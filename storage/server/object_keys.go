package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

func normalizeStoragePath(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "\\", "/"))
}

func objectIDFromStoragePath(storagePath string) string {
	sum := sha256.Sum256([]byte(normalizeStoragePath(storagePath)))
	return hex.EncodeToString(sum[:16])
}

func chooseObjectKey(explicitKey, filename string) (string, error) {
	key := strings.Trim(strings.TrimSpace(explicitKey), "/")
	if key != "" {
		return key, nil
	}

	ext := strings.ToLower(strings.TrimSpace(filepath.Ext(filename)))
	if len(ext) > 10 || strings.Contains(ext, "/") {
		ext = ""
	}
	suffix, err := randomHex(12)
	if err != nil {
		return "", err
	}
	datePath := time.Now().UTC().Format("2006/01/02")
	return fmt.Sprintf("uploads/%s/%s%s", datePath, suffix, ext), nil
}

func randomHex(size int) (string, error) {
	if size <= 0 {
		return "", errors.New("size must be > 0")
	}
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
