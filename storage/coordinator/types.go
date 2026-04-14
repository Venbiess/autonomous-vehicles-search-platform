package coordinator

import "time"

type OperationState string

const (
	OperationStatePending       OperationState = "PENDING"
	OperationStateObjectWritten OperationState = "OBJECT_WRITTEN"
	OperationStateVectorWritten OperationState = "VECTOR_WRITTEN"
	OperationStateCommitted     OperationState = "COMMITTED"
	OperationStateFailed        OperationState = "FAILED"
)

type ObjectRecord struct {
	ObjectID    string    `json:"object_id"`
	StoragePath string    `json:"storage_path"`
	Bucket      string    `json:"bucket"`
	Key         string    `json:"key"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Version     int64     `json:"version"`
}

type OperationRecord struct {
	OperationID string                 `json:"operation_id"`
	ObjectID    string                 `json:"object_id"`
	Type        string                 `json:"type"`
	State       OperationState         `json:"state"`
	Error       string                 `json:"error,omitempty"`
	Payload     map[string]any         `json:"payload,omitempty"`
	CreatedAt   time.Time              `json:"created_at"`
	UpdatedAt   time.Time              `json:"updated_at"`
	Version     int64                  `json:"version"`
	Meta        map[string]interface{} `json:"meta,omitempty"`
}

type LeaderInfo struct {
	NodeID    string    `json:"node_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

type ServerConfig struct {
	NodeID       string
	LeaseTTL     time.Duration
	OperationTTL time.Duration
}
