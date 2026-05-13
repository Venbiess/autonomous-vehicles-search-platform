package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	infra "github.com/Venbiess/autonomous-vehicles-search-platform/storage/infra"
	"gopkg.in/yaml.v3"
)

const defaultStorageConfigPath = "./config/storage.yaml"

type StorageConfig struct {
	StorageServer StorageServerConfig `yaml:"storage_server"`
}

type StorageServerConfig struct {
	ServerName                string                  `yaml:"server_name"`
	Addr                      string                  `yaml:"addr"`
	WriteToken                string                  `yaml:"write_token"`
	DefaultBucket             string                  `yaml:"default_bucket"`
	PreprocessorsManifestPath string                  `yaml:"preprocessors_manifest_path"`
	ObjectCache               ObjectCacheConfig       `yaml:"object_cache"`
	MetadataDB                StorageMetadataDBConfig `yaml:"metadata_db"`
	AnalyticsDB               AnalyticsDBConfig       `yaml:"analytics_db"`
	ObjectStore               infra.ObjectStoreConfig `yaml:"object_store"`
	VectorIndex               infra.VectorIndexConfig `yaml:"vector_index"`
}

type StorageMetadataDBConfig struct {
	DSN    string `yaml:"dsn"`
	Schema string `yaml:"schema"`
	Table  string `yaml:"table"`
}

type AnalyticsDBConfig struct {
	Provider             string `yaml:"provider"`
	DSN                  string `yaml:"dsn"`
	FieldCatalogTable    string `yaml:"field_catalog_table"`
	AnnotationStoreTable string `yaml:"annotation_store_table"`
}

type ObjectCacheConfig struct {
	Enabled            bool  `yaml:"enabled"`
	MaxItems           int   `yaml:"max_items"`
	MaxTotalBytes      int64 `yaml:"max_total_bytes"`
	MaxObjectSizeBytes int64 `yaml:"max_object_size_bytes"`
	TTLSeconds         int   `yaml:"ttl_seconds"`
}

type PreprocessorCatalog struct {
	Preprocessors []PreprocessorMethodConfig `yaml:"preprocessors"`
}

type PreprocessorMethodConfig struct {
	Key           string         `yaml:"key" json:"key"`
	Label         string         `yaml:"label" json:"label"`
	Description   string         `yaml:"description" json:"description,omitempty"`
	Runner        RunnerConfig   `yaml:"runner" json:"runner"`
	DefaultConfig map[string]any `yaml:"default_config" json:"default_config,omitempty"`
}

type RunnerConfig struct {
	Entrypoint string `yaml:"entrypoint" json:"entrypoint"`
	Module     string `yaml:"module" json:"module,omitempty"`
}

func LoadStorageServerConfig() (StorageServerConfig, error) {
	return LoadStorageServerConfigFromPath("")
}

func LoadStorageServerConfigFromPath(path string) (StorageServerConfig, error) {
	if strings.TrimSpace(path) == "" {
		path = configPath()
	}
	cfg, err := loadStorageConfigFromPath(path)
	if err != nil {
		return StorageServerConfig{}, err
	}
	return cfg.StorageServer, nil
}

func configPath() string {
	if path := strings.TrimSpace(os.Getenv("STORAGE_CONFIG_PATH")); path != "" {
		return path
	}
	return defaultStorageConfigPath
}

func loadStorageConfigFromPath(path string) (StorageConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return StorageConfig{}, fmt.Errorf("read storage config: %w", err)
	}

	var cfg StorageConfig
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return StorageConfig{}, fmt.Errorf("parse storage config yaml: %w", err)
	}
	applyEnvOverrides(&cfg)
	return cfg, nil
}

func applyEnvOverrides(cfg *StorageConfig) {
	if cfg == nil {
		return
	}
	overrideString(&cfg.StorageServer.ObjectStore.Provider, "OBJECT_STORE_PROVIDER")
	overrideString(&cfg.StorageServer.ObjectStore.EndpointURL, "OBJECT_STORE_ENDPOINT_URL")
	overrideString(&cfg.StorageServer.ObjectStore.AccessKey, "OBJECT_STORE_ACCESS_KEY")
	overrideString(&cfg.StorageServer.ObjectStore.SecretKey, "OBJECT_STORE_SECRET_KEY")
	overrideString(&cfg.StorageServer.ObjectStore.SessionToken, "OBJECT_STORE_SESSION_TOKEN")
	overrideString(&cfg.StorageServer.ObjectStore.AuthToken, "OBJECT_STORE_AUTH_TOKEN")
	overrideString(&cfg.StorageServer.ObjectStore.Region, "OBJECT_STORE_REGION")
	overrideString(&cfg.StorageServer.ObjectStore.PathPrefix, "OBJECT_STORE_PATH_PREFIX")
	overrideBool(&cfg.StorageServer.ObjectStore.UseSSL, "OBJECT_STORE_USE_SSL")
	overrideBool(&cfg.StorageServer.ObjectStore.ForcePathStyle, "OBJECT_STORE_FORCE_PATH_STYLE")
}

func overrideString(dst *string, envKey string) {
	if dst == nil {
		return
	}
	if val := strings.TrimSpace(os.Getenv(envKey)); val != "" {
		*dst = val
	}
}

func overrideBool(dst *bool, envKey string) {
	if dst == nil {
		return
	}
	raw := strings.TrimSpace(os.Getenv(envKey))
	if raw == "" {
		return
	}
	parsed, err := strconv.ParseBool(raw)
	if err != nil {
		return
	}
	*dst = parsed
}

func LoadPreprocessorCatalog(path string) (PreprocessorCatalog, error) {
	raw, err := os.ReadFile(strings.TrimSpace(path))
	if err != nil {
		return PreprocessorCatalog{}, fmt.Errorf("read preprocessors catalog: %w", err)
	}

	var cfg PreprocessorCatalog
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return PreprocessorCatalog{}, fmt.Errorf("parse preprocessors yaml: %w", err)
	}
	return cfg, nil
}
