package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var identRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const analyticsScanBatchSize = 512

type AnalyticsDBConfig struct {
	Provider             string
	DSN                  string
	FieldCatalogTable    string
	AnnotationStoreTable string
}

type AnalyticsField struct {
	FieldName    string `json:"field_name"`
	Prompt       string `json:"prompt"`
	ResponseType string `json:"response_type"`
}

type AnnotationRow struct {
	ObjectID string            `json:"object_id"`
	Values   map[string]string `json:"values"`
}

type SearchFilter struct {
	FieldName string `json:"field_name"`
	Value     string `json:"value"`
	MatchMode string `json:"match_mode"`
}

type SearchResult struct {
	ObjectID   string            `json:"object_id"`
	Attributes map[string]string `json:"attributes"`
	UpdatedAt  time.Time         `json:"-"`
}

type AnalyticsStore struct {
	shards []*clickHouseAnalyticsShard
}

func NewAnalyticsStore(cfg AnalyticsDBConfig) (*AnalyticsStore, error) {
	if strings.TrimSpace(cfg.Provider) == "" && strings.TrimSpace(cfg.DSN) == "" {
		return nil, nil
	}
	if strings.TrimSpace(cfg.Provider) != "" && !strings.EqualFold(strings.TrimSpace(cfg.Provider), "clickhouse") {
		return nil, fmt.Errorf("unsupported analytics provider: %s", cfg.Provider)
	}
	shard, err := newClickHouseAnalyticsShard(cfg)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for attempt := 1; attempt <= 10; attempt++ {
		if err := shard.ensure(context.Background()); err == nil {
			lastErr = nil
			break
		} else {
			lastErr = err
		}
		time.Sleep(time.Duration(min(attempt, 5)) * time.Second)
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return &AnalyticsStore{shards: []*clickHouseAnalyticsShard{shard}}, nil
}

func (s *AnalyticsStore) Health(ctx context.Context) error {
	if s == nil {
		return nil
	}
	for _, shard := range s.shards {
		if err := shard.health(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (s *AnalyticsStore) GetFields(ctx context.Context, fieldNames []string) ([]AnalyticsField, error) {
	if s == nil || len(s.shards) == 0 {
		return []AnalyticsField{}, nil
	}
	return s.shards[0].getFields(ctx, fieldNames)
}

func (s *AnalyticsStore) UpsertFields(ctx context.Context, fields []AnalyticsField, replaceMissing, purgeDeletedValues bool) error {
	for _, shard := range s.shards {
		if err := shard.upsertFields(ctx, fields, replaceMissing, purgeDeletedValues); err != nil {
			return err
		}
	}
	return nil
}

func (s *AnalyticsStore) UpsertAnnotations(ctx context.Context, rows []AnnotationRow) error {
	if len(rows) == 0 {
		return nil
	}
	grouped := make([][]AnnotationRow, len(s.shards))
	for _, row := range rows {
		idx := shardIndex(row.ObjectID, len(s.shards))
		grouped[idx] = append(grouped[idx], row)
	}
	for idx, rows := range grouped {
		if len(rows) == 0 {
			continue
		}
		if err := s.shards[idx].upsertAnnotations(ctx, rows); err != nil {
			return err
		}
	}
	return nil
}

func (s *AnalyticsStore) GetAnnotations(ctx context.Context, objectIDs []string) ([]AnnotationRow, error) {
	if s == nil || len(s.shards) == 0 {
		return []AnnotationRow{}, nil
	}
	normalized := dedupeTrimmed(objectIDs)
	if len(normalized) == 0 {
		return []AnnotationRow{}, nil
	}
	grouped := make([][]string, len(s.shards))
	for _, objectID := range normalized {
		idx := shardIndex(objectID, len(s.shards))
		grouped[idx] = append(grouped[idx], objectID)
	}
	outByObjectID := make(map[string]AnnotationRow, len(normalized))
	for idx, ids := range grouped {
		if len(ids) == 0 {
			continue
		}
		rows, err := s.shards[idx].getAnnotations(ctx, ids)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			outByObjectID[row.ObjectID] = row
		}
	}
	out := make([]AnnotationRow, 0, len(outByObjectID))
	for _, objectID := range normalized {
		row, ok := outByObjectID[objectID]
		if !ok {
			continue
		}
		out = append(out, row)
	}
	return out, nil
}

func (s *AnalyticsStore) DeleteAnnotations(ctx context.Context, objectIDs []string) (int, error) {
	normalized := dedupeTrimmed(objectIDs)
	if len(normalized) == 0 {
		return 0, nil
	}
	grouped := make([][]string, len(s.shards))
	for _, objectID := range normalized {
		idx := shardIndex(objectID, len(s.shards))
		grouped[idx] = append(grouped[idx], objectID)
	}
	for idx, ids := range grouped {
		if len(ids) == 0 {
			continue
		}
		if err := s.shards[idx].deleteAnnotations(ctx, ids); err != nil {
			return 0, err
		}
	}
	return len(normalized), nil
}

func (s *AnalyticsStore) ClearAnnotations(ctx context.Context) (int, error) {
	total := 0
	for _, shard := range s.shards {
		deleted, err := shard.clearAnnotations(ctx)
		if err != nil {
			return 0, err
		}
		total += deleted
	}
	return total, nil
}

func (s *AnalyticsStore) CompletedObjectIDs(ctx context.Context, objectIDs, fieldNames []string) ([]string, error) {
	if len(objectIDs) == 0 || len(fieldNames) == 0 {
		return []string{}, nil
	}
	grouped := make([][]string, len(s.shards))
	for _, objectID := range objectIDs {
		idx := shardIndex(objectID, len(s.shards))
		grouped[idx] = append(grouped[idx], objectID)
	}
	out := make([]string, 0, len(objectIDs))
	for idx, ids := range grouped {
		if len(ids) == 0 {
			continue
		}
		completed, err := s.shards[idx].completedObjectIDs(ctx, ids, fieldNames)
		if err != nil {
			return nil, err
		}
		out = append(out, completed...)
	}
	return out, nil
}

func (s *AnalyticsStore) Search(ctx context.Context, filters []SearchFilter, limit int) ([]SearchResult, error) {
	if len(filters) == 0 {
		return []SearchResult{}, nil
	}
	if limit < 1 {
		limit = 1
	}
	merged := make([]SearchResult, 0, limit)
	seen := make(map[string]struct{})
	for _, shard := range s.shards {
		results, err := shard.search(ctx, filters, limit)
		if err != nil {
			return nil, err
		}
		for _, item := range results {
			if _, ok := seen[item.ObjectID]; ok {
				continue
			}
			seen[item.ObjectID] = struct{}{}
			merged = append(merged, item)
		}
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].UpdatedAt.After(merged[j].UpdatedAt) })
	if len(merged) > limit {
		merged = merged[:limit]
	}
	return merged, nil
}

type clickHouseAnalyticsShard struct {
	endpoint         string
	username         string
	password         string
	database         string
	fieldsTable      string
	annotationsTable string
	httpClient       *http.Client
}

func newClickHouseAnalyticsShard(cfg AnalyticsDBConfig) (*clickHouseAnalyticsShard, error) {
	dsn := strings.TrimSpace(cfg.DSN)
	if dsn == "" {
		return nil, errors.New("analytics dsn is required")
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		return nil, err
	}
	secure := parsed.Scheme == "https" || parsed.Scheme == "clickhouses"
	scheme := "http"
	if secure {
		scheme = "https"
	}
	host := parsed.Host
	if host == "" {
		host = "localhost:8123"
	}
	if !strings.Contains(host, ":") {
		if secure {
			host += ":8443"
		} else {
			host += ":8123"
		}
	}
	username := "default"
	password := ""
	if parsed.User != nil {
		username = parsed.User.Username()
		password, _ = parsed.User.Password()
	}
	database := strings.Trim(strings.TrimSpace(parsed.Path), "/")
	if database == "" {
		database = "default"
	}
	fieldsTable := strings.TrimSpace(cfg.FieldCatalogTable)
	if fieldsTable == "" {
		fieldsTable = "vlm_field_specs"
	}
	annotationsTable := strings.TrimSpace(cfg.AnnotationStoreTable)
	if annotationsTable == "" {
		annotationsTable = "vlm_annotations"
	}
	if !identRE.MatchString(fieldsTable) || !identRE.MatchString(annotationsTable) {
		return nil, errors.New("analytics table names must be valid identifiers")
	}
	return &clickHouseAnalyticsShard{
		endpoint:         fmt.Sprintf("%s://%s", scheme, host),
		username:         username,
		password:         password,
		database:         database,
		fieldsTable:      fieldsTable,
		annotationsTable: annotationsTable,
		httpClient:       &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func (s *clickHouseAnalyticsShard) ensure(ctx context.Context) error {
	if err := s.exec(ctx, fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			field_name String,
			prompt String,
			response_type String,
			updated_at DateTime64(3, 'UTC')
		)
		ENGINE = ReplacingMergeTree(updated_at)
		ORDER BY field_name`, chIdent(s.fieldsTable))); err != nil {
		return err
	}
	return s.exec(ctx, fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			object_id String,
			values_json String,
			updated_at DateTime64(3, 'UTC')
		)
		ENGINE = ReplacingMergeTree(updated_at)
		ORDER BY object_id`, chIdent(s.annotationsTable)))
}

func (s *clickHouseAnalyticsShard) health(ctx context.Context) error {
	return s.exec(ctx, "SELECT 1")
}

func (s *clickHouseAnalyticsShard) getFields(ctx context.Context, fieldNames []string) ([]AnalyticsField, error) {
	query := fmt.Sprintf(
		"SELECT field_name, argMax(prompt, updated_at) AS prompt, argMax(response_type, updated_at) AS response_type FROM %s",
		chIdent(s.fieldsTable),
	)
	if len(fieldNames) > 0 {
		query += " WHERE field_name IN (" + quotedList(fieldNames) + ")"
	}
	query += " GROUP BY field_name ORDER BY field_name"
	var payload struct {
		Data []struct {
			FieldName    string `json:"field_name"`
			Prompt       string `json:"prompt"`
			ResponseType string `json:"response_type"`
		} `json:"data"`
	}
	if err := s.queryJSON(ctx, query, &payload); err != nil {
		return nil, err
	}
	fields := make([]AnalyticsField, 0, len(payload.Data))
	for _, row := range payload.Data {
		fields = append(fields, AnalyticsField{
			FieldName:    row.FieldName,
			Prompt:       row.Prompt,
			ResponseType: row.ResponseType,
		})
	}
	return fields, nil
}

func (s *clickHouseAnalyticsShard) upsertFields(ctx context.Context, fields []AnalyticsField, replaceMissing, purgeDeletedValues bool) error {
	var removed []string
	if replaceMissing {
		existing, err := s.getFields(ctx, nil)
		if err != nil {
			return err
		}
		incoming := make(map[string]struct{}, len(fields))
		for _, field := range fields {
			if name := strings.TrimSpace(field.FieldName); name != "" {
				incoming[name] = struct{}{}
			}
		}
		for _, field := range existing {
			if _, ok := incoming[field.FieldName]; !ok {
				removed = append(removed, field.FieldName)
			}
		}
	}
	if len(fields) > 0 {
		rows := make([]map[string]any, 0, len(fields))
		now := time.Now().UTC()
		for _, field := range fields {
			name := strings.TrimSpace(field.FieldName)
			if name == "" {
				continue
			}
			rows = append(rows, map[string]any{
				"field_name":    name,
				"prompt":        strings.TrimSpace(field.Prompt),
				"response_type": strings.ToLower(strings.TrimSpace(field.ResponseType)),
				"updated_at":    formatClickHouseTime(now),
			})
		}
		if err := s.insertJSONEachRow(ctx, s.fieldsTable, []string{"field_name", "prompt", "response_type", "updated_at"}, rows); err != nil {
			return err
		}
	}
	if len(removed) > 0 {
		if err := s.deleteFields(ctx, removed); err != nil {
			return err
		}
		if purgeDeletedValues {
			return s.purgeDeletedFieldsFromAnnotations(ctx, removed)
		}
	}
	return nil
}

func (s *clickHouseAnalyticsShard) deleteFields(ctx context.Context, fieldNames []string) error {
	normalized := dedupeTrimmed(fieldNames)
	if len(normalized) == 0 {
		return nil
	}
	return s.exec(ctx, fmt.Sprintf("ALTER TABLE %s DELETE WHERE field_name IN (%s)", chIdent(s.fieldsTable), quotedList(normalized)))
}

func (s *clickHouseAnalyticsShard) purgeDeletedFieldsFromAnnotations(ctx context.Context, fieldNames []string) error {
	removed := make(map[string]struct{}, len(fieldNames))
	for _, fieldName := range dedupeTrimmed(fieldNames) {
		removed[fieldName] = struct{}{}
	}
	if len(removed) == 0 {
		return nil
	}
	lastObjectID := ""
	for {
		query := fmt.Sprintf(
			"SELECT object_id, argMax(values_json, updated_at) AS values_json FROM %s WHERE object_id > %s GROUP BY object_id HAVING %s ORDER BY object_id LIMIT %d",
			chIdent(s.annotationsTable),
			chQuote(lastObjectID),
			buildAnnotationFieldPresenceClause("values_json", fieldNames),
			analyticsScanBatchSize,
		)
		var payload struct {
			Data []struct {
				ObjectID   string `json:"object_id"`
				ValuesJSON string `json:"values_json"`
			} `json:"data"`
		}
		if err := s.queryJSON(ctx, query, &payload); err != nil {
			return err
		}
		if len(payload.Data) == 0 {
			return nil
		}
		rows := make([]map[string]any, 0, len(payload.Data))
		now := time.Now().UTC()
		for _, row := range payload.Data {
			lastObjectID = row.ObjectID
			values := decodeValues(row.ValuesJSON)
			changed := false
			for name := range removed {
				if _, ok := values[name]; ok {
					delete(values, name)
					changed = true
				}
			}
			if !changed {
				continue
			}
			raw, _ := json.Marshal(values)
			rows = append(rows, map[string]any{
				"object_id":   row.ObjectID,
				"values_json": string(raw),
				"updated_at":  formatClickHouseTime(now),
			})
		}
		if len(rows) > 0 {
			if err := s.insertJSONEachRow(ctx, s.annotationsTable, []string{"object_id", "values_json", "updated_at"}, rows); err != nil {
				return err
			}
		}
		if len(payload.Data) < analyticsScanBatchSize {
			return nil
		}
	}
}

type annotationPayload struct {
	Raw    string
	Values map[string]string
}

func (s *clickHouseAnalyticsShard) getAnnotationPayloadBatch(ctx context.Context, objectIDs []string) (map[string]annotationPayload, error) {
	normalized := dedupeTrimmed(objectIDs)
	if len(normalized) == 0 {
		return map[string]annotationPayload{}, nil
	}
	query := fmt.Sprintf(
		"SELECT object_id, argMax(values_json, updated_at) AS values_json FROM %s WHERE object_id IN (%s) GROUP BY object_id",
		chIdent(s.annotationsTable),
		quotedList(normalized),
	)
	var payload struct {
		Data []struct {
			ObjectID   string `json:"object_id"`
			ValuesJSON string `json:"values_json"`
		} `json:"data"`
	}
	if err := s.queryJSON(ctx, query, &payload); err != nil {
		return nil, err
	}
	valuesByObjectID := make(map[string]annotationPayload, len(payload.Data))
	for _, row := range payload.Data {
		valuesByObjectID[row.ObjectID] = annotationPayload{
			Raw:    row.ValuesJSON,
			Values: decodeValues(row.ValuesJSON),
		}
	}
	return valuesByObjectID, nil
}

func (s *clickHouseAnalyticsShard) getAnnotationValuesBatch(ctx context.Context, objectIDs []string) (map[string]map[string]string, error) {
	payloads, err := s.getAnnotationPayloadBatch(ctx, objectIDs)
	if err != nil {
		return nil, err
	}
	valuesByObjectID := make(map[string]map[string]string, len(payloads))
	for objectID, payload := range payloads {
		valuesByObjectID[objectID] = payload.Values
	}
	return valuesByObjectID, nil
}

func (s *clickHouseAnalyticsShard) upsertAnnotations(ctx context.Context, rows []AnnotationRow) error {
	grouped := make(map[string]map[string]string, len(rows))
	order := make([]string, 0, len(rows))
	for _, row := range rows {
		objectID := strings.TrimSpace(row.ObjectID)
		if objectID == "" {
			continue
		}
		values, ok := grouped[objectID]
		if !ok {
			values = make(map[string]string, len(row.Values))
			grouped[objectID] = values
			order = append(order, objectID)
		}
		for key, value := range row.Values {
			key = strings.TrimSpace(key)
			if key == "" {
				continue
			}
			values[key] = value
		}
	}
	if len(order) == 0 {
		return nil
	}
	existingValues, err := s.getAnnotationPayloadBatch(ctx, order)
	if err != nil {
		return err
	}
	insertRows := make([]map[string]any, 0, len(order))
	now := time.Now().UTC()
	for _, objectID := range order {
		existingPayload, hasExisting := existingValues[objectID]
		updates := grouped[objectID]
		unchanged := hasExisting
		if unchanged {
			for key, value := range updates {
				if existingPayload.Values[key] != value {
					unchanged = false
					break
				}
			}
		}
		if unchanged {
			continue
		}
		merged := make(map[string]string, len(existingPayload.Values)+len(updates))
		for key, value := range existingPayload.Values {
			merged[key] = value
		}
		for key, value := range updates {
			merged[key] = value
		}
		raw, _ := json.Marshal(merged)
		insertRows = append(insertRows, map[string]any{
			"object_id":   objectID,
			"values_json": string(raw),
			"updated_at":  formatClickHouseTime(now),
		})
	}
	if len(insertRows) == 0 {
		return nil
	}
	return s.insertJSONEachRow(ctx, s.annotationsTable, []string{"object_id", "values_json", "updated_at"}, insertRows)
}

func (s *clickHouseAnalyticsShard) getAnnotations(ctx context.Context, objectIDs []string) ([]AnnotationRow, error) {
	normalizedIDs := dedupeTrimmed(objectIDs)
	if len(normalizedIDs) == 0 {
		return []AnnotationRow{}, nil
	}
	query := fmt.Sprintf(
		"SELECT object_id, argMax(values_json, updated_at) AS values_json FROM %s WHERE object_id IN (%s) GROUP BY object_id",
		chIdent(s.annotationsTable),
		quotedList(normalizedIDs),
	)
	var payload struct {
		Data []struct {
			ObjectID   string `json:"object_id"`
			ValuesJSON string `json:"values_json"`
		} `json:"data"`
	}
	if err := s.queryJSON(ctx, query, &payload); err != nil {
		return nil, err
	}
	out := make([]AnnotationRow, 0, len(payload.Data))
	for _, item := range payload.Data {
		out = append(out, AnnotationRow{
			ObjectID: item.ObjectID,
			Values:   decodeValues(item.ValuesJSON),
		})
	}
	return out, nil
}

func (s *clickHouseAnalyticsShard) deleteAnnotations(ctx context.Context, objectIDs []string) error {
	normalized := dedupeTrimmed(objectIDs)
	if len(normalized) == 0 {
		return nil
	}
	return s.exec(ctx, fmt.Sprintf("ALTER TABLE %s DELETE WHERE object_id IN (%s)", chIdent(s.annotationsTable), quotedList(normalized)))
}

func (s *clickHouseAnalyticsShard) clearAnnotations(ctx context.Context) (int, error) {
	var payload struct {
		Data []struct {
			Count any `json:"count"`
		} `json:"data"`
	}
	query := fmt.Sprintf("SELECT COUNT() AS count FROM (SELECT object_id FROM %s GROUP BY object_id)", chIdent(s.annotationsTable))
	if err := s.queryJSON(ctx, query, &payload); err != nil {
		return 0, err
	}
	count := 0
	if len(payload.Data) > 0 {
		parsedCount, err := parseJSONInt(payload.Data[0].Count)
		if err != nil {
			return 0, fmt.Errorf("failed to parse annotations count: %w", err)
		}
		count = parsedCount
	}
	if err := s.exec(ctx, fmt.Sprintf("TRUNCATE TABLE %s", chIdent(s.annotationsTable))); err != nil {
		return 0, err
	}
	return count, nil
}

func parseJSONInt(value any) (int, error) {
	var asInt64 int64
	switch v := value.(type) {
	case nil:
		return 0, nil
	case int:
		asInt64 = int64(v)
	case int8:
		asInt64 = int64(v)
	case int16:
		asInt64 = int64(v)
	case int32:
		asInt64 = int64(v)
	case int64:
		asInt64 = v
	case uint:
		if uint64(v) > math.MaxInt64 {
			return 0, fmt.Errorf("value %v overflows int64", value)
		}
		asInt64 = int64(v)
	case uint8:
		asInt64 = int64(v)
	case uint16:
		asInt64 = int64(v)
	case uint32:
		asInt64 = int64(v)
	case uint64:
		if v > math.MaxInt64 {
			return 0, fmt.Errorf("value %v overflows int64", value)
		}
		asInt64 = int64(v)
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return 0, fmt.Errorf("invalid numeric value: %v", value)
		}
		if math.Trunc(v) != v {
			return 0, fmt.Errorf("non-integer numeric value: %v", value)
		}
		if v < math.MinInt64 || v > math.MaxInt64 {
			return 0, fmt.Errorf("value %v overflows int64", value)
		}
		asInt64 = int64(v)
	case json.Number:
		parsed, err := v.Int64()
		if err != nil {
			return 0, err
		}
		asInt64 = parsed
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return 0, nil
		}
		parsed, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil {
			return 0, err
		}
		asInt64 = parsed
	default:
		return 0, fmt.Errorf("unsupported value type %T", value)
	}

	if asInt64 < 0 {
		return 0, fmt.Errorf("negative value: %d", asInt64)
	}
	if asInt64 > int64(math.MaxInt) {
		return 0, fmt.Errorf("value %d overflows int", asInt64)
	}
	return int(asInt64), nil
}

