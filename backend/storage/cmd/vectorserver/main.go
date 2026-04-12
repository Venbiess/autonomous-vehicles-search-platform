package main

import (
	"log"
	"net/http"

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
	adapter, err := infra.ResolveVectorAdapter(cfg.VectorIndex)
	if err != nil {
		log.Fatalf("failed to initialize vector adapter: %v", err)
	}

	svc := core.NewVectorServer(adapter)
	handler := apiv1.NewVectorHandler(svc)
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
