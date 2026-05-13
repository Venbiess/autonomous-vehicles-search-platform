package infra

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type PicsAdapter struct {
	baseURL string
	client  *http.Client
}

func NewPicsAdapter(cfg ObjectStoreConfig) (*PicsAdapter, error) {
	baseURL := strings.TrimSpace(cfg.EndpointURL)
	if baseURL == "" {
		return nil, errors.New("pics endpoint is required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("parse pics endpoint: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("pics endpoint must be an absolute URL")
	}
	return &PicsAdapter{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  http.DefaultClient,
	}, nil
}

func (p *PicsAdapter) GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.objectURL(bucket, key), nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, "", fmt.Errorf("%w: object %s/%s", ErrNotFound, bucket, key)
	}
	if resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("pics get failed with status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	contentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return body, contentType, nil
}

func (p *PicsAdapter) PutStream(ctx context.Context, bucket, key string, reader io.Reader, size int64, contentType string) (PutResult, error) {
	payload := struct {
		Bucket      string `json:"bucket"`
		Key         string `json:"key"`
		ContentType string `json:"content_type"`
		Size        int64  `json:"size"`
	}{
		Bucket:      bucket,
		Key:         key,
		ContentType: contentType,
		Size:        size,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return PutResult{}, err
	}
	createReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/uploads", bytes.NewReader(raw))
	if err != nil {
		return PutResult{}, err
	}
	createReq.Header.Set("Content-Type", "application/json")
	createResp, err := p.client.Do(createReq)
	if err != nil {
		return PutResult{}, err
	}
	defer createResp.Body.Close()
	if createResp.StatusCode >= 300 {
		return PutResult{}, fmt.Errorf("pics create upload failed with status %d", createResp.StatusCode)
	}
	var create struct {
		Targets []struct {
			UploadURL   string `json:"upload_url"`
			UploadToken string `json:"upload_token"`
		} `json:"targets"`
	}
	if err := json.NewDecoder(createResp.Body).Decode(&create); err != nil {
		return PutResult{}, err
	}
	if len(create.Targets) == 0 {
		return PutResult{}, errors.New("pics upload plan has no targets")
	}
	putReq, err := http.NewRequestWithContext(ctx, http.MethodPut, create.Targets[0].UploadURL, reader)
	if err != nil {
		return PutResult{}, err
	}
	putReq.Header.Set("X-Upload-Token", create.Targets[0].UploadToken)
	if contentType != "" {
		putReq.Header.Set("Content-Type", contentType)
	}
	putReq.ContentLength = size
	putResp, err := p.client.Do(putReq)
	if err != nil {
		return PutResult{}, err
	}
	defer putResp.Body.Close()
	if putResp.StatusCode >= 300 {
		return PutResult{}, fmt.Errorf("pics upload failed with status %d", putResp.StatusCode)
	}
	var out struct {
		ContentType string `json:"content_type"`
		Size        int64  `json:"size"`
	}
	if err := json.NewDecoder(putResp.Body).Decode(&out); err != nil {
		return PutResult{}, err
	}
	if strings.TrimSpace(out.ContentType) == "" {
		out.ContentType = contentType
	}
	return PutResult{
		SizeBytes:   out.Size,
		ContentType: out.ContentType,
	}, nil
}

func (p *PicsAdapter) Delete(ctx context.Context, bucket, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, p.objectURL(bucket, key), nil)
	if err != nil {
		return err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("pics delete failed with status %d", resp.StatusCode)
	}
	return nil
}

func (p *PicsAdapter) Health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.baseURL+"/health", nil)
	if err != nil {
		return err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("pics health failed with status %d", resp.StatusCode)
	}
	return nil
}

func (p *PicsAdapter) CanonicalPath(bucket, key string) string {
	return fmt.Sprintf("pics://%s/%s", strings.Trim(strings.TrimSpace(bucket), "/"), strings.Trim(strings.TrimSpace(key), "/"))
}

func (p *PicsAdapter) objectURL(bucket, key string) string {
	parts := strings.Split(key, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return p.baseURL + "/b/" + url.PathEscape(bucket) + "/" + strings.Join(parts, "/")
}
