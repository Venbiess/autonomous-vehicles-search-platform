package infra

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

const defaultYTsaurusPathPrefix = "//tmp/avsp"

type YTsaurusAdapter struct {
	baseURL    string
	authToken  string
	pathPrefix string
	client     *http.Client
}

func NewYTsaurusAdapter(cfg ObjectStoreConfig) (*YTsaurusAdapter, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.EndpointURL), "/")
	if baseURL == "" {
		return nil, errors.New("ytsaurus endpoint is required")
	}
	pathPrefix := strings.TrimSpace(cfg.PathPrefix)
	if pathPrefix == "" {
		pathPrefix = defaultYTsaurusPathPrefix
	}
	pathPrefix = strings.TrimRight(pathPrefix, "/")
	if !strings.HasPrefix(pathPrefix, "//") {
		return nil, errors.New("ytsaurus path_prefix must start with //")
	}
	return &YTsaurusAdapter{
		baseURL:    baseURL,
		authToken:  strings.TrimSpace(cfg.AuthToken),
		pathPrefix: pathPrefix,
		client: &http.Client{
			Timeout: 120 * time.Second,
		},
	}, nil
}

func (y *YTsaurusAdapter) CanonicalPath(bucket, key string) string {
	return fmt.Sprintf("yt://%s/%s", strings.Trim(strings.TrimSpace(bucket), "/"), strings.Trim(strings.TrimSpace(key), "/"))
}

func (y *YTsaurusAdapter) GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error) {
	req, err := y.newRequest(ctx, http.MethodGet, "read_file", map[string]string{
		"path": y.objectPath(bucket, key),
	}, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := y.client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, "", fmt.Errorf("%w: object %s/%s", ErrNotFound, bucket, key)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", y.decodeHTTPError(resp)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	contentType := http.DetectContentType(body)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return body, contentType, nil
}

func (y *YTsaurusAdapter) PutStream(ctx context.Context, bucket, key string, reader io.Reader, size int64, contentType string) (PutResult, error) {
	objectPath := y.objectPath(bucket, key)
	if err := y.createNode(ctx, path.Dir(objectPath), "map_node", true, true); err != nil {
		return PutResult{}, err
	}
	if err := y.createNode(ctx, objectPath, "file", false, true); err != nil {
		return PutResult{}, err
	}
	req, err := y.newRequest(ctx, http.MethodPut, "write_file", map[string]string{
		"path": objectPath,
	}, reader)
	if err != nil {
		return PutResult{}, err
	}
	if size >= 0 {
		req.ContentLength = size
	}
	resp, err := y.client.Do(req)
	if err != nil {
		return PutResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return PutResult{}, y.decodeHTTPError(resp)
	}
	contentType = strings.TrimSpace(contentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return PutResult{SizeBytes: size, ContentType: contentType}, nil
}

func (y *YTsaurusAdapter) Delete(ctx context.Context, bucket, key string) error {
	req, err := y.newRequest(ctx, http.MethodPost, "remove", map[string]string{
		"path":  y.objectPath(bucket, key),
		"force": "true",
	}, nil)
	if err != nil {
		return err
	}
	resp, err := y.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return y.decodeHTTPError(resp)
	}
	return nil
}

func (y *YTsaurusAdapter) Health(ctx context.Context) error {
	req, err := y.newRequest(ctx, http.MethodGet, "get", map[string]string{
		"path": "//sys/@",
	}, nil)
	if err != nil {
		return err
	}
	resp, err := y.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return y.decodeHTTPError(resp)
	}
	return nil
}

func (y *YTsaurusAdapter) createNode(ctx context.Context, nodePath, nodeType string, recursive, ignoreExisting bool) error {
	req, err := y.newRequest(ctx, http.MethodPost, "create", map[string]string{
		"path":            nodePath,
		"type":            nodeType,
		"recursive":       boolString(recursive),
		"ignore_existing": boolString(ignoreExisting),
	}, nil)
	if err != nil {
		return err
	}
	resp, err := y.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return y.decodeHTTPError(resp)
	}
	return nil
}

func (y *YTsaurusAdapter) objectPath(bucket, key string) string {
	bucket = strings.Trim(strings.TrimSpace(bucket), "/")
	key = strings.Trim(strings.TrimSpace(key), "/")
	base := strings.TrimRight(strings.TrimSpace(y.pathPrefix), "/")
	if key == "" {
		if bucket == "" {
			return base
		}
		return base + "/" + bucket
	}
	if bucket == "" {
		return base + "/" + key
	}
	return base + "/" + bucket + "/" + key
}

func (y *YTsaurusAdapter) newRequest(ctx context.Context, method, command string, params map[string]string, body io.Reader) (*http.Request, error) {
	target, err := y.apiURL(command, params)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	if y.authToken != "" {
		req.Header.Set("Authorization", "OAuth "+y.authToken)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	return req, nil
}

func (y *YTsaurusAdapter) apiURL(command string, params map[string]string) (string, error) {
	base, err := url.Parse(y.baseURL)
	if err != nil {
		return "", err
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/api/v3/" + command
	query := base.Query()
	for key, value := range params {
		if strings.TrimSpace(value) != "" {
			query.Set(key, value)
		}
	}
	base.RawQuery = query.Encode()
	return base.String(), nil
}

func (y *YTsaurusAdapter) decodeHTTPError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = resp.Status
	}
	return fmt.Errorf("ytsaurus %s: %s", resp.Status, message)
}

func boolString(v bool) string {
	if v {
		return "true"
	}
	return "false"
}
