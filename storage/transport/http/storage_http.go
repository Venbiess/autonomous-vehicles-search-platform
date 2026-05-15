package httptransport

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	core "github.com/Venbiess/autonomous-vehicles-search-platform/storage/server"
)

const maxUnifiedBatchObjectIDs = 256
const maxVectorGetObjectIDs = 512
const defaultListObjectsLimit = 100
const maxListObjectsLimit = 1000
const maxUploadObjectBytes = 32 << 20
const vectorCountCacheTTL = 15 * time.Second

type StorageHandler struct {
	svc        *core.StorageServer
	writeToken string
	methods    []core.PreprocessorMethod
	methodsMu  sync.RWMutex
	methodsProvider func() ([]core.PreprocessorMethod, error)

	vectorCountMu        sync.Mutex
	vectorCountCachedAt  time.Time
	vectorCountCachedVal int64
	vectorCountHasCache  bool
}

func NewStorageHandler(
	svc *core.StorageServer,
	writeToken string,
	methods []core.PreprocessorMethod,
	methodsProvider func() ([]core.PreprocessorMethod, error),
) *StorageHandler {
	methodsCopy := make([]core.PreprocessorMethod, len(methods))
	copy(methodsCopy, methods)
	return &StorageHandler{
		svc:        svc,
		writeToken: strings.TrimSpace(writeToken),
		methods:    methodsCopy,
		methodsProvider: methodsProvider,
	}
}

func (h *StorageHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/preprocessors/methods", h.handlePreprocessorMethods)
	mux.HandleFunc("/objects", h.handleObjects)
	mux.HandleFunc("/objects/count", h.handleObjectCount)
	mux.HandleFunc("/objects/upload", h.handleUploadObject)
	mux.HandleFunc("/objects/get-batch", h.handleGetBatch)
	mux.HandleFunc("/objects/", h.handleObjectByID)
	mux.HandleFunc("/vectors/upsert", h.handleVectorUpsert)
	mux.HandleFunc("/vectors/delete", h.handleVectorDelete)
	mux.HandleFunc("/vectors/get", h.handleVectorGet)
	mux.HandleFunc("/vectors/query", h.handleVectorQuery)
	mux.HandleFunc("/vectors/count", h.handleVectorCount)
	mux.HandleFunc("/vectors/count-above", h.handleVectorCountAbove)
	mux.HandleFunc("/vectors/clear", h.handleVectorClear)
	mux.HandleFunc("/vectors/cleanup-orphans", h.handleVectorCleanupOrphans)
	mux.HandleFunc("/vectors/completed-object-ids", h.handleVectorsCompletedObjectIDs)
	mux.HandleFunc("/fields", h.handleAnalyticsFields)
	mux.HandleFunc("/annotations/upsert", h.handleAnalyticsAnnotationsUpsert)
	mux.HandleFunc("/annotations/get", h.handleAnalyticsAnnotationsGet)
	mux.HandleFunc("/annotations/delete", h.handleAnalyticsAnnotationsDelete)
	mux.HandleFunc("/annotations/clear", h.handleAnalyticsAnnotationsClear)
	mux.HandleFunc("/annotations/completed-object-ids", h.handleAnalyticsCompletedObjectIDs)
	mux.HandleFunc("/search", h.handleAnalyticsSearch)
	mux.HandleFunc("/vlm/fields", h.handleAnalyticsFields)
	mux.HandleFunc("/vlm/annotations/upsert", h.handleAnalyticsAnnotationsUpsert)
	mux.HandleFunc("/vlm/annotations/get", h.handleAnalyticsAnnotationsGet)
	mux.HandleFunc("/vlm/annotations/delete", h.handleAnalyticsAnnotationsDelete)
	mux.HandleFunc("/vlm/annotations/clear", h.handleAnalyticsAnnotationsClear)
	mux.HandleFunc("/vlm/annotations/completed-object-ids", h.handleAnalyticsCompletedObjectIDs)
	mux.HandleFunc("/vlm/search", h.handleAnalyticsSearch)
}

