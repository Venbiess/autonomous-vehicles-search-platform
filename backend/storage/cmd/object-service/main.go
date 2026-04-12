package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"avsp/storage/pkg/adapters/object"
	"avsp/storage/pkg/service/objectsvc"
	"github.com/cockroachdb/pebble"
)

func main() {
	addr := env("OBJECT_SERVICE_ADDR", ":9010")
	kvPath := env("OBJECT_KV_PATH", "/data/object-pebble")
	defaultBucket := env("OBJECT_DEFAULT_BUCKET", "avsp")
	provider := env("OBJECT_ADAPTER_PROVIDER", "minio")
	minioEndpoint := env("S3_ENDPOINT_URL", "http://minio:9000")
	minioAccess := env("S3_ACCESS_KEY_ID", "minioadmin")
	minioSecret := env("S3_SECRET_ACCESS_KEY", "minioadmin")
	useSSL := envBool("S3_USE_SSL", false)

	adapter, err := object.NewAdapter(object.Config{
		Provider:    provider,
		EndpointURL: minioEndpoint,
		AccessKey:   minioAccess,
		SecretKey:   minioSecret,
		UseSSL:      useSSL,
	})
	if err != nil {
		log.Fatalf("failed to initialize object adapter: %v", err)
	}
	kv, err := pebble.Open(kvPath, &pebble.Options{})
	if err != nil {
		log.Fatalf("failed to open pebble db: %v", err)
	}
	defer kv.Close()

	svc := objectsvc.New(adapter, kv, objectsvc.Config{DefaultBucket: defaultBucket})
	mux := http.NewServeMux()
	svc.Register(mux)

	log.Printf("object-service listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); strings.TrimSpace(v) != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return parsed
}
