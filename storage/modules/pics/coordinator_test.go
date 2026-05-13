package images

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dgraph-io/badger/v4"
)

func TestAllocateCreatesPack(t *testing.T) {
	cfg := CoordinatorConfig{
		DBPath:             filepath.Join(t.TempDir(), "badger"),
		PackSizeBytes:      1024,
		ReplicaCount:       1,
		ObjectCacheEntries: 8,
	}
	registry, err := LoadRegistry(cfg)
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	defer func() {
		if err := registry.Close(); err != nil {
			t.Fatalf("close registry: %v", err)
		}
	}()
	registry.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{}`)),
				Header:     make(http.Header),
			}, nil
		}),
	}
	if err := registry.Heartbeat(HeartbeatRequest{
		ServerID:     "s1",
		URL:          "http://storage-a",
		FreeBytes:    1 << 20,
		MaxPackBytes: 1024,
	}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	resp, err := registry.Allocate(t.Context(), 10)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if resp.PackID == 0 || resp.EntryID == 0 || resp.BlobID == "" {
		t.Fatalf("unexpected allocation response: %+v", resp)
	}
}

func TestObjectCatalogRoundTripAndList(t *testing.T) {
	cfg := CoordinatorConfig{
		DBPath:             filepath.Join(t.TempDir(), "badger"),
		ObjectCacheEntries: 4,
	}
	registry, err := LoadRegistry(cfg)
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	defer func() {
		if err := registry.Close(); err != nil {
			t.Fatalf("close registry: %v", err)
		}
	}()

	now := time.Now().UTC().Round(time.Second)
	record := objectRecord{
		Bucket: "images-demo",
		Key:    "cats/one.jpg",
		BlobID: "00000001,0000000000000001,00000001",
		Metadata: ImageMetadata{
			ContentType: "image/jpeg",
			Size:        123,
		},
		UpdatedAt: now,
	}
	prev, err := putTestObject(registry, record)
	if err != nil {
		t.Fatalf("put object: %v", err)
	}
	if prev != nil {
		t.Fatalf("expected no previous record, got %+v", prev)
	}

	got, err := registry.GetObject(record.Bucket, record.Key)
	if err != nil {
		t.Fatalf("get object: %v", err)
	}
	if got == nil || got.BlobID != record.BlobID || got.Key != record.Key {
		t.Fatalf("unexpected object: %+v", got)
	}

	second := objectRecord{
		Bucket: "images-demo",
		Key:    "cats/two.jpg",
		BlobID: "00000001,0000000000000002,00000002",
		Metadata: ImageMetadata{
			ContentType: "image/jpeg",
			Size:        456,
		},
		UpdatedAt: now,
	}
	if _, err := putTestObject(registry, second); err != nil {
		t.Fatalf("put second object: %v", err)
	}

	list, err := registry.ListObjects("images-demo", "cats/", 10)
	if err != nil {
		t.Fatalf("list objects: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 objects, got %d", len(list))
	}

	deleted, err := registry.DeleteObject(record.Bucket, record.Key)
	if err != nil {
		t.Fatalf("delete object: %v", err)
	}
	if deleted == nil || deleted.BlobID != record.BlobID {
		t.Fatalf("unexpected deleted record: %+v", deleted)
	}
	missing, err := registry.GetObject(record.Bucket, record.Key)
	if err != nil {
		t.Fatalf("get deleted object: %v", err)
	}
	if missing != nil {
		t.Fatalf("expected object to be deleted, got %+v", missing)
	}
}

func TestCompleteUploadUpdatesPackAndCatalogAtomically(t *testing.T) {
	cfg := CoordinatorConfig{
		DBPath:             filepath.Join(t.TempDir(), "badger"),
		PackSizeBytes:      1024,
		ReplicaCount:       1,
		ObjectCacheEntries: 4,
		UploadTokenSecret:  "test-secret",
	}
	registry, err := LoadRegistry(cfg)
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	defer func() {
		if err := registry.Close(); err != nil {
			t.Fatalf("close registry: %v", err)
		}
	}()

	if err := registry.Heartbeat(HeartbeatRequest{
		ServerID:     "s1",
		URL:          "http://storage-a",
		FreeBytes:    1 << 20,
		MaxPackBytes: 1024,
	}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	upload, err := registry.CreateUpload(t.Context(), UploadCreateRequest{
		Bucket:      "images-demo",
		Key:         "cats/one.jpg",
		ContentType: "image/jpeg",
		Size:        123,
	})
	if err != nil {
		t.Fatalf("create upload: %v", err)
	}
	if len(upload.Targets) != 1 {
		t.Fatalf("unexpected targets: %d", len(upload.Targets))
	}
	claims, err := verifyUploadToken(cfg.UploadTokenSecret, upload.Targets[0].UploadToken)
	if err != nil {
		t.Fatalf("verify upload token: %v", err)
	}
	prev, record, err := registry.CompleteUpload(upload.UploadID, UploadCompleteRequest{
		Token: claims.CompleteToken,
		Metadata: []UploadMetadata{
			{
				ServerID: upload.Targets[0].ServerID,
				Metadata: ImageMetadata{
					ContentType: "image/jpeg",
					Checksum:    "abc",
					Size:        123,
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("complete upload: %v", err)
	}
	if prev != nil {
		t.Fatalf("expected no previous record, got %+v", prev)
	}

	blobID, err := ParseBlobID(record.BlobID)
	if err != nil {
		t.Fatalf("parse blob id: %v", err)
	}
	lookup, err := registry.Lookup(blobID.PackID)
	if err != nil {
		t.Fatalf("lookup pack: %v", err)
	}
	if lookup.State != PackStateWritable {
		t.Fatalf("unexpected pack state: %s", lookup.State)
	}
	if len(lookup.Replicas) != 1 {
		t.Fatalf("unexpected replica count: %d", len(lookup.Replicas))
	}

	pack := registry.packs[blobID.PackID]
	if pack.SizeBytes != int64(record.Metadata.Size) {
		t.Fatalf("unexpected pack size: %d", pack.SizeBytes)
	}

	got, err := registry.GetObject(record.Bucket, record.Key)
	if err != nil {
		t.Fatalf("get object: %v", err)
	}
	if got == nil || got.BlobID != record.BlobID {
		t.Fatalf("unexpected object: %+v", got)
	}
}

func TestCompleteUploadWithWriteQuorum(t *testing.T) {
	cfg := CoordinatorConfig{
		DBPath:             filepath.Join(t.TempDir(), "badger"),
		PackSizeBytes:      1024,
		ReplicaCount:       3,
		WriteQuorum:        2,
		ObjectCacheEntries: 4,
		UploadTokenSecret:  "test-secret",
	}
	registry, err := LoadRegistry(cfg)
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	defer func() {
		if err := registry.Close(); err != nil {
			t.Fatalf("close registry: %v", err)
		}
	}()

	for _, serverID := range []string{"s1", "s2", "s3"} {
		if err := registry.Heartbeat(HeartbeatRequest{
			ServerID:     serverID,
			URL:          "http://storage-" + serverID,
			FreeBytes:    1 << 20,
			MaxPackBytes: 1024,
		}); err != nil {
			t.Fatalf("heartbeat %s: %v", serverID, err)
		}
	}
	upload, err := registry.CreateUpload(t.Context(), UploadCreateRequest{
		Bucket:      "images-demo",
		Key:         "cats/quorum.jpg",
		ContentType: "image/jpeg",
		Size:        123,
	})
	if err != nil {
		t.Fatalf("create upload: %v", err)
	}
	if len(upload.Targets) != 1 {
		t.Fatalf("unexpected targets: %d", len(upload.Targets))
	}
	claims, err := verifyUploadToken(cfg.UploadTokenSecret, upload.Targets[0].UploadToken)
	if err != nil {
		t.Fatalf("verify upload token: %v", err)
	}

	_, record, err := registry.CompleteUpload(upload.UploadID, UploadCompleteRequest{
		Token: claims.CompleteToken,
		Metadata: []UploadMetadata{
			{
				ServerID: "s1",
				Metadata: ImageMetadata{ContentType: "image/jpeg", Checksum: "abc", Size: 123},
			},
			{
				ServerID: "s2",
				Metadata: ImageMetadata{ContentType: "image/jpeg", Checksum: "abc", Size: 123},
			},
		},
	})
	if err != nil {
		t.Fatalf("complete upload: %v", err)
	}
	if record.BlobID == "" {
		t.Fatalf("empty blob id")
	}

	upload2, err := registry.CreateUpload(t.Context(), UploadCreateRequest{
		Bucket:      "images-demo",
		Key:         "cats/quorum-fail.jpg",
		ContentType: "image/jpeg",
		Size:        123,
	})
	if err != nil {
		t.Fatalf("create upload2: %v", err)
	}
	claims2, err := verifyUploadToken(cfg.UploadTokenSecret, upload2.Targets[0].UploadToken)
	if err != nil {
		t.Fatalf("verify upload token2: %v", err)
	}
	_, _, err = registry.CompleteUpload(upload2.UploadID, UploadCompleteRequest{
		Token: claims2.CompleteToken,
		Metadata: []UploadMetadata{
			{
				ServerID: "s1",
				Metadata: ImageMetadata{ContentType: "image/jpeg", Checksum: "abc", Size: 123},
			},
		},
	})
	if err == nil {
		t.Fatalf("expected quorum failure")
	}
}

func TestDeleteObjectSyncRequiresQuorum(t *testing.T) {
	cfg := CoordinatorConfig{
		DBPath:             filepath.Join(t.TempDir(), "badger"),
		PackSizeBytes:      1024,
		ReplicaCount:       2,
		WriteQuorum:        2,
		ObjectCacheEntries: 4,
	}
	registry, err := LoadRegistry(cfg)
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	defer func() {
		if err := registry.Close(); err != nil {
			t.Fatalf("close registry: %v", err)
		}
	}()

	registry.packs[1] = &packState{
		PackID:      1,
		State:       PackStateWritable,
		Replicas:    []Replica{{ServerID: "a", URL: "http://a"}, {ServerID: "b", URL: "http://b"}},
		NextEntryID: 2,
		MaxBytes:    1024,
	}
	_, err = putTestObject(registry, objectRecord{
		Bucket: "bench",
		Key:    "k1",
		BlobID: BlobID{PackID: 1, EntryID: 1, Guard: 7}.String(),
		Metadata: ImageMetadata{
			ContentType: "application/octet-stream",
			Checksum:    strings.Repeat("0", 64),
			Size:        1,
		},
		UpdatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("seed object: %v", err)
	}

	registry.client = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if strings.Contains(req.URL.Host, "b") {
				return &http.Response{
					StatusCode: http.StatusInternalServerError,
					Body:       io.NopCloser(strings.NewReader(`{"error":"fail"}`)),
					Header:     make(http.Header),
				}, nil
			}
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(strings.NewReader(``)),
				Header:     make(http.Header),
			}, nil
		}),
	}
	if _, err := registry.DeleteObjectSync(t.Context(), "bench", "k1"); err == nil {
		t.Fatalf("expected delete quorum error")
	}
	stillThere, err := registry.GetObject("bench", "k1")
	if err != nil {
		t.Fatalf("get object after failed delete: %v", err)
	}
	if stillThere == nil {
		t.Fatalf("object should remain in catalog when delete quorum is not met")
	}
}

func putTestObject(registry *Registry, record objectRecord) (*objectRecord, error) {
	var previous *objectRecord
	err := registry.db.Update(func(txn *badger.Txn) error {
		if item, err := txn.Get(objectKey(record.Bucket, record.Key)); err == nil {
			raw, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}
			var old objectRecord
			if err := json.Unmarshal(raw, &old); err != nil {
				return err
			}
			previous = &old
		} else if err != badger.ErrKeyNotFound {
			return err
		}

		raw, err := json.Marshal(record)
		if err != nil {
			return err
		}
		return txn.Set(objectKey(record.Bucket, record.Key), raw)
	})
	if err != nil {
		return nil, err
	}
	registry.objectCache.Put(record)
	return previous, nil
}

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