func (h *StorageHandler) handlePreprocessorMethods(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if h.methodsProvider != nil {
		if loaded, err := h.methodsProvider(); err == nil {
			h.setMethods(loaded)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": h.getMethods(),
	})
}

func (h *StorageHandler) getMethods() []core.PreprocessorMethod {
	h.methodsMu.RLock()
	defer h.methodsMu.RUnlock()
	out := make([]core.PreprocessorMethod, len(h.methods))
	copy(out, h.methods)
	return out
}

func (h *StorageHandler) setMethods(methods []core.PreprocessorMethod) {
	methodsCopy := make([]core.PreprocessorMethod, len(methods))
	copy(methodsCopy, methods)
	h.methodsMu.Lock()
	h.methods = methodsCopy
	h.methodsMu.Unlock()
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

type storageListObjectsResponse struct {
	Items      []core.ObjectMetadata `json:"items"`
	NextCursor string                `json:"next_cursor,omitempty"`
}

func (h *StorageHandler) handleObjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		limit := defaultListObjectsLimit
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		if limit > maxListObjectsLimit {
			limit = maxListObjectsLimit
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

func (h *StorageHandler) handleObjectCount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	total, err := h.svc.CountObjects(r.Context())
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"count": total})
}

func (h *StorageHandler) handleUploadObject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadObjectBytes+(1<<20))
	if r.ContentLength <= 0 {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", errors.New("content-length is required"))
		return
	}
	if r.ContentLength > maxUploadObjectBytes {
		writeTypedError(w, r, http.StatusRequestEntityTooLarge, "payload_too_large", errors.New("file is too large"))
		return
	}
	bucket := strings.TrimSpace(r.URL.Query().Get("bucket"))
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	filename := strings.TrimSpace(r.URL.Query().Get("filename"))
	if filename == "" {
		filename = strings.TrimSpace(r.Header.Get("X-Object-Filename"))
	}
	contentType := strings.TrimSpace(r.URL.Query().Get("content_type"))
	if contentType == "" {
		contentType = strings.TrimSpace(r.Header.Get("Content-Type"))
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	m, err := h.svc.UploadObject(r.Context(), bucket, key, filename, contentType, r.Body, r.ContentLength)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

type storageGetBatchObjectsRequest struct {
	ObjectIDs      []string `json:"object_ids"`
	IncludeContent bool     `json:"include_content"`
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
		if req.IncludeContent && len(item.Content) > 0 {
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

type storageUpsertVectorsRequest struct {
	Vectors []core.UpsertVector `json:"vectors"`
}

type storageDeleteVectorsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}

type storageClearVectorsRequest struct {
	PageSize int `json:"page_size"`
}

type storageQueryVectorsRequest struct {
	Embedding []float64 `json:"embedding"`
	TopK      int       `json:"top_k"`
}

type storageQueryVectorsResponse struct {
	Results []core.QueryResult `json:"results"`
}

type storageCountVectorsAboveRequest struct {
	Embedding     []float64 `json:"embedding"`
	MinSimilarity float64   `json:"min_similarity"`
}

type storageCountVectorsAboveResponse struct {
	Count int64 `json:"count"`
}

type storageGetVectorsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}

type storageGetVectorsResponse struct {
	Items []core.StoredVector `json:"items"`
}

type storageCompletedObjectIDsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}

type storageCompletedObjectIDsResponse struct {
	ObjectIDs []string `json:"object_ids"`
}

type analyticsFieldsResponse struct {
	Fields []core.AnalyticsField `json:"fields"`
}

type analyticsUpsertFieldsRequest struct {
	Fields             []core.AnalyticsField `json:"fields"`
	ReplaceMissing     bool                  `json:"replace_missing"`
	PurgeDeletedValues bool                  `json:"purge_deleted_values"`
}

type analyticsUpsertAnnotationsRequest struct {
	Rows []core.AnnotationRow `json:"rows"`
}

type analyticsGetAnnotationsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}

type analyticsDeleteAnnotationsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}

type analyticsCompletedObjectIDsRequest struct {
	ObjectIDs  []string `json:"object_ids"`
	FieldNames []string `json:"field_names"`
}

type analyticsSearchRequest struct {
	Filters []core.SearchFilter `json:"filters"`
	Limit   int                 `json:"limit"`
}

