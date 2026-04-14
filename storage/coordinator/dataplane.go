package coordinator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type DataPlane interface {
	ResolveObjectID(ctx context.Context, storagePath string) (string, error)
	UpsertVector(ctx context.Context, objectID string, embedding []float64) error
	DeleteVector(ctx context.Context, objectID string) error
	DeleteObject(ctx context.Context, objectID string) error
}

type HTTPDataPlaneConfig struct {
	ObjectEndpoint string
	VectorEndpoint string
	WriteToken     string
	Timeout        time.Duration
}

type HTTPDataPlane struct {
	objectEndpoint string
	vectorEndpoint string
	writeToken     string
	client         *http.Client
}

func NewHTTPDataPlane(cfg HTTPDataPlaneConfig) (*HTTPDataPlane, error) {
	if strings.TrimSpace(cfg.ObjectEndpoint) == "" {
		return nil, errors.New("object endpoint is required")
	}
	if strings.TrimSpace(cfg.VectorEndpoint) == "" {
		return nil, errors.New("vector endpoint is required")
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &HTTPDataPlane{
		objectEndpoint: strings.TrimRight(cfg.ObjectEndpoint, "/"),
		vectorEndpoint: strings.TrimRight(cfg.VectorEndpoint, "/"),
		writeToken:     strings.TrimSpace(cfg.WriteToken),
		client:         &http.Client{Timeout: timeout},
	}, nil
}

func (h *HTTPDataPlane) ResolveObjectID(ctx context.Context, storagePath string) (string, error) {
	var out struct {
		ObjectID string `json:"object_id"`
	}
	if err := h.doJSON(
		ctx,
		http.MethodPost,
		h.objectEndpoint+"/objects/resolve-path",
		map[string]any{"storage_path": storagePath},
		&out,
	); err != nil {
		return "", err
	}
	if strings.TrimSpace(out.ObjectID) == "" {
		return "", errors.New("empty object_id in response")
	}
	return out.ObjectID, nil
}

func (h *HTTPDataPlane) UpsertVector(ctx context.Context, objectID string, embedding []float64) error {
	return h.doJSON(
		ctx,
		http.MethodPost,
		h.vectorEndpoint+"/vectors/upsert",
		map[string]any{
			"vectors": []map[string]any{
				{
					"object_id": objectID,
					"embedding": embedding,
				},
			},
		},
		nil,
	)
}

func (h *HTTPDataPlane) DeleteVector(ctx context.Context, objectID string) error {
	return h.doJSON(
		ctx,
		http.MethodPost,
		h.vectorEndpoint+"/vectors/delete",
		map[string]any{"object_ids": []string{objectID}},
		nil,
	)
}

func (h *HTTPDataPlane) DeleteObject(ctx context.Context, objectID string) error {
	return h.doJSON(
		ctx,
		http.MethodDelete,
		h.objectEndpoint+"/objects/"+objectID,
		nil,
		nil,
	)
}

func (h *HTTPDataPlane) doJSON(ctx context.Context, method, url string, payload any, out any) error {
	var body *bytes.Reader
	if payload == nil {
		body = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if h.writeToken != "" {
		req.Header.Set("X-Storage-Write-Token", h.writeToken)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("request failed: %s %s status=%d", method, url, resp.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}