func (s *clickHouseAnalyticsShard) completedObjectIDs(ctx context.Context, objectIDs, fieldNames []string) ([]string, error) {
	normalizedIDs := dedupeTrimmed(objectIDs)
	normalizedFields := dedupeTrimmed(fieldNames)
	if len(normalizedIDs) == 0 || len(normalizedFields) == 0 {
		return []string{}, nil
	}
	// Large IN(...) lists can exceed ClickHouse max_query_size. Chunk IDs to keep
	// each generated query small regardless of client payload size.
	completedSet := make(map[string]struct{}, len(normalizedIDs))
	for i := 0; i < len(normalizedIDs); i += analyticsScanBatchSize {
		end := min(i+analyticsScanBatchSize, len(normalizedIDs))
		chunk := normalizedIDs[i:end]
		query := fmt.Sprintf(
			"SELECT object_id, argMax(values_json, updated_at) AS values_json FROM %s WHERE object_id IN (%s) GROUP BY object_id",
			chIdent(s.annotationsTable),
			quotedList(chunk),
		)
		var payload struct {
			Data []struct {
				ObjectID   string `json:"object_id"`
				ValuesJSON string `json:"values_json"`
			} `json:"data"`
		}
		if err := s.queryJSON(ctx, query, &payload); err != nil {
			return nil, err
		}
		for _, row := range payload.Data {
			values := decodeValues(row.ValuesJSON)
			ok := true
			for _, fieldName := range normalizedFields {
				if strings.TrimSpace(values[fieldName]) == "" {
					ok = false
					break
				}
			}
			if ok {
				completedSet[row.ObjectID] = struct{}{}
			}
		}
	}
	completed := make([]string, 0, len(completedSet))
	for _, objectID := range normalizedIDs {
		if _, ok := completedSet[objectID]; ok {
			completed = append(completed, objectID)
		}
	}
	return completed, nil
}

