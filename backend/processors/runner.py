from __future__ import annotations

import math
from typing import Any, Callable, Dict, List, Optional, Tuple

from .argoverse_preprocessor import ArgoversePreprocessor
from .nuimages_preprocessor import NuImagesPreprocessor
from .synthetic_preprocessor import SyntheticRoadPreprocessor
from .waymo_preprocessor import WaymoPreprocessor


ProgressCallback = Callable[[Dict[str, Any]], None]


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:  # noqa: BLE001
        return default


def _to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:  # noqa: BLE001
        return default


def _to_optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except Exception:  # noqa: BLE001
        return None


def _to_str_list(value: Any, default: Optional[List[str]] = None) -> List[str]:
    if isinstance(value, list):
        out = [str(item).strip() for item in value if str(item).strip()]
        return out if out else (default or [])
    return default or []


def _normalize_download_parts(value: Any) -> Dict[str, List[int]]:
    if not isinstance(value, dict):
        return {"train": [0, 1], "val": [0], "test": [0]}
    out: Dict[str, List[int]] = {}
    for split, raw_parts in value.items():
        if not isinstance(raw_parts, list):
            continue
        parts: List[int] = []
        for item in raw_parts:
            try:
                parts.append(int(item))
            except Exception:  # noqa: BLE001
                continue
        out[str(split)] = parts
    return out or {"train": [0, 1], "val": [0], "test": [0]}


def _build_preprocessor(
    method_key: str,
    cfg: Dict[str, Any],
) -> Tuple[Any, str, int]:
    key = method_key.strip().lower()
    if key == "synthetic":
        num_images = max(1, _to_int(cfg.get("num_images", 64), 64))
        batch_size = max(1, _to_int(cfg.get("batch_size", 16), 16))
        keep_local_images = _to_bool(cfg.get("keep_local_images", False), False)
        preprocessor = SyntheticRoadPreprocessor(
            num_images=num_images,
            batch_size=batch_size,
            cameras=_to_str_list(cfg.get("cameras"), ["FRONT", "FRONT_LEFT", "FRONT_RIGHT"]),
            width=max(320, _to_int(cfg.get("width", 960), 960)),
            height=max(240, _to_int(cfg.get("height", 540), 540)),
            seed=_to_int(cfg.get("seed", 7), 7),
            remove_local_images=not keep_local_images,
        )
        bucket = str(cfg.get("bucket", "avsp")).strip() or "avsp"
        planned_total = int(math.ceil(num_images / max(batch_size, 1)))
        return preprocessor, bucket, planned_total

    if key == "waymo":
        preprocessor = WaymoPreprocessor(
            cameras=_to_str_list(cfg.get("cameras"), ["FRONT"]),
            resample_seconds=_to_float(cfg.get("resample_seconds", 0.5), 0.5),
            exist_skip=_to_bool(cfg.get("exist_skip", False), False),
        )
        bucket = str(cfg.get("bucket", "waymo")).strip() or "waymo"
        planned_total = len(preprocessor)
        return preprocessor, bucket, planned_total

    if key == "argoverse":
        parts = _normalize_download_parts(cfg.get("download_parts"))
        preprocessor = ArgoversePreprocessor(
            cameras=_to_str_list(cfg.get("cameras"), ["FRONT"]),
            resample_seconds=_to_float(cfg.get("resample_seconds", 0.5), 0.5),
            download_parts=parts,
            remove_after_load=_to_bool(cfg.get("remove_after_load", False), False),
        )
        bucket = str(cfg.get("bucket", "argoverse")).strip() or "argoverse"
        planned_total = sum(len(v) for v in parts.values())
        return preprocessor, bucket, planned_total

    if key in {"nuimages", "nuscenes"}:
        preprocessor = NuImagesPreprocessor(
            cameras=_to_str_list(cfg.get("cameras"), ["FRONT"]),
            resample_seconds=_to_float(cfg.get("resample_seconds", 0.5), 0.5),
            image_roots=_to_str_list(cfg.get("image_roots"), ["sweeps", "samples"]),
            extract_with_progress=_to_bool(cfg.get("extract_with_progress", False), False),
            limit=_to_optional_int(cfg.get("limit")),
        )
        keep_local_images = _to_bool(cfg.get("keep_local_images", True), True)
        preprocessor.remove_local_images = not keep_local_images
        bucket = str(cfg.get("bucket", "nuimages")).strip() or "nuimages"
        planned_total = len(preprocessor)
        return preprocessor, bucket, planned_total

    raise ValueError(f"Unsupported preprocessor method: {method_key}")


def run_preprocessor_method(
    method_key: str,
    config: Dict[str, Any],
    progress_callback: Optional[ProgressCallback] = None,
    cancel_requested_callback: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    cfg = dict(config or {})
    preprocessor, bucket, planned_total = _build_preprocessor(method_key, cfg)

    if progress_callback:
        progress_callback(
            {
                "event": "start",
                "total_planned": planned_total,
            }
        )

    if hasattr(preprocessor, "download_progress_callback"):
        def _download_progress(payload: Dict[str, Any]) -> None:
            if not progress_callback:
                return
            progress_callback(
                {
                    "event": "download",
                    "current_scene_index": int(payload.get("file_index", 0) or 0),
                    "total_planned": int(payload.get("total_files", planned_total) or planned_total),
                    "current_scene_tasks_completed": int(payload.get("downloaded_bytes", 0) or 0),
                    "current_scene_tasks_total": int(payload.get("total_bytes", 0) or 0),
                }
            )

        preprocessor.download_progress_callback = _download_progress
    if cancel_requested_callback is not None:
        preprocessor.cancel_requested_callback = cancel_requested_callback

    summary = preprocessor.download_to_storage(
        bucket=bucket,
        progress_callback=progress_callback,
        should_stop_callback=cancel_requested_callback,
    )

    out = {
        "method_key": method_key,
        "bucket": bucket,
        "total_planned": planned_total,
    }
    out.update(summary or {})
    return out
