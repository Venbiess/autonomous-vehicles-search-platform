package server

import "time"

type ObjectMetadata struct {
	ObjectID    string    `json:"object_id"`
	StoragePath string    `json:"storage_path"`
	Bucket      string    `json:"bucket"`
	Key         string    `json:"key"`
	SizeBytes   int64     `json:"size_bytes"`
	ContentType string    `json:"content_type"`
	CreatedAt   time.Time `json:"created_at"`
}

type RegisterPathItem struct {
	ObjectID    string `json:"object_id"`
	StoragePath string `json:"storage_path"`
}

type UpsertVector struct {
	ObjectID  string
	Embedding []float64
}

type QueryResult struct {
	ObjectID   string  `json:"object_id"`
	Distance   float64 `json:"distance"`
	Similarity float64 `json:"similarity"`
}

type AnalyticsField struct {
	FieldName    string `json:"field_name"`
	Prompt       string `json:"prompt"`
	ResponseType string `json:"response_type"`
}

type AnalyticsAnnotationRow struct {
	ObjectID string            `json:"object_id"`
	Values   map[string]string `json:"values"`
}

type AnalyticsFilter struct {
	FieldName string `json:"field_name"`
	Value     string `json:"value"`
	MatchMode string `json:"match_mode"`
}

type AnalyticsSearchResult struct {
	ObjectID   string            `json:"object_id"`
	Attributes map[string]string `json:"attributes"`
}
