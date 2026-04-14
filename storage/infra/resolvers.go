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

func ResolveObjectAdapterSet(primary ObjectStoreConfig, replicas []ObjectStoreConfig) (ObjectAdapter, error) {
	if len(replicas) == 0 {
		return ResolveObjectAdapter(primary)
	}
	adapters := make([]ObjectAdapter, 0, len(replicas))
	for i, item := range replicas {
		adapter, err := ResolveObjectAdapter(item)
		if err != nil {
			return nil, fmt.Errorf("object adapter[%d]: %w", i, err)
		}
		adapters = append(adapters, adapter)
	}
	return NewMultiObjectAdapter(adapters)
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

func ResolveVectorAdapterSet(primary VectorIndexConfig, shards []VectorIndexConfig) (VectorAdapter, error) {
	if len(shards) == 0 {
		return ResolveVectorAdapter(primary)
	}
	adapters := make([]VectorAdapter, 0, len(shards))
	for i, item := range shards {
		adapter, err := ResolveVectorAdapter(item)
		if err != nil {
			return nil, fmt.Errorf("vector adapter[%d]: %w", i, err)
		}
		adapters = append(adapters, adapter)
	}
	return NewMultiVectorAdapter(adapters)
}
