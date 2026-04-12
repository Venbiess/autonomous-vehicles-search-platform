package infra

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/ClickHouse/clickhouse-go/v2"
)

type AnalyticsDBConfig struct {
	Provider string `yaml:"provider"`
	DSN      string `yaml:"dsn"`

	// Preferred names.
	FieldCatalogTable    string `yaml:"field_catalog_table"`
	AnnotationStoreTable string `yaml:"annotation_store_table"`

	// Legacy aliases (kept for backward compatibility).
	FieldsTable      string `yaml:"fields_table"`
	AnnotationsTable string `yaml:"annotations_table"`
}

type ClickHouseAdapter struct {
	db               *sql.DB
	fieldsTable      string
	annotationsTable string
}

func NewClickHouseAdapter(dsn, fieldsTable, annotationsTable string) (*ClickHouseAdapter, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, errors.New("clickhouse dsn is required")
	}
	if strings.TrimSpace(fieldsTable) == "" {
		return nil, errors.New("analytics field catalog table is required")
	}
	if strings.TrimSpace(annotationsTable) == "" {
		return nil, errors.New("analytics annotation store table is required")
	}

	db, err := sql.Open("clickhouse", dsn)
	if err != nil {
		return nil, err
	}

	pingCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, err
	}

	adapter := &ClickHouseAdapter{
		db:               db,
		fieldsTable:      fieldsTable,
		annotationsTable: annotationsTable,
	}
	if err := adapter.Ensure(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return adapter, nil
}

func (a *ClickHouseAdapter) Ensure(ctx context.Context) error {
	fieldsDDL := fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			field_name String,
			prompt String,
			response_type String,
			updated_at DateTime64(3, 'UTC')
		)
		ENGINE = ReplacingMergeTree(updated_at)
		ORDER BY field_name
	`, a.fieldsTable)
	if _, err := a.db.ExecContext(ctx, fieldsDDL); err != nil {
		return err
	}

	annotationsDDL := fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			object_id String,
			values_json String,
			updated_at DateTime64(3, 'UTC')
		)
		ENGINE = ReplacingMergeTree(updated_at)
		ORDER BY object_id
	`, a.annotationsTable)
	_, err := a.db.ExecContext(ctx, annotationsDDL)
	return err
}

func (a *ClickHouseAdapter) GetFields(ctx context.Context, fieldNames []string) ([]AnalyticsField, error) {
	query := fmt.Sprintf(`
		SELECT field_name, argMax(prompt, updated_at) AS prompt, argMax(response_type, updated_at) AS response_type
		FROM %s
	`, a.fieldsTable)
	args := make([]any, 0)
	if len(fieldNames) > 0 {
		query += " WHERE field_name IN ("
		for i, name := range fieldNames {
			if i > 0 {
				query += ","
			}
			query += "?"
			args = append(args, name)
		}
		query += ")"
	}
	query += " GROUP BY field_name ORDER BY field_name"

	rows, err := a.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]AnalyticsField, 0)
	for rows.Next() {
		var item AnalyticsField
		if err := rows.Scan(&item.FieldName, &item.Prompt, &item.ResponseType); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (a *ClickHouseAdapter) UpsertFields(ctx context.Context, fields []AnalyticsField) error {
	if len(fields) == 0 {
		return nil
	}
	now := time.Now().UTC()
	query := fmt.Sprintf("INSERT INTO %s (field_name, prompt, response_type, updated_at) VALUES (?, ?, ?, ?)", a.fieldsTable)
	for _, field := range fields {
		if _, err := a.db.ExecContext(ctx, query, field.FieldName, field.Prompt, field.ResponseType, now); err != nil {
			return err
		}
	}
	return nil
}

func (a *ClickHouseAdapter) UpsertAnnotations(ctx context.Context, rows []AnalyticsAnnotationRow) error {
	if len(rows) == 0 {
		return nil
	}
	now := time.Now().UTC()
	insert := fmt.Sprintf("INSERT INTO %s (object_id, values_json, updated_at) VALUES (?, ?, ?)", a.annotationsTable)
	for _, row := range rows {
		existing, err := a.getAnnotationValues(ctx, row.ObjectID)
		if err != nil {
			return err
		}
		if existing == nil {
			existing = map[string]string{}
		}
		for k, v := range row.Values {
			existing[k] = v
		}
		payload, err := json.Marshal(existing)
		if err != nil {
			return err
		}
		if _, err := a.db.ExecContext(ctx, insert, row.ObjectID, string(payload), now); err != nil {
			return err
		}
	}
	return nil
}

func (a *ClickHouseAdapter) DeleteAnnotations(ctx context.Context, objectIDs []string) error {
	if len(objectIDs) == 0 {
		return nil
	}
	query := fmt.Sprintf("ALTER TABLE %s DELETE WHERE object_id IN (", a.annotationsTable)
	args := make([]any, 0, len(objectIDs))
	for i, id := range objectIDs {
		if i > 0 {
			query += ","
		}
		query += "?"
		args = append(args, id)
	}
	query += ")"
	_, err := a.db.ExecContext(ctx, query, args...)
	return err
}

func (a *ClickHouseAdapter) ClearAnnotations(ctx context.Context) (int64, error) {
	countQuery := fmt.Sprintf("SELECT COUNT() FROM (SELECT object_id FROM %s GROUP BY object_id)", a.annotationsTable)
	var count int64
	if err := a.db.QueryRowContext(ctx, countQuery).Scan(&count); err != nil {
		return 0, err
	}
	truncate := fmt.Sprintf("TRUNCATE TABLE %s", a.annotationsTable)
	if _, err := a.db.ExecContext(ctx, truncate); err != nil {
		return 0, err
	}
	return count, nil
}

func (a *ClickHouseAdapter) CompletedObjectIDs(ctx context.Context, objectIDs []string, fieldNames []string) ([]string, error) {
	if len(objectIDs) == 0 || len(fieldNames) == 0 {
		return []string{}, nil
	}
	subquery := fmt.Sprintf("SELECT object_id, argMax(values_json, updated_at) AS values_json FROM %s GROUP BY object_id", a.annotationsTable)
	query := "SELECT object_id FROM (" + subquery + ") WHERE object_id IN ("
	args := make([]any, 0, len(objectIDs)+len(fieldNames))
	for i, id := range objectIDs {
		if i > 0 {
			query += ","
		}
		query += "?"
		args = append(args, id)
	}
	query += ")"
	for _, name := range fieldNames {
		query += " AND lengthUTF8(ifNull(JSONExtractString(values_json, ?), '')) > 0"
		args = append(args, name)
	}

	rows, err := a.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	completed := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		completed = append(completed, id)
	}
	return completed, rows.Err()
}

