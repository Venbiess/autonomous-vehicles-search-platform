package infra

import "context"

type PutResult struct {
	SizeBytes   int64
	ContentType string
}

type ObjectAdapter interface {
	GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error)
	PutBytes(ctx context.Context, bucket, key string, data []byte, contentType string) (PutResult, error)
	Delete(ctx context.Context, bucket, key string) error
	Health(ctx context.Context) error
}

type VectorQueryResult struct {
	ObjectID   string
	Distance   float64
	Similarity float64
}

type VectorAdapter interface {
	Upsert(ctx context.Context, objectID string, embedding []float64) error
	QueryTopK(ctx context.Context, embedding []float64, topK int) ([]VectorQueryResult, error)
	Delete(ctx context.Context, objectIDs []string) error
	Health(ctx context.Context) error
}

type AnalyticsField struct {
	FieldName    string
	Prompt       string
	ResponseType string
}

type AnalyticsAnnotationRow struct {
	ObjectID string
	Values   map[string]string
}

type AnalyticsFilter struct {
	FieldName string
	Value     string
	MatchMode string
}

type AnalyticsSearchResult struct {
	ObjectID   string
	Attributes map[string]string
}

type AnalyticsAdapter interface {
	Ensure(ctx context.Context) error
	GetFields(ctx context.Context, fieldNames []string) ([]AnalyticsField, error)
	UpsertFields(ctx context.Context, fields []AnalyticsField) error
	UpsertAnnotations(ctx context.Context, rows []AnalyticsAnnotationRow) error
	DeleteAnnotations(ctx context.Context, objectIDs []string) error
	ClearAnnotations(ctx context.Context) (int64, error)
	CompletedObjectIDs(ctx context.Context, objectIDs []string, fieldNames []string) ([]string, error)
	Search(ctx context.Context, filters []AnalyticsFilter, limit int) ([]AnalyticsSearchResult, error)
	Health(ctx context.Context) error
}
