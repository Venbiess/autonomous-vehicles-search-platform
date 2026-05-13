package vector

import "testing"

func TestDeterministicVectorStable(t *testing.T) {
	a := deterministicVector(42, 7, 8)
	b := deterministicVector(42, 7, 8)
	if len(a) != len(b) {
		t.Fatalf("length mismatch: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("vector differs at %d: %v vs %v", i, a[i], b[i])
		}
	}
}

func TestPercentile(t *testing.T) {
	values := []float64{1, 2, 3, 4, 5}
	if got := percentile(values, 0.50); got != 3 {
		t.Fatalf("p50 = %v, want 3", got)
	}
	if got := percentile(values, 0.95); got != 5 {
		t.Fatalf("p95 = %v, want 5", got)
	}
}

func TestBuildReport(t *testing.T) {
	stats := &benchStats{
		Latencies: []float64{5, 1, 3, 2, 4},
		Errors:    1,
		Successes: 5,
	}
	report := buildReport(runnerConfig{
		Label:    "bench",
		Provider: "qdrant",
		Mode:     "query",
	}, stats, 2_000_000_000, "self")
	if report.Provider != "qdrant" {
		t.Fatalf("provider = %s", report.Provider)
	}
	if report.Operations != 6 {
		t.Fatalf("operations = %d", report.Operations)
	}
	if report.P50Ms != 3 {
		t.Fatalf("p50 = %v", report.P50Ms)
	}
}

func TestPrintRunReportJSON(t *testing.T) {
	report := runReport{
		Label:    "bench",
		Provider: "pgvector",
		Insert:   benchReport{Mode: "insert"},
		Search:   benchReport{Mode: "query"},
	}
	if report.Insert.Mode != "insert" {
		t.Fatalf("insert mode = %s", report.Insert.Mode)
	}
	if report.Search.Mode != "query" {
		t.Fatalf("search mode = %s", report.Search.Mode)
	}
}

func TestResolveVectorConfigQdrantWithoutConfig(t *testing.T) {
	cfg, err := resolveVectorConfig(runnerConfig{
		BackendType: "qdrant",
		Endpoint:    "http://localhost:6333",
		VectorSize:  640,
		TimeoutSec:  10,
	})
	if err != nil {
		t.Fatalf("resolveVectorConfig error: %v", err)
	}
	if cfg.Provider != "qdrant" {
		t.Fatalf("provider = %s", cfg.Provider)
	}
	if cfg.Collection != "image_embeddings" {
		t.Fatalf("collection = %s", cfg.Collection)
	}
}

func TestResolveVectorConfigPgvectorRequiresDSN(t *testing.T) {
	_, err := resolveVectorConfig(runnerConfig{
		BackendType: "pgvector",
		VectorSize:  640,
	})
	if err == nil {
		t.Fatal("expected error")
	}
}
