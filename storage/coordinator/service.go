package coordinator

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Service struct {
	store     Store
	cfg       ServerConfig
	dataPlane DataPlane
}

func NewService(store Store, cfg ServerConfig, dataPlane DataPlane) *Service {
	if cfg.LeaseTTL <= 0 {
		cfg.LeaseTTL = 10 * time.Second
	}
	if strings.TrimSpace(cfg.NodeID) == "" {
		cfg.NodeID = "coordinator-node"
	}
	return &Service{store: store, cfg: cfg, dataPlane: dataPlane}
}

func (s *Service) Health(ctx context.Context) error {
	return s.store.Health(ctx)
}

func (s *Service) RenewLeader(ctx context.Context) (LeaderInfo, bool, error) {
	return s.store.AcquireLeaderLease(ctx, s.cfg.NodeID)
}

func (s *Service) EnsureLeader(ctx context.Context) (LeaderInfo, error) {
	leader, acquired, err := s.store.AcquireLeaderLease(ctx, s.cfg.NodeID)
	if err != nil {
		return LeaderInfo{}, err
	}
	if !acquired {
		return leader, errors.New("not a leader")
	}
	return leader, nil
}

func (s *Service) GetLeader(ctx context.Context) (LeaderInfo, error) {
	return s.store.GetLeader(ctx)
}

func (s *Service) RegisterObject(ctx context.Context, storagePath, bucket, key string) (ObjectRecord, error) {
	if strings.TrimSpace(storagePath) == "" {
		return ObjectRecord{}, errors.New("storage_path is required")
	}
	record := ObjectRecord{
		ObjectID:    uuid.NewString(),
		StoragePath: storagePath,
		Bucket:      bucket,
		Key:         key,
	}
	return s.store.UpsertObject(ctx, record)
}

func (s *Service) RegisterObjectWorkflow(ctx context.Context, storagePath, source string) (OperationRecord, error) {
	if s.dataPlane == nil {
		return OperationRecord{}, errors.New("data plane is not configured")
	}
	objectID, err := s.dataPlane.ResolveObjectID(ctx, storagePath)
	if err != nil {
		return OperationRecord{}, err
	}
	op, err := s.StartOperation(ctx, "register_object", objectID, map[string]any{
		"storage_path": storagePath,
		"source":       source,
	})
	if err != nil {
		return OperationRecord{}, err
	}
	if _, err := s.MarkObjectWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	committed, err := s.CommitAllowObjectOnly(ctx, op.OperationID)
	if err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	return committed, nil
}

func (s *Service) RegisterObjectWorkflowIdempotent(
	ctx context.Context,
	storagePath string,
	source string,
	idempotencyKey string,
) (OperationRecord, error) {
	if strings.TrimSpace(idempotencyKey) == "" {
		return s.RegisterObjectWorkflow(ctx, storagePath, source)
	}
	if s.dataPlane == nil {
		return OperationRecord{}, errors.New("data plane is not configured")
	}
	objectID, err := s.dataPlane.ResolveObjectID(ctx, storagePath)
	if err != nil {
		return OperationRecord{}, err
	}
	newOpID := uuid.NewString()
	opID, acquired, err := s.store.AcquireIdempotencyKey(ctx, idempotencyKey, newOpID)
	if err != nil {
		return OperationRecord{}, err
	}
	if !acquired {
		return s.GetOperation(ctx, opID)
	}
	op, err := s.startOperationWithID(ctx, opID, "register_object", objectID, map[string]any{
		"storage_path": storagePath,
		"source":       source,
		"idempotency":  idempotencyKey,
	})
	if err != nil {
		return OperationRecord{}, err
	}
	if _, err := s.MarkObjectWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	committed, err := s.CommitAllowObjectOnly(ctx, op.OperationID)
	if err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	return committed, nil
}

func (s *Service) GetObject(ctx context.Context, objectID string) (ObjectRecord, error) {
	if strings.TrimSpace(objectID) == "" {
		return ObjectRecord{}, errors.New("object_id is required")
	}
	return s.store.GetObject(ctx, objectID)
}

func (s *Service) StartOperation(ctx context.Context, operationType, objectID string, payload map[string]any) (OperationRecord, error) {
	return s.startOperationWithID(ctx, uuid.NewString(), operationType, objectID, payload)
}

