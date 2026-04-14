package infra

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

type VectorIndexConfig struct {
	Provider    string `yaml:"provider"`
	ConnStr     string `yaml:"conn_str"`
	Schema      string `yaml:"schema"`
	Table       string `yaml:"table"`
	EndpointURL string `yaml:"endpoint_url"`
	APIKey      string `yaml:"api_key"`
	Collection  string `yaml:"collection"`
	Distance    string `yaml:"distance"`
	VectorSize  int    `yaml:"vector_size"`
	TimeoutSec  int    `yaml:"timeout_sec"`
}

type PgVectorAdapter struct {
	db        *sql.DB
	schema    string
	tableName string
}

func NewPgVectorAdapter(connStr, schema, table string) (*PgVectorAdapter, error) {
	if strings.TrimSpace(connStr) == "" {
		return nil, errors.New("postgres connection string is required")
	}
	if strings.TrimSpace(schema) == "" {
		return nil, errors.New("vector schema is required")
	}
	if strings.TrimSpace(table) == "" {
		return nil, errors.New("vector table is required")
	}

	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, err
	}

	pingCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, err
	}

	adapter := &PgVectorAdapter{db: db, schema: schema, tableName: table}
	if err := adapter.ensureTable(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return adapter, nil
}

func (p *PgVectorAdapter) ensureTable(ctx context.Context) error {
	if _, err := p.db.ExecContext(ctx, fmt.Sprintf("CREATE SCHEMA IF NOT EXISTS %s", pqIdent(p.schema))); err != nil {
		return err
	}
	if _, err := p.db.ExecContext(ctx, "CREATE EXTENSION IF NOT EXISTS vector"); err != nil {
		return err
	}
	query := fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s.%s (
			object_id TEXT PRIMARY KEY,
			embedding vector NOT NULL,
			embedding_dim INT NOT NULL,
			updated_at TIMESTAMPTZ DEFAULT now()
		)
	`, pqIdent(p.schema), pqIdent(p.tableName))
	_, err := p.db.ExecContext(ctx, query)
	return err
}

func (p *PgVectorAdapter) Upsert(ctx context.Context, objectID string, embedding []float64) error {
	query := fmt.Sprintf(`
		INSERT INTO %s.%s (object_id, embedding, embedding_dim)
		VALUES ($1, $2::vector, $3)
		ON CONFLICT (object_id)
		DO UPDATE SET embedding = EXCLUDED.embedding,
			embedding_dim = EXCLUDED.embedding_dim,
			updated_at = now()
	`, pqIdent(p.schema), pqIdent(p.tableName))
	_, err := p.db.ExecContext(ctx, query, objectID, vectorLiteral(embedding), len(embedding))
	return err
}

func (p *PgVectorAdapter) QueryTopK(ctx context.Context, embedding []float64, topK int) ([]VectorQueryResult, error) {
	query := fmt.Sprintf(`
		SELECT object_id,
			embedding <=> $1::vector AS distance,
			1 - (embedding <=> $1::vector) AS similarity
		FROM %s.%s
		WHERE embedding_dim = $3
		ORDER BY embedding <=> $1::vector
		LIMIT $2
	`, pqIdent(p.schema), pqIdent(p.tableName))
	rows, err := p.db.QueryContext(ctx, query, vectorLiteral(embedding), topK, len(embedding))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]VectorQueryResult, 0, topK)
	for rows.Next() {
		var item VectorQueryResult
		if err := rows.Scan(&item.ObjectID, &item.Distance, &item.Similarity); err != nil {
			return nil, err
		}
		results = append(results, item)
	}
	return results, rows.Err()
}

func (p *PgVectorAdapter) Delete(ctx context.Context, objectIDs []string) error {
	if len(objectIDs) == 0 {
		return nil
	}
	args := make([]string, len(objectIDs))
	vals := make([]any, len(objectIDs))
	for i, id := range objectIDs {
		args[i] = fmt.Sprintf("$%d", i+1)
		vals[i] = id
	}
	query := fmt.Sprintf("DELETE FROM %s.%s WHERE object_id IN (%s)", pqIdent(p.schema), pqIdent(p.tableName), strings.Join(args, ","))
	_, err := p.db.ExecContext(ctx, query, vals...)
	return err
}

func (p *PgVectorAdapter) Health(ctx context.Context) error { return p.db.PingContext(ctx) }

func pqIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

func vectorLiteral(values []float64) string {
	if len(values) == 0 {
		return "[]"
	}
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = fmt.Sprintf("%.8f", value)
	}
	return "[" + strings.Join(parts, ",") + "]"
}
