package infra

import (
	"reflect"
	"testing"
)

func TestNormalizeYDBDistance(t *testing.T) {
	cases := map[string]string{
		"":          "cosine",
		"cosine":    "cosine",
		"l2":        "euclidean",
		"euclidean": "euclidean",
		"l1":        "manhattan",
		"manhattan": "manhattan",
	}
	for input, expected := range cases {
		if got := normalizeYDBDistance(input); got != expected {
			t.Fatalf("normalizeYDBDistance(%q)=%q, want %q", input, got, expected)
		}
	}
}

func TestYDBDedupeNonEmpty(t *testing.T) {
	got := ydbDedupeNonEmpty([]string{" obj-1 ", "", "obj-2", "obj-1", "obj-3 "})
	want := []string{"obj-1", "obj-2", "obj-3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ydbDedupeNonEmpty() = %#v, want %#v", got, want)
	}
}

func TestParseYDBEmbeddingRaw(t *testing.T) {
	got, err := parseYDBEmbeddingRaw(`[0.11,0.22,0.33]`)
	if err != nil {
		t.Fatalf("parseYDBEmbeddingRaw() error: %v", err)
	}
	want := []float64{0.11, 0.22, 0.33}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseYDBEmbeddingRaw() = %#v, want %#v", got, want)
	}
}

func TestParseYDBEmbeddingRawRejectsInvalidJSON(t *testing.T) {
	if _, err := parseYDBEmbeddingRaw(`not-json`); err == nil {
		t.Fatal("expected parseYDBEmbeddingRaw() to fail on invalid json")
	}
}
