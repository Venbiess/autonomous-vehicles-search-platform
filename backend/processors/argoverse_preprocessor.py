from .preprocessor import Preprocessor
from typing import Any, Callable, List, Optional, Dict
from tqdm import tqdm
import pandas as pd
import requests
from pathlib import Path
from glob import glob
import shutil
import os
import re
import tarfile

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
    CHUNK_SIZE = 1024 * 1024  # 1 MB

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

    def __init__(self,
                 cameras: Optional[List[str]] = ["FRONT"],
                 resample_seconds: Optional[float] = 0.5,
                 download_parts: Dict[str, List[int]] = {
                     "train": range(14),
                     "val": range(3),
                     "test": range(3)
                 },  # https://www.argoverse.org/av2.html#download-link
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

        # for iterable
        self.iteration = 0
        self.install_log_callback: Optional[Callable[[str], None]] = None
        self.download_progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
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
                self._extract_tar_with_progress(out_path)
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

        self._extract_tar_with_progress(out_path)
        return out_path

    def _extract_tar_with_progress(self, tar_path: str) -> None:
        tar_name = Path(tar_path).name
        marker_path = Path(DATA_FOLDER) / f".extracted_{tar_name}.ok"
        sensor_root = Path(DATA_FOLDER) / "sensor"
        split_name = tar_name.split("-", 1)[0] if "-" in tar_name else ""
        split_root = sensor_root / split_name if split_name else sensor_root

        # Skip only when this exact archive was already extracted and its split data exists.
        if marker_path.exists() and split_root.exists():
            has_split_files = any(p.is_file() for p in split_root.rglob("*.jpg"))
            if has_split_files:
                self._log(
                    f"[Argoverse] Skip extract for {tar_name}: marker found and files already unpacked."
                )
                return

        self._log(f"[Argoverse] Start extract (stream mode, no pre-scan): {tar_name}")
        self._log("[Argoverse] INFO: skipping full tar index/size scan for speed on large archives.")

        # Stream mode avoids expensive full archive indexing (getmembers) on huge tar files.
        with tarfile.open(tar_path, "r|*") as tar:
            extracted_files = 0
            pbar = tqdm(
                unit="B",
                unit_scale=True,
                unit_divisor=1024,
                desc=f"Extract {tar_name}",
                dynamic_ncols=True,
            )
            for member in tar:
                tar.extract(member, path=DATA_FOLDER)
                if member.isfile():
                    extracted_files += 1
                    pbar.update(max(member.size, 0))
            pbar.close()
        marker_path.write_text("ok\n")

        self._log(f"[Argoverse] Done extract: {tar_name} (files: {extracted_files})")

    def filter_by_step_seconds(self, files: List[Path]) -> List[Path]:
        step_ns = int(self.resample_seconds * 1e9)

        parsed = []
        for file in files:
            p = Path(file)
            ts = self._extract_timestamp_from_stem(p.stem)
            if ts is None:
                continue
            parsed.append((ts, p))

        parsed.sort(key=lambda x: x[0])

        out = []
        last_ts = None
        for ts, p in parsed:
            if last_ts is None or (ts - last_ts) >= step_ns:
                out.append(p)
                last_ts = ts

        return out

    @staticmethod
    def _extract_timestamp_from_stem(stem: str) -> Optional[int]:
        numeric_tokens = [token for token in stem.split("_") if token.isdigit()]
        if not numeric_tokens:
            return None

        # Prefer long tokens (real sensor timestamps) over short collision suffixes like "_1".
        long_tokens = [token for token in numeric_tokens if len(token) >= 12]
        candidate = long_tokens[-1] if long_tokens else numeric_tokens[-1]
        try:
            return int(candidate)
        except ValueError:
            return None

    def fitler_part(self, path, split, part):
        trips_path = path / "sensor" / split

        # filter cameras
        paths = [
            Path(p)
            for camera in self.cameras
            for p in glob(str(trips_path / "**" / camera / "*.jpg"), recursive=True)
        ]

        images: List[Path] = []
        for src in paths:
            ts_str = src.stem
            cam_raw = src.parent.name
            cam = self.REVERSE_CAMERA_TO_LABEL.get(cam_raw, cam_raw)
            try:
                rel = src.relative_to(trips_path)
                group_key = rel.parts[0] if rel.parts else f"{split}_{part:03d}"
            except ValueError:
                group_key = src.parent.parent.name
            group_key = re.sub(r"[^A-Za-z0-9_-]+", "_", group_key)

            # Include a per-sequence key in file name to avoid camera+timestamp collisions.
            dst = DATA_FOLDER / f"{cam}_{group_key}_{ts_str}.jpg"

            if dst.exists():
                i = 1
                while (DATA_FOLDER / f"{cam}_{group_key}_{ts_str}_{i}.jpg").exists():
                    i += 1
                dst = DATA_FOLDER / f"{cam}_{group_key}_{ts_str}_{i}.jpg"

            src.rename(dst)  # moves files from sensor to argoverse data folder
            images.append(dst)
        
        if self.remove_after_load:
            sensor_dir = Path(DATA_FOLDER) / "sensor"
            if sensor_dir.exists():
                shutil.rmtree(sensor_dir)

        images = self.filter_by_step_seconds(images)

        rows = []
        for path in images:
            ts = self._extract_timestamp_from_stem(path.stem)
            if ts is None:
                continue
            rows.append(
                {
                    "timestamp": ts,
                    "camera_name": self.REVERSE_CAMERA_TO_LABEL[path.parent.name],
                    "dataset_type": "argoverse",
                    "image_path": path,
                    "source_link": os.path.join(S3_DATASET_LINK, f"{split}-{part:03d}.tar"),
                }
            )

        result = pd.DataFrame(rows, columns=OUTPUT_COLUMNS)

        # out_path = os.path.join(DATA_FOLDER, f"{split}-{part:03d}.parquet")
        # result.to_parquet(out_path, index=False)
        return result

    def process_part(self, split: str, part: int):
        part_index = self.iteration + 1
        self._log(f"[Argoverse] Process part {part_index}/{self.total_parts}: {split}-{part:03d}")
        output = self.download_part(split, part, part_index=part_index)
        output = self.fitler_part(Path(output).parent, split, part)
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
        download_parts={"train": [0]},
        cameras=["FRONT"]
    )

    # for i, episode in enumerate(processor):
    #     if i >= 1:
    #         break
    #     print(i)
    #     print(episode)

    processor.download_to_storage(bucket="argoverse")
