package images

import "testing"

func TestBlobIDRoundTrip(t *testing.T) {
	original := BlobID{PackID: 17, EntryID: 99, Guard: 1234}
	parsed, err := ParseBlobID(original.String())
	if err != nil {
		t.Fatalf("parse blob id: %v", err)
	}
	if parsed != original {
		t.Fatalf("round trip mismatch: got %+v want %+v", parsed, original)
	}
}
