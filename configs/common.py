import os

from .argoverse import *
from .waymo import *
from .nuscenes import *

DATA_DIR = "/app/data"

# Available: WAYMO, ARGOVERSE
# Make sure that the appropriate configs are filled in.
DATASETS = ["WAYMO", "ARGOVERSE"]

# S3 configuration
S3_ENDPOINT_URL="http://minio:9000"
S3_ACCESS_KEY_ID="minioadmin"
S3_SECRET_ACCESS_KEY="minioadmin"

# Postgres configuration
POSTGRES_HOST = os.getenv("POSTGRES_HOST", "0.0.0.0")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "7000"))
POSTGRES_DB = os.getenv("POSTGRES_DB", "avsp")
POSTGRES_USER = os.getenv("POSTGRES_USER", "postgres")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "postgres")
POSTGRES_SCHEMA = os.getenv("POSTGRES_SCHEMA", "public")
POSTGRES_TABLE = os.getenv("POSTGRES_TABLE", "frames")


