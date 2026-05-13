import os
import time
from typing import Any, Callable, Dict, List

import httpx


def storage_vector_upsert_batch(
    rows: List[Any],
    *,
    upsert_vectors: Callable[[List[Dict[str, Any]]], int],
) -> int:
    if not rows:
        return 0
    return upsert_vectors(
        [
            {
                "object_id": row.object_id,
                "embedding": row.embedding,
            }
            for row in rows
        ]
    )


def raise_upstream_http_error(exc: httpx.HTTPStatusError) -> None:
    from fastapi import HTTPException

    try:
        detail: Any = exc.response.json()
    except Exception:
        detail = exc.response.text or str(exc)
    raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc


def is_storage_query_unavailable_error(exc: Exception) -> bool:
    if isinstance(exc, httpx.RequestError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = int(exc.response.status_code)
        return status in {502, 503, 504}
    return False


def search_dependencies_ready(
    *,
    model_gateway: Any,
    storage_api: Any,
    embedder_endpoint: str,
    embedder_timeout_sec: int,
    model_backend_ready_wait_sec: float,
    model_backend_ready_poll_sec: float,
    require_embedder: bool = True,
    require_vlm: bool = True,
    allow_embedder_http_fallback: bool = False,
) -> tuple[bool, str]:
    wait_timeout_sec = max(
        0.0,
        float(os.getenv("MODEL_BACKEND_READY_WAIT_SEC", str(model_backend_ready_wait_sec))),
    )
    poll_interval_sec = max(
        0.1,
        float(os.getenv("MODEL_BACKEND_READY_POLL_SEC", str(model_backend_ready_poll_sec))),
    )

    def _embedder_http_ready() -> bool:
        endpoint = str(embedder_endpoint or "").strip().rstrip("/")
        if not endpoint:
            return False
        timeout = httpx.Timeout(min(10.0, max(1.0, float(embedder_timeout_sec))))
        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.get(f"{endpoint}/health")
            if response.status_code >= 400:
                return False
            try:
                payload = response.json()
            except Exception:
                return True
            if not isinstance(payload, dict):
                return True
            status = str(payload.get("status", "")).lower()
            return status in {"", "ok"}
        except Exception:
            return False

    def _evaluate_model_health() -> tuple[bool, Dict[str, Any]]:
        model_health = model_gateway.health()
        if str(model_health.get("status", "")).lower() == "ok":
            return True, model_health

        mode = str(model_health.get("mode", "")).strip().lower()
        if mode == "rabbitmq":
            rabbitmq = model_health.get("rabbitmq", {})
            queues = rabbitmq.get("queues", {}) if isinstance(rabbitmq, dict) else {}
            embedder_queue = os.getenv("RABBITMQ_EMBEDDER_QUEUE", "avsp.embedder.tasks")
            vlm_queue = os.getenv("RABBITMQ_VLM_QUEUE", "avsp.vlm.tasks")
            required_queues: List[str] = []
            if require_embedder:
                required_queues.append(embedder_queue)
            if require_vlm:
                required_queues.append(vlm_queue)
            missing_required: List[str] = []
            for queue_name in required_queues:
                stats = queues.get(queue_name, {}) if isinstance(queues, dict) else {}
                if int(stats.get("consumers", 0)) <= 0:
                    missing_required.append(queue_name)
            if not missing_required and required_queues:
                return True, model_health
            if (
                allow_embedder_http_fallback
                and require_embedder
                and not require_vlm
                and _embedder_http_ready()
            ):
                return True, model_health
            if missing_required:
                model_health = {
                    **model_health,
                    "missing_required_consumers": missing_required,
                }
            return False, model_health
        if (
            allow_embedder_http_fallback
            and require_embedder
            and not require_vlm
            and _embedder_http_ready()
        ):
            return True, model_health
        return False, model_health

    deadline = time.monotonic() + wait_timeout_sec
    last_model_health: Dict[str, Any] = {}
    while True:
        model_ready, model_health = _evaluate_model_health()
        last_model_health = model_health
        if model_ready:
            break
        if time.monotonic() >= deadline:
            return False, f"model backend not ready: {last_model_health}"
        time.sleep(poll_interval_sec)

    try:
        storage_health = storage_api.health()
    except Exception as exc:
        return False, f"storage health check failed: {exc}"
    if str(storage_health.get("status", "")).lower() != "ok":
        return False, f"storage backend not ready: {storage_health}"
    return True, ""


def build_search_backend_unavailable_warning(reason: str, source: str) -> Dict[str, Any]:
    normalized = str(reason).strip()
    lowered = normalized.lower()
    is_model_unavailable = "model backend not ready" in lowered
    return {
        "code": "model_unavailable" if is_model_unavailable else "search_backend_unavailable",
        "source": source,
        "message": (
            "Модель сейчас недоступна (starting/offline). Дождитесь статуса online в Job Monitor."
            if is_model_unavailable
            else f"Search backend is unavailable: {normalized}"
        ),
        "reason": normalized,
    }
