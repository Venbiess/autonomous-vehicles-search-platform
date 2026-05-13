package main

import (
	"context"
	"log"
	"net/http"
	"os/signal"
	"syscall"

	images "github.com/Venbiess/autonomous-vehicles-search-platform/storage/modules/pics"
)

func main() {
	cfg, err := images.LoadCoordinatorConfig()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	registry, err := images.LoadRegistry(cfg)
	if err != nil {
		log.Fatalf("load registry: %v", err)
	}
	defer func() {
		if err := registry.Close(); err != nil {
			log.Printf("close registry: %v", err)
		}
	}()
	_, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Printf("coordinator listening on %s", cfg.ListenAddr)
	if err := http.ListenAndServe(cfg.ListenAddr, images.NewCoordinatorHandler(registry)); err != nil {
		log.Fatal(err)
	}
}
