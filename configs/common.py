import os

from .argoverse import *
from .waymo import *
from .nuscenes import *

DATA_DIR = "/app/data"

# Available: WAYMO, ARGOVERSE
# Make sure that the appropriate configs are filled in.
DATASETS = ["WAYMO", "ARGOVERSE"]


def _env_first(primary: str, secondary: str, default: str) -> str:
    value = os.getenv(primary)
    if value:
        return value
    value = os.getenv(secondary)
    if value:
        return value
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
EMBEDDER_ENDPOINT = os.getenv("EMBEDDER_ENDPOINT", "http://embedder:8000")
EMBEDDER_TIMEOUT_SEC = int(os.getenv("EMBEDDER_TIMEOUT_SEC", "30"))
EMBEDDINGS_SCHEMA = os.getenv("EMBEDDINGS_SCHEMA", POSTGRES_SCHEMA)
EMBEDDINGS_TABLE = os.getenv("EMBEDDINGS_TABLE", "image_embeddings")

# Unified storage servers
OBJECT_SERVER_ENDPOINT = _env_first(
    "OBJECT_SERVER_ENDPOINT",
    "OBJECT_SERVICE_ENDPOINT",
    "http://object-server:9010",
)
OBJECT_SERVER_TIMEOUT_SEC = int(
    _env_first("OBJECT_SERVER_TIMEOUT_SEC", "OBJECT_SERVICE_TIMEOUT_SEC", "30")
)
VECTOR_SERVER_ENDPOINT = _env_first(
    "VECTOR_SERVER_ENDPOINT",
    "VECTOR_SERVICE_ENDPOINT",
    "http://vector-server:9011",
)
VECTOR_SERVER_TIMEOUT_SEC = int(
    _env_first("VECTOR_SERVER_TIMEOUT_SEC", "VECTOR_SERVICE_TIMEOUT_SEC", "30")
)

# VLM configuration
VLM_ENDPOINT = os.getenv("VLM_ENDPOINT", "http://vlm:8001")
VLM_TIMEOUT_SEC = int(os.getenv("VLM_TIMEOUT_SEC", "120"))

# Analytics server configuration
ANALYTICS_SERVER_ENDPOINT = _env_first(
    "ANALYTICS_SERVER_ENDPOINT",
    "ANALYTICS_SERVICE_ENDPOINT",
    "http://analytics-server:9012",
)
ANALYTICS_SERVER_TIMEOUT_SEC = int(
    _env_first("ANALYTICS_SERVER_TIMEOUT_SEC", "ANALYTICS_SERVICE_TIMEOUT_SEC", "30")
)

# Backward-compatible aliases for legacy imports.
OBJECT_SERVICE_ENDPOINT = OBJECT_SERVER_ENDPOINT
OBJECT_SERVICE_TIMEOUT_SEC = OBJECT_SERVER_TIMEOUT_SEC
VECTOR_SERVICE_ENDPOINT = VECTOR_SERVER_ENDPOINT
VECTOR_SERVICE_TIMEOUT_SEC = VECTOR_SERVER_TIMEOUT_SEC
ANALYTICS_SERVICE_ENDPOINT = ANALYTICS_SERVER_ENDPOINT
ANALYTICS_SERVICE_TIMEOUT_SEC = ANALYTICS_SERVER_TIMEOUT_SEC
