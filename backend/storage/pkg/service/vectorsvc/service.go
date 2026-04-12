package vectorsvc

import (
	"encoding/json"
	"errors"
	"net/http"

	"avsp/storage/pkg/adapters/vector"
	"avsp/storage/pkg/common"
	"avsp/storage/pkg/contracts"
)

type Service struct {
	adapter vector.VectorAdapter
}

func New(adapter vector.VectorAdapter) *Service {
	return &Service{adapter: adapter}
}

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/vectors/upsert", s.handleUpsert)
	mux.HandleFunc("/vectors/query", s.handleQuery)
	mux.HandleFunc("/vectors/delete", s.handleDelete)
}

func (s *Service) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.adapter.Health(r.Context()); err != nil {
		common.WriteError(w, http.StatusServiceUnavailable, err)
		return
	}
	common.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		common.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req contracts.UpsertVectorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		common.WriteError(w, http.StatusBadRequest, err)
		return
	}
	for _, v := range req.Vectors {
		if v.ObjectID == "" || len(v.Embedding) == 0 {
			common.WriteError(w, http.StatusBadRequest, errors.New("object_id and embedding are required"))
			return
		}
		if err := s.adapter.Upsert(r.Context(), v.ObjectID, v.Embedding); err != nil {
			common.WriteError(w, http.StatusBadGateway, err)
			return
		}
	}
	common.WriteJSON(w, http.StatusOK, map[string]int{"upserted": len(req.Vectors)})
}

func (s *Service) handleQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		common.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req contracts.QueryVectorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		common.WriteError(w, http.StatusBadRequest, err)
		return
	}
	if len(req.Embedding) == 0 {
		common.WriteError(w, http.StatusBadRequest, errors.New("embedding is required"))
		return
	}
	if req.TopK <= 0 {
		req.TopK = 5
	}
	results, err := s.adapter.QueryTopK(r.Context(), req.Embedding, req.TopK)
	if err != nil {
		common.WriteError(w, http.StatusBadGateway, err)
		return
	}
	payload := contracts.QueryVectorsResponse{Results: make([]contracts.QueryResult, 0, len(results))}
	for _, item := range results {
		payload.Results = append(payload.Results, contracts.QueryResult{
			ObjectID:   item.ObjectID,
			Distance:   item.Distance,
			Similarity: item.Similarity,
		})
	}
	common.WriteJSON(w, http.StatusOK, payload)
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		common.WriteError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	var req contracts.DeleteVectorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		common.WriteError(w, http.StatusBadRequest, err)
		return
	}
	if err := s.adapter.Delete(r.Context(), req.ObjectIDs); err != nil {
		common.WriteError(w, http.StatusBadGateway, err)
		return
	}
	common.WriteJSON(w, http.StatusOK, map[string]int{"deleted": len(req.ObjectIDs)})
}
