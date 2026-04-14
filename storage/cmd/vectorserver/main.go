package main

import (
	"log"
	"net/http"
	"time"

	"avsp/storage/config"
	infra "avsp/storage/infra"
	"avsp/storage/observability"
	core "avsp/storage/server"
	apiv1 "avsp/storage/transport/http"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	cfg, err := config.LoadVectorServerConfig()
	if err != nil {
		log.Fatalf("failed to load vector server config: %v", err)
	}
	adapter, err := infra.ResolveVectorAdapterSet(cfg.VectorIndex, cfg.VectorIndexes)
	if err != nil {
		log.Fatalf("failed to initialize vector adapter: %v", err)
	}

	svc := core.NewVectorServer(adapter)
	handler := apiv1.NewVectorHandler(svc, cfg.WriteToken)
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Health(r.Context()); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	handler.Register(mux)

	shardsCount := len(cfg.VectorIndexes)
	if shardsCount == 0 {
		shardsCount = 1
	}
	observability.LogInfo("server_start", map[string]any{
		"service":             cfg.ServerName,
		"addr":                cfg.Addr,
		"provider":            cfg.VectorIndex.Provider,
		"schema":              cfg.VectorIndex.Schema,
		"table":               cfg.VectorIndex.Table,
		"shards":              shardsCount,
		"write_guard_enabled": cfg.WriteToken != "",
	})
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           observability.Middleware(cfg.ServerName, mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
