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
	ObjectServer      ObjectServerConfig      `yaml:"object_server"`
	VectorServer      VectorServerConfig      `yaml:"vector_server"`
	CoordinatorServer CoordinatorServerConfig `yaml:"coordinator_server"`
}

type ObjectServerConfig struct {
	ServerName    string                    `yaml:"server_name"`
	Addr          string                    `yaml:"addr"`
	KVPath        string                    `yaml:"kv_path"`
	DefaultBucket string                    `yaml:"default_bucket"`
	WriteToken    string                    `yaml:"write_token"`
	ObjectCache   ObjectCacheConfig         `yaml:"object_cache"`
	ObjectStore   infra.ObjectStoreConfig   `yaml:"object_store"`
	ObjectStores  []infra.ObjectStoreConfig `yaml:"object_stores"`
}

type ObjectCacheConfig struct {
	Enabled            bool  `yaml:"enabled"`
	MaxItems           int   `yaml:"max_items"`
	MaxTotalBytes      int64 `yaml:"max_total_bytes"`
	MaxObjectSizeBytes int64 `yaml:"max_object_size_bytes"`
	TTLSeconds         int   `yaml:"ttl_seconds"`
}

type VectorServerConfig struct {
	ServerName    string                    `yaml:"server_name"`
	Addr          string                    `yaml:"addr"`
	WriteToken    string                    `yaml:"write_token"`
	VectorIndex   infra.VectorIndexConfig   `yaml:"vector_index"`
	VectorIndexes []infra.VectorIndexConfig `yaml:"vector_indexes"`
}

type CoordinatorServerConfig struct {
	ServerName string                     `yaml:"server_name"`
	Addr       string                     `yaml:"addr"`
	NodeID     string                     `yaml:"node_id"`
	Backend    CoordinatorBackendConfig   `yaml:"backend"`
	DataPlane  CoordinatorDataPlaneConfig `yaml:"data_plane"`
}

type CoordinatorBackendConfig struct {
	Provider                 string   `yaml:"provider"`
	Endpoints                []string `yaml:"endpoints"`
	Prefix                   string   `yaml:"prefix"`
	LeaseTTLSeconds          int      `yaml:"lease_ttl_seconds"`
	OperationTTLSeconds      int      `yaml:"operation_ttl_seconds"`
	ReconcileIntervalSeconds int      `yaml:"reconcile_interval_seconds"`
	ReconcileBatchLimit      int      `yaml:"reconcile_batch_limit"`
}

type CoordinatorDataPlaneConfig struct {
	ObjectEndpoint string `yaml:"object_endpoint"`
	VectorEndpoint string `yaml:"vector_endpoint"`
	WriteToken     string `yaml:"write_token"`
	TimeoutSeconds int    `yaml:"timeout_seconds"`
}

func LoadObjectServerConfig() (ObjectServerConfig, error) {
	cfg, err := loadStorageConfigFromPath(configPath())
	if err != nil {
		return ObjectServerConfig{}, err
	}
	return cfg.ObjectServer, nil
}

func LoadVectorServerConfig() (VectorServerConfig, error) {
	cfg, err := loadStorageConfigFromPath(configPath())
	if err != nil {
		return VectorServerConfig{}, err
	}
	return cfg.VectorServer, nil
}

func LoadCoordinatorServerConfig() (CoordinatorServerConfig, error) {
	cfg, err := loadStorageConfigFromPath(configPath())
	if err != nil {
		return CoordinatorServerConfig{}, err
	}
	return cfg.CoordinatorServer, nil
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
