package server

import (
	"encoding/json"
	"testing"
)

func TestParseJSONIntAcceptsQuotedAndNumericValues(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		value any
		want  int
	}{
		{name: "int", value: int(7), want: 7},
		{name: "float64 integer", value: float64(11), want: 11},
		{name: "json number", value: json.Number("13"), want: 13},
		{name: "quoted number", value: "17", want: 17},
		{name: "nil", value: nil, want: 0},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := parseJSONInt(tc.value)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("unexpected value: got=%d want=%d", got, tc.want)
			}
		})
	}
}

func TestParseJSONIntRejectsInvalidValues(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		value any
	}{
		{name: "float fraction", value: float64(1.5)},
		{name: "negative int", value: int(-1)},
		{name: "non numeric string", value: "abc"},
		{name: "unsupported type", value: map[string]any{"count": 1}},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if _, err := parseJSONInt(tc.value); err == nil {
				t.Fatalf("expected error, got nil")
			}
		})
	}
}
