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
	default:
		return nil, fmt.Errorf("unsupported vector adapter provider: %s", cfg.Provider)
	}
}

func ResolveAnalyticsAdapter(cfg AnalyticsDBConfig) (AnalyticsAdapter, error) {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "", "clickhouse":
		fieldsTable := firstNonEmpty(cfg.FieldCatalogTable, cfg.FieldsTable)
		annotationsTable := firstNonEmpty(cfg.AnnotationStoreTable, cfg.AnnotationsTable)
		return NewClickHouseAdapter(cfg.DSN, fieldsTable, annotationsTable)
	default:
		return nil, fmt.Errorf("unsupported analytics adapter provider: %s", cfg.Provider)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
