from __future__ import annotations

import argparse
import importlib
import os
import re
import subprocess
import tarfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import pandas as pd
from tqdm import tqdm

from configs.common import DATA_DIR

from .preprocessor import Preprocessor

DATA_FOLDER = Path(DATA_DIR) / "once"
OUTPUT_COLUMNS = [
    "timestamp",
    "camera_name",
    "dataset_type",
    "source_link",
    "image_path",
]


class OncePreprocessor(Preprocessor):
    CAMERA_TO_LABEL = {
        "FRONT": ["cam01"],
        "FRONT_LEFT": ["cam03"],
        "FRONT_RIGHT": ["cam05"],
        "REAR": ["cam06"],
        "BACK_LEFT": ["cam07"],
        "BACK_RIGHT": ["cam08"],
        "REAR_RIGHT": ["cam09"],
        "SIDE_LEFT": ["cam07"],
        "SIDE_RIGHT": ["cam08"],
    }
    REVERSE_CAMERA_TO_LABEL = {
        "cam01": "FRONT",
        "cam03": "FRONT_LEFT",
        "cam05": "FRONT_RIGHT",
        "cam06": "REAR",
        "cam07": "BACK_LEFT",
        "cam08": "BACK_RIGHT",
        "cam09": "REAR_RIGHT",
    }
    ARCHIVE_PATTERNS = ("*.tar", "*.tgz", "*.tar.gz")
    IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
    CAMERA_RE = re.compile(r"(cam\d{2})", re.IGNORECASE)
    TIMESTAMP_RE = re.compile(r"(\d{6,})")
    DOWNLOAD_SIZE_RE = re.compile(
        r"(?P<done>\d+(?:\.\d+)?)\s*(?P<done_unit>[KMGTP]?i?B?|[KMGTP])\s*/\s*"
        r"(?P<total>\d+(?:\.\d+)?)\s*(?P<total_unit>[KMGTP]?i?B?|[KMGTP])",
        re.IGNORECASE,
    )
    SPLIT_GDRIVE_FOLDERS = {
        "train": "https://drive.google.com/drive/folders/1E85-kPxCatAUGx-EvnNJJpnJ7pfxqmPH?usp=sharing",
        "val": "https://drive.google.com/drive/folders/1zYgxnU5NBoAWz9TvMgfapKkZ2YhTtyl7?usp=sharing",
        "test": "https://drive.google.com/drive/folders/1hd8L36qNuh_7hI0yb_xjt9yYqBVXlMyx?usp=sharing",
        "unlabeled_1": "https://drive.google.com/drive/folders/1gxxkM-K7lA2unT5cVQnZ1UxSOOshatZQ?usp=sharing",
        "unlabeled_2": "https://drive.google.com/drive/folders/1Bta7R4dex-wI4iWoLZlE4M2faV7ZskTV?usp=sharing",
        "unlabeled_3": "https://drive.google.com/drive/folders/1l-Jjk3J1ogE8_BWbpxnDc9KFFcbLEmXS?usp=sharing",
        "unlabeled_4": "https://drive.google.com/drive/folders/1t_Ea2IGSwIS3HZ3UWcCz_9PLUgdw3_Y6?usp=sharing",
        "unlabeled_5": "https://drive.google.com/drive/folders/14LKOfIcW-pKfypU1Cjz8If9L7K7tPYoY?usp=sharing",
        "unlabeled_6": "https://drive.google.com/drive/folders/1xt3i5zFJvTGqhPYcQgndav2WNO-qYmZC?usp=sharing",
        "unlabeled_7": "https://drive.google.com/drive/folders/15nxLHdAuOgyYkh21MtYAuyYYAI3d5xRu?usp=sharing",
        "unlabeled_8": "https://drive.google.com/drive/folders/1eVO5YynrxCBptqARb6xfh-IUOVIfR7Hb?usp=sharing",
        "unlabeled_9": "https://drive.google.com/drive/folders/1Ygr8O3MRIBtHSorIqXK-JSuBQtQVxonw?usp=sharing",
    }

    def __init__(
        self,
        cameras: Optional[List[str]] = None,
        resample_seconds: float = 5.0,
        fps: int = 10,
        tar_dir: Optional[str] = None,
        extract_dir: Optional[str] = None,
        out_dir: Optional[str] = None,
        download_splits: Optional[List[str]] = None,
        use_local_archives: bool = False,
        download_from_gdrive: bool = True,
        remove_local_images: bool = True,
        stream_upload_by_archive: bool = True,
        install_log_callback: Optional[Callable[[str], None]] = None,
        download_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        download_detail_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        extract_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        cancel_requested_callback: Optional[Callable[[], bool]] = None,
    ):
        super().__init__(remove_local_images=remove_local_images)
        self.resample_seconds = max(0.0, float(resample_seconds or 0.0))
        self.fps = max(1, int(fps or 1))
        self.step_frames = max(1, int(round(self.resample_seconds * self.fps)))

        self.tar_dir = Path(tar_dir) if tar_dir else DATA_FOLDER / "tars"
        self.extract_dir = Path(extract_dir) if extract_dir else DATA_FOLDER / "extracted"
        self.out_dir = Path(out_dir) if out_dir else DATA_FOLDER / "filtered"
        self.download_splits = self._normalize_download_splits(download_splits)
        self.use_local_archives = bool(use_local_archives)
        self.download_from_gdrive = bool(download_from_gdrive)
        self.stream_upload_by_archive = bool(stream_upload_by_archive)

        self.install_log_callback = install_log_callback
        self.download_progress_callback = download_progress_callback
        self.download_detail_progress_callback = download_detail_progress_callback
        self.extract_progress_callback = extract_progress_callback
        self.cancel_requested_callback = cancel_requested_callback

        self.selected_cameras = self._normalize_camera_selection(cameras or ["FRONT"])

        DATA_FOLDER.mkdir(parents=True, exist_ok=True)
        self.tar_dir.mkdir(parents=True, exist_ok=True)
        self.extract_dir.mkdir(parents=True, exist_ok=True)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.local_source_root = self.extract_dir
        self.local_output_root = self.out_dir

        self._log(
            "[ONCE] Init: "
            f"selected_cameras={sorted(self.selected_cameras) if self.selected_cameras else 'all'}, "
            f"resample_seconds={self.resample_seconds}, fps={self.fps}, step_frames={self.step_frames}, "
            f"download_splits={self.download_splits}, "
            f"use_local_archives={self.use_local_archives}, "
            f"download_from_gdrive={self.download_from_gdrive}, "
            f"stream_upload_by_archive={self.stream_upload_by_archive}, "
            f"tar_dir={self.tar_dir}"
        )

        self._prepare_archives()
        self.archives = self._discover_archives()
        self.streaming_mode = bool(self.stream_upload_by_archive and len(self.archives) > 0)
        self.episodes: Dict[str, List[Dict[str, Any]]] = {}
        self.episode_keys: List[str] = []
        if not self.streaming_mode:
            self._extract_archives_if_needed()
            self.episodes = self._build_episodes()
            self.episode_keys = sorted(self.episodes.keys())
            if not self.episode_keys:
                raise FileNotFoundError(
                    f"No ONCE jpg files found in {self.extract_dir}. "
                    "Check Google Drive folder access and archive contents."
                )

        self.iteration = 0
        if self.streaming_mode:
            self._log(f"[ONCE] Ready: archives={len(self.archives)} (stream upload mode)")
        else:
            self._log(f"[ONCE] Ready: episodes={len(self.episode_keys)}")

    def _log(self, message: str) -> None:
        print(message, flush=True)
        if self.install_log_callback:
            self.install_log_callback(message)

    def _should_stop(self) -> bool:
        return bool(self.cancel_requested_callback and self.cancel_requested_callback())

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

    def _report_download_progress(
        self,
        file_index: int,
        total_files: int,
        downloaded_bytes: int,
        total_bytes: int,
        file_name: str = "gdrive-folder",
        done: bool = False,
    ) -> None:
        if not self.download_progress_callback:
            return
        self.download_progress_callback(
            {
                "file_index": int(max(file_index, 0)),
                "total_files": int(max(total_files, 1)),
                "file_name": str(file_name),
                "downloaded_bytes": int(max(downloaded_bytes, 0)),
                "total_bytes": int(max(total_bytes, 0)),
                "done": bool(done),
            }
        )

    def _normalize_camera_selection(self, cameras: List[str]) -> Optional[set[str]]:
        selected: set[str] = set()
        for camera in cameras:
            raw = str(camera).strip()
            if not raw:
                continue

            upper = raw.upper()
            if upper in self.CAMERA_TO_LABEL:
                selected.update(self.CAMERA_TO_LABEL[upper])
                continue

            match = self.CAMERA_RE.search(raw)
            if match:
                selected.add(match.group(1).lower())

        return selected or None

    def _normalize_download_splits(self, splits: Optional[List[str]]) -> List[str]:
        if not splits:
            return list(self.SPLIT_GDRIVE_FOLDERS.keys())
        out: List[str] = []
        known = set(self.SPLIT_GDRIVE_FOLDERS.keys())
        aliases = {
            "unlabeled part 1": "unlabeled_1",
            "unlabeled part 2": "unlabeled_2",
            "unlabeled part 3": "unlabeled_3",
            "unlabeled part 4": "unlabeled_4",
            "unlabeled part 5": "unlabeled_5",
            "unlabeled part 6": "unlabeled_6",
            "unlabeled part 7": "unlabeled_7",
            "unlabeled part 8": "unlabeled_8",
            "unlabeled part 9": "unlabeled_9",
        }
        for raw in splits:
            key = str(raw).strip().lower().replace("-", "_")
            key = aliases.get(key, key)
            if key in known and key not in out:
                out.append(key)
        if not out:
            raise ValueError(
                "ONCE download_splits is empty or invalid. "
                f"Allowed: {sorted(self.SPLIT_GDRIVE_FOLDERS.keys())}"
            )
        return out

    def _to_bytes(self, value: str, unit: str) -> int:
        number = float(value)
        normalized = unit.strip().upper()
        if normalized in {"", "B"}:
            base_unit = "B"
        elif normalized in {"K", "KB", "KIB"}:
            base_unit = "KB"
        elif normalized in {"M", "MB", "MIB"}:
            base_unit = "MB"
        elif normalized in {"G", "GB", "GIB"}:
            base_unit = "GB"
        elif normalized in {"T", "TB", "TIB"}:
            base_unit = "TB"
        elif normalized in {"P", "PB", "PIB"}:
            base_unit = "PB"
        else:
            base_unit = "B"
        multipliers = {
            "B": 1,
            "KB": 1024,
            "MB": 1024 * 1024,
            "GB": 1024 * 1024 * 1024,
            "TB": 1024 * 1024 * 1024 * 1024,
            "PB": 1024 * 1024 * 1024 * 1024 * 1024,
        }
        return int(number * multipliers.get(base_unit, 1))

    def _discover_archives(self) -> List[Path]:
        archives: List[Path] = []
        for pattern in self.ARCHIVE_PATTERNS:
            archives.extend(self.tar_dir.glob(pattern))
        return sorted({path.resolve() for path in archives})

    def _has_extracted_images(self) -> bool:
        return any(self.extract_dir.rglob("*.jpg"))

    def _prepare_archives(self) -> None:
        if self._should_stop():
            raise InterruptedError("Dataset installation cancelled by user")
        if self._has_extracted_images():
            self._log("[ONCE] Skip archive preparation: extracted images already exist")
            return

        local_archives = self._discover_archives()
        if self.use_local_archives:
            if not local_archives:
                raise FileNotFoundError(
                    f"ONCE use_local_archives=true but no archives found in {self.tar_dir}. "
                    "Place .tar/.tgz/.tar.gz files there or disable use_local_archives."
                )
            self._log(f"[ONCE] Use local archives from {self.tar_dir}: found={len(local_archives)}")
            return

        if local_archives:
            self._log("[ONCE] Skip Google Drive download: local archives already exist")
            return
        if not self.download_from_gdrive:
            raise FileNotFoundError(
                f"No local ONCE archives in {self.tar_dir} and download_from_gdrive=false."
            )
        self._download_archives_from_gdrive_if_needed()

    def _download_archives_from_gdrive_if_needed(self) -> None:
        if self._should_stop():
            raise InterruptedError("Dataset installation cancelled by user")
        if self._has_extracted_images():
            self._log("[ONCE] Skip Google Drive download: extracted images already exist")
            return

        try:
            importlib.import_module("gdown")
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "Package 'gdown' is required for Google Drive download. "
                "Install it in server image (pip install gdown)."
            ) from exc

        selected_splits = list(self.download_splits)

        total_parts = len(selected_splits)
        completed_parts = 0
        self._report_download_progress(
            file_index=0,
            total_files=max(total_parts, 1),
            downloaded_bytes=0,
            total_bytes=max(total_parts, 1),
            done=False,
        )

        for idx, split in enumerate(selected_splits, start=1):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")
            url = self.SPLIT_GDRIVE_FOLDERS.get(split, "")
            if not url:
                raise ValueError(f"Missing Google Drive URL for ONCE split: {split}")

            out_dir = self.tar_dir / split
            out_dir.mkdir(parents=True, exist_ok=True)
            self._log(f"[ONCE] Download split {idx}/{total_parts}: {split}")
            self._report_download_progress(
                file_index=idx,
                total_files=max(total_parts, 1),
                downloaded_bytes=completed_parts,
                total_bytes=max(total_parts, 1),
                file_name=split,
                done=False,
            )

            detail_file_name = f"{split}.tar"
            last_logged_at = time.time()
            cmd = [
                "python3",
                "-m",
                "gdown",
                "--folder",
                url,
                "--output",
                str(out_dir),
                "--no-cookies",
                "--continue",
            ]
            last_downloaded = 0
            last_total = 0
            parsed_progress = False
            last_error_tail: List[str] = []
            self._log(f"[ONCE] Run downloader: {' '.join(cmd[:4])} ...")
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            tail: List[str] = []
            assert proc.stdout is not None
            for raw_line in proc.stdout:
                if self._should_stop():
                    proc.terminate()
                    raise InterruptedError("Dataset installation cancelled by user")
                line = raw_line.strip()
                if not line:
                    continue
                tail.append(line)
                if len(tail) > 60:
                    tail = tail[-60:]

                size_match = self.DOWNLOAD_SIZE_RE.search(line)
                if size_match:
                    parsed_progress = True
                    done = self._to_bytes(size_match.group("done"), size_match.group("done_unit"))
                    total = self._to_bytes(size_match.group("total"), size_match.group("total_unit"))
                    last_downloaded = max(done, 0)
                    last_total = max(total, 1)
                    if self.download_detail_progress_callback:
                        self.download_detail_progress_callback(
                            {
                                "file_index": int(idx),
                                "total_files": int(max(total_parts, 1)),
                                "file_name": detail_file_name,
                                "downloaded_bytes": int(last_downloaded),
                                "total_bytes": int(last_total),
                                "done": False,
                            }
                        )
                if "Downloading..." in line or "To:" in line:
                    self._log(f"[ONCE] {line}")
                now = time.time()
                if now - last_logged_at >= 20:
                    if parsed_progress:
                        self._log(
                            "[ONCE] Download progress "
                            f"split={split}: {last_downloaded}/{last_total} bytes"
                        )
                    else:
                        self._log(f"[ONCE] Download progress split={split}: waiting for size info")
                    last_logged_at = now

            return_code = proc.wait()
            last_error_tail = tail

            archives_in_split = 0
            for pattern in self.ARCHIVE_PATTERNS:
                archives_in_split += len(list(out_dir.glob(pattern)))
            if return_code != 0 and archives_in_split == 0:
                tail_block = "\n".join(last_error_tail[-20:]) if last_error_tail else "n/a"
                raise RuntimeError(
                    f"gdown failed for split={split}; no archives downloaded.\nLast output:\n{tail_block}"
                )
            if return_code != 0 and archives_in_split > 0:
                self._log(
                    f"[ONCE] gdown returned non-zero for split={split}, but found {archives_in_split} archives; continue"
                )
            if not parsed_progress:
                self._log(f"[ONCE] Download split={split} completed (size details unavailable)")
            if self.download_detail_progress_callback:
                self.download_detail_progress_callback(
                    {
                        "file_index": int(idx),
                        "total_files": int(max(total_parts, 1)),
                        "file_name": detail_file_name,
                        "downloaded_bytes": int(max(last_downloaded, last_total)),
                        "total_bytes": int(max(last_total, 1)),
                        "done": True,
                    }
                )

            completed_parts += 1
            self._report_download_progress(
                file_index=idx,
                total_files=max(total_parts, 1),
                downloaded_bytes=completed_parts,
                total_bytes=max(total_parts, 1),
                file_name=split,
                done=completed_parts >= total_parts,
            )

        total_bytes = 0
        archive_count = 0
        for path in self._discover_archives():
            archive_count += 1
            try:
                total_bytes += int(path.stat().st_size)
            except Exception:  # noqa: BLE001
                continue
        self._report_download_progress(
            file_index=max(total_parts, 1),
            total_files=max(total_parts, 1),
            downloaded_bytes=max(total_parts, 1),
            total_bytes=max(total_parts, 1),
            file_name="all-splits",
            done=True,
        )
        self._log(
            "[ONCE] Google Drive download done: "
            f"splits={len(selected_splits)}, archives={archive_count}, total_size={total_bytes} bytes"
        )

    def _safe_extract_member(self, tar: tarfile.TarFile, member: tarfile.TarInfo) -> None:
        target_path = (self.extract_dir / member.name).resolve()
        extract_root = self.extract_dir.resolve()
        if os.path.commonpath([str(extract_root), str(target_path)]) != str(extract_root):
            raise RuntimeError(f"Refusing to extract outside target dir: {member.name}")
        tar.extract(member, self.extract_dir)

    def _extract_archives_if_needed(self) -> None:
        archives = self._discover_archives()
        if not archives:
            self._log(f"[ONCE] No archives found in {self.tar_dir}; skip extraction")
            return

        total_archives = len(archives)
        for file_index, archive_path in enumerate(archives, start=1):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")

            marker_path = self.extract_dir / f".extracted_{archive_path.name}.ok"
            archive_size = int(archive_path.stat().st_size) if archive_path.exists() else 0
            if marker_path.exists():
                self._log(f"[ONCE] Skip extract {archive_path.name}: marker exists")
                self._report_extract_progress(
                    file_index=file_index,
                    total_files=total_archives,
                    file_name=archive_path.name,
                    extracted_bytes=archive_size,
                    total_bytes=archive_size,
                    extracted_files=0,
                    done=True,
                )
                continue

            self._log(
                f"[ONCE] Extract {file_index}/{total_archives}: {archive_path.name} ({archive_size} bytes)"
            )
            with tarfile.open(archive_path) as tar:
                members = tar.getmembers()
                total_bytes = sum(max(member.size, 0) for member in members if member.isfile())
                extracted_bytes = 0
                extracted_files = 0

                self._report_extract_progress(
                    file_index=file_index,
                    total_files=total_archives,
                    file_name=archive_path.name,
                    extracted_bytes=0,
                    total_bytes=total_bytes,
                    extracted_files=0,
                    done=False,
                )

                for member in tqdm(members, desc=f"Extract {archive_path.name}", dynamic_ncols=True):
                    if self._should_stop():
                        raise InterruptedError("Dataset installation cancelled by user")
                    self._safe_extract_member(tar, member)
                    if member.isfile():
                        extracted_files += 1
                        extracted_bytes += max(member.size, 0)
                        self._report_extract_progress(
                            file_index=file_index,
                            total_files=total_archives,
                            file_name=archive_path.name,
                            extracted_bytes=extracted_bytes,
                            total_bytes=total_bytes,
                            extracted_files=extracted_files,
                            done=False,
                        )

            marker_path.write_text("ok\n")
            self._report_extract_progress(
                file_index=file_index,
                total_files=total_archives,
                file_name=archive_path.name,
                extracted_bytes=archive_size,
                total_bytes=archive_size,
                extracted_files=extracted_files,
                done=True,
            )

    def _extract_single_archive_with_images(
        self, archive_path: Path, file_index: int, total_archives: int
    ) -> List[Path]:
        marker_path = self.extract_dir / f".extracted_{archive_path.name}.ok"
        archive_size = int(archive_path.stat().st_size) if archive_path.exists() else 0
        image_paths: List[Path] = []

        with tarfile.open(archive_path) as tar:
            members = tar.getmembers()
            if marker_path.exists():
                for member in members:
                    if not member.isfile():
                        continue
                    member_path = (self.extract_dir / member.name).resolve()
                    if member_path.suffix.lower() in self.IMAGE_SUFFIXES and member_path.exists():
                        image_paths.append(member_path)
                if not image_paths:
                    marker_path.unlink(missing_ok=True)
                    self._log(
                        f"[ONCE] Marker exists but no extracted files found; re-extract: {archive_path.name}"
                    )
                else:
                    self._log(f"[ONCE] Skip extract {archive_path.name}: marker exists")
                    self._report_extract_progress(
                        file_index=file_index,
                        total_files=total_archives,
                        file_name=archive_path.name,
                        extracted_bytes=archive_size,
                        total_bytes=archive_size,
                        extracted_files=len(image_paths),
                        done=True,
                    )
                    return image_paths

            total_bytes = sum(max(member.size, 0) for member in members if member.isfile())
            extracted_bytes = 0
            extracted_files = 0
            self._log(
                f"[ONCE] Extract {file_index}/{total_archives}: {archive_path.name} ({archive_size} bytes)"
            )
            self._report_extract_progress(
                file_index=file_index,
                total_files=total_archives,
                file_name=archive_path.name,
                extracted_bytes=0,
                total_bytes=total_bytes,
                extracted_files=0,
                done=False,
            )

            for member in tqdm(members, desc=f"Extract {archive_path.name}", dynamic_ncols=True):
                if self._should_stop():
                    raise InterruptedError("Dataset installation cancelled by user")
                self._safe_extract_member(tar, member)
                if not member.isfile():
                    continue
                extracted_files += 1
                extracted_bytes += max(member.size, 0)
                member_path = (self.extract_dir / member.name).resolve()
                if member_path.suffix.lower() in self.IMAGE_SUFFIXES:
                    image_paths.append(member_path)
                self._report_extract_progress(
                    file_index=file_index,
                    total_files=total_archives,
                    file_name=archive_path.name,
                    extracted_bytes=extracted_bytes,
                    total_bytes=total_bytes,
                    extracted_files=extracted_files,
                    done=False,
                )

        marker_path.write_text("ok\n")
        self._report_extract_progress(
            file_index=file_index,
            total_files=total_archives,
            file_name=archive_path.name,
            extracted_bytes=archive_size,
            total_bytes=archive_size,
            extracted_files=len(image_paths),
            done=True,
        )
        return image_paths

    def _detect_camera_raw(self, image_path: Path) -> Optional[str]:
        for candidate in [image_path.name, *image_path.parts]:
            match = self.CAMERA_RE.search(candidate)
            if match:
                return match.group(1).lower()
        # Some local ONCE archives contain per-camera image files without camera
        # tokens in file/path names. If user selected exactly one camera, infer it.
        if self.selected_cameras and len(self.selected_cameras) == 1:
            return next(iter(self.selected_cameras))
        return None

    def _extract_timestamp(self, image_path: Path, fallback: int) -> int:
        match = self.TIMESTAMP_RE.search(image_path.stem)
        if match:
            try:
                return int(match.group(1))
            except Exception:  # noqa: BLE001
                return fallback
        return fallback

    def _scene_id_for_path(self, image_path: Path, camera_raw: str) -> str:
        rel = image_path.relative_to(self.extract_dir)
        dir_parts = list(rel.parts[:-1])
        cleaned: List[str] = []
        removed_camera = False
        for part in dir_parts:
            lowered = part.lower()
            if not removed_camera and lowered == camera_raw:
                removed_camera = True
                continue
            cleaned.append(part)

        if not cleaned:
            return "root"
        return "/".join(cleaned)

    def _build_episodes(self) -> Dict[str, List[Dict[str, Any]]]:
        all_images = sorted(
            path
            for path in self.extract_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in self.IMAGE_SUFFIXES
        )
        self._log(f"[ONCE] Index start: images={len(all_images)}")

        grouped: Dict[str, List[Dict[str, Any]]] = {}
        skipped_no_camera = 0
        skipped_by_selection = 0
        for idx, image_path in enumerate(tqdm(all_images, desc="Index ONCE", dynamic_ncols=True), start=1):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")

            camera_raw = self._detect_camera_raw(image_path)
            if not camera_raw:
                skipped_no_camera += 1
                continue
            if self.selected_cameras and camera_raw not in self.selected_cameras:
                skipped_by_selection += 1
                continue

            scene_id = self._scene_id_for_path(image_path, camera_raw)
            episode_key = f"{scene_id}|{camera_raw}"
            grouped.setdefault(episode_key, []).append(
                {
                    "timestamp": self._extract_timestamp(image_path, fallback=idx),
                    "image_path": image_path,
                    "camera_raw": camera_raw,
                    "scene_id": scene_id,
                }
            )

        episodes: Dict[str, List[Dict[str, Any]]] = {}
        for episode_key, rows in grouped.items():
            rows.sort(key=lambda row: (int(row["timestamp"]), str(row["image_path"])))
            selected_rows = rows[:: self.step_frames] if self.step_frames > 1 else rows
            if selected_rows:
                episodes[episode_key] = selected_rows

        total_rows = sum(len(rows) for rows in episodes.values())
        self._log(
            "[ONCE] Index done: "
            f"episodes={len(episodes)}, rows_after_step={total_rows}, step_frames={self.step_frames}, "
            f"skipped_no_camera={skipped_no_camera}, skipped_by_selection={skipped_by_selection}"
        )
        return episodes

    def process_episode(self, episode_key: str) -> pd.DataFrame:
        rows = self.episodes.get(episode_key, [])
        out_rows: List[Dict[str, Any]] = []

        for row in rows:
            source_path = Path(str(row["image_path"]))
            camera_raw = str(row["camera_raw"])
            scene_id = str(row["scene_id"])
            timestamp = int(row["timestamp"])

            scene_safe = scene_id.replace("/", "__")
            link_dir = self.out_dir / scene_safe / camera_raw
            link_dir.mkdir(parents=True, exist_ok=True)

            link_name = source_path.name
            dst_path = link_dir / link_name
            if not dst_path.exists():
                os.symlink(source_path.resolve(), dst_path)

            out_rows.append(
                {
                    "timestamp": timestamp,
                    "camera_name": self.REVERSE_CAMERA_TO_LABEL.get(camera_raw, camera_raw.upper()),
                    "dataset_type": "once",
                    "source_link": f"local://{source_path.relative_to(self.extract_dir)}",
                    "image_path": str(dst_path),
                }
            )

        return pd.DataFrame(out_rows, columns=OUTPUT_COLUMNS)

    def _build_df_from_images(self, image_paths: List[Path]) -> pd.DataFrame:
        grouped: Dict[str, List[Dict[str, Any]]] = {}
        skipped_no_camera = 0
        skipped_by_selection = 0

        for idx, image_path in enumerate(sorted(image_paths), start=1):
            if not image_path.exists():
                continue
            camera_raw = self._detect_camera_raw(image_path)
            if not camera_raw:
                skipped_no_camera += 1
                continue
            if self.selected_cameras and camera_raw not in self.selected_cameras:
                skipped_by_selection += 1
                continue
            scene_id = self._scene_id_for_path(image_path, camera_raw)
            episode_key = f"{scene_id}|{camera_raw}"
            grouped.setdefault(episode_key, []).append(
                {
                    "timestamp": self._extract_timestamp(image_path, fallback=idx),
                    "image_path": image_path,
                    "camera_raw": camera_raw,
                    "scene_id": scene_id,
                }
            )

        out_rows: List[Dict[str, Any]] = []
        for rows in grouped.values():
            rows.sort(key=lambda row: (int(row["timestamp"]), str(row["image_path"])))
            selected_rows = rows[:: self.step_frames] if self.step_frames > 1 else rows
            for row in selected_rows:
                source_path = Path(str(row["image_path"]))
                camera_raw = str(row["camera_raw"])
                scene_id = str(row["scene_id"])
                timestamp = int(row["timestamp"])
                scene_safe = scene_id.replace("/", "__")
                link_dir = self.out_dir / scene_safe / camera_raw
                link_dir.mkdir(parents=True, exist_ok=True)
                dst_path = link_dir / source_path.name
                if not dst_path.exists():
                    os.symlink(source_path.resolve(), dst_path)
                out_rows.append(
                    {
                        "timestamp": timestamp,
                        "camera_name": self.REVERSE_CAMERA_TO_LABEL.get(camera_raw, camera_raw.upper()),
                        "dataset_type": "once",
                        "source_link": f"local://{source_path.relative_to(self.extract_dir)}",
                        "image_path": str(dst_path),
                    }
                )

        self._log(
            "[ONCE] Archive sampling done: "
            f"episodes={len(grouped)}, rows={len(out_rows)}, "
            f"skipped_no_camera={skipped_no_camera}, skipped_by_selection={skipped_by_selection}"
        )
        return pd.DataFrame(out_rows, columns=OUTPUT_COLUMNS)

    def __iter__(self):
        return self

    def __next__(self):
        if self.streaming_mode:
            if self.iteration >= len(self.archives):
                raise StopIteration
            archive_index = self.iteration + 1
            archive_path = self.archives[self.iteration]
            self.iteration += 1
            self._log(f"[ONCE] Process archive {archive_index}/{len(self.archives)}: {archive_path.name}")
            image_paths = self._extract_single_archive_with_images(
                archive_path, file_index=archive_index, total_archives=len(self.archives)
            )
            return self._build_df_from_images(image_paths)

        if self.iteration >= len(self.episode_keys):
            raise StopIteration

        episode_key = self.episode_keys[self.iteration]
        self.iteration += 1
        if self.iteration == 1 or self.iteration % 20 == 0 or self.iteration == len(self.episode_keys):
            self._log(f"[ONCE] Process episode {self.iteration}/{len(self.episode_keys)}: {episode_key}")

        return self.process_episode(episode_key)

    def __len__(self):
        if self.streaming_mode:
            return len(self.archives)
        return len(self.episode_keys)


