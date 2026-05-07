package server

import (
	"strings"
	"testing"
)

func TestNormalizeStoragePath(t *testing.T) {
	got := normalizeStoragePath(`  s3:\bucket\path\file.jpg  `)
	if got != "s3:/bucket/path/file.jpg" {
		t.Fatalf("unexpected normalized path: %q", got)
	}
}

func TestObjectIDFromStoragePathStableAcrossSeparators(t *testing.T) {
	a := objectIDFromStoragePath("s3://bucket/path/file.jpg")
	b := objectIDFromStoragePath(`s3://bucket\path\file.jpg`)
	if a != b {
		t.Fatalf("expected stable object id, got %q vs %q", a, b)
	}
}

func TestChooseObjectKeyUsesExplicitKey(t *testing.T) {
	got, err := chooseObjectKey(" /demo/file.jpg/ ", "ignored.png")
	if err != nil {
		t.Fatalf("chooseObjectKey returned error: %v", err)
	}
	if got != "demo/file.jpg" {
		t.Fatalf("unexpected explicit key: %q", got)
	}
}

func TestChooseObjectKeyBuildsUploadPathFromFilename(t *testing.T) {
	got, err := chooseObjectKey("", "frame.JPG")
	if err != nil {
		t.Fatalf("chooseObjectKey returned error: %v", err)
	}
	if !strings.HasPrefix(got, "uploads/") {
		t.Fatalf("expected uploads prefix, got %q", got)
	}
	if !strings.HasSuffix(got, ".jpg") {
		t.Fatalf("expected lowercase extension, got %q", got)
	}
}

func TestRandomHexRejectsNonPositiveSize(t *testing.T) {
	if _, err := randomHex(0); err == nil {
		t.Fatal("expected error for zero size")
	}
}