type analyticsSearchResponse struct {
	Results []core.SearchResult `json:"results"`
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

func (h *StorageHandler) handleVectorCount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	total, ok := h.readVectorCountCache()
	if !ok {
		var err error
		total, err = h.svc.CountVectors(r.Context())
		if err != nil {
			status, code := classifyError(err)
			writeTypedError(w, r, status, code, err)
			return
		}
		h.writeVectorCountCache(total)
	}
	writeJSON(w, http.StatusOK, map[string]int64{"count": total})
}

func (h *StorageHandler) handleVectorCountAbove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	var req storageCountVectorsAboveRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	total, err := h.svc.CountVectorsAboveSimilarity(r.Context(), req.Embedding, req.MinSimilarity)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, storageCountVectorsAboveResponse{Count: total})
}

func (h *StorageHandler) handleVectorGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	var req storageGetVectorsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	if len(req.ObjectIDs) == 0 {
		writeJSON(w, http.StatusOK, storageGetVectorsResponse{Items: []core.StoredVector{}})
		return
	}
	if len(req.ObjectIDs) > maxVectorGetObjectIDs {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", errors.New("too many object_ids in batch"))
		return
	}
	items, err := h.svc.GetVectors(r.Context(), req.ObjectIDs)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, storageGetVectorsResponse{Items: items})
}

func (h *StorageHandler) handleVectorsCompletedObjectIDs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	var req storageCompletedObjectIDsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	if len(req.ObjectIDs) == 0 {
		writeJSON(w, http.StatusOK, storageCompletedObjectIDsResponse{ObjectIDs: []string{}})
		return
	}
	existing, err := h.svc.ExistingVectorObjectIDs(r.Context(), req.ObjectIDs)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, storageCompletedObjectIDsResponse{ObjectIDs: existing})
}

func (h *StorageHandler) readVectorCountCache() (int64, bool) {
	h.vectorCountMu.Lock()
	defer h.vectorCountMu.Unlock()
	if !h.vectorCountHasCache {
		return 0, false
	}
	if time.Since(h.vectorCountCachedAt) > vectorCountCacheTTL {
		h.vectorCountHasCache = false
		return 0, false
	}
	return h.vectorCountCachedVal, true
}

func (h *StorageHandler) writeVectorCountCache(count int64) {
	h.vectorCountMu.Lock()
	defer h.vectorCountMu.Unlock()
	h.vectorCountCachedVal = count
	h.vectorCountCachedAt = time.Now().UTC()
	h.vectorCountHasCache = true
}

func (h *StorageHandler) invalidateVectorCountCache() {
	h.vectorCountMu.Lock()
	defer h.vectorCountMu.Unlock()
	h.vectorCountHasCache = false
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
	h.invalidateVectorCountCache()
	writeJSON(w, http.StatusOK, map[string]int{"upserted": len(req.Vectors)})
}

func (h *StorageHandler) handleVectorDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	var req storageDeleteVectorsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	deleted, err := h.svc.DeleteVectors(r.Context(), req.ObjectIDs)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	h.invalidateVectorCountCache()
	writeJSON(w, http.StatusOK, map[string]int{"deleted": deleted, "requested": deleted})
}

func (h *StorageHandler) handleVectorClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	var req storageClearVectorsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	deleted, err := h.svc.ClearVectors(r.Context(), req.PageSize)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	h.invalidateVectorCountCache()
	writeJSON(w, http.StatusOK, map[string]int{"deleted": deleted, "requested": deleted})
}

func (h *StorageHandler) handleVectorCleanupOrphans(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	deleted, err := h.svc.CleanupOrphanVectors(r.Context())
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	h.invalidateVectorCountCache()
	writeJSON(w, http.StatusOK, map[string]int{"deleted": deleted, "requested": deleted})
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
	if len(parts) > 1 {
		writeTypedError(w, r, http.StatusNotFound, "not_found", errors.New("not found"))
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
		h.invalidateVectorCountCache()
		writeJSON(w, http.StatusOK, storageDeleteObjectResponse{ObjectID: objectID, Deleted: deleted})
	default:
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
	}
}

