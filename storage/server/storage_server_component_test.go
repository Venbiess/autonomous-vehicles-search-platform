package server

import (
	infra "github.com/Venbiess/autonomous-vehicles-search-platform/storage/infra"
	"context"
	"io"
	"strings"
	"testing"
)

type fakeObjectAdapter struct {
	bodyByKey map[string][]byte
	putCalls  int
	getCalls  int
	deleteKey string
}

func (f *fakeObjectAdapter) GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error) {
	_ = ctx
	f.getCalls++
	body, ok := f.bodyByKey[bucket+"/"+key]
	if !ok {
		return nil, "", infra.ErrNotFound
	}
	return append([]byte(nil), body...), "image/jpeg", nil
}

func (f *fakeObjectAdapter) PutStream(ctx context.Context, bucket, key string, reader io.Reader, size int64, contentType string) (infra.PutResult, error) {
	_ = ctx
	_ = contentType
	payload, err := io.ReadAll(reader)
	if err != nil {
		return infra.PutResult{}, err
	}
	if f.bodyByKey == nil {
		f.bodyByKey = map[string][]byte{}
	}
	f.putCalls++
	f.bodyByKey[bucket+"/"+key] = append([]byte(nil), payload...)
	return infra.PutResult{SizeBytes: size, ContentType: "image/jpeg"}, nil
}

func (f *fakeObjectAdapter) Delete(ctx context.Context, bucket, key string) error {
	_ = ctx
	f.deleteKey = bucket + "/" + key
	delete(f.bodyByKey, f.deleteKey)
	return nil
}

func (f *fakeObjectAdapter) Health(ctx context.Context) error {
	_ = ctx
	return nil
}

func (f *fakeObjectAdapter) CanonicalPath(bucket, key string) string {
	return "s3://" + bucket + "/" + key
}

type fakeVectorAdapter struct {
	upserted   []string
	deleted    []string
	queryTopK  []infra.VectorQueryResult
	countValue int64
}

func (f *fakeVectorAdapter) Upsert(ctx context.Context, objectID string, embedding []float64) error {
	_ = ctx
	_ = embedding
	f.upserted = append(f.upserted, objectID)
	return nil
}

func (f *fakeVectorAdapter) QueryTopK(ctx context.Context, embedding []float64, topK int) ([]infra.VectorQueryResult, error) {
	_ = ctx
	_ = embedding
	_ = topK
	return f.queryTopK, nil
}

func (f *fakeVectorAdapter) Delete(ctx context.Context, objectIDs []string) error {
	_ = ctx
	f.deleted = append(f.deleted, objectIDs...)
	return nil
}

func (f *fakeVectorAdapter) Count(ctx context.Context) (int64, error) {
	_ = ctx
	return f.countValue, nil
}

func (f *fakeVectorAdapter) Health(ctx context.Context) error {
	_ = ctx
	return nil
}

type fakeBatchVectorAdapter struct {
	fakeVectorAdapter
	batchObjectIDs  []string
	batchEmbeddings [][]float64
}

func (f *fakeBatchVectorAdapter) UpsertBatch(ctx context.Context, objectIDs []string, embeddings [][]float64) error {
	_ = ctx
	f.batchObjectIDs = append([]string(nil), objectIDs...)
	f.batchEmbeddings = make([][]float64, 0, len(embeddings))
	for _, embedding := range embeddings {
		f.batchEmbeddings = append(f.batchEmbeddings, append([]float64(nil), embedding...))
	}
	return nil
}

type fakeLookupVectorAdapter struct {
	fakeVectorAdapter
	existingIDs map[string]bool
	byObjectID  map[string][]float64
}

func (f *fakeLookupVectorAdapter) ExistingObjectIDs(ctx context.Context, objectIDs []string) ([]string, error) {
	_ = ctx
	out := make([]string, 0, len(objectIDs))
	for _, objectID := range objectIDs {
		if f.existingIDs[objectID] {
			out = append(out, objectID)
		}
	}
	return out, nil
}

func (f *fakeLookupVectorAdapter) GetByObjectIDs(ctx context.Context, objectIDs []string) (map[string][]float64, error) {
	_ = ctx
	out := make(map[string][]float64, len(objectIDs))
	for _, objectID := range objectIDs {
		vector, ok := f.byObjectID[objectID]
		if !ok {
			continue
		}
		out[objectID] = append([]float64(nil), vector...)
	}
	return out, nil
}

func TestStorageServerUpsertVectorsValidatesAndDelegates(t *testing.T) {
	server := &StorageServer{vectorAdapter: &fakeVectorAdapter{}}

	if err := server.UpsertVectors(context.Background(), nil); err == nil {
		t.Fatal("expected validation error for empty vectors")
	}

	fake := &fakeVectorAdapter{}
	server.vectorAdapter = fake
	err := server.UpsertVectors(context.Background(), []UpsertVector{
		{ObjectID: "obj-1", Embedding: []float64{0.1, 0.2}},
		{ObjectID: "obj-2", Embedding: []float64{0.3, 0.4}},
	})
	if err != nil {
		t.Fatalf("unexpected UpsertVectors error: %v", err)
	}
	if len(fake.upserted) != 2 {
		t.Fatalf("expected 2 upserts, got %d", len(fake.upserted))
	}
}

