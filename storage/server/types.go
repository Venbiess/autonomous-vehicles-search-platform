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

type ObjectBatchItem struct {
	ObjectID    string
	Content     []byte
	ContentType string
	SizeBytes   int64
	Error       string
}

type UpsertVector struct {
	ObjectID  string    `json:"object_id"`
	Embedding []float64 `json:"embedding"`
}

type QueryResult struct {
	ObjectID   string  `json:"object_id"`
	Distance   float64 `json:"distance"`
	Similarity float64 `json:"similarity"`
}

type PreprocessorRunner struct {
	Entrypoint string `json:"entrypoint"`
	Module     string `json:"module,omitempty"`
}

type PreprocessorMethod struct {
	Key           string             `json:"key"`
	Label         string             `json:"label"`
	Description   string             `json:"description,omitempty"`
	Runner        PreprocessorRunner `json:"runner"`
	DefaultConfig map[string]any     `json:"default_config,omitempty"`
}