func (s *clickHouseAnalyticsShard) search(ctx context.Context, filters []SearchFilter, limit int) ([]SearchResult, error) {
	clauses := make([]string, 0, len(filters))
	for _, filter := range filters {
		fieldName := strings.TrimSpace(filter.FieldName)
		if fieldName == "" {
			continue
		}
		extract := fmt.Sprintf("ifNull(JSONExtractString(values_json, %s), '')", chQuote(fieldName))
		mode := strings.ToLower(strings.TrimSpace(filter.MatchMode))
		if mode == "contains" {
			clauses = append(clauses, fmt.Sprintf("positionCaseInsensitiveUTF8(%s, %s) > 0", extract, chQuote(filter.Value)))
		} else if mode == "exact" || mode == "equal" {
			clauses = append(clauses, fmt.Sprintf("lowerUTF8(%s) = lowerUTF8(%s)", extract, chQuote(filter.Value)))
		} else if mode == "not_equal" {
			clauses = append(clauses, fmt.Sprintf("lowerUTF8(%s) != lowerUTF8(%s)", extract, chQuote(filter.Value)))
		} else if mode == "greater" || mode == "greater_or_equal" || mode == "less" || mode == "less_or_equal" {
			leftNum := fmt.Sprintf("toFloat64OrNull(%s)", extract)
			rightNum := fmt.Sprintf("toFloat64OrNull(%s)", chQuote(filter.Value))
			op := ">"
			if mode == "greater_or_equal" {
				op = ">="
			} else if mode == "less" {
				op = "<"
			} else if mode == "less_or_equal" {
				op = "<="
			}
			clauses = append(clauses, fmt.Sprintf(
				"%s IS NOT NULL AND %s IS NOT NULL AND %s %s %s",
				leftNum,
				rightNum,
				leftNum,
				op,
				rightNum,
			))
		} else {
			clauses = append(clauses, fmt.Sprintf("lowerUTF8(%s) = lowerUTF8(%s)", extract, chQuote(filter.Value)))
		}
	}
	if len(clauses) == 0 {
		return []SearchResult{}, nil
	}
	subquery := fmt.Sprintf(
		"SELECT object_id, argMax(values_json, updated_at) AS values_json, max(updated_at) AS latest_updated_at FROM %s GROUP BY object_id",
		chIdent(s.annotationsTable),
	)
	query := fmt.Sprintf(
		"SELECT object_id, values_json, latest_updated_at FROM (%s) WHERE %s ORDER BY latest_updated_at DESC LIMIT %d",
		subquery,
		strings.Join(clauses, " AND "),
		limit,
	)
	var payload struct {
		Data []struct {
			ObjectID        string `json:"object_id"`
			ValuesJSON      string `json:"values_json"`
			LatestUpdatedAt string `json:"latest_updated_at"`
		} `json:"data"`
	}
	if err := s.queryJSON(ctx, query, &payload); err != nil {
		return nil, err
	}
	out := make([]SearchResult, 0, len(payload.Data))
	for _, row := range payload.Data {
		values := decodeValues(row.ValuesJSON)
		attrs := make(map[string]string)
		for _, filter := range filters {
			if value, ok := values[filter.FieldName]; ok {
				attrs[filter.FieldName] = value
			}
		}
		updatedAt, _ := parseClickHouseTime(row.LatestUpdatedAt)
		out = append(out, SearchResult{ObjectID: row.ObjectID, Attributes: attrs, UpdatedAt: updatedAt})
	}
	return out, nil
}

