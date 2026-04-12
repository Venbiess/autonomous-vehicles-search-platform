package object

import (
	"bytes"
	"context"
	"io"
	"net/url"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type MinIOAdapter struct {
	client *minio.Client
}

func NewMinIOAdapter(endpointURL, accessKey, secretKey string, useSSL bool) (*MinIOAdapter, error) {
	parsed, err := url.Parse(endpointURL)
	if err != nil {
		return nil, err
	}
	endpoint := parsed.Host
	if endpoint == "" {
		endpoint = strings.TrimPrefix(strings.TrimPrefix(endpointURL, "http://"), "https://")
	}
	cli, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, err
	}
	return &MinIOAdapter{client: cli}, nil
}

func (m *MinIOAdapter) GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error) {
	obj, err := m.client.GetObject(ctx, bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, "", err
	}
	defer obj.Close()
	stat, err := obj.Stat()
	if err != nil {
		return nil, "", err
	}
	body, err := io.ReadAll(obj)
	if err != nil {
		return nil, "", err
	}
	contentType := stat.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return body, contentType, nil
}

func (m *MinIOAdapter) PutBytes(ctx context.Context, bucket, key string, data []byte, contentType string) (PutResult, error) {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	res, err := m.client.PutObject(ctx, bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return PutResult{}, err
	}
	return PutResult{SizeBytes: res.Size, ContentType: contentType}, nil
}

func (m *MinIOAdapter) Delete(ctx context.Context, bucket, key string) error {
	return m.client.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{})
}

func (m *MinIOAdapter) Health(ctx context.Context) error {
	_, err := m.client.ListBuckets(ctx)
	return err
}
