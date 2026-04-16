package infra

import (
	"context"
	"errors"
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
