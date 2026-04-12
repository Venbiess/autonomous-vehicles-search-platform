package object

import (
	"fmt"
	"strings"
)

type Config struct {
	Provider    string
	EndpointURL string
	AccessKey   string
	SecretKey   string
	UseSSL      bool
}

func NewAdapter(cfg Config) (ObjectAdapter, error) {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "", "minio", "s3":
		return NewMinIOAdapter(cfg.EndpointURL, cfg.AccessKey, cfg.SecretKey, cfg.UseSSL)
	default:
		return nil, fmt.Errorf("unsupported object adapter provider: %s", cfg.Provider)
	}
}
