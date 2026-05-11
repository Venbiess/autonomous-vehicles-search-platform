package infra

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMilvusHelpers(t *testing.T) {
	t.Parallel()

	if got := milvusDBName(""); got != defaultMilvusDBName {
		t.Fatalf("unexpected default db name: %q", got)
	}
	if got := normalizeMilvusMetricType("dot"); got != "IP" {
		t.Fatalf("unexpected metric type: %q", got)
	}
	if got := normalizeMilvusMetricType("euclidean"); got != "L2" {
		t.Fatalf("unexpected metric type: %q", got)
	}
	if got := milvusIDFilter([]string{`a"b`, `c\d`}); got != `object_id in ["a\"b", "c\\d"]` {
		t.Fatalf("unexpected filter: %q", got)
	}

	distance, similarity := milvusScoreToDistanceSimilarity("COSINE", 0.8)
	if distance < 0.19 || distance > 0.21 || similarity != 0.8 {
		t.Fatalf("unexpected cosine mapping: (%v, %v)", distance, similarity)
	}
}

func TestMilvusAdapterCreateUpsertSearchDeleteCount(t *testing.T) {
	t.Parallel()

	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/v2/vectordb/collections/has":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": map[string]any{"has": len(calls) > 1},
			})
		case "/v2/vectordb/collections/create":
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode create payload: %v", err)
			}
			if payload["collectionName"] != "image_embeddings" {
				t.Fatalf("unexpected collection name: %v", payload["collectionName"])
			}
			if payload["primaryFieldName"] != defaultMilvusPrimaryField {
				t.Fatalf("unexpected primary field: %v", payload["primaryFieldName"])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{}})
		case "/v2/vectordb/entities/upsert":
			if got := r.Header.Get("Authorization"); got != "Bearer root:Milvus" {
				t.Fatalf("unexpected auth header: %q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{}})
		case "/v2/vectordb/entities/search":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": []map[string]any{
					{defaultMilvusPrimaryField: "obj-1", "distance": 0.9},
					{defaultMilvusPrimaryField: "obj-2", "distance": 0.5},
				},
			})
		case "/v2/vectordb/entities/delete":
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("decode delete payload: %v", err)
			}
			if payload["filter"] != `object_id in ["obj-1", "obj-2"]` {
				t.Fatalf("unexpected delete payload: %+v", payload)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{}})
		case "/v2/vectordb/collections/get_stats":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": map[string]any{"rowCount": 7},
			})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	adapter, err := NewMilvusAdapter(VectorIndexConfig{
		Provider:    "milvus",
		EndpointURL: server.URL,
		APIKey:      "root:Milvus",
		Schema:      "default",
		Table:       "image_embeddings",
		Distance:    "cosine",
	})
	if err != nil {
		t.Fatalf("NewMilvusAdapter error: %v", err)
	}
	if err := adapter.Upsert(context.Background(), "obj-1", []float64{0.1, 0.2}); err != nil {
		t.Fatalf("Upsert error: %v", err)
	}
	results, err := adapter.QueryTopK(context.Background(), []float64{0.1, 0.2}, 2)
	if err != nil {
		t.Fatalf("QueryTopK error: %v", err)
	}
	if len(results) != 2 || results[0].ObjectID != "obj-1" {
		t.Fatalf("unexpected search results: %+v", results)
	}
	if err := adapter.Delete(context.Background(), []string{"obj-1", "obj-2"}); err != nil {
		t.Fatalf("Delete error: %v", err)
	}
	count, err := adapter.Count(context.Background())
	if err != nil {
		t.Fatalf("Count error: %v", err)
	}
	if count != 7 {
		t.Fatalf("unexpected count: %d", count)
	}
}

func TestMilvusAdapterGetHelpers(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/vectordb/collections/has":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": map[string]any{"has": true},
			})
		case "/v2/vectordb/entities/get":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": []map[string]any{
					{defaultMilvusPrimaryField: "obj-2", defaultMilvusVectorField: []float64{0.2, 0.3}},
					{defaultMilvusPrimaryField: "obj-1", defaultMilvusVectorField: []float64{0.1, 0.2}},
				},
			})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	adapter, err := NewMilvusAdapter(VectorIndexConfig{
		Provider:    "milvus",
		EndpointURL: server.URL,
		Table:       "image_embeddings",
	})
	if err != nil {
		t.Fatalf("NewMilvusAdapter error: %v", err)
	}
	ids, err := adapter.ExistingObjectIDs(context.Background(), []string{"obj-1", "", "obj-2"})
	if err != nil {
		t.Fatalf("ExistingObjectIDs error: %v", err)
	}
	if strings.Join(ids, ",") != "obj-2,obj-1" {
		t.Fatalf("unexpected ids: %v", ids)
	}
	vectors, err := adapter.GetByObjectIDs(context.Background(), []string{"obj-1", "obj-2"})
	if err != nil {
		t.Fatalf("GetByObjectIDs error: %v", err)
	}
	if len(vectors) != 2 || len(vectors["obj-1"]) != 2 || vectors["obj-2"][1] != 0.3 {
		t.Fatalf("unexpected vectors: %+v", vectors)
	}
}
