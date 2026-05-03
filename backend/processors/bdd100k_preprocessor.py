from __future__ import annotations

import argparse
import os
import re
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import pandas as pd
from tqdm import tqdm

from configs.common import DATA_DIR
from .preprocessor import Preprocessor

DATA_FOLDER = Path(DATA_DIR) / "bdd100k"
OUTPUT_COLUMNS = [
    "timestamp",
    "camera_name",
    "dataset_type",
    "source_link",
    "image_path",
]


class BDD100KPreprocessor(Preprocessor):
    IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
    ZIP_PATTERNS = ("*.zip",)
    STEM_TS_RE = re.compile(r"-(\d+)$")

    def __init__(
        self,
        splits: Optional[List[str]] = None,
        resample_seconds: float = 5.0,
        fps: int = 10,
        zip_dir: Optional[str] = None,
        extract_dir: Optional[str] = None,
        out_dir: Optional[str] = None,
        extract_archives: bool = True,
        remove_local_images: bool = True,
        install_log_callback: Optional[Callable[[str], None]] = None,
        extract_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        cancel_requested_callback: Optional[Callable[[], bool]] = None,
    ):
        super().__init__(remove_local_images=remove_local_images)
        self.splits = self._normalize_splits(splits)
        self.resample_seconds = max(0.0, float(resample_seconds or 0.0))
        self.fps = max(1, int(fps or 1))
        self.step_frames = max(1, int(round(self.resample_seconds * self.fps)))

        self.zip_dir = Path(zip_dir) if zip_dir else DATA_FOLDER / "zips"
        self.extract_dir = Path(extract_dir) if extract_dir else DATA_FOLDER / "extracted"
        self.out_dir = Path(out_dir) if out_dir else DATA_FOLDER / "filtered"

        self.install_log_callback = install_log_callback
        self.extract_progress_callback = extract_progress_callback
        self.cancel_requested_callback = cancel_requested_callback

        DATA_FOLDER.mkdir(parents=True, exist_ok=True)
        self.zip_dir.mkdir(parents=True, exist_ok=True)
        self.extract_dir.mkdir(parents=True, exist_ok=True)
        self.out_dir.mkdir(parents=True, exist_ok=True)

        self._log(
            "[BDD100K] Init: "
            f"splits={self.splits}, resample_seconds={self.resample_seconds}, "
            f"fps={self.fps}, step_frames={self.step_frames}, extract_archives={extract_archives}"
        )

        if extract_archives:
            self._extract_archives_if_needed()

        self.episodes = self._build_episodes()
        self.episode_keys = sorted(self.episodes.keys())
        if not self.episode_keys:
            raise FileNotFoundError(
                f"No BDD100K images found under {self.extract_dir}. "
                "Expected images/{train,val,test} or bdd100k/images/100k/{train,val,test}."
            )
        self.iteration = 0
        self._log(f"[BDD100K] Ready: episodes={len(self.episode_keys)}")

    def _log(self, message: str) -> None:
        print(message, flush=True)
        if self.install_log_callback:
            self.install_log_callback(message)

    def _should_stop(self) -> bool:
        return bool(self.cancel_requested_callback and self.cancel_requested_callback())

    def _normalize_splits(self, splits: Optional[List[str]]) -> List[str]:
        allowed = {"train", "val", "test"}
        if not splits:
            return ["train", "val", "test"]
        out: List[str] = []
        for item in splits:
            key = str(item).strip().lower()
            if key in allowed and key not in out:
                out.append(key)
        return out or ["train", "val", "test"]

    def _discover_archives(self) -> List[Path]:
        archives: List[Path] = []
        for pattern in self.ZIP_PATTERNS:
            archives.extend(self.zip_dir.glob(pattern))
        return sorted({path.resolve() for path in archives})

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

    def _safe_extract_member(self, zf: zipfile.ZipFile, member: zipfile.ZipInfo) -> None:
        target_path = (self.extract_dir / member.filename).resolve()
        extract_root = self.extract_dir.resolve()
        if os.path.commonpath([str(extract_root), str(target_path)]) != str(extract_root):
            raise RuntimeError(f"Refusing to extract outside target dir: {member.filename}")
        zf.extract(member, self.extract_dir)

    def _extract_archives_if_needed(self) -> None:
        archives = self._discover_archives()
        if not archives:
            self._log(f"[BDD100K] No zip archives found in {self.zip_dir}; skip extraction")
            return
        total_archives = len(archives)
        for file_index, archive_path in enumerate(archives, start=1):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")
            marker_path = self.extract_dir / f".extracted_{archive_path.name}.ok"
            archive_size = int(archive_path.stat().st_size) if archive_path.exists() else 0
            if marker_path.exists():
                self._log(f"[BDD100K] Skip extract {archive_path.name}: marker exists")
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
                f"[BDD100K] Extract {file_index}/{total_archives}: {archive_path.name} ({archive_size} bytes)"
            )
            with zipfile.ZipFile(archive_path) as zf:
                members = zf.infolist()
                total_bytes = sum(max(m.file_size, 0) for m in members if not m.is_dir())
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
                    self._safe_extract_member(zf, member)
                    if not member.is_dir():
                        extracted_files += 1
                        extracted_bytes += max(member.file_size, 0)
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

    def _detect_split(self, image_path: Path) -> Optional[str]:
        parts = [part.lower() for part in image_path.parts]
        for split in self.splits:
            if split in parts:
                return split
        return None

    def _is_source_image(self, path: Path) -> bool:
        parts = [part.lower() for part in path.parts]
        if "images" not in parts:
            return False
        if "labels" in parts or "color_labels" in parts:
            return False
        return True

    def _clip_id(self, image_path: Path) -> str:
        stem = image_path.stem
        if "-" in stem:
            return stem.split("-", 1)[0]
        return stem

    def _timestamp(self, image_path: Path, fallback: int) -> int:
        m = self.STEM_TS_RE.search(image_path.stem)
        if not m:
            return fallback
        try:
            return int(m.group(1))
        except Exception:  # noqa: BLE001
            return fallback

    def _build_episodes(self) -> Dict[str, List[Dict[str, Any]]]:
        all_images = sorted(
            path
            for path in self.extract_dir.rglob("*")
            if path.is_file()
            and path.suffix.lower() in self.IMAGE_SUFFIXES
            and self._is_source_image(path)
        )
        self._log(f"[BDD100K] Index start: images={len(all_images)}")
        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for idx, image_path in enumerate(
            tqdm(all_images, desc="Index BDD100K", dynamic_ncols=True), start=1
        ):
            if self._should_stop():
                raise InterruptedError("Dataset installation cancelled by user")
            split = self._detect_split(image_path)
            if not split:
                continue
            clip = self._clip_id(image_path)
            key = f"{split}|{clip}"
            grouped.setdefault(key, []).append(
                {
                    "timestamp": self._timestamp(image_path, fallback=idx),
                    "image_path": image_path,
                    "split": split,
                    "clip": clip,
                }
            )
        episodes: Dict[str, List[Dict[str, Any]]] = {}
        for key, rows in grouped.items():
            rows.sort(key=lambda row: (int(row["timestamp"]), str(row["image_path"])))
            selected_rows = rows[:: self.step_frames] if self.step_frames > 1 else rows
            if selected_rows:
                episodes[key] = selected_rows
        self._log(
            f"[BDD100K] Index done: episodes={len(episodes)}, rows_after_step={sum(len(v) for v in episodes.values())}"
        )
        return episodes

    def process_episode(self, episode_key: str) -> pd.DataFrame:
        rows = self.episodes.get(episode_key, [])
        out_rows: List[Dict[str, Any]] = []
        for row in rows:
            source_path = Path(str(row["image_path"]))
            split = str(row["split"])
            clip = str(row["clip"])
            ts = int(row["timestamp"])
            link_dir = self.out_dir / split / clip
            link_dir.mkdir(parents=True, exist_ok=True)
            link_name = f"{split}__{clip}__{source_path.name}"
            dst_path = link_dir / link_name
            if not dst_path.exists():
                os.symlink(source_path.resolve(), dst_path)
            out_rows.append(
                {
                    "timestamp": ts,
                    "camera_name": "FRONT",
                    "dataset_type": "bdd100k",
                    "source_link": f"local://{source_path.relative_to(self.extract_dir)}",
                    "image_path": str(dst_path),
                }
            )
        return pd.DataFrame(out_rows, columns=OUTPUT_COLUMNS)

    def __iter__(self):
        return self

    def __next__(self):
        if self.iteration >= len(self.episode_keys):
            raise StopIteration
        key = self.episode_keys[self.iteration]
        self.iteration += 1
        return self.process_episode(key)

    def __len__(self):
        return len(self.episode_keys)


