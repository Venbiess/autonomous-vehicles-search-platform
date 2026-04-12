package httptransport

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"avsp/storage/platform/httpx"
	core "avsp/storage/server"
)

type AnalyticsHandler struct{ svc *core.AnalyticsServer }

type analyticsFieldsRequest struct {
	Fields []core.AnalyticsField `json:"fields"`
}

type analyticsFieldsResponse struct {
	Fields []core.AnalyticsField `json:"fields"`
}

type upsertAnnotationsRequest struct {
	Rows []core.AnalyticsAnnotationRow `json:"rows"`
}

type deleteAnnotationsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}

type deleteAnnotationsResponse struct {
	Requested int `json:"requested"`
}

type completedIDsRequest struct {
	ObjectIDs  []string `json:"object_ids"`
	FieldNames []string `json:"field_names"`
}

type completedIDsResponse struct {
	ObjectIDs []string `json:"object_ids"`
}

type searchRequest struct {
	Filters []core.AnalyticsFilter `json:"filters"`
	Limit   int                    `json:"limit"`
}

type searchResponse struct {
	Results []core.AnalyticsSearchResult `json:"results"`
}

func NewAnalyticsHandler(svc *core.AnalyticsServer) *AnalyticsHandler {
	return &AnalyticsHandler{svc: svc}
}

func (h *AnalyticsHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/vlm/fields", h.handleFields)
	mux.HandleFunc("/vlm/annotations/upsert", h.handleUpsertAnnotations)
	mux.HandleFunc("/vlm/annotations/delete", h.handleDeleteAnnotations)
	mux.HandleFunc("/vlm/annotations/clear", h.handleClearAnnotations)
	mux.HandleFunc("/vlm/annotations/completed-object-ids", h.handleCompletedObjectIDs)
	mux.HandleFunc("/vlm/search", h.handleSearch)
}

func (h *AnalyticsHandler) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Health(r.Context()); err != nil {
		httpx.WriteError(w, http.StatusServiceUnavailable, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *AnalyticsHandler) handleFields(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		raw := strings.TrimSpace(r.URL.Query().Get("field_names"))
		fieldNames := []string{}
		if raw != "" {
			for _, part := range strings.Split(raw, ",") {
				if p := strings.TrimSpace(part); p != "" {
					fieldNames = append(fieldNames, p)
				}
			}
		}
		fields, err := h.svc.GetFields(r.Context(), fieldNames)
		if err != nil {
			httpx.WriteError(w, http.StatusBadGateway, err)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, analyticsFieldsResponse{Fields: fields})
	case http.MethodPost:
		var req analyticsFieldsRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			httpx.WriteError(w, http.StatusBadRequest, err)
			return
		}
		if err := h.svc.UpsertFields(r.Context(), req.Fields); err != nil {
			httpx.WriteError(w, http.StatusBadGateway, err)
			return
		}
		fields, err := h.svc.GetFields(r.Context(), nil)
		if err != nil {
			httpx.WriteError(w, http.StatusBadGateway, err)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, analyticsFieldsResponse{Fields: fields})
	default:
		httpx.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
	}
}

func (h *AnalyticsHandler) handleUpsertAnnotations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req upsertAnnotationsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, err)
		return
	}
	if err := h.svc.UpsertAnnotations(r.Context(), req.Rows); err != nil {
		httpx.WriteError(w, http.StatusBadGateway, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]int{"upserted": len(req.Rows)})
}

func (h *AnalyticsHandler) handleDeleteAnnotations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req deleteAnnotationsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, err)
		return
	}
	requested, err := h.svc.DeleteAnnotations(r.Context(), req.ObjectIDs)
	if err != nil {
		httpx.WriteError(w, http.StatusBadGateway, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, deleteAnnotationsResponse{Requested: requested})
}

func (h *AnalyticsHandler) handleClearAnnotations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	deleted, err := h.svc.ClearAnnotations(r.Context())
	if err != nil {
		httpx.WriteError(w, http.StatusBadGateway, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"status": "cleared", "deleted_rows": deleted})
}

func (h *AnalyticsHandler) handleCompletedObjectIDs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req completedIDsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, err)
		return
	}
	ids, err := h.svc.CompletedObjectIDs(r.Context(), req.ObjectIDs, req.FieldNames)
	if err != nil {
		httpx.WriteError(w, http.StatusBadGateway, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, completedIDsResponse{ObjectIDs: ids})
}

func (h *AnalyticsHandler) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req searchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, err)
		return
	}
	results, err := h.svc.Search(r.Context(), req.Filters, req.Limit)
	if err != nil {
		httpx.WriteError(w, http.StatusBadGateway, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, searchResponse{Results: results})
}
