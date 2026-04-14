package coordinator

import (
	"context"
	"sort"
	"sync"
	"time"
)

type MemoryStore struct {
	mu           sync.Mutex
	leaseTTL     time.Duration
	objects      map[string]ObjectRecord
	operations   map[string]OperationRecord
	idempotency  map[string]string
	leaderNodeID string
	leaderExpiry time.Time
}

func NewMemoryStore(leaseTTL time.Duration) *MemoryStore {
	if leaseTTL <= 0 {
		leaseTTL = 10 * time.Second
	}
	return &MemoryStore{
		leaseTTL:    leaseTTL,
		objects:     make(map[string]ObjectRecord),
		operations:  make(map[string]OperationRecord),
		idempotency: make(map[string]string),
	}
}

func (m *MemoryStore) Health(ctx context.Context) error { return nil }

func (m *MemoryStore) UpsertObject(ctx context.Context, object ObjectRecord) (ObjectRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now().UTC()
	existing, ok := m.objects[object.ObjectID]
	if !ok {
		object.CreatedAt = now
		object.Version = 1
	} else {
		object.CreatedAt = existing.CreatedAt
		object.Version = existing.Version + 1
	}
	object.UpdatedAt = now
	m.objects[object.ObjectID] = object
	return object, nil
}

func (m *MemoryStore) GetObject(ctx context.Context, objectID string) (ObjectRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	object, ok := m.objects[objectID]
	if !ok {
		return ObjectRecord{}, ErrNotFound
	}
	return object, nil
}

func (m *MemoryStore) CreateOperation(ctx context.Context, op OperationRecord) (OperationRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	op.CreatedAt = now
	op.UpdatedAt = now
	op.Version = 1
	m.operations[op.OperationID] = op
	return op, nil
}

func (m *MemoryStore) GetOperation(ctx context.Context, operationID string) (OperationRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	op, ok := m.operations[operationID]
	if !ok {
		return OperationRecord{}, ErrNotFound
	}
	return op, nil
}

func (m *MemoryStore) UpdateOperation(ctx context.Context, op OperationRecord) (OperationRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.operations[op.OperationID]
	if !ok {
		return OperationRecord{}, ErrNotFound
	}
	if op.Version != current.Version {
		return OperationRecord{}, ErrVersionConflict
	}
	op.CreatedAt = current.CreatedAt
	op.Version = current.Version + 1
	op.UpdatedAt = time.Now().UTC()
	m.operations[op.OperationID] = op
	return op, nil
}

func (m *MemoryStore) ListOperations(ctx context.Context, states []OperationState, limit int) ([]OperationRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 {
		limit = 100
	}
	stateSet := make(map[OperationState]struct{}, len(states))
	for _, st := range states {
		stateSet[st] = struct{}{}
	}
	out := make([]OperationRecord, 0, len(m.operations))
	for _, op := range m.operations {
		if len(stateSet) > 0 {
			if _, ok := stateSet[op.State]; !ok {
				continue
			}
		}
		out = append(out, op)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].UpdatedAt.Before(out[j].UpdatedAt)
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (m *MemoryStore) AcquireIdempotencyKey(ctx context.Context, key string, operationID string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.idempotency[key]; ok {
		return existing, false, nil
	}
	m.idempotency[key] = operationID
	return operationID, true, nil
}

func (m *MemoryStore) AcquireLeaderLease(ctx context.Context, nodeID string) (LeaderInfo, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	if m.leaderNodeID == "" || now.After(m.leaderExpiry) || m.leaderNodeID == nodeID {
		m.leaderNodeID = nodeID
		m.leaderExpiry = now.Add(m.leaseTTL)
		return LeaderInfo{NodeID: m.leaderNodeID, ExpiresAt: m.leaderExpiry}, true, nil
	}
	return LeaderInfo{NodeID: m.leaderNodeID, ExpiresAt: m.leaderExpiry}, false, nil
}

func (m *MemoryStore) GetLeader(ctx context.Context) (LeaderInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	if m.leaderNodeID == "" || now.After(m.leaderExpiry) {
		return LeaderInfo{}, ErrNotFound
	}
	return LeaderInfo{NodeID: m.leaderNodeID, ExpiresAt: m.leaderExpiry}, nil
}
