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

func TestLoadStorageConfigFromPathAppliesObjectStoreEnvOverrides(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "storage.yaml")
	err := os.WriteFile(path, []byte(`
storage_server:
  server_name: test
  addr: ":9012"
  write_token: secret
  default_bucket: synthetic
  object_store:
    provider: minio
    endpoint_url: http://minio:9000
    access_key: minioadmin
    secret_key: minioadmin
    region: us-east-1
    use_ssl: false
    force_path_style: true
`), 0o644)
	if err != nil {
		t.Fatalf("write config: %v", err)
	}

	t.Setenv("OBJECT_STORE_PROVIDER", "seaweedfs")
	t.Setenv("OBJECT_STORE_ENDPOINT_URL", "http://seaweedfs-s3:8333")
	t.Setenv("OBJECT_STORE_ACCESS_KEY", "seaweedfs")
	t.Setenv("OBJECT_STORE_SECRET_KEY", "seaweedfs-secret")
	t.Setenv("OBJECT_STORE_AUTH_TOKEN", "yt-oauth")
	t.Setenv("OBJECT_STORE_REGION", "local")
	t.Setenv("OBJECT_STORE_PATH_PREFIX", "//tmp/override")
	t.Setenv("OBJECT_STORE_USE_SSL", "true")
	t.Setenv("OBJECT_STORE_FORCE_PATH_STYLE", "false")

	cfg, err := loadStorageConfigFromPath(path)
	if err != nil {
		t.Fatalf("loadStorageConfigFromPath returned error: %v", err)
	}
	if cfg.StorageServer.ObjectStore.Provider != "seaweedfs" {
		t.Fatalf("unexpected provider: %q", cfg.StorageServer.ObjectStore.Provider)
	}
	if cfg.StorageServer.ObjectStore.EndpointURL != "http://seaweedfs-s3:8333" {
		t.Fatalf("unexpected endpoint: %q", cfg.StorageServer.ObjectStore.EndpointURL)
	}
	if cfg.StorageServer.ObjectStore.AccessKey != "seaweedfs" {
		t.Fatalf("unexpected access key: %q", cfg.StorageServer.ObjectStore.AccessKey)
	}
	if cfg.StorageServer.ObjectStore.SecretKey != "seaweedfs-secret" {
		t.Fatalf("unexpected secret key: %q", cfg.StorageServer.ObjectStore.SecretKey)
	}
	if cfg.StorageServer.ObjectStore.AuthToken != "yt-oauth" {
		t.Fatalf("unexpected auth token: %q", cfg.StorageServer.ObjectStore.AuthToken)
	}
	if cfg.StorageServer.ObjectStore.Region != "local" {
		t.Fatalf("unexpected region: %q", cfg.StorageServer.ObjectStore.Region)
	}
	if cfg.StorageServer.ObjectStore.PathPrefix != "//tmp/override" {
		t.Fatalf("unexpected path prefix: %q", cfg.StorageServer.ObjectStore.PathPrefix)
	}
	if !cfg.StorageServer.ObjectStore.UseSSL {
		t.Fatalf("expected use_ssl=true")
	}
	if cfg.StorageServer.ObjectStore.ForcePathStyle {
		t.Fatalf("expected force_path_style=false")
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
