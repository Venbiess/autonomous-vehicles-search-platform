from .preprocessor import Preprocessor
from google.cloud import storage
from typing import Any, Callable, Dict, List, Optional
from pathlib import Path
import pandas as pd
import os

from configs.common import WAYMO_DIR, DATA_DIR

BUCKET_NAME = "waymo_open_dataset_v_2_0_1"
PREFIX = "training/camera_image"
PROJECT_NAME = "avsp-479717"
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
        self.bucket = self.client.bucket(BUCKET_NAME)
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
        self.download_progress_callback: Optional[
            Callable[[Dict[str, Any]], None]
        ] = None

    def _report_progress(
        self,
        file_index: int,
        total_files: int,
        file_name: str,
        downloaded_bytes: int,
        total_bytes: int,
        done: bool = False,
    ) -> None:
        if not self.download_progress_callback:
            return
        self.download_progress_callback(
            {
                "file_index": file_index,
                "total_files": total_files,
                "file_name": file_name,
                "downloaded_bytes": int(downloaded_bytes),
                "total_bytes": int(total_bytes),
                "done": bool(done),
            }
        )

    def download_blob(self, name: str, dst_path: str, file_index: int):
        total_files = max(len(self.episodes), 1)
        if not os.path.exists(dst_path) or not self.exist_skip:
            blob_name = f"{PREFIX}/{name}"
            blob = self.bucket.blob(blob_name)
            blob.reload()
            total_bytes = int(blob.size or 0)
            self._report_progress(
                file_index=file_index,
                total_files=total_files,
                file_name=name,
                downloaded_bytes=0,
                total_bytes=total_bytes,
                done=False,
            )

            downloaded_bytes = 0
            chunk_size = 8 * 1024 * 1024
            with open(dst_path, "wb") as f:
                if total_bytes <= 0:
                    blob.download_to_file(f)
                    downloaded_bytes = int(os.path.getsize(dst_path))
                    total_bytes = max(total_bytes, downloaded_bytes)
                    self._report_progress(
                        file_index=file_index,
                        total_files=total_files,
                        file_name=name,
                        downloaded_bytes=downloaded_bytes,
                        total_bytes=total_bytes,
                        done=True,
                    )
                else:
                    start = 0
                    while start < total_bytes:
                        end = min(start + chunk_size - 1, total_bytes - 1)
                        payload = blob.download_as_bytes(start=start, end=end)
                        f.write(payload)
                        downloaded_bytes = end + 1
                        self._report_progress(
                            file_index=file_index,
                            total_files=total_files,
                            file_name=name,
                            downloaded_bytes=downloaded_bytes,
                            total_bytes=total_bytes,
                            done=downloaded_bytes >= total_bytes,
                        )
                        start = end + 1
        else:
            file_size = int(os.path.getsize(dst_path))
            self._report_progress(
                file_index=file_index,
                total_files=total_files,
                file_name=name,
                downloaded_bytes=file_size,
                total_bytes=file_size,
                done=True,
            )

    def process_parquet(self, path: str) -> pd.DataFrame:
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

        episode_name = os.path.basename(path)
        df = df[self.COLUMNS_TO_SAVE.keys()].rename(columns=self.COLUMNS_TO_SAVE)
        df = self._save_images_and_replace_column(df, episode_name)
        return df

    def _save_images_and_replace_column(
        self,
        df: pd.DataFrame,
        episode_name: str,
    ) -> pd.DataFrame:
        episode_id = Path(episode_name).stem

        image_paths: List[str] = []

        for row in df.itertuples(index=False):
            ts = getattr(row, "timestamp")
            cam = getattr(row, "camera_name")
            img = getattr(row, "image")

            ts_str = str(int(ts))

            file_path = DATA_FOLDER / f"{cam}_{ts_str}.jpg"
            if file_path.exists():
                i = 1
                while (DATA_FOLDER / f"{ts_str}_{i}.jpg").exists():
                    i += 1
                file_path = DATA_FOLDER / f"{ts_str}_{i}.jpg"

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
        df["image_path"] = image_paths
        return df

    def process_sample(self, blob_name: str, file_index: int) -> pd.DataFrame:
        name = os.path.basename(blob_name)
        dst_path = DATA_FOLDER / name

        self.download_blob(name, dst_path, file_index=file_index)
        result_df = self.process_parquet(dst_path)
        if self.remove_local_images:
            os.remove(dst_path)

        return result_df

    def __iter__(self):
        return self

    def __next__(self):
        if self.iteration >= len(self.episodes):
            raise StopIteration

        file_index = self.iteration + 1
        blob_name = self.episodes[self.iteration]
        self.iteration += 1
        return self.process_sample(blob_name, file_index=file_index)

    def __len__(self):
        return len(self.episodes)


if __name__ == "__main__":
    processor = WaymoPreprocessor(resample_seconds=0.5)

    # for i, episode in enumerate(processor):
    #     print(i)
    #     print(episode)
    #     if i >= 1000:
    #         break

    processor.download_to_s3(bucket="waymo")
