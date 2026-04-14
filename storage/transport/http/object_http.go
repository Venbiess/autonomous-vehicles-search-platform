package httptransport

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	core "avsp/storage/server"
)

type ObjectHandler struct {
	svc        *core.ObjectServer
	writeToken string
}

type putObjectRequest struct {
	StoragePath string `json:"storage_path"`
	ContentType string `json:"content_type,omitempty"`
}

type putObjectResponse struct {
	ObjectID    string    `json:"object_id"`
	StoragePath string    `json:"storage_path"`
	SizeBytes   int64     `json:"size_bytes"`
	ContentType string    `json:"content_type"`
	CreatedAt   time.Time `json:"created_at"`
}

type resolvePathRequest struct {
	StoragePath string `json:"storage_path"`
}

type resolvePathResponse struct {
	ObjectID string `json:"object_id"`
}

type registerPathsRequest struct {
	StoragePaths []string `json:"storage_paths"`
}

type registerPathsResponse struct {
	Items []core.RegisterPathItem `json:"items"`
}

type listObjectsResponse struct {
	Items      []core.ObjectMetadata `json:"items"`
	NextCursor string                `json:"next_cursor,omitempty"`
}

type deleteObjectResponse struct {
	ObjectID string `json:"object_id"`
	Deleted  bool   `json:"deleted"`
}

type getBatchObjectsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}

type getBatchObjectItem struct {
	ObjectID      string `json:"object_id"`
	ContentBase64 string `json:"content_base64,omitempty"`
	ContentType   string `json:"content_type,omitempty"`
	SizeBytes     int64  `json:"size_bytes,omitempty"`
	Error         string `json:"error,omitempty"`
}

type getBatchObjectsResponse struct {
	Items []getBatchObjectItem `json:"items"`
}

func NewObjectHandler(svc *core.ObjectServer, writeToken string) *ObjectHandler {
	return &ObjectHandler{svc: svc, writeToken: strings.TrimSpace(writeToken)}
}

func (h *ObjectHandler) authorizeWrite(r *http.Request) error {
	if h.writeToken == "" {
		return nil
	}
	if strings.TrimSpace(r.Header.Get("X-Storage-Write-Token")) != h.writeToken {
		return errors.New("write token is required")
	}
	return nil
}

func (h *ObjectHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/objects", h.handleObjects)
	mux.HandleFunc("/objects/register-paths", h.handleRegisterPaths)
	mux.HandleFunc("/objects/resolve-path", h.handleResolvePath)
	mux.HandleFunc("/objects/get-batch", h.handleGetBatch)
	mux.HandleFunc("/objects/", h.handleObjectByID)
}

func (h *ObjectHandler) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Health(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *ObjectHandler) handleObjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		limit := 100
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
		items, nextCursor, err := h.svc.ListObjects(limit, cursor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, listObjectsResponse{Items: items, NextCursor: nextCursor})
	case http.MethodPost:
		if err := h.authorizeWrite(r); err != nil {
			writeError(w, http.StatusForbidden, err)
			return
		}
		var req putObjectRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		m, err := h.svc.ResolvePath(r.Context(), req.StoragePath)
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, http.StatusOK, putObjectResponse{ObjectID: m.ObjectID, StoragePath: m.StoragePath, SizeBytes: m.SizeBytes, ContentType: m.ContentType, CreatedAt: m.CreatedAt})
	default:
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}

func (h *ObjectHandler) handleRegisterPaths(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeError(w, http.StatusForbidden, err)
		return
	}
	var req registerPathsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	items, err := h.svc.RegisterPaths(r.Context(), req.StoragePaths)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, registerPathsResponse{Items: items})
}

func (h *ObjectHandler) handleResolvePath(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeError(w, http.StatusForbidden, err)
		return
	}
	var req resolvePathRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	m, err := h.svc.ResolvePath(r.Context(), req.StoragePath)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, resolvePathResponse{ObjectID: m.ObjectID})
}

func (h *ObjectHandler) handleGetBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}

	var req getBatchObjectsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(req.ObjectIDs) == 0 {
		writeError(w, http.StatusBadRequest, errors.New("object_ids are required"))
		return
	}

	items := h.svc.GetBatchContent(r.Context(), req.ObjectIDs)
	resp := getBatchObjectsResponse{Items: make([]getBatchObjectItem, 0, len(items))}
	for _, item := range items {
		out := getBatchObjectItem{
			ObjectID:    item.ObjectID,
			ContentType: item.ContentType,
			SizeBytes:   item.SizeBytes,
			Error:       item.Error,
		}
		if len(item.Content) > 0 {
			out.ContentBase64 = base64.StdEncoding.EncodeToString(item.Content)
		}
		resp.Items = append(resp.Items, out)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *ObjectHandler) handleObjectByID(w http.ResponseWriter, r *http.Request) {
	tail := strings.TrimPrefix(r.URL.Path, "/objects/")
	if tail == "" {
		writeError(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	parts := strings.Split(strings.Trim(tail, "/"), "/")
	objectID := parts[0]
	if len(parts) == 2 && parts[1] == "content" {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
			return
		}
		content, contentType, err := h.svc.GetContent(r.Context(), objectID)
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(content)
		return
	}
	switch r.Method {
	case http.MethodGet:
		m, err := h.svc.GetMetadataByID(objectID)
		if err != nil {
			writeError(w, http.StatusNotFound, err)
			return
		}
		writeJSON(w, http.StatusOK, m)
	case http.MethodDelete:
		if err := h.authorizeWrite(r); err != nil {
			writeError(w, http.StatusForbidden, err)
			return
		}
		deleted, err := h.svc.Delete(r.Context(), objectID)
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, http.StatusOK, deleteObjectResponse{ObjectID: objectID, Deleted: deleted})
	default:
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}
