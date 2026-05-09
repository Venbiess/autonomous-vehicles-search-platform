package infra

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/lib/pq"
)

const pgvectorUpsertChunkSize = 128
const pgvectorLookupChunkSize = 512
const pgvectorStartupWait = 60 * time.Second
const pgvectorStartupPingInterval = 2 * time.Second
const pgvectorDefaultANNLists = 100
const pgvectorDefaultHNSWEfSearch = 40

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
	db         *sql.DB
	schema     string
	tableName  string
	vectorSize int
}

func NewPgVectorAdapter(connStr, schema, table string, vectorSize int) (*PgVectorAdapter, error) {
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

	if err := waitForPostgres(db, pgvectorStartupWait, pgvectorStartupPingInterval); err != nil {
		_ = db.Close()
		return nil, err
	}

	if vectorSize < 0 {
		vectorSize = 0
	}
	adapter := &PgVectorAdapter{
		db: db, schema: schema, tableName: table, vectorSize: vectorSize,
	}
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
	vectorType := "vector"
	if p.vectorSize > 0 {
		vectorType = fmt.Sprintf("vector(%d)", p.vectorSize)
	}
	query := fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s.%s (
			object_id TEXT PRIMARY KEY,
			embedding %s NOT NULL,
			embedding_dim INT NOT NULL,
			updated_at TIMESTAMPTZ DEFAULT now()
		)
	`, pqIdent(p.schema), pqIdent(p.tableName), vectorType)
	if _, err := p.db.ExecContext(ctx, query); err != nil {
		return err
	}
	if err := p.ensureVectorDimensions(ctx); err != nil {
		return err
	}
	return p.ensureANNIndexes(ctx)
}

func (p *PgVectorAdapter) ensureVectorDimensions(ctx context.Context) error {
	if p.vectorSize <= 0 {
		_, hasDimensions, err := p.currentVectorDimensions(ctx)
		if err != nil {
			return err
		}
		if !hasDimensions {
			return nil
		}
		// Allow mixed embedding dimensions when vector_size is unset.
		// This is useful when users switch embedder models (e.g. 640 -> 2048)
		// and rebuild vectors without recreating metadata storage.
		query := fmt.Sprintf(
			"ALTER TABLE %s ALTER COLUMN embedding TYPE vector USING embedding::vector",
			p.qualifiedTable(),
		)
		if _, err := p.db.ExecContext(ctx, query); err != nil {
			return err
		}
		return nil
	}
	currentSize, hasDimensions, err := p.currentVectorDimensions(ctx)
	if err != nil {
		return err
	}
	if hasDimensions && currentSize == p.vectorSize {
		return nil
	}
	query := fmt.Sprintf(
		"ALTER TABLE %s ALTER COLUMN embedding TYPE vector(%d) USING embedding::vector(%d)",
		p.qualifiedTable(),
		p.vectorSize,
		p.vectorSize,
	)
	if _, err := p.db.ExecContext(ctx, query); err != nil {
		return err
	}
	return nil
}

func (p *PgVectorAdapter) ensureANNIndexes(ctx context.Context) error {
	hasDimensions, err := p.vectorColumnHasDimensions(ctx)
	if err != nil {
		return err
	}
	if !hasDimensions {
		if err := p.dropANNIndexes(ctx); err != nil {
			return err
		}
		log.Printf("pgvector: ANN index skipped for %s.%s (embedding column has no fixed dimensions)", p.schema, p.tableName)
		return nil
	}

	qualified := p.qualifiedTable()
	hnswIdx := p.indexName("embedding_hnsw_idx")
	hnswQuery := fmt.Sprintf(
		"CREATE INDEX IF NOT EXISTS %s ON %s USING hnsw (embedding vector_cosine_ops)",
		hnswIdx,
		qualified,
	)
	if _, err := p.db.ExecContext(ctx, hnswQuery); err == nil {
		return nil
	}
	log.Printf("pgvector: hnsw index creation skipped, falling back to ivfflat")

	ivfIdx := p.indexName("embedding_ivfflat_idx")
	ivfQuery := fmt.Sprintf(
		"CREATE INDEX IF NOT EXISTS %s ON %s USING ivfflat (embedding vector_cosine_ops) WITH (lists = %d)",
		ivfIdx,
		qualified,
		pgvectorDefaultANNLists,
	)
	if _, err := p.db.ExecContext(ctx, ivfQuery); err == nil {
		return nil
	}
	log.Printf("pgvector: ivfflat index creation skipped")
	return nil
}

func (p *PgVectorAdapter) dropANNIndexes(ctx context.Context) error {
	for _, suffix := range []string{"embedding_hnsw_idx", "embedding_ivfflat_idx"} {
		query := fmt.Sprintf(
			"DROP INDEX IF EXISTS %s.%s",
			pqIdent(p.schema),
			p.indexName(suffix),
		)
		if _, err := p.db.ExecContext(ctx, query); err != nil {
			return err
		}
	}
	return nil
}

func (p *PgVectorAdapter) vectorColumnHasDimensions(ctx context.Context) (bool, error) {
	_, hasDimensions, err := p.currentVectorDimensions(ctx)
	return hasDimensions, err
}

func (p *PgVectorAdapter) currentVectorDimensions(ctx context.Context) (int, bool, error) {
	const query = `SELECT format_type(a.atttypid, a.atttypmod)
		 FROM pg_attribute a
		 JOIN pg_class c ON c.oid = a.attrelid
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = $1
		   AND c.relname = $2
		   AND a.attname = 'embedding'
		   AND a.attnum > 0
		   AND NOT a.attisdropped
		 LIMIT 1`
	var colType string
	if err := p.db.QueryRowContext(ctx, query, p.schema, p.tableName).Scan(&colType); err != nil {
		return 0, false, err
	}
	colType = strings.ToLower(strings.TrimSpace(colType))
	if !strings.HasPrefix(colType, "vector(") {
		return 0, false, nil
	}
	sizeText := strings.TrimSuffix(strings.TrimPrefix(colType, "vector("), ")")
	size, err := strconv.Atoi(sizeText)
	if err != nil {
		return 0, false, err
	}
	return size, true, nil
}

func (p *PgVectorAdapter) Upsert(ctx context.Context, objectID string, embedding []float64) error {
	return p.execUpsertRows(ctx, []string{objectID}, [][]float64{embedding})
}

func (p *PgVectorAdapter) UpsertBatch(ctx context.Context, objectIDs []string, embeddings [][]float64) error {
	if len(objectIDs) == 0 {
		return nil
	}
	if len(objectIDs) != len(embeddings) {
		return errors.New("object_ids and embeddings length mismatch")
	}

	for start := 0; start < len(objectIDs); start += pgvectorUpsertChunkSize {
		end := start + pgvectorUpsertChunkSize
		if end > len(objectIDs) {
			end = len(objectIDs)
		}
		if err := p.execUpsertRows(ctx, objectIDs[start:end], embeddings[start:end]); err != nil {
			return err
		}
	}
	return nil
}

func (p *PgVectorAdapter) execUpsertRows(ctx context.Context, objectIDs []string, embeddings [][]float64) error {
	if len(objectIDs) != len(embeddings) {
		return errors.New("object_ids and embeddings length mismatch")
	}
	values := make([]string, 0, len(objectIDs))
	args := make([]any, 0, len(objectIDs)*3)
	for i := range objectIDs {
		base := i*3 + 1
		values = append(values, fmt.Sprintf("($%d, translate($%d::text, '{}', '[]')::vector, $%d)", base, base+1, base+2))
		args = append(args, objectIDs[i], pq.Array(embeddings[i]), len(embeddings[i]))
	}
	query := p.buildUpsertSQL(strings.Join(values, ","))
	_, err := p.db.ExecContext(ctx, query, args...)
	return err
}

func (p *PgVectorAdapter) QueryTopK(ctx context.Context, embedding []float64, topK int) ([]VectorQueryResult, error) {
	if topK <= 0 {
		topK = 5
	}
	efSearch := topK
	if efSearch < pgvectorDefaultHNSWEfSearch {
		efSearch = pgvectorDefaultHNSWEfSearch
	}

	conn, err := p.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, fmt.Sprintf("SET hnsw.ef_search = %d", efSearch)); err != nil {
		log.Printf("pgvector: failed to set hnsw.ef_search=%d: %v", efSearch, err)
	} else {
		defer func() {
			if _, err := conn.ExecContext(context.Background(), "RESET hnsw.ef_search"); err != nil {
				log.Printf("pgvector: failed to reset hnsw.ef_search: %v", err)
			}
		}()
	}

	query := fmt.Sprintf(`
		SELECT object_id,
			embedding <=> translate($1::text, '{}', '[]')::vector AS distance,
			1 - (embedding <=> translate($1::text, '{}', '[]')::vector) AS similarity
		FROM %s
		WHERE embedding_dim = $3
		ORDER BY embedding <=> translate($1::text, '{}', '[]')::vector
		LIMIT $2
	`, p.qualifiedTable())
	rows, err := conn.QueryContext(ctx, query, pq.Array(embedding), topK, len(embedding))
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return results, nil
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
	query := fmt.Sprintf("DELETE FROM %s WHERE object_id IN (%s)", p.qualifiedTable(), strings.Join(args, ","))
	_, err := p.db.ExecContext(ctx, query, vals...)
	return err
}

func (p *PgVectorAdapter) CleanupOrphaned(ctx context.Context, metadataSchema string, metadataTable string) (int, error) {
	schema := strings.TrimSpace(metadataSchema)
	table := strings.TrimSpace(metadataTable)
	if schema == "" {
		schema = "public"
	}
	if table == "" {
		table = "objects"
	}
	query := fmt.Sprintf(
		`DELETE FROM %s AS v
		 WHERE NOT EXISTS (
		   SELECT 1 FROM %s.%s AS o WHERE o.object_id = v.object_id
		 )`,
		p.qualifiedTable(),
		pqIdent(schema),
		pqIdent(table),
	)
	result, err := p.db.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if affected < 0 {
		return 0, nil
	}
	return int(affected), nil
}

func (p *PgVectorAdapter) Count(ctx context.Context) (int64, error) {
	query := fmt.Sprintf("SELECT COUNT(*) FROM %s", p.qualifiedTable())
	var total int64
	if err := p.db.QueryRowContext(ctx, query).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}

func (p *PgVectorAdapter) ExistingObjectIDs(ctx context.Context, objectIDs []string) ([]string, error) {
	if len(objectIDs) == 0 {
		return []string{}, nil
	}

	out := make([]string, 0, len(objectIDs))
	for start := 0; start < len(objectIDs); start += pgvectorLookupChunkSize {
		end := start + pgvectorLookupChunkSize
		if end > len(objectIDs) {
			end = len(objectIDs)
		}
		chunk := objectIDs[start:end]
		args := make([]string, 0, len(chunk))
		vals := make([]any, 0, len(chunk))
		for i, id := range chunk {
			args = append(args, fmt.Sprintf("$%d", i+1))
			vals = append(vals, id)
		}
		query := fmt.Sprintf(
			"SELECT object_id FROM %s WHERE object_id IN (%s)",
			p.qualifiedTable(),
			strings.Join(args, ","),
		)
		rows, err := p.db.QueryContext(ctx, query, vals...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var objectID string
			if err := rows.Scan(&objectID); err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, objectID)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

func (p *PgVectorAdapter) GetByObjectIDs(ctx context.Context, objectIDs []string) (map[string][]float64, error) {
	out := make(map[string][]float64)
	if len(objectIDs) == 0 {
		return out, nil
	}

	for start := 0; start < len(objectIDs); start += pgvectorLookupChunkSize {
		end := start + pgvectorLookupChunkSize
		if end > len(objectIDs) {
			end = len(objectIDs)
		}
		chunk := objectIDs[start:end]
		args := make([]string, 0, len(chunk))
		vals := make([]any, 0, len(chunk))
		for i, id := range chunk {
			args = append(args, fmt.Sprintf("$%d", i+1))
			vals = append(vals, id)
		}
		query := fmt.Sprintf(
			"SELECT object_id, translate(embedding::text, '[]', '{}')::float8[] FROM %s WHERE object_id IN (%s)",
			p.qualifiedTable(),
			strings.Join(args, ","),
		)
		rows, err := p.db.QueryContext(ctx, query, vals...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var objectID string
			var rawVector pq.Float64Array
			if err := rows.Scan(&objectID, &rawVector); err != nil {
				rows.Close()
				return nil, err
			}
			out[objectID] = append([]float64(nil), rawVector...)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	return out, nil
}

func (p *PgVectorAdapter) Health(ctx context.Context) error { return p.db.PingContext(ctx) }

func (p *PgVectorAdapter) qualifiedTable() string {
	return fmt.Sprintf("%s.%s", pqIdent(p.schema), pqIdent(p.tableName))
}

func (p *PgVectorAdapter) indexName(suffix string) string {
	return pqIdent(fmt.Sprintf("%s_%s", p.tableName, suffix))
}

func (p *PgVectorAdapter) buildUpsertSQL(valuesExpr string) string {
	return fmt.Sprintf(`
		INSERT INTO %s (object_id, embedding, embedding_dim)
		VALUES %s
		ON CONFLICT (object_id)
		DO UPDATE SET embedding = EXCLUDED.embedding,
			embedding_dim = EXCLUDED.embedding_dim,
			updated_at = now()
	`, p.qualifiedTable(), valuesExpr)
}

func pqIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

func waitForPostgres(db *sql.DB, timeout time.Duration, interval time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := db.PingContext(ctx)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(interval)
	}
	return fmt.Errorf("postgres is not ready after %s: %w", timeout, lastErr)
}
