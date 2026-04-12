package contracts

import "time"

type PutObjectRequest struct {
	StoragePath string `json:"storage_path"`
	ContentType string `json:"content_type,omitempty"`
}

type PutObjectResponse struct {
	ObjectID    string    `json:"object_id"`
	StoragePath string    `json:"storage_path"`
	SizeBytes   int64     `json:"size_bytes"`
	ContentType string    `json:"content_type"`
	CreatedAt   time.Time `json:"created_at"`
}

type ObjectMetadata struct {
	ObjectID    string    `json:"object_id"`
	StoragePath string    `json:"storage_path"`
	Bucket      string    `json:"bucket"`
	Key         string    `json:"key"`
	SizeBytes   int64     `json:"size_bytes"`
	ContentType string    `json:"content_type"`
	CreatedAt   time.Time `json:"created_at"`
}

type ResolvePathRequest struct {
	StoragePath string `json:"storage_path"`
}

type ResolvePathResponse struct {
	ObjectID string `json:"object_id"`
}

type RegisterPathsRequest struct {
	StoragePaths []string `json:"storage_paths"`
}

type RegisterPathItem struct {
	ObjectID    string `json:"object_id"`
	StoragePath string `json:"storage_path"`
}

type RegisterPathsResponse struct {
	Items []RegisterPathItem `json:"items"`
}

type ListObjectsResponse struct {
	Items      []ObjectMetadata `json:"items"`
	NextCursor string           `json:"next_cursor,omitempty"`
}

type UpsertVector struct {
	ObjectID  string    `json:"object_id"`
	Embedding []float64 `json:"embedding"`
}

type UpsertVectorsRequest struct {
	Vectors []UpsertVector `json:"vectors"`
}

type QueryVectorsRequest struct {
	Embedding []float64 `json:"embedding"`
	TopK      int       `json:"top_k"`
}

type QueryResult struct {
	ObjectID   string  `json:"object_id"`
	Distance   float64 `json:"distance"`
	Similarity float64 `json:"similarity"`
}

type QueryVectorsResponse struct {
	Results []QueryResult `json:"results"`
}

type DeleteVectorsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}
