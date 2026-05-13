package httptransport

import (
	infra "github.com/Venbiess/autonomous-vehicles-search-platform/storage/infra"
	"github.com/Venbiess/autonomous-vehicles-search-platform/storage/observability"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	core "github.com/Venbiess/autonomous-vehicles-search-platform/storage/server"
)

type errorResponse struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeTypedError(w http.ResponseWriter, r *http.Request, status int, code string, err error) {
	writeJSON(w, status, errorResponse{
		Error: errorBody{
			Code:      strings.TrimSpace(code),
			Message:   safeErrorMessage(err),
			RequestID: observability.RequestIDFromContext(r.Context()),
		},
	})
}

func safeErrorMessage(err error) string {
	if err == nil {
		return "request failed"
	}
	msg := strings.TrimSpace(err.Error())
	if msg == "" {
		return "request failed"
	}
	return msg
}

func classifyError(err error) (int, string) {
	if err == nil {
		return http.StatusInternalServerError, "internal_error"
	}
	if errors.Is(err, core.ErrInvalidArgument) {
		return http.StatusBadRequest, "bad_request"
	}
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, infra.ErrNotFound) {
		return http.StatusNotFound, "not_found"
	}
	return http.StatusBadGateway, "upstream_error"
}

func decodeJSONBody(r *http.Request, out any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != nil && !errors.Is(err, io.EOF) {
		return errors.New("request body must contain exactly one JSON object")
	}
	return nil
}
