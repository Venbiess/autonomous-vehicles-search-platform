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

type ObjectInfo struct {
	SizeBytes   int64
	ContentType string
}

type ObjectAdapter interface {
	GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error)
	HeadObject(ctx context.Context, bucket, key string) (ObjectInfo, error)
	PutBytes(ctx context.Context, bucket, key string, data []byte, contentType string) (PutResult, error)
	PutStream(ctx context.Context, bucket, key string, reader io.Reader, size int64, contentType string) (PutResult, error)
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
	Count(ctx context.Context) (int64, error)
	Health(ctx context.Context) error
}

// Optional capability for efficiently checking which object IDs already have vectors.
type VectorExistingLookup interface {
	ExistingObjectIDs(ctx context.Context, objectIDs []string) ([]string, error)
}

// Optional capability for reading stored vectors by object IDs.
type VectorBatchGetter interface {
	GetByObjectIDs(ctx context.Context, objectIDs []string) (map[string][]float64, error)
}
