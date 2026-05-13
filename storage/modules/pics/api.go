package images

import (
	"fmt"
	"io"
	"net/http"
	"net/http/pprof"
	"strconv"
	"strings"
)

func NewCoordinatorHandler(registry *Registry) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/internal/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var req HeartbeatRequest
		if err := DecodeJSON(r, &req); err != nil {
			WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if req.ServerID == "" || req.URL == "" {
			WriteError(w, http.StatusBadRequest, "server_id and url are required")
			return
		}
		if err := registry.Heartbeat(req); err != nil {
			WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/internal/lookup", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		packID, err := strconv.ParseUint(r.URL.Query().Get("pack_id"), 10, 32)
		if err != nil {
			WriteError(w, http.StatusBadRequest, "invalid pack_id")
			return
		}
		resp, err := registry.Lookup(uint32(packID))
		if err != nil {
			WriteError(w, http.StatusNotFound, err.Error())
			return
		}
		WriteJSON(w, http.StatusOK, resp)
	})
	mux.HandleFunc("/internal/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		WriteJSON(w, http.StatusOK, registry.Status())
	})
	mux.HandleFunc("/internal/gc/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if err := registry.RunLightGC(r.Context()); err != nil {
			WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/uploads", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var req UploadCreateRequest
		if err := DecodeJSON(r, &req); err != nil {
			WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		if req.Bucket == "" || req.Key == "" || req.Size == 0 {
			WriteError(w, http.StatusBadRequest, "bucket, key and size are required")
			return
		}
		resp, err := registry.CreateUpload(r.Context(), req)
		if err != nil {
			WriteError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		WriteJSON(w, http.StatusCreated, resp)
	})
	mux.HandleFunc("/internal/uploads/", func(w http.ResponseWriter, r *http.Request) {
		trimmed := strings.TrimPrefix(r.URL.Path, "/internal/uploads/")
		parts := strings.Split(trimmed, "/")
		if len(parts) != 2 || parts[1] != "complete" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var req UploadCompleteRequest
		if err := DecodeJSON(r, &req); err != nil {
			WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		_, record, err := registry.CompleteUpload(parts[0], req)
		if err != nil {
			WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
		WriteJSON(w, http.StatusCreated, map[string]any{
			"bucket":       record.Bucket,
			"key":          record.Key,
			"blob_id":      record.BlobID,
			"url":          objectURL(record.Bucket, record.Key),
			"content_type": record.Metadata.ContentType,
			"size":         record.Metadata.Size,
			"checksum":     record.Metadata.Checksum,
		})
	})
	mux.HandleFunc("/b/", func(w http.ResponseWriter, r *http.Request) {
		bucket, key, hasKey := parseBucketPath(strings.TrimPrefix(r.URL.Path, "/b/"))
		if bucket == "" {
			WriteError(w, http.StatusBadRequest, "bucket required")
			return
		}

		switch {
		case !hasKey && r.Method == http.MethodGet:
			limit := 100
			if raw := r.URL.Query().Get("limit"); raw != "" {
				if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
					limit = parsed
				}
			}
			records, err := registry.ListObjects(bucket, r.URL.Query().Get("start"), limit)
			if err != nil {
				WriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			out := make([]map[string]any, 0, len(records))
			for _, record := range records {
				out = append(out, map[string]any{
					"bucket":       record.Bucket,
					"key":          record.Key,
					"blob_id":      record.BlobID,
					"url":          objectURL(record.Bucket, record.Key),
					"content_type": record.Metadata.ContentType,
					"size":         record.Metadata.Size,
					"updated_at":   record.UpdatedAt.UTC(),
				})
			}
			WriteJSON(w, http.StatusOK, map[string]any{"objects": out})
			return
		case !hasKey:
			WriteError(w, http.StatusBadRequest, "object key required")
			return
		}

		switch r.Method {
		case http.MethodGet, http.MethodHead:
			record, err := registry.GetObject(bucket, key)
			if err != nil {
				WriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if record == nil {
				WriteError(w, http.StatusNotFound, "object not found")
				return
			}
			if err := proxyBlobByID(registry, record.BlobID, w, r); err != nil {
				WriteError(w, http.StatusNotFound, err.Error())
				return
			}
		case http.MethodDelete:
			_, err := registry.DeleteObjectSync(r.Context(), bucket, key)
			if err != nil {
				WriteError(w, http.StatusInternalServerError, err.Error())
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	})
	return mux
}

func parseBucketPath(raw string) (bucket string, key string, hasKey bool) {
	trimmed := strings.TrimPrefix(raw, "/")
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		return "", "", false
	}
	if len(parts) == 1 {
		return parts[0], "", false
	}
	return parts[0], normalizeObjectPath(parts[1]), true
}

func proxyBlobByID(registry *Registry, rawBlobID string, w http.ResponseWriter, r *http.Request) error {
	blobID, err := ParseBlobID(rawBlobID)
	if err != nil {
		return err
	}
	lookup, err := registry.Lookup(blobID.PackID)
	if err != nil {
		return err
	}
	for _, replica := range lookup.Replicas {
		base := replica.URL
		if base == "" {
			base = replica.PublicURL
		}
		if base == "" {
			continue
		}
		target := strings.TrimRight(base, "/") + "/internal/packs/" + strconv.FormatUint(uint64(blobID.PackID), 10) + "/entries/" + strconv.FormatUint(blobID.EntryID, 10) + "?guard=" + strconv.FormatUint(uint64(blobID.Guard), 10)
		if raw := r.URL.RawQuery; raw != "" {
			target += "&" + raw
		}

		req, err := http.NewRequestWithContext(r.Context(), r.Method, target, nil)
		if err != nil {
			continue
		}
		if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		if ifNoneMatch := r.Header.Get("If-None-Match"); ifNoneMatch != "" {
			req.Header.Set("If-None-Match", ifNoneMatch)
		}
		if ifModifiedSince := r.Header.Get("If-Modified-Since"); ifModifiedSince != "" {
			req.Header.Set("If-Modified-Since", ifModifiedSince)
		}

		resp, err := registry.client.Do(req)
		if err != nil {
			continue
		}
		if resp.StatusCode == http.StatusNotFound || resp.StatusCode >= 500 {
			_ = resp.Body.Close()
			continue
		}

		for name, values := range resp.Header {
			for _, value := range values {
				w.Header().Add(name, value)
			}
		}
		w.WriteHeader(resp.StatusCode)
		if r.Method != http.MethodHead {
			_, _ = io.Copy(w, resp.Body)
		}
		_ = resp.Body.Close()
		return nil
	}
	return fmt.Errorf("object not found on replicas")
}
