from .preprocessor import Preprocessor
from typing import List, Optional, Dict
from tqdm import tqdm
import pandas as pd
import requests
from pathlib import Path
from glob import glob
import shutil
import os

from configs.common import DATA_DIR, ARGOVERSE_DIR

S3_DATASET_LINK = "https://s3.amazonaws.com/argoverse/datasets/av2/tars/sensor/"
DATA_FOLDER = Path(DATA_DIR) / ARGOVERSE_DIR


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
                 }  # https://www.argoverse.org/av2.html#download-link
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

        os.makedirs(DATA_FOLDER, exist_ok=True)

        # for iterable
        self.iteration = 0

    def download_part(self, split: str, part: int):
        filename = f"{split}-{part:03d}.tar"
        url = os.path.join(S3_DATASET_LINK, filename)
        out_path = os.path.join(DATA_FOLDER, filename)

        with requests.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()

            remote_size = int(r.headers.get("Content-Length", 0))
            local_size = os.path.getsize(out_path) if os.path.exists(out_path) else 0

            downloaded = os.path.getsize(out_path) if os.path.exists(out_path) else 0
            mode = "ab" if downloaded > 0 else "wb"

            headers = {}

            if remote_size and local_size >= remote_size:
                os.system(f'tar -xvf "{out_path}" -C "{DATA_FOLDER}" --wildcards --no-anchored \'*.jpg\' --skip-old-files')
                os.remove(out_path)
                return out_path
            if downloaded > 0:
                headers = {"Range": f"bytes={downloaded}-"}
                r.close()
                r = requests.get(url, stream=True, timeout=60, headers=headers)
                r.raise_for_status()

                remaining = int(r.headers.get("Content-Length", 0))
                remote_size = downloaded + remaining

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
                    if chunk:
                        f.write(chunk)
                        pbar.update(len(chunk))

        os.system(f'tar -xvf "{out_path}" -C "{DATA_FOLDER}" --wildcards --no-anchored \'*.jpg\' --skip-old-files')
        os.remove(out_path)
        return out_path

    def filter_by_step_seconds(self, files: List[Path]) -> List[Path]:
        step_ns = int(self.resample_seconds * 1e9)

        parsed = []
        for file in files:
            p = Path(file)
            parts = p.stem.split("_")
            ts = None
            for token in reversed(parts):
                if token.isdigit():
                    ts = int(token)
                    break
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
            ride_id = path.parents[2].name
            cam = self.REVERSE_CAMERA_TO_LABEL.get(cam_raw, cam_raw)

            dst = DATA_FOLDER / f"{cam}_{ts_str}_{ride_id}.jpg"

            src.rename(dst)  # moves files from sensor to argoverse data folder
            images.append(dst)

        if not images:
            images = glob(str(DATA_FOLDER / "*.jpg"))

        images = self.filter_by_step_seconds(images)
        result = pd.DataFrame([
            {
                "timestamp": int(path.stem.split('_')[1]),
                "camera_name": path.stem.split('_')[0],
                "dataset_type": "argoverse",
                "local": path,
                "source_link": os.path.join(S3_DATASET_LINK, f"{split}-{part:03d}.tar"),
                "source_ride_id": path.stem.split('_')[2]
            }
            for path in images
        ])

        # out_path = os.path.join(DATA_FOLDER, f"{split}-{part:03d}.parquet")
        # result.to_parquet(out_path, index=False)
        return result

    def process_part(self, split: str, part: int):
        output = self.download_part(split, part)
        output = self.fitler_part(Path(output).parent, split, part)
        return output

    def _generate(self):
        for split, parts in self.download_parts.items():
            for part in parts:
                yield self.process_part(split, part)

    def __iter__(self):
        return self._generate()


if __name__ == "__main__":
    processor = ArgoversePreprocessor(
        resample_seconds=0.5,
        download_parts={"train": [0]},
        cameras=["FRONT"]
    )
    # processor.clear_bucket(bucket="argoverse")

    # for i, ride in enumerate(processor):
    #     if i >= 1:
    #         break
    #     print(i)
    #     print(ride)

    processor.download_to_s3(bucket="argoverse")