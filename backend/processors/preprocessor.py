from abc import abstractmethod
from typing import Any, Callable, Dict, Optional

import logging
import os

import requests
from configs.common import OBJECT_SERVER_ENDPOINT, STORAGE_WRITE_TOKEN
from tqdm import tqdm

logger = logging.getLogger(__name__)


class Preprocessor:
    cameras = [
        "FRONT",
        "FRONT_LEFT",
        "FRONT_RIGHT",
        "REAR",
        "BACK_LEFT",
        "BACK_RIGHT",
    ]

    def __init__(self, remove_local_images: bool = True):
        self.remove_local_images = remove_local_images

    def upload_to_storage(self, local_path: str, bucket: str, object_name: str) -> Optional[dict]:
        headers = {}
        token = STORAGE_WRITE_TOKEN.strip()
        if token:
            headers["X-Storage-Write-Token"] = token

        try:
            with open(local_path, "rb") as fp:
                response = requests.post(
                    f"{OBJECT_SERVER_ENDPOINT}/objects/upload",
                    data={
                        "bucket": bucket,
                        "key": object_name,
                    },
                    files={"file": (os.path.basename(local_path), fp, "image/jpeg")},
                    headers=headers,
                    timeout=60,
                )
            response.raise_for_status()
            payload = response.json()
            if not str(payload.get("object_id", "")).strip():
                return None
            return payload
        except Exception:  # noqa: BLE001
            logger.exception("failed to upload object: path=%s bucket=%s key=%s", local_path, bucket, object_name)
            return None

    # Backward compatibility: legacy preprocessors/scripts may still call this name.
    def upload_to_s3(self, local_path: str, bucket: str, object_name: str) -> Optional[dict]:
        return self.upload_to_storage(local_path, bucket, object_name)

    @abstractmethod
    def __iter__(self):
        raise NotImplementedError("Dataset preprocessor must have __iter__")

    @abstractmethod
    def __next__(self):
        raise NotImplementedError("Dataset preprocessor must have __next__")

    def download_to_storage(
        self,
        bucket: str = "avsp",
        save_to_db: bool = False,
        db_table: str = None,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        should_stop_callback: Optional[Callable[[], bool]] = None,
    ):
        if save_to_db or db_table:
            logger.warning("save_to_db/db_table are ignored: preprocessors now write only to storage")

        episodes_done = 0
        total_rows = 0
        uploaded_objects = 0
        failed_objects = 0

        for episode_df in tqdm(self):
            if should_stop_callback and should_stop_callback():
                raise InterruptedError("Dataset installation cancelled by user")
            episodes_done += 1
            episode_df["storage_path"] = None
            episode_df["object_id"] = None
            total_episode_rows = int(len(episode_df.index))

            for row_idx, (idx, row) in enumerate(episode_df.iterrows(), start=1):
                if should_stop_callback and should_stop_callback():
                    raise InterruptedError("Dataset installation cancelled by user")
                total_rows += 1
                local_path = str(row["image_path"])
                name = os.path.basename(local_path)
                dataset_type = str(row.get("dataset_type", "dataset")).strip() or "dataset"
                object_name = f"{dataset_type}/{name}"

                uploaded = self.upload_to_storage(local_path, bucket, object_name)
                if uploaded:
                    episode_df.at[idx, "storage_path"] = uploaded.get("storage_path")
                    episode_df.at[idx, "object_id"] = uploaded.get("object_id")
                    uploaded_objects += 1
                else:
                    failed_objects += 1

                if self.remove_local_images and os.path.exists(local_path):
                    os.remove(local_path)

                if progress_callback:
                    progress_callback(
                        {
                            "event": "upload_progress",
                            "episodes_done": episodes_done,
                            "current_scene_tasks_completed": row_idx,
                            "current_scene_tasks_total": total_episode_rows,
                            "uploaded_objects": uploaded_objects,
                            "failed_objects": failed_objects,
                            "total_rows": total_rows,
                            "last_uploaded_object_id": uploaded.get("object_id") if uploaded else None,
                            "last_storage_path": uploaded.get("storage_path") if uploaded else None,
                        }
                    )

            if progress_callback:
                progress_callback(
                    {
                        "event": "episode",
                        "episodes_done": episodes_done,
                        "uploaded_objects": uploaded_objects,
                        "failed_objects": failed_objects,
                        "total_rows": total_rows,
                    }
                )

        return {
            "episodes_done": episodes_done,
            "total_rows": total_rows,
            "uploaded_objects": uploaded_objects,
            "failed_objects": failed_objects,
        }