func (s *Service) startOperationWithID(
	ctx context.Context,
	operationID string,
	operationType string,
	objectID string,
	payload map[string]any,
) (OperationRecord, error) {
	if strings.TrimSpace(operationID) == "" {
		return OperationRecord{}, errors.New("operation_id is required")
	}
	if strings.TrimSpace(operationType) == "" {
		return OperationRecord{}, errors.New("type is required")
	}
	if strings.TrimSpace(objectID) == "" {
		return OperationRecord{}, errors.New("object_id is required")
	}
	op := OperationRecord{
		OperationID: operationID,
		ObjectID:    objectID,
		Type:        operationType,
		State:       OperationStatePending,
		Payload:     payload,
	}
	return s.store.CreateOperation(ctx, op)
}

func (s *Service) GetOperation(ctx context.Context, operationID string) (OperationRecord, error) {
	if strings.TrimSpace(operationID) == "" {
		return OperationRecord{}, errors.New("operation_id is required")
	}
	return s.store.GetOperation(ctx, operationID)
}

func (s *Service) VectorUpsertWorkflow(ctx context.Context, objectID string, embedding []float64, source string) (OperationRecord, error) {
	if s.dataPlane == nil {
		return OperationRecord{}, errors.New("data plane is not configured")
	}
	op, err := s.StartOperation(ctx, "vector_upsert", objectID, map[string]any{
		"source": source,
	})
	if err != nil {
		return OperationRecord{}, err
	}
	if _, err := s.MarkObjectWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if err := s.dataPlane.UpsertVector(ctx, objectID, embedding); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if _, err := s.MarkVectorWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	committed, err := s.Commit(ctx, op.OperationID)
	if err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	return committed, nil
}

func (s *Service) VectorUpsertWorkflowIdempotent(
	ctx context.Context,
	objectID string,
	embedding []float64,
	source string,
	idempotencyKey string,
) (OperationRecord, error) {
	if strings.TrimSpace(idempotencyKey) == "" {
		return s.VectorUpsertWorkflow(ctx, objectID, embedding, source)
	}
	newOpID := uuid.NewString()
	opID, acquired, err := s.store.AcquireIdempotencyKey(ctx, idempotencyKey, newOpID)
	if err != nil {
		return OperationRecord{}, err
	}
	if !acquired {
		return s.GetOperation(ctx, opID)
	}
	if s.dataPlane == nil {
		return OperationRecord{}, errors.New("data plane is not configured")
	}
	op, err := s.startOperationWithID(ctx, opID, "vector_upsert", objectID, map[string]any{
		"source":      source,
		"idempotency": idempotencyKey,
	})
	if err != nil {
		return OperationRecord{}, err
	}
	if _, err := s.MarkObjectWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if err := s.dataPlane.UpsertVector(ctx, objectID, embedding); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if _, err := s.MarkVectorWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	committed, err := s.Commit(ctx, op.OperationID)
	if err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	return committed, nil
}