func (a *ClickHouseAdapter) Search(ctx context.Context, filters []AnalyticsFilter, limit int) ([]AnalyticsSearchResult, error) {
	if len(filters) == 0 {
		return []AnalyticsSearchResult{}, nil
	}
	if limit <= 0 {
		limit = 100
	}

	subquery := fmt.Sprintf("SELECT object_id, argMax(values_json, updated_at) AS values_json, max(updated_at) AS updated_at FROM %s GROUP BY object_id", a.annotationsTable)
	query := "SELECT object_id, values_json FROM (" + subquery + ") WHERE "
	args := make([]any, 0, len(filters)*2+1)
	clauses := make([]string, 0, len(filters))
	for _, filter := range filters {
		extract := "ifNull(JSONExtractString(values_json, ?), '')"
		if strings.ToLower(filter.MatchMode) == "contains" {
			clauses = append(clauses, "positionCaseInsensitiveUTF8("+extract+", ?) > 0")
			args = append(args, filter.FieldName, filter.Value)
		} else {
			clauses = append(clauses, "lowerUTF8("+extract+") = lowerUTF8(?)")
			args = append(args, filter.FieldName, filter.Value)
		}
	}
	query += strings.Join(clauses, " AND ") + " ORDER BY updated_at DESC LIMIT ?"
	args = append(args, limit)

	rows, err := a.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := make([]AnalyticsSearchResult, 0)
	for rows.Next() {
		var id string
		var valuesJSON string
		if err := rows.Scan(&id, &valuesJSON); err != nil {
			return nil, err
		}
		attributes := map[string]string{}
		_ = json.Unmarshal([]byte(valuesJSON), &attributes)
		selected := map[string]string{}
		for _, filter := range filters {
			if v, ok := attributes[filter.FieldName]; ok {
				selected[filter.FieldName] = v
			}
		}
		results = append(results, AnalyticsSearchResult{ObjectID: id, Attributes: selected})
	}
	return results, rows.Err()
}

func (a *ClickHouseAdapter) Health(ctx context.Context) error {
	return a.db.PingContext(ctx)
}

func (a *ClickHouseAdapter) getAnnotationValues(ctx context.Context, objectID string) (map[string]string, error) {
	query := fmt.Sprintf(`
		SELECT argMax(values_json, updated_at)
		FROM %s
		WHERE object_id = ?
	`, a.annotationsTable)
	var valuesJSON sql.NullString
	if err := a.db.QueryRowContext(ctx, query, objectID).Scan(&valuesJSON); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if !valuesJSON.Valid || strings.TrimSpace(valuesJSON.String) == "" {
		return nil, nil
	}
	result := map[string]string{}
	if err := json.Unmarshal([]byte(valuesJSON.String), &result); err != nil {
		return nil, err
	}
	return result, nil
}
