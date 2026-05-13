package lib

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPutGetDeleteObject(t *testing.T) {
	var uploaded [][]byte
	var deleted bool
	var uploadURL string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/uploads":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"upload_id":"u1","blob_id":"b1","targets":[{"server_id":"s1","upload_url":"` + uploadURL + `/direct/u1","upload_token":"tok"}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/b/bench/a.txt":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("hello"))
		case r.Method == http.MethodDelete && r.URL.Path == "/b/bench/a.txt":
			deleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer api.Close()

	volume := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/direct/u1" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("X-Upload-Token"); got != "tok" {
			http.Error(w, "bad token", http.StatusForbidden)
			return
		}
		body, _ := io.ReadAll(r.Body)
		uploaded = append(uploaded, body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"bucket":"bench","key":"a.txt","blob_id":"b1","url":"/b/bench/a.txt","content_type":"text/plain","size":5,"checksum":"sum"}`))
	}))
	defer volume.Close()
	uploadURL = volume.URL

	client := New(api.URL, api.Client())

	resp, err := client.PutBytes(context.Background(), "bench", "a.txt", []byte("hello"), "text/plain")
	if err != nil {
		t.Fatalf("put bytes: %v", err)
	}
	if resp.BlobID != "b1" || len(uploaded) != 1 || string(uploaded[0]) != "hello" {
		t.Fatalf("unexpected upload result: %+v uploaded=%q", resp, uploaded)
	}

	getResp, err := client.GetObject(context.Background(), "bench", "a.txt")
	if err != nil {
		t.Fatalf("get object: %v", err)
	}
	raw, _ := io.ReadAll(getResp.Body)
	_ = getResp.Body.Close()
	if string(raw) != "hello" {
		t.Fatalf("unexpected body: %q", string(raw))
	}

	if err := client.DeleteObject(context.Background(), "bench", "a.txt"); err != nil {
		t.Fatalf("delete object: %v", err)
	}
	if !deleted {
		t.Fatal("expected delete request")
	}
}
