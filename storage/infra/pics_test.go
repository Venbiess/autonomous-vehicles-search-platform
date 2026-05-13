package infra

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewPicsAdapterRequiresEndpoint(t *testing.T) {
	if _, err := NewPicsAdapter(ObjectStoreConfig{}); err == nil {
		t.Fatalf("expected error for empty endpoint")
	}
}

func TestPicsAdapterRoundTrip(t *testing.T) {
	var ts *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/uploads", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		_ = json.NewDecoder(r.Body).Decode(&map[string]any{})
		uploadURL := ts.URL + "/upload-target"
		_ = json.NewEncoder(w).Encode(map[string]any{
			"targets": []map[string]string{
				{
					"upload_url":   uploadURL,
					"upload_token": "token",
				},
			},
		})
	})
	mux.HandleFunc("/upload-target", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("unexpected method: %s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content_type": r.Header.Get("Content-Type"),
			"size":         len(body),
		})
	})
	mux.HandleFunc("/b/avsp/a/b.jpg", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "image/jpeg")
			_, _ = w.Write([]byte("jpeg-bytes"))
		case http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	ts = httptest.NewServer(mux)
	defer ts.Close()

	adapter, err := NewPicsAdapter(ObjectStoreConfig{EndpointURL: ts.URL})
	if err != nil {
		t.Fatalf("NewPicsAdapter error: %v", err)
	}
	if err := adapter.Health(context.Background()); err != nil {
		t.Fatalf("Health error: %v", err)
	}
	res, err := adapter.PutStream(context.Background(), "avsp", "a/b.jpg", strings.NewReader("jpeg-bytes"), int64(len("jpeg-bytes")), "image/jpeg")
	if err != nil {
		t.Fatalf("PutStream error: %v", err)
	}
	if res.SizeBytes != int64(len("jpeg-bytes")) {
		t.Fatalf("unexpected size: %d", res.SizeBytes)
	}
	body, ct, err := adapter.GetBytes(context.Background(), "avsp", "a/b.jpg")
	if err != nil {
		t.Fatalf("GetBytes error: %v", err)
	}
	if string(body) != "jpeg-bytes" {
		t.Fatalf("unexpected body: %q", string(body))
	}
	if ct != "image/jpeg" {
		t.Fatalf("unexpected content type: %q", ct)
	}
	if err := adapter.Delete(context.Background(), "avsp", "a/b.jpg"); err != nil {
		t.Fatalf("Delete error: %v", err)
	}
}
