package httptransport

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"

	core "avsp/storage/server"
)

const maxUnifiedBatchObjectIDs = 256

type StorageHandler struct {
	svc        *core.StorageServer
	writeToken string
}

func NewStorageHandler(svc *core.StorageServer, writeToken string) *StorageHandler {
	return &StorageHandler{svc: svc, writeToken: strings.TrimSpace(writeToken)}
}

func (h *StorageHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/objects", h.handleObjects)
	mux.HandleFunc("/objects/resolve-path", h.handleResolvePath)
	mux.HandleFunc("/objects/register-paths", h.handleRegisterPaths)
	mux.HandleFunc("/objects/get-batch", h.handleGetBatch)
	mux.HandleFunc("/objects/", h.handleObjectByID)
	mux.HandleFunc("/vectors/upsert", h.handleVectorUpsert)
	mux.HandleFunc("/vectors/query", h.handleVectorQuery)
}

func (h *StorageHandler) authorizeWrite(r *http.Request) error {
	if h.writeToken == "" {
		return nil
	}
	if strings.TrimSpace(r.Header.Get("X-Storage-Write-Token")) != h.writeToken {
		return errors.New("write token is required")
	}
	return nil
}

func (h *StorageHandler) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Health(r.Context()); err != nil {
		writeTypedError(w, r, http.StatusServiceUnavailable, "service_unavailable", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type storageResolvePathRequest struct {
	StoragePath string `json:"storage_path"`
}

type storageResolvePathResponse struct {
	ObjectID string `json:"object_id"`
}

type storageRegisterPathsRequest struct {
	StoragePaths []string `json:"storage_paths"`
}

type storageRegisterPathsResponse struct {
	Items []core.RegisterPathItem `json:"items"`
}

type storageListObjectsResponse struct {
	Items      []core.ObjectMetadata `json:"items"`
	NextCursor string                `json:"next_cursor,omitempty"`
}

func (h *StorageHandler) handleObjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		limit := 100
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		items, nextCursor, err := h.svc.ListObjects(r.Context(), limit, strings.TrimSpace(r.URL.Query().Get("cursor")))
		if err != nil {
			status, code := classifyError(err)
			writeTypedError(w, r, status, code, err)
			return
		}
		writeJSON(w, http.StatusOK, storageListObjectsResponse{Items: items, NextCursor: nextCursor})
	default:
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
	}
}

func (h *StorageHandler) handleResolvePath(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	var req storageResolvePathRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	m, err := h.svc.ResolvePath(r.Context(), req.StoragePath)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, storageResolvePathResponse{ObjectID: m.ObjectID})
}

func (h *StorageHandler) handleRegisterPaths(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	var req storageRegisterPathsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	if len(req.StoragePaths) == 0 {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", errors.New("storage_paths are required"))
		return
	}
	items, err := h.svc.RegisterPaths(r.Context(), req.StoragePaths)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, storageRegisterPathsResponse{Items: items})
}

type storageGetBatchObjectsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}

type storageGetBatchObjectItem struct {
	ObjectID      string `json:"object_id"`
	ContentBase64 string `json:"content_base64,omitempty"`
	ContentType   string `json:"content_type,omitempty"`
	SizeBytes     int64  `json:"size_bytes,omitempty"`
	Error         string `json:"error,omitempty"`
}

type storageGetBatchObjectsResponse struct {
	Items []storageGetBatchObjectItem `json:"items"`
}

func (h *StorageHandler) handleGetBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	var req storageGetBatchObjectsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	if len(req.ObjectIDs) == 0 {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", errors.New("object_ids are required"))
		return
	}
	if len(req.ObjectIDs) > maxUnifiedBatchObjectIDs {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", errors.New("too many object_ids in batch"))
		return
	}
	items := h.svc.GetBatchContent(r.Context(), req.ObjectIDs)
	out := storageGetBatchObjectsResponse{Items: make([]storageGetBatchObjectItem, 0, len(items))}
	for _, item := range items {
		respItem := storageGetBatchObjectItem{
			ObjectID:    item.ObjectID,
			ContentType: item.ContentType,
			SizeBytes:   item.SizeBytes,
			Error:       item.Error,
		}
		if len(item.Content) > 0 {
			respItem.ContentBase64 = base64.StdEncoding.EncodeToString(item.Content)
		}
		out.Items = append(out.Items, respItem)
	}
	writeJSON(w, http.StatusOK, out)
}

type storageDeleteObjectResponse struct {
	ObjectID string `json:"object_id"`
	Deleted  bool   `json:"deleted"`
}

func (h *StorageHandler) handleObjectByID(w http.ResponseWriter, r *http.Request) {
	tail := strings.TrimPrefix(r.URL.Path, "/objects/")
	tail = strings.Trim(tail, "/")
	if tail == "" {
		writeTypedError(w, r, http.StatusNotFound, "not_found", errors.New("not found"))
		return
	}
	parts := strings.Split(tail, "/")
	objectID := parts[0]
	if len(parts) == 2 && parts[1] == "content" {
		if r.Method != http.MethodGet {
			writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
			return
		}
		body, contentType, err := h.svc.GetContent(r.Context(), objectID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeTypedError(w, r, http.StatusNotFound, "not_found", err)
				return
			}
			status, code := classifyError(err)
			writeTypedError(w, r, status, code, err)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
		return
	}

	switch r.Method {
	case http.MethodGet:
		m, err := h.svc.GetMetadataByID(r.Context(), objectID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeTypedError(w, r, http.StatusNotFound, "not_found", err)
				return
			}
			status, code := classifyError(err)
			writeTypedError(w, r, status, code, err)
			return
		}
		writeJSON(w, http.StatusOK, m)
	case http.MethodDelete:
		if err := h.authorizeWrite(r); err != nil {
			writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
			return
		}
		deleted, err := h.svc.DeleteObject(r.Context(), objectID)
		if err != nil {
			status, code := classifyError(err)
			writeTypedError(w, r, status, code, err)
			return
		}
		writeJSON(w, http.StatusOK, storageDeleteObjectResponse{ObjectID: objectID, Deleted: deleted})
	default:
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
	}
}

type storageUpsertVectorsRequest struct {
	Vectors []core.UpsertVector `json:"vectors"`
}

func (h *StorageHandler) handleVectorUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	var req storageUpsertVectorsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	if err := h.svc.UpsertVectors(r.Context(), req.Vectors); err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"upserted": len(req.Vectors)})
}

type storageQueryVectorsRequest struct {
	Embedding []float64 `json:"embedding"`
	TopK      int       `json:"top_k"`
}

type storageQueryVectorsResponse struct {
	Results []core.QueryResult `json:"results"`
}

func (h *StorageHandler) handleVectorQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	var req storageQueryVectorsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	if req.TopK <= 0 {
		req.TopK = 5
	}
	results, err := h.svc.QueryVectors(r.Context(), req.Embedding, req.TopK)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, storageQueryVectorsResponse{Results: results})
}
