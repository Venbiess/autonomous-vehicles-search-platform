package config

import (
	"fmt"
	"os"
	"strings"

	infra "avsp/storage/infra"
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
	cfg, err := loadStorageConfigFromPath(configPath())
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
	return cfg, nil
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
