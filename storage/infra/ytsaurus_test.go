package infra

import (
	"io"
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
