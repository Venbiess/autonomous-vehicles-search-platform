package vector

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	_ "github.com/lib/pq"
)

type PgVectorAdapter struct {
	db        *sql.DB
	schema    string
	tableName string
}

func NewPgVectorAdapter(connStr, schema, table string) (*PgVectorAdapter, error) {
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, err
	}
	adapter := &PgVectorAdapter{db: db, schema: schema, tableName: table}
	if err := adapter.ensureTable(context.Background()); err != nil {
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

func (p *PgVectorAdapter) QueryTopK(ctx context.Context, embedding []float64, topK int) ([]QueryResult, error) {
	query := fmt.Sprintf(`
		SELECT object_id,
			embedding <=> $1::vector AS distance,
			1 - (embedding <=> $1::vector) AS similarity
		FROM %s.%s
		ORDER BY embedding <=> $1::vector
		LIMIT $2
	`, pqIdent(p.schema), pqIdent(p.tableName))
	rows, err := p.db.QueryContext(ctx, query, vectorLiteral(embedding), topK)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]QueryResult, 0, topK)
	for rows.Next() {
		var item QueryResult
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

func (p *PgVectorAdapter) Health(ctx context.Context) error {
	return p.db.PingContext(ctx)
}

func pqIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

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
