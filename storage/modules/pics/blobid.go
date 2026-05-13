package images

import (
	"fmt"
	"strconv"
	"strings"
)

type BlobID struct {
	PackID  uint32
	EntryID uint64
	Guard   uint32
}

func (b BlobID) String() string {
	return fmt.Sprintf("%08x,%016x,%08x", b.PackID, b.EntryID, b.Guard)
}

func ParseBlobID(raw string) (BlobID, error) {
	parts := strings.Split(raw, ",")
	if len(parts) != 3 {
		return BlobID{}, fmt.Errorf("invalid blob_id")
	}
	packID, err := strconv.ParseUint(parts[0], 16, 32)
	if err != nil {
		return BlobID{}, fmt.Errorf("invalid pack id")
	}
	entryID, err := strconv.ParseUint(parts[1], 16, 64)
	if err != nil {
		return BlobID{}, fmt.Errorf("invalid entry id")
	}
	guard, err := strconv.ParseUint(parts[2], 16, 32)
	if err != nil {
		return BlobID{}, fmt.Errorf("invalid guard")
	}
	return BlobID{
		PackID:  uint32(packID),
		EntryID: entryID,
		Guard:   uint32(guard),
	}, nil
}
