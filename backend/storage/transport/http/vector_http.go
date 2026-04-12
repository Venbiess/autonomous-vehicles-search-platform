package httptransport

import (
	"encoding/json"
	"errors"
	"net/http"

	"avsp/storage/platform/httpx"
	core "avsp/storage/server"
)

type VectorHandler struct{ svc *core.VectorServer }

type upsertVectorsRequest struct {
	Vectors []core.UpsertVector `json:"vectors"`
}

type queryVectorsRequest struct {
	Embedding []float64 `json:"embedding"`
	TopK      int       `json:"top_k"`
}

type queryVectorsResponse struct {
	Results []core.QueryResult `json:"results"`
}

type deleteVectorsRequest struct {
	ObjectIDs []string `json:"object_ids"`
}

type deleteVectorsResponse struct {
	Requested int `json:"requested"`
}

func NewVectorHandler(svc *core.VectorServer) *VectorHandler { return &VectorHandler{svc: svc} }

func (h *VectorHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/vectors/upsert", h.handleUpsert)
	mux.HandleFunc("/vectors/query", h.handleQuery)
	mux.HandleFunc("/vectors/delete", h.handleDelete)
}

func (h *VectorHandler) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Health(r.Context()); err != nil {
		httpx.WriteError(w, http.StatusServiceUnavailable, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *VectorHandler) handleUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req upsertVectorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, err)
		return
	}
	for _, v := range req.Vectors {
		if v.ObjectID == "" || len(v.Embedding) == 0 {
			httpx.WriteError(w, http.StatusBadRequest, errors.New("object_id and embedding are required"))
			return
		}
	}
	if err := h.svc.Upsert(r.Context(), req.Vectors); err != nil {
		httpx.WriteError(w, http.StatusBadGateway, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]int{"upserted": len(req.Vectors)})
}

func (h *VectorHandler) handleQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req queryVectorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, err)
		return
	}
	if len(req.Embedding) == 0 {
		httpx.WriteError(w, http.StatusBadRequest, errors.New("embedding is required"))
		return
	}
	if req.TopK <= 0 {
		req.TopK = 5
	}
	results, err := h.svc.Query(r.Context(), req.Embedding, req.TopK)
	if err != nil {
		httpx.WriteError(w, http.StatusBadGateway, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, queryVectorsResponse{Results: results})
}

func (h *VectorHandler) handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req deleteVectorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, err)
		return
	}
	requested, err := h.svc.Delete(r.Context(), req.ObjectIDs)
	if err != nil {
		httpx.WriteError(w, http.StatusBadGateway, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, deleteVectorsResponse{Requested: requested})
}