def main() -> None:
    parser = argparse.ArgumentParser(description="Process ONCE dataset and upload to storage")
    parser.add_argument("--tar-dir", type=str, default=str(DATA_FOLDER / "tars"))
    parser.add_argument("--extract-dir", type=str, default=str(DATA_FOLDER / "extracted"))
    parser.add_argument("--out-dir", type=str, default=str(DATA_FOLDER / "filtered"))
    parser.add_argument("--cameras", nargs="+", default=["FRONT"])
    parser.add_argument("--resample-seconds", type=float, default=5.0)
    parser.add_argument("--fps", type=int, default=10)
    parser.add_argument("--download-splits", nargs="+", default=list(OncePreprocessor.SPLIT_GDRIVE_FOLDERS.keys()))
    parser.add_argument("--use-local-archives", action="store_true")
    parser.add_argument("--download-from-gdrive", action="store_true")
    parser.add_argument("--bucket", type=str, default="once")
    parser.add_argument("--keep-local-images", action="store_true")
    args = parser.parse_args()

    preprocessor = OncePreprocessor(
        tar_dir=args.tar_dir,
        extract_dir=args.extract_dir,
        out_dir=args.out_dir,
        cameras=args.cameras,
        resample_seconds=args.resample_seconds,
        fps=args.fps,
        download_splits=args.download_splits,
        use_local_archives=bool(args.use_local_archives),
        download_from_gdrive=bool(args.download_from_gdrive) or not bool(args.use_local_archives),
        remove_local_images=not args.keep_local_images,
    )
    preprocessor.download_to_storage(bucket=args.bucket)


if __name__ == "__main__":
    main()
