package infra

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNormalizeQdrantDistance(t *testing.T) {
	t.Parallel()

	cases := []struct {
		input string
		want  string
	}{
		{input: "", want: "Cosine"},
		{input: "cosine", want: "Cosine"},
		{input: "dot", want: "Dot"},
		{input: "euclidean", want: "Euclid"},
		{input: "l1", want: "Manhattan"},
		{input: "unexpected", want: "Cosine"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			if got := normalizeQdrantDistance(tc.input); got != tc.want {
				t.Fatalf("normalizeQdrantDistance(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestScoreToDistanceSimilarity(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name           string
		score          float64
		distance       string
		wantDistance   float64
		wantSimilarity float64
	}{
		{name: "cosine", score: 0.8, distance: "cosine", wantDistance: 0.2, wantSimilarity: 0.8},
		{name: "dot", score: 0.3, distance: "dot", wantDistance: 0.7, wantSimilarity: 0.3},
		{name: "euclid", score: -2, distance: "euclid", wantDistance: 2, wantSimilarity: 1.0 / 3.0},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			distance, similarity := scoreToDistanceSimilarity(tc.score, tc.distance)
			if math.Abs(distance-tc.wantDistance) > 1e-9 || math.Abs(similarity-tc.wantSimilarity) > 1e-9 {
				t.Fatalf(
					"scoreToDistanceSimilarity(%v, %q) = (%v, %v), want (%v, %v)",
					tc.score, tc.distance, distance, similarity, tc.wantDistance, tc.wantSimilarity,
				)
			}
		})
	}
}

func TestParseQdrantVector(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		raw   any
		want  []float64
		valid bool
	}{
		{name: "plain array", raw: []any{1.0, 2, int64(3)}, want: []float64{1, 2, 3}, valid: true},
		{name: "default map", raw: map[string]any{"default": []any{4.0, 5.0}}, want: []float64{4, 5}, valid: true},
		{name: "fallback map", raw: map[string]any{"custom": []any{6.0}}, want: []float64{6}, valid: true},
		{name: "invalid value", raw: []any{1.0, "bad"}, want: []float64{}, valid: false},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := parseQdrantVector(tc.raw)
			if tc.valid {
				if len(got) != len(tc.want) {
					t.Fatalf("parseQdrantVector(%v) len=%d want=%d", tc.raw, len(got), len(tc.want))
				}
				for i := range got {
					if got[i] != tc.want[i] {
						t.Fatalf("parseQdrantVector(%v)[%d]=%v want=%v", tc.raw, i, got[i], tc.want[i])
					}
				}
				return
			}
			if len(got) != 0 {
				t.Fatalf("parseQdrantVector(%v)=%v want empty", tc.raw, got)
			}
		})
	}
}

func TestQdrantExtractObjectIDPrefersPayload(t *testing.T) {
	t.Parallel()

	q := &QdrantAdapter{}
	if got := q.extractObjectID("point-id", map[string]any{"object_id": "object-id"}); got != "object-id" {
		t.Fatalf("expected payload object_id, got %q", got)
	}
	if got := q.extractObjectID(float64(42), nil); got != "42" {
		t.Fatalf("expected numeric id fallback, got %q", got)
	}
}

func TestQdrantLookupPointsParsesArrayAndPointsObject(t *testing.T) {
	t.Parallel()

	arrayResult := []any{
		map[string]any{
			"id":      "obj-1",
			"vector":  []any{1.0, 2.0},
			"payload": map[string]any{"object_id": "obj-1"},
		},
	}
	objectResult := map[string]any{
		"points": []any{
			map[string]any{
				"id":      "obj-2",
				"vector":  []any{3.0, 4.0},
				"payload": map[string]any{"object_id": "obj-2"},
			},
		},
	}

	arrayPoints := qdrantLookupPoints(arrayResult)
	if len(arrayPoints) != 1 || arrayPoints[0].ID != "obj-1" {
		t.Fatalf("qdrantLookupPoints(array) = %#v", arrayPoints)
	}
	objectPoints := qdrantLookupPoints(objectResult)
	if len(objectPoints) != 1 || objectPoints[0].ID != "obj-2" {
		t.Fatalf("qdrantLookupPoints(object) = %#v", objectPoints)
	}
}

func TestParseQdrantPayloadEmbedding(t *testing.T) {
	t.Parallel()

	got := parseQdrantPayloadEmbedding(map[string]any{
		"embedding": []any{0.11, 0.22},
	})
	if len(got) != 2 || got[0] != 0.11 || got[1] != 0.22 {
		t.Fatalf("parseQdrantPayloadEmbedding() = %v", got)
	}
}

func TestQdrantExistingObjectIDs(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/collections/test/points" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status":"ok",
			"result":[
				{"id":"obj-2","payload":{"object_id":"obj-2"}},
				{"id":"obj-1","payload":{"object_id":"obj-1"}},
				{"id":"obj-2","payload":{"object_id":"obj-2"}}
			]
		}`))
	}))
	defer server.Close()

	adapter, err := NewQdrantAdapter(VectorIndexConfig{
		EndpointURL: server.URL,
		Collection:  "test",
		Distance:    "cosine",
		TimeoutSec:  5,
	})
	if err != nil {
		t.Fatalf("NewQdrantAdapter error: %v", err)
	}

	ids, err := adapter.ExistingObjectIDs(context.Background(), []string{"obj-2", "missing", "obj-1", "obj-2"})
	if err != nil {
		t.Fatalf("ExistingObjectIDs error: %v", err)
	}
	if len(ids) != 2 || ids[0] != "obj-2" || ids[1] != "obj-1" {
		t.Fatalf("ExistingObjectIDs() = %#v", ids)
	}
}
