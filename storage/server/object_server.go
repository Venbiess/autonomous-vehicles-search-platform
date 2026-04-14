package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"

	infra "avsp/storage/infra"
	"github.com/cockroachdb/pebble"
	"github.com/google/uuid"
)

type ObjectConfig struct {
	DefaultBucket string
	Cache         ObjectCacheConfig
}

type ObjectServer struct {
	adapter infra.ObjectAdapter
	kv      *pebble.DB
	cfg     ObjectConfig
	cache   *ObjectCache
}

func NewObjectServer(adapter infra.ObjectAdapter, kv *pebble.DB, cfg ObjectConfig) *ObjectServer {
	return &ObjectServer{
		adapter: adapter,
		kv:      kv,
		cfg:     cfg,
		cache:   NewObjectCache(cfg.Cache),
	}
}

func (s *ObjectServer) Health(ctx context.Context) error { return s.adapter.Health(ctx) }

func (s *ObjectServer) ResolvePath(ctx context.Context, storagePath string) (ObjectMetadata, error) {
	storagePath = normalizeStoragePath(storagePath)
	if storagePath == "" {
		return ObjectMetadata{}, errors.New("storage_path is required")
	}
	if m, err := s.getMetadataByPath(storagePath); err == nil {
		return m, nil
	}
	bucket, key, err := parseStoragePath(storagePath, s.cfg.DefaultBucket)
	if err != nil {
		return ObjectMetadata{}, err
	}
	info, err := s.adapter.HeadObject(ctx, bucket, key)
	if err != nil {
		return ObjectMetadata{}, err
	}
	m := ObjectMetadata{
		ObjectID:    uuid.NewString(),
		StoragePath: fmt.Sprintf("s3://%s/%s", bucket, key),
		Bucket:      bucket,
		Key:         key,
		SizeBytes:   info.SizeBytes,
		ContentType: info.ContentType,
		CreatedAt:   time.Now().UTC(),
	}
	if err := s.saveMetadata(m); err != nil {
		return ObjectMetadata{}, err
	}
	return m, nil
}

func (s *ObjectServer) GetMetadataByID(objectID string) (ObjectMetadata, error) {
	return s.getMetadataByID(objectID)
}

func (s *ObjectServer) GetContent(ctx context.Context, objectID string) ([]byte, string, error) {
	if cached, ok := s.cache.Get(objectID); ok {
		return cached.Content, cached.ContentType, nil
	}
	m, err := s.getMetadataByID(objectID)
	if err != nil {
		return nil, "", err
	}
	body, contentType, err := s.adapter.GetBytes(ctx, m.Bucket, m.Key)
	if err != nil {
		return nil, "", err
	}
	s.cache.Put(objectID, body, contentType)
	return body, contentType, nil
}

func (s *ObjectServer) GetBatchContent(ctx context.Context, objectIDs []string) []ObjectBatchItem {
	items := make([]ObjectBatchItem, len(objectIDs))
	if len(objectIDs) == 0 {
		return items
	}
	type job struct {
		idx int
		id  string
	}
	workers := runtime.NumCPU()
	if workers < 4 {
		workers = 4
	}
	if workers > 16 {
		workers = 16
	}
	if workers > len(objectIDs) {
		workers = len(objectIDs)
	}
	jobs := make(chan job, len(objectIDs))
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for jb := range jobs {
				objectID := strings.TrimSpace(jb.id)
				if objectID == "" {
					items[jb.idx] = ObjectBatchItem{ObjectID: jb.id, Error: "object_id is required"}
					continue
				}
				if cached, ok := s.cache.Get(objectID); ok {
					items[jb.idx] = ObjectBatchItem{
						ObjectID:    objectID,
						Content:     cached.Content,
						ContentType: cached.ContentType,
						SizeBytes:   cached.SizeBytes,
					}
					continue
				}
				m, err := s.getMetadataByID(objectID)
				if err != nil {
					items[jb.idx] = ObjectBatchItem{ObjectID: objectID, Error: err.Error()}
					continue
				}
				body, contentType, err := s.adapter.GetBytes(ctx, m.Bucket, m.Key)
				if err != nil {
					items[jb.idx] = ObjectBatchItem{ObjectID: objectID, Error: err.Error()}
					continue
				}
				items[jb.idx] = ObjectBatchItem{
					ObjectID:    objectID,
					Content:     body,
					ContentType: contentType,
					SizeBytes:   int64(len(body)),
				}
				s.cache.Put(objectID, body, contentType)
			}
		}()
	}
	for i, id := range objectIDs {
		jobs <- job{idx: i, id: id}
	}
	close(jobs)
	wg.Wait()
	return items
}

