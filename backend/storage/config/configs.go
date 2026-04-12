package config

import (
	"errors"
	"fmt"
	"os"
	"strings"

	infra "avsp/storage/infra"
	"gopkg.in/yaml.v3"
)

const defaultStorageConfigPath = "./config/storage.yaml"

type StorageConfig struct {
	ObjectServer    ObjectServerConfig    `yaml:"object_server"`
	VectorServer    VectorServerConfig    `yaml:"vector_server"`
	AnalyticsServer AnalyticsServerConfig `yaml:"analytics_server"`
}

type ObjectServerConfig struct {
	ServerName    string                  `yaml:"server_name"`
	Addr          string                  `yaml:"addr"`
	KVPath        string                  `yaml:"kv_path"`
	DefaultBucket string                  `yaml:"default_bucket"`
	ObjectStore   infra.ObjectStoreConfig `yaml:"object_store"`
}

type VectorServerConfig struct {
	ServerName  string                  `yaml:"server_name"`
	Addr        string                  `yaml:"addr"`
	VectorIndex infra.VectorIndexConfig `yaml:"vector_index"`
}

type AnalyticsServerConfig struct {
	ServerName  string                  `yaml:"server_name"`
	Addr        string                  `yaml:"addr"`
	AnalyticsDB infra.AnalyticsDBConfig `yaml:"analytics_db"`
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

func LoadAnalyticsServerConfig() (AnalyticsServerConfig, error) {
	cfg, err := loadStorageConfigFromPath(configPath())
	if err != nil {
		return AnalyticsServerConfig{}, err
	}
	return cfg.AnalyticsServer, nil
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
	if err := validateStorageConfig(cfg); err != nil {
		return StorageConfig{}, err
	}
	return cfg, nil
}

func validateStorageConfig(cfg StorageConfig) error {
	if strings.TrimSpace(cfg.ObjectServer.Addr) == "" {
		return errors.New("object_server.addr is required")
	}
	if strings.TrimSpace(cfg.ObjectServer.KVPath) == "" {
		return errors.New("object_server.kv_path is required")
	}
	if strings.TrimSpace(cfg.ObjectServer.DefaultBucket) == "" {
		return errors.New("object_server.default_bucket is required")
	}
	if strings.TrimSpace(cfg.ObjectServer.ObjectStore.Provider) == "" {
		return errors.New("object_server.object_store.provider is required")
	}
	if strings.TrimSpace(cfg.ObjectServer.ObjectStore.EndpointURL) == "" {
		return errors.New("object_server.object_store.endpoint_url is required")
	}

	if strings.TrimSpace(cfg.VectorServer.Addr) == "" {
		return errors.New("vector_server.addr is required")
	}
	if strings.TrimSpace(cfg.VectorServer.VectorIndex.Provider) == "" {
		return errors.New("vector_server.vector_index.provider is required")
	}
	if strings.TrimSpace(cfg.VectorServer.VectorIndex.ConnStr) == "" {
		return errors.New("vector_server.vector_index.conn_str is required")
	}
	if strings.TrimSpace(cfg.VectorServer.VectorIndex.Schema) == "" {
		return errors.New("vector_server.vector_index.schema is required")
	}
	if strings.TrimSpace(cfg.VectorServer.VectorIndex.Table) == "" {
		return errors.New("vector_server.vector_index.table is required")
	}

	if strings.TrimSpace(cfg.AnalyticsServer.Addr) == "" {
		return errors.New("analytics_server.addr is required")
	}
	if strings.TrimSpace(cfg.AnalyticsServer.AnalyticsDB.Provider) == "" {
		return errors.New("analytics_server.analytics_db.provider is required")
	}
	if strings.TrimSpace(cfg.AnalyticsServer.AnalyticsDB.DSN) == "" {
		return errors.New("analytics_server.analytics_db.dsn is required")
	}
	if strings.TrimSpace(cfg.AnalyticsServer.AnalyticsDB.FieldCatalogTable) == "" {
		return errors.New("analytics_server.analytics_db.field_catalog_table is required")
	}
	if strings.TrimSpace(cfg.AnalyticsServer.AnalyticsDB.AnnotationStoreTable) == "" {
		return errors.New("analytics_server.analytics_db.annotation_store_table is required")
	}
	return nil
}
