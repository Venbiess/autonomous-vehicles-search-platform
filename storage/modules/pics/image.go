package images

import "net/http"

type ImageMetadata struct {
	ContentType string `json:"content_type"`
	Checksum    string `json:"checksum"`
	Size        uint64 `json:"size"`
}

func BuildImageMetadata(size uint64, checksum string, sniff []byte, hintedType string) ImageMetadata {
	contentType := hintedType
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = http.DetectContentType(sniff)
	}
	return ImageMetadata{
		ContentType: contentType,
		Checksum:    checksum,
		Size:        size,
	}
}
