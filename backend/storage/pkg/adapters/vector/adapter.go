package vector

import "context"

type QueryResult struct {
	ObjectID   string
	Distance   float64
	Similarity float64
}

type VectorAdapter interface {
	Upsert(ctx context.Context, objectID string, embedding []float64) error
	QueryTopK(ctx context.Context, embedding []float64, topK int) ([]QueryResult, error)
	Delete(ctx context.Context, objectIDs []string) error
	Health(ctx context.Context) error
}
