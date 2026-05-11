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
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultMilvusDBName         = "default"
	defaultMilvusPrimaryField   = "object_id"
	defaultMilvusVectorField    = "embedding"
	defaultMilvusPrimaryMaxLen  = 512
	defaultMilvusTimeoutSeconds = 10
	defaultMilvusConsistency    = "Bounded"
)

type MilvusAdapter struct {
	baseURL        string
	token          string
	dbName         string
	collectionName string
	metricType     string
	vectorSize     int
	timeoutSec     int
	client         *http.Client

	mu      sync.Mutex
	ensured bool
}

func NewMilvusAdapter(cfg VectorIndexConfig) (*MilvusAdapter, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.EndpointURL), "/")
	if baseURL == "" {
		return nil, errors.New("milvus endpoint_url is required")
	}
	collectionName := strings.TrimSpace(cfg.Collection)
	if collectionName == "" {
		collectionName = strings.TrimSpace(cfg.Table)
	}
	if collectionName == "" {
		return nil, errors.New("milvus collection or table is required")
	}
	timeoutSec := cfg.TimeoutSec
	if timeoutSec <= 0 {
		timeoutSec = defaultMilvusTimeoutSeconds
	}
	adapter := &MilvusAdapter{
		baseURL:        baseURL,
		token:          strings.TrimSpace(cfg.APIKey),
		dbName:         milvusDBName(cfg.Schema),
		collectionName: collectionName,
		metricType:     normalizeMilvusMetricType(cfg.Distance),
		vectorSize:     cfg.VectorSize,
		timeoutSec:     timeoutSec,
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

func (m *MilvusAdapter) Upsert(ctx context.Context, objectID string, embedding []float64) error {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return errors.New("object_id is required")
	}
	if len(embedding) == 0 {
		return errors.New("embedding is required")
	}
	if err := m.ensureCollection(ctx, len(embedding)); err != nil {
		return err
	}
	reqBody := map[string]any{
		"dbName":         m.dbName,
		"collectionName": m.collectionName,
		"data": []map[string]any{
			{
				defaultMilvusPrimaryField: objectID,
				defaultMilvusVectorField:  embedding,
			},
		},
	}
	return m.doJSON(ctx, http.MethodPost, "/v2/vectordb/entities/upsert", reqBody, nil)
}

func (m *MilvusAdapter) QueryTopK(ctx context.Context, embedding []float64, topK int) ([]VectorQueryResult, error) {
	if len(embedding) == 0 {
		return nil, errors.New("embedding is required")
	}
	if topK <= 0 {
		return nil, errors.New("top_k must be > 0")
	}
	if err := m.ensureCollection(ctx, len(embedding)); err != nil {
		return nil, err
	}
	var resp []map[string]any
	reqBody := map[string]any{
		"dbName":           m.dbName,
		"collectionName":   m.collectionName,
		"data":             [][]float64{embedding},
		"annsField":        defaultMilvusVectorField,
		"limit":            topK,
		"outputFields":     []string{defaultMilvusPrimaryField},
		"consistencyLevel": defaultMilvusConsistency,
		"searchParams": map[string]any{
			"metricType": m.metricType,
			"params":     map[string]any{},
		},
	}
	if err := m.doJSON(ctx, http.MethodPost, "/v2/vectordb/entities/search", reqBody, &resp); err != nil {
		return nil, err
	}
	results := make([]VectorQueryResult, 0, len(resp))
	for _, item := range resp {
		objectID := anyToString(item[defaultMilvusPrimaryField])
		if objectID == "" {
			objectID = anyToString(item["id"])
		}
		if objectID == "" {
			continue
		}
		score, _ := anyToFloat64(item["distance"])
		distance, similarity := milvusScoreToDistanceSimilarity(m.metricType, score)
		results = append(results, VectorQueryResult{
			ObjectID:   objectID,
			Distance:   distance,
			Similarity: similarity,
		})
	}
	return results, nil
}

