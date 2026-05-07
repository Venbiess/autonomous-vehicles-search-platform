from __future__ import annotations

import argparse
import fnmatch
import os
import re
import tarfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote

import cv2
import pandas as pd
import requests

from configs.common import DATA_DIR
from .preprocessor import Preprocessor

DATA_FOLDER = Path(DATA_DIR) / "drivingdojo"
OUTPUT_COLUMNS = [
    "timestamp",
    "camera_name",
    "dataset_type",
    "source_link",
    "image_path",
]


class DrivingDojoPreprocessor(Preprocessor):
    VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".avi", ".webm"}
    IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
    ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".tar")
    HF_API_BASE = "https://huggingface.co/api"
    HF_DATASET_BASE = "https://huggingface.co/datasets"
    CHUNK_SIZE = 8 * 1024 * 1024
    LOG_PROGRESS_EVERY_SEC = 20
    FRAME_NUMBER_RE = re.compile(r"(\d+)")

    def __init__(
        self,
        resample_seconds: float = 5.0,
        camera_name: str = "FRONT",
        repo_id: str = "Yuqi1997/DrivingDojo",
        source_dir: Optional[str] = None,
        videos_dir: Optional[str] = None,
        extract_dir: Optional[str] = None,
        out_dir: Optional[str] = None,
        allow_patterns: Optional[List[str]] = None,
        download_from_hf: bool = True,
        extract_archives: bool = True,
        hf_token: Optional[str] = None,
        fps: int = 10,
        max_workers: int = 4,
        limit_videos: Optional[int] = None,
        remove_local_images: bool = True,
        stream_upload_by_archive: bool = True,
        install_log_callback: Optional[Callable[[str], None]] = None,
        download_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        extract_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        cancel_requested_callback: Optional[Callable[[], bool]] = None,
    ):
        super().__init__(remove_local_images=remove_local_images)
        self.resample_seconds = max(0.0, float(resample_seconds or 0.0))
        self.camera_name = str(camera_name or "FRONT").strip().upper() or "FRONT"
        self.repo_id = str(repo_id or "Yuqi1997/DrivingDojo").strip() or "Yuqi1997/DrivingDojo"
        self.source_dir = Path(source_dir) if source_dir else DATA_FOLDER / "source"
        self.videos_dir = Path(videos_dir) if videos_dir else self.source_dir / "videos"
        self.extract_dir = Path(extract_dir) if extract_dir else self.source_dir / "extracted"
        self.out_dir = Path(out_dir) if out_dir else DATA_FOLDER / "filtered"
        self.allow_patterns = allow_patterns or ["videos/*"]
        self.download_from_hf = bool(download_from_hf)
        self.extract_archives = bool(extract_archives)
        self.hf_token = (
            str(hf_token or os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_HUB_TOKEN") or "").strip()
            or None
        )
        self.fps = max(1, int(fps or 1))
        self.step_frames = max(1, int(round(self.resample_seconds * self.fps)))
        self.max_workers = max(1, int(max_workers or 1))
        self.limit_videos = int(limit_videos) if limit_videos is not None else None
        self.stream_upload_by_archive = bool(stream_upload_by_archive)
        self._hf_sizes_cache: Optional[Dict[str, int]] = None
        self._hf_file_size_cache: Dict[str, int] = {}
        self._stream_expected_sizes: Dict[str, int] = {}

        self.install_log_callback = install_log_callback
        self.download_progress_callback = download_progress_callback
        self.extract_progress_callback = extract_progress_callback
        self.cancel_requested_callback = cancel_requested_callback

        DATA_FOLDER.mkdir(parents=True, exist_ok=True)
        self.source_dir.mkdir(parents=True, exist_ok=True)
        self.videos_dir.mkdir(parents=True, exist_ok=True)
        self.extract_dir.mkdir(parents=True, exist_ok=True)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.local_source_root = self.extract_dir
        self.local_output_root = self.out_dir

        self._log(
            "[DrivingDojo] Init: "
            f"resample_seconds={self.resample_seconds}, fps={self.fps}, step_frames={self.step_frames}, "
            f"camera_name={self.camera_name}, download_from_hf={self.download_from_hf}, "
            f"extract_archives={self.extract_archives}, stream_upload_by_archive={self.stream_upload_by_archive}, "
            f"repo_id={self.repo_id}, videos_dir={self.videos_dir}"
        )

        videos, archives = self._prepare_sources()
        self.streaming_mode = bool(
            self.stream_upload_by_archive and self.extract_archives and len(archives) > 0 and len(videos) == 0
        )
        self.archives_for_stream: List[Path] = list(archives) if self.streaming_mode else []
        self.episodes: List[Dict[str, Any]] = []
        if self.streaming_mode:
            if self.limit_videos is not None:
                self.archives_for_stream = self.archives_for_stream[: max(0, int(self.limit_videos))]
        else:
            if self.extract_archives and archives:
                self._extract_archives_if_needed(archives)
            self.episodes = self._build_episodes()
            if self.limit_videos is not None:
                self.episodes = self.episodes[: max(0, int(self.limit_videos))]

        if not self.streaming_mode and not self.episodes:
            raise FileNotFoundError(
                f"No DrivingDojo scenes found in {self.source_dir}. "
                "Expected video files (*.mp4/...) or extracted image directories from videos_*.tar.gz archives."
            )

        if self.streaming_mode:
            self.total_source_bytes = sum(
                int(path.stat().st_size) for path in self.archives_for_stream if path.exists()
            )
        else:
            self.total_source_bytes = sum(int(item.get("source_size", 0) or 0) for item in self.episodes)
        self.processed_source_bytes = 0
        self.processed_scenes = 0
        self.iteration = 0

        modes = (
            {"images(stream)"}
            if self.streaming_mode
            else {str(item.get("mode", "")) for item in self.episodes}
        )
        self._log(
            f"[DrivingDojo] Ready: episodes={len(self)}, modes={sorted(modes)}, "
            f"total_source_bytes={self.total_source_bytes}"
        )

    def _should_stop(self) -> bool:
        return bool(self.cancel_requested_callback and self.cancel_requested_callback())

    def _log(self, message: str) -> None:
        print(message, flush=True)
        if self.install_log_callback:
            self.install_log_callback(message)

    def _format_bytes(self, value: int) -> str:
        n = float(max(int(value or 0), 0))
        units = ["B", "KB", "MB", "GB", "TB"]
        idx = 0
        while n >= 1024.0 and idx < len(units) - 1:
            n /= 1024.0
            idx += 1
        return f"{n:.2f} {units[idx]}"

    def _report_download_progress(
        self,
        file_index: int,
        total_files: int,
        downloaded_bytes: int,
        total_bytes: int,
        file_name: str,
        download_label: str = "",
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
                "download_label": str(download_label or ""),
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
                "file_index": int(max(file_index, 0)),
                "total_files": int(max(total_files, 1)),
                "file_name": str(file_name),
                "extracted_bytes": int(max(extracted_bytes, 0)),
                "total_bytes": int(max(total_bytes, 0)),
                "extracted_files": int(max(extracted_files, 0)),
                "done": bool(done),
            }
        )

    def _prepare_sources(self) -> tuple[List[Path], List[Path]]:
        videos = self._discover_videos(self.videos_dir)
        archives = self._discover_archives()

        if videos:
            self._log(f"[DrivingDojo] Using local videos: found={len(videos)}")
            return videos, archives

        if self.download_from_hf and self.extract_archives and self.stream_upload_by_archive:
            archives = self._prepare_stream_archives_from_hf(archives)

        if self.download_from_hf and not (self.extract_archives and self.stream_upload_by_archive):
            self._download_from_hf()
            archives = self._discover_archives()
            videos = self._discover_videos(self.videos_dir)
            if videos:
                self._log(f"[DrivingDojo] Downloaded videos directly: found={len(videos)}")
                return videos, archives

        if self.extract_archives and archives:
            if self.stream_upload_by_archive:
                self._log("[DrivingDojo] Archive pre-validation deferred to per-archive processing")
            else:
                self._validate_archives_before_extract(archives)
        return videos, archives

    def _archive_rel_name(self, archive_path: Path) -> str:
        try:
            rel = archive_path.relative_to(self.source_dir)
            return str(rel).replace("\\", "/")
        except Exception:
            return archive_path.name

    def _prepare_stream_archives_from_hf(self, local_archives: List[Path]) -> List[Path]:
        if self._should_stop():
            raise InterruptedError("Dataset installation cancelled by user")

        siblings: List[Dict[str, Any]]
        try:
            siblings = self._hf_dataset_siblings()
        except requests.HTTPError as exc:
            status = int(exc.response.status_code) if exc.response is not None else 0
            details = exc.response.text if exc.response is not None else str(exc)
            if status in {401, 403}:
                raise RuntimeError(
                    "DrivingDojo archive listing failed. Dataset is gated or token is invalid. "
                    "Accept access on Hugging Face and pass hf_token (read scope). "
                    f"Details: HTTP {status}: {details}"
                ) from exc
            raise RuntimeError(
                "DrivingDojo archive listing failed while reading dataset metadata from Hugging Face. "
                f"Details: HTTP {status}: {details}"
            ) from exc
        except Exception as exc:
            raise RuntimeError(
                "DrivingDojo archive listing failed. "
                "Dataset may be gated: accept access conditions on Hugging Face and provide HF token. "
                f"Details: {exc}"
            ) from exc

        planned: List[Path] = []
        seen: set[str] = set()
        expected_sizes: Dict[str, int] = {}
        for item in siblings:
            filename = str(item.get("rfilename", "") or "").strip()
            if not filename:
                continue
            if not any(fnmatch.fnmatch(filename, pattern) for pattern in self.allow_patterns):
                continue
            if not self._is_archive_name(filename):
                continue
            size = int(item.get("size", 0) or 0)
            if size <= 0:
                size = self._hf_head_size(filename)
            target = (self.source_dir / filename).resolve()
            target.parent.mkdir(parents=True, exist_ok=True)
            planned.append(target)
            seen.add(filename)
            if size > 0:
                expected_sizes[filename] = size
                self._hf_file_size_cache[filename] = size

        for local_archive in local_archives:
            rel_name = self._archive_rel_name(local_archive)
            if rel_name in seen:
                continue
            planned.append(local_archive)
            if local_archive.exists():
                expected_sizes.setdefault(rel_name, int(local_archive.stat().st_size))

        if planned:
            self._stream_expected_sizes = expected_sizes
            self._log(f"[DrivingDojo] Stream archive plan: total={len(planned)}")
            return sorted(planned, key=lambda p: self._archive_rel_name(p))
        return local_archives

    def _validate_archives_before_extract(self, archives: List[Path]) -> None:
        if not archives:
            return
        if not self.download_from_hf:
            self._log("[DrivingDojo] Skip remote archive validation: download_from_hf=false")
            return

        expected_sizes: Dict[str, int] = {}
        try:
            expected_sizes = self._hf_archive_size_map()
        except Exception as exc:
            self._log(f"[DrivingDojo] Skip pre-validation: failed to fetch remote sizes ({exc})")
            expected_sizes = {}
        if not expected_sizes:
            self._log("[DrivingDojo] Remote archive size map is empty; will query sizes per archive")

        checked = 0
        mismatched = 0
        total_archives = len(archives)
        for file_index, archive_path in enumerate(archives, start=1):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")

            rel = archive_path.relative_to(self.source_dir)
            filename = str(rel).replace("\\", "/")
            expected_size = int(expected_sizes.get(filename, 0) or 0)
            if expected_size <= 0:
                expected_size = self._hf_head_size(filename)
                if expected_size > 0:
                    expected_sizes[filename] = expected_size
            if expected_size <= 0:
                self._log(f"[DrivingDojo] Skip size check for {filename}: remote size unknown")
                continue

            checked += 1
            local_size = int(archive_path.stat().st_size) if archive_path.exists() else 0
            if local_size == expected_size:
                continue

            mismatched += 1
            self._log(
                f"[DrivingDojo] Archive size mismatch: {filename} "
                f"(local={self._format_bytes(local_size)}, expected={self._format_bytes(expected_size)})"
            )
            self._recover_corrupted_archive(
                archive_path,
                expected_size=expected_size,
                file_index=file_index,
                total_files=total_archives,
            )
            marker_path = self.extract_dir / f".extracted_{archive_path.name}.ok"
            marker_path.unlink(missing_ok=True)

        self._log(
            f"[DrivingDojo] Archive pre-validation done: checked={checked}, mismatched={mismatched}"
        )

    def _download_from_hf(self) -> None:
        if self._should_stop():
            raise InterruptedError("Dataset installation cancelled by user")

        self._log(
            f"[DrivingDojo] Download from HF dataset repo={self.repo_id}, allow_patterns={self.allow_patterns}"
        )

        try:
            siblings = self._hf_dataset_siblings()
        except requests.HTTPError as exc:
            status = int(exc.response.status_code) if exc.response is not None else 0
            details = exc.response.text if exc.response is not None else str(exc)
            if status in {401, 403}:
                raise RuntimeError(
                    "DrivingDojo download failed. Dataset is gated or token is invalid. "
                    "Accept access on Hugging Face and pass hf_token (read scope). "
                    f"Details: HTTP {status}: {details}"
                ) from exc
            raise RuntimeError(
                "DrivingDojo download failed while reading dataset metadata from Hugging Face. "
                f"Details: HTTP {status}: {details}"
            ) from exc
        except Exception as exc:
            details = str(exc)
            raise RuntimeError(
                "DrivingDojo download failed. "
                "Dataset may be gated: accept access conditions on Hugging Face and provide HF token. "
                f"Details: {details}"
            ) from exc

        candidate_files: List[Dict[str, Any]] = []
        for item in siblings:
            filename = str(item.get("rfilename", "") or "").strip()
            if not filename:
                continue
            if not any(fnmatch.fnmatch(filename, pattern) for pattern in self.allow_patterns):
                continue
            if not (
                any(filename.lower().endswith(sfx) for sfx in self.ARCHIVE_SUFFIXES)
                or Path(filename).suffix.lower() in self.VIDEO_SUFFIXES
            ):
                continue
            size_raw = item.get("size", 0)
            try:
                size = max(int(size_raw or 0), 0)
            except Exception:
                size = 0
            if size <= 0:
                size = self._hf_head_size(filename)
            candidate_files.append({"filename": filename, "size": size})

        if not candidate_files:
            raise FileNotFoundError(
                f"No downloadable files matched allow_patterns={self.allow_patterns} in repo {self.repo_id}"
            )

        total_files = len(candidate_files)
        total_bytes = sum(int(item["size"]) for item in candidate_files)
        self._log(
            f"[DrivingDojo] Download plan: files={total_files}, total={self._format_bytes(total_bytes)}"
        )
        downloaded_bytes_total = 0
        headers = self._hf_headers()

        for file_index, item in enumerate(candidate_files, start=1):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")

            filename = str(item["filename"])
            expected_size = int(item["size"])
            target_path = self.source_dir / filename
            part_path = Path(str(target_path) + ".part")
            target_path.parent.mkdir(parents=True, exist_ok=True)

            local_complete = (
                target_path.exists()
                and (
                    (expected_size > 0 and int(target_path.stat().st_size) == expected_size)
                    or (
                        expected_size <= 0
                        and not self._is_archive_name(filename)
                        and int(target_path.stat().st_size) > 0
                    )
                )
            )
            if local_complete:
                local_size = int(target_path.stat().st_size)
                downloaded_bytes_total += local_size
                self._log(
                    f"[DrivingDojo] Skip download {file_index}/{total_files}: {filename} "
                    f"(already exists, {self._format_bytes(local_size)})"
                )
                self._report_download_progress(
                    file_index=file_index,
                    total_files=total_files,
                    downloaded_bytes=downloaded_bytes_total,
                    total_bytes=max(total_bytes, downloaded_bytes_total),
                    file_name=Path(filename).name,
                    done=True,
                )
                continue

            if target_path.exists() and not part_path.exists():
                target_size = int(target_path.stat().st_size)
                if target_size > 0:
                    os.replace(target_path, part_path)
                    self._log(
                        f"[DrivingDojo] Found partial file, continue as .part: {filename} "
                        f"({self._format_bytes(target_size)})"
                    )

            resume_from = int(part_path.stat().st_size) if part_path.exists() else 0
            if expected_size > 0 and resume_from > expected_size:
                part_path.unlink(missing_ok=True)
                resume_from = 0

            url = self._hf_hub_file_url(filename)
            self._log(
                f"[DrivingDojo] Download file {file_index}/{total_files}: {filename} "
                f"(resume_from={self._format_bytes(resume_from)})"
            )

            request_headers = dict(headers)
            if resume_from > 0:
                request_headers["Range"] = f"bytes={resume_from}-"

            response = requests.get(url, headers=request_headers, stream=True, timeout=60)
            if resume_from > 0 and response.status_code == 200:
                response.close()
                self._log(f"[DrivingDojo] Server did not honor Range for {filename}, restart from zero")
                part_path.unlink(missing_ok=True)
                resume_from = 0
                request_headers = dict(headers)
                response = requests.get(url, headers=request_headers, stream=True, timeout=60)

            response.raise_for_status()
            if expected_size <= 0:
                expected_size = self._response_total_size(response, resume_from=resume_from)
            if expected_size > 0 and int(item["size"] or 0) <= 0:
                total_bytes += expected_size

            file_downloaded = resume_from
            self._report_download_progress(
                file_index=file_index,
                total_files=total_files,
                downloaded_bytes=downloaded_bytes_total + file_downloaded,
                total_bytes=max(total_bytes, downloaded_bytes_total + max(expected_size, file_downloaded)),
                file_name=Path(filename).name,
                done=False,
            )

            log_last_at = 0.0
            with response, open(part_path, "ab" if resume_from > 0 else "wb") as fp:
                for chunk in response.iter_content(chunk_size=self.CHUNK_SIZE):
                    if self._should_stop():
                        raise InterruptedError("Dataset installation cancelled by user")
                    if not chunk:
                        continue
                    fp.write(chunk)
                    file_downloaded += len(chunk)
                    self._report_download_progress(
                        file_index=file_index,
                        total_files=total_files,
                        downloaded_bytes=downloaded_bytes_total + file_downloaded,
                        total_bytes=max(total_bytes, downloaded_bytes_total + max(expected_size, file_downloaded)),
                        file_name=Path(filename).name,
                        done=False,
                    )
                    now = time.time()
                    if (now - log_last_at) >= self.LOG_PROGRESS_EVERY_SEC:
                        if expected_size > 0:
                            percent = min((file_downloaded / expected_size) * 100.0, 100.0)
                            self._log(
                                f"[DrivingDojo] Download progress {filename}: {percent:.1f}% "
                                f"({self._format_bytes(file_downloaded)} / {self._format_bytes(expected_size)})"
                            )
                        else:
                            self._log(
                                f"[DrivingDojo] Download progress {filename}: {self._format_bytes(file_downloaded)}"
                            )
                        log_last_at = now

            final_size = int(part_path.stat().st_size) if part_path.exists() else file_downloaded
            if expected_size > 0 and final_size != expected_size:
                raise RuntimeError(
                    f"Incomplete download for {filename}: got {final_size} bytes, expected {expected_size}"
                )
            os.replace(part_path, target_path)
            downloaded_bytes_total += final_size
            self._report_download_progress(
                file_index=file_index,
                total_files=total_files,
                downloaded_bytes=downloaded_bytes_total,
                total_bytes=max(total_bytes, downloaded_bytes_total),
                file_name=Path(filename).name,
                done=True,
            )
            self._log(
                f"[DrivingDojo] Download done {file_index}/{total_files}: {filename} "
                f"({self._format_bytes(final_size)})"
            )

    def _is_archive_name(self, name: str) -> bool:
        lowered = str(name).lower()
        return any(lowered.endswith(sfx) for sfx in self.ARCHIVE_SUFFIXES)

    def _discover_archives(self) -> List[Path]:
        out: List[Path] = []
        for p in self.videos_dir.rglob("*"):
            if p.is_file() and self._is_archive_name(p.name):
                out.append(p.resolve())
        return sorted(out)

    def _safe_extract_member(self, tar: tarfile.TarFile, member: tarfile.TarInfo) -> None:
        target_path = (self.extract_dir / member.name).resolve()
        extract_root = self.extract_dir.resolve()
        if os.path.commonpath([str(extract_root), str(target_path)]) != str(extract_root):
            raise RuntimeError(f"Refusing to extract outside target dir: {member.name}")
        tar.extract(member, self.extract_dir)

    def _extract_archives_if_needed(self, archives: List[Path]) -> None:
        total_archives = len(archives)
        if total_archives == 0:
            return
        self._log(f"[DrivingDojo] Extract archives: total={total_archives}")

        for file_index, archive_path in enumerate(archives, start=1):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")

            marker_path = self.extract_dir / f".extracted_{archive_path.name}.ok"
            archive_size = int(archive_path.stat().st_size) if archive_path.exists() else 0
            if marker_path.exists():
                self._log(
                    f"[DrivingDojo] Skip extract {file_index}/{total_archives}: {archive_path.name} (marker exists)"
                )
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
                f"[DrivingDojo] Extract {file_index}/{total_archives}: {archive_path.name} "
                f"({self._format_bytes(archive_size)})"
            )

            extracted_bytes = 0
            extracted_files = 0
            total_bytes = max(archive_size, 1)
            log_last_at = 0.0
            self._report_extract_progress(
                file_index=file_index,
                total_files=total_archives,
                file_name=archive_path.name,
                extracted_bytes=0,
                total_bytes=total_bytes,
                extracted_files=0,
                done=False,
            )

            def _extract_once() -> None:
                nonlocal extracted_bytes, extracted_files, log_last_at
                with tarfile.open(archive_path, "r:*") as tar:
                    for member in tar:
                        if self._should_stop():
                            raise InterruptedError("Dataset installation cancelled by user")
                        if not member.isfile():
                            continue
                        member_name = str(member.name)
                        suffix = Path(member_name).suffix.lower()
                        if suffix not in self.IMAGE_SUFFIXES:
                            continue

                        self._safe_extract_member(tar, member)
                        extracted_files += 1
                        extracted_bytes += max(int(member.size or 0), 0)
                        self._report_extract_progress(
                            file_index=file_index,
                            total_files=total_archives,
                            file_name=archive_path.name,
                            extracted_bytes=extracted_bytes,
                            total_bytes=total_bytes,
                            extracted_files=extracted_files,
                            done=False,
                        )

                        now = time.time()
                        if (now - log_last_at) >= self.LOG_PROGRESS_EVERY_SEC:
                            percent = min((extracted_bytes / total_bytes) * 100.0, 100.0)
                            self._log(
                                f"[DrivingDojo] Extract progress {archive_path.name}: {percent:.1f}% "
                                f"({self._format_bytes(extracted_bytes)} / {self._format_bytes(total_bytes)}), "
                                f"files={extracted_files}"
                            )
                            log_last_at = now

            try:
                _extract_once()
            except EOFError as exc:
                self._log(f"[DrivingDojo] Corrupted archive detected: {archive_path.name} ({exc})")
                self._recover_corrupted_archive(
                    archive_path,
                    file_index=file_index,
                    total_files=total_archives,
                )
                self._log(f"[DrivingDojo] Retry extract after recovery: {archive_path.name}")
                extracted_bytes = 0
                extracted_files = 0
                log_last_at = 0.0
                self._report_extract_progress(
                    file_index=file_index,
                    total_files=total_archives,
                    file_name=archive_path.name,
                    extracted_bytes=0,
                    total_bytes=total_bytes,
                    extracted_files=0,
                    done=False,
                )
                _extract_once()

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
            self._log(
                f"[DrivingDojo] Extract done {file_index}/{total_archives}: {archive_path.name} "
                f"(files={extracted_files})"
            )

    def _extract_single_archive_with_images(
        self, archive_path: Path, file_index: int, total_archives: int
    ) -> List[Path]:
        marker_path = self.extract_dir / f".extracted_{archive_path.name}.ok"
        archive_size = int(archive_path.stat().st_size) if archive_path.exists() else 0
        image_paths: List[Path] = []

        if marker_path.exists():
            with tarfile.open(archive_path, "r:*") as tar:
                for member in tar:
                    if not member.isfile():
                        continue
                    suffix = Path(str(member.name)).suffix.lower()
                    if suffix not in self.IMAGE_SUFFIXES:
                        continue
                    out_path = (self.extract_dir / str(member.name)).resolve()
                    if out_path.exists():
                        image_paths.append(out_path)
            if not image_paths:
                marker_path.unlink(missing_ok=True)
                self._log(
                    f"[DrivingDojo] Marker exists but no extracted files found; re-extract: {archive_path.name}"
                )
            else:
                self._log(
                    f"[DrivingDojo] Skip extract {file_index}/{total_archives}: {archive_path.name} (marker exists)"
                )
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

        self._log(
            f"[DrivingDojo] Extract {file_index}/{total_archives}: {archive_path.name} "
            f"({self._format_bytes(archive_size)})"
        )
        extracted_bytes = 0
        extracted_files = 0
        total_bytes = max(archive_size, 1)
        log_last_at = 0.0
        self._report_extract_progress(
            file_index=file_index,
            total_files=total_archives,
            file_name=archive_path.name,
            extracted_bytes=0,
            total_bytes=total_bytes,
            extracted_files=0,
            done=False,
        )

        def _extract_once() -> None:
            nonlocal extracted_bytes, extracted_files, log_last_at
            with tarfile.open(archive_path, "r:*") as tar:
                for member in tar:
                    if self._should_stop():
                        raise InterruptedError("Dataset installation cancelled by user")
                    if not member.isfile():
                        continue
                    member_name = str(member.name)
                    suffix = Path(member_name).suffix.lower()
                    if suffix not in self.IMAGE_SUFFIXES:
                        continue
                    self._safe_extract_member(tar, member)
                    out_path = (self.extract_dir / member_name).resolve()
                    if out_path.exists():
                        image_paths.append(out_path)
                    extracted_files += 1
                    extracted_bytes += max(int(member.size or 0), 0)
                    self._report_extract_progress(
                        file_index=file_index,
                        total_files=total_archives,
                        file_name=archive_path.name,
                        extracted_bytes=extracted_bytes,
                        total_bytes=total_bytes,
                        extracted_files=extracted_files,
                        done=False,
                    )
                    now = time.time()
                    if (now - log_last_at) >= self.LOG_PROGRESS_EVERY_SEC:
                        percent = min((extracted_bytes / total_bytes) * 100.0, 100.0)
                        self._log(
                            f"[DrivingDojo] Extract progress {archive_path.name}: {percent:.1f}% "
                            f"({self._format_bytes(extracted_bytes)} / {self._format_bytes(total_bytes)}), "
                            f"files={extracted_files}"
                        )
                        log_last_at = now

        try:
            _extract_once()
        except EOFError as exc:
            self._log(f"[DrivingDojo] Corrupted archive detected: {archive_path.name} ({exc})")
            self._recover_corrupted_archive(
                archive_path,
                file_index=file_index,
                total_files=total_archives,
            )
            self._log(f"[DrivingDojo] Retry extract after recovery: {archive_path.name}")
            extracted_bytes = 0
            extracted_files = 0
            log_last_at = 0.0
            image_paths = []
            self._report_extract_progress(
                file_index=file_index,
                total_files=total_archives,
                file_name=archive_path.name,
                extracted_bytes=0,
                total_bytes=total_bytes,
                extracted_files=0,
                done=False,
            )
            _extract_once()

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
        self._log(
            f"[DrivingDojo] Extract done {file_index}/{total_archives}: {archive_path.name} "
            f"(files={extracted_files})"
        )
        return image_paths

    def _build_df_from_extracted_images(self, image_paths: List[Path]) -> pd.DataFrame:
        grouped: Dict[str, List[Path]] = {}
        for path in image_paths:
            if not path.exists():
                continue
            rel = path.relative_to(self.extract_dir)
            scene = rel.parts[0] if len(rel.parts) > 1 else rel.stem
            grouped.setdefault(scene, []).append(path)

        rows: List[Dict[str, Any]] = []
        for scene_id, paths in grouped.items():
            paths.sort(key=lambda x: self._frame_number_from_name(x, 0))
            selected = paths[:: self.step_frames] if self.step_frames > 1 else paths
            episode_out_dir = self.out_dir / scene_id
            episode_out_dir.mkdir(parents=True, exist_ok=True)
            for idx, src in enumerate(selected):
                frame_no = self._frame_number_from_name(src, idx)
                timestamp_ms = int(round((frame_no / max(float(self.fps), 1e-6)) * 1000.0))
                dst = episode_out_dir / src.name
                if not dst.exists():
                    os.symlink(src.resolve(), dst)
                rel = src.relative_to(self.extract_dir)
                rows.append(
                    {
                        "timestamp": timestamp_ms,
                        "camera_name": self.camera_name,
                        "dataset_type": "drivingdojo",
                        "source_link": f"local://{rel}",
                        "image_path": str(dst),
                    }
                )

        return pd.DataFrame(rows, columns=OUTPUT_COLUMNS)

    def _frame_number_from_name(self, image_path: Path, fallback: int) -> int:
        m = self.FRAME_NUMBER_RE.search(image_path.stem)
        if not m:
            return fallback
        try:
            return int(m.group(1))
        except Exception:
            return fallback

    def _build_image_episodes(self) -> List[Dict[str, Any]]:
        images = sorted(
            p.resolve()
            for p in self.extract_dir.rglob("*")
            if p.is_file() and p.suffix.lower() in self.IMAGE_SUFFIXES
        )
        if not images:
            return []

        grouped: Dict[str, List[Path]] = {}
        for p in images:
            rel = p.relative_to(self.extract_dir)
            scene = rel.parts[0] if len(rel.parts) > 1 else rel.stem
            grouped.setdefault(scene, []).append(p)

        episodes: List[Dict[str, Any]] = []
        for scene_id, paths in grouped.items():
            paths.sort(key=lambda x: self._frame_number_from_name(x, 0))
            episodes.append(
                {
                    "mode": "images",
                    "scene_id": scene_id,
                    "image_paths": paths,
                    "source_size": sum(int(p.stat().st_size) for p in paths if p.exists()),
                }
            )

        episodes.sort(key=lambda row: str(row.get("scene_id", "")))
        self._log(f"[DrivingDojo] Image episodes discovered: {len(episodes)}")
        return episodes

    def _discover_videos(self, root: Path) -> List[Path]:
        return sorted(
            path.resolve()
            for path in root.rglob("*")
            if path.is_file() and path.suffix.lower() in self.VIDEO_SUFFIXES
        )

    def _episode_id(self, video_path: Path) -> str:
        rel = video_path.relative_to(self.videos_dir)
        raw = "__".join(list(rel.with_suffix("").parts))
        cleaned = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in raw)
        return cleaned.strip("_") or video_path.stem

    def _build_video_episodes(self) -> List[Dict[str, Any]]:
        videos = self._discover_videos(self.videos_dir)
        if not videos:
            return []
        rows = [
            {
                "mode": "video",
                "video_path": video_path,
                "source_size": int(video_path.stat().st_size) if video_path.exists() else 0,
                "episode_id": self._episode_id(video_path),
                "relative_path": str(video_path.relative_to(self.videos_dir)),
            }
            for video_path in videos
        ]
        self._log(f"[DrivingDojo] Video episodes discovered: {len(rows)}")
        return rows

    def _build_episodes(self) -> List[Dict[str, Any]]:
        video_episodes = self._build_video_episodes()
        if video_episodes:
            return video_episodes

        image_episodes = self._build_image_episodes()
        if image_episodes:
            return image_episodes
        return []

    def _process_video_episode(self, episode: Dict[str, Any]) -> pd.DataFrame:
        video_path = Path(str(episode["video_path"]))
        episode_id = str(episode["episode_id"])
        rel_path = str(episode["relative_path"])

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {video_path}")

        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        if fps <= 0.0:
            fps = float(self.fps)
        step_frames = max(1, int(round(self.resample_seconds * fps)))

        out_rows: List[Dict[str, Any]] = []
        frame_idx = 0
        saved_idx = 0
        episode_out_dir = self.out_dir / episode_id
        episode_out_dir.mkdir(parents=True, exist_ok=True)

        started_at = time.time()
        while True:
            if self._should_stop():
                cap.release()
                raise InterruptedError("Dataset installation cancelled by user")

            ok, frame = cap.read()
            if not ok:
                break

            if frame_idx % step_frames == 0:
                timestamp_ms = int(round((frame_idx / max(fps, 1e-6)) * 1000.0))
                frame_name = f"{episode_id}_{saved_idx:06d}.jpg"
                frame_path = episode_out_dir / frame_name
                if not cv2.imwrite(str(frame_path), frame):
                    cap.release()
                    raise RuntimeError(f"Failed to save frame: {frame_path}")

                out_rows.append(
                    {
                        "timestamp": timestamp_ms,
                        "camera_name": self.camera_name,
                        "dataset_type": "drivingdojo",
                        "source_link": f"local://{rel_path}#frame={frame_idx}",
                        "image_path": str(frame_path),
                    }
                )
                saved_idx += 1

            frame_idx += 1

        cap.release()

        if not out_rows:
            raise RuntimeError(f"No frames extracted from video: {video_path}")

        elapsed = max(time.time() - started_at, 0.001)
        self._log(
            f"[DrivingDojo] Frames extracted: {video_path.name} -> {len(out_rows)} frames "
            f"in {elapsed:.1f}s (fps={fps:.2f}, step_frames={step_frames})"
        )

        return pd.DataFrame(out_rows, columns=OUTPUT_COLUMNS)

    def _process_image_episode(self, episode: Dict[str, Any]) -> pd.DataFrame:
        scene_id = str(episode.get("scene_id", "scene"))
        image_paths: List[Path] = list(episode.get("image_paths", []))
        if not image_paths:
            return pd.DataFrame(columns=OUTPUT_COLUMNS)

        selected = image_paths[:: self.step_frames] if self.step_frames > 1 else image_paths
        episode_out_dir = self.out_dir / scene_id
        episode_out_dir.mkdir(parents=True, exist_ok=True)

        rows: List[Dict[str, Any]] = []
        for idx, src in enumerate(selected):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")

            frame_no = self._frame_number_from_name(src, idx)
            timestamp_ms = int(round((frame_no / max(float(self.fps), 1e-6)) * 1000.0))
            dst = episode_out_dir / src.name
            if not dst.exists():
                os.symlink(src.resolve(), dst)

            rel = src.relative_to(self.extract_dir)
            rows.append(
                {
                    "timestamp": timestamp_ms,
                    "camera_name": self.camera_name,
                    "dataset_type": "drivingdojo",
                    "source_link": f"local://{rel}",
                    "image_path": str(dst),
                }
            )

        self._log(
            f"[DrivingDojo] Scene sampled: {scene_id} -> {len(rows)} frames "
            f"(from {len(image_paths)}, step_frames={self.step_frames})"
        )
        return pd.DataFrame(rows, columns=OUTPUT_COLUMNS)

    def _hf_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        if self.hf_token:
            headers["Authorization"] = f"Bearer {self.hf_token}"
        return headers

    def _hf_head_size(self, filename: str) -> int:
        cached = int(self._hf_file_size_cache.get(filename, 0) or 0)
        if cached > 0:
            return cached

        url = self._hf_hub_file_url(filename)
        headers = self._hf_headers()
        range_headers = dict(headers)
        range_headers["Range"] = "bytes=0-0"

        try:
            with requests.get(url, headers=range_headers, stream=True, timeout=30) as response:
                if response.status_code < 400:
                    size = self._response_total_size(response, resume_from=0)
                    if size > 0:
                        self._hf_file_size_cache[filename] = size
                        return size
        except Exception:
            pass

        try:
            response = requests.head(
                url,
                headers=headers,
                timeout=30,
                allow_redirects=True,
            )
            if response.status_code >= 400:
                return 0
            size = self._response_total_size(response, resume_from=0)
            if size > 0:
                self._hf_file_size_cache[filename] = size
            return size
        except Exception:
            return 0

    def _response_total_size(self, response: requests.Response, resume_from: int = 0) -> int:
        content_encoding = str(response.headers.get("Content-Encoding", "identity") or "identity").lower()
        if content_encoding != "identity":
            return 0

        content_range = str(response.headers.get("Content-Range", "") or "").strip()
        if "/" in content_range:
            total_raw = content_range.rsplit("/", 1)[-1].strip()
            if total_raw and total_raw != "*":
                try:
                    parsed = int(total_raw)
                    if parsed > 0:
                        return parsed
                except Exception:
                    pass

        content_length_raw = str(response.headers.get("Content-Length", "") or "").strip()
        if not content_length_raw:
            return 0
        try:
            content_length = int(content_length_raw)
        except Exception:
            return 0
        if content_length <= 0:
            return 0
        if int(response.status_code) == 206:
            if resume_from > 0:
                return resume_from + content_length
            return 0
        return content_length

    def _download_hf_file_with_resume(
        self,
        *,
        filename: str,
        target_path: Path,
        expected_size: int,
        file_index: int,
        total_files: int,
        download_label: str = "",
    ) -> int:
        expected_size = int(expected_size or 0)
        if expected_size <= 0:
            expected_size = self._hf_head_size(filename)

        target_path.parent.mkdir(parents=True, exist_ok=True)
        part_path = Path(str(target_path) + ".part")
        file_name = Path(filename).name

        if target_path.exists():
            current_size = int(target_path.stat().st_size)
            if expected_size > 0 and current_size == expected_size:
                self._report_download_progress(
                    file_index=file_index,
                    total_files=total_files,
                    downloaded_bytes=current_size,
                    total_bytes=expected_size,
                    file_name=file_name,
                    download_label=download_label,
                    done=True,
                )
                return current_size
            if expected_size <= 0 and current_size > 0:
                self._report_download_progress(
                    file_index=file_index,
                    total_files=total_files,
                    downloaded_bytes=current_size,
                    total_bytes=current_size,
                    file_name=file_name,
                    download_label=download_label,
                    done=True,
                )
                return current_size
            if not part_path.exists() and current_size > 0:
                os.replace(target_path, part_path)
                self._log(
                    f"[DrivingDojo] Found partial file, continue as .part: {filename} "
                    f"({self._format_bytes(current_size)})"
                )

        resume_from = int(part_path.stat().st_size) if part_path.exists() else 0
        if expected_size > 0 and resume_from > expected_size:
            part_path.unlink(missing_ok=True)
            resume_from = 0
        if expected_size > 0 and resume_from == expected_size:
            os.replace(part_path, target_path)
            self._report_download_progress(
                file_index=file_index,
                total_files=total_files,
                downloaded_bytes=expected_size,
                total_bytes=expected_size,
                file_name=file_name,
                download_label=download_label,
                done=True,
            )
            return expected_size

        url = self._hf_hub_file_url(filename)
        headers = self._hf_headers()
        request_headers = dict(headers)
        if resume_from > 0:
            request_headers["Range"] = f"bytes={resume_from}-"

        response = requests.get(url, headers=request_headers, stream=True, timeout=60)
        if resume_from > 0 and response.status_code == 200:
            response.close()
            self._log(f"[DrivingDojo] Server did not honor Range for {filename}, restart from zero")
            part_path.unlink(missing_ok=True)
            resume_from = 0
            response = requests.get(url, headers=headers, stream=True, timeout=60)

        response.raise_for_status()
        remote_total_size = self._response_total_size(response, resume_from=resume_from)
        if expected_size <= 0 and remote_total_size > 0:
            expected_size = remote_total_size
        elif expected_size > 0 and remote_total_size > 0 and remote_total_size != expected_size:
            self._log(
                f"[DrivingDojo] Remote size differs for {file_name}: "
                f"expected={self._format_bytes(expected_size)}, remote={self._format_bytes(remote_total_size)}"
            )
            expected_size = remote_total_size

        downloaded = resume_from
        total_for_progress = max(expected_size, downloaded, 1)
        self._report_download_progress(
            file_index=file_index,
            total_files=total_files,
            downloaded_bytes=downloaded,
            total_bytes=total_for_progress,
            file_name=file_name,
            download_label=download_label,
            done=False,
        )
        log_last_at = 0.0
        with response, open(part_path, "ab" if resume_from > 0 else "wb") as fp:
            for chunk in response.iter_content(chunk_size=self.CHUNK_SIZE):
                if self._should_stop():
                    raise InterruptedError("Dataset installation cancelled by user")
                if not chunk:
                    continue
                fp.write(chunk)
                downloaded += len(chunk)
                total_for_progress = max(expected_size, downloaded, 1)
                self._report_download_progress(
                    file_index=file_index,
                    total_files=total_files,
                    downloaded_bytes=downloaded,
                    total_bytes=total_for_progress,
                    file_name=file_name,
                    download_label=download_label,
                    done=False,
                )
                now = time.time()
                if (now - log_last_at) >= self.LOG_PROGRESS_EVERY_SEC:
                    if expected_size > 0:
                        percent = min((downloaded / expected_size) * 100.0, 100.0)
                        self._log(
                            f"[DrivingDojo] Download progress {filename}: {percent:.1f}% "
                            f"({self._format_bytes(downloaded)} / {self._format_bytes(expected_size)})"
                        )
                    else:
                        self._log(
                            f"[DrivingDojo] Download progress {filename}: {self._format_bytes(downloaded)}"
                        )
                    log_last_at = now

        final_size = int(part_path.stat().st_size) if part_path.exists() else downloaded
        if expected_size > 0 and final_size != expected_size:
            raise RuntimeError(
                f"Incomplete download for {filename}: got {final_size} bytes, expected {expected_size}"
            )
        os.replace(part_path, target_path)
        progress_total = expected_size if expected_size > 0 else final_size
        self._report_download_progress(
            file_index=file_index,
            total_files=total_files,
            downloaded_bytes=final_size,
            total_bytes=max(progress_total, final_size, 1),
            file_name=file_name,
            download_label=download_label,
            done=True,
        )
        if expected_size > 0:
            self._hf_file_size_cache[filename] = expected_size
            self._stream_expected_sizes[filename] = expected_size
        return final_size

    def _expected_archive_size(self, archive_path: Path) -> int:
        rel_name = self._archive_rel_name(archive_path)
        cached = int(self._stream_expected_sizes.get(rel_name, 0) or 0)
        if cached > 0:
            return cached
        if not self.download_from_hf:
            return 0
        remote = self._hf_head_size(rel_name)
        if remote > 0:
            self._stream_expected_sizes[rel_name] = remote
        return remote

    def _ensure_archive_ready_for_stream(self, archive_path: Path, file_index: int, total_files: int) -> None:
        if self._should_stop():
            raise InterruptedError("Dataset installation cancelled by user")

        filename = self._archive_rel_name(archive_path)
        expected_size = self._expected_archive_size(archive_path)
        local_size = int(archive_path.stat().st_size) if archive_path.exists() else 0
        if local_size > 0 and expected_size > 0 and local_size == expected_size:
            self._report_download_progress(
                file_index=file_index,
                total_files=total_files,
                downloaded_bytes=local_size,
                total_bytes=expected_size,
                file_name=archive_path.name,
                done=True,
            )
            return
        if local_size > 0 and expected_size <= 0:
            self._report_download_progress(
                file_index=file_index,
                total_files=total_files,
                downloaded_bytes=local_size,
                total_bytes=local_size,
                file_name=archive_path.name,
                done=True,
            )
            return
        if not self.download_from_hf:
            raise FileNotFoundError(
                f"Missing or incomplete archive {archive_path.name}. "
                "Enable download_from_hf=true or provide complete local archives."
            )

        if local_size > 0 and expected_size > 0 and local_size != expected_size:
            self._log(
                f"[DrivingDojo] Archive size mismatch before extract: {filename} "
                f"(local={self._format_bytes(local_size)}, expected={self._format_bytes(expected_size)})"
            )
        self._log(
            f"[DrivingDojo] Download archive {file_index}/{total_files}: {filename} "
            f"(expected={self._format_bytes(expected_size) if expected_size > 0 else 'unknown'})"
        )
        self._download_hf_file_with_resume(
            filename=filename,
            target_path=archive_path,
            expected_size=expected_size,
            file_index=file_index,
            total_files=total_files,
        )
        marker_path = self.extract_dir / f".extracted_{archive_path.name}.ok"
        marker_path.unlink(missing_ok=True)

    def _recover_corrupted_archive(
        self,
        archive_path: Path,
        expected_size: Optional[int] = None,
        file_index: int = 1,
        total_files: int = 1,
    ) -> None:
        if not self.download_from_hf:
            raise RuntimeError(
                f"Archive {archive_path.name} is corrupted. Remove it manually and rerun installation."
            )

        filename = self._archive_rel_name(archive_path)
        expected_size = int(expected_size or 0)
        if expected_size <= 0:
            expected_size = self._hf_head_size(filename)
        if expected_size <= 0:
            raise RuntimeError(
                f"Archive {archive_path.name} is corrupted and remote size is unknown; "
                "remove file manually and rerun."
            )

        self._log(
            f"[DrivingDojo] Recover archive by re-download: {filename} "
            f"(expected={self._format_bytes(expected_size)})"
        )
        self._download_hf_file_with_resume(
            filename=filename,
            target_path=archive_path,
            expected_size=expected_size,
            file_index=file_index,
            total_files=total_files,
            download_label="Recovery Download",
        )
        marker_path = self.extract_dir / f".extracted_{archive_path.name}.ok"
        marker_path.unlink(missing_ok=True)

    def _hf_dataset_siblings(self) -> List[Dict[str, Any]]:
        api_url = f"{self.HF_API_BASE}/datasets/{self.repo_id}"
        response = requests.get(
            api_url,
            params={"full": "1"},
            headers=self._hf_headers(),
            timeout=60,
        )
        response.raise_for_status()
        payload = response.json() if response.content else {}
        siblings_raw = payload.get("siblings", [])
        if not isinstance(siblings_raw, list):
            return []

        out: List[Dict[str, Any]] = []
        for raw in siblings_raw:
            if not isinstance(raw, dict):
                continue
            filename = str(raw.get("rfilename", "") or "").strip()
            if not filename:
                continue
            size = raw.get("size", 0)
            size_int = 0
            try:
                size_int = int(size or 0)
            except Exception:
                size_int = 0
            if size_int <= 0 and isinstance(raw.get("lfs"), dict):
                size = raw["lfs"].get("size", 0)
            try:
                parsed_size = max(int(size or 0), 0)
            except Exception:
                parsed_size = 0
            out.append({"rfilename": filename, "size": parsed_size})
        return out

    def _hf_archive_size_map(self) -> Dict[str, int]:
        if self._hf_sizes_cache is not None:
            return dict(self._hf_sizes_cache)

        out: Dict[str, int] = {}
        for item in self._hf_dataset_siblings():
            filename = str(item.get("rfilename", "") or "").strip()
            if not filename:
                continue
            if not any(fnmatch.fnmatch(filename, pattern) for pattern in self.allow_patterns):
                continue
            if not self._is_archive_name(filename):
                continue
            size = int(item.get("size", 0) or 0)
            if size > 0:
                out[filename] = size

        self._hf_sizes_cache = dict(out)
        return out

    def _hf_hub_file_url(self, filename: str) -> str:
        encoded = quote(filename, safe="/")
        return f"{self.HF_DATASET_BASE}/{self.repo_id}/resolve/main/{encoded}"

    def __iter__(self):
        return self

    def __next__(self):
        if self.streaming_mode:
            if self.iteration >= len(self.archives_for_stream):
                raise StopIteration
            archive_index = self.iteration + 1
            archive_path = self.archives_for_stream[self.iteration]
            self.iteration += 1
            self._ensure_archive_ready_for_stream(
                archive_path,
                file_index=archive_index,
                total_files=len(self.archives_for_stream),
            )
            image_paths = self._extract_single_archive_with_images(
                archive_path, file_index=archive_index, total_archives=len(self.archives_for_stream)
            )
            df = self._build_df_from_extracted_images(image_paths)
            self._log(
                f"[DrivingDojo] Archive processed {archive_index}/{len(self.archives_for_stream)}: "
                f"{archive_path.name}, sampled_rows={len(df.index)}"
            )
            self.processed_source_bytes += int(archive_path.stat().st_size) if archive_path.exists() else 0
            self.processed_scenes += int(len(df.index) > 0)
            return df

        if self.iteration >= len(self.episodes):
            raise StopIteration

        episode = self.episodes[self.iteration]
        self.iteration += 1

        mode = str(episode.get("mode", ""))
        if mode == "video":
            display = Path(str(episode.get("video_path", ""))).name
        else:
            display = str(episode.get("scene_id", f"scene_{self.iteration:06d}"))

        self._log(
            f"[DrivingDojo] Process {mode or 'episode'} {self.iteration}/{len(self.episodes)}: {display}"
        )

        self._report_extract_progress(
            file_index=self.iteration,
            total_files=len(self.episodes),
            file_name=display,
            extracted_bytes=self.processed_source_bytes,
            total_bytes=self.total_source_bytes,
            extracted_files=self.processed_scenes,
            done=False,
        )

        if mode == "video":
            df = self._process_video_episode(episode)
        elif mode == "images":
            df = self._process_image_episode(episode)
        else:
            raise RuntimeError(f"Unsupported DrivingDojo episode mode: {mode}")

        self.processed_source_bytes += int(episode.get("source_size", 0) or 0)
        self.processed_scenes += 1

        self._report_extract_progress(
            file_index=self.iteration,
            total_files=len(self.episodes),
            file_name=display,
            extracted_bytes=self.processed_source_bytes,
            total_bytes=self.total_source_bytes,
            extracted_files=self.processed_scenes,
            done=True,
        )

        return df

    def __len__(self):
        if self.streaming_mode:
            return len(self.archives_for_stream)
        return len(self.episodes)


