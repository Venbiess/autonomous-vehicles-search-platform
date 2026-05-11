import os
import subprocess
import time
from typing import Any, Dict, List, Optional

import httpx
import psutil


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def to_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except Exception:
        return default


def collect_nvidia_info() -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "available": False,
        "driver_version": "",
        "cuda_version": "",
        "gpus": [],
        "error": "",
    }

    try:
        version_run = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if version_run.returncode == 0:
            first_line = version_run.stdout.strip().splitlines()
            if first_line:
                out["driver_version"] = first_line[0].strip()

        run = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if run.returncode != 0:
            stderr = (run.stderr or "").strip()
            out["error"] = stderr or "nvidia-smi returned non-zero status"
            return out

        lines = [line.strip() for line in run.stdout.splitlines() if line.strip()]
        gpus: List[Dict[str, Any]] = []
        for line in lines:
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 7:
                continue
            used_mb = to_float(parts[4], 0.0)
            total_mb = to_float(parts[5], 0.0)
            gpus.append(
                {
                    "index": to_int(parts[0], 0),
                    "name": parts[1],
                    "uuid": parts[2],
                    "utilization_percent": to_float(parts[3], 0.0),
                    "memory_used_mb": round(used_mb, 2),
                    "memory_total_mb": round(total_mb, 2),
                    "memory_free_mb": round(max(total_mb - used_mb, 0.0), 2),
                    "memory_used_percent": round((used_mb / total_mb) * 100, 2)
                    if total_mb > 0
                    else 0.0,
                    "temperature_c": to_float(parts[6], 0.0),
                }
            )

        out["gpus"] = gpus
        out["available"] = len(gpus) > 0
        return out
    except FileNotFoundError:
        out["error"] = "nvidia-smi not found"
        return out
    except Exception as exc:
        out["error"] = str(exc)
        return out


def fetch_model_runtime(
    name: str,
    endpoint: str,
    timeout_sec: int = 3,
    *,
    fallback_model: str = "",
    fallback_device: str = "",
    fallback_dtype: str = "",
    fallback_attn_type: str = "",
) -> Dict[str, Any]:
    normalized_endpoint = endpoint.rstrip("/")
    configured_device = str(fallback_device).strip().lower()
    configured_dtype = str(fallback_dtype).strip()
    configured_attn_type = str(fallback_attn_type).strip()
    result: Dict[str, Any] = {
        "name": name,
        "endpoint": normalized_endpoint,
        "reachable": False,
        "status": "unavailable",
        "model": str(fallback_model).strip(),
        "device": configured_device,
        "runtime": {
            "configured_device": configured_device,
            "dtype": configured_dtype,
            "attn_type": configured_attn_type,
        },
        "memory": {},
        "counters": {},
        "error": "",
    }

    if not normalized_endpoint:
        result["error"] = "endpoint is empty"
        return result

    try:
        timeout = httpx.Timeout(timeout_sec)
        with httpx.Client(timeout=timeout) as client:
            response = client.get(f"{normalized_endpoint}/health")
        if not response.is_success:
            result["error"] = f"health status={response.status_code}"
            return result

        payload = response.json()
        runtime = payload.get("runtime", {}) if isinstance(payload, dict) else {}
        memory = payload.get("memory", {}) if isinstance(payload, dict) else {}
        counters = payload.get("counters", {}) if isinstance(payload, dict) else {}
        device = ""
        if isinstance(runtime, dict):
            device = str(runtime.get("selected_device", "")).strip()
        if not device and isinstance(payload, dict):
            device = str(payload.get("device", "")).strip()

        result.update(
            {
                "reachable": True,
                "status": str(payload.get("status", "ok")) if isinstance(payload, dict) else "ok",
                "model": str(payload.get("model", "")) if isinstance(payload, dict) else "",
                "device": device,
                "runtime": runtime if isinstance(runtime, dict) else {},
                "memory": memory if isinstance(memory, dict) else {},
                "counters": counters if isinstance(counters, dict) else {},
            }
        )
        return result
    except Exception as exc:
        message = str(exc).strip()
        lowered = message.lower()
        if (
            "connection refused" in lowered
            or "all connection attempts failed" in lowered
            or "timed out" in lowered
        ):
            result["status"] = "starting"
            result["error"] = ""
            return result
        result["error"] = message
        return result