func (m *MilvusAdapter) Delete(ctx context.Context, objectIDs []string) error {
	normalized := milvusDedupeNonEmpty(objectIDs)
	if len(normalized) == 0 {
		return nil
	}
	hasCollection, err := m.hasCollection(ctx)
	if err != nil {
		return err
	}
	if !hasCollection {
		return nil
	}
	reqBody := map[string]any{
		"dbName":         m.dbName,
		"collectionName": m.collectionName,
		"filter":         milvusIDFilter(normalized),
	}
	return m.doJSON(ctx, http.MethodPost, "/v2/vectordb/entities/delete", reqBody, nil)
}

func (m *MilvusAdapter) Count(ctx context.Context) (int64, error) {
	hasCollection, err := m.hasCollection(ctx)
	if err != nil {
		return 0, err
	}
	if !hasCollection {
		return 0, nil
	}
	var resp struct {
		RowCount any `json:"rowCount"`
	}
	reqBody := map[string]any{
		"dbName":         m.dbName,
		"collectionName": m.collectionName,
	}
	if err := m.doJSON(ctx, http.MethodPost, "/v2/vectordb/collections/get_stats", reqBody, &resp); err != nil {
		return 0, err
	}
	count, ok := anyToInt64(resp.RowCount)
	if !ok {
		return 0, fmt.Errorf("milvus returned non-numeric rowCount: %v", resp.RowCount)
	}
	return count, nil
}

func (m *MilvusAdapter) Health(ctx context.Context) error {
	_, err := m.hasCollection(ctx)
	return err
}

func (m *MilvusAdapter) ExistingObjectIDs(ctx context.Context, objectIDs []string) ([]string, error) {
	rows, err := m.getEntities(ctx, milvusDedupeNonEmpty(objectIDs), nil)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		objectID := anyToString(row[defaultMilvusPrimaryField])
		if objectID == "" {
			objectID = anyToString(row["id"])
		}
		if objectID != "" {
			out = append(out, objectID)
		}
	}
	return out, nil
}

func (m *MilvusAdapter) GetByObjectIDs(ctx context.Context, objectIDs []string) (map[string][]float64, error) {
	rows, err := m.getEntities(ctx, milvusDedupeNonEmpty(objectIDs), []string{defaultMilvusVectorField})
	if err != nil {
		return nil, err
	}
	out := make(map[string][]float64, len(rows))
	for _, row := range rows {
		objectID := anyToString(row[defaultMilvusPrimaryField])
		if objectID == "" {
			objectID = anyToString(row["id"])
		}
		if objectID == "" {
			continue
		}
		vector := parseQdrantVector(row[defaultMilvusVectorField])
		if len(vector) == 0 {
			continue
		}
		out[objectID] = vector
	}
	return out, nil
}

func (m *MilvusAdapter) getEntities(ctx context.Context, objectIDs []string, outputFields []string) ([]map[string]any, error) {
	if len(objectIDs) == 0 {
		return []map[string]any{}, nil
	}
	hasCollection, err := m.hasCollection(ctx)
	if err != nil {
		return nil, err
	}
	if !hasCollection {
		return []map[string]any{}, nil
	}
	var resp []map[string]any
	reqBody := map[string]any{
		"dbName":         m.dbName,
		"collectionName": m.collectionName,
		"id":             objectIDs,
	}
	if len(outputFields) > 0 {
		reqBody["outputFields"] = outputFields
	}
	if err := m.doJSON(ctx, http.MethodPost, "/v2/vectordb/entities/get", reqBody, &resp); err != nil {
		return nil, err
	}
	return resp, nil
}

