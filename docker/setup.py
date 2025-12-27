import os
import subprocess

if __name__ == "__main__":
    GCLOUD_PROJECT = os.getenv("GCLOUD_PROJECT")
    WAYMO_BUCKET = os.getenv("WAYMO_BUCKET")

    print("Project:", GCLOUD_PROJECT)

    os.system(f"gcloud config set project {GCLOUD_PROJECT}")
