package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"avsp/storage/config"
	"avsp/storage/coordinator"
	"avsp/storage/observability"
	apiv1 "avsp/storage/transport/http"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	cfg, err := config.LoadCoordinatorServerConfig()
	if err != nil {
		log.Fatalf("failed to load coordinator config: %v", err)
	}

	leaseTTL := time.Duration(cfg.Backend.LeaseTTLSeconds) * time.Second
	if leaseTTL <= 0 {
		leaseTTL = 10 * time.Second
	}
	opTTL := time.Duration(cfg.Backend.OperationTTLSeconds) * time.Second

	store, err := coordinator.ResolveStore(coordinator.BackendConfig{
		Provider:  cfg.Backend.Provider,
		Endpoints: cfg.Backend.Endpoints,
		Prefix:    cfg.Backend.Prefix,
	}, leaseTTL)
	if err != nil {
		log.Fatalf("failed to initialize coordinator store: %v", err)
	}

	dataPlane, err := coordinator.NewHTTPDataPlane(coordinator.HTTPDataPlaneConfig{
		ObjectEndpoint: cfg.DataPlane.ObjectEndpoint,
		VectorEndpoint: cfg.DataPlane.VectorEndpoint,
		WriteToken:     cfg.DataPlane.WriteToken,
		Timeout:        time.Duration(cfg.DataPlane.TimeoutSeconds) * time.Second,
	})
	if err != nil {
		log.Fatalf("failed to initialize coordinator data plane client: %v", err)
	}

	svc := coordinator.NewService(store, coordinator.ServerConfig{
		NodeID:       cfg.NodeID,
		LeaseTTL:     leaseTTL,
		OperationTTL: opTTL,
	}, dataPlane)

	reconcileInterval := time.Duration(cfg.Backend.ReconcileIntervalSeconds) * time.Second
	if reconcileInterval <= 0 {
		reconcileInterval = 15 * time.Second
	}
	reconcileLimit := cfg.Backend.ReconcileBatchLimit
	if reconcileLimit <= 0 {
		reconcileLimit = 200
	}
	go func() {
		ticker := time.NewTicker(reconcileInterval)
		defer ticker.Stop()
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			leader, err := svc.EnsureLeader(ctx)
			if err == nil {
				failed, recErr := svc.ReconcileStaleOperations(ctx, opTTL, reconcileLimit)
				if recErr != nil {
					observability.LogError("coordinator_reconcile_failed", map[string]any{
						"error": recErr.Error(),
					})
				} else if failed > 0 {
					observability.LogInfo("coordinator_reconcile_applied", map[string]any{
						"failed_operations": failed,
						"leader_node_id":    leader.NodeID,
					})
				}
			}
			cancel()
		}
	}()
	handler := apiv1.NewCoordinatorHandler(svc)
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
		"service":                    cfg.ServerName,
		"addr":                       cfg.Addr,
		"node_id":                    cfg.NodeID,
		"provider":                   cfg.Backend.Provider,
		"endpoints":                  cfg.Backend.Endpoints,
		"prefix":                     cfg.Backend.Prefix,
		"lease_ttl_seconds":          cfg.Backend.LeaseTTLSeconds,
		"operation_ttl_seconds":      cfg.Backend.OperationTTLSeconds,
		"reconcile_interval_seconds": cfg.Backend.ReconcileIntervalSeconds,
		"reconcile_batch_limit":      cfg.Backend.ReconcileBatchLimit,
		"dataplane_object_endpoint":  cfg.DataPlane.ObjectEndpoint,
		"dataplane_vector_endpoint":  cfg.DataPlane.VectorEndpoint,
		"dataplane_timeout_seconds":  cfg.DataPlane.TimeoutSeconds,
		"dataplane_write_guard":      cfg.DataPlane.WriteToken != "",
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
