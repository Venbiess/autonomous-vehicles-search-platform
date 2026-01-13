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



