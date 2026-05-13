package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	infra "github.com/Venbiess/autonomous-vehicles-search-platform/storage/infra"
)

var ErrInvalidArgument = errors.New("invalid argument")

func invalidArgument(msg string) error { return fmt.Errorf("%w: %s", ErrInvalidArgument, msg) }

const maxBatchContentWorkers = 16

type vectorBatchUpserter interface {
	UpsertBatch(ctx context.Context, objectIDs []string, embeddings [][]float64) error
}

type StorageConfig struct {
	DefaultBucket  string
	MetadataSchema string
	MetadataTable  string
	Cache          ObjectCacheConfig
}

type StorageServer struct {
	objectAdapter infra.ObjectAdapter
	vectorAdapter infra.VectorAdapter
	analytics     *AnalyticsStore
	metaDB        *sql.DB
	cfg           StorageConfig
	cache         *ObjectCache
}

func NewStorageServer(objectAdapter infra.ObjectAdapter, vectorAdapter infra.VectorAdapter, metaDB *sql.DB, cfg StorageConfig) (*StorageServer, error) {
	if metaDB == nil {
		return nil, errors.New("metadata db is required")
	}
	if strings.TrimSpace(cfg.MetadataSchema) == "" {
		cfg.MetadataSchema = "public"
	}
	if strings.TrimSpace(cfg.MetadataTable) == "" {
		cfg.MetadataTable = "objects"
	}
	s := &StorageServer{
		objectAdapter: objectAdapter,
		vectorAdapter: vectorAdapter,
		metaDB:        metaDB,
		cfg:           cfg,
		cache:         NewObjectCache(cfg.Cache),
	}
	if err := s.ensureMetadataTable(context.Background()); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *StorageServer) Health(ctx context.Context) error {
	if err := s.metaDB.PingContext(ctx); err != nil {
		return err
	}
	if err := s.objectAdapter.Health(ctx); err != nil {
		return err
	}
	if err := s.vectorAdapter.Health(ctx); err != nil {
		return err
	}
	if s.analytics != nil {
		if err := s.analytics.Health(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (s *StorageServer) AttachAnalytics(store *AnalyticsStore) {
	s.analytics = store
}

func (s *StorageServer) Analytics() *AnalyticsStore {
	return s.analytics
}

func (s *StorageServer) UploadObject(ctx context.Context, bucket, key, filename, contentType string, reader io.Reader, size int64) (ObjectMetadata, error) {
	if reader == nil || size <= 0 {
		return ObjectMetadata{}, invalidArgument("file payload is required")
	}

	bucket = strings.TrimSpace(bucket)
	if bucket == "" {
		bucket = strings.TrimSpace(s.cfg.DefaultBucket)
	}
	if bucket == "" {
		return ObjectMetadata{}, invalidArgument("bucket is required")
	}

	var err error
	key, err = chooseObjectKey(key, filename)
	if err != nil {
		return ObjectMetadata{}, err
	}
	key = strings.Trim(strings.TrimSpace(key), "/")
	if key == "" {
		return ObjectMetadata{}, invalidArgument("key is required")
	}

	canonicalPath := s.objectAdapter.CanonicalPath(bucket, key)
	objectID := objectIDFromStoragePath(canonicalPath)

	res, err := s.objectAdapter.PutStream(ctx, bucket, key, reader, size, strings.TrimSpace(contentType))
	if err != nil {
		return ObjectMetadata{}, err
	}

	m := ObjectMetadata{
		ObjectID:    objectID,
		StoragePath: canonicalPath,
		Bucket:      bucket,
		Key:         key,
		SizeBytes:   res.SizeBytes,
		ContentType: res.ContentType,
		CreatedAt:   time.Now().UTC(),
	}
	return s.upsertMetadata(ctx, m)
}

func (s *StorageServer) GetMetadataByID(ctx context.Context, objectID string) (ObjectMetadata, error) {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return ObjectMetadata{}, invalidArgument("object_id is required")
	}
	return s.getMetadataByID(ctx, objectID)
}

func (s *StorageServer) ListObjects(ctx context.Context, limit int, cursor string) ([]ObjectMetadata, string, error) {
	if limit <= 0 {
		limit = 100
	}
	cursor = strings.TrimSpace(cursor)

	query := fmt.Sprintf(
		`SELECT object_id, storage_path, bucket, object_key, size_bytes, content_type, created_at
		 FROM %s.%s
		 WHERE ($1 = '' OR object_id > $1)
		 ORDER BY object_id ASC
		 LIMIT $2`,
		pqIdent(s.cfg.MetadataSchema),
		pqIdent(s.cfg.MetadataTable),
	)
	rows, err := s.metaDB.QueryContext(ctx, query, cursor, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	out := make([]ObjectMetadata, 0, limit+1)
	for rows.Next() {
		var m ObjectMetadata
		if err := rows.Scan(&m.ObjectID, &m.StoragePath, &m.Bucket, &m.Key, &m.SizeBytes, &m.ContentType, &m.CreatedAt); err != nil {
			return nil, "", err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	nextCursor := ""
	if len(out) > limit {
		nextCursor = out[limit-1].ObjectID
		out = out[:limit]
	}
	return out, nextCursor, nil
}

func (s *StorageServer) GetContent(ctx context.Context, objectID string) ([]byte, string, error) {
	return s.getContent(ctx, objectID, true)
}

func (s *StorageServer) getContent(ctx context.Context, objectID string, copyCached bool) ([]byte, string, error) {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return nil, "", invalidArgument("object_id is required")
	}
	if s.cache != nil {
		var (
			cached cacheValue
			ok     bool
		)
		if copyCached {
			cached, ok = s.cache.Get(objectID)
		} else {
			cached, ok = s.cache.Peek(objectID)
		}
		if ok {
			return cached.Content, cached.ContentType, nil
		}
	}
	m, err := s.getMetadataByID(ctx, objectID)
	if err != nil {
		return nil, "", err
	}
	body, contentType, err := s.objectAdapter.GetBytes(ctx, m.Bucket, m.Key)
	if err != nil {
		return nil, "", err
	}
	if s.cache != nil {
		s.cache.PutOwned(objectID, body, contentType)
	}
	return body, contentType, nil
}

func (s *StorageServer) GetBatchContent(ctx context.Context, objectIDs []string) []ObjectBatchItem {
	items := make([]ObjectBatchItem, len(objectIDs))
	if len(objectIDs) == 0 {
		return items
	}

	positionsByID := make(map[string][]int, len(objectIDs))
	uniqueIDs := make([]string, 0, len(objectIDs))
	for idx, rawID := range objectIDs {
		objectID := strings.TrimSpace(rawID)
		if objectID == "" {
			items[idx] = ObjectBatchItem{ObjectID: rawID, Error: "object_id is required"}
			continue
		}
		if _, ok := positionsByID[objectID]; !ok {
			uniqueIDs = append(uniqueIDs, objectID)
		}
		positionsByID[objectID] = append(positionsByID[objectID], idx)
	}
	if len(uniqueIDs) == 0 {
		return items
	}

	workers := len(uniqueIDs)
	if workers > maxBatchContentWorkers {
		workers = maxBatchContentWorkers
	}
	jobs := make(chan int, len(uniqueIDs))
	var wg sync.WaitGroup

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				objectID := uniqueIDs[idx]
				body, contentType, err := s.getContent(ctx, objectID, false)
				if err != nil {
					for _, pos := range positionsByID[objectID] {
						items[pos] = ObjectBatchItem{ObjectID: objectID, Error: err.Error()}
					}
					continue
				}
				body = append([]byte(nil), body...)
				item := ObjectBatchItem{
					ObjectID:    objectID,
					Content:     body,
					ContentType: contentType,
					SizeBytes:   int64(len(body)),
				}
				for _, pos := range positionsByID[objectID] {
					items[pos] = item
				}
			}
		}()
	}

	for idx := range uniqueIDs {
		jobs <- idx
	}
	close(jobs)
	wg.Wait()
	return items
}

func (s *StorageServer) DeleteObject(ctx context.Context, objectID string) (bool, error) {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return false, invalidArgument("object_id is required")
	}
	m, err := s.getMetadataByID(ctx, objectID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if err := s.vectorAdapter.Delete(ctx, []string{objectID}); err != nil {
		return false, err
	}
	if err := s.objectAdapter.Delete(ctx, m.Bucket, m.Key); err != nil {
		return false, err
	}
	deleted, err := s.deleteMetadataByID(ctx, objectID)
	if err != nil {
		return false, err
	}
	s.cache.Delete(objectID)
	return deleted, nil
}

func (s *StorageServer) UpsertVectors(ctx context.Context, vectors []UpsertVector) error {
	if len(vectors) == 0 {
		return invalidArgument("vectors are required")
	}
	objectIDs := make([]string, 0, len(vectors))
	embeddings := make([][]float64, 0, len(vectors))
	for _, v := range vectors {
		if strings.TrimSpace(v.ObjectID) == "" {
			return invalidArgument("object_id is required")
		}
		if len(v.Embedding) == 0 {
			return invalidArgument("embedding is required")
		}
		objectIDs = append(objectIDs, strings.TrimSpace(v.ObjectID))
		embeddings = append(embeddings, v.Embedding)
	}
	if batch, ok := s.vectorAdapter.(vectorBatchUpserter); ok {
		return batch.UpsertBatch(ctx, objectIDs, embeddings)
	}
	for i := range objectIDs {
		if err := s.vectorAdapter.Upsert(ctx, objectIDs[i], embeddings[i]); err != nil {
			return err
		}
	}
	return nil
}

func (s *StorageServer) QueryVectors(ctx context.Context, embedding []float64, topK int) ([]QueryResult, error) {
	if len(embedding) == 0 {
		return nil, invalidArgument("embedding is required")
	}
	if topK <= 0 {
		return nil, invalidArgument("top_k must be > 0")
	}
	results, err := s.vectorAdapter.QueryTopK(ctx, embedding, topK)
	if err != nil {
		return nil, err
	}
	out := make([]QueryResult, 0, len(results))
	for _, item := range results {
		out = append(out, QueryResult{
			ObjectID:   item.ObjectID,
			Distance:   item.Distance,
			Similarity: item.Similarity,
		})
	}
	return out, nil
}

func (s *StorageServer) CountVectors(ctx context.Context) (int64, error) {
	return s.vectorAdapter.Count(ctx)
}

func (s *StorageServer) CountObjects(ctx context.Context) (int64, error) {
	query := fmt.Sprintf(`SELECT COUNT(*) FROM %s.%s`, pqIdent(s.cfg.MetadataSchema), pqIdent(s.cfg.MetadataTable))
	var total int64
	if err := s.metaDB.QueryRowContext(ctx, query).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}

func (s *StorageServer) ExistingVectorObjectIDs(ctx context.Context, objectIDs []string) ([]string, error) {
	if len(objectIDs) == 0 {
		return []string{}, nil
	}
	lookup, ok := s.vectorAdapter.(infra.VectorExistingLookup)
	if !ok {
		return nil, errors.New("vector backend does not support object id lookup")
	}
	return lookup.ExistingObjectIDs(ctx, objectIDs)
}

func (s *StorageServer) GetVectors(ctx context.Context, objectIDs []string) ([]StoredVector, error) {
	normalized := dedupeNonEmpty(objectIDs)
	if len(normalized) == 0 {
		return []StoredVector{}, nil
	}
	getter, ok := s.vectorAdapter.(infra.VectorBatchGetter)
	if !ok {
		return nil, errors.New("vector backend does not support batch vector read")
	}
	byObjectID, err := getter.GetByObjectIDs(ctx, normalized)
	if err != nil {
		return nil, err
	}
	out := make([]StoredVector, 0, len(byObjectID))
	for _, objectID := range normalized {
		embedding, exists := byObjectID[objectID]
		if !exists {
			continue
		}
		out = append(out, StoredVector{
			ObjectID:  objectID,
			Embedding: embedding,
		})
	}
	return out, nil
}

func (s *StorageServer) DeleteVectors(ctx context.Context, objectIDs []string) (int, error) {
	normalized := dedupeNonEmpty(objectIDs)
	if len(normalized) == 0 {
		return 0, nil
	}
	deleted := len(normalized)
	if lookup, ok := s.vectorAdapter.(infra.VectorExistingLookup); ok {
		existing, err := lookup.ExistingObjectIDs(ctx, normalized)
		if err != nil {
			return 0, err
		}
		deleted = len(existing)
		if deleted == 0 {
			return 0, nil
		}
	}
	if err := s.vectorAdapter.Delete(ctx, normalized); err != nil {
		return 0, err
	}
	return deleted, nil
}

func (s *StorageServer) ClearVectors(ctx context.Context, pageSize int) (int, error) {
	limit := pageSize
	if limit <= 0 {
		limit = 1000
	}
	if limit > 5000 {
		limit = 5000
	}

	totalDeleted := 0
	cursor := ""
	for {
		items, nextCursor, err := s.ListObjects(ctx, limit, cursor)
		if err != nil {
			return totalDeleted, err
		}
		if len(items) == 0 {
			break
		}

		objectIDs := make([]string, 0, len(items))
		for _, item := range items {
			objectID := strings.TrimSpace(item.ObjectID)
			if objectID != "" {
				objectIDs = append(objectIDs, objectID)
			}
		}
		if len(objectIDs) > 0 {
			deleted, err := s.DeleteVectors(ctx, objectIDs)
			if err != nil {
				return totalDeleted, err
			}
			totalDeleted += deleted
		}

		if strings.TrimSpace(nextCursor) == "" {
			break
		}
		cursor = nextCursor
	}

	return totalDeleted, nil
}

func (s *StorageServer) CleanupOrphanVectors(ctx context.Context) (int, error) {
	cleaner, ok := s.vectorAdapter.(infra.VectorOrphanCleaner)
	if !ok {
		return 0, errors.New("vector backend does not support orphan cleanup")
	}
	return cleaner.CleanupOrphaned(ctx, s.cfg.MetadataSchema, s.cfg.MetadataTable)
}

func (s *StorageServer) ensureMetadataTable(ctx context.Context) error {
	if _, err := s.metaDB.ExecContext(ctx, fmt.Sprintf("CREATE SCHEMA IF NOT EXISTS %s", pqIdent(s.cfg.MetadataSchema))); err != nil {
		return err
	}
	query := fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s.%s (
			object_id TEXT PRIMARY KEY,
			storage_path TEXT NOT NULL UNIQUE,
			bucket TEXT NOT NULL,
			object_key TEXT NOT NULL,
			size_bytes BIGINT NOT NULL,
			content_type TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`, pqIdent(s.cfg.MetadataSchema), pqIdent(s.cfg.MetadataTable))
	_, err := s.metaDB.ExecContext(ctx, query)
	return err
}

func (s *StorageServer) upsertMetadata(ctx context.Context, m ObjectMetadata) (ObjectMetadata, error) {
	query := fmt.Sprintf(`
		INSERT INTO %s.%s (
			object_id, storage_path, bucket, object_key, size_bytes, content_type, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, now(), now())
		ON CONFLICT (object_id) DO UPDATE SET
			storage_path = EXCLUDED.storage_path,
			bucket = EXCLUDED.bucket,
			object_key = EXCLUDED.object_key,
			size_bytes = EXCLUDED.size_bytes,
			content_type = EXCLUDED.content_type,
			updated_at = now()
		RETURNING object_id, storage_path, bucket, object_key, size_bytes, content_type, created_at
	`, pqIdent(s.cfg.MetadataSchema), pqIdent(s.cfg.MetadataTable))
	if err := s.metaDB.QueryRowContext(ctx, query, m.ObjectID, m.StoragePath, m.Bucket, m.Key, m.SizeBytes, m.ContentType).
		Scan(&m.ObjectID, &m.StoragePath, &m.Bucket, &m.Key, &m.SizeBytes, &m.ContentType, &m.CreatedAt); err != nil {
		return ObjectMetadata{}, err
	}
	return m, nil
}

func (s *StorageServer) getMetadataByID(ctx context.Context, objectID string) (ObjectMetadata, error) {
	query := fmt.Sprintf(`
		SELECT object_id, storage_path, bucket, object_key, size_bytes, content_type, created_at
		FROM %s.%s
		WHERE object_id = $1
	`, pqIdent(s.cfg.MetadataSchema), pqIdent(s.cfg.MetadataTable))
	var m ObjectMetadata
	err := s.metaDB.QueryRowContext(ctx, query, objectID).Scan(
		&m.ObjectID, &m.StoragePath, &m.Bucket, &m.Key, &m.SizeBytes, &m.ContentType, &m.CreatedAt,
	)
	return m, err
}

func (s *StorageServer) deleteMetadataByID(ctx context.Context, objectID string) (bool, error) {
	query := fmt.Sprintf(`DELETE FROM %s.%s WHERE object_id = $1`, pqIdent(s.cfg.MetadataSchema), pqIdent(s.cfg.MetadataTable))
	res, err := s.metaDB.ExecContext(ctx, query, objectID)
	if err != nil {
		return false, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

func pqIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
