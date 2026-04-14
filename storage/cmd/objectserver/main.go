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
	"github.com/cockroachdb/pebble"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	cfg, err := config.LoadObjectServerConfig()
	if err != nil {
		log.Fatalf("failed to load object server config: %v", err)
	}

	adapter, err := infra.ResolveObjectAdapterSet(cfg.ObjectStore, cfg.ObjectStores)
	if err != nil {
		log.Fatalf("failed to initialize object adapter: %v", err)
	}
	kv, err := pebble.Open(cfg.KVPath, &pebble.Options{})
	if err != nil {
		log.Fatalf("failed to open pebble db: %v", err)
	}
	defer kv.Close()

	svc := core.NewObjectServer(adapter, kv, core.ObjectConfig{
		DefaultBucket: cfg.DefaultBucket,
		Cache: core.ObjectCacheConfig{
			Enabled:            cfg.ObjectCache.Enabled,
			MaxItems:           cfg.ObjectCache.MaxItems,
			MaxTotalBytes:      cfg.ObjectCache.MaxTotalBytes,
			MaxObjectSizeBytes: cfg.ObjectCache.MaxObjectSizeBytes,
			TTL:                time.Duration(cfg.ObjectCache.TTLSeconds) * time.Second,
		},
	})
	handler := apiv1.NewObjectHandler(svc, cfg.WriteToken)
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

	observability.LogInfo("server_start", map[string]any{
		"service":                     cfg.ServerName,
		"addr":                        cfg.Addr,
		"default_bucket":              cfg.DefaultBucket,
		"kv_path":                     cfg.KVPath,
		"object_stores":               len(cfg.ObjectStores),
		"cache_enabled":               cfg.ObjectCache.Enabled,
		"cache_max_items":             cfg.ObjectCache.MaxItems,
		"cache_max_total_bytes":       cfg.ObjectCache.MaxTotalBytes,
		"cache_max_object_size_bytes": cfg.ObjectCache.MaxObjectSizeBytes,
		"cache_ttl_seconds":           cfg.ObjectCache.TTLSeconds,
		"write_guard_enabled":         cfg.WriteToken != "",
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
