from __future__ import annotations

import os
import resource
from typing import Any
from typing import Union

import torch

TorchDTypeLike = Union[torch.dtype, str, None]


def resolve_device(configured_device: str) -> str:
    cfg_device = str(configured_device).strip().lower()
    if cfg_device == "cuda" and torch.cuda.is_available():
        return "cuda"
    if cfg_device == "mps" and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def process_rss_mb() -> float:
    # Linux containers expose resident pages in /proc/self/statm.
    try:
        with open("/proc/self/statm", "r", encoding="utf-8") as fp:
            parts = fp.read().strip().split()
        if len(parts) >= 2:
            resident_pages = int(parts[1])
            page_size = os.sysconf("SC_PAGE_SIZE")
            return round((resident_pages * page_size) / (1024**2), 2)
    except Exception:
        pass

    try:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        rss = float(usage.ru_maxrss)
        # Linux reports KiB, macOS reports bytes.
        if rss > 10**8:
            return round(rss / (1024**2), 2)
        return round(rss / 1024.0, 2)
    except Exception:
        return 0.0


def runtime_payload(configured_device: str, selected_device: str) -> dict[str, Any]:
    payload = {
        "configured_device": configured_device,
        "selected_device": selected_device,
        "torch_cuda_available": bool(torch.cuda.is_available()),
        "torch_mps_available": bool(torch.backends.mps.is_available()),
        "cuda_device_count": int(torch.cuda.device_count() if torch.cuda.is_available() else 0),
        "cuda_device_name": None,
    }

    memory = {
        "process_rss_mb": process_rss_mb(),
        "gpu_allocated_mb": 0.0,
        "gpu_reserved_mb": 0.0,
        "gpu_total_mb": 0.0,
        "gpu_free_mb": 0.0,
    }

    if selected_device == "cuda" and torch.cuda.is_available():
        try:
            current = torch.cuda.current_device()
            payload["cuda_device_name"] = torch.cuda.get_device_name(current)
            memory["gpu_allocated_mb"] = round(torch.cuda.memory_allocated(current) / (1024**2), 2)
            memory["gpu_reserved_mb"] = round(torch.cuda.memory_reserved(current) / (1024**2), 2)
            free_bytes, total_bytes = torch.cuda.mem_get_info(current)
            memory["gpu_total_mb"] = round(total_bytes / (1024**2), 2)
            memory["gpu_free_mb"] = round(free_bytes / (1024**2), 2)
        except Exception:
            pass

    return {"runtime": payload, "memory": memory}


def resolve_torch_dtype(
    configured_dtype: str | None,
    *,
    device: str,
    default_cuda: str = "bfloat16",
    default_other: str = "float32",
) -> tuple[TorchDTypeLike, str]:
    """
    Resolve string dtype from config/env into a value that can be passed to
    HuggingFace `from_pretrained(..., dtype=...)` or SentenceTransformer
    `model_kwargs={"dtype": ...}`.
    """

    normalized = str(configured_dtype).strip().lower() if configured_dtype is not None else ""
    if not normalized:
        normalized = default_cuda if device == "cuda" else default_other

    aliases: dict[str, TorchDTypeLike] = {
        "auto": "auto",
        "fp32": torch.float32,
        "float32": torch.float32,
        "float": torch.float32,
        "fp16": torch.float16,
        "float16": torch.float16,
        "half": torch.float16,
        "bf16": torch.bfloat16,
        "bfloat16": torch.bfloat16,
    }

    if normalized not in aliases:
        supported = ", ".join(sorted(aliases.keys()))
        raise ValueError(
            f"Unsupported torch dtype '{configured_dtype}'. "
            f"Supported values: {supported}"
        )

    dtype_value = aliases[normalized]
    if isinstance(dtype_value, str):
        return dtype_value, dtype_value
    return dtype_value, str(dtype_value).replace("torch.", "")


def resolve_bool_flag(value: object, *, default: bool = True, name: str = "flag") -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on", "y"}:
        return True
    if normalized in {"0", "false", "no", "off", "n"}:
        return False
    raise ValueError(
        f"Unsupported value for {name}: {value!r}. "
        "Expected one of: true/false, 1/0, yes/no, on/off."
    )