def sample_existing_embedding_dim(storage_api: Any, max_objects_scan: int = 512) -> Optional[int]:
    cursor = ""
    scanned = 0
    page_limit = 128

    while scanned < max_objects_scan:
        limit = min(page_limit, max_objects_scan - scanned)
        payload = storage_api.list_objects(limit=limit, cursor=cursor or None)
        items = payload.get("items", []) if isinstance(payload, dict) else []
        if not isinstance(items, list) or len(items) == 0:
            return None

        object_ids = [
            str(item.get("object_id", "")).strip()
            for item in items
            if isinstance(item, dict) and str(item.get("object_id", "")).strip()
        ]
        scanned += len(object_ids)
        if object_ids:
            completed = storage_api.completed_vector_object_ids(object_ids)
            if completed:
                vectors = storage_api.get_vectors(completed[:1])
                if vectors:
                    embedding = vectors[0].get("embedding", []) if isinstance(vectors[0], dict) else []
                    if isinstance(embedding, list) and embedding:
                        return len(embedding)

        next_cursor = str(payload.get("next_cursor", "")).strip() if isinstance(payload, dict) else ""
        if not next_cursor:
            break
        cursor = next_cursor
    return None


def build_embedding_dim_warning(
    *,
    query_embedding: List[float],
    source: str,
    storage_api: Any,
    logger: Any,
) -> Optional[Dict[str, Any]]:
    query_dim = len(query_embedding)
    if query_dim <= 0:
        return None
    try:
        total_vectors = max(0, int(storage_api.count_vectors()))
        if total_vectors == 0:
            return None
        stored_dim = sample_existing_embedding_dim(storage_api)
        if stored_dim is None or stored_dim <= 0 or stored_dim == query_dim:
            return None
        return {
            "code": "embedding_dim_mismatch",
            "source": source,
            "query_dim": query_dim,
            "stored_dim": int(stored_dim),
            "message": (
                f"Embedding dimension mismatch: query_dim={query_dim}, stored_dim={stored_dim}. "
                "Search results may be empty until embeddings are rebuilt."
            ),
        }
    except Exception as exc:
        logger.warning("failed to detect embedding dimension mismatch: %s", exc)
        return None


def build_system_info(
    *,
    embedder_endpoint: str,
    vlm_endpoint: str,
    embedder_config: Any,
    vlm_config: Any,
) -> Dict[str, Any]:
    cpu_percent = psutil.cpu_percent(interval=None)
    cpu_count = psutil.cpu_count()
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    uptime_seconds = int(time.time() - psutil.boot_time())
    embedder_runtime = fetch_model_runtime(
        "embedder",
        embedder_endpoint,
        fallback_model=os.getenv(
            "EMBEDDER_MODEL_NAME",
            str(getattr(embedder_config, "MODEL_NAME", "") or ""),
        ),
        fallback_device=os.getenv(
            "EMBEDDER_DEVICE",
            str(getattr(embedder_config, "DEVICE", "") or ""),
        ),
        fallback_dtype=os.getenv(
            "EMBEDDER_TORCH_DTYPE",
            str(getattr(embedder_config, "TORCH_DTYPE", "") or ""),
        ),
        fallback_attn_type=os.getenv(
            "EMBEDDER_ATTN_IMPLEMENTATION",
            str(getattr(embedder_config, "ATTN_IMPLEMENTATION", "") or ""),
        ),
    )
    vlm_runtime = fetch_model_runtime(
        "vlm",
        vlm_endpoint,
        fallback_model=os.getenv(
            "VLM_MODEL_NAME",
            str(getattr(vlm_config, "MODEL_NAME", "") or ""),
        ),
        fallback_device=os.getenv(
            "VLM_DEVICE",
            str(getattr(vlm_config, "DEVICE", "") or ""),
        ),
        fallback_dtype=os.getenv(
            "VLM_TORCH_DTYPE",
            str(getattr(vlm_config, "TORCH_DTYPE", "") or ""),
        ),
        fallback_attn_type=os.getenv(
            "VLM_ATTN_IMPLEMENTATION",
            str(getattr(vlm_config, "ATTN_IMPLEMENTATION", "") or ""),
        ),
    )
    gpu_info = collect_nvidia_info()
    return {
        "cpu": {
            "usage_percent": cpu_percent,
            "cores": cpu_count,
        },
        "memory": {
            "total_gb": round(memory.total / (1024 ** 3), 2),
            "used_gb": round(memory.used / (1024 ** 3), 2),
            "available_gb": round(memory.available / (1024 ** 3), 2),
            "usage_percent": round(memory.percent, 2),
        },
        "disk": {
            "total_gb": round(disk.total / (1024 ** 3), 2),
            "used_gb": round(disk.used / (1024 ** 3), 2),
            "available_gb": round((disk.total - disk.used) / (1024 ** 3), 2),
            "usage_percent": round((disk.used / disk.total) * 100, 2),
        },
        "gpu": gpu_info,
        "services": {
            "embedder": embedder_runtime,
            "vlm": vlm_runtime,
        },
        "uptime_seconds": uptime_seconds,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
