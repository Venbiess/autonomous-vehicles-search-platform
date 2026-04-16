package infra

import (
	"fmt"
	"strings"
)

func ResolveObjectAdapter(cfg ObjectStoreConfig) (ObjectAdapter, error) {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "", "s3", "s3-compatible", "minio":
		return NewS3Adapter(cfg)
	default:
		return nil, fmt.Errorf("unsupported object adapter provider: %s", cfg.Provider)
	}
}

func ResolveVectorAdapter(cfg VectorIndexConfig) (VectorAdapter, error) {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "", "pgvector", "postgres":
		return NewPgVectorAdapter(cfg.ConnStr, cfg.Schema, cfg.Table)
	case "qdrant":
		return NewQdrantAdapter(cfg)
	default:
		return nil, fmt.Errorf("unsupported vector adapter provider: %s", cfg.Provider)
	}
}