func (h *StorageHandler) analyticsStore(w http.ResponseWriter, r *http.Request) *core.AnalyticsStore {
	store := h.svc.Analytics()
	if store == nil {
		writeTypedError(w, r, http.StatusServiceUnavailable, "service_unavailable", errors.New("analytics storage is not configured"))
		return nil
	}
	return store
}

func (h *StorageHandler) handleAnalyticsFields(w http.ResponseWriter, r *http.Request) {
	store := h.analyticsStore(w, r)
	if store == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		rawNames := strings.TrimSpace(r.URL.Query().Get("field_names"))
		var names []string
		if rawNames != "" {
			for _, item := range strings.Split(rawNames, ",") {
				if name := strings.TrimSpace(item); name != "" {
					names = append(names, name)
				}
			}
		}
		fields, err := store.GetFields(r.Context(), names)
		if err != nil {
			status, code := classifyError(err)
			writeTypedError(w, r, status, code, err)
			return
		}
		writeJSON(w, http.StatusOK, analyticsFieldsResponse{Fields: fields})
	case http.MethodPost:
		if err := h.authorizeWrite(r); err != nil {
			writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
			return
		}
		var req analyticsUpsertFieldsRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
			return
		}
		if err := store.UpsertFields(r.Context(), req.Fields, req.ReplaceMissing, req.PurgeDeletedValues); err != nil {
			status, code := classifyError(err)
			writeTypedError(w, r, status, code, err)
			return
		}
		fields, err := store.GetFields(r.Context(), nil)
		if err != nil {
			status, code := classifyError(err)
			writeTypedError(w, r, status, code, err)
			return
		}
		writeJSON(w, http.StatusOK, analyticsFieldsResponse{Fields: fields})
	default:
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
	}
}

func (h *StorageHandler) handleAnalyticsAnnotationsUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	store := h.analyticsStore(w, r)
	if store == nil {
		return
	}
	var req analyticsUpsertAnnotationsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	if err := store.UpsertAnnotations(r.Context(), req.Rows); err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"upserted": len(req.Rows)})
}

func (h *StorageHandler) handleAnalyticsAnnotationsGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	store := h.analyticsStore(w, r)
	if store == nil {
		return
	}
	var req analyticsGetAnnotationsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	rows, err := store.GetAnnotations(r.Context(), req.ObjectIDs)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rows})
}

func (h *StorageHandler) handleAnalyticsAnnotationsDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	store := h.analyticsStore(w, r)
	if store == nil {
		return
	}
	var req analyticsDeleteAnnotationsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	requested, err := store.DeleteAnnotations(r.Context(), req.ObjectIDs)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"requested": requested})
}

func (h *StorageHandler) handleAnalyticsAnnotationsClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	if err := h.authorizeWrite(r); err != nil {
		writeTypedError(w, r, http.StatusForbidden, "forbidden", err)
		return
	}
	store := h.analyticsStore(w, r)
	if store == nil {
		return
	}
	deleted, err := store.ClearAnnotations(r.Context())
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "cleared", "deleted_rows": deleted})
}

func (h *StorageHandler) handleAnalyticsCompletedObjectIDs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	store := h.analyticsStore(w, r)
	if store == nil {
		return
	}
	var req analyticsCompletedObjectIDsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	ids, err := store.CompletedObjectIDs(r.Context(), req.ObjectIDs, req.FieldNames)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, storageCompletedObjectIDsResponse{ObjectIDs: ids})
}

func (h *StorageHandler) handleAnalyticsSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeTypedError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", errors.New("method not allowed"))
		return
	}
	store := h.analyticsStore(w, r)
	if store == nil {
		return
	}
	var req analyticsSearchRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", err)
		return
	}
	if req.Limit <= 0 {
		writeTypedError(w, r, http.StatusBadRequest, "bad_request", errors.New("limit must be positive"))
		return
	}
	results, err := store.Search(r.Context(), req.Filters, req.Limit)
	if err != nil {
		status, code := classifyError(err)
		writeTypedError(w, r, status, code, err)
		return
	}
	writeJSON(w, http.StatusOK, analyticsSearchResponse{Results: results})
}
