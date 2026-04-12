package main

import (
	"log"
	"net/http"

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

	adapter, err := infra.ResolveObjectAdapter(cfg.ObjectStore)
	if err != nil {
		log.Fatalf("failed to initialize object adapter: %v", err)
	}
	kv, err := pebble.Open(cfg.KVPath, &pebble.Options{})
	if err != nil {
		log.Fatalf("failed to open pebble db: %v", err)
	}
	defer kv.Close()

	svc := core.NewObjectServer(adapter, kv, core.ObjectConfig{DefaultBucket: cfg.DefaultBucket})
	handler := apiv1.NewObjectHandler(svc)
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

	log.Printf("%s listening on %s", cfg.ServerName, cfg.Addr)
	if err := http.ListenAndServe(cfg.Addr, observability.Middleware(cfg.ServerName, mux)); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