func (m *MilvusAdapter) ensureCollection(ctx context.Context, vectorSize int) error {
	m.mu.Lock()
	if m.ensured {
		m.mu.Unlock()
		return nil
	}
	if m.vectorSize > 0 && vectorSize > 0 && m.vectorSize != vectorSize {
		m.mu.Unlock()
		return fmt.Errorf("milvus vector size mismatch: configured=%d got=%d", m.vectorSize, vectorSize)
	}
	if m.vectorSize == 0 {
		m.vectorSize = vectorSize
	}
	if m.vectorSize <= 0 {
		m.mu.Unlock()
		return errors.New("milvus vector_size must be > 0 or inferred from first upsert/search")
	}
	m.mu.Unlock()

	hasCollection, err := m.hasCollection(ctx)
	if err != nil {
		return err
	}
	if hasCollection {
		m.mu.Lock()
		m.ensured = true
		m.mu.Unlock()
		return nil
	}
	reqBody := map[string]any{
		"dbName":           m.dbName,
		"collectionName":   m.collectionName,
		"dimension":        m.vectorSize,
		"metricType":       m.metricType,
		"idType":           "VarChar",
		"autoID":           false,
		"primaryFieldName": defaultMilvusPrimaryField,
		"vectorFieldName":  defaultMilvusVectorField,
		"params": map[string]any{
			"max_length": strconv.Itoa(defaultMilvusPrimaryMaxLen),
		},
	}
	if err := m.doJSON(ctx, http.MethodPost, "/v2/vectordb/collections/create", reqBody, nil); err != nil {
		return err
	}
	m.mu.Lock()
	m.ensured = true
	m.mu.Unlock()
	return nil
}

func (m *MilvusAdapter) hasCollection(ctx context.Context) (bool, error) {
	var resp struct {
		Has bool `json:"has"`
	}
	reqBody := map[string]any{
		"dbName":         m.dbName,
		"collectionName": m.collectionName,
	}
	if err := m.doJSON(ctx, http.MethodPost, "/v2/vectordb/collections/has", reqBody, &resp); err != nil {
		return false, err
	}
	return resp.Has, nil
}

func (m *MilvusAdapter) doJSON(ctx context.Context, method, path string, reqBody any, out any) error {
	var bodyReader io.Reader
	if reqBody != nil {
		raw, err := json.Marshal(reqBody)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, m.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if m.token != "" {
		req.Header.Set("Authorization", "Bearer "+m.token)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("milvus request failed: method=%s path=%s status=%d body=%s", method, path, resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	var envelope struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return err
	}
	if envelope.Code != 0 {
		msg := strings.TrimSpace(envelope.Message)
		if msg == "" {
			msg = fmt.Sprintf("code=%d", envelope.Code)
		}
		return fmt.Errorf("milvus request rejected: %s", msg)
	}
	if out != nil && len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return err
		}
	}
	return nil
}

func milvusDBName(schema string) string {
	name := strings.TrimSpace(schema)
	if name == "" {
		return defaultMilvusDBName
	}
	return name
}

func normalizeMilvusMetricType(distance string) string {
	switch strings.ToLower(strings.TrimSpace(distance)) {
	case "", "cos", "cosine":
		return "COSINE"
	case "ip", "inner_product", "dot":
		return "IP"
	case "l2", "euclid", "euclidean":
		return "L2"
	default:
		return "COSINE"
	}
}

func milvusScoreToDistanceSimilarity(metricType string, score float64) (float64, float64) {
	switch strings.ToUpper(strings.TrimSpace(metricType)) {
	case "IP":
		return -score, score
	case "L2":
		dist := math.Abs(score)
		return dist, 1 / (1 + dist)
	default:
		return 1 - score, score
	}
}

func milvusIDFilter(objectIDs []string) string {
	if len(objectIDs) == 1 {
		return fmt.Sprintf(`%s == %s`, defaultMilvusPrimaryField, milvusQuoteString(objectIDs[0]))
	}
	quoted := make([]string, 0, len(objectIDs))
	for _, objectID := range objectIDs {
		quoted = append(quoted, milvusQuoteString(objectID))
	}
	return fmt.Sprintf(`%s in [%s]`, defaultMilvusPrimaryField, strings.Join(quoted, ", "))
}

func milvusQuoteString(value string) string {
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return `"` + escaped + `"`
}

func anyToFloat64(v any) (float64, bool) {
	switch value := v.(type) {
	case float64:
		return value, true
	case float32:
		return float64(value), true
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	case json.Number:
		parsed, err := value.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func anyToInt64(v any) (int64, bool) {
	switch value := v.(type) {
	case int64:
		return value, true
	case int:
		return int64(value), true
	case float64:
		return int64(value), true
	case json.Number:
		parsed, err := value.Int64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func milvusDedupeNonEmpty(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}
