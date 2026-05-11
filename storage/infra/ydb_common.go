package infra

import "strings"

func normalizeYDBDistance(distance string) string {
	switch strings.ToLower(strings.TrimSpace(distance)) {
	case "euclidean", "l2":
		return "euclidean"
	case "manhattan", "l1":
		return "manhattan"
	default:
		return "cosine"
	}
}
