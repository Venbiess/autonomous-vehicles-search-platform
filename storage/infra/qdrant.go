package infra

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

type QdrantAdapter struct {
	baseURL    string
	apiKey     string
	collection string
	distance   string
	vectorSize int
	client     *http.Client

	mu      sync.Mutex
	ensured bool
}

func NewQdrantAdapter(cfg VectorIndexConfig) (*QdrantAdapter, error) {
	baseURL := strings.TrimSpace(cfg.EndpointURL)
	if baseURL == "" {
		return nil, errors.New("qdrant endpoint_url is required")
	}
	collection := strings.TrimSpace(cfg.Collection)
	if collection == "" {
		return nil, errors.New("qdrant collection is required")
	}
	distance := normalizeQdrantDistance(cfg.Distance)
	timeoutSec := cfg.TimeoutSec
	if timeoutSec <= 0 {
		timeoutSec = 10
	}

	adapter := &QdrantAdapter{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     strings.TrimSpace(cfg.APIKey),
		collection: collection,
		distance:   distance,
		vectorSize: cfg.VectorSize,
		client: &http.Client{
			Timeout: time.Duration(timeoutSec) * time.Second,
		},
	}

	if cfg.VectorSize > 0 {
		if err := adapter.ensureCollection(context.Background(), cfg.VectorSize); err != nil {
			return nil, err
		}
	}
	return adapter, nil
}

func (q *QdrantAdapter) Upsert(ctx context.Context, objectID string, embedding []float64) error {
	if strings.TrimSpace(objectID) == "" {
		return errors.New("object_id is required")
	}
	if len(embedding) == 0 {
		return errors.New("embedding is required")
	}
	if err := q.ensureCollection(ctx, len(embedding)); err != nil {
		return err
	}

	reqBody := map[string]any{
		"points": []map[string]any{
			{
				"id":      objectID,
				"vector":  embedding,
				"payload": map[string]any{"object_id": objectID},
			},
		},
	}
	return q.doJSONExpectOK(ctx, http.MethodPut, fmt.Sprintf("/collections/%s/points?wait=true", q.collection), reqBody, nil, false)
}

func (q *QdrantAdapter) QueryTopK(ctx context.Context, embedding []float64, topK int) ([]VectorQueryResult, error) {
	if len(embedding) == 0 {
		return nil, errors.New("embedding is required")
	}
	if topK <= 0 {
		topK = 5
	}
	if err := q.ensureCollection(ctx, len(embedding)); err != nil {
		if isNotFoundErr(err) {
			return []VectorQueryResult{}, nil
		}
		return nil, err
	}

	var resp struct {
		Result []struct {
			ID      any            `json:"id"`
			Score   float64        `json:"score"`
			Payload map[string]any `json:"payload"`
		} `json:"result"`
	}
	reqBody := map[string]any{
		"vector":       embedding,
		"limit":        topK,
		"with_payload": true,
	}
	err := q.doJSONExpectOK(ctx, http.MethodPost, fmt.Sprintf("/collections/%s/points/search", q.collection), reqBody, &resp, true)
	if err != nil {
		if isNotFoundErr(err) {
			return []VectorQueryResult{}, nil
		}
		return nil, err
	}

	results := make([]VectorQueryResult, 0, len(resp.Result))
	for _, item := range resp.Result {
		objectID := q.extractObjectID(item.ID, item.Payload)
		if objectID == "" {
			continue
		}
		distance, similarity := scoreToDistanceSimilarity(item.Score, q.distance)
		results = append(results, VectorQueryResult{
			ObjectID:   objectID,
			Distance:   distance,
			Similarity: similarity,
		})
	}
	return results, nil
}

func (q *QdrantAdapter) Delete(ctx context.Context, objectIDs []string) error {
	if len(objectIDs) == 0 {
		return nil
	}
	reqBody := map[string]any{"points": objectIDs}
	err := q.doJSONExpectOK(ctx, http.MethodPost, fmt.Sprintf("/collections/%s/points/delete?wait=true", q.collection), reqBody, nil, false)
	if isNotFoundErr(err) {
		return nil
	}
	return err
}

