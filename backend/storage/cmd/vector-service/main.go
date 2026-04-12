package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"avsp/storage/pkg/adapters/vector"
	"avsp/storage/pkg/service/vectorsvc"
)

func main() {
	addr := env("VECTOR_SERVICE_ADDR", ":9011")
	host := env("POSTGRES_HOST", "postgres")
	port := env("POSTGRES_PORT", "5432")
	db := env("POSTGRES_DB", "avsp")
	user := env("POSTGRES_USER", "postgres")
	password := env("POSTGRES_PASSWORD", "postgres")
	provider := env("VECTOR_ADAPTER_PROVIDER", "pgvector")
	schema := env("VECTOR_SCHEMA", "public")
	table := env("VECTOR_TABLE", "image_embeddings")

	connStr := fmt.Sprintf("host=%s port=%s dbname=%s user=%s password=%s sslmode=disable", host, port, db, user, password)
	adapter, err := vector.NewAdapter(vector.Config{
		Provider: provider,
		ConnStr:  connStr,
		Schema:   schema,
		Table:    table,
	})
	if err != nil {
		log.Fatalf("failed to initialize vector adapter: %v", err)
	}

	svc := vectorsvc.New(adapter)
	mux := http.NewServeMux()
	svc.Register(mux)

	log.Printf("vector-service listening on %s", addr)
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
