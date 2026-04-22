import logging
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

import httpx
import psutil
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from backend.processors.runner import run_preprocessor_method
from configs.common import (
    ANALYTICS_SERVER_ENDPOINT,
    ANALYTICS_SERVER_TIMEOUT_SEC,
    EMBEDDER_ENDPOINT,
    EMBEDDER_TIMEOUT_SEC,
    STORAGE_SERVER_ENDPOINT,
    STORAGE_SERVER_TIMEOUT_SEC,
    STORAGE_WRITE_TOKEN,
    VLM_ENDPOINT,
    VLM_TIMEOUT_SEC,
)
from backend.server.analytics_api import AnalyticsAPI
from backend.server.storage_api import StorageAPI

logger = logging.getLogger("avsp.master")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="AVSP Master Server")

jobs_store: Dict[str, Dict[str, Any]] = {}
jobs_lock = threading.Lock()
JOB_LOG_DIR = Path("/tmp/avsp-job-logs")
JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)
JOBS_INSTALL_LOG_TAIL_LINES = 200

VLM_RESPONSE_TYPES = {"short_text", "text", "yes_no", "number", "category"}
VLM_RESPONSE_HINTS = {
    "short_text": "Answer briefly in a single short phrase. Do not explain.",
    "text": "Answer with a detailed description in 2-4 sentences.",
    "yes_no": "Answer with exactly one token: Yes or No.",
    "number": "Answer with a single integer number only.",
    "category": "Answer with a single short category label only.",
}


class JobStatus(str, Enum):
    RUNNING = "running"
    SUCCESS = "success"
    ERROR = "error"
    CANCELLED = "cancelled"


class BackfillRequest(BaseModel):
    limit: int = Field(1000, ge=1)
    batch_size: int = Field(50, ge=1)
    stop_on_error: bool = False
    dry_run: bool = False


class TextSearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(5, ge=1)
    max_rows: int = Field(10000, ge=1)


class VLMFieldDefinition(BaseModel):
    name: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    response_type: str = Field("text", min_length=1)


class VLMFieldsRequest(BaseModel):
    fields: List[VLMFieldDefinition] = Field(..., min_length=1)


class VLMBackfillRequest(BaseModel):
    field_names: List[str] = Field(default_factory=list)
    limit: int = Field(1000, ge=1)
    batch_size: int = Field(10, ge=1)
    stop_on_error: bool = False
    dry_run: bool = False
    overwrite_existing: bool = False
    max_new_tokens: int = Field(32, ge=1, le=512)


class VLMFilterDefinition(BaseModel):
    field_name: str = Field(..., min_length=1)
    value: str = Field(..., min_length=1)
    match_mode: str = Field("exact", min_length=1)


class VLMSearchRequest(BaseModel):
    filters: List[VLMFilterDefinition] = Field(..., min_length=1)
    limit: int = Field(100, ge=1, le=1000)


class CancelJobRequest(BaseModel):
    job_id: str = Field(..., min_length=1)
    install_cleanup_mode: str = Field("keep", min_length=1)


class ObjectIDsRequest(BaseModel):
    object_ids: List[str] = Field(default_factory=list)


class AnnotationRowsRequest(BaseModel):
    rows: List[Dict[str, Any]] = Field(default_factory=list)


class DatasetInstallRequest(BaseModel):
    datasets: List[str] = Field(..., min_length=1)
    configs: Dict[str, Dict[str, Any]] = Field(default_factory=dict)


@dataclass(frozen=True)
class EmbedResult:
    object_id: str
    embedding: List[float]
    dim: int

storage_api = StorageAPI(
    endpoint=STORAGE_SERVER_ENDPOINT,
    timeout_sec=STORAGE_SERVER_TIMEOUT_SEC,
    write_token=STORAGE_WRITE_TOKEN,
)
analytics_api = AnalyticsAPI(
    endpoint=ANALYTICS_SERVER_ENDPOINT,
    timeout_sec=ANALYTICS_SERVER_TIMEOUT_SEC,
)


def _normalize_field_name(field_name: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_]+", "_", field_name.strip().lower())
    normalized = re.sub(r"_+", "_", normalized).strip("_")
    if not normalized:
        raise ValueError("Field name cannot be empty after normalization")
    if normalized[0].isdigit():
        normalized = f"field_{normalized}"
    return normalized


def _normalize_response_type(response_type: str) -> str:
    normalized = response_type.strip().lower()
    if normalized not in VLM_RESPONSE_TYPES:
        raise ValueError(
            f"Unsupported response_type '{response_type}'. "
            f"Allowed values: {sorted(VLM_RESPONSE_TYPES)}"
        )
    return normalized


def _normalize_match_mode(match_mode: str) -> str:
    normalized = match_mode.strip().lower()
    if normalized not in {"exact", "contains"}:
        raise ValueError("match_mode must be 'exact' or 'contains'")
    return normalized


def _normalize_vlm_fields(
    fields: List[VLMFieldDefinition],
) -> List[Dict[str, str]]:
    normalized_fields: List[Dict[str, str]] = []
    seen_names = set()
    for field in fields:
        field_name = _normalize_field_name(field.name)
        if field_name in seen_names:
            raise ValueError(f"Duplicate field name after normalization: {field_name}")
        seen_names.add(field_name)
        normalized_fields.append(
            {
                "field_name": field_name,
                "prompt": field.prompt.strip(),
                "response_type": _normalize_response_type(field.response_type),
            }
        )
    return normalized_fields


def _build_vlm_prompt(prompt: str, response_type: str) -> str:
    suffix = VLM_RESPONSE_HINTS[response_type]
    return f"{prompt.strip()}\n\nFormat requirement: {suffix}"


