package infra

import (
	"errors"
	"strings"
	"testing"

	"github.com/minio/minio-go/v7"
)

func TestNewS3AdapterRejectsInvalidEndpoint(t *testing.T) {
	t.Parallel()

	_, err := NewS3Adapter(ObjectStoreConfig{})
	if err == nil || !strings.Contains(err.Error(), "s3 endpoint is required") {
		t.Fatalf("expected missing endpoint validation error, got: %v", err)
	}

	_, err = NewS3Adapter(ObjectStoreConfig{EndpointURL: "http://localhost:9000/prefix"})
	if err == nil || !strings.Contains(err.Error(), "must not include URL path") {
		t.Fatalf("expected path validation error, got: %v", err)
	}
}

func TestS3AdapterCanonicalPathTrimsBucketAndKey(t *testing.T) {
	t.Parallel()

	adapter := &S3Adapter{}
	got := adapter.CanonicalPath(" /bucket/ ", " /nested/file.jpg/ ")
	if got != "s3://bucket/nested/file.jpg" {
		t.Fatalf("unexpected canonical path: %q", got)
	}
}

func TestIsMinioNotFound(t *testing.T) {
	t.Parallel()

	if !isMinioNotFound(minio.ErrorResponse{Code: "NoSuchKey"}) {
		t.Fatalf("expected NoSuchKey to be treated as not found")
	}
	if isMinioNotFound(errors.New("boom")) {
		t.Fatalf("plain errors must not be treated as not found")
	}
}
