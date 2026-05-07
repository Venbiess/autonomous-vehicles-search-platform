package server

import (
	"reflect"
	"testing"
)

func TestDedupeNonEmptyPreservesOrder(t *testing.T) {
	got := dedupeNonEmpty([]string{"a", "", "b", "a", "c", "b"})
	want := []string{"a", "b", "c"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected dedupe result: got=%v want=%v", got, want)
	}
}
