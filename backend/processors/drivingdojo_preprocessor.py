from __future__ import annotations

import argparse
import fnmatch
import os
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
    HF_API_BASE = "https://huggingface.co/api"
    HF_DATASET_BASE = "https://huggingface.co/datasets"

    def __init__(
        self,
        resample_seconds: float = 5.0,
        camera_name: str = "FRONT",
        repo_id: str = "Yuqi1997/DrivingDojo",
        source_dir: Optional[str] = None,
        videos_dir: Optional[str] = None,
        out_dir: Optional[str] = None,
        allow_patterns: Optional[List[str]] = None,
        download_from_hf: bool = True,
        hf_token: Optional[str] = None,
        max_workers: int = 4,
        limit_videos: Optional[int] = None,
        remove_local_images: bool = True,
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
        self.out_dir = Path(out_dir) if out_dir else DATA_FOLDER / "filtered"
        self.allow_patterns = allow_patterns or ["videos/*"]
        self.download_from_hf = bool(download_from_hf)
        self.hf_token = str(hf_token or os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_HUB_TOKEN") or "").strip() or None
        self.max_workers = max(1, int(max_workers or 1))
        self.limit_videos = int(limit_videos) if limit_videos is not None else None

        self.install_log_callback = install_log_callback
        self.download_progress_callback = download_progress_callback
        self.extract_progress_callback = extract_progress_callback
        self.cancel_requested_callback = cancel_requested_callback

        DATA_FOLDER.mkdir(parents=True, exist_ok=True)
        self.source_dir.mkdir(parents=True, exist_ok=True)
        self.videos_dir.mkdir(parents=True, exist_ok=True)
        self.out_dir.mkdir(parents=True, exist_ok=True)

        self._log(
            "[DrivingDojo] Init: "
            f"resample_seconds={self.resample_seconds}, camera_name={self.camera_name}, "
            f"download_from_hf={self.download_from_hf}, repo_id={self.repo_id}, "
            f"videos_dir={self.videos_dir}"
        )

        self._prepare_videos()

        videos = self._discover_videos()
        if self.limit_videos is not None:
            videos = videos[: max(0, int(self.limit_videos))]

        if not videos:
            raise FileNotFoundError(
                f"No DrivingDojo videos found in {self.videos_dir}. "
                "Put videos under videos_dir or enable download_from_hf."
            )

        self.episodes = [
            {
                "video_path": video_path,
                "video_size": int(video_path.stat().st_size) if video_path.exists() else 0,
                "episode_id": self._episode_id(video_path),
                "relative_path": str(video_path.relative_to(self.videos_dir)),
            }
            for video_path in videos
        ]
        self.total_video_bytes = sum(int(item["video_size"]) for item in self.episodes)
        self.extracted_video_bytes = 0
        self.extracted_videos = 0

        self.iteration = 0
        self._log(
            f"[DrivingDojo] Ready: videos={len(self.episodes)}, total_video_bytes={self.total_video_bytes}"
        )

    def _should_stop(self) -> bool:
        return bool(self.cancel_requested_callback and self.cancel_requested_callback())

    def _log(self, message: str) -> None:
        print(message, flush=True)
        if self.install_log_callback:
            self.install_log_callback(message)

    def _report_download_progress(
        self,
        file_index: int,
        total_files: int,
        downloaded_bytes: int,
        total_bytes: int,
        file_name: str,
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

    def _prepare_videos(self) -> None:
        existing = self._discover_videos()
        if existing:
            self._log(f"[DrivingDojo] Using local videos: found={len(existing)}")
            return

        if not self.download_from_hf:
            self._log("[DrivingDojo] download_from_hf=false and local videos not found")
            return

        self._download_from_hf()

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
        except Exception as exc:  # noqa: BLE001
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
            if Path(filename).suffix.lower() not in self.VIDEO_SUFFIXES and not filename.endswith(".tar.gz"):
                continue
            size_raw = item.get("size", 0)
            try:
                size = max(int(size_raw or 0), 0)
            except Exception:  # noqa: BLE001
                size = 0
            candidate_files.append({"filename": filename, "size": size})

        if not candidate_files:
            raise FileNotFoundError(
                f"No downloadable files matched allow_patterns={self.allow_patterns} "
                f"in repo {self.repo_id}"
            )

        total_files = len(candidate_files)
        total_bytes = sum(int(item["size"]) for item in candidate_files)
        downloaded_bytes_total = 0
        headers = {}
        if self.hf_token:
            headers["Authorization"] = f"Bearer {self.hf_token}"

        for file_index, item in enumerate(candidate_files, start=1):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")

            filename = str(item["filename"])
            expected_size = int(item["size"])
            target_path = self.source_dir / filename
            target_path.parent.mkdir(parents=True, exist_ok=True)

            if target_path.exists() and expected_size > 0 and int(target_path.stat().st_size) == expected_size:
                downloaded_bytes_total += expected_size
                self._report_download_progress(
                    file_index=file_index,
                    total_files=total_files,
                    downloaded_bytes=downloaded_bytes_total,
                    total_bytes=max(total_bytes, downloaded_bytes_total),
                    file_name=Path(filename).name,
                    done=True,
                )
                continue

            url = self._hf_hub_file_url(filename)
            self._log(f"[DrivingDojo] Download file {file_index}/{total_files}: {filename}")
            file_downloaded = 0
            with requests.get(url, headers=headers, stream=True, timeout=60) as response:
                response.raise_for_status()
                content_len = int(response.headers.get("Content-Length", "0") or 0)
                if content_len > 0 and expected_size <= 0:
                    expected_size = content_len
                    total_bytes += content_len

                with open(target_path, "wb") as fp:
                    for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
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

            downloaded_bytes_total += file_downloaded
            self._report_download_progress(
                file_index=file_index,
                total_files=total_files,
                downloaded_bytes=downloaded_bytes_total,
                total_bytes=max(total_bytes, downloaded_bytes_total),
                file_name=Path(filename).name,
                done=True,
            )

        videos = self._discover_videos()
        if not videos:
            raise FileNotFoundError(
                f"DrivingDojo download completed but no videos were found in {self.videos_dir}."
            )
        self._log(f"[DrivingDojo] Download done: videos={len(videos)}")

    def _hf_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        if self.hf_token:
            headers["Authorization"] = f"Bearer {self.hf_token}"
        return headers

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
            except Exception:  # noqa: BLE001
                size_int = 0
            if size_int <= 0 and isinstance(raw.get("lfs"), dict):
                size = raw["lfs"].get("size", 0)
            try:
                parsed_size = max(int(size or 0), 0)
            except Exception:  # noqa: BLE001
                parsed_size = 0
            out.append(
                {
                    "rfilename": filename,
                    "size": parsed_size,
                }
            )
        return out

    def _hf_hub_file_url(self, filename: str) -> str:
        encoded = quote(filename, safe="/")
        return f"{self.HF_DATASET_BASE}/{self.repo_id}/resolve/main/{encoded}"

    def _discover_videos(self) -> List[Path]:
        return sorted(
            path.resolve()
            for path in self.videos_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in self.VIDEO_SUFFIXES
        )

    def _episode_id(self, video_path: Path) -> str:
        rel = video_path.relative_to(self.videos_dir)
        raw = "__".join(list(rel.with_suffix("").parts))
        cleaned = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in raw)
        return cleaned.strip("_") or video_path.stem

    def _process_video(self, episode: Dict[str, Any]) -> pd.DataFrame:
        video_path = Path(str(episode["video_path"]))
        episode_id = str(episode["episode_id"])
        rel_path = str(episode["relative_path"])

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {video_path}")

        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        if fps <= 0.0:
            fps = 5.0
        step_frames = max(1, int(round(self.resample_seconds * fps)))

        out_rows: List[Dict[str, Any]] = []
        frame_idx = 0
        saved_idx = 0
        episode_out_dir = self.out_dir / episode_id
        episode_out_dir.mkdir(parents=True, exist_ok=True)

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

        return pd.DataFrame(out_rows, columns=OUTPUT_COLUMNS)

    def __iter__(self):
        return self

    def __next__(self):
        if self.iteration >= len(self.episodes):
            raise StopIteration

        episode = self.episodes[self.iteration]
        self.iteration += 1

        self._report_extract_progress(
            file_index=self.iteration,
            total_files=len(self.episodes),
            file_name=Path(str(episode["video_path"])).name,
            extracted_bytes=self.extracted_video_bytes,
            total_bytes=self.total_video_bytes,
            extracted_files=self.extracted_videos,
            done=False,
        )

        df = self._process_video(episode)

        self.extracted_video_bytes += int(episode.get("video_size", 0) or 0)
        self.extracted_videos += 1
        self._report_extract_progress(
            file_index=self.iteration,
            total_files=len(self.episodes),
            file_name=Path(str(episode["video_path"])).name,
            extracted_bytes=self.extracted_video_bytes,
            total_bytes=self.total_video_bytes,
            extracted_files=self.extracted_videos,
            done=True,
        )

        if self.iteration == 1 or self.iteration % 10 == 0 or self.iteration == len(self.episodes):
            self._log(
                f"[DrivingDojo] Processed video {self.iteration}/{len(self.episodes)}: "
                f"{Path(str(episode['video_path'])).name}"
            )

        return df

    def __len__(self):
        return len(self.episodes)


def main() -> None:
    parser = argparse.ArgumentParser(description="Process DrivingDojo videos and upload sampled frames")
    parser.add_argument("--resample-seconds", type=float, default=5.0)
    parser.add_argument("--camera-name", type=str, default="FRONT")
    parser.add_argument("--repo-id", type=str, default="Yuqi1997/DrivingDojo")
    parser.add_argument("--source-dir", type=str, default=str(DATA_FOLDER / "source"))
    parser.add_argument("--videos-dir", type=str, default=str((DATA_FOLDER / "source") / "videos"))
    parser.add_argument("--out-dir", type=str, default=str(DATA_FOLDER / "filtered"))
    parser.add_argument("--allow-patterns", nargs="+", default=["videos/*"])
    parser.add_argument("--download-from-hf", action="store_true")
    parser.add_argument("--hf-token", type=str, default="")
    parser.add_argument("--max-workers", type=int, default=4)
    parser.add_argument("--limit-videos", type=int, default=None)
    parser.add_argument("--bucket", type=str, default="drivingdojo")
    parser.add_argument("--keep-local-images", action="store_true")
    args = parser.parse_args()

    preprocessor = DrivingDojoPreprocessor(
        resample_seconds=args.resample_seconds,
        camera_name=args.camera_name,
        repo_id=args.repo_id,
        source_dir=args.source_dir,
        videos_dir=args.videos_dir,
        out_dir=args.out_dir,
        allow_patterns=args.allow_patterns,
        download_from_hf=bool(args.download_from_hf),
        hf_token=args.hf_token,
        max_workers=args.max_workers,
        limit_videos=args.limit_videos,
        remove_local_images=not args.keep_local_images,
    )
    preprocessor.download_to_storage(bucket=args.bucket)


if __name__ == "__main__":
    main()
