package server

import (
	"context"
	infra "avsp/storage/infra"
	"io"
	"strings"
	"testing"
)

type fakeObjectAdapter struct {
	bodyByKey map[string][]byte
	putCalls  int
	deleteKey string
}

func (f *fakeObjectAdapter) GetBytes(ctx context.Context, bucket, key string) ([]byte, string, error) {
	_ = ctx
	body, ok := f.bodyByKey[bucket+"/"+key]
	if !ok {
		return nil, "", infra.ErrNotFound
	}
	return append([]byte(nil), body...), "image/jpeg", nil
}

func (f *fakeObjectAdapter) HeadObject(ctx context.Context, bucket, key string) (infra.ObjectInfo, error) {
	_ = ctx
	body, ok := f.bodyByKey[bucket+"/"+key]
	if !ok {
		return infra.ObjectInfo{}, infra.ErrNotFound
	}
	return infra.ObjectInfo{SizeBytes: int64(len(body)), ContentType: "image/jpeg"}, nil
}

func (f *fakeObjectAdapter) PutBytes(ctx context.Context, bucket, key string, data []byte, contentType string) (infra.PutResult, error) {
	_ = ctx
	_ = contentType
	if f.bodyByKey == nil {
		f.bodyByKey = map[string][]byte{}
	}
	f.bodyByKey[bucket+"/"+key] = append([]byte(nil), data...)
	return infra.PutResult{SizeBytes: int64(len(data)), ContentType: "image/jpeg"}, nil
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
