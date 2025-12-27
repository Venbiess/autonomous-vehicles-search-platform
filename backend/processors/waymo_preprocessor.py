from .preprocessor import Preprocessor
from google.cloud import storage
from typing import List, Optional
import subprocess
import pandas as pd
import shutil
import os

from configs.common import WAYMO_DIR, DATA_DIR

BUCKET_NAME = "waymo_open_dataset_v_2_0_1"
PREFIX = "training/camera_image"
PROJECT_NAME = "avsp-479717"
REMOTE_PATH = f"gs://{BUCKET_NAME}/{PREFIX}/"

GOOGLE_CLOUD_GSUTIL_PATH = shutil.which("gsutil")
DATA_FOLDER = os.path.join(DATA_DIR, WAYMO_DIR)


class WaymoPreprocessor(Preprocessor):
    CAMERA_TO_LABEL = {
        "FRONT": 1,
        "FRONT_LEFT": 2,
        "FRONT_RIGHT": 3,
        "BACK_LEFT": 4,
        "BACK_RIGHT": 5
    }  # https://github.com/Jossome/Waymo-open-dataset-document
    REVERSE_CAMERA_TO_LABEL = {
        v: k for k, v in CAMERA_TO_LABEL.items()
    }

    COLUMNS_TO_SAVE = {
        "key.frame_timestamp_micros": "timestamp",
        "key.camera_name": "camera_name",
        "[CameraImageComponent].image": "image"
    }

    def __init__(self,
                 cameras: Optional[List[str]] = ["FRONT"],
                 resample_seconds: Optional[float] = 0.5,
                 exist_skip: bool = False
                ):
        super().__init__()
        self.client = storage.Client(project=PROJECT_NAME)
        self.bucket = self.client.bucket(BUCKET_NAME, user_project=PROJECT_NAME)
        self.blobs = self.bucket.list_blobs(prefix=PREFIX)
        self.episodes = [
            blob.name for blob in self.blobs if blob.name.endswith(".parquet")
        ]
        self.exist_skip = exist_skip

        if cameras:
            self.cameras = set([
                self.CAMERA_TO_LABEL[camera] for camera in cameras
            ])
        else:
            self.cameras = None
        self.resample_seconds = resample_seconds

        os.makedirs(DATA_FOLDER, exist_ok=True)

        # for iterable
        self.iteration = 0

    def download_blob(self, name: str, dst_path: str):
        if not os.path.exists(dst_path) or not self.exist_skip:
            cmd = [
                GOOGLE_CLOUD_GSUTIL_PATH,
                "cp",
                os.path.join(REMOTE_PATH, name),
                dst_path
            ]

            subprocess.run(cmd)

        # if not os.path.exists(dst_path):
        #     blob = self.bucket.blob(blob_name)
        #     try:
        #         blob.download_to_filename(dst_path)
        #     except Exception as e:
        #         print("DOWNLOAD FAILED")
        #         print("type:", type(e))
        #         print("error:", e)
        #         # если файл создался частично — уберём
        #         if os.path.exists(dst_path) and os.path.getsize(dst_path) == 0:
        #             os.remove(dst_path)
        #         raise

    def process_parquet(self, path):
        df = pd.read_parquet(path)

        if self.cameras:
            df = df[df['key.camera_name'].isin(self.cameras)]
            df['key.camera_name'] = df['key.camera_name'].map(self.REVERSE_CAMERA_TO_LABEL)

        if self.resample_seconds:
            df["ts"] = pd.to_datetime(df["key.frame_timestamp_micros"], unit="us", utc=True)
            df = df.sort_values("ts")

            df = (
                df
                .set_index("ts")
                .resample(f"{self.resample_seconds}s")
                .first()
                .reset_index()
                .dropna(subset=["ts"])
            )

        df = df[self.COLUMNS_TO_SAVE.keys()].rename(columns=self.COLUMNS_TO_SAVE)
        df.to_parquet(path, index=False)

    def process_sample(self, blob_name: str):
        name = os.path.basename(blob_name)
        dst_path = os.path.join(DATA_FOLDER, name)

        self.download_blob(name, dst_path)
        self.process_parquet(dst_path)

        return dst_path

    def __iter__(self):
        return self

    def __next__(self):
        if self.iteration >= len(self.episodes):
            raise StopIteration

        blob_name = self.episodes[self.iteration]
        self.iteration += 1
        return self.process_sample(blob_name)


if __name__ == "__main__":
    processor = WaymoPreprocessor(resample_seconds=0.5)

    for i, episode in enumerate(processor):
        if i >= 1:
            break
        print(i)
        print(episode)
