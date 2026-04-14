package coordinator

import (
	"fmt"
	"strings"
	"time"
)

type BackendConfig struct {
	Provider  string
	Endpoints []string
	Prefix    string
}

func ResolveStore(cfg BackendConfig, leaseTTL time.Duration) (Store, error) {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "", "memory", "inmemory":
		return NewMemoryStore(leaseTTL), nil
	case "etcd":
		etcdStore, err := NewEtcdStore(EtcdConfig{
			Endpoints: cfg.Endpoints,
			Prefix:    cfg.Prefix,
			LeaseTTL:  int(leaseTTL.Seconds()),
		})
		if err != nil {
			return nil, err
		}
		return etcdStore, nil
	default:
		return nil, fmt.Errorf("unsupported coordinator backend provider: %s", cfg.Provider)
	}
}
