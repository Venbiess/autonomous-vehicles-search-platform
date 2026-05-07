from .preprocessor import Preprocessor
from typing import Any, Callable, List, Optional, Dict
from tqdm import tqdm
import pandas as pd
import requests
from pathlib import Path
import os
import re
import tarfile
import time
import json

from configs.common import DATA_DIR, ARGOVERSE_DIR

S3_DATASET_LINK = "https://s3.amazonaws.com/argoverse/datasets/av2/tars/sensor/"
DATA_FOLDER = Path(DATA_DIR) / ARGOVERSE_DIR
OUTPUT_COLUMNS = [
    "timestamp",
    "camera_name",
    "dataset_type",
    "source_link",
    "image_path",
]


class ArgoversePreprocessor(Preprocessor):
    CHUNK_SIZE = 1024 * 1024

    CAMERA_TO_LABEL = {
        "FRONT": "ring_front_center",
        "FRONT_LEFT": "ring_front_left",
        "FRONT_RIGHT": "ring_front_right",
        "BACK_LEFT": "ring_rear_left",
        "BACK_RIGHT": "ring_rear_right"
    }

    REVERSE_CAMERA_TO_LABEL = {
        v: k for k, v in CAMERA_TO_LABEL.items()
    }
    MEMBER_PATH_RE = re.compile(
        r"sensor/(?P<split>[a-zA-Z0-9_-]+)/(?P<group>[^/]+)/sensors/cameras/(?P<camera>ring_[^/]+)/(?P<file>[^/]+\.jpg)$"
    )

    def __init__(self,
                 cameras: Optional[List[str]] = ["FRONT"],
                 resample_seconds: Optional[float] = 0.5,
                 download_parts: Dict[str, List[int]] = {
                     "train": range(14),
                     "val": range(3),
                     "test": range(3)
                 },
                 remove_after_load: bool = False
                ):
        super().__init__()

        if cameras:
            self.cameras = set([
                self.CAMERA_TO_LABEL[camera] for camera in cameras
            ])
        else:
            self.cameras = None
        self.download_parts = download_parts
        self.total_parts = sum([len(part) for part in download_parts.values()])
        self.resample_seconds = resample_seconds
        self.remove_after_load = remove_after_load

        os.makedirs(DATA_FOLDER, exist_ok=True)

        self.iteration = 0
        self.install_log_callback: Optional[Callable[[str], None]] = None
        self.download_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
        self.extract_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
        self.cancel_requested_callback: Optional[Callable[[], bool]] = None

    def _log(self, message: str) -> None:
        print(message, flush=True)
        if self.install_log_callback:
            self.install_log_callback(message)

    def _should_stop(self) -> bool:
        return bool(self.cancel_requested_callback and self.cancel_requested_callback())

    def _report_progress(
        self,
        file_index: int,
        file_name: str,
        downloaded_bytes: int,
        total_bytes: int,
        done: bool = False,
    ) -> None:
        if not self.download_progress_callback:
            return
        self.download_progress_callback(
            {
                "file_index": int(file_index),
                "total_files": int(max(self.total_parts, 1)),
                "file_name": str(file_name),
                "downloaded_bytes": int(max(downloaded_bytes, 0)),
                "total_bytes": int(max(total_bytes, 0)),
                "done": bool(done),
            }
        )

    def _report_extract_progress(
        self,
        file_index: int,
        file_name: str,
        extracted_bytes: int,
        total_bytes: int,
        extracted_files: int,
        done: bool = False,
    ) -> None:
        if not self.extract_progress_callback:
            return
        self.extract_progress_callback(
            {
                "file_index": int(file_index),
                "total_files": int(max(self.total_parts, 1)),
                "file_name": str(file_name),
                "extracted_bytes": int(max(extracted_bytes, 0)),
                "total_bytes": int(max(total_bytes, 0)),
                "extracted_files": int(max(extracted_files, 0)),
                "done": bool(done),
            }
        )

    def download_part(self, split: str, part: int, part_index: int):
        filename = f"{split}-{part:03d}.tar"
        url = os.path.join(S3_DATASET_LINK, filename)
        out_path = os.path.join(DATA_FOLDER, filename)
        self._log(f"[Argoverse] Download start {part_index}/{self.total_parts}: {filename}")

        with requests.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()

            remote_size = int(r.headers.get("Content-Length", 0))
            local_size = os.path.getsize(out_path) if os.path.exists(out_path) else 0

            downloaded = os.path.getsize(out_path) if os.path.exists(out_path) else 0
            mode = "ab" if downloaded > 0 else "wb"

            headers = {}

            if remote_size and local_size >= remote_size:
                self._log(
                    f"[Argoverse] Archive already downloaded {filename} ({local_size} bytes), skip download"
                )
                self._report_progress(
                    file_index=part_index,
                    file_name=filename,
                    downloaded_bytes=local_size,
                    total_bytes=remote_size,
                    done=True,
                )
                return out_path
            if downloaded > 0:
                self._log(
                    f"[Argoverse] Resume download {filename} from byte {downloaded}"
                )
                headers = {"Range": f"bytes={downloaded}-"}
                r.close()
                r = requests.get(url, stream=True, timeout=60, headers=headers)
                r.raise_for_status()

                remaining = int(r.headers.get("Content-Length", 0))
                remote_size = downloaded + remaining

            self._report_progress(
                file_index=part_index,
                file_name=filename,
                downloaded_bytes=downloaded,
                total_bytes=remote_size,
                done=False,
            )

            pbar = tqdm(
                total=remote_size,
                initial=downloaded,
                unit="B",
                unit_scale=True,
                unit_divisor=1024,
                desc=os.path.basename(out_path)
            )
            with open(out_path, mode) as f:
                for chunk in r.iter_content(chunk_size=self.CHUNK_SIZE):
                    if self._should_stop():
                        raise InterruptedError("Dataset installation cancelled by user")
                    if chunk:
                        f.write(chunk)
                        pbar.update(len(chunk))
                        downloaded += len(chunk)
                        self._report_progress(
                            file_index=part_index,
                            file_name=filename,
                            downloaded_bytes=downloaded,
                            total_bytes=remote_size,
                            done=False,
                        )

        final_size = os.path.getsize(out_path) if os.path.exists(out_path) else downloaded
        self._report_progress(
            file_index=part_index,
            file_name=filename,
            downloaded_bytes=final_size,
            total_bytes=remote_size if remote_size > 0 else final_size,
            done=True,
        )
        self._log(
            f"[Argoverse] Download done {part_index}/{self.total_parts}: {filename} ({final_size} bytes)"
        )
        return out_path

    def _part_tag(self, split: str, part: int) -> str:
        return f"{split}_{part:03d}"

    def _manifest_path(self, tar_name: str) -> Path:
        return Path(DATA_FOLDER) / f".manifest_{tar_name}.csv"

    def _meta_path(self, tar_name: str) -> Path:
        return Path(DATA_FOLDER) / f".manifest_{tar_name}.meta.json"

    def _build_part_df_from_manifest(self, manifest_path: Path) -> pd.DataFrame:
        if not manifest_path.exists():
            return pd.DataFrame(columns=OUTPUT_COLUMNS)
        try:
            df = pd.read_csv(manifest_path)
        except Exception:
            return pd.DataFrame(columns=OUTPUT_COLUMNS)
        for col in OUTPUT_COLUMNS:
            if col not in df.columns:
                df[col] = None
        return df[OUTPUT_COLUMNS]

    def _extract_member_info(
        self,
        member_name: str,
        expected_split: str,
    ) -> Optional[Dict[str, str]]:
        normalized = member_name.replace("\\", "/")
        match = self.MEMBER_PATH_RE.search(normalized)
        if not match:
            return None
        split = str(match.group("split"))
        if split != expected_split:
            return None
        group = str(match.group("group"))
        camera_raw = str(match.group("camera"))
        file_name = str(match.group("file"))
        stem = Path(file_name).stem
        ts = self._extract_timestamp_from_stem(stem)
        if ts is None:
            return None
        return {
            "split": split,
            "group": group,
            "camera_raw": camera_raw,
            "file_name": file_name,
            "timestamp": str(ts),
            "stem": stem,
        }

    def _extract_tar_with_progress(self, tar_path: str, part_index: int, split: str, part: int) -> pd.DataFrame:
        tar_name = Path(tar_path).name
        marker_path = Path(DATA_FOLDER) / f".extracted_{tar_name}.ok"
        manifest_path = self._manifest_path(tar_name)
        meta_path = self._meta_path(tar_name)
        part_tag = self._part_tag(split, part)
        archive_size = int(os.path.getsize(tar_path)) if os.path.exists(tar_path) else 0
        archive_mtime_ns = int(os.stat(tar_path).st_mtime_ns) if os.path.exists(tar_path) else 0
        current_config = {
            "part_tag": part_tag,
            "cameras": sorted(list(self.cameras)) if self.cameras else ["*"],
            "resample_seconds": float(self.resample_seconds or 0.0),
            "archive_size": archive_size,
            "archive_mtime_ns": archive_mtime_ns,
        }

        if marker_path.exists() and manifest_path.exists() and meta_path.exists():
            try:
                stored_meta = json.loads(meta_path.read_text())
            except Exception:
                stored_meta = {}
            stored_manifest_version = int(stored_meta.get("manifest_version", 1) or 1)
            stored_cfg = {
                "part_tag": stored_meta.get("part_tag"),
                "cameras": stored_meta.get("cameras"),
                "resample_seconds": float(stored_meta.get("resample_seconds", 0.0)),
                "archive_size": int(stored_meta.get("archive_size", 0) or 0),
                "archive_mtime_ns": int(stored_meta.get("archive_mtime_ns", 0) or 0),
            }
            manifest_df = self._build_part_df_from_manifest(manifest_path)
            selected_count = int(stored_meta.get("selected_count", len(manifest_df.index)) or 0)
            existing_count = 0
            if selected_count > 0 and "image_path" in manifest_df.columns:
                existing_count = int(
                    manifest_df["image_path"].astype(str).map(lambda p: Path(p).exists()).sum()
                )
            if (
                stored_manifest_version >= 2
                and selected_count > 0
                and stored_cfg == current_config
                and selected_count == existing_count
            ):
                self._log(
                    f"[Argoverse] Skip extract for {tar_name}: manifest matches config, "
                    f"existing_files={existing_count}/{selected_count}"
                )
                self._report_extract_progress(
                    file_index=part_index,
                    file_name=tar_name,
                    extracted_bytes=archive_size,
                    total_bytes=archive_size,
                    extracted_files=existing_count,
                    done=True,
                )
                return manifest_df

        self._log(
            f"[Argoverse] Start extract {part_index}/{self.total_parts}: {tar_name} "
            f"(archive_size={archive_size} bytes, stream mode, part={part_tag})"
        )
        self._log(
            "[Argoverse] INFO: extracting only selected cameras and applying time-step filter during stream."
        )

        rows: List[Dict[str, Any]] = []
        step_ns = int(self.resample_seconds * 1e9) if self.resample_seconds else 0
        last_kept_ts: Dict[str, int] = {}
        with tarfile.open(tar_path, "r|*") as tar:
            extracted_files = 0
            extracted_payload_bytes = 0
            extracted_members = 0
            selected_members = 0
            last_logged_bytes = 0
            last_logged_at = time.time()
            pbar = tqdm(
                total=archive_size if archive_size > 0 else None,
                unit="B",
                unit_scale=True,
                unit_divisor=1024,
                desc=f"Extract {tar_name}",
                dynamic_ncols=True,
            )
            pbar_bytes = 0

            def _sync_stream_progress() -> int:
                nonlocal pbar_bytes, last_logged_bytes, last_logged_at
                current_stream_pos = 0
                file_obj = getattr(tar, "fileobj", None)
                if file_obj is not None and hasattr(file_obj, "tell"):
                    try:
                        current_stream_pos = int(file_obj.tell())
                    except Exception:
                        current_stream_pos = 0
                if archive_size > 0:
                    extract_bytes_local = min(max(current_stream_pos, 0), archive_size)
                else:
                    extract_bytes_local = max(current_stream_pos, extracted_payload_bytes)
                if extract_bytes_local > pbar_bytes:
                    pbar.update(extract_bytes_local - pbar_bytes)
                    pbar_bytes = extract_bytes_local

                self._report_extract_progress(
                    file_index=part_index,
                    file_name=tar_name,
                    extracted_bytes=extract_bytes_local,
                    total_bytes=archive_size if archive_size > 0 else extract_bytes_local,
                    extracted_files=extracted_files,
                    done=False,
                )

                now = time.time()
                should_log_progress = False
                if extract_bytes_local - last_logged_bytes >= 2 * 1024 * 1024 * 1024:
                    should_log_progress = True
                if now - last_logged_at >= 30:
                    should_log_progress = True
                if should_log_progress:
                    if archive_size > 0:
                        percent = min(100.0, (extract_bytes_local / archive_size) * 100.0)
                        self._log(
                            f"[Argoverse] Extract progress {tar_name}: {percent:.1f}% "
                            f"({extract_bytes_local}/{archive_size} bytes), kept_files={extracted_files}, selected={selected_members}, members={extracted_members}"
                        )
                    else:
                        self._log(
                            f"[Argoverse] Extract progress {tar_name}: "
                            f"{extract_bytes_local} bytes, kept_files={extracted_files}, selected={selected_members}, members={extracted_members}"
                        )
                    last_logged_bytes = extract_bytes_local
                    last_logged_at = now
                return extract_bytes_local

            for member in tar:
                if self._should_stop():
                    raise InterruptedError("Dataset installation cancelled by user")
                extracted_members += 1
                if not member.isfile():
                    _sync_stream_progress()
                    continue

                member_info = self._extract_member_info(member.name, expected_split=split)
                if not member_info:
                    _sync_stream_progress()
                    continue
                camera_raw = member_info["camera_raw"]
                if self.cameras and camera_raw not in self.cameras:
                    _sync_stream_progress()
                    continue

                ts = int(member_info["timestamp"])
                group_key = re.sub(r"[^A-Za-z0-9_-]+", "_", member_info["group"])
                keep_key = f"{group_key}::{camera_raw}"
                if step_ns > 0:
                    last_ts = last_kept_ts.get(keep_key)
                    if last_ts is not None and (ts - last_ts) < step_ns:
                        _sync_stream_progress()
                        continue

                selected_members += 1
                tar_file = tar.extractfile(member)
                if tar_file is None:
                    continue

                cam = self.REVERSE_CAMERA_TO_LABEL.get(camera_raw, camera_raw)
                ts_str = member_info["timestamp"]
                dst = DATA_FOLDER / f"{part_tag}_{cam}_{group_key}_{ts_str}.jpg"
                if dst.exists():
                    i = 1
                    while (DATA_FOLDER / f"{part_tag}_{cam}_{group_key}_{ts_str}_{i}.jpg").exists():
                        i += 1
                    dst = DATA_FOLDER / f"{part_tag}_{cam}_{group_key}_{ts_str}_{i}.jpg"

                with open(dst, "wb") as out_fp:
                    while True:
                        chunk = tar_file.read(self.CHUNK_SIZE)
                        if not chunk:
                            break
                        out_fp.write(chunk)

                last_kept_ts[keep_key] = ts
                extracted_files += 1
                member_size = int(max(member.size, 0))
                extracted_payload_bytes += member_size
                rows.append(
                    {
                        "timestamp": ts,
                        "camera_name": cam,
                        "dataset_type": "argoverse",
                        "image_path": str(dst),
                        "source_link": os.path.join(S3_DATASET_LINK, f"{split}-{part:03d}.tar"),
                    }
                )
                _sync_stream_progress()
            if archive_size > 0 and pbar_bytes < archive_size:
                pbar.update(archive_size - pbar_bytes)
            pbar.close()
        marker_path.write_text("ok\n")
        result_df = pd.DataFrame(rows, columns=OUTPUT_COLUMNS)
        result_df.to_csv(manifest_path, index=False)
        meta_path.write_text(
            json.dumps(
                {
                    "manifest_version": 2,
                    "part_tag": part_tag,
                    "cameras": current_config["cameras"],
                    "resample_seconds": current_config["resample_seconds"],
                    "archive_size": archive_size,
                    "archive_mtime_ns": archive_mtime_ns,
                    "selected_count": int(len(result_df.index)),
                    "saved_at": int(time.time()),
                },
                ensure_ascii=True,
            )
            + "\n"
        )
        final_extract_bytes = archive_size if archive_size > 0 else extracted_payload_bytes
        self._report_extract_progress(
            file_index=part_index,
            file_name=tar_name,
            extracted_bytes=final_extract_bytes,
            total_bytes=archive_size if archive_size > 0 else final_extract_bytes,
            extracted_files=extracted_files,
            done=True,
        )

        self._log(
            f"[Argoverse] Done extract {part_index}/{self.total_parts}: {tar_name} "
            f"(kept_files={extracted_files}, selected={selected_members}, members={extracted_members}, payload_bytes={extracted_payload_bytes})"
        )
        return result_df

    @staticmethod
    def _extract_timestamp_from_stem(stem: str) -> Optional[int]:
        numeric_tokens = [token for token in stem.split("_") if token.isdigit()]
        if not numeric_tokens:
            return None

        long_tokens = [token for token in numeric_tokens if len(token) >= 12]
        candidate = long_tokens[-1] if long_tokens else numeric_tokens[-1]
        try:
            return int(candidate)
        except ValueError:
            return None

    def process_part(self, split: str, part: int):
        part_index = self.iteration + 1
        self._log(f"[Argoverse] Process part {part_index}/{self.total_parts}: {split}-{part:03d}")
        tar_path = self.download_part(split, part, part_index=part_index)
        output = self._extract_tar_with_progress(tar_path, part_index=part_index, split=split, part=part)
        self._log(f"[Argoverse] Part complete {part_index}/{self.total_parts}: {split}-{part:03d}")
        return output

    def _generate(self):
        for split, parts in self.download_parts.items():
            for part in parts:
                if self._should_stop():
                    raise InterruptedError("Dataset installation cancelled by user")
                yield self.process_part(split, part)
                self.iteration += 1

    def __iter__(self):
        return self._generate()


if __name__ == "__main__":
    processor = ArgoversePreprocessor(
        resample_seconds=0.5,
        download_parts={"train": [1]},
        cameras=["FRONT"]
    )


    processor.download_to_storage(bucket="argoverse")
