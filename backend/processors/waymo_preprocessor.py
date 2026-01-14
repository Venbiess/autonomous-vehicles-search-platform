from .preprocessor import Preprocessor
from google.cloud import storage
from typing import List, Optional
from pathlib import Path
import subprocess
import pandas as pd
import shutil
import os

from configs.common import WAYMO_DIR, DATA_DIR

BUCKET_NAME = "waymo_open_dataset_v_2_0_1"
PREFIX = "training/camera_image"
PROJECT_NAME = "avsp-479717"
REMOTE_PATH = f"gs://{BUCKET_NAME}/{PREFIX}/"
SOURCE_URL = f"https://storage.googleapis.com/{BUCKET_NAME}/{PREFIX}/"

GOOGLE_CLOUD_GSUTIL_PATH = shutil.which("gsutil")
DATA_FOLDER = Path(DATA_DIR) / WAYMO_DIR


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
        self.rides = [
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
        #         if os.path.exists(dst_path) and os.path.getsize(dst_path) == 0:
        #             os.remove(dst_path)
        #         raise

    def process_parquet(self, path: Path) -> pd.DataFrame:
        df = pd.read_parquet(path)

        if self.cameras:
            df = df[df["key.camera_name"].isin(self.cameras)]
            df["key.camera_name"] = df["key.camera_name"].map(self.REVERSE_CAMERA_TO_LABEL)

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

        ride_id = path.stem
        df = self._save_images_and_replace_column(df, ride_id)
        df["source_ride_id"] = ride_id
        df["source_link"] = SOURCE_URL + ride_id + ".parquet"
        return df

    def _save_images_and_replace_column(
        self,
        df: pd.DataFrame,
        ride_id: str,
    ) -> pd.DataFrame:
        image_paths: List[str] = []

        for row in df.itertuples(index=False):
            ts = getattr(row, "timestamp")
            cam = getattr(row, "camera_name")
            img = getattr(row, "image")

            ts_str = str(int(ts))

            file_path = DATA_FOLDER / f"{cam}_{ts_str}_{ride_id}.jpg"

            if img is None or (hasattr(pd, "isna") and pd.isna(img)):
                image_paths.append(None)
                continue

            if isinstance(img, memoryview):
                img_bytes = img.tobytes()
            else:
                img_bytes = img if isinstance(img, (bytes, bytearray)) else bytes(img)

            with open(file_path, "wb") as f:
                f.write(img_bytes)

            image_paths.append(str(file_path))

        df = df.drop(columns=["image"])
        df["local_path"] = image_paths
        return df

    def process_sample(self, blob_name: str) -> pd.DataFrame:
        name = os.path.basename(blob_name)
        dst_path = DATA_FOLDER / name

        self.download_blob(name, dst_path)
        result_df = self.process_parquet(dst_path)

        return result_df

    def __iter__(self):
        return self

    def __next__(self):
        if self.iteration >= len(self.rides):
            raise StopIteration

        blob_name = self.rides[self.iteration]
        self.iteration += 1
        return self.process_sample(blob_name)

    def __len__(self):
        return len(self.rides)


if __name__ == "__main__":
    processor = WaymoPreprocessor(resample_seconds=0.5, exist_skip=True)
    # processor.clear_bucket(bucket="waymo")

    # for i, ride in enumerate(processor):
    #     print(i)
    #     print(ride)
    #     if i >= 1000:
    #         break

    processor.download_to_s3(bucket="waymo", total_rides=1)
