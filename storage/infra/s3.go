package infra

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type ObjectStoreConfig struct {
	Provider       string `yaml:"provider"`
	EndpointURL    string `yaml:"endpoint_url"`
	AccessKey      string `yaml:"access_key"`
	SecretKey      string `yaml:"secret_key"`
	SessionToken   string `yaml:"session_token"`
	Region         string `yaml:"region"`
	UseSSL         bool   `yaml:"use_ssl"`
	ForcePathStyle bool   `yaml:"force_path_style"`
}

type S3Adapter struct {
	client *minio.Client
}

func NewS3Adapter(cfg ObjectStoreConfig) (*S3Adapter, error) {
	if strings.TrimSpace(cfg.EndpointURL) == "" {
		return nil, errors.New("s3 endpoint is required")
	}

	secure := cfg.UseSSL
	parsed, err := url.Parse(cfg.EndpointURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(parsed.Path) != "" && strings.TrimSpace(parsed.Path) != "/" {
		return nil, errors.New("s3 endpoint must not include URL path")
	}
	if parsed.Scheme == "https" {
		secure = true
	}

	endpoint := parsed.Host
	if endpoint == "" {
		endpoint = strings.TrimPrefix(strings.TrimPrefix(cfg.EndpointURL, "http://"), "https://")
	}

	creds := credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, cfg.SessionToken)
	bucketLookup := minio.BucketLookupAuto
	if cfg.ForcePathStyle {
		bucketLookup = minio.BucketLookupPath
	}
	cli, err := minio.New(endpoint, &minio.Options{
		Creds:        creds,
		Secure:       secure,
		Region:       cfg.Region,
		BucketLookup: bucketLookup,
	})
	if err != nil {
		return nil, err
	}
	return &S3Adapter{client: cli}, nil
}

func (m *S3Adapter) GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error) {
	obj, err := m.client.GetObject(ctx, bucket, key, minio.GetObjectOptions{})
	if err != nil {
		if isMinioNotFound(err) {
			return nil, "", fmt.Errorf("%w: object %s/%s", ErrNotFound, bucket, key)
		}
		return nil, "", err
	}
	defer obj.Close()
	stat, err := obj.Stat()
	if err != nil {
		if isMinioNotFound(err) {
			return nil, "", fmt.Errorf("%w: object %s/%s", ErrNotFound, bucket, key)
		}
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

func (m *S3Adapter) HeadObject(ctx context.Context, bucket, key string) (ObjectInfo, error) {
	stat, err := m.client.StatObject(ctx, bucket, key, minio.StatObjectOptions{})
	if err != nil {
		if isMinioNotFound(err) {
			return ObjectInfo{}, fmt.Errorf("%w: object %s/%s", ErrNotFound, bucket, key)
		}
		return ObjectInfo{}, err
	}
	contentType := stat.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return ObjectInfo{
		SizeBytes:   stat.Size,
		ContentType: contentType,
	}, nil
}

func (m *S3Adapter) PutBytes(ctx context.Context, bucket, key string, data []byte, contentType string) (PutResult, error) {
	return m.PutStream(ctx, bucket, key, bytes.NewReader(data), int64(len(data)), contentType)
}

func (m *S3Adapter) PutStream(ctx context.Context, bucket, key string, reader io.Reader, size int64, contentType string) (PutResult, error) {
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	exists, err := m.client.BucketExists(ctx, bucket)
	if err != nil {
		return PutResult{}, err
	}
	if !exists {
		if err := m.client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			alreadyOwned := strings.TrimSpace(minio.ToErrorResponse(err).Code) == "BucketAlreadyOwnedByYou"
			alreadyExists := strings.TrimSpace(minio.ToErrorResponse(err).Code) == "BucketAlreadyExists"
			if !alreadyOwned && !alreadyExists {
				return PutResult{}, err
			}
		}
	}

	res, err := m.client.PutObject(ctx, bucket, key, reader, size, minio.PutObjectOptions{ContentType: contentType})
	if err != nil {
		return PutResult{}, err
	}

	return PutResult{SizeBytes: res.Size, ContentType: contentType}, nil
}

func (m *S3Adapter) Delete(ctx context.Context, bucket, key string) error {
	err := m.client.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{})
	if err != nil && isMinioNotFound(err) {
		return nil
	}
	return err
}

func (m *S3Adapter) Health(ctx context.Context) error {
	_, err := m.client.ListBuckets(ctx)
	return err
}

func isMinioNotFound(err error) bool {
	resp := minio.ToErrorResponse(err)
	switch strings.TrimSpace(resp.Code) {
	case "NoSuchKey", "NoSuchBucket", "NotFound":
		return true
	default:
		return false
	}
}

func isMinioNoSuchBucket(err error) bool {
	resp := minio.ToErrorResponse(err)
	return strings.TrimSpace(resp.Code) == "NoSuchBucket"
}
