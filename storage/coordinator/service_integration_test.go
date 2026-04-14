package coordinator

import (
	"context"
	"sync"
	"testing"
	"time"
)

type fakeDataPlane struct {
	mu            sync.Mutex
	pathToObject  map[string]string
	vectorUpserts int
	vectorDeletes int
	objectDeletes int
}

func newFakeDataPlane() *fakeDataPlane {
	return &fakeDataPlane{
		pathToObject: map[string]string{
			"s3://avsp/a.jpg": "obj-a",
		},
	}
}

func (f *fakeDataPlane) ResolveObjectID(ctx context.Context, storagePath string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id, ok := f.pathToObject[storagePath]; ok {
		return id, nil
	}
	return "", ErrNotFound
}

func (f *fakeDataPlane) UpsertVector(ctx context.Context, objectID string, embedding []float64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.vectorUpserts++
	return nil
}

func (f *fakeDataPlane) DeleteVector(ctx context.Context, objectID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.vectorDeletes++
	return nil
}

func (f *fakeDataPlane) DeleteObject(ctx context.Context, objectID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objectDeletes++
	return nil
}

func TestCoordinatorWorkflowChainAndIdempotency(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore(5 * time.Second)
	dp := newFakeDataPlane()
	svc := NewService(store, ServerConfig{NodeID: "node-a", LeaseTTL: 5 * time.Second}, dp)

	if _, err := svc.EnsureLeader(ctx); err != nil {
		t.Fatalf("ensure leader: %v", err)
	}

	reg, err := svc.RegisterObjectWorkflowIdempotent(ctx, "s3://avsp/a.jpg", "test", "idem-reg-a")
	if err != nil {
		t.Fatalf("register workflow: %v", err)
	}
	if reg.State != OperationStateCommitted {
		t.Fatalf("register state = %s; want COMMITTED", reg.State)
	}

	up1, err := svc.VectorUpsertWorkflowIdempotent(ctx, "obj-a", []float64{0.1, 0.2}, "test", "idem-up-a")
	if err != nil {
		t.Fatalf("vector upsert #1: %v", err)
	}
	up2, err := svc.VectorUpsertWorkflowIdempotent(ctx, "obj-a", []float64{0.1, 0.2}, "test", "idem-up-a")
	if err != nil {
		t.Fatalf("vector upsert #2: %v", err)
	}
	if up1.OperationID != up2.OperationID {
		t.Fatalf("idempotent operation mismatch: %s != %s", up1.OperationID, up2.OperationID)
	}
	dp.mu.Lock()
	upserts := dp.vectorUpserts
	dp.mu.Unlock()
	if upserts != 1 {
		t.Fatalf("vector upsert calls = %d; want 1", upserts)
	}

	del, err := svc.DeleteObjectAndVectorsWorkflowIdempotent(ctx, "obj-a", "test", "idem-del-a")
	if err != nil {
		t.Fatalf("delete workflow: %v", err)
	}
	if del.State != OperationStateCommitted {
		t.Fatalf("delete state = %s; want COMMITTED", del.State)
	}
	dp.mu.Lock()
	vectorDeletes := dp.vectorDeletes
	objectDeletes := dp.objectDeletes
	dp.mu.Unlock()
	if vectorDeletes != 1 || objectDeletes != 1 {
		t.Fatalf("delete counters vector=%d object=%d; want 1/1", vectorDeletes, objectDeletes)
	}
}

func TestCoordinatorLeaderFailoverByLeaseTTL(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore(150 * time.Millisecond)
	dp := newFakeDataPlane()
	svcA := NewService(store, ServerConfig{NodeID: "node-a", LeaseTTL: 150 * time.Millisecond}, dp)
	svcB := NewService(store, ServerConfig{NodeID: "node-b", LeaseTTL: 150 * time.Millisecond}, dp)

	if _, err := svcA.EnsureLeader(ctx); err != nil {
		t.Fatalf("svcA ensure leader: %v", err)
	}
	if _, err := svcB.EnsureLeader(ctx); err == nil {
		t.Fatalf("svcB expected not leader while lease is active")
	}
	time.Sleep(220 * time.Millisecond)
	if _, err := svcB.EnsureLeader(ctx); err != nil {
		t.Fatalf("svcB should acquire leadership after lease expiry: %v", err)
	}
}
