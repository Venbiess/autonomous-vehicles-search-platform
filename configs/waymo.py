# gcloud project
PROJECT_NAME="avsp"
GCLOUD_PROJECT="avsp-479717"
ENVIRONMENT="dev"

# Available: FRONT, FRONT_LEFT, FRONT_RIGHT, BACK_LEFT, BACK_RIGHT
WAYMO_CAMERAS = [
    "FRONT"
]

# Time step
WAYMO_RESAMPLE_SECONDS = 0.1

# Path inside DATA_DIR to data (DATA_DIR is initialized in common.py)
WAYMO_DIR = "waymo/"
