from .argoverse import *
from .waymo import *
from .nuscenes import *

# Data dir inside app
DATA_DIR = "/data"

# Available: WAYMO, ARGOVERSE
# Make sure that the appropriate configs are filled in.
DATASETS = ["WAYMO", "ARGOVERSE"]
