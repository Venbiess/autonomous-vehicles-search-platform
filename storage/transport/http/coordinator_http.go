package httptransport

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"avsp/storage/coordinator"
)

type CoordinatorHandler struct {
	svc *coordinator.Service
}

const idempotencyHeader = "X-Idempotency-Key"

type registerObjectRequest struct {
	StoragePath string `json:"storage_path"`
	Bucket      string `json:"bucket,omitempty"`
	Key         string `json:"key,omitempty"`
}

type startOperationRequest struct {
	Type     string         `json:"type"`
	ObjectID string         `json:"object_id"`
	Payload  map[string]any `json:"payload,omitempty"`
}

type failOperationRequest struct {
	Reason string `json:"reason"`
}

type vectorUpsertWorkflowRequest struct {
	ObjectID  string    `json:"object_id"`
	Embedding []float64 `json:"embedding"`
	Source    string    `json:"source,omitempty"`
}

type registerPathWorkflowRequest struct {
	StoragePath string `json:"storage_path"`
	Source      string `json:"source,omitempty"`
}

type deleteWorkflowRequest struct {
	ObjectID string `json:"object_id"`
	Source   string `json:"source,omitempty"`
}

func NewCoordinatorHandler(svc *coordinator.Service) *CoordinatorHandler {
	return &CoordinatorHandler{svc: svc}
}

func (h *CoordinatorHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/coordinator/leader", h.handleLeader)
	mux.HandleFunc("/coordinator/leader/renew", h.handleLeaderRenew)
	mux.HandleFunc("/coordinator/objects/register", h.handleObjectsRegister)
	mux.HandleFunc("/coordinator/objects/", h.handleObjectByID)
	mux.HandleFunc("/coordinator/operations", h.handleOperations)
	mux.HandleFunc("/coordinator/operations/", h.handleOperationByID)
	mux.HandleFunc("/coordinator/workflows/vector-upsert", h.handleWorkflowVectorUpsert)
	mux.HandleFunc("/coordinator/workflows/register-path", h.handleWorkflowRegisterPath)
	mux.HandleFunc("/coordinator/workflows/delete-object", h.handleWorkflowDeleteObject)
}

func (h *CoordinatorHandler) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Health(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *CoordinatorHandler) handleLeader(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	leader, err := h.svc.GetLeader(r.Context())
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, leader)
}

func (h *CoordinatorHandler) handleLeaderRenew(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	leader, acquired, err := h.svc.RenewLeader(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"acquired": acquired,
		"leader":   leader,
	})
}

func (h *CoordinatorHandler) handleObjectsRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	if _, err := h.svc.EnsureLeader(r.Context()); err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	var req registerObjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	record, err := h.svc.RegisterObject(r.Context(), req.StoragePath, req.Bucket, req.Key)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (h *CoordinatorHandler) handleObjectByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	tail := strings.TrimPrefix(r.URL.Path, "/coordinator/objects/")
	objectID := strings.TrimSpace(strings.Trim(tail, "/"))
	record, err := h.svc.GetObject(r.Context(), objectID)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (h *CoordinatorHandler) handleOperations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	if _, err := h.svc.EnsureLeader(r.Context()); err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	var req startOperationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	record, err := h.svc.StartOperation(r.Context(), req.Type, req.ObjectID, req.Payload)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (h *CoordinatorHandler) handleOperationByID(w http.ResponseWriter, r *http.Request) {
	tail := strings.TrimPrefix(r.URL.Path, "/coordinator/operations/")
	tail = strings.Trim(tail, "/")
	if tail == "" {
		writeError(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	parts := strings.Split(tail, "/")
	opID := parts[0]
	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
			return
		}
		op, err := h.svc.GetOperation(r.Context(), opID)
		if err != nil {
			writeError(w, http.StatusNotFound, err)
			return
		}
		writeJSON(w, http.StatusOK, op)
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	if _, err := h.svc.EnsureLeader(r.Context()); err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	action := parts[1]
	switch action {
	case "object-written":
		op, err := h.svc.MarkObjectWritten(r.Context(), opID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, op)
	case "vector-written":
		op, err := h.svc.MarkVectorWritten(r.Context(), opID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, op)
	case "commit":
		op, err := h.svc.Commit(r.Context(), opID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, op)
	case "fail":
		var req failOperationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		op, err := h.svc.Fail(r.Context(), opID, req.Reason)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, op)
	default:
		writeError(w, http.StatusNotFound, errors.New("not found"))
	}
}

func (h *CoordinatorHandler) handleWorkflowVectorUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	if _, err := h.svc.EnsureLeader(r.Context()); err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	var req vectorUpsertWorkflowRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	op, err := h.svc.VectorUpsertWorkflowIdempotent(
		r.Context(),
		strings.TrimSpace(req.ObjectID),
		req.Embedding,
		req.Source,
		strings.TrimSpace(r.Header.Get(idempotencyHeader)),
	)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, op)
}

func (h *CoordinatorHandler) handleWorkflowRegisterPath(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	if _, err := h.svc.EnsureLeader(r.Context()); err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	var req registerPathWorkflowRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	op, err := h.svc.RegisterObjectWorkflowIdempotent(
		r.Context(),
		strings.TrimSpace(req.StoragePath),
		req.Source,
		strings.TrimSpace(r.Header.Get(idempotencyHeader)),
	)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, op)
}

func (h *CoordinatorHandler) handleWorkflowDeleteObject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	if _, err := h.svc.EnsureLeader(r.Context()); err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	var req deleteWorkflowRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	op, err := h.svc.DeleteObjectAndVectorsWorkflowIdempotent(
		r.Context(),
		strings.TrimSpace(req.ObjectID),
		req.Source,
		strings.TrimSpace(r.Header.Get(idempotencyHeader)),
	)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, op)
}
