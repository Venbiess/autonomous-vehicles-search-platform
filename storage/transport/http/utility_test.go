package httptransport

import (
	core "github.com/Venbiess/autonomous-vehicles-search-platform/storage/server"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSafeErrorMessage(t *testing.T) {
	if got := safeErrorMessage(nil); got != "request failed" {
		t.Fatalf("unexpected nil error message: %q", got)
	}
	if got := safeErrorMessage(errors.New("  boom  ")); got != "boom" {
		t.Fatalf("unexpected trimmed message: %q", got)
	}
}

func TestClassifyError(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"invalid argument", core.ErrInvalidArgument, http.StatusBadRequest, "bad_request"},
		{"not found", sql.ErrNoRows, http.StatusNotFound, "not_found"},
		{"internal nil", nil, http.StatusInternalServerError, "internal_error"},
		{"upstream", errors.New("boom"), http.StatusBadGateway, "upstream_error"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, code := classifyError(tt.err)
			if status != tt.status || code != tt.code {
				t.Fatalf("got=(%d,%s) want=(%d,%s)", status, code, tt.status, tt.code)
			}
		})
	}
}

func TestDecodeJSONBodyRejectsTrailingPayload(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(`{"a":1}{"b":2}`))
	var payload struct {
		A int `json:"a"`
	}

	err := decodeJSONBody(req, &payload)
	if err == nil {
		t.Fatal("expected trailing JSON payload to fail")
	}
}
