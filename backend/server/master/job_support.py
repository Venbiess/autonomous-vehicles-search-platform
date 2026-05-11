import queue
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple

import httpx

from .embedder import storage_vector_upsert_batch
from .models import EmbedResult, JobStatus
from .state import JOB_LOG_DIR, jobs_lock, jobs_store, logger, model_gateway, storage_api
from configs.common import EMBEDDER_ENDPOINT, EMBEDDER_TIMEOUT_SEC


def to_bool(value: Any, default: bool = False) -> bool:
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


def normalize_job_config(payload: Any) -> Dict[str, Any]:
    if payload is None:
        return {}
    if hasattr(payload, "model_dump"):
        try:
            dumped = payload.model_dump()
            if isinstance(dumped, dict):
                return dumped
        except Exception:
            pass
    if hasattr(payload, "dict"):
        try:
            dumped = payload.dict()
            if isinstance(dumped, dict):
                return dumped
        except Exception:
            pass
    if isinstance(payload, dict):
        return dict(payload)
    return {}


def embed_image(client: httpx.Client, image_bytes: bytes) -> Tuple[List[float], int]:
    return model_gateway.embed_image(client, EMBEDDER_ENDPOINT, image_bytes)


def embed_images(client: httpx.Client, images_bytes: List[bytes]) -> Tuple[List[List[float]], int]:
    return model_gateway.embed_images(client, EMBEDDER_ENDPOINT, images_bytes)


def job_cancel_requested(job_id: str) -> bool:
    with jobs_lock:
        job = jobs_store.get(job_id)
        return bool(job and job.get("cancel_requested"))


def job_install_cleanup_mode(job_id: str) -> str:
    with jobs_lock:
        job = jobs_store.get(job_id) or {}
        mode = str(job.get("install_cleanup_mode", "keep")).strip().lower()
    return mode if mode in {"keep", "delete"} else "keep"


def chunk_object_ids(object_ids: List[str], chunk_size: int = 500) -> List[List[str]]:
    if chunk_size <= 0:
        chunk_size = 500
    normalized = [str(item).strip() for item in object_ids if str(item).strip()]
    if not normalized:
        return []
    return [normalized[i : i + chunk_size] for i in range(0, len(normalized), chunk_size)]


def mark_job_cancelled(
    job_id: str,
    total_seen: int,
    total_inserted: int,
    errors: List[Dict[str, str]],
    extra_updates: Optional[Dict[str, Any]] = None,
) -> None:
    with jobs_lock:
        if job_id in jobs_store:
            payload: Dict[str, Any] = {
                "status": JobStatus.CANCELLED.value,
                "total_seen": total_seen,
                "total_inserted": total_inserted,
                "current_scene_tasks_completed": 0,
                "current_scene_tasks_total": 0,
                "errors": errors,
                "updated_at": time.time(),
            }
            if extra_updates:
                payload.update(extra_updates)
            jobs_store[job_id].update(payload)


def append_job_log(job: Dict[str, Any], message: str) -> None:
    text = str(message or "").strip()
    if not text:
        return
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {text}"
    logs = job.get("job_log")
    if not isinstance(logs, list):
        logs = []
        job["job_log"] = logs
    logs.append(line)
    if len(logs) > 5000:
        del logs[:-5000]

    job_id = str(job.get("job_id", "")).strip()
    if job_id:
        log_path = JOB_LOG_DIR / f"{job_id}.log"
        job["job_log_path"] = str(log_path)
        try:
            with log_path.open("a", encoding="utf-8") as fp:
                fp.write(line + "\n")
        except Exception:
            logger.exception("Failed to write job log file for job_id=%s", job_id)


def record_job_error(
    job_id: str,
    errors: List[Dict[str, str]],
    error_item: Dict[str, str],
    *,
    log_message: Optional[str] = None,
) -> None:
    errors.append(error_item)
    with jobs_lock:
        job = jobs_store.get(job_id)
        if not job:
            return
        job["errors"] = list(errors)
        job["updated_at"] = time.time()
        if log_message:
            append_job_log(job, log_message)
        detail_log = str(error_item.get("log", "")).strip()
        if detail_log:
            append_job_log(job, detail_log)


def current_model_health_text() -> str:
    try:
        return str(model_gateway.health())
    except Exception as exc:
        return f"health check failed: {exc}"


def build_error_item(exc: Exception, object_id: Optional[str] = None) -> Dict[str, str]:
    item: Dict[str, str] = {"error": str(exc), "log": traceback.format_exc().strip()}
    if object_id:
        item["object_id"] = object_id
    if "rpc timeout waiting for queue=" in str(exc).lower():
        item["model_health"] = current_model_health_text()
    return item