func buildAnnotationFieldPresenceClause(jsonExpr string, fieldNames []string) string {
	normalized := dedupeTrimmed(fieldNames)
	if len(normalized) == 0 {
		return "1"
	}
	clauses := make([]string, 0, len(normalized))
	for _, fieldName := range normalized {
		clauses = append(clauses, fmt.Sprintf("JSONHas(%s, %s)", jsonExpr, chQuote(fieldName)))
	}
	return strings.Join(clauses, " OR ")
}

func (s *clickHouseAnalyticsShard) queryJSON(ctx context.Context, query string, out any) error {
	return s.doJSON(ctx, query+" FORMAT JSON", out)
}

func (s *clickHouseAnalyticsShard) exec(ctx context.Context, query string) error {
	_, err := s.do(ctx, query, nil)
	return err
}

func (s *clickHouseAnalyticsShard) insertJSONEachRow(ctx context.Context, table string, columns []string, rows []map[string]any) error {
	if len(rows) == 0 {
		return nil
	}
	var buf bytes.Buffer
	for _, row := range rows {
		raw, err := json.Marshal(row)
		if err != nil {
			return err
		}
		buf.Write(raw)
		buf.WriteByte('\n')
	}
	columnSQL := make([]string, 0, len(columns))
	for _, column := range columns {
		columnSQL = append(columnSQL, chIdent(column))
	}
	query := fmt.Sprintf("INSERT INTO %s (%s) FORMAT JSONEachRow\n%s", chIdent(table), strings.Join(columnSQL, ", "), buf.String())
	return s.exec(ctx, query)
}

