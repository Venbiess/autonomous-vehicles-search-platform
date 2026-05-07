package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigPathPrefersEnv(t *testing.T) {
	t.Setenv("STORAGE_CONFIG_PATH", "/tmp/custom-storage.yaml")
	if got := configPath(); got != "/tmp/custom-storage.yaml" {
		t.Fatalf("unexpected config path: %q", got)
	}
}

func TestLoadStorageConfigFromPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "storage.yaml")
	err := os.WriteFile(path, []byte(`
storage_server:
  server_name: test
  addr: ":9012"
  write_token: secret
  default_bucket: synthetic
`), 0o644)
	if err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := loadStorageConfigFromPath(path)
	if err != nil {
		t.Fatalf("loadStorageConfigFromPath returned error: %v", err)
	}
	if cfg.StorageServer.ServerName != "test" {
		t.Fatalf("unexpected server name: %q", cfg.StorageServer.ServerName)
	}
	if cfg.StorageServer.DefaultBucket != "synthetic" {
		t.Fatalf("unexpected default bucket: %q", cfg.StorageServer.DefaultBucket)
	}
}

func TestLoadPreprocessorCatalog(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "preprocessors.yaml")
	err := os.WriteFile(path, []byte(`
preprocessors:
  - key: synthetic
    label: Synthetic
    runner:
      entrypoint: python
      module: backend.processors.synthetic_preprocessor
`), 0o644)
	if err != nil {
		t.Fatalf("write preprocessors: %v", err)
	}

	cfg, err := LoadPreprocessorCatalog(path)
	if err != nil {
		t.Fatalf("LoadPreprocessorCatalog returned error: %v", err)
	}
	if len(cfg.Preprocessors) != 1 {
		t.Fatalf("unexpected preprocessors count: %d", len(cfg.Preprocessors))
	}
	if cfg.Preprocessors[0].Runner.Module != "backend.processors.synthetic_preprocessor" {
		t.Fatalf("unexpected module: %q", cfg.Preprocessors[0].Runner.Module)
	}
}
