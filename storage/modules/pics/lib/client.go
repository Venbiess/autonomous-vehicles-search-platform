package lib

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	baseURL string
	http    *http.Client
}

type UploadCreateRequest struct {
	Bucket      string `json:"bucket"`
	Key         string `json:"key"`
	ContentType string `json:"content_type"`
	Size        uint64 `json:"size"`
}

type UploadTarget struct {
	ServerID    string `json:"server_id"`
	UploadURL   string `json:"upload_url"`
	UploadToken string `json:"upload_token"`
}

type UploadCreateResponse struct {
	UploadID string         `json:"upload_id"`
	BlobID   string         `json:"blob_id"`
	Targets  []UploadTarget `json:"targets"`
}

type ImageMetadata struct {
	ContentType string `json:"content_type"`
	Checksum    string `json:"checksum"`
	Size        uint64 `json:"size"`
}

type UploadMetadata struct {
	ServerID string        `json:"server_id"`
	Metadata ImageMetadata `json:"metadata"`
}

type PutObjectResponse struct {
	Bucket      string `json:"bucket"`
	Key         string `json:"key"`
	BlobID      string `json:"blob_id"`
	URL         string `json:"url"`
	ContentType string `json:"content_type"`
	Size        uint64 `json:"size"`
	Checksum    string `json:"checksum"`
}

type ObjectInfo struct {
	Bucket      string `json:"bucket"`
	Key         string `json:"key"`
	BlobID      string `json:"blob_id"`
	URL         string `json:"url"`
	ContentType string `json:"content_type"`
	Size        uint64 `json:"size"`
	UpdatedAt   string `json:"updated_at"`
}

type ListObjectsResponse struct {
	Objects []ObjectInfo `json:"objects"`
}

func New(baseURL string, client *http.Client) *Client {
	if client == nil {
		client = http.DefaultClient
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    client,
	}
}

func (c *Client) CreateUpload(ctx context.Context, req UploadCreateRequest) (UploadCreateResponse, error) {
	var out UploadCreateResponse
	if err := c.doJSON(ctx, http.MethodPost, "/uploads", req, &out); err != nil {
		return UploadCreateResponse{}, err
	}
	return out, nil
}

func (c *Client) PutObject(ctx context.Context, bucket, key string, body io.ReadSeeker, size int64, contentType string) (PutObjectResponse, error) {
	if bucket == "" || key == "" {
		return PutObjectResponse{}, fmt.Errorf("bucket and key are required")
	}
	if body == nil {
		return PutObjectResponse{}, fmt.Errorf("body is required")
	}
	if size <= 0 {
		return PutObjectResponse{}, fmt.Errorf("size must be positive")
	}

	plan, err := c.CreateUpload(ctx, UploadCreateRequest{
		Bucket:      bucket,
		Key:         key,
		ContentType: contentType,
		Size:        uint64(size),
	})
	if err != nil {
		return PutObjectResponse{}, err
	}
	if len(plan.Targets) == 0 {
		return PutObjectResponse{}, fmt.Errorf("upload plan has no targets")
	}
	target := plan.Targets[0]
	if _, err := body.Seek(0, io.SeekStart); err != nil {
		return PutObjectResponse{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target.UploadURL, body)
	if err != nil {
		return PutObjectResponse{}, err
	}
	req.Header.Set("X-Upload-Token", target.UploadToken)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.ContentLength = size
	resp, err := c.http.Do(req)
	if err != nil {
		return PutObjectResponse{}, err
	}
	var out PutObjectResponse
	if err := decodeJSONResponse(resp, &out); err != nil {
		return PutObjectResponse{}, err
	}
	return out, nil
}

func (c *Client) PutBytes(ctx context.Context, bucket, key string, body []byte, contentType string) (PutObjectResponse, error) {
	return c.PutObject(ctx, bucket, key, bytes.NewReader(body), int64(len(body)), contentType)
}

func (c *Client) GetObject(ctx context.Context, bucket, key string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.objectURL(bucket, key), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		err = readResponseError(resp)
		resp.Body.Close()
		return nil, err
	}
	return resp, nil
}

func (c *Client) HeadObject(ctx context.Context, bucket, key string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, c.objectURL(bucket, key), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		err = readResponseError(resp)
		resp.Body.Close()
		return nil, err
	}
	return resp, nil
}

func (c *Client) DeleteObject(ctx context.Context, bucket, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.objectURL(bucket, key), nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	return checkResponse(resp)
}

func (c *Client) ListObjects(ctx context.Context, bucket, start string, limit int) (ListObjectsResponse, error) {
	values := url.Values{}
	if start != "" {
		values.Set("start", start)
	}
	if limit > 0 {
		values.Set("limit", fmt.Sprintf("%d", limit))
	}
	path := "/b/" + url.PathEscape(bucket)
	if encoded := values.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var out ListObjectsResponse
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return ListObjectsResponse{}, err
	}
	return out, nil
}

func (c *Client) objectURL(bucket, key string) string {
	parts := strings.Split(key, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return c.baseURL + "/b/" + url.PathEscape(bucket) + "/" + strings.Join(parts, "/")
}

func (c *Client) doJSON(ctx context.Context, method, path string, in any, out any) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return readResponseError(resp)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func checkResponse(resp *http.Response) error {
	defer resp.Body.Close()
	if resp.StatusCode < 300 {
		return nil
	}
	return readResponseError(resp)
}

func decodeJSONResponse(resp *http.Response, out any) error {
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return readResponseError(resp)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func readResponseError(resp *http.Response) error {
	raw, _ := io.ReadAll(resp.Body)
	detail := strings.TrimSpace(string(raw))
	if detail == "" {
		detail = resp.Status
	}
	return fmt.Errorf("request failed: %s %s", resp.Status, detail)
}
