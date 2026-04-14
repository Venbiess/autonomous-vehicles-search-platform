package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
)

type EtcdConfig struct {
	Endpoints []string
	Prefix    string
	LeaseTTL  int
}

type EtcdStore struct {
	cfg   EtcdConfig
	cli   *clientv3.Client
	pfx   string
	ttl   int64
	keyOp string
	keyOb string
	keyLd string
	keyId string
}

func NewEtcdStore(cfg EtcdConfig) (*EtcdStore, error) {
	if len(cfg.Endpoints) == 0 {
		return nil, errors.New("etcd endpoints are required")
	}
	pfx := strings.TrimSpace(cfg.Prefix)
	if pfx == "" {
		pfx = "/avsp/coordinator"
	}
	if cfg.LeaseTTL <= 0 {
		cfg.LeaseTTL = 10
	}
	cli, err := clientv3.New(clientv3.Config{
		Endpoints:   cfg.Endpoints,
		DialTimeout: 5 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	return &EtcdStore{
		cfg:   cfg,
		cli:   cli,
		pfx:   pfx,
		ttl:   int64(cfg.LeaseTTL),
		keyOp: path.Join(pfx, "operations"),
		keyOb: path.Join(pfx, "objects"),
		keyLd: path.Join(pfx, "leader"),
		keyId: path.Join(pfx, "idempotency"),
	}, nil
}

func (e *EtcdStore) Health(ctx context.Context) error {
	_, err := e.cli.Status(ctx, e.cfg.Endpoints[0])
	return err
}

func (e *EtcdStore) UpsertObject(ctx context.Context, object ObjectRecord) (ObjectRecord, error) {
	if strings.TrimSpace(object.ObjectID) == "" {
		return ObjectRecord{}, errors.New("object_id is required")
	}
	now := time.Now().UTC()
	key := e.objectKey(object.ObjectID)

	resp, err := e.cli.Get(ctx, key)
	if err != nil {
		return ObjectRecord{}, err
	}
	if len(resp.Kvs) == 0 {
		object.CreatedAt = now
		object.Version = 1
	} else {
		current, _, err := decodeObject(resp.Kvs[0].Value)
		if err != nil {
			return ObjectRecord{}, err
		}
		object.CreatedAt = current.CreatedAt
		object.Version = current.Version + 1
	}
	object.UpdatedAt = now

	raw, err := json.Marshal(object)
	if err != nil {
		return ObjectRecord{}, err
	}
	if _, err := e.cli.Put(ctx, key, string(raw)); err != nil {
		return ObjectRecord{}, err
	}
	return object, nil
}

func (e *EtcdStore) GetObject(ctx context.Context, objectID string) (ObjectRecord, error) {
	resp, err := e.cli.Get(ctx, e.objectKey(objectID))
	if err != nil {
		return ObjectRecord{}, err
	}
	if len(resp.Kvs) == 0 {
		return ObjectRecord{}, ErrNotFound
	}
	object, _, err := decodeObject(resp.Kvs[0].Value)
	if err != nil {
		return ObjectRecord{}, err
	}
	return object, nil
}

func (e *EtcdStore) CreateOperation(ctx context.Context, op OperationRecord) (OperationRecord, error) {
	if strings.TrimSpace(op.OperationID) == "" {
		return OperationRecord{}, errors.New("operation_id is required")
	}
	now := time.Now().UTC()
	op.CreatedAt = now
	op.UpdatedAt = now
	op.Version = 1
	key := e.operationKey(op.OperationID)
	raw, err := json.Marshal(op)
	if err != nil {
		return OperationRecord{}, err
	}
	txn, err := e.cli.Txn(ctx).
		If(clientv3.Compare(clientv3.CreateRevision(key), "=", 0)).
		Then(clientv3.OpPut(key, string(raw))).
		Commit()
	if err != nil {
		return OperationRecord{}, err
	}
	if !txn.Succeeded {
		return OperationRecord{}, ErrVersionConflict
	}
	getResp, err := e.cli.Get(ctx, key)
	if err != nil {
		return OperationRecord{}, err
	}
	if len(getResp.Kvs) == 0 {
		return OperationRecord{}, ErrNotFound
	}
	created, modRev, err := decodeOperation(getResp.Kvs[0].Value)
	if err != nil {
		return OperationRecord{}, err
	}
	created.Meta = setModRevision(created.Meta, modRev)
	return created, nil
}

func (e *EtcdStore) GetOperation(ctx context.Context, operationID string) (OperationRecord, error) {
	resp, err := e.cli.Get(ctx, e.operationKey(operationID))
	if err != nil {
		return OperationRecord{}, err
	}
	if len(resp.Kvs) == 0 {
		return OperationRecord{}, ErrNotFound
	}
	op, modRev, err := decodeOperation(resp.Kvs[0].Value)
	if err != nil {
		return OperationRecord{}, err
	}
	op.Meta = setModRevision(op.Meta, modRev)
	return op, nil
}

func (e *EtcdStore) UpdateOperation(ctx context.Context, op OperationRecord) (OperationRecord, error) {
	if strings.TrimSpace(op.OperationID) == "" {
		return OperationRecord{}, errors.New("operation_id is required")
	}
	key := e.operationKey(op.OperationID)

	expectedRev, ok := getModRevision(op.Meta)
	if !ok {
		return OperationRecord{}, ErrVersionConflict
	}
	currentResp, err := e.cli.Get(ctx, key)
	if err != nil {
		return OperationRecord{}, err
	}
	if len(currentResp.Kvs) == 0 {
		return OperationRecord{}, ErrNotFound
	}
	current, _, err := decodeOperation(currentResp.Kvs[0].Value)
	if err != nil {
		return OperationRecord{}, err
	}
	if current.Version != op.Version {
		return OperationRecord{}, ErrVersionConflict
	}

	op.CreatedAt = current.CreatedAt
	op.Version = current.Version + 1
	op.UpdatedAt = time.Now().UTC()
	op.Meta = nil

	raw, err := json.Marshal(op)
	if err != nil {
		return OperationRecord{}, err
	}
	txnResp, err := e.cli.Txn(ctx).
		If(clientv3.Compare(clientv3.ModRevision(key), "=", expectedRev)).
		Then(clientv3.OpPut(key, string(raw))).
		Commit()
	if err != nil {
		return OperationRecord{}, err
	}
	if !txnResp.Succeeded {
		return OperationRecord{}, ErrVersionConflict
	}

	getResp, err := e.cli.Get(ctx, key)
	if err != nil {
		return OperationRecord{}, err
	}
	if len(getResp.Kvs) == 0 {
		return OperationRecord{}, ErrNotFound
	}
	updated, modRev, err := decodeOperation(getResp.Kvs[0].Value)
	if err != nil {
		return OperationRecord{}, err
	}
	updated.Meta = setModRevision(updated.Meta, modRev)
	return updated, nil
}

func (e *EtcdStore) ListOperations(ctx context.Context, states []OperationState, limit int) ([]OperationRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	stateSet := make(map[OperationState]struct{}, len(states))
	for _, st := range states {
		stateSet[st] = struct{}{}
	}
	resp, err := e.cli.Get(ctx, e.keyOp+"/", clientv3.WithPrefix(), clientv3.WithLimit(int64(limit*4)))
	if err != nil {
		return nil, err
	}
	out := make([]OperationRecord, 0, limit)
	for _, kv := range resp.Kvs {
		op, modRev, err := decodeOperation(kv.Value)
		if err != nil {
			continue
		}
		if len(stateSet) > 0 {
			if _, ok := stateSet[op.State]; !ok {
				continue
			}
		}
		op.Meta = setModRevision(op.Meta, modRev)
		out = append(out, op)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (e *EtcdStore) AcquireIdempotencyKey(ctx context.Context, key string, operationID string) (string, bool, error) {
	if strings.TrimSpace(key) == "" {
		return "", false, errors.New("idempotency key is required")
	}
	if strings.TrimSpace(operationID) == "" {
		return "", false, errors.New("operation_id is required")
	}
	fullKey := path.Join(e.keyId, key)
	txnResp, err := e.cli.Txn(ctx).
		If(clientv3.Compare(clientv3.CreateRevision(fullKey), "=", 0)).
		Then(clientv3.OpPut(fullKey, operationID)).
		Else(clientv3.OpGet(fullKey)).
		Commit()
	if err != nil {
		return "", false, err
	}
	if txnResp.Succeeded {
		return operationID, true, nil
	}
	if len(txnResp.Responses) > 0 {
		rangeResp := txnResp.Responses[0].GetResponseRange()
		if rangeResp != nil && len(rangeResp.Kvs) > 0 {
			return string(rangeResp.Kvs[0].Value), false, nil
		}
	}
	getResp, err := e.cli.Get(ctx, fullKey)
	if err != nil {
		return "", false, err
	}
	if len(getResp.Kvs) == 0 {
		return "", false, ErrNotFound
	}
	return string(getResp.Kvs[0].Value), false, nil
}

func (e *EtcdStore) AcquireLeaderLease(ctx context.Context, nodeID string) (LeaderInfo, bool, error) {
	if strings.TrimSpace(nodeID) == "" {
		return LeaderInfo{}, false, errors.New("node_id is required")
	}
	lease, err := e.cli.Grant(ctx, e.ttl)
	if err != nil {
		return LeaderInfo{}, false, err
	}
	leaderKey := e.keyLd
	txnResp, err := e.cli.Txn(ctx).
		If(
			clientv3.Compare(clientv3.CreateRevision(leaderKey), "=", 0),
		).
		Then(clientv3.OpPut(leaderKey, nodeID, clientv3.WithLease(lease.ID))).
		Else(clientv3.OpGet(leaderKey)).
		Commit()
	if err != nil {
		return LeaderInfo{}, false, err
	}
	if txnResp.Succeeded {
		return LeaderInfo{
			NodeID:    nodeID,
			ExpiresAt: time.Now().UTC().Add(time.Duration(e.ttl) * time.Second),
		}, true, nil
	}

	// If lock already exists, allow lease renewal by the same node.
	getResp, err := e.cli.Get(ctx, leaderKey)
	if err != nil {
		return LeaderInfo{}, false, err
	}
	if len(getResp.Kvs) == 0 {
		return LeaderInfo{}, false, ErrNotFound
	}
	currentNode := string(getResp.Kvs[0].Value)
	if currentNode == nodeID {
		txnResp, err = e.cli.Txn(ctx).
			If(clientv3.Compare(clientv3.Value(leaderKey), "=", nodeID)).
			Then(clientv3.OpPut(leaderKey, nodeID, clientv3.WithLease(lease.ID))).
			Commit()
		if err != nil {
			return LeaderInfo{}, false, err
		}
		if txnResp.Succeeded {
			return LeaderInfo{
				NodeID:    nodeID,
				ExpiresAt: time.Now().UTC().Add(time.Duration(e.ttl) * time.Second),
			}, true, nil
		}
	}
	leader, err := e.GetLeader(ctx)
	if err != nil {
		return LeaderInfo{}, false, err
	}
	return leader, false, nil
}

func (e *EtcdStore) GetLeader(ctx context.Context) (LeaderInfo, error) {
	resp, err := e.cli.Get(ctx, e.keyLd)
	if err != nil {
		return LeaderInfo{}, err
	}
	if len(resp.Kvs) == 0 {
		return LeaderInfo{}, ErrNotFound
	}
	kv := resp.Kvs[0]
	info := LeaderInfo{NodeID: string(kv.Value)}
	if kv.Lease != 0 {
		ttlResp, err := e.cli.TimeToLive(ctx, clientv3.LeaseID(kv.Lease))
		if err == nil && ttlResp.TTL > 0 {
			info.ExpiresAt = time.Now().UTC().Add(time.Duration(ttlResp.TTL) * time.Second)
		}
	}
	return info, nil
}

func (e *EtcdStore) objectKey(objectID string) string {
	return path.Join(e.keyOb, objectID)
}

func (e *EtcdStore) operationKey(operationID string) string {
	return path.Join(e.keyOp, operationID)
}

func decodeObject(raw []byte) (ObjectRecord, int64, error) {
	var object ObjectRecord
	if err := json.Unmarshal(raw, &object); err != nil {
		return ObjectRecord{}, 0, err
	}
	return object, object.Version, nil
}

func decodeOperation(raw []byte) (OperationRecord, int64, error) {
	var op OperationRecord
	if err := json.Unmarshal(raw, &op); err != nil {
		return OperationRecord{}, 0, err
	}
	return op, op.Version, nil
}

func getModRevision(meta map[string]interface{}) (int64, bool) {
	if meta == nil {
		return 0, false
	}
	value, ok := meta["_etcd_mod_revision"]
	if !ok {
		return 0, false
	}
	switch v := value.(type) {
	case int64:
		return v, true
	case int:
		return int64(v), true
	case float64:
		return int64(v), true
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

func setModRevision(meta map[string]interface{}, modRev int64) map[string]interface{} {
	if meta == nil {
		meta = make(map[string]interface{}, 1)
	}
	meta["_etcd_mod_revision"] = modRev
	return meta
}

var _ Store = (*EtcdStore)(nil)

func (e *EtcdStore) String() string {
	return fmt.Sprintf("EtcdStore{endpoints=%v,prefix=%s}", e.cfg.Endpoints, e.pfx)
}