func (s *ObjectServer) Delete(ctx context.Context, objectID string) (bool, error) {
	m, err := s.getMetadataByID(objectID)
	if err != nil {
		if errors.Is(err, pebble.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	if err := s.adapter.Delete(ctx, m.Bucket, m.Key); err != nil {
		return false, err
	}
	if err := s.deleteMetadata(m); err != nil {
		return false, err
	}
	s.cache.Delete(objectID)
	return true, nil
}

func (s *ObjectServer) RegisterPaths(ctx context.Context, storagePaths []string) ([]RegisterPathItem, error) {
	items := make([]RegisterPathItem, 0, len(storagePaths))
	for _, rawPath := range storagePaths {
		m, err := s.ResolvePath(ctx, rawPath)
		if err != nil {
			return nil, err
		}
		items = append(items, RegisterPathItem{ObjectID: m.ObjectID, StoragePath: m.StoragePath})
	}
	return items, nil
}

func (s *ObjectServer) ListObjects(limit int, cursor string) ([]ObjectMetadata, string, error) {
	if limit <= 0 {
		limit = 100
	}
	iter, err := s.kv.NewIter(&pebble.IterOptions{LowerBound: []byte("obj:"), UpperBound: []byte("obj;")})
	if err != nil {
		return nil, "", err
	}
	defer iter.Close()

	items := make([]ObjectMetadata, 0, limit)
	var nextCursor string
	start := "obj:"
	if cursor != "" {
		start = "obj:" + cursor
	}
	for ok := iter.SeekGE([]byte(start)); ok; ok = iter.Next() {
		key := string(iter.Key())
		if !strings.HasPrefix(key, "obj:") {
			break
		}
		objectID := strings.TrimPrefix(key, "obj:")
		if cursor != "" && objectID == cursor {
			continue
		}
		var m ObjectMetadata
		if err := json.Unmarshal(iter.Value(), &m); err != nil {
			return nil, "", err
		}
		items = append(items, m)
		if len(items) == limit {
			nextCursor = objectID
			break
		}
	}
	return items, nextCursor, nil
}

func (s *ObjectServer) saveMetadata(m ObjectMetadata) error {
	bytes, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := s.kv.Set([]byte("obj:"+m.ObjectID), bytes, pebble.Sync); err != nil {
		return err
	}
	return s.kv.Set([]byte("path:"+m.StoragePath), []byte(m.ObjectID), pebble.Sync)
}

func (s *ObjectServer) deleteMetadata(m ObjectMetadata) error {
	if err := s.kv.Delete([]byte("obj:"+m.ObjectID), pebble.Sync); err != nil && !errors.Is(err, pebble.ErrNotFound) {
		return err
	}
	if err := s.kv.Delete([]byte("path:"+m.StoragePath), pebble.Sync); err != nil && !errors.Is(err, pebble.ErrNotFound) {
		return err
	}
	return nil
}

func (s *ObjectServer) getMetadataByID(objectID string) (ObjectMetadata, error) {
	val, closer, err := s.kv.Get([]byte("obj:" + objectID))
	if err != nil {
		return ObjectMetadata{}, err
	}
	defer closer.Close()
	copied := append([]byte(nil), val...)
	var m ObjectMetadata
	if err := json.Unmarshal(copied, &m); err != nil {
		return ObjectMetadata{}, err
	}
	return m, nil
}

func (s *ObjectServer) getMetadataByPath(storagePath string) (ObjectMetadata, error) {
	val, closer, err := s.kv.Get([]byte("path:" + storagePath))
	if err != nil {
		return ObjectMetadata{}, err
	}
	objectID := string(append([]byte(nil), val...))
	closer.Close()
	return s.getMetadataByID(objectID)
}

func parseStoragePath(storagePath, defaultBucket string) (string, string, error) {
	path := normalizeStoragePath(storagePath)
	if strings.HasPrefix(path, "s3://") {
		path = strings.TrimPrefix(path, "s3://")
	}
	path = strings.TrimPrefix(path, "/")
	if path == "" {
		return "", "", errors.New("invalid storage path")
	}
	parts := strings.SplitN(path, "/", 2)
	if len(parts) == 1 {
		if defaultBucket == "" {
			return "", "", errors.New("default bucket is required")
		}
		return defaultBucket, parts[0], nil
	}
	return parts[0], parts[1], nil
}

func normalizeStoragePath(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "\\", "/"))
}
