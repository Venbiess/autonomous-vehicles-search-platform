package infra

import "testing"

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
