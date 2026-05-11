package infra

import "testing"

func TestResolveObjectAdapterAcceptsSeaweedfsAliases(t *testing.T) {
	base := ObjectStoreConfig{
		EndpointURL:    "http://localhost:8333",
		AccessKey:      "seaweedfs",
		SecretKey:      "seaweedfs-secret",
		ForcePathStyle: true,
	}

	for _, provider := range []string{"seaweedfs", "sweedfs"} {
		cfg := base
		cfg.Provider = provider
		adapter, err := ResolveObjectAdapter(cfg)
		if err != nil {
			t.Fatalf("ResolveObjectAdapter(%q) returned error: %v", provider, err)
		}
		if adapter == nil {
			t.Fatalf("ResolveObjectAdapter(%q) returned nil adapter", provider)
		}
	}
}

func TestResolveObjectAdapterAcceptsYTsaurusAliases(t *testing.T) {
	base := ObjectStoreConfig{
		EndpointURL: "http://yt-proxy.local",
		PathPrefix:  "//tmp/avsp",
		AuthToken:   "token",
	}

	for _, provider := range []string{"ytsaurus", "yt"} {
		cfg := base
		cfg.Provider = provider
		adapter, err := ResolveObjectAdapter(cfg)
		if err != nil {
			t.Fatalf("ResolveObjectAdapter(%q) returned error: %v", provider, err)
		}
		if adapter == nil {
			t.Fatalf("ResolveObjectAdapter(%q) returned nil adapter", provider)
		}
		if got := adapter.CanonicalPath("avsp", "a/b.jpg"); got != "yt://avsp/a/b.jpg" {
			t.Fatalf("unexpected canonical path for %q: %q", provider, got)
		}
	}
}