func TestStorageServerUpsertVectorsUsesBatchUpserter(t *testing.T) {
	batch := &fakeBatchVectorAdapter{}
	server := &StorageServer{vectorAdapter: batch}

	err := server.UpsertVectors(context.Background(), []UpsertVector{
		{ObjectID: "obj-1", Embedding: []float64{0.1, 0.2}},
		{ObjectID: "obj-2", Embedding: []float64{0.3, 0.4}},
	})
	if err != nil {
		t.Fatalf("unexpected UpsertVectors error: %v", err)
	}
	if strings.Join(batch.batchObjectIDs, ",") != "obj-1,obj-2" {
		t.Fatalf("unexpected batch object ids: %v", batch.batchObjectIDs)
	}
	if len(batch.upserted) != 0 {
		t.Fatalf("expected single-row Upsert not to be called, got %v", batch.upserted)
	}
}

func TestStorageServerQueryAndDeleteVectors(t *testing.T) {
	fake := &fakeVectorAdapter{
		queryTopK: []infra.VectorQueryResult{{ObjectID: "obj-1", Distance: 0.1, Similarity: 0.9}},
	}
	server := &StorageServer{vectorAdapter: fake}

	results, err := server.QueryVectors(context.Background(), []float64{0.1, 0.2}, 5)
	if err != nil {
		t.Fatalf("unexpected QueryVectors error: %v", err)
	}
	if len(results) != 1 || results[0].ObjectID != "obj-1" {
		t.Fatalf("unexpected query results: %+v", results)
	}

	deleted, err := server.DeleteVectors(context.Background(), []string{"obj-1", "", "obj-1", "obj-2"})
	if err != nil {
		t.Fatalf("unexpected DeleteVectors error: %v", err)
	}
	if deleted != 2 {
		t.Fatalf("expected 2 unique deletions, got %d", deleted)
	}
	if strings.Join(fake.deleted, ",") != "obj-1,obj-2" {
		t.Fatalf("unexpected deleted ids: %v", fake.deleted)
	}
}

func TestStorageServerLookupHelpers(t *testing.T) {
	fake := &fakeLookupVectorAdapter{
		existingIDs: map[string]bool{"obj-1": true, "obj-3": true},
		byObjectID: map[string][]float64{
			"obj-1": {0.1, 0.2},
			"obj-3": {0.3, 0.4},
		},
	}
	server := &StorageServer{vectorAdapter: fake}

	existing, err := server.ExistingVectorObjectIDs(context.Background(), []string{"obj-1", "", "obj-2", "obj-3"})
	if err != nil {
		t.Fatalf("unexpected ExistingVectorObjectIDs error: %v", err)
	}
	if strings.Join(existing, ",") != "obj-1,obj-3" {
		t.Fatalf("unexpected existing ids: %v", existing)
	}

	vectors, err := server.GetVectors(context.Background(), []string{"obj-3", "obj-1", "obj-3", ""})
	if err != nil {
		t.Fatalf("unexpected GetVectors error: %v", err)
	}
	if len(vectors) != 2 {
		t.Fatalf("unexpected vectors length: %d", len(vectors))
	}
	if vectors[0].ObjectID != "obj-3" || vectors[1].ObjectID != "obj-1" {
		t.Fatalf("unexpected vectors order/content: %+v", vectors)
	}
}

func TestStorageServerGetBatchContentReturnsErrorsPerObject(t *testing.T) {
	obj := &fakeObjectAdapter{
		bodyByKey: map[string][]byte{
			"avsp/path/a.jpg": []byte("a-bytes"),
		},
	}
	server := &StorageServer{
		objectAdapter: obj,
		cache:         NewObjectCache(ObjectCacheConfig{Enabled: true, MaxItems: 10, MaxTotalBytes: 1024}),
	}

	objectID := objectIDFromStoragePath("s3://avsp/path/a.jpg")
	server.cache.Put(objectID, []byte("cached"), "image/jpeg")

	items := server.GetBatchContent(context.Background(), []string{objectID, ""})
	if len(items) != 2 {
		t.Fatalf("unexpected batch length: %d", len(items))
	}
	if string(items[0].Content) != "cached" {
		t.Fatalf("expected cached content, got %q", string(items[0].Content))
	}
	if items[1].Error == "" {
		t.Fatal("expected validation error for empty object id")
	}
}

func TestStorageServerGetBatchContentDeduplicatesCachedObjectIDs(t *testing.T) {
	obj := &fakeObjectAdapter{
		bodyByKey: map[string][]byte{
			"avsp/path/a.jpg": []byte("a-bytes"),
		},
	}
	server := &StorageServer{
		objectAdapter: obj,
		cache:         NewObjectCache(ObjectCacheConfig{Enabled: true, MaxItems: 10, MaxTotalBytes: 1024}),
	}

	objectID := objectIDFromStoragePath("s3://avsp/path/a.jpg")
	server.cache.Put(objectID, []byte("cached"), "image/jpeg")

	items := server.GetBatchContent(context.Background(), []string{objectID, objectID, objectID})
	if len(items) != 3 {
		t.Fatalf("unexpected batch length: %d", len(items))
	}
	for i, item := range items {
		if string(item.Content) != "cached" {
			t.Fatalf("item %d expected cached content, got %q", i, string(item.Content))
		}
	}
	if obj.getCalls != 0 {
		t.Fatalf("expected cached batch lookup to avoid object store reads, got %d", obj.getCalls)
	}
}