func (s *Service) DeleteObjectAndVectorsWorkflow(ctx context.Context, objectID, source string) (OperationRecord, error) {
	if s.dataPlane == nil {
		return OperationRecord{}, errors.New("data plane is not configured")
	}
	op, err := s.StartOperation(ctx, "delete_object_and_vectors", objectID, map[string]any{
		"source": source,
	})
	if err != nil {
		return OperationRecord{}, err
	}
	if _, err := s.MarkObjectWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if err := s.dataPlane.DeleteVector(ctx, objectID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if _, err := s.MarkVectorWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if err := s.dataPlane.DeleteObject(ctx, objectID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	committed, err := s.Commit(ctx, op.OperationID)
	if err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	return committed, nil
}

func (s *Service) DeleteObjectAndVectorsWorkflowIdempotent(
	ctx context.Context,
	objectID string,
	source string,
	idempotencyKey string,
) (OperationRecord, error) {
	if strings.TrimSpace(idempotencyKey) == "" {
		return s.DeleteObjectAndVectorsWorkflow(ctx, objectID, source)
	}
	newOpID := uuid.NewString()
	opID, acquired, err := s.store.AcquireIdempotencyKey(ctx, idempotencyKey, newOpID)
	if err != nil {
		return OperationRecord{}, err
	}
	if !acquired {
		return s.GetOperation(ctx, opID)
	}
	if s.dataPlane == nil {
		return OperationRecord{}, errors.New("data plane is not configured")
	}
	op, err := s.startOperationWithID(ctx, opID, "delete_object_and_vectors", objectID, map[string]any{
		"source":      source,
		"idempotency": idempotencyKey,
	})
	if err != nil {
		return OperationRecord{}, err
	}
	if _, err := s.MarkObjectWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if err := s.dataPlane.DeleteVector(ctx, objectID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if _, err := s.MarkVectorWritten(ctx, op.OperationID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	if err := s.dataPlane.DeleteObject(ctx, objectID); err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	committed, err := s.Commit(ctx, op.OperationID)
	if err != nil {
		_, _ = s.Fail(ctx, op.OperationID, err.Error())
		return OperationRecord{}, err
	}
	return committed, nil
}

func (s *Service) ReconcileStaleOperations(ctx context.Context, staleAfter time.Duration, limit int) (int, error) {
	if staleAfter <= 0 {
		return 0, nil
	}
	ops, err := s.store.ListOperations(ctx, []OperationState{
		OperationStatePending,
		OperationStateObjectWritten,
		OperationStateVectorWritten,
	}, limit)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	failed := 0
	for _, op := range ops {
		if now.Sub(op.UpdatedAt) < staleAfter {
			continue
		}
		_, err := s.Fail(ctx, op.OperationID, "stale operation timed out in reconciler")
		if err == nil {
			failed++
		}
	}
	return failed, nil
}

func (s *Service) MarkObjectWritten(ctx context.Context, operationID string) (OperationRecord, error) {
	return s.transition(ctx, operationID, func(op OperationRecord) (OperationRecord, error) {
		if op.State == OperationStateCommitted || op.State == OperationStateFailed {
			return OperationRecord{}, errors.New("operation is closed")
		}
		op.State = OperationStateObjectWritten
		op.Error = ""
		return op, nil
	})
}

func (s *Service) MarkVectorWritten(ctx context.Context, operationID string) (OperationRecord, error) {
	return s.transition(ctx, operationID, func(op OperationRecord) (OperationRecord, error) {
		if op.State != OperationStateObjectWritten && op.State != OperationStateVectorWritten {
			return OperationRecord{}, errors.New("invalid state transition to vector_written")
		}
		op.State = OperationStateVectorWritten
		op.Error = ""
		return op, nil
	})
}

func (s *Service) Commit(ctx context.Context, operationID string) (OperationRecord, error) {
	return s.transition(ctx, operationID, func(op OperationRecord) (OperationRecord, error) {
		if op.State != OperationStateVectorWritten {
			return OperationRecord{}, errors.New("operation must be VECTOR_WRITTEN before commit")
		}
		op.State = OperationStateCommitted
		op.Error = ""
		return op, nil
	})
}

func (s *Service) CommitAllowObjectOnly(ctx context.Context, operationID string) (OperationRecord, error) {
	return s.transition(ctx, operationID, func(op OperationRecord) (OperationRecord, error) {
		if op.State != OperationStateObjectWritten && op.State != OperationStateVectorWritten {
			return OperationRecord{}, errors.New("operation must be OBJECT_WRITTEN or VECTOR_WRITTEN before commit")
		}
		op.State = OperationStateCommitted
		op.Error = ""
		return op, nil
	})
}

func (s *Service) Fail(ctx context.Context, operationID, reason string) (OperationRecord, error) {
	return s.transition(ctx, operationID, func(op OperationRecord) (OperationRecord, error) {
		op.State = OperationStateFailed
		op.Error = strings.TrimSpace(reason)
		return op, nil
	})
}

func (s *Service) transition(ctx context.Context, operationID string, fn func(op OperationRecord) (OperationRecord, error)) (OperationRecord, error) {
	for i := 0; i < 3; i++ {
		op, err := s.store.GetOperation(ctx, operationID)
		if err != nil {
			return OperationRecord{}, err
		}
		next, err := fn(op)
		if err != nil {
			return OperationRecord{}, err
		}
		next.OperationID = op.OperationID
		next.ObjectID = op.ObjectID
		next.Type = op.Type
		next.Payload = op.Payload
		next.Meta = op.Meta
		next.CreatedAt = op.CreatedAt
		next.Version = op.Version

		updated, err := s.store.UpdateOperation(ctx, next)
		if err == nil {
			return updated, nil
		}
		if !errors.Is(err, ErrVersionConflict) {
			return OperationRecord{}, err
		}
	}
	return OperationRecord{}, errors.New("operation update conflict")
}
