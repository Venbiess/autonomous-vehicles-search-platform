package main

import (
	"database/sql"
	"log"
	"net/http"
	"strings"
	"time"

	"avsp/storage/config"
	infra "avsp/storage/infra"
	"avsp/storage/observability"
	core "avsp/storage/server"
	apiv1 "avsp/storage/transport/http"
	_ "github.com/lib/pq"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	cfg, err := config.LoadStorageServerConfig()
	if err != nil {
		log.Fatalf("failed to load storage server config: %v", err)
	}

	objectAdapter, err := infra.ResolveObjectAdapter(cfg.ObjectStore)
	if err != nil {
		log.Fatalf("failed to initialize object adapter: %v", err)
	}
	vectorAdapter, err := infra.ResolveVectorAdapter(cfg.VectorIndex)
	if err != nil {
		log.Fatalf("failed to initialize vector adapter: %v", err)
	}
	metaDB, err := sql.Open("postgres", cfg.MetadataDB.DSN)
	if err != nil {
		log.Fatalf("failed to open metadata postgres: %v", err)
	}
	defer metaDB.Close()

	svc, err := core.NewStorageServer(objectAdapter, vectorAdapter, metaDB, core.StorageConfig{
		DefaultBucket:  cfg.DefaultBucket,
		MetadataSchema: cfg.MetadataDB.Schema,
		MetadataTable:  cfg.MetadataDB.Table,
		Cache: core.ObjectCacheConfig{
			Enabled:            cfg.ObjectCache.Enabled,
			MaxItems:           cfg.ObjectCache.MaxItems,
			MaxTotalBytes:      cfg.ObjectCache.MaxTotalBytes,
			MaxObjectSizeBytes: cfg.ObjectCache.MaxObjectSizeBytes,
			TTL:                time.Duration(cfg.ObjectCache.TTLSeconds) * time.Second,
		},
	})
	if err != nil {
		log.Fatalf("failed to initialize storage service: %v", err)
	}

	preprocessorMethods := make([]core.PreprocessorMethod, 0)
	if manifestPath := strings.TrimSpace(cfg.PreprocessorsManifestPath); manifestPath != "" {
		catalog, err := config.LoadPreprocessorCatalog(manifestPath)
		if err != nil {
			observability.LogError("preprocessors_manifest_load_failed", map[string]any{
				"path":  manifestPath,
				"error": err.Error(),
			})
		} else {
			preprocessorMethods = make([]core.PreprocessorMethod, 0, len(catalog.Preprocessors))
			for _, item := range catalog.Preprocessors {
				key := strings.TrimSpace(item.Key)
				label := strings.TrimSpace(item.Label)
				if key == "" || label == "" {
					continue
				}
				preprocessorMethods = append(preprocessorMethods, core.PreprocessorMethod{
					Key:         key,
					Label:       label,
					Description: strings.TrimSpace(item.Description),
					Runner: core.PreprocessorRunner{
						Entrypoint: strings.TrimSpace(item.Runner.Entrypoint),
						Module:     strings.TrimSpace(item.Runner.Module),
					},
					DefaultConfig: item.DefaultConfig,
				})
			}
		}
	}

	handler := apiv1.NewStorageHandler(svc, cfg.WriteToken, preprocessorMethods)
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
		"service":              cfg.ServerName,
		"addr":                 cfg.Addr,
		"default_bucket":       cfg.DefaultBucket,
		"metadata_schema":      cfg.MetadataDB.Schema,
		"metadata_table":       cfg.MetadataDB.Table,
		"object_provider":      cfg.ObjectStore.Provider,
		"vector_provider":      cfg.VectorIndex.Provider,
		"preprocessor_methods": len(preprocessorMethods),
		"write_guard_enabled":  cfg.WriteToken != "",
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