func (q *QdrantAdapter) Count(ctx context.Context) (int64, error) {
	var resp struct {
		Result struct {
			Count int64 `json:"count"`
		} `json:"result"`
	}
	err := q.doJSONExpectOK(
		ctx,
		http.MethodPost,
		fmt.Sprintf("/collections/%s/points/count", q.collection),
		map[string]any{"exact": true},
		&resp,
		true,
	)
	if isNotFoundErr(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return resp.Result.Count, nil
}

func (q *QdrantAdapter) Health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, q.baseURL+"/healthz", nil)
	if err != nil {
		return err
	}
	if q.apiKey != "" {
		req.Header.Set("api-key", q.apiKey)
	}
	resp, err := q.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 == 2 {
		return nil
	}
	if resp.StatusCode == http.StatusNotFound {
		return q.doJSONExpectOK(ctx, http.MethodGet, "/collections", nil, nil, false)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("qdrant health failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
}

func (q *QdrantAdapter) ensureCollection(ctx context.Context, vectorSize int) error {
	q.mu.Lock()
	if q.ensured {
		q.mu.Unlock()
		return nil
	}
	if q.vectorSize > 0 && vectorSize > 0 && q.vectorSize != vectorSize {
		q.mu.Unlock()
		return fmt.Errorf("qdrant vector size mismatch: configured=%d got=%d", q.vectorSize, vectorSize)
	}
	if q.vectorSize == 0 {
		q.vectorSize = vectorSize
	}
	if q.vectorSize <= 0 {
		q.mu.Unlock()
		return errors.New("qdrant vector_size must be > 0 or inferred from first upsert")
	}
	q.mu.Unlock()

	err := q.doJSONExpectOK(ctx, http.MethodGet, fmt.Sprintf("/collections/%s", q.collection), nil, nil, false)
	if err == nil {
		q.mu.Lock()
		q.ensured = true
		q.mu.Unlock()
		return nil
	}
	if !isNotFoundErr(err) {
		return err
	}

	reqBody := map[string]any{
		"vectors": map[string]any{
			"size":     q.vectorSize,
			"distance": q.distance,
		},
	}
	if err := q.doJSONExpectOK(ctx, http.MethodPut, fmt.Sprintf("/collections/%s", q.collection), reqBody, nil, false); err != nil {
		return err
	}
	q.mu.Lock()
	q.ensured = true
	q.mu.Unlock()
	return nil
}

func (q *QdrantAdapter) doJSONExpectOK(ctx context.Context, method, path string, reqBody any, out any, parseJSON bool) error {
	var bodyReader io.Reader
	if reqBody != nil {
		raw, err := json.Marshal(reqBody)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, q.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if q.apiKey != "" {
		req.Header.Set("api-key", q.apiKey)
	}

	resp, err := q.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return errNotFound
	}
	if resp.StatusCode/100 != 2 {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("qdrant request failed: method=%s path=%s status=%d body=%s", method, path, resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	if parseJSON && out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return err
		}
	}
	return nil
}

func (q *QdrantAdapter) extractObjectID(id any, payload map[string]any) string {
	if payload != nil {
		if v, ok := payload["object_id"]; ok {
			return anyToString(v)
		}
	}
	return anyToString(id)
}

func anyToString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return fmt.Sprintf("%.0f", t)
	case int:
		return fmt.Sprintf("%d", t)
	case int64:
		return fmt.Sprintf("%d", t)
	default:
		return ""
	}
}

func normalizeQdrantDistance(distance string) string {
	switch strings.ToLower(strings.TrimSpace(distance)) {
	case "", "cos", "cosine":
		return "Cosine"
	case "dot":
		return "Dot"
	case "euclid", "euclidean":
		return "Euclid"
	case "manhattan", "l1":
		return "Manhattan"
	default:
		return "Cosine"
	}
}

func scoreToDistanceSimilarity(score float64, distance string) (float64, float64) {
	switch strings.ToLower(distance) {
	case "dot":
		return 1 - score, score
	case "euclid", "manhattan":
		// In qdrant for distance metrics score is ordered descending;
		// treat negative distance as score and convert back to positive distance.
		dist := math.Abs(score)
		return dist, 1 / (1 + dist)
	default: // cosine
		return 1 - score, score
	}
}

var errNotFound = errors.New("not found")

func isNotFoundErr(err error) bool {
	return errors.Is(err, errNotFound)
}
