package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

func parseStoragePath(storagePath, defaultBucket string) (string, string, error) {
	path := normalizeStoragePath(storagePath)
	if strings.HasPrefix(path, "s3://") {
		path = strings.TrimPrefix(path, "s3://")
	}
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		return "", "", errors.New("invalid storage path")
	}
	parts := strings.SplitN(path, "/", 2)
	if len(parts) == 1 {
		if defaultBucket == "" {
			return "", "", errors.New("default bucket is required")
		}
		return defaultBucket, parts[0], nil
	}
	return parts[0], parts[1], nil
}

func normalizeStoragePath(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "\\", "/"))
}

func objectIDFromStoragePath(storagePath string) string {
	sum := sha256.Sum256([]byte(normalizeStoragePath(storagePath)))
	return hex.EncodeToString(sum[:16])
}

func canonicalStoragePath(storagePath, defaultBucket string) (string, string, string, error) {
	bucket, key, err := parseStoragePath(storagePath, defaultBucket)
	if err != nil {
		return "", "", "", err
	}
	canonical := fmt.Sprintf("s3://%s/%s", bucket, key)
	return canonical, bucket, key, nil
}
