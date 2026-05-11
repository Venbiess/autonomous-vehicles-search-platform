import os

from .argoverse import *
from .once import *
from .waymo import *
from .nuscenes import *

DATA_DIR = "/app/data"

# Available: WAYMO, ARGOVERSE, ONCE
# Make sure that the appropriate configs are filled in.
DATASETS = ["WAYMO", "ARGOVERSE", "ONCE"]


def _env_first(primary: str, secondary: str, default: str) -> str:
    value = os.getenv(primary)
    if value:
        return value
    value = os.getenv(secondary)
    if value:
        return value
    return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = str(raw).strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(str(raw).strip())
    except ValueError:
        return default

# S3 configuration
S3_ENDPOINT_URL = os.getenv("S3_ENDPOINT_URL", "http://minio:9000")
S3_ACCESS_KEY_ID = os.getenv("S3_ACCESS_KEY_ID", "minioadmin")
S3_SECRET_ACCESS_KEY = os.getenv("S3_SECRET_ACCESS_KEY", "minioadmin")

# Postgres configuration
POSTGRES_HOST = os.getenv("POSTGRES_HOST", "0.0.0.0")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "5432"))
POSTGRES_DB = os.getenv("POSTGRES_DB", "avsp")
POSTGRES_USER = os.getenv("POSTGRES_USER", "postgres")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "postgres")
POSTGRES_SCHEMA = os.getenv("POSTGRES_SCHEMA", "public")
POSTGRES_TABLE = os.getenv("POSTGRES_TABLE", "frames")

# Embeddings configuration
EMBEDDER_ENDPOINT = os.getenv("EMBEDDER_ENDPOINT", "http://embedder-worker:8000")
EMBEDDER_TIMEOUT_SEC = int(os.getenv("EMBEDDER_TIMEOUT_SEC", "30"))
EMBEDDINGS_SCHEMA = os.getenv("EMBEDDINGS_SCHEMA", POSTGRES_SCHEMA)
EMBEDDINGS_TABLE = os.getenv("EMBEDDINGS_TABLE", "image_embeddings")

# Unified storage server
STORAGE_SERVER_ENDPOINT = _env_first(
    "STORAGE_SERVER_ENDPOINT",
    "STORAGE_SERVICE_ENDPOINT",
    "http://storage-server:9012",
)
STORAGE_SERVER_TIMEOUT_SEC = int(
    _env_first("STORAGE_SERVER_TIMEOUT_SEC", "STORAGE_SERVICE_TIMEOUT_SEC", "30")
)
STORAGE_WRITE_TOKEN = os.getenv("STORAGE_WRITE_TOKEN", "change-me-storage-write-token")

# VLM configuration
VLM_ENDPOINT = _env_first(
    "VLM_ENDPOINT",
    "VLM_SERVICE_ENDPOINT",
    "http://vlm-worker:8001",
)
VLM_TIMEOUT_SEC = int(os.getenv("VLM_TIMEOUT_SEC", "120"))
VLM_RETRY_EMPTY_VALUES = _env_bool("VLM_RETRY_EMPTY_VALUES", True)
# 0 means "use current job batch_size as field chunk size"
VLM_BACKFILL_FIELD_CHUNK_SIZE = max(0, _env_int("VLM_BACKFILL_FIELD_CHUNK_SIZE", 0))
VLM_DEBUG_EMPTY_OUTPUT = _env_bool("VLM_DEBUG_EMPTY_OUTPUT", False)

# Model dependency readiness checks used by master before model-dependent operations.
MODEL_BACKEND_READY_WAIT_SEC = max(0.0, _env_float("MODEL_BACKEND_READY_WAIT_SEC", 45.0))
MODEL_BACKEND_READY_POLL_SEC = max(0.1, _env_float("MODEL_BACKEND_READY_POLL_SEC", 1.0))

# Analytics server configuration
ANALYTICS_SERVER_ENDPOINT = _env_first(
    "ANALYTICS_SERVER_ENDPOINT",
    "ANALYTICS_SERVICE_ENDPOINT",
    "http://storage-server:9012",
)
ANALYTICS_SERVER_TIMEOUT_SEC = int(
    _env_first("ANALYTICS_SERVER_TIMEOUT_SEC", "ANALYTICS_SERVICE_TIMEOUT_SEC", "30")
)

# Backward-compatible aliases for existing imports in backend.
OBJECT_SERVER_ENDPOINT = STORAGE_SERVER_ENDPOINT
OBJECT_SERVER_TIMEOUT_SEC = STORAGE_SERVER_TIMEOUT_SEC
VECTOR_SERVER_ENDPOINT = STORAGE_SERVER_ENDPOINT
VECTOR_SERVER_TIMEOUT_SEC = STORAGE_SERVER_TIMEOUT_SEC
OBJECT_SERVICE_ENDPOINT = STORAGE_SERVER_ENDPOINT
OBJECT_SERVICE_TIMEOUT_SEC = STORAGE_SERVER_TIMEOUT_SEC
VECTOR_SERVICE_ENDPOINT = STORAGE_SERVER_ENDPOINT
VECTOR_SERVICE_TIMEOUT_SEC = STORAGE_SERVER_TIMEOUT_SEC
ANALYTICS_SERVICE_ENDPOINT = ANALYTICS_SERVER_ENDPOINT
ANALYTICS_SERVICE_TIMEOUT_SEC = ANALYTICS_SERVER_TIMEOUT_SEC