def _normalize_vlm_response(response_text: str, response_type: str) -> str:
    value = response_text.strip()
    if response_type == "yes_no":
        lowered = value.lower()
        if "yes" in lowered:
            return "Yes"
        if "no" in lowered:
            return "No"
        cleaned = re.sub(r"[^a-zA-Z]", "", value)
        if cleaned.lower().startswith("yes"):
            return "Yes"
        if cleaned.lower().startswith("no"):
            return "No"
        return cleaned or value

    if response_type == "number":
        match = re.search(r"-?\d+(?:[.,]\d+)?", value)
        if match:
            return match.group(0).replace(",", ".")
        cleaned = re.sub(r"[^\d\-.,]", "", value)
        return cleaned

    if response_type == "category":
        value = re.sub(r"[^\w\s-]", "", value, flags=re.UNICODE)
        value = re.sub(r"\s+", " ", value).strip()
        return value

    return value


def _validate_existing_vlm_fields(field_names: List[str]) -> List[Dict[str, str]]:
    normalized_names = [_normalize_field_name(name) for name in field_names]
    fields = analytics_api.get_fields(normalized_names)
    if len(fields) != len(set(normalized_names)):
        existing = {field["field_name"] for field in fields}
        missing = sorted(set(normalized_names) - existing)
        raise ValueError(f"Unknown VLM fields: {missing}")
    return fields


