from .preprocessor import Preprocessor
from google.cloud import storage
from typing import Any, Callable, Dict, List, Optional
from pathlib import Path
import logging
import pandas as pd
import os
import re
import requests
from tqdm import tqdm

from configs.common import WAYMO_DIR, DATA_DIR, OBJECT_SERVER_ENDPOINT

BUCKET_NAME = "waymo_open_dataset_v_2_0_1"
PREFIX = "training/camera_image"
PROJECT_NAME = "avsp-479717"
DATA_FOLDER = Path(DATA_DIR) / WAYMO_DIR
OUTPUT_COLUMNS = [
    "timestamp",
    "camera_name",
    "dataset_type",
    "source_link",
    "image_path",
]

logger = logging.getLogger(__name__)


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
    STORAGE_KEY_PATTERN = re.compile(
        r"^(FRONT|FRONT_LEFT|FRONT_RIGHT|BACK_LEFT|BACK_RIGHT)_(.+)_(\d+)(?:_\d+)?\.jpg$"
    )

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
        self._processed_episode_ids: Optional[set[str]] = None

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
        self.install_log_callback: Optional[Callable[[str], None]] = None
        self.cancel_requested_callback: Optional[Callable[[], bool]] = None

        if self.exist_skip:
            self._processed_episode_ids = self._load_processed_episode_ids_from_storage()

    def _extract_episode_id_from_storage_key(self, key: str) -> Optional[str]:
        normalized = key.strip().replace("\\", "/")
        if not normalized.startswith("waymo/"):
            return None
        file_name = os.path.basename(normalized)
        match = self.STORAGE_KEY_PATTERN.match(file_name)
        if not match:
            return None
        return str(match.group(2)).strip() or None

    def _load_processed_episode_ids_from_storage(self) -> set[str]:
        processed: set[str] = set()
        cursor: Optional[str] = None

        while True:
            params: Dict[str, Any] = {"limit": 1000}
            if cursor:
                params["cursor"] = cursor
            try:
                response = requests.get(
                    f"{OBJECT_SERVER_ENDPOINT}/objects",
                    params=params,
                    timeout=30,
                )
                response.raise_for_status()
                payload = response.json()
            except Exception:  # noqa: BLE001
                logger.exception("failed to load objects metadata for waymo exist_skip")
                return processed

            items = payload.get("items", [])
            if not isinstance(items, list):
                break

            for item in items:
                key = str(item.get("key", "")).strip()
                episode_id = self._extract_episode_id_from_storage_key(key)
                if episode_id:
                    processed.add(episode_id)

            cursor = str(payload.get("next_cursor", "")).strip() or None
            if not cursor:
                break

        return processed

    def _should_skip_episode_by_storage(self, episode_name: str) -> bool:
        if not self.exist_skip:
            return False
        if self._processed_episode_ids is None:
            return False
        episode_id = Path(episode_name).stem
        return episode_id in self._processed_episode_ids

    def _should_stop(self) -> bool:
        return bool(self.cancel_requested_callback and self.cancel_requested_callback())

    def _log(self, message: str) -> None:
        logger.info(message)
        if self.install_log_callback:
            self.install_log_callback(message)

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

    def _is_valid_parquet_file(self, file_path: str) -> bool:
        try:
            if not os.path.exists(file_path):
                return False
            if os.path.getsize(file_path) < 8:
                return False
            with open(file_path, "rb") as f:
                header = f.read(4)
                f.seek(-4, os.SEEK_END)
                footer = f.read(4)
            return header == b"PAR1" and footer == b"PAR1"
        except Exception:  # noqa: BLE001
            return False

    def download_blob(self, blob_name: str, dst_path: str, file_index: int):
        if self._should_stop():
            raise InterruptedError("Dataset installation cancelled by user")
        total_files = max(len(self.episodes), 1)
        file_progress = None
        downloaded_bytes = 0
        name = os.path.basename(blob_name)

        local_exists = os.path.exists(dst_path)
        should_download = (not local_exists) or (not self.exist_skip)
        if local_exists and self.exist_skip and not self._is_valid_parquet_file(dst_path):
            self._log(
                f"[Waymo] Local parquet is invalid for {name}; forcing re-download"
            )
            should_download = True

        if should_download:
            blob = self.bucket.blob(blob_name)
            blob.reload()
            total_bytes = int(blob.size or 0)
            total_mib_str = (
                f"{(total_bytes / (1024 * 1024)):.2f} MiB"
                if total_bytes > 0
                else "unknown size"
            )
            self._log(
                f"[Waymo] Download start {file_index}/{total_files}: {name} ({total_mib_str})"
            )

            if self.download_progress_callback is None:
                total_mib = (total_bytes / (1024 * 1024)) if total_bytes > 0 else None
                file_progress = tqdm(
                    total=total_mib,
                    desc=f"{file_index}/{total_files} {name}",
                    unit="MiB",
                    leave=False,
                    dynamic_ncols=True,
                )

            self._report_progress(
                file_index=file_index,
                total_files=total_files,
                file_name=name,
                downloaded_bytes=0,
                total_bytes=total_bytes,
                done=False,
            )

            chunk_size = 8 * 1024 * 1024
            try:
                with open(dst_path, "wb") as f:
                    if total_bytes <= 0:
                        if self._should_stop():
                            raise InterruptedError("Dataset installation cancelled by user")
                        blob.download_to_file(f)
                        downloaded_bytes = int(os.path.getsize(dst_path))
                        total_bytes = max(total_bytes, downloaded_bytes)
                        if file_progress:
                            if file_progress.total is None:
                                file_progress.total = downloaded_bytes / (1024 * 1024)
                            file_progress.update(downloaded_bytes / (1024 * 1024))
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
                            if self._should_stop():
                                raise InterruptedError("Dataset installation cancelled by user")
                            end = min(start + chunk_size - 1, total_bytes - 1)
                            payload = blob.download_as_bytes(start=start, end=end)
                            f.write(payload)
                            prev_downloaded = downloaded_bytes
                            downloaded_bytes = end + 1
                            if file_progress:
                                delta_mib = (downloaded_bytes - prev_downloaded) / (1024 * 1024)
                                file_progress.update(delta_mib)
                            self._report_progress(
                                file_index=file_index,
                                total_files=total_files,
                                file_name=name,
                                downloaded_bytes=downloaded_bytes,
                                total_bytes=total_bytes,
                                done=downloaded_bytes >= total_bytes,
                            )
                            start = end + 1
            except InterruptedError:
                if os.path.exists(dst_path):
                    os.remove(dst_path)
                raise
            finally:
                if file_progress:
                    file_progress.close()
        else:
            file_size = int(os.path.getsize(dst_path))
            self._log(
                f"[Waymo] Skip download {name}: local file exists and exist_skip=true"
            )
            if self.download_progress_callback is None:
                file_progress = tqdm(
                    total=max(file_size / (1024 * 1024), 0.0),
                    desc=f"{file_index}/{total_files} {name}",
                    unit="MiB",
                    leave=False,
                    dynamic_ncols=True,
                )
                file_progress.update(file_size / (1024 * 1024))
                file_progress.close()
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
        df["dataset_type"] = "waymo"
        df["source_link"] = f"gs://{BUCKET_NAME}/{PREFIX}/{episode_name}"
        df = df[OUTPUT_COLUMNS]
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

            # Include episode key in file name to avoid collisions on camera+timestamp.
            file_path = DATA_FOLDER / f"{cam}_{episode_id}_{ts_str}.jpg"
            if file_path.exists():
                i = 1
                while (DATA_FOLDER / f"{cam}_{episode_id}_{ts_str}_{i}.jpg").exists():
                    i += 1
                file_path = DATA_FOLDER / f"{cam}_{episode_id}_{ts_str}_{i}.jpg"

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

        if self._should_skip_episode_by_storage(name):
            self._log(
                f"[Waymo] Skip episode {name}: found in object storage and exist_skip=true"
            )
            return pd.DataFrame(columns=OUTPUT_COLUMNS)

        self.download_blob(blob_name, dst_path, file_index=file_index)
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

    processor.download_to_storage(bucket="waymo")
