package object

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
