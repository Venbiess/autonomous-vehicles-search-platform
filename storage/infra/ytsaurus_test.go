package infra

import (
	"context"
	"io"
	"net/http/httptest"
	"slices"
	"net/http"
	"strings"
	"testing"
)

func TestNewYTsaurusAdapterDefaultsAndValidation(t *testing.T) {
	t.Parallel()

	adapter, err := NewYTsaurusAdapter(ObjectStoreConfig{EndpointURL: "http://yt.local"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if adapter.pathPrefix != defaultYTsaurusPathPrefix {
		t.Fatalf("unexpected default path prefix: %q", adapter.pathPrefix)
	}

	if _, err := NewYTsaurusAdapter(ObjectStoreConfig{}); err == nil {
		t.Fatal("expected missing endpoint to fail")
	}
	if _, err := NewYTsaurusAdapter(ObjectStoreConfig{
		EndpointURL: "http://yt.local",
		PathPrefix:  "/tmp/avsp",
	}); err == nil {
		t.Fatal("expected invalid path prefix to fail")
	}
}

func TestYTsaurusAdapterHelpers(t *testing.T) {
	t.Parallel()

	adapter, err := NewYTsaurusAdapter(ObjectStoreConfig{
		EndpointURL: "http://yt.local/root",
		PathPrefix:  "//data/avsp/",
		AuthToken:   "secret",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got := adapter.CanonicalPath("bucket", "nested/file.jpg"); got != "yt://bucket/nested/file.jpg" {
		t.Fatalf("unexpected canonical path: %q", got)
	}
	if got := adapter.objectPath("bucket", "nested/file.jpg"); got != "//data/avsp/bucket/nested/file.jpg" {
		t.Fatalf("unexpected object path: %q", got)
	}
	if got := adapter.objectPath("bucket", ""); got != "//data/avsp/bucket" {
		t.Fatalf("unexpected bucket path: %q", got)
	}

	url, err := adapter.apiURL("read_file", map[string]string{"path": "//data/avsp/bucket/file.jpg", "force": "true"})
	if err != nil {
		t.Fatalf("unexpected apiURL error: %v", err)
	}
	if !strings.HasPrefix(url, "http://yt.local/root/api/v3/read_file?") {
		t.Fatalf("unexpected api url prefix: %q", url)
	}
	if !strings.Contains(url, "force=true") || !strings.Contains(url, "path=%2F%2Fdata%2Favsp%2Fbucket%2Ffile.jpg") {
		t.Fatalf("unexpected api url query: %q", url)
	}

	req, err := adapter.newRequest(t.Context(), http.MethodPut, "write_file", map[string]string{"path": "//data/avsp/bucket/file.jpg"}, strings.NewReader("payload"))
	if err != nil {
		t.Fatalf("unexpected newRequest error: %v", err)
	}
	if got := req.Header.Get("Authorization"); got != "OAuth secret" {
		t.Fatalf("unexpected authorization header: %q", got)
	}
	if got := req.Header.Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("unexpected content type: %q", got)
	}
}

func TestYTsaurusDecodeHTTPError(t *testing.T) {
	t.Parallel()

	adapter := &YTsaurusAdapter{}
	resp := &http.Response{
		Status:     "500 Internal Server Error",
		StatusCode: http.StatusInternalServerError,
		Body:       io.NopCloser(strings.NewReader("boom")),
	}
	if err := adapter.decodeHTTPError(resp); err == nil || err.Error() != "ytsaurus 500 Internal Server Error: boom" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestYTsaurusAdapterMainFlowUsesValidYPath(t *testing.T) {
	t.Parallel()

	var createPaths []string
	var writePaths []string
	var readPaths []string
	var removePaths []string
	var healthPaths []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cmd := strings.TrimPrefix(r.URL.Path, "/api/v3/")
		switch cmd {
		case "create":
			createPaths = append(createPaths, r.URL.Query().Get("path"))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		case "write_file":
			writePaths = append(writePaths, r.URL.Query().Get("path"))
			body, _ := io.ReadAll(r.Body)
			if string(body) != "payload" {
				t.Fatalf("unexpected write payload: %q", string(body))
			}
			w.WriteHeader(http.StatusOK)
		case "read_file":
			readPaths = append(readPaths, r.URL.Query().Get("path"))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("payload"))
		case "remove":
			removePaths = append(removePaths, r.URL.Query().Get("path"))
			w.WriteHeader(http.StatusOK)
		case "get":
			healthPaths = append(healthPaths, r.URL.Query().Get("path"))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		default:
			t.Fatalf("unexpected command: %s", cmd)
		}
	}))
	defer srv.Close()

	adapter, err := NewYTsaurusAdapter(ObjectStoreConfig{
		EndpointURL: srv.URL,
		PathPrefix:  "//tmp/avsp",
	})
	if err != nil {
		t.Fatalf("unexpected adapter init error: %v", err)
	}

	ctx := context.Background()
	putRes, err := adapter.PutStream(ctx, "avsp", "integration/file.jpg", strings.NewReader("payload"), int64(len("payload")), "text/plain")
	if err != nil {
		t.Fatalf("unexpected PutStream error: %v", err)
	}
	if putRes.SizeBytes != int64(len("payload")) {
		t.Fatalf("unexpected PutStream size: %d", putRes.SizeBytes)
	}

	body, contentType, err := adapter.GetBytes(ctx, "avsp", "integration/file.jpg")
	if err != nil {
		t.Fatalf("unexpected GetBytes error: %v", err)
	}
	if string(body) != "payload" {
		t.Fatalf("unexpected GetBytes body: %q", string(body))
	}
	if contentType == "" {
		t.Fatal("expected detected content type")
	}

	if err := adapter.Delete(ctx, "avsp", "integration/file.jpg"); err != nil {
		t.Fatalf("unexpected Delete error: %v", err)
	}
	if err := adapter.Health(ctx); err != nil {
		t.Fatalf("unexpected Health error: %v", err)
	}

	if len(createPaths) != 2 {
		t.Fatalf("expected 2 create calls, got %d", len(createPaths))
	}
	if !slices.Contains(createPaths, "//tmp/avsp/avsp/integration") {
		t.Fatalf("missing parent create path, got %v", createPaths)
	}
	if !slices.Contains(createPaths, "//tmp/avsp/avsp/integration/file.jpg") {
		t.Fatalf("missing file create path, got %v", createPaths)
	}
	if len(writePaths) != 1 || writePaths[0] != "//tmp/avsp/avsp/integration/file.jpg" {
		t.Fatalf("unexpected write paths: %v", writePaths)
	}
	if len(readPaths) != 1 || readPaths[0] != "//tmp/avsp/avsp/integration/file.jpg" {
		t.Fatalf("unexpected read paths: %v", readPaths)
	}
	if len(removePaths) != 1 || removePaths[0] != "//tmp/avsp/avsp/integration/file.jpg" {
		t.Fatalf("unexpected remove paths: %v", removePaths)
	}
	if len(healthPaths) != 1 || healthPaths[0] != "//sys/@" {
		t.Fatalf("unexpected health paths: %v", healthPaths)
	}
}

func TestYTsaurusAdapterGetBytesNotFound(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
	}))
	defer srv.Close()

	adapter, err := NewYTsaurusAdapter(ObjectStoreConfig{
		EndpointURL: srv.URL,
		PathPrefix:  "//tmp/avsp",
	})
	if err != nil {
		t.Fatalf("unexpected adapter init error: %v", err)
	}

	_, _, err = adapter.GetBytes(context.Background(), "avsp", "missing.jpg")
	if err == nil {
		t.Fatal("expected not found error")
	}
	if !strings.Contains(err.Error(), ErrNotFound.Error()) {
		t.Fatalf("expected ErrNotFound wrapper, got: %v", err)
	}
}
