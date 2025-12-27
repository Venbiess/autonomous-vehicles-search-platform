# Available: FRONT, FRONT_LEFT, FRONT_RIGHT, BACK_LEFT, BACK_RIGHT
ARGOVERSE_CAMERAS = [
    "FRONT"
]

# Time step
ARGOVERSE_RESAMPLE_SECONDS = 0.5

# Available:
# Train - [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
# Val - [0, 2]
# Test - [0, 1, 2]
ARGOVERSE_DOWNLOAD_PARTS = {
    "train": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    "val": [0, 1, 2],
    "test": [0, 1, 2],
}

# Path inside DATA_DIR to data (DATA_DIR is initialized in common.py)
ARGOVERSE_DIR = "argoverse/"
