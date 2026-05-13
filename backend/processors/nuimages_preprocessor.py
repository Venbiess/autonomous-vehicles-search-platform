from .preprocessor import Preprocessor
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from pathlib import Path
from tqdm import tqdm
import re
import subprocess
import tarfile
import time

import pandas as pd

from configs.common import DATA_DIR, NUIMAGES_DIR

DATA_FOLDER = Path(DATA_DIR) / NUIMAGES_DIR
OUTPUT_COLUMNS = [
    "timestamp",
    "camera_name",
    "dataset_type",
    "source_link",
    "image_path",
]


class NuImagesPreprocessor(Preprocessor):
    CAMERA_TO_LABEL = {
        "FRONT": "CAM_FRONT",
        "FRONT_LEFT": "CAM_FRONT_LEFT",
        "FRONT_RIGHT": "CAM_FRONT_RIGHT",
        "REAR": "CAM_BACK",
        "BACK_LEFT": "CAM_BACK_LEFT",
        "BACK_RIGHT": "CAM_BACK_RIGHT",
    }
    REVERSE_CAMERA_TO_LABEL = {v: k for k, v in CAMERA_TO_LABEL.items()}

    ARCHIVE_PATTERNS = ("*.tgz", "*.tar.gz", "*.tar")
    IMAGE_FILE_RE = re.compile(
        r"^(?P<log_id>.+)__(?P<camera>CAM_[A-Z_]+)__(?P<timestamp>\d+)\.jpg$",
        re.IGNORECASE,
    )

    def __init__(
        self,
        cameras: Optional[List[str]] = None,
        resample_seconds: Optional[float] = 0.5,
        image_roots: Optional[List[str]] = None,
        extract_with_progress: bool = False,
        limit: Optional[int] = None,
        remove_local_images: bool = True,
        install_log_callback: Optional[Callable[[str], None]] = None,
        download_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        extract_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        cancel_requested_callback: Optional[Callable[[], bool]] = None,
    ):
        super().__init__(remove_local_images=remove_local_images)
        normalized_cameras = cameras or ["FRONT"]
        if normalized_cameras:
            self.cameras = {self.CAMERA_TO_LABEL[camera] for camera in normalized_cameras}
        else:
            self.cameras = None

        self.resample_seconds = resample_seconds
        self.image_roots = image_roots or ["sweeps", "samples"]
        self.extract_with_progress = extract_with_progress
        self.limit = limit
        self.download_progress_callback = download_progress_callback
        self.extract_progress_callback = extract_progress_callback
        self.cancel_requested_callback = cancel_requested_callback
        self.install_log_callback = install_log_callback

        DATA_FOLDER.mkdir(parents=True, exist_ok=True)
        self.local_source_root = DATA_FOLDER
        self._log(
            "[NuImages] Init: "
            f"cameras={sorted(self.cameras) if self.cameras else 'all'}, "
            f"resample_seconds={self.resample_seconds}, "
            f"image_roots={self.image_roots}, "
            f"extract_with_progress={self.extract_with_progress}, "
            f"limit={self.limit}"
        )

        self.archives = self._discover_archives()
        self._log(f"[NuImages] Archives discovered: {len(self.archives)}")
        self._extract_archives_if_needed()

        self.episode_rows = self._build_episode_rows()
        self.episode_keys = sorted(self.episode_rows.keys())
        if self.limit is not None:
            self.episode_keys = self.episode_keys[: max(0, int(self.limit))]

        if not self.episode_keys:
            raise FileNotFoundError(
                f"No nuImages frames found under {DATA_FOLDER}. "
                "Expected extracted folders like sweeps/ or samples/ and files "
                "named <log_id>__<camera>__<timestamp>.jpg"
            )

        self.iteration = 0
        self._log(f"[NuImages] Ready: episodes={len(self.episode_keys)}")

    def _should_stop(self) -> bool:
        return bool(self.cancel_requested_callback and self.cancel_requested_callback())

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

    def _report_extract_progress(
        self,
        file_index: int,
        total_files: int,
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
                "total_files": int(total_files),
                "file_name": str(file_name),
                "extracted_bytes": int(max(extracted_bytes, 0)),
                "total_bytes": int(max(total_bytes, 0)),
                "extracted_files": int(max(extracted_files, 0)),
                "done": bool(done),
            }
        )

    def _log(self, message: str) -> None:
        print(message, flush=True)
        if self.install_log_callback:
            self.install_log_callback(message)

    def _discover_archives(self) -> List[Path]:
        archives: List[Path] = []
        for pattern in self.ARCHIVE_PATTERNS:
            archives.extend(DATA_FOLDER.glob(pattern))
        resolved = sorted({path.resolve() for path in archives})
        if resolved:
            for archive in resolved:
                try:
                    size = int(archive.stat().st_size)
                except Exception:
                    size = 0
                self._log(f"[NuImages] Found archive: {archive.name} ({size} bytes)")
        return resolved

    def _has_extracted_images(self) -> bool:
        for root_name in self.image_roots:
            root = DATA_FOLDER / root_name
            if root.exists() and any(root.rglob("*.jpg")):
                return True
        return False

    def _extract_archives_if_needed(self) -> None:
        if self._should_stop():
            raise InterruptedError("Dataset installation cancelled by user")
        if not self.archives:
            if self._has_extracted_images():
                self._log("[NuImages] Archives not found, using already extracted data.")
                return
            raise FileNotFoundError(
                f"No archives found in {DATA_FOLDER}. "
                "Download nuImages archive(s) manually (e.g. *.tgz) and place them there."
            )

        total_archives = len(self.archives)
        for idx, archive_path in enumerate(self.archives, start=1):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")
            self._extract_archive_with_progress(archive_path, archive_index=idx, total_archives=total_archives)

    def _extract_archive_with_progress(
        self,
        archive_path: Path,
        archive_index: int,
        total_archives: int,
    ) -> None:
        marker_path = DATA_FOLDER / f".extracted_{archive_path.name}.ok"
        archive_size = int(archive_path.stat().st_size if archive_path.exists() else 0)

        if marker_path.exists() and self._has_extracted_images():
            self._log(
                f"[NuImages] Skip extract {archive_index}/{total_archives}: {archive_path.name} (already extracted)"
            )
            self._report_progress(
                file_index=archive_index,
                total_files=total_archives,
                file_name=archive_path.name,
                downloaded_bytes=archive_size,
                total_bytes=archive_size,
                done=True,
            )
            self._report_extract_progress(
                file_index=archive_index,
                total_files=total_archives,
                file_name=archive_path.name,
                extracted_bytes=archive_size,
                total_bytes=archive_size,
                extracted_files=0,
                done=True,
            )
            return

        self._log(
            f"[NuImages] Start extract {archive_index}/{total_archives}: {archive_path.name} "
            f"(archive_size={archive_size} bytes)"
        )
        self._report_progress(
            file_index=archive_index,
            total_files=total_archives,
            file_name=archive_path.name,
            downloaded_bytes=0,
            total_bytes=archive_size,
            done=False,
        )
        self._report_extract_progress(
            file_index=archive_index,
            total_files=total_archives,
            file_name=archive_path.name,
            extracted_bytes=0,
            total_bytes=archive_size,
            extracted_files=0,
            done=False,
        )
        extracted_files = None
        if self.extract_with_progress:
            self._log("[NuImages] INFO: progress mode enabled (slower).")
            extracted_files = self._extract_archive_with_progress_bar(
                archive_path=archive_path,
                archive_index=archive_index,
                total_archives=total_archives,
            )
        else:
            self._extract_archive_fast(archive_path)

        marker_path.write_text("ok\n")
        self._report_progress(
            file_index=archive_index,
            total_files=total_archives,
            file_name=archive_path.name,
            downloaded_bytes=archive_size,
            total_bytes=archive_size,
            done=True,
        )
        self._report_extract_progress(
            file_index=archive_index,
            total_files=total_archives,
            file_name=archive_path.name,
            extracted_bytes=archive_size,
            total_bytes=archive_size,
            extracted_files=int(extracted_files or 0),
            done=True,
        )
        if extracted_files is None:
            self._log(f"[NuImages] Done extract: {archive_path.name}")
        else:
            self._log(
                f"[NuImages] Done extract: {archive_path.name} (files: {extracted_files})",
            )

    def _extract_archive_fast(self, archive_path: Path) -> None:
        if self._should_stop():
            raise InterruptedError("Dataset installation cancelled by user")
        started_at = time.time()
        tar_args = ["tar", "-xzf", str(archive_path), "-C", str(DATA_FOLDER)]
        if archive_path.suffix.lower() == ".tar":
            tar_args = ["tar", "-xf", str(archive_path), "-C", str(DATA_FOLDER)]
        self._log(
            f"[NuImages] Extract fast mode: {' '.join(tar_args)}"
        )
        subprocess.run(tar_args, check=True)
        elapsed_sec = max(0.0, time.time() - started_at)
        self._log(
            f"[NuImages] Extract fast mode done: {archive_path.name} elapsed={elapsed_sec:.1f}s"
        )

    def _extract_archive_with_progress_bar(
        self,
        archive_path: Path,
        archive_index: int,
        total_archives: int,
    ) -> int:
        total_bytes = int(archive_path.stat().st_size if archive_path.exists() else 0)
        extracted_bytes = 0
        extracted_files = 0
        last_logged_at = time.time()
        last_logged_bytes = 0
        with tarfile.open(archive_path, "r|*") as tar:
            pbar = tqdm(
                unit="B",
                unit_scale=True,
                unit_divisor=1024,
                desc=f"Extract {archive_path.name}",
                dynamic_ncols=True,
            )
            for member in tar:
                if self._should_stop():
                    raise InterruptedError("Dataset installation cancelled by user")
                tar.extract(member, path=DATA_FOLDER)
                if member.isfile():
                    extracted_files += 1
                    size = max(member.size, 0)
                    extracted_bytes += size
                    pbar.update(size)
                    self._report_progress(
                        file_index=archive_index,
                        total_files=total_archives,
                        file_name=archive_path.name,
                        downloaded_bytes=extracted_bytes,
                        total_bytes=total_bytes,
                        done=False,
                    )
                    stream_pos = extracted_bytes
                    tar_stream = getattr(tar, "fileobj", None)
                    if tar_stream is not None and hasattr(tar_stream, "tell"):
                        try:
                            stream_pos = int(max(tar_stream.tell(), 0))
                        except Exception:
                            stream_pos = extracted_bytes
                    self._report_extract_progress(
                        file_index=archive_index,
                        total_files=total_archives,
                        file_name=archive_path.name,
                        extracted_bytes=min(stream_pos, total_bytes) if total_bytes > 0 else stream_pos,
                        total_bytes=total_bytes if total_bytes > 0 else stream_pos,
                        extracted_files=extracted_files,
                        done=False,
                    )
                    now = time.time()
                    if (
                        (stream_pos - last_logged_bytes) >= 1024 * 1024 * 1024
                        or (now - last_logged_at) >= 20
                    ):
                        if total_bytes > 0:
                            percent = min(100.0, (stream_pos / total_bytes) * 100.0)
                            self._log(
                                f"[NuImages] Extract progress {archive_path.name}: "
                                f"{percent:.1f}% ({stream_pos}/{total_bytes} bytes), files={extracted_files}"
                            )
                        else:
                            self._log(
                                f"[NuImages] Extract progress {archive_path.name}: "
                                f"{stream_pos} bytes, files={extracted_files}"
                            )
                        last_logged_at = now
                        last_logged_bytes = stream_pos
            pbar.close()
        self._report_extract_progress(
            file_index=archive_index,
            total_files=total_archives,
            file_name=archive_path.name,
            extracted_bytes=total_bytes if total_bytes > 0 else extracted_bytes,
            total_bytes=total_bytes if total_bytes > 0 else extracted_bytes,
            extracted_files=extracted_files,
            done=True,
        )
        return extracted_files

    def _iter_source_roots(self) -> Iterable[Tuple[str, Path]]:
        for root_name in self.image_roots:
            root_path = DATA_FOLDER / root_name
            if root_path.exists():
                yield root_name, root_path

    def _build_episode_rows(self) -> Dict[str, List[Dict[str, object]]]:
        episodes: Dict[str, List[Dict[str, object]]] = {}

        source_roots = list(self._iter_source_roots())
        if not source_roots:
            return episodes

        all_files: List[Tuple[str, Path]] = []
        for root_name, root_path in source_roots:
            all_files.extend((root_name, path) for path in root_path.rglob("*.jpg"))
        self._log(f"[NuImages] Index start: files={len(all_files)}")

        pbar = tqdm(all_files, desc="Index nuImages", dynamic_ncols=True)
        for root_name, file_path in pbar:
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")
            match = self.IMAGE_FILE_RE.match(file_path.name)
            if not match:
                continue

            camera_raw = match.group("camera").upper()
            if self.cameras and camera_raw not in self.cameras:
                continue

            ts = int(match.group("timestamp"))
            log_id = match.group("log_id")
            camera_name = self.REVERSE_CAMERA_TO_LABEL.get(camera_raw, camera_raw)

            row = {
                "timestamp": ts,
                "camera_name": camera_name,
                "dataset_type": "nuimages",
                "source_link": f"local://{root_name}/{file_path.name}",
                "image_path": str(file_path),
                "_log_id": log_id,
                "_camera_raw": camera_raw,
            }
            episodes.setdefault(log_id, []).append(row)

        for log_id in list(episodes.keys()):
            episodes[log_id] = self._resample_rows(episodes[log_id])
            if not episodes[log_id]:
                episodes.pop(log_id, None)

        total_rows = sum(len(rows) for rows in episodes.values())
        self._log(
            f"[NuImages] Index done: episodes={len(episodes)}, rows_after_resample={total_rows}"
        )

        return episodes

    def _resample_rows(self, rows: List[Dict[str, object]]) -> List[Dict[str, object]]:
        if not self.resample_seconds:
            return rows

        step_us = int(self.resample_seconds * 1_000_000)
        if step_us <= 0:
            return rows

        grouped: Dict[Tuple[str, str], List[Dict[str, object]]] = {}
        for row in rows:
            key = (str(row["_log_id"]), str(row["_camera_raw"]))
            grouped.setdefault(key, []).append(row)

        filtered: List[Dict[str, object]] = []
        for _, bucket in grouped.items():
            bucket.sort(key=lambda item: int(item["timestamp"]))
            last_ts = None
            for row in bucket:
                ts = int(row["timestamp"])
                if last_ts is None or (ts - last_ts) >= step_us:
                    filtered.append(row)
                    last_ts = ts

        return filtered

    def process_log(self, log_id: str) -> pd.DataFrame:
        rows = self.episode_rows.get(log_id, [])
        clean_rows = []
        for row in rows:
            clean_rows.append(
                {
                    "timestamp": row["timestamp"],
                    "camera_name": row["camera_name"],
                    "dataset_type": row["dataset_type"],
                    "source_link": row["source_link"],
                    "image_path": row["image_path"],
                }
            )

        return pd.DataFrame(clean_rows, columns=OUTPUT_COLUMNS)

    def __iter__(self):
        return self

    def __next__(self):
        if self.iteration >= len(self.episode_keys):
            raise StopIteration

        log_id = self.episode_keys[self.iteration]
        if self.iteration % 20 == 0 or self.iteration == len(self.episode_keys) - 1:
            self._log(
                f"[NuImages] Process episode {self.iteration + 1}/{len(self.episode_keys)}: {log_id}"
            )
        self.iteration += 1
        return self.process_log(log_id)

    def __len__(self):
        return len(self.episode_keys)


if __name__ == "__main__":
    processor = NuImagesPreprocessor(
        cameras=["FRONT"],
        resample_seconds=0.5,
        extract_with_progress=True,
    )
    processor.download_to_storage(bucket="nuimages")
