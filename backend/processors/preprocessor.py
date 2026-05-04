from abc import abstractmethod
from typing import Any, Callable, Dict, Optional

import hashlib
import logging
import os
import re
from pathlib import Path

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
                params = {
                    "bucket": bucket,
                    "key": object_name,
                    "filename": os.path.basename(local_path),
                    "content_type": "image/jpeg",
                }
                req_headers = dict(headers)
                req_headers["Content-Type"] = "image/jpeg"
                response = requests.post(
                    f"{OBJECT_SERVER_ENDPOINT}/objects/upload",
                    params=params,
                    data=fp,
                    headers=req_headers,
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

    @staticmethod
    def _sanitize_storage_path(path: str) -> str:
        normalized = str(path or "").strip().replace("\\", "/").strip("/")
        if not normalized:
            return ""
        normalized = normalized.replace("../", "_/").replace("/..", "/_")
        normalized = re.sub(r"[^A-Za-z0-9._/\-]+", "_", normalized)
        normalized = re.sub(r"/{2,}", "/", normalized)
        return normalized.strip("/")

    def _build_object_key(self, row: Any, local_path: str) -> str:
        dataset_type = str(getattr(row, "get", lambda *_: "dataset")("dataset_type", "dataset")).strip() or "dataset"
        base_name = os.path.basename(str(local_path or "").strip()) or "image.jpg"
        source_link = str(getattr(row, "get", lambda *_: "")("source_link", "")).strip()

        relative = ""
        if source_link.startswith("local://"):
            relative = source_link[len("local://") :]
        elif source_link.startswith("gs://"):
            relative = source_link[len("gs://") :]
        elif source_link:
            relative = source_link

        safe_relative = self._sanitize_storage_path(relative)
        if safe_relative and source_link.startswith("local://"):
            return f"{dataset_type}/{safe_relative}"
        if safe_relative:
            camera_name = str(getattr(row, "get", lambda *_: "")("camera_name", "")).strip()
            timestamp = str(getattr(row, "get", lambda *_: "")("timestamp", "")).strip()
            per_image_token_raw = "_".join(
                part for part in [camera_name, timestamp, base_name] if part
            ) or base_name
            per_image_token = self._sanitize_storage_path(per_image_token_raw).replace("/", "_").strip("_")
            if not per_image_token:
                per_image_token = base_name
            return f"{dataset_type}/{safe_relative}/{per_image_token}"

        digest = hashlib.sha1(str(local_path).encode("utf-8"), usedforsecurity=False).hexdigest()[:16]
        return f"{dataset_type}/{digest}_{base_name}"

    # Backward compatibility: legacy preprocessors/scripts may still call this name.
    def upload_to_s3(self, local_path: str, bucket: str, object_name: str) -> Optional[dict]:
        return self.upload_to_storage(local_path, bucket, object_name)

    def _resolve_local_source_path(self, row: Any) -> Optional[Path]:
        source_link = str(getattr(row, "get", lambda *_: "")("source_link", "")).strip()
        if not source_link.startswith("local://"):
            return None
        source_root_raw = getattr(self, "local_source_root", None)
        if not source_root_raw:
            return None
        relative = source_link[len("local://") :].strip().replace("\\", "/").lstrip("/")
        if not relative:
            return None
        source_root = Path(str(source_root_raw)).resolve()
        candidate = (source_root / relative).resolve()
        if os.path.commonpath([str(source_root), str(candidate)]) != str(source_root):
            return None
        return candidate

    @staticmethod
    def _prune_empty_parents(path: Path, stop_at: Optional[Path]) -> None:
        if stop_at is None:
            return
        try:
            stop = stop_at.resolve()
        except Exception:  # noqa: BLE001
            return
        current = path.parent
        while True:
            try:
                current_resolved = current.resolve()
            except Exception:  # noqa: BLE001
                break
            if str(current_resolved) == str(stop):
                break
            try:
                if any(current.iterdir()):
                    break
                current.rmdir()
            except Exception:  # noqa: BLE001
                break
            current = current.parent

    def _cleanup_local_artifacts_after_upload(self, local_path: str, row: Any) -> None:
        link_path = Path(str(local_path))
        if link_path.exists():
            link_path.unlink(missing_ok=True)
        out_root_raw = getattr(self, "local_output_root", None)
        out_root = Path(str(out_root_raw)).resolve() if out_root_raw else None
        self._prune_empty_parents(link_path, out_root)

        source_path = self._resolve_local_source_path(row)
        if source_path and source_path.exists() and source_path != link_path:
            source_path.unlink(missing_ok=True)
            source_root_raw = getattr(self, "local_source_root", None)
            source_root = Path(str(source_root_raw)).resolve() if source_root_raw else None
            self._prune_empty_parents(source_path, source_root)

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
        uploaded_unique = 0
        uploaded_ids_seen: set[str] = set()
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
                object_name = self._build_object_key(row, local_path)

                uploaded = self.upload_to_storage(local_path, bucket, object_name)
                if uploaded:
                    episode_df.at[idx, "storage_path"] = uploaded.get("storage_path")
                    episode_df.at[idx, "object_id"] = uploaded.get("object_id")
                    uploaded_objects += 1
                    object_id = str(uploaded.get("object_id", "")).strip()
                    if object_id and object_id not in uploaded_ids_seen:
                        uploaded_ids_seen.add(object_id)
                        uploaded_unique += 1
                else:
                    failed_objects += 1

                if self.remove_local_images:
                    self._cleanup_local_artifacts_after_upload(local_path, row)

                if progress_callback:
                    progress_callback(
                        {
                            "event": "upload_progress",
                            "episodes_done": episodes_done,
                            "current_scene_tasks_completed": row_idx,
                            "current_scene_tasks_total": total_episode_rows,
                            "uploaded_objects": uploaded_objects,
                            "uploaded_objects_unique": uploaded_unique,
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
                        "uploaded_objects_unique": uploaded_unique,
                        "failed_objects": failed_objects,
                        "total_rows": total_rows,
                    }
                )

        return {
            "episodes_done": episodes_done,
            "total_rows": total_rows,
            "uploaded_objects": uploaded_objects,
            "uploaded_objects_unique": uploaded_unique,
            "failed_objects": failed_objects,
        }