func (s *clickHouseAnalyticsShard) doJSON(ctx context.Context, query string, out any) error {
	_, err := s.do(ctx, query, func(res *http.Response) error {
		return json.NewDecoder(res.Body).Decode(out)
	})
	return err
}

func (s *clickHouseAnalyticsShard) do(ctx context.Context, query string, consume func(*http.Response) error) ([]byte, error) {
	u, err := url.Parse(s.endpoint)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("database", s.database)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(query))
	if err != nil {
		return nil, err
	}
	if s.username != "" {
		req.SetBasicAuth(s.username, s.password)
	}
	res, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		body, readErr := io.ReadAll(io.LimitReader(res.Body, 4096))
		if readErr != nil {
			return nil, readErr
		}
		return nil, fmt.Errorf("clickhouse query failed: %s: %s", res.Status, strings.TrimSpace(string(body)))
	}
	if consume != nil {
		return nil, consume(res)
	}
	_, err = io.Copy(io.Discard, res.Body)
	return nil, err
}

func chIdent(value string) string {
	return "`" + strings.ReplaceAll(value, "`", "``") + "`"
}

func chQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func quotedList(values []string) string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, chQuote(strings.TrimSpace(value)))
	}
	return strings.Join(out, ", ")
}

func dedupeTrimmed(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func shardIndex(key string, total int) int {
	if total <= 1 {
		return 0
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	return int(h.Sum32() % uint32(total))
}

func decodeValues(raw string) map[string]string {
	values := make(map[string]string)
	if strings.TrimSpace(raw) == "" {
		return values
	}
	_ = json.Unmarshal([]byte(raw), &values)
	return values
}

func formatClickHouseTime(t time.Time) string {
	return t.UTC().Format("2006-01-02 15:04:05.000")
}

func parseClickHouseTime(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	for _, layout := range []string{"2006-01-02 15:04:05.000", "2006-01-02 15:04:05", time.RFC3339Nano} {
		if parsed, err := time.ParseInLocation(layout, value, time.UTC); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid clickhouse time: %s", value)
}
