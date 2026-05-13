package images

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type CoordinatorConfig struct {
	ListenAddr         string        `yaml:"listen_addr"`
	PublicURL          string        `yaml:"public_url"`
	DBPath             string        `yaml:"db_path"`
	PackSizeBytes      int64         `yaml:"pack_size_bytes"`
	ReplicaCount       int           `yaml:"replica_count"`
	WriteQuorum        int           `yaml:"write_quorum"`
	HTTPTimeout        time.Duration `yaml:"http_timeout"`
	MaxUploadBytes     int64         `yaml:"max_upload_bytes"`
	ObjectCacheEntries int           `yaml:"object_cache_entries"`
	UploadTokenSecret  string        `yaml:"upload_token_secret"`
}

type VolumeConfig struct {
	ServerID          string        `yaml:"server_id"`
	ListenAddr        string        `yaml:"listen_addr"`
	PublicURL         string        `yaml:"public_url"`
	InternalURL       string        `yaml:"internal_url"`
	CoordinatorURL    string        `yaml:"coordinator_url"`
	DataDir           string        `yaml:"data_dir"`
	MaxPackBytes      int64         `yaml:"max_pack_bytes"`
	MaxUploadBytes    int64         `yaml:"max_upload_bytes"`
	SnapshotInterval  time.Duration `yaml:"snapshot_interval"`
	HeartbeatInterval time.Duration `yaml:"heartbeat_interval"`
	HTTPTimeout       time.Duration `yaml:"http_timeout"`
	UploadTokenSecret string        `yaml:"upload_token_secret"`
	CompactOnStart    bool          `yaml:"compact_on_start"`
}

func defaultCoordinatorConfig() CoordinatorConfig {
	return CoordinatorConfig{
		ListenAddr:         "0.0.0.0:9000",
		PublicURL:          "http://127.0.0.1:9000",
		DBPath:             "data/coordinator/badger",
		PackSizeBytes:      32 << 30,
		ReplicaCount:       3,
		WriteQuorum:        3,
		HTTPTimeout:        10 * time.Second,
		MaxUploadBytes:     64 << 20,
		ObjectCacheEntries: 10000,
		UploadTokenSecret:  "dev-upload-token-secret",
	}
}

func defaultVolumeConfig() VolumeConfig {
	return VolumeConfig{
		ServerID:          "storage-a",
		ListenAddr:        "0.0.0.0:9002",
		PublicURL:         "http://127.0.0.1:9002",
		InternalURL:       "http://127.0.0.1:9002",
		CoordinatorURL:    "http://127.0.0.1:9000",
		DataDir:           "data/storage",
		MaxPackBytes:      32 << 30,
		MaxUploadBytes:    64 << 20,
		SnapshotInterval:  5 * time.Second,
		HeartbeatInterval: 2 * time.Second,
		HTTPTimeout:       5 * time.Second,
		UploadTokenSecret: "dev-upload-token-secret",
		CompactOnStart:    false,
	}
}

func LoadCoordinatorConfig() (CoordinatorConfig, error) {
	cfg := defaultCoordinatorConfig()
	path, err := requiredEnv("COORDINATOR_CONFIG_PATH")
	if err != nil {
		return CoordinatorConfig{}, err
	}
	if err := LoadYAMLConfig(path, &cfg); err != nil {
		return CoordinatorConfig{}, err
	}
	applyCoordinatorEnvOverrides(&cfg)
	return cfg, nil
}

func LoadVolumeConfig() (VolumeConfig, error) {
	cfg := defaultVolumeConfig()
	path, err := requiredEnv("VOLUME_CONFIG_PATH")
	if err != nil {
		return VolumeConfig{}, err
	}
	if err := LoadYAMLConfig(path, &cfg); err != nil {
		return VolumeConfig{}, err
	}
	applyVolumeEnvOverrides(&cfg)
	return cfg, nil
}

func requiredEnv(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func LoadYAMLConfig(path string, dst any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := yaml.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("parse yaml %s: %w", filepath.Clean(path), err)
	}
	return nil
}

func applyCoordinatorEnvOverrides(cfg *CoordinatorConfig) {
	applyStringEnv("COORDINATOR_LISTEN_ADDR", &cfg.ListenAddr)
	applyStringEnv("COORDINATOR_PUBLIC_URL", &cfg.PublicURL)
	applyStringEnv("COORDINATOR_DB_PATH", &cfg.DBPath)
	applyInt64Env("COORDINATOR_PACK_SIZE_BYTES", &cfg.PackSizeBytes)
	applyIntEnv("COORDINATOR_REPLICA_COUNT", &cfg.ReplicaCount)
	applyIntEnv("COORDINATOR_WRITE_QUORUM", &cfg.WriteQuorum)
	applyDurationEnv("COORDINATOR_HTTP_TIMEOUT", &cfg.HTTPTimeout)
	applyInt64Env("COORDINATOR_MAX_UPLOAD_BYTES", &cfg.MaxUploadBytes)
	applyIntEnv("COORDINATOR_OBJECT_CACHE_ENTRIES", &cfg.ObjectCacheEntries)
	applyStringEnv("COORDINATOR_UPLOAD_TOKEN_SECRET", &cfg.UploadTokenSecret)
	if cfg.ReplicaCount <= 0 {
		cfg.ReplicaCount = 1
	}
	if cfg.WriteQuorum <= 0 {
		cfg.WriteQuorum = cfg.ReplicaCount
	}
	if cfg.WriteQuorum > cfg.ReplicaCount {
		cfg.WriteQuorum = cfg.ReplicaCount
	}
}

func applyVolumeEnvOverrides(cfg *VolumeConfig) {
	applyStringEnv("VOLUME_SERVER_ID", &cfg.ServerID)
	applyStringEnv("VOLUME_LISTEN_ADDR", &cfg.ListenAddr)
	applyStringEnv("VOLUME_PUBLIC_URL", &cfg.PublicURL)
	applyStringEnv("VOLUME_INTERNAL_URL", &cfg.InternalURL)
	applyStringEnv("VOLUME_COORDINATOR_URL", &cfg.CoordinatorURL)
	applyStringEnv("VOLUME_DATA_DIR", &cfg.DataDir)
	applyInt64Env("VOLUME_MAX_PACK_BYTES", &cfg.MaxPackBytes)
	applyInt64Env("VOLUME_MAX_UPLOAD_BYTES", &cfg.MaxUploadBytes)
	applyDurationEnv("VOLUME_SNAPSHOT_INTERVAL", &cfg.SnapshotInterval)
	applyDurationEnv("VOLUME_HEARTBEAT_INTERVAL", &cfg.HeartbeatInterval)
	applyDurationEnv("VOLUME_HTTP_TIMEOUT", &cfg.HTTPTimeout)
	applyStringEnv("VOLUME_UPLOAD_TOKEN_SECRET", &cfg.UploadTokenSecret)
	applyBoolEnv("VOLUME_COMPACT_ON_START", &cfg.CompactOnStart)
}

func applyStringEnv(name string, dst *string) {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		*dst = value
	}
}

func applyIntEnv(name string, dst *int) {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			*dst = parsed
		}
	}
}

func applyInt64Env(name string, dst *int64) {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
			*dst = parsed
		}
	}
}

func applyDurationEnv(name string, dst *time.Duration) {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil {
			*dst = parsed
		}
	}
}

func applyBoolEnv(name string, dst *bool) {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		if parsed, err := strconv.ParseBool(value); err == nil {
			*dst = parsed
		}
	}
}
