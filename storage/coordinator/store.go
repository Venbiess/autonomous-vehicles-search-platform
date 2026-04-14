package coordinator

import (
	"context"
	"errors"
)

var (
	ErrNotFound        = errors.New("not found")
	ErrVersionConflict = errors.New("version conflict")
)

type Store interface {
	Health(ctx context.Context) error

	UpsertObject(ctx context.Context, object ObjectRecord) (ObjectRecord, error)
	GetObject(ctx context.Context, objectID string) (ObjectRecord, error)

	CreateOperation(ctx context.Context, op OperationRecord) (OperationRecord, error)
	GetOperation(ctx context.Context, operationID string) (OperationRecord, error)
	UpdateOperation(ctx context.Context, op OperationRecord) (OperationRecord, error)
	ListOperations(ctx context.Context, states []OperationState, limit int) ([]OperationRecord, error)
	AcquireIdempotencyKey(ctx context.Context, key string, operationID string) (string, bool, error)

	AcquireLeaderLease(ctx context.Context, nodeID string) (LeaderInfo, bool, error)
	GetLeader(ctx context.Context) (LeaderInfo, error)
}
