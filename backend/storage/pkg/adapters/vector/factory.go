package vector

import (
	"fmt"
	"strings"
)

type Config struct {
	Provider string
	ConnStr  string
	Schema   string
	Table    string
}

func NewAdapter(cfg Config) (VectorAdapter, error) {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "", "pgvector", "postgres":
		return NewPgVectorAdapter(cfg.ConnStr, cfg.Schema, cfg.Table)
	default:
		return nil, fmt.Errorf("unsupported vector adapter provider: %s", cfg.Provider)
	}
}
