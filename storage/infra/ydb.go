package infra

import (
	"context"
	"errors"
	"fmt"
	"math"
	"path"
	"strings"
	"time"

	"github.com/ydb-platform/ydb-go-sdk/v3"
	"github.com/ydb-platform/ydb-go-sdk/v3/table"
	"github.com/ydb-platform/ydb-go-sdk/v3/table/result"
	"github.com/ydb-platform/ydb-go-sdk/v3/table/result/named"
	ydbtypes "github.com/ydb-platform/ydb-go-sdk/v3/table/types"
)

type YDBAdapter struct {
	driver        *ydb.Driver
	schema        string
	tableName     string
	indexName     string
	distance      string
	vectorSize    int
	searchTopSize int
}

func NewYDBAdapter(cfg VectorIndexConfig) (*YDBAdapter, error) {
	connStr := strings.TrimSpace(cfg.ConnStr)
	if connStr == "" {
		return nil, errors.New("ydb conn_str is required")
	}
	tableName := strings.TrimSpace(cfg.Table)
	if tableName == "" {
		return nil, errors.New("ydb vector table is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	driver, err := ydb.Open(ctx, connStr)
	if err != nil {
		return nil, err
	}
	adapter := &YDBAdapter{
		driver:        driver,
		schema:        strings.TrimSpace(cfg.Schema),
		tableName:     tableName,
		indexName:     strings.TrimSpace(cfg.IndexName),
		distance:      normalizeYDBDistance(cfg.Distance),
		vectorSize:    cfg.VectorSize,
		searchTopSize: cfg.SearchTopSize,
	}
	if err := adapter.ensureTable(ctx); err != nil {
		_ = driver.Close(ctx)
		return nil, err
	}
	return adapter, nil
}

func (y *YDBAdapter) Upsert(ctx context.Context, objectID string, embedding []float64) error {
	if strings.TrimSpace(objectID) == "" {
		return errors.New("object_id is required")
	}
	if len(embedding) == 0 {
		return errors.New("embedding is required")
	}
	if y.vectorSize > 0 && len(embedding) != y.vectorSize {
		return fmt.Errorf("expected %d dimensions, got %d", y.vectorSize, len(embedding))
	}
	query := fmt.Sprintf(`
DECLARE $object_id AS Utf8;
DECLARE $embedding AS List<Float>;
DECLARE $embedding_dim AS Int32;

UPSERT INTO %s (object_id, embedding, embedding_dim, updated_at)
VALUES (
  $object_id,
  Untag(Knn::ToBinaryStringFloat($embedding), "FloatVector"),
  $embedding_dim,
  CurrentUtcTimestamp()
);`, y.quotedTable())

	_, err := y.execute(ctx, query,
		table.ValueParam("$object_id", ydbtypes.UTF8Value(objectID)),
		table.ValueParam("$embedding", y.floatListValue(embedding)),
		table.ValueParam("$embedding_dim", ydbtypes.Int32Value(int32(len(embedding)))),
	)
	return err
}

func (y *YDBAdapter) QueryTopK(ctx context.Context, embedding []float64, topK int) ([]VectorQueryResult, error) {
	if len(embedding) == 0 {
		return nil, errors.New("embedding is required")
	}
	if topK <= 0 {
		return nil, errors.New("top_k must be > 0")
	}
	if y.vectorSize > 0 && len(embedding) != y.vectorSize {
		return nil, fmt.Errorf("expected %d dimensions, got %d", y.vectorSize, len(embedding))
	}

	var query strings.Builder
	if y.indexName != "" && y.searchTopSize > 0 {
		fmt.Fprintf(&query, "PRAGMA ydb.KMeansTreeSearchTopSize=\"%d\";\n", y.searchTopSize)
	}
	fmt.Fprintf(&query, `
DECLARE $embedding AS List<Float>;
DECLARE $top_k AS Uint64;

SELECT object_id,
       CAST(%s(embedding, Knn::ToBinaryStringFloat($embedding)) AS Double) AS distance
FROM %s%s
ORDER BY distance
LIMIT $top_k;`,
		y.distanceFunction(),
		y.quotedTable(),
		y.viewClause(),
	)

	res, err := y.execute(ctx, query.String(),
		table.ValueParam("$embedding", y.floatListValue(embedding)),
		table.ValueParam("$top_k", ydbtypes.Uint64Value(uint64(topK))),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Close() }()

	results := make([]VectorQueryResult, 0, topK)
	if !res.NextResultSet(ctx) {
		return results, res.Err()
	}
	for res.NextRow() {
		var (
			objectID string
			distance float64
		)
		if err := res.ScanNamed(
			named.OptionalWithDefault("object_id", &objectID),
			named.OptionalWithDefault("distance", &distance),
		); err != nil {
			return nil, err
		}
		results = append(results, VectorQueryResult{
			ObjectID:   objectID,
			Distance:   distance,
			Similarity: y.distanceToSimilarity(distance),
		})
	}
	return results, res.Err()
}

func (y *YDBAdapter) Delete(ctx context.Context, objectIDs []string) error {
	for _, objectID := range objectIDs {
		trimmed := strings.TrimSpace(objectID)
		if trimmed == "" {
			continue
		}
		query := fmt.Sprintf(`
DECLARE $object_id AS Utf8;
DELETE FROM %s
WHERE object_id == $object_id;`, y.quotedTable())
		if _, err := y.execute(ctx, query,
			table.ValueParam("$object_id", ydbtypes.UTF8Value(trimmed)),
		); err != nil {
			return err
		}
	}
	return nil
}

func (y *YDBAdapter) Count(ctx context.Context) (int64, error) {
	query := fmt.Sprintf(`SELECT CAST(COUNT(*) AS Uint64) AS cnt FROM %s;`, y.quotedTable())
	res, err := y.execute(ctx, query)
	if err != nil {
		return 0, err
	}
	defer func() { _ = res.Close() }()
	if !res.NextResultSet(ctx) {
		return 0, res.Err()
	}
	if !res.NextRow() {
		return 0, res.Err()
	}
	var count uint64
	if err := res.ScanNamed(named.OptionalWithDefault("cnt", &count)); err != nil {
		return 0, err
	}
	return int64(count), res.Err()
}

func (y *YDBAdapter) Health(ctx context.Context) error {
	res, err := y.execute(ctx, `SELECT 1 AS ok;`)
	if err != nil {
		return err
	}
	defer func() { _ = res.Close() }()
	return res.Err()
}

func (y *YDBAdapter) ensureTable(ctx context.Context) error {
	query := fmt.Sprintf(`
CREATE TABLE IF NOT EXISTS %s (
	object_id Utf8,
	embedding String,
	embedding_dim Int32,
	updated_at Timestamp,
	PRIMARY KEY (object_id)
);`, y.quotedTable())
	_, err := y.execute(ctx, query)
	return err
}

func (y *YDBAdapter) execute(ctx context.Context, query string, params ...table.ParameterOption) (result.Result, error) {
	var tableResult result.Result
	err := y.driver.Table().Do(ctx, func(ctx context.Context, s table.Session) error {
		_, r, err := s.Execute(
			ctx,
			table.DefaultTxControl(),
			query,
			table.NewQueryParameters(params...),
		)
		if err != nil {
			return err
		}
		tableResult = r
		return nil
	}, table.WithIdempotent())
	if err != nil {
		return nil, err
	}
	return tableResult, nil
}

func (y *YDBAdapter) floatListValue(embedding []float64) ydbtypes.Value {
	items := make([]ydbtypes.Value, 0, len(embedding))
	for _, v := range embedding {
		items = append(items, ydbtypes.FloatValue(float32(v)))
	}
	return ydbtypes.ListValue(items...)
}

func (y *YDBAdapter) distanceFunction() string {
	switch y.distance {
	case "euclidean":
		return "Knn::EuclideanDistance"
	case "manhattan":
		return "Knn::ManhattanDistance"
	default:
		return "Knn::CosineDistance"
	}
}

func (y *YDBAdapter) distanceToSimilarity(distance float64) float64 {
	switch y.distance {
	case "cosine":
		return 1 - distance
	default:
		if math.IsNaN(distance) || math.IsInf(distance, 0) {
			return 0
		}
		return 1 / (1 + distance)
	}
}

func (y *YDBAdapter) quotedTable() string {
	return "`" + strings.ReplaceAll(y.tablePath(), "`", "``") + "`"
}

func (y *YDBAdapter) tablePath() string {
	schema := strings.Trim(strings.TrimSpace(y.schema), "/")
	tableName := strings.Trim(strings.TrimSpace(y.tableName), "/")
	if schema == "" {
		return tableName
	}
	return path.Join(schema, tableName)
}

func (y *YDBAdapter) viewClause() string {
	if strings.TrimSpace(y.indexName) == "" {
		return ""
	}
	return " VIEW `" + strings.ReplaceAll(strings.TrimSpace(y.indexName), "`", "``") + "`"
}
