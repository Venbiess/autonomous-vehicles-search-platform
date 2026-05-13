package images

import (
	"bytes"
	"fmt"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/cespare/xxhash/v2"
)

func testImageMetadata(body []byte, hintedType string) ImageMetadata {
	return BuildImageMetadata(uint64(len(body)), fmt.Sprintf("%016x", xxhash.Sum64(body)), body, hintedType)
}

func TestVolumeWriteReadDelete(t *testing.T) {
	cfg := VolumeConfig{
		ServerID:         "a",
		DataDir:          t.TempDir(),
		MaxPackBytes:     1 << 20,
		SnapshotInterval: 0,
	}
	store, err := OpenStore(cfg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	}()
	if _, err := store.ensurePack(1, cfg.MaxPackBytes); err != nil {
		t.Fatalf("create pack: %v", err)
	}
	writeReq := EntryWriteRequest{
		EntryID:  7,
		Guard:    11,
		Metadata: testImageMetadata([]byte("hello"), "text/plain"),
	}
	if _, err := store.Write(1, writeReq, bytes.NewReader([]byte("hello"))); err != nil {
		t.Fatalf("write: %v", err)
	}
	item, reader, err := store.Read(1, 7, 11)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	body, _ := io.ReadAll(reader)
	_ = reader.Close()
	if string(body) != "hello" || item.Size != 5 {
		t.Fatalf("unexpected read result: %q size=%d", string(body), item.Size)
	}
	if err := store.Delete(1, EntryDeleteRequest{EntryID: 7, Guard: 11}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, _, err := store.Read(1, 7, 11); err == nil {
		t.Fatal("expected not found after delete")
	}
}

func TestRecoverReplaysTailAfterSnapshot(t *testing.T) {
	cfg := VolumeConfig{
		ServerID:         "a",
		DataDir:          t.TempDir(),
		MaxPackBytes:     1 << 20,
		SnapshotInterval: 0,
	}
	store, err := OpenStore(cfg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	if _, err := store.ensurePack(1, cfg.MaxPackBytes); err != nil {
		t.Fatalf("create pack: %v", err)
	}

	write1 := EntryWriteRequest{
		EntryID:  1,
		Guard:    101,
		Metadata: testImageMetadata([]byte("first"), "text/plain"),
	}
	if _, err := store.Write(1, write1, bytes.NewReader([]byte("first"))); err != nil {
		t.Fatalf("write first: %v", err)
	}

	pack := store.packs[1]
	if err := pack.snapshotNow(); err != nil {
		t.Fatalf("snapshot now: %v", err)
	}

	write2 := EntryWriteRequest{
		EntryID:  2,
		Guard:    202,
		Metadata: testImageMetadata([]byte("second"), "text/plain"),
	}
	if _, err := store.Write(1, write2, bytes.NewReader([]byte("second"))); err != nil {
		t.Fatalf("write second: %v", err)
	}

	idxPath := filepath.Join(cfg.DataDir, "00000001.idx")
	raw, err := os.ReadFile(idxPath)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if string(raw) == "" {
		t.Fatal("expected non-empty snapshot")
	}

	pack.mu.Lock()
	if err := pack.file.Close(); err != nil {
		pack.mu.Unlock()
		t.Fatalf("close pack file: %v", err)
	}
	pack.mu.Unlock()

	reopened, err := OpenStore(cfg)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer func() {
		if err := reopened.Close(); err != nil {
			t.Fatalf("close reopened store: %v", err)
		}
	}()

	item, reader, err := reopened.Read(1, 2, 202)
	if err != nil {
		t.Fatalf("read replayed tail entry: %v", err)
	}
	body, _ := io.ReadAll(reader)
	_ = reader.Close()
	if item.Size != uint64(len("second")) || string(body) != "second" {
		t.Fatalf("unexpected replayed entry: size=%d body=%q", item.Size, string(body))
	}
}

func TestVolumeHTTPWritePath(t *testing.T) {
	cfg := VolumeConfig{
		ServerID:         "a",
		DataDir:          t.TempDir(),
		MaxPackBytes:     1 << 20,
		SnapshotInterval: 0,
	}
	store, err := OpenStore(cfg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	}()
	if _, err := store.ensurePack(1, cfg.MaxPackBytes); err != nil {
		t.Fatalf("create pack: %v", err)
	}

	body := []byte("hello over http")
	reqMeta := EntryWriteRequest{
		EntryID:  10,
		Guard:    20,
		Metadata: testImageMetadata(body, "application/octet-stream"),
	}
	handler := NewVolumeHandler(store, cfg)
	httpReq := httptest.NewRequest(http.MethodPost, "/internal/packs/1/write", bytes.NewReader(body))
	meta, err := json.Marshal(reqMeta)
	if err != nil {
		t.Fatalf("marshal meta: %v", err)
	}
	httpReq.Header.Set("X-Entry-Meta", string(meta))
	httpReq.ContentLength = int64(len(body))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httpReq)
	if rec.Code != http.StatusCreated {
		t.Fatalf("unexpected status: %d body=%s", rec.Code, rec.Body.String())
	}

	item, reader, err := store.Read(1, 10, 20)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	raw, _ := io.ReadAll(reader)
	_ = reader.Close()
	if item.Size != uint64(len(body)) || string(raw) != string(body) {
		t.Fatalf("unexpected body: size=%d body=%q", item.Size, string(raw))
	}
}

func TestReadMissingPackDoesNotCreateFiles(t *testing.T) {
	cfg := VolumeConfig{
		ServerID:         "a",
		DataDir:          t.TempDir(),
		MaxPackBytes:     1 << 20,
		SnapshotInterval: 0,
	}
	store, err := OpenStore(cfg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	}()

	if _, _, err := store.Read(77, 1, 1); err == nil {
		t.Fatal("expected read from missing pack to fail")
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "0000004d.dat")); !os.IsNotExist(err) {
		t.Fatalf("expected no pack file to be created, stat err=%v", err)
	}
}

func TestWriteUsesKnownContentLength(t *testing.T) {
	cfg := VolumeConfig{
		ServerID:         "a",
		DataDir:          t.TempDir(),
		MaxPackBytes:     1 << 20,
		SnapshotInterval: 0,
	}
	store, err := OpenStore(cfg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	}()

	body := []byte("replicate me")
	req := EntryWriteRequest{
		EntryID:  1,
		Guard:    2,
		Metadata: ImageMetadata{ContentType: "text/plain", Size: uint64(len(body))},
	}
	meta, err := store.Write(1, req, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	if meta.Size != uint64(len(body)) {
		t.Fatalf("unexpected metadata size: %d", meta.Size)
	}
}
