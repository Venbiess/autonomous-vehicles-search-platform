package infra

import (
	"context"
	"errors"
	"io"
)

var ErrNotFound = errors.New("not found")

type PutResult struct {
	SizeBytes   int64
	ContentType string
}

type ObjectAdapter interface {
	GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error)
	PutStream(ctx context.Context, bucket, key string, reader io.Reader, size int64, contentType string) (PutResult, error)
	Delete(ctx context.Context, bucket, key string) error
	Health(ctx context.Context) error
	CanonicalPath(bucket, key string) string
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
	Count(ctx context.Context) (int64, error)
	Health(ctx context.Context) error
}

type VectorExistingLookup interface {
	ExistingObjectIDs(ctx context.Context, objectIDs []string) ([]string, error)
}

type VectorBatchGetter interface {
	GetByObjectIDs(ctx context.Context, objectIDs []string) (map[string][]float64, error)
}

type VectorOrphanCleaner interface {
	CleanupOrphaned(ctx context.Context, metadataSchema string, metadataTable string) (int, error)
}
