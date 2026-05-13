package images

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

func StartHeartbeatLoop(ctx context.Context, store *Store, cfg VolumeConfig) {
	ticker := time.NewTicker(cfg.HeartbeatInterval)
	go func() {
		defer ticker.Stop()
		for {
			if err := sendHeartbeat(store, cfg); err != nil {
				log.Printf("heartbeat failed: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func sendHeartbeat(store *Store, cfg VolumeConfig) error {
	payload, err := json.Marshal(store.Heartbeat())
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(cfg.CoordinatorURL, "/")+"/internal/heartbeat", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := store.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("coordinator heartbeat status %s", resp.Status)
	}
	return nil
}
