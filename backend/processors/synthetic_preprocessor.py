from __future__ import annotations

import argparse
from pathlib import Path
from typing import List, Optional

import numpy as np
import pandas as pd
from matplotlib import pyplot as plt

from .preprocessor import Preprocessor
from configs.common import DATA_DIR

DATA_FOLDER = Path(DATA_DIR) / "synthetic"

 
class SyntheticRoadPreprocessor(Preprocessor):
    def __init__(
        self,
        num_images: int = 64,
        batch_size: int = 16,
        cameras: Optional[List[str]] = None,
        width: int = 960,
        height: int = 540,
        seed: int = 7,
        remove_local_images: bool = True,
    ):
        super().__init__(remove_local_images=remove_local_images)
        self.num_images = max(1, int(num_images))
        self.batch_size = max(1, int(batch_size))
        self.cameras = cameras or ["FRONT", "FRONT_LEFT", "FRONT_RIGHT"]
        self.width = max(320, int(width))
        self.height = max(240, int(height))
        self.seed = int(seed)
        self.iteration = 0

        DATA_FOLDER.mkdir(parents=True, exist_ok=True)

    def _render_frame(self, frame_idx: int, camera_name: str) -> np.ndarray:
        h, w = self.height, self.width
        rng = np.random.default_rng(self.seed + frame_idx * 31 + len(camera_name) * 11)
        img = np.zeros((h, w, 3), dtype=np.uint8)

        horizon = int(h * 0.45)
        for y in range(horizon):
            t = y / max(horizon - 1, 1)
            img[y, :, 0] = int(90 + 65 * t)
            img[y, :, 1] = int(150 + 65 * t)
            img[y, :, 2] = int(220 + 30 * t)

        road_top_width = int(w * 0.18)
        road_bottom_width = int(w * 0.95)
        center_x = w // 2

        for y in range(horizon, h):
            t = (y - horizon) / max(h - horizon - 1, 1)
            half = int((road_top_width + (road_bottom_width - road_top_width) * t) * 0.5)
            left = max(0, center_x - half)
            right = min(w, center_x + half)
            img[y, left:right, :] = np.array([62, 64, 68], dtype=np.uint8)

            shoulder = max(2, int(3 + 7 * t))
            img[y, max(left - shoulder, 0):left, :] = np.array([140, 140, 110], dtype=np.uint8)
            img[y, right:min(right + shoulder, w), :] = np.array([140, 140, 110], dtype=np.uint8)

        lane_color = np.array([235, 235, 215], dtype=np.uint8)
        for seg in range(26):
            y0 = int(horizon + (seg / 26.0) * (h - horizon))
            y1 = int(horizon + ((seg + 0.5) / 26.0) * (h - horizon))
            if seg % 2 == 0:
                for y in range(y0, min(y1, h)):
                    t = (y - horizon) / max(h - horizon - 1, 1)
                    half = int((road_top_width + (road_bottom_width - road_top_width) * t) * 0.5)
                    lane_half = max(1, int(2 + 4 * t))
                    x = center_x
                    img[y, max(x - lane_half, 0):min(x + lane_half, w), :] = lane_color

        car_count = int(rng.integers(2, 6))
        for _ in range(car_count):
            y = int(rng.integers(int(h * 0.52), int(h * 0.9)))
            t = (y - horizon) / max(h - horizon - 1, 1)
            half = int((road_top_width + (road_bottom_width - road_top_width) * t) * 0.5)
            road_left = center_x - half
            road_right = center_x + half
            car_w = int(max(12, 40 * t))
            car_h = int(max(10, 26 * t))
            if road_right - road_left - car_w < 1:
                continue
            x = int(rng.integers(road_left, road_right - car_w))
            color = np.array(
                [
                    int(rng.integers(50, 220)),
                    int(rng.integers(50, 220)),
                    int(rng.integers(50, 220)),
                ],
                dtype=np.uint8,
            )
            img[y:y + car_h, x:x + car_w, :] = color
            win_h = max(2, car_h // 4)
            img[y:y + win_h, x + 2:x + car_w - 2, :] = np.array([185, 215, 245], dtype=np.uint8)

        for y in range(h):
            shade = 1.0 - 0.1 * (y / max(h - 1, 1))
            img[y, :, :] = np.clip(img[y, :, :].astype(np.float32) * shade, 0, 255).astype(np.uint8)

        noise = rng.normal(loc=0.0, scale=2.0, size=img.shape)
        img = np.clip(img.astype(np.float32) + noise, 0, 255).astype(np.uint8)
        return img

    def _save_frame(self, image: np.ndarray, frame_idx: int, camera_name: str) -> Path:
        timestamp = 1_700_000_000_000_000 + frame_idx * 100_000
        filename = f"{camera_name}_{timestamp}_{frame_idx:06d}.jpg"
        path = DATA_FOLDER / filename
        plt.imsave(path, image)
        return path

    def __iter__(self):
        return self

    def __next__(self):
        if self.iteration >= self.num_images:
            raise StopIteration

        rows = []
        batch_end = min(self.num_images, self.iteration + self.batch_size)
        for frame_idx in range(self.iteration, batch_end):
            camera_name = self.cameras[frame_idx % len(self.cameras)]
            image = self._render_frame(frame_idx, camera_name)
            path = self._save_frame(image, frame_idx, camera_name)
            rows.append(
                {
                    "timestamp": 1_700_000_000_000_000 + frame_idx * 100_000,
                    "camera_name": camera_name,
                    "dataset_type": "synthetic",
                    "image_path": str(path),
                    "source_link": "synthetic://road-scene-generator-v1",
                }
            )
        self.iteration = batch_end
        return pd.DataFrame(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic road images and push to storage")
    parser.add_argument("--num-images", type=int, default=64)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--bucket", type=str, default="synthetic")
    parser.add_argument("--keep-local-images", action="store_true")
    args = parser.parse_args()

    processor = SyntheticRoadPreprocessor(
        num_images=args.num_images,
        batch_size=args.batch_size,
        remove_local_images=not args.keep_local_images,
    )
    processor.download_to_storage(bucket=args.bucket)


if __name__ == "__main__":
    main()