def embed_install_queue_worker(
    job_id: str,
    object_queue: "queue.Queue[Optional[str]]",
    errors: List[Dict[str, str]],
    batch_size: int = 16,
) -> None:
    timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)
    requested_batch = max(1, int(batch_size))
    producer_done = False
    pending_ids: List[str] = []

    with httpx.Client(timeout=timeout) as client:
        while True:
            if job_cancel_requested(job_id):
                raise InterruptedError("Dataset installation cancelled by user")

            queue_wait_timed_out = False
            if not producer_done and len(pending_ids) < requested_batch:
                try:
                    item = object_queue.get(timeout=0.25)
                    if item is None:
                        producer_done = True
                    else:
                        pending_ids.append(item)
                except queue.Empty:
                    queue_wait_timed_out = True

            if not pending_ids:
                if producer_done:
                    break
                continue

            if len(pending_ids) < requested_batch and not producer_done and not queue_wait_timed_out:
                continue

            batch_ids = pending_ids[:requested_batch]
            del pending_ids[:requested_batch]

            batch_payload = storage_api.get_object_bytes_batch(batch_ids)
            by_object_id = {
                item.get("object_id"): item for item in batch_payload if item.get("object_id")
            }
            rows: List[EmbedResult] = []
            valid_ids: List[str] = []
            valid_images: List[bytes] = []

            for object_id in batch_ids:
                if job_cancel_requested(job_id):
                    raise InterruptedError("Dataset installation cancelled by user")
                try:
                    batch_item = by_object_id.get(object_id)
                    if not batch_item:
                        raise ValueError("object not returned in batch response")
                    if batch_item.get("error"):
                        raise ValueError(str(batch_item.get("error")))
                    image_bytes = batch_item.get("content", b"")
                    if not image_bytes:
                        raise ValueError("empty content")
                    valid_ids.append(object_id)
                    valid_images.append(image_bytes)
                except Exception as exc:
                    logger.exception("Auto-embedding failed for object_id=%s", object_id)
                    error_item = build_error_item(exc, object_id)
                    timeout_note = ""
                    if error_item.get("model_health"):
                        timeout_note = f" | model_health={error_item['model_health']}"
                    record_job_error(
                        job_id,
                        errors,
                        error_item,
                        log_message=f"Embedding error: object_id={object_id} | {exc}{timeout_note}",
                    )

            if valid_images:
                if len(valid_images) == 1:
                    object_id = valid_ids[0]
                    image_bytes = valid_images[0]
                    try:
                        embedding, dim = embed_image(client, image_bytes)
                        rows.append(EmbedResult(object_id=object_id, embedding=embedding, dim=dim))
                    except Exception as exc:
                        logger.exception("Auto-embedding failed for single object_id=%s", object_id)
                        error_item = build_error_item(exc, object_id)
                        timeout_note = ""
                        if error_item.get("model_health"):
                            timeout_note = f" | model_health={error_item['model_health']}"
                        record_job_error(
                            job_id,
                            errors,
                            error_item,
                            log_message=f"Embedding error: object_id={object_id} | {exc}{timeout_note}",
                        )
                else:
                    try:
                        embeddings, dim = embed_images(client, valid_images)
                        if len(embeddings) != len(valid_ids):
                            raise ValueError(
                                f"batch embedding size mismatch: expected={len(valid_ids)} actual={len(embeddings)}"
                            )
                        rows.extend(
                            EmbedResult(object_id=object_id, embedding=embedding, dim=dim)
                            for object_id, embedding in zip(valid_ids, embeddings)
                        )
                    except Exception:
                        logger.exception(
                            "Auto-embedding batch failed (size=%s), falling back to per-item",
                            len(valid_ids),
                        )
                        for object_id, image_bytes in zip(valid_ids, valid_images):
                            try:
                                embedding, dim = embed_image(client, image_bytes)
                                rows.append(EmbedResult(object_id=object_id, embedding=embedding, dim=dim))
                            except Exception as exc:
                                logger.exception("Auto-embedding fallback failed for object_id=%s", object_id)
                                error_item = build_error_item(exc, object_id)
                                timeout_note = ""
                                if error_item.get("model_health"):
                                    timeout_note = f" | model_health={error_item['model_health']}"
                                record_job_error(
                                    job_id,
                                    errors,
                                    error_item,
                                    log_message=f"Embedding fallback error: object_id={object_id} | {exc}{timeout_note}",
                                )

            upserted = 0
            if rows:
                try:
                    upserted = storage_vector_upsert_batch(rows, upsert_vectors=storage_api.upsert_vectors)
                    if upserted != len(rows):
                        mismatch_error = f"auto-embedding upsert mismatch: expected={len(rows)} actual={upserted}"
                        record_job_error(
                            job_id,
                            errors,
                            {"error": mismatch_error},
                            log_message=f"Embedding upsert mismatch: {mismatch_error}",
                        )
                except Exception as exc:
                    logger.exception("Auto-embedding vector upsert failed for rows=%s", len(rows))
                    record_job_error(
                        job_id,
                        errors,
                        {"error": str(exc)},
                        log_message=f"Embedding upsert error: {exc}",
                    )

            with jobs_lock:
                job = jobs_store.get(job_id)
                if job:
                    job["embedding_tasks_completed"] = int(job.get("embedding_tasks_completed", 0) or 0) + len(batch_ids)
                    job["total_embeddings_inserted"] = int(job.get("total_embeddings_inserted", 0) or 0) + int(upserted)
                    job["updated_at"] = time.time()