def _upsert_vlm_annotations(rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0
    return analytics_api.upsert_annotations(rows)


def _filter_pending_vlm_object_ids(
    object_ids: List[str],
    field_names: List[str],
    overwrite_existing: bool,
) -> List[str]:
    if overwrite_existing or not object_ids:
        return object_ids
    completed = set(analytics_api.completed_object_ids(object_ids, field_names))
    return [object_id for object_id in object_ids if object_id not in completed]


def _list_object_ids(limit: int, page_size: int = 500) -> List[str]:
    remaining = max(limit, 0)
    cursor: Optional[str] = None
    object_ids: List[str] = []
    while remaining > 0:
        payload = storage_api.list_objects(limit=min(page_size, remaining), cursor=cursor)
        items = payload.get("items", [])
        if not items:
            break
        for item in items:
            object_id = item.get("object_id")
            if object_id:
                object_ids.append(object_id)
                remaining -= 1
                if remaining == 0:
                    break
        next_cursor = payload.get("next_cursor")
        if not next_cursor or remaining == 0:
            break
        cursor = next_cursor
    return object_ids


def _filter_pending_embedding_object_ids(object_ids: List[str]) -> List[str]:
    if not object_ids:
        return []
    completed: set[str] = set()
    chunk_size = 500
    for i in range(0, len(object_ids), chunk_size):
        chunk = object_ids[i : i + chunk_size]
        completed.update(storage_api.completed_vector_object_ids(chunk))
    return [object_id for object_id in object_ids if object_id not in completed]


def _list_pending_embedding_object_ids(limit: int, page_size: int = 500) -> List[str]:
    remaining = max(limit, 0)
    cursor: Optional[str] = None
    pending: List[str] = []

    while remaining > 0:
        payload = storage_api.list_objects(limit=page_size, cursor=cursor)
        items = payload.get("items", [])
        if not items:
            break

        batch_ids: List[str] = []
        for item in items:
            object_id = str(item.get("object_id", "")).strip()
            if object_id:
                batch_ids.append(object_id)

        if batch_ids:
            batch_pending = _filter_pending_embedding_object_ids(batch_ids)
            if batch_pending:
                take = batch_pending[:remaining]
                pending.extend(take)
                remaining -= len(take)

        next_cursor = payload.get("next_cursor")
        if not next_cursor or remaining == 0:
            break
        cursor = next_cursor

    return pending


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


def _storage_vector_upsert_batch(rows: List[EmbedResult]) -> int:
    if not rows:
        return 0
    return storage_api.upsert_vectors(
        [
            {
                "object_id": row.object_id,
                "embedding": row.embedding,
            }
            for row in rows
        ]
    )


def _raise_upstream_http_error(exc: httpx.HTTPStatusError) -> None:
    detail: Any
    try:
        detail = exc.response.json()
    except Exception:  # noqa: BLE001
        detail = exc.response.text or str(exc)
    raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc


def _embed_image(client: httpx.Client, image_bytes: bytes) -> Tuple[List[float], int]:
    url = f"{EMBEDDER_ENDPOINT}/embedding/image_bytes"
    response = client.post(url, content=image_bytes)
    response.raise_for_status()
    payload = response.json()
    return payload["embedding"], payload["dim"]


def _embed_text(client: httpx.Client, text: str) -> Tuple[List[float], int]:
    url = f"{EMBEDDER_ENDPOINT}/embedding/text"
    response = client.post(url, params={"text": text})
    response.raise_for_status()
    payload = response.json()
    return payload["embedding"], payload["dim"]


def _run_vlm(
    client: httpx.Client,
    image_bytes: bytes,
    prompt: str,
    max_new_tokens: int,
    job_id: Optional[str] = None,
    task_index: Optional[int] = None,
    task_total: Optional[int] = None,
    field_name: Optional[str] = None,
    object_id: Optional[str] = None,
) -> str:
    response = client.post(
        f"{VLM_ENDPOINT}/generate",
        data={
            "prompt": prompt,
            "max_new_tokens": str(max_new_tokens),
            "job_id": job_id or "",
            "task_index": str(task_index) if task_index is not None else "",
            "task_total": str(task_total) if task_total is not None else "",
            "field_name": field_name or "",
            "object_id": object_id or "",
        },
        files={"file": ("image.jpg", image_bytes, "image/jpeg")},
    )
    response.raise_for_status()
    payload = response.json()
    return payload["response"].strip()


def _job_cancel_requested(job_id: str) -> bool:
    with jobs_lock:
        job = jobs_store.get(job_id)
        return bool(job and job.get("cancel_requested"))


def _job_install_cleanup_mode(job_id: str) -> str:
    with jobs_lock:
        job = jobs_store.get(job_id) or {}
        mode = str(job.get("install_cleanup_mode", "keep")).strip().lower()
    return mode if mode in {"keep", "delete"} else "keep"


def _mark_job_cancelled(
    job_id: str,
    total_seen: int,
    total_inserted: int,
    errors: List[Dict[str, str]],
) -> None:
    with jobs_lock:
        if job_id in jobs_store:
            jobs_store[job_id].update(
                {
                    "status": JobStatus.CANCELLED.value,
                    "total_seen": total_seen,
                    "total_inserted": total_inserted,
                    "current_scene_tasks_completed": 0,
                    "current_scene_tasks_total": 0,
                    "errors": errors,
                    "updated_at": time.time(),
                }
            )


def _append_install_log(job: Dict[str, Any], message: str) -> None:
    text = str(message or "").strip()
    if not text:
        return
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {text}"
    logs = job.get("install_log")
    if not isinstance(logs, list):
        logs = []
        job["install_log"] = logs
    logs.append(line)
    if len(logs) > 5000:
        del logs[:-5000]

    job_id = str(job.get("job_id", "")).strip()
    if job_id:
        log_path = JOB_LOG_DIR / f"{job_id}.log"
        job["install_log_path"] = str(log_path)
        try:
            with log_path.open("a", encoding="utf-8") as fp:
                fp.write(line + "\n")
        except Exception:  # noqa: BLE001
            logger.exception("Failed to write install log file for job_id=%s", job_id)


def _embed_install_queue_worker(
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
            if _job_cancel_requested(job_id):
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

            # Do not stall progress waiting for a full batch: if queue is idle,
            # process whatever has already been downloaded.
            if len(pending_ids) < requested_batch and not producer_done and not queue_wait_timed_out:
                continue

            batch_ids = pending_ids[:requested_batch]
            del pending_ids[:requested_batch]

            batch_payload = storage_api.get_object_bytes_batch(batch_ids)
            by_object_id = {
                item.get("object_id"): item for item in batch_payload if item.get("object_id")
            }
            rows: List[EmbedResult] = []

            for object_id in batch_ids:
                if _job_cancel_requested(job_id):
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
                    embedding, dim = _embed_image(client, image_bytes)
                    rows.append(
                        EmbedResult(
                            object_id=object_id,
                            embedding=embedding,
                            dim=dim,
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.exception("Auto-embedding failed for object_id=%s", object_id)
                    errors.append({"object_id": object_id, "error": str(exc)})

            upserted = 0
            if rows:
                try:
                    upserted = _storage_vector_upsert_batch(rows)
                    if upserted != len(rows):
                        errors.append(
                            {
                                "error": (
                                    f"auto-embedding upsert mismatch: expected={len(rows)} "
                                    f"actual={upserted}"
                                )
                            }
                        )
                except Exception as exc:  # noqa: BLE001
                    logger.exception(
                        "Auto-embedding vector upsert failed for rows=%s", len(rows)
                    )
                    errors.append({"error": str(exc)})

            with jobs_lock:
                job = jobs_store.get(job_id)
                if job:
                    job["embedding_tasks_completed"] = int(
                        job.get("embedding_tasks_completed", 0) or 0
                    ) + len(batch_ids)
                    job["total_embeddings_inserted"] = int(
                        job.get("total_embeddings_inserted", 0) or 0
                    ) + int(upserted)
                    job["updated_at"] = time.time()


def _run_backfill_job(job_id: str, payload: BackfillRequest):
    with jobs_lock:
        jobs_store[job_id] = {
            "job_id": job_id,
            "job_type": "backfill_embeddings",
            "status": JobStatus.RUNNING.value,
            "cancel_requested": False,
            "progress": 0,
            "total_seen": 0,
            "total_inserted": 0,
            "total_limit": payload.limit,
            "errors": [],
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    total_seen = 0
    total_inserted = 0
    errors = []

    try:
        logger.info(
            "Backfill embeddings job %s started: limit=%s batch_size=%s dry_run=%s",
            job_id,
            payload.limit,
            payload.batch_size,
            payload.dry_run,
        )
        timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)

        object_ids = _list_pending_embedding_object_ids(payload.limit)
        planned_total = len(object_ids)
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id]["total_limit"] = planned_total
                jobs_store[job_id]["updated_at"] = time.time()
        logger.info(
            "Backfill embeddings job %s pending objects=%s (requested limit=%s)",
            job_id,
            planned_total,
            payload.limit,
        )
        with httpx.Client(timeout=timeout) as client:
            for i in range(0, len(object_ids), payload.batch_size):
                if _job_cancel_requested(job_id):
                    _mark_job_cancelled(job_id, total_seen, total_inserted, errors)
                    return
                batch_ids = object_ids[i : i + payload.batch_size]
                rows: List[EmbedResult] = []
                processed_in_batch = 0
                batch_payload = storage_api.get_object_bytes_batch(batch_ids)
                by_object_id = {
                    item.get("object_id"): item for item in batch_payload if item.get("object_id")
                }

                for object_id in batch_ids:
                    if _job_cancel_requested(job_id):
                        _mark_job_cancelled(job_id, total_seen, total_inserted, errors)
                        return
                    try:
                        batch_item = by_object_id.get(object_id)
                        if not batch_item:
                            raise ValueError("object not returned in batch response")
                        if batch_item.get("error"):
                            raise ValueError(str(batch_item.get("error")))
                        image_bytes = batch_item.get("content", b"")
                        if not image_bytes:
                            raise ValueError("empty content")
                        embedding, dim = _embed_image(client, image_bytes)
                        rows.append(
                            EmbedResult(
                                object_id=object_id,
                                embedding=embedding,
                                dim=dim,
                            )
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("Embedding failed for object_id=%s", object_id)
                        errors.append(
                            {"object_id": object_id, "error": str(exc)}
                        )
                        processed_in_batch += 1
                        if payload.stop_on_error:
                            break
                    else:
                        processed_in_batch += 1

                total_seen += processed_in_batch
                if rows and not payload.dry_run:
                    try:
                        upserted = _storage_vector_upsert_batch(rows)
                        total_inserted += upserted
                        if upserted != len(rows):
                            errors.append(
                                {
                                    "error": (
                                        f"vector upsert mismatch: expected={len(rows)} "
                                        f"actual={upserted}"
                                    )
                                }
                            )
                            if payload.stop_on_error:
                                break
                    except Exception as exc:  # noqa: BLE001
                        logger.exception(
                            "Batch vector upsert failed for rows=%s", len(rows)
                        )
                        errors.append({"error": str(exc)})
                        if payload.stop_on_error:
                            break

                progress = min(int((total_seen / max(planned_total, 1)) * 100), 100)
                with jobs_lock:
                    if job_id in jobs_store:
                        jobs_store[job_id].update(
                            {
                                "progress": progress,
                                "total_seen": total_seen,
                                "total_inserted": total_inserted,
                                "errors": errors,
                                "updated_at": time.time(),
                            }
                        )
                if payload.stop_on_error and errors:
                    break

        final_status = JobStatus.SUCCESS if not errors else JobStatus.ERROR
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update(
                    {
                        "status": final_status.value,
                        "progress": 100,
                        "total_seen": total_seen,
                        "total_inserted": total_inserted,
                        "errors": errors,
                        "updated_at": time.time(),
                    }
                )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Backfill embeddings job %s failed", job_id)
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update(
                    {
                        "status": JobStatus.ERROR.value,
                        "errors": errors + [{"error": str(exc), "log": traceback.format_exc()}],
                        "updated_at": time.time(),
                    }
                )


def _run_vlm_backfill_job(job_id: str, payload: VLMBackfillRequest):
    with jobs_lock:
        jobs_store[job_id] = {
            "job_id": job_id,
            "job_type": "backfill_vlm",
            "status": JobStatus.RUNNING.value,
            "cancel_requested": False,
            "progress": 0,
            "total_seen": 0,
            "total_inserted": 0,
            "total_limit": payload.limit,
            "total_tasks_completed": 0,
            "total_tasks_planned": 0,
            "current_scene_tasks_completed": 0,
            "current_scene_tasks_total": 0,
            "current_scene_index": 0,
            "field_names": payload.field_names,
            "errors": [],
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    total_seen = 0
    total_inserted = 0
    errors = []

    try:
        timeout = httpx.Timeout(VLM_TIMEOUT_SEC)

        if payload.field_names:
            fields = _validate_existing_vlm_fields(payload.field_names)
        else:
            fields = analytics_api.get_fields()
        if not fields:
            raise ValueError("No VLM fields configured")

        field_names = [field["field_name"] for field in fields]
        object_ids = _list_object_ids(payload.limit)
        object_ids = _filter_pending_vlm_object_ids(
            object_ids,
            field_names,
            payload.overwrite_existing,
        )
        planned_total = len(object_ids)
        total_tasks_planned = len(object_ids) * len(field_names)
        completed_tasks = 0

        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update(
                    {
                        "total_limit": planned_total,
                        "total_tasks_planned": total_tasks_planned,
                        "updated_at": time.time(),
                    }
                )

        with httpx.Client(timeout=timeout) as client:
            for i in range(0, len(object_ids), payload.batch_size):
                if _job_cancel_requested(job_id):
                    _mark_job_cancelled(job_id, total_seen, total_inserted, errors)
                    return
                batch_ids = object_ids[i : i + payload.batch_size]
                batch_payload = storage_api.get_object_bytes_batch(batch_ids)
                by_object_id = {
                    item.get("object_id"): item for item in batch_payload if item.get("object_id")
                }

                for object_id in batch_ids:
                    if _job_cancel_requested(job_id):
                        _mark_job_cancelled(job_id, total_seen, total_inserted, errors)
                        return
                    try:
                        batch_item = by_object_id.get(object_id)
                        if not batch_item:
                            raise ValueError("object not returned in batch response")
                        if batch_item.get("error"):
                            raise ValueError(str(batch_item.get("error")))
                        image_bytes = batch_item.get("content", b"")
                        if not image_bytes:
                            raise ValueError("empty content")
                        values: Dict[str, str] = {}
                        current_scene_index = total_seen + 1
                        current_scene_tasks_total = len(fields)
                        with jobs_lock:
                            if job_id in jobs_store:
                                jobs_store[job_id].update(
                                    {
                                        "current_scene_index": current_scene_index,
                                        "current_scene_tasks_completed": 0,
                                        "current_scene_tasks_total": current_scene_tasks_total,
                                        "updated_at": time.time(),
                                    }
                                )
                        for field_index, field in enumerate(fields):
                            if _job_cancel_requested(job_id):
                                _mark_job_cancelled(job_id, total_seen, total_inserted, errors)
                                return
                            prompt = _build_vlm_prompt(field["prompt"], field["response_type"])
                            task_index = completed_tasks + field_index + 1
                            values[field["field_name"]] = _run_vlm(
                                client,
                                image_bytes,
                                prompt,
                                payload.max_new_tokens,
                                job_id=job_id,
                                task_index=task_index,
                                task_total=total_tasks_planned if total_tasks_planned > 0 else None,
                                field_name=field["field_name"],
                                object_id=object_id,
                            )
                            values[field["field_name"]] = _normalize_vlm_response(
                                values[field["field_name"]],
                                field["response_type"],
                            )
                            completed_tasks += 1
                        if not payload.dry_run:
                            total_inserted += _upsert_vlm_annotations(
                                [{"object_id": object_id, "values": values}]
                            )
                        total_seen += 1
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("VLM failed for object_id=%s", object_id)
                        errors.append({"object_id": object_id, "error": str(exc)})
                        total_seen += 1
                        if payload.stop_on_error:
                            break

                    progress = min(int((total_seen / max(len(object_ids), 1)) * 100), 100)
                    with jobs_lock:
                        if job_id in jobs_store:
                            jobs_store[job_id].update(
                                {
                                    "progress": progress,
                                    "total_seen": total_seen,
                                    "total_inserted": total_inserted,
                                    "total_tasks_completed": completed_tasks,
                                    "total_tasks_planned": total_tasks_planned,
                                    "current_scene_tasks_completed": 0,
                                    "current_scene_tasks_total": len(fields),
                                    "errors": errors,
                                    "field_names": field_names,
                                    "updated_at": time.time(),
                                }
                            )

                    if payload.stop_on_error and errors:
                        break

                if payload.stop_on_error and errors:
                    break

        final_status = JobStatus.SUCCESS if not errors else JobStatus.ERROR
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update(
                    {
                        "status": final_status.value,
                        "progress": 100,
                        "total_seen": total_seen,
                        "total_inserted": total_inserted,
                        "total_tasks_completed": completed_tasks,
                        "total_tasks_planned": total_tasks_planned,
                        "current_scene_tasks_completed": 0,
                        "current_scene_tasks_total": 0,
                        "errors": errors,
                        "updated_at": time.time(),
                    }
                )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Backfill VLM job %s failed", job_id)
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update(
                    {
                        "status": JobStatus.ERROR.value,
                        "errors": errors + [{"error": str(exc), "log": traceback.format_exc()}],
                        "updated_at": time.time(),
                    }
                )


def _run_dataset_install_job(job_id: str, dataset_key: str, dataset_cfg: Dict[str, Any]):
    cfg = dict(dataset_cfg or {})
    embed_on_install = _to_bool(cfg.get("embed_on_install", False), False)

    with jobs_lock:
        jobs_store[job_id] = {
            "job_id": job_id,
            "job_type": f"install_{dataset_key}",
            "dataset": dataset_key,
            "embed_on_install": embed_on_install,
            "status": JobStatus.RUNNING.value,
            "cancel_requested": False,
            "install_cleanup_mode": "keep",
            "progress": 0,
            "total_seen": 0,
            "total_inserted": 0,
            "total_embeddings_inserted": 0,
            "embedding_tasks_completed": 0,
            "embedding_tasks_total": 0,
            "embedding_worker_running": bool(embed_on_install),
            "total_limit": 0,
            "total_planned": 0,
            "current_scene_tasks_completed": 0,
            "current_scene_tasks_total": 0,
            "current_scene_index": 0,
            "errors": [],
            "install_log": [],
            "install_log_path": str(JOB_LOG_DIR / f"{job_id}.log"),
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    errors: List[Dict[str, str]] = []
    uploaded_object_ids: List[str] = []
    uploaded_object_ids_seen: set[str] = set()
    embed_queue: Optional["queue.Queue[Optional[str]]"] = None
    embed_thread: Optional[threading.Thread] = None
    embed_worker_state: Dict[str, Any] = {"error": None, "cancelled": False}
    embed_worker_lock = threading.Lock()
    embed_worker_stopped = False

    if embed_on_install:
        embed_queue = queue.Queue(maxsize=4096)
        with jobs_lock:
            job = jobs_store.get(job_id)
            if job:
                _append_install_log(
                    job,
                    "Auto-embedding enabled, running in streaming mode during install.",
                )

        def _embed_worker_runner() -> None:
            try:
                _embed_install_queue_worker(
                    job_id=job_id,
                    object_queue=embed_queue,  # type: ignore[arg-type]
                    errors=errors,
                )
            except InterruptedError:
                with embed_worker_lock:
                    embed_worker_state["cancelled"] = True
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "Streaming auto-embedding worker failed: job_id=%s dataset=%s",
                    job_id,
                    dataset_key,
                )
                with embed_worker_lock:
                    embed_worker_state["error"] = {
                        "error": str(exc),
                        "log": traceback.format_exc(),
                    }
            finally:
                with jobs_lock:
                    job = jobs_store.get(job_id)
                    if job:
                        job["embedding_worker_running"] = False
                        job["updated_at"] = time.time()

        embed_thread = threading.Thread(
            target=_embed_worker_runner,
            name=f"embed-install-{job_id[:8]}",
            daemon=True,
        )
        embed_thread.start()

    def _stop_embedding_worker(wait: bool = True) -> None:
        nonlocal embed_worker_stopped
        if embed_worker_stopped:
            return
        worker_alive = bool(embed_thread is not None and embed_thread.is_alive())
        if worker_alive and embed_queue is not None:
            while True:
                try:
                    embed_queue.put(None, timeout=0.2)
                    break
                except queue.Full:
                    if embed_thread is not None and not embed_thread.is_alive():
                        break
                    if _job_cancel_requested(job_id):
                        continue
        if wait and embed_thread is not None:
            embed_thread.join()
        embed_worker_stopped = True

    def _on_progress(event: Dict[str, Any]) -> None:
        ev = str(event.get("event", "")).strip()
        object_id_to_enqueue: Optional[str] = None
        with jobs_lock:
            job = jobs_store.get(job_id)
            if not job:
                return

            if ev == "start":
                total = int(event.get("total_planned", 0) or 0)
                job["total_limit"] = total
                job["total_planned"] = total
                _append_install_log(job, f"Start installation for dataset={dataset_key}, planned={total}")

            if ev == "download":
                job["current_scene_index"] = int(event.get("current_scene_index", 0) or 0)
                job["current_scene_tasks_completed"] = int(
                    event.get("current_scene_tasks_completed", 0) or 0
                )
                job["current_scene_tasks_total"] = int(
                    event.get("current_scene_tasks_total", 0) or 0
                )
                total = int(event.get("total_planned", job.get("total_planned", 0)) or 0)
                if total > 0:
                    job["total_limit"] = total
                    job["total_planned"] = total

            if ev == "upload_progress":
                scene_index = int(event.get("episodes_done", job.get("current_scene_index", 0)) or 0)
                job["current_scene_index"] = scene_index
                job["current_scene_tasks_completed"] = int(
                    event.get("current_scene_tasks_completed", 0) or 0
                )
                job["current_scene_tasks_total"] = int(
                    event.get("current_scene_tasks_total", 0) or 0
                )
                object_id = str(event.get("last_uploaded_object_id", "") or "").strip()
                if object_id and object_id not in uploaded_object_ids_seen:
                    uploaded_object_ids_seen.add(object_id)
                    uploaded_object_ids.append(object_id)
                    if embed_on_install and embed_queue is not None:
                        object_id_to_enqueue = object_id
                        job["embedding_tasks_total"] = int(
                            job.get("embedding_tasks_total", 0) or 0
                        ) + 1

            if ev == "log":
                _append_install_log(job, str(event.get("message", "") or ""))

            if ev == "episode":
                seen = int(event.get("episodes_done", job.get("total_seen", 0)) or 0)
                inserted = int(event.get("uploaded_objects", job.get("total_inserted", 0)) or 0)
                failed = int(event.get("failed_objects", 0) or 0)
                total = int(job.get("total_planned", 0) or 0)
                if total > 0:
                    job["progress"] = min(100, int((seen / max(total, 1)) * 100))
                job["total_seen"] = seen
                job["total_inserted"] = inserted
                if failed > 0:
                    job["errors"] = [{"error": f"failed objects: {failed}"}]
                    _append_install_log(job, f"Failed objects so far: {failed}")
                job["current_scene_index"] = seen

            job["updated_at"] = time.time()

        if object_id_to_enqueue and embed_queue is not None:
            while True:
                if _job_cancel_requested(job_id):
                    break
                if embed_thread is not None and not embed_thread.is_alive():
                    break
                try:
                    embed_queue.put(object_id_to_enqueue, timeout=0.2)
                    break
                except queue.Full:
                    continue

    try:
        summary = run_preprocessor_method(
            dataset_key,
            cfg,
            progress_callback=_on_progress,
            cancel_requested_callback=lambda: _job_cancel_requested(job_id),
        )
        if embed_on_install:
            with jobs_lock:
                job = jobs_store.get(job_id)
                if job:
                    _append_install_log(
                        job,
                        "Dataset download finished, waiting for remaining embedding tasks...",
                    )
            _stop_embedding_worker(wait=True)
            with embed_worker_lock:
                worker_error = embed_worker_state.get("error")
            if worker_error:
                errors.append(worker_error)

        failed_objects = int(summary.get("failed_objects", 0) or 0)
        with jobs_lock:
            if job_id in jobs_store:
                existing_errors = list(jobs_store[job_id].get("errors", []))
                final_errors = existing_errors + errors
                total_embeddings_inserted = int(
                    jobs_store[job_id].get("total_embeddings_inserted", 0) or 0
                )
                jobs_store[job_id].update(
                    {
                        "status": JobStatus.SUCCESS.value
                        if failed_objects == 0 and not final_errors
                        else JobStatus.ERROR.value,
                        "progress": 100,
                        "total_seen": int(summary.get("episodes_done", 0) or 0),
                        "total_inserted": int(summary.get("uploaded_objects", 0) or 0),
                        "total_embeddings_inserted": int(total_embeddings_inserted),
                        "total_limit": int(summary.get("total_planned", jobs_store[job_id].get("total_limit", 0)) or 0),
                        "total_planned": int(summary.get("total_planned", jobs_store[job_id].get("total_planned", 0)) or 0),
                        "embedding_worker_running": False,
                        "current_scene_tasks_completed": 0,
                        "current_scene_tasks_total": 0,
                        "errors": final_errors,
                        "updated_at": time.time(),
                    }
                )
                _append_install_log(
                    jobs_store[job_id],
                    (
                        f"Finished with status={jobs_store[job_id]['status']}, "
                        f"uploaded={jobs_store[job_id].get('total_inserted', 0)}, "
                        f"embeddings={jobs_store[job_id].get('total_embeddings_inserted', 0)}"
                    ),
                )
    except InterruptedError:
        _stop_embedding_worker(wait=True)
        cleanup_mode = _job_install_cleanup_mode(job_id)
        removed_count = 0
        cleanup_errors: List[Dict[str, str]] = []
        if cleanup_mode == "delete":
            for object_id in uploaded_object_ids:
                try:
                    delete_result = storage_api.delete_object(object_id)
                    if bool(delete_result.get("deleted", False)):
                        removed_count += 1
                except Exception as exc:  # noqa: BLE001
                    cleanup_errors.append(
                        {"object_id": object_id, "error": f"cleanup failed: {exc}"}
                    )

        with jobs_lock:
            if job_id in jobs_store:
                existing_errors = list(jobs_store[job_id].get("errors", []))
                if cleanup_mode == "delete":
                    existing_errors.append(
                        {
                            "error": (
                                f"Cancellation cleanup removed {removed_count} / "
                                f"{len(uploaded_object_ids)} uploaded objects"
                            )
                        }
                    )
                jobs_store[job_id].update(
                    {
                        "status": JobStatus.CANCELLED.value,
                        "total_inserted": max(
                            0,
                            int(jobs_store[job_id].get("total_inserted", 0) or 0)
                            - removed_count,
                        ),
                        "embedding_worker_running": False,
                        "current_scene_tasks_completed": 0,
                        "current_scene_tasks_total": 0,
                        "errors": existing_errors + cleanup_errors,
                        "updated_at": time.time(),
                    }
                )
                _append_install_log(
                    jobs_store[job_id],
                    f"Cancelled (cleanup_mode={cleanup_mode}, removed={removed_count}/{len(uploaded_object_ids)})",
                )
    except Exception as exc:  # noqa: BLE001
        _stop_embedding_worker(wait=True)
        logger.exception("Dataset installation job failed: job_id=%s dataset=%s", job_id, dataset_key)
        errors.append({"error": str(exc), "log": traceback.format_exc()})
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update(
                    {
                        "status": JobStatus.ERROR.value,
                        "embedding_worker_running": False,
                        "errors": errors,
                        "updated_at": time.time(),
                    }
                )
                _append_install_log(jobs_store[job_id], f"Failed: {exc}")


@app.get("/health")
def healthcheck():
    return {"status": "ok"}


@app.get("/jobs")
def get_jobs():
    with jobs_lock:
        jobs = []
        for raw_job in jobs_store.values():
            job = dict(raw_job)
            install_log = raw_job.get("install_log")
            if isinstance(install_log, list):
                if len(install_log) > JOBS_INSTALL_LOG_TAIL_LINES:
                    job["install_log"] = install_log[-JOBS_INSTALL_LOG_TAIL_LINES:]
                    job["install_log_truncated"] = True
                else:
                    job["install_log"] = list(install_log)
                    job["install_log_truncated"] = False
            jobs.append(job)
    jobs.sort(key=lambda item: item.get("created_at", 0), reverse=True)
    return {"jobs": jobs}


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:  # noqa: BLE001
        return default


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except Exception:  # noqa: BLE001
        return default


def _collect_nvidia_info() -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "available": False,
        "driver_version": "",
        "cuda_version": "",
        "gpus": [],
        "error": "",
    }

    try:
        version_cmd = [
            "nvidia-smi",
            "--query-gpu=driver_version",
            "--format=csv,noheader",
        ]
        version_run = subprocess.run(
            version_cmd,
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if version_run.returncode == 0:
            first_line = version_run.stdout.strip().splitlines()
            if first_line:
                out["driver_version"] = first_line[0].strip()

        cmd = [
            "nvidia-smi",
            "--query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ]
        run = subprocess.run(
            cmd,
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
            used_mb = _to_float(parts[4], 0.0)
            total_mb = _to_float(parts[5], 0.0)
            gpus.append(
                {
                    "index": _to_int(parts[0], 0),
                    "name": parts[1],
                    "uuid": parts[2],
                    "utilization_percent": _to_float(parts[3], 0.0),
                    "memory_used_mb": round(used_mb, 2),
                    "memory_total_mb": round(total_mb, 2),
                    "memory_free_mb": round(max(total_mb - used_mb, 0.0), 2),
                    "memory_used_percent": round((used_mb / total_mb) * 100, 2)
                    if total_mb > 0
                    else 0.0,
                    "temperature_c": _to_float(parts[6], 0.0),
                }
            )

        out["gpus"] = gpus
        out["available"] = len(gpus) > 0
        return out
    except FileNotFoundError:
        out["error"] = "nvidia-smi not found"
        return out
    except Exception as exc:  # noqa: BLE001
        out["error"] = str(exc)
        return out


def _fetch_model_runtime(name: str, endpoint: str, timeout_sec: int = 3) -> Dict[str, Any]:
    normalized_endpoint = endpoint.rstrip("/")
    result: Dict[str, Any] = {
        "name": name,
        "endpoint": normalized_endpoint,
        "reachable": False,
        "status": "unavailable",
        "model": "",
        "device": "",
        "runtime": {},
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
    except Exception as exc:  # noqa: BLE001
        result["error"] = str(exc)
        return result


@app.get("/system-info")
def get_system_info():
    try:
        cpu_percent = psutil.cpu_percent(interval=None)
        cpu_count = psutil.cpu_count()
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage("/")
        uptime_seconds = int(time.time() - psutil.boot_time())
        embedder_runtime = _fetch_model_runtime("embedder", EMBEDDER_ENDPOINT)
        vlm_runtime = _fetch_model_runtime("vlm", VLM_ENDPOINT)
        gpu_info = _collect_nvidia_info()

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
    except Exception as exc:  # noqa: BLE001
        logger.error("Error getting system info: %s", exc)
        return {
            "error": str(exc),
            "cpu": {"usage_percent": 0, "cores": 0},
            "memory": {
                "total_gb": 0,
                "used_gb": 0,
                "available_gb": 0,
                "usage_percent": 0,
            },
            "disk": {
                "total_gb": 0,
                "used_gb": 0,
                "available_gb": 0,
                "usage_percent": 0,
            },
            "gpu": {
                "available": False,
                "driver_version": "",
                "cuda_version": "",
                "gpus": [],
                "error": str(exc),
            },
            "services": {
                "embedder": _fetch_model_runtime("embedder", EMBEDDER_ENDPOINT),
                "vlm": _fetch_model_runtime("vlm", VLM_ENDPOINT),
            },
            "uptime_seconds": 0,
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        }


@app.post("/embeddings/backfill")
def backfill_embeddings(payload: BackfillRequest):
    job_id = str(uuid.uuid4())
    thread = threading.Thread(
        target=_run_backfill_job,
        args=(job_id, payload),
        daemon=True,
    )
    thread.start()
    return {"job_id": job_id, "status": "started"}


@app.post("/datasets/install")
def install_datasets(payload: DatasetInstallRequest):
    requested = [item.strip().lower() for item in payload.datasets if item.strip()]
    if not requested:
        raise HTTPException(status_code=400, detail="datasets are required")

    available_items = storage_api.get_preprocessor_methods()
    available = {
        str(item.get("key", "")).strip().lower(): item
        for item in available_items
        if str(item.get("key", "")).strip()
    }
    missing = sorted([item for item in requested if item not in available])
    if missing:
        raise HTTPException(
            status_code=400,
            detail={"message": "unknown dataset methods", "missing": missing},
        )

    jobs = []
    for dataset_key in requested:
        job_id = str(uuid.uuid4())
        thread = threading.Thread(
            target=_run_dataset_install_job,
            args=(job_id, dataset_key, payload.configs.get(dataset_key, {})),
            daemon=True,
        )
        thread.start()
        jobs.append(
            {
                "dataset": dataset_key,
                "job_id": job_id,
                "status": "started",
            }
        )
    return {"jobs": jobs}


@app.post("/search/text")
def search_text(payload: TextSearchRequest):
    try:
        timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)
        with httpx.Client(timeout=timeout) as client:
            query_embedding, _ = _embed_text(client, payload.query)
        results = storage_api.query_vectors(query_embedding, payload.top_k)
    except httpx.HTTPStatusError as exc:
        _raise_upstream_http_error(exc)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "mode": "vector_server",
        "results": results,
    }


@app.post("/search/image_bytes")
async def search_image_bytes(
    request: Request,
    top_k: int = 5,
    max_rows: int = 10000,
):
    del max_rows
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image bytes are required")

    try:
        timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)
        with httpx.Client(timeout=timeout) as client:
            query_embedding, _ = _embed_image(client, image_bytes)
        results = storage_api.query_vectors(query_embedding, max(1, top_k))
    except httpx.HTTPStatusError as exc:
        _raise_upstream_http_error(exc)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "mode": "vector_server",
        "results": results,
    }


@app.get("/vlm/fields")
def get_vlm_fields():
    return {"fields": analytics_api.get_fields()}


@app.post("/vlm/fields")
def upsert_vlm_fields(payload: VLMFieldsRequest):
    try:
        normalized_fields = _normalize_vlm_fields(payload.fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    fields = analytics_api.upsert_fields(normalized_fields)
    return {"fields": fields}


@app.post("/vlm/backfill")
def backfill_vlm(payload: VLMBackfillRequest):
    job_id = str(uuid.uuid4())
    thread = threading.Thread(
        target=_run_vlm_backfill_job,
        args=(job_id, payload),
        daemon=True,
    )
    thread.start()
    return {"job_id": job_id, "status": "started"}


@app.post("/vlm/annotations/clear")
def clear_vlm_annotations():
    return analytics_api.clear_annotations()


@app.post("/vlm/annotations/upsert")
def upsert_vlm_annotations(payload: AnnotationRowsRequest):
    normalized_rows: List[Dict[str, Any]] = []
    for raw in payload.rows:
        if not isinstance(raw, dict):
            continue
        object_id = str(raw.get("object_id", "")).strip()
        values = raw.get("values", {})
        if not object_id or not isinstance(values, dict):
            continue
        normalized_values = {
            str(key).strip(): str(value).strip()
            for key, value in values.items()
            if str(key).strip() and str(value).strip()
        }
        if not normalized_values:
            continue
        normalized_rows.append({"object_id": object_id, "values": normalized_values})
    return {"upserted": analytics_api.upsert_annotations(normalized_rows)}


@app.post("/vlm/annotations/get")
def get_vlm_annotations(payload: ObjectIDsRequest):
    normalized = sorted({str(item).strip() for item in payload.object_ids if str(item).strip()})
    return {"rows": analytics_api.get_annotations(normalized)}


@app.post("/vlm/annotations/delete")
def delete_vlm_annotations(payload: ObjectIDsRequest):
    normalized = sorted({str(item).strip() for item in payload.object_ids if str(item).strip()})
    return {"requested": analytics_api.delete_annotations(normalized)}


@app.post("/jobs/cancel")
def cancel_job(payload: CancelJobRequest):
    with jobs_lock:
        job = jobs_store.get(payload.job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job["status"] != JobStatus.RUNNING.value:
            raise HTTPException(status_code=400, detail="Job is not running")
        cleanup_mode = str(payload.install_cleanup_mode or "keep").strip().lower()
        if cleanup_mode not in {"keep", "delete"}:
            raise HTTPException(
                status_code=400,
                detail="install_cleanup_mode must be 'keep' or 'delete'",
            )
        if str(job.get("job_type", "")).startswith("install_"):
            job["install_cleanup_mode"] = cleanup_mode
        job["cancel_requested"] = True
        job["updated_at"] = time.time()
    return {
        "job_id": payload.job_id,
        "status": "cancellation_requested",
        "install_cleanup_mode": cleanup_mode if str(job.get("job_type", "")).startswith("install_") else None,
    }


@app.post("/search/vlm")
def search_vlm(payload: VLMSearchRequest):
    try:
        normalized_filters = [
            {
                "field_name": _normalize_field_name(item.field_name),
                "value": item.value.strip(),
                "match_mode": _normalize_match_mode(item.match_mode),
            }
            for item in payload.filters
            if item.value.strip()
        ]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not normalized_filters:
        return {"results": []}
    _validate_existing_vlm_fields([item["field_name"] for item in normalized_filters])
    return {
        "results": analytics_api.search(normalized_filters, payload.limit),
    }


@app.delete("/objects/{object_id}")
def delete_object(object_id: str):
    result: Dict[str, Any] = {
        "object_id": object_id,
        "vectors": {"requested": 0},
        "annotations": {"requested": 0},
        "object": {"object_id": object_id, "deleted": False},
    }
    errors: Dict[str, str] = {}

    try:
        deleted = storage_api.delete_object(object_id)
        result["vectors"]["requested"] = 1
        result["object"] = {
            "object_id": object_id,
            "deleted": bool(deleted.get("deleted", False)),
        }
    except Exception as exc:  # noqa: BLE001
        errors["storage_server"] = str(exc)

    try:
        result["annotations"]["requested"] = analytics_api.delete_annotations([object_id])
    except Exception as exc:  # noqa: BLE001
        errors["analytics_server"] = str(exc)

    if errors:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Cascade delete partially failed; retry is safe (idempotent).",
                "errors": errors,
                "result": result,
            },
        )
    return {"status": "ok", "result": result}
