package main

import (
	"database/sql"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/Venbiess/autonomous-vehicles-search-platform/storage/config"
	infra "github.com/Venbiess/autonomous-vehicles-search-platform/storage/infra"
	"github.com/Venbiess/autonomous-vehicles-search-platform/storage/observability"
	core "github.com/Venbiess/autonomous-vehicles-search-platform/storage/server"
	apiv1 "github.com/Venbiess/autonomous-vehicles-search-platform/storage/transport/http"
	_ "github.com/lib/pq"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func trimDescriptionI18n(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	out := make(map[string]string, len(input))
	for rawLang, rawText := range input {
		lang := strings.ToLower(strings.TrimSpace(rawLang))
		text := strings.TrimSpace(rawText)
		if lang == "" || text == "" {
			continue
		}
		out[lang] = text
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func loadPreprocessorMethods(manifestPath string) ([]core.PreprocessorMethod, error) {
	catalog, err := config.LoadPreprocessorCatalog(manifestPath)
	if err != nil {
		return nil, err
	}

	methods := make([]core.PreprocessorMethod, 0, len(catalog.Preprocessors))
	for _, item := range catalog.Preprocessors {
		key := strings.TrimSpace(item.Key)
		label := strings.TrimSpace(item.Label)
		if key == "" || label == "" {
			continue
		}
		methods = append(methods, core.PreprocessorMethod{
			Key:             key,
			Label:           label,
			Description:     strings.TrimSpace(item.Description),
			DescriptionI18n: trimDescriptionI18n(item.DescriptionI18n),
			Runner: core.PreprocessorRunner{
				Entrypoint: strings.TrimSpace(item.Runner.Entrypoint),
				Module:     strings.TrimSpace(item.Runner.Module),
			},
			DefaultConfig: item.DefaultConfig,
		})
	}
	return methods, nil
}

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
	analyticsStore, err := core.NewAnalyticsStore(core.AnalyticsDBConfig{
		Provider:             cfg.AnalyticsDB.Provider,
		DSN:                  cfg.AnalyticsDB.DSN,
		FieldCatalogTable:    cfg.AnalyticsDB.FieldCatalogTable,
		AnnotationStoreTable: cfg.AnalyticsDB.AnnotationStoreTable,
	})
	if err != nil {
		log.Fatalf("failed to initialize analytics storage: %v", err)
	}
	svc.AttachAnalytics(analyticsStore)

	preprocessorMethods := make([]core.PreprocessorMethod, 0)
	var methodsProvider func() ([]core.PreprocessorMethod, error)
	if manifestPath := strings.TrimSpace(cfg.PreprocessorsManifestPath); manifestPath != "" {
		loadedMethods, err := loadPreprocessorMethods(manifestPath)
		if err != nil {
			observability.LogError("preprocessors_manifest_load_failed", map[string]any{
				"path":  manifestPath,
				"error": err.Error(),
			})
		} else {
			preprocessorMethods = loadedMethods
		}
		methodsProvider = func() ([]core.PreprocessorMethod, error) {
			return loadPreprocessorMethods(manifestPath)
		}
	}

	handler := apiv1.NewStorageHandler(svc, cfg.WriteToken, preprocessorMethods, methodsProvider)
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
		"analytics_provider":   cfg.AnalyticsDB.Provider,
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