def main() -> None:
    parser = argparse.ArgumentParser(description="Process DrivingDojo sources and upload sampled frames")
    parser.add_argument("--resample-seconds", type=float, default=5.0)
    parser.add_argument("--fps", type=int, default=10)
    parser.add_argument("--camera-name", type=str, default="FRONT")
    parser.add_argument("--repo-id", type=str, default="Yuqi1997/DrivingDojo")
    parser.add_argument("--source-dir", type=str, default=str(DATA_FOLDER / "source"))
    parser.add_argument("--videos-dir", type=str, default=str((DATA_FOLDER / "source") / "videos"))
    parser.add_argument("--extract-dir", type=str, default=str((DATA_FOLDER / "source") / "extracted"))
    parser.add_argument("--out-dir", type=str, default=str(DATA_FOLDER / "filtered"))
    parser.add_argument("--allow-patterns", nargs="+", default=["videos/*"])
    parser.add_argument("--download-from-hf", action="store_true")
    parser.add_argument("--extract-archives", action="store_true")
    parser.add_argument("--hf-token", type=str, default="")
    parser.add_argument("--max-workers", type=int, default=4)
    parser.add_argument("--limit-videos", type=int, default=None)
    parser.add_argument("--bucket", type=str, default="drivingdojo")
    parser.add_argument("--keep-local-images", action="store_true")
    args = parser.parse_args()

    preprocessor = DrivingDojoPreprocessor(
        resample_seconds=args.resample_seconds,
        fps=args.fps,
        camera_name=args.camera_name,
        repo_id=args.repo_id,
        source_dir=args.source_dir,
        videos_dir=args.videos_dir,
        extract_dir=args.extract_dir,
        out_dir=args.out_dir,
        allow_patterns=args.allow_patterns,
        download_from_hf=bool(args.download_from_hf),
        extract_archives=bool(args.extract_archives),
        hf_token=args.hf_token,
        max_workers=args.max_workers,
        limit_videos=args.limit_videos,
        remove_local_images=not args.keep_local_images,
    )
    preprocessor.download_to_storage(bucket=args.bucket)


if __name__ == "__main__":
    main()