def main() -> None:
    parser = argparse.ArgumentParser(description="Process BDD100K dataset and upload to storage")
    parser.add_argument("--zip-dir", type=str, default=str(DATA_FOLDER / "zips"))
    parser.add_argument("--extract-dir", type=str, default=str(DATA_FOLDER / "extracted"))
    parser.add_argument("--out-dir", type=str, default=str(DATA_FOLDER / "filtered"))
    parser.add_argument("--splits", nargs="+", default=["train", "val", "test"])
    parser.add_argument("--resample-seconds", type=float, default=5.0)
    parser.add_argument("--fps", type=int, default=10)
    parser.add_argument("--extract", action="store_true")
    parser.add_argument("--bucket", type=str, default="bdd100k")
    parser.add_argument("--keep-local-images", action="store_true")
    args = parser.parse_args()

    preprocessor = BDD100KPreprocessor(
        zip_dir=args.zip_dir,
        extract_dir=args.extract_dir,
        out_dir=args.out_dir,
        splits=args.splits,
        resample_seconds=args.resample_seconds,
        fps=args.fps,
        extract_archives=bool(args.extract),
        remove_local_images=not args.keep_local_images,
    )
    preprocessor.download_to_storage(bucket=args.bucket)


if __name__ == "__main__":
    main()
