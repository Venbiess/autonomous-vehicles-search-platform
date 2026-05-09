import logging
import os
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
from configs.hw_settings import EMBEDDER_CONFIG, VLM_CONFIG
from backend.server.analytics_api import AnalyticsAPI
from backend.server.dataset_visibility import load_hidden_datasets
from backend.server.model_bus import ModelGateway
from backend.server.storage_api import StorageAPI

logger = logging.getLogger("avsp.master")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="AVSP Master Server")

jobs_store: Dict[str, Dict[str, Any]] = {}
jobs_lock = threading.Lock()
JOB_LOG_DIR = Path("/tmp/avsp-job-logs")
JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)
JOBS_JOB_LOG_TAIL_LINES = 200

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
    dataset: Optional[str] = None


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
    replace_missing: bool = False
    purge_deleted_values: bool = False


class VLMBackfillRequest(BaseModel):
    field_names: List[str] = Field(default_factory=list)
    limit: int = Field(1000, ge=1)
    batch_size: int = Field(10, ge=1)
    stop_on_error: bool = False
    dry_run: bool = False
    overwrite_existing: bool = False
    max_new_tokens: int = Field(32, ge=1, le=512)
    dataset: Optional[str] = None


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


class RetryJobRequest(BaseModel):
    job_id: str = Field(..., min_length=1)


class ObjectIDsRequest(BaseModel):
    object_ids: List[str] = Field(default_factory=list)


class AnnotationRowRequest(BaseModel):
    object_id: str = Field(..., min_length=1)
    values: Dict[str, str] = Field(default_factory=dict)


class AnnotationRowsRequest(BaseModel):
    rows: List[AnnotationRowRequest] = Field(default_factory=list)


class DatasetInstallRequest(BaseModel):
    datasets: List[str] = Field(..., min_length=1)
    configs: Dict[str, Dict[str, Any]] = Field(default_factory=dict)


class WaymoAuthCompleteRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    code: str = Field(..., min_length=1)


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
    write_token=STORAGE_WRITE_TOKEN,
)
model_gateway = ModelGateway()

WAYMO_AUTH_MAX_LOG_LINES = 300
waymo_auth_lock = threading.Lock()
waymo_auth_session: Dict[str, Any] = {
    "session_id": None,
    "process": None,
    "thread": None,
    "auth_url": None,
    "awaiting_code": False,
    "logs": [],
    "started_at": 0.0,
    "finished": False,
    "returncode": None,
}


def _extract_first_url(line: str) -> Optional[str]:
    match = re.search(r"https://[^\s]+", line)
    if not match:
        return None
    return match.group(0).rstrip(").,")


def _is_waymo_auth_process_alive_locked() -> bool:
    proc = waymo_auth_session.get("process")
    return bool(proc is not None and proc.poll() is None)


def _append_waymo_auth_log_locked(line: str) -> None:
    logs = waymo_auth_session.get("logs")
    if not isinstance(logs, list):
        logs = []
        waymo_auth_session["logs"] = logs
    logs.append(line)
    if len(logs) > WAYMO_AUTH_MAX_LOG_LINES:
        del logs[: len(logs) - WAYMO_AUTH_MAX_LOG_LINES]


def _waymo_auth_reader(session_id: str, proc: subprocess.Popen) -> None:
    stream = proc.stdout
    if stream is None:
        return

    for raw_line in stream:
        line = str(raw_line).rstrip("\n")
        with waymo_auth_lock:
            if waymo_auth_session.get("session_id") != session_id:
                continue
            _append_waymo_auth_log_locked(line)
            auth_url = waymo_auth_session.get("auth_url")
            if not auth_url and "https://" in line:
                maybe_url = _extract_first_url(line)
                if maybe_url and "google" in maybe_url:
                    waymo_auth_session["auth_url"] = maybe_url
            lowered = line.lower()
            if "enter authorization code" in lowered:
                waymo_auth_session["awaiting_code"] = True

    return_code = proc.poll()
    with waymo_auth_lock:
        if waymo_auth_session.get("session_id") == session_id:
            waymo_auth_session["finished"] = True
            waymo_auth_session["returncode"] = int(return_code) if return_code is not None else None


def _start_waymo_auth_session() -> Dict[str, Any]:
    command = [
        "gcloud",
        "auth",
        "application-default",
        "login",
        "--no-launch-browser",
    ]
    env = dict(os.environ)
    env["CLOUDSDK_CORE_DISABLE_PROMPTS"] = "0"
    try:
        proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=500,
            detail="gcloud is not available in avsp-server container",
        ) from exc

    session_id = str(uuid.uuid4())
    reader = threading.Thread(
        target=_waymo_auth_reader,
        args=(session_id, proc),
        name=f"waymo-auth-{session_id[:8]}",
        daemon=True,
    )
    with waymo_auth_lock:
        waymo_auth_session.update(
            {
                "session_id": session_id,
                "process": proc,
                "thread": reader,
                "auth_url": None,
                "awaiting_code": False,
                "logs": [],
                "started_at": time.time(),
                "finished": False,
                "returncode": None,
            }
        )
    reader.start()
    return {"session_id": session_id}


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
    allowed = {
        "contains",
        "exact",
        "equal",
        "not_equal",
        "greater",
        "greater_or_equal",
        "less",
        "less_or_equal",
    }
    if normalized not in allowed:
        raise ValueError(
            "match_mode must be one of: "
            "'contains', 'exact', 'equal', 'not_equal', "
            "'greater', 'greater_or_equal', 'less', 'less_or_equal'"
        )
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
    try:
        completed = set(analytics_api.completed_object_ids(object_ids, field_names))
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "VLM pending filter skipped due analytics error: %s",
            exc,
        )
        # Do not fail the whole backfill job if completed-ids probe is unavailable.
        # In this case we may re-run some already annotated objects, but progress continues.
        return object_ids
    return [object_id for object_id in object_ids if object_id not in completed]


def _list_object_ids(limit: int, page_size: int = 500, dataset: Optional[str] = None) -> List[str]:
    remaining = max(limit, 0)
    cursor: Optional[str] = None
    object_ids: List[str] = []
    dataset_filter = str(dataset or "").strip().lower()
    hidden = {name.lower() for name in load_hidden_datasets()}
    while remaining > 0:
        payload = storage_api.list_objects(limit=min(page_size, remaining), cursor=cursor)
        items = payload.get("items", [])
        if not items:
            break
        for item in items:
            bucket_name = str(item.get("bucket", "")).strip().lower()
            if bucket_name and bucket_name in hidden:
                continue
            if dataset_filter:
                if bucket_name != dataset_filter:
                    continue
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


def _list_pending_embedding_object_ids(
    limit: int,
    page_size: int = 500,
    dataset: Optional[str] = None,
) -> List[str]:
    remaining = max(limit, 0)
    cursor: Optional[str] = None
    pending: List[str] = []
    dataset_filter = str(dataset or "").strip().lower()
    hidden = {name.lower() for name in load_hidden_datasets()}

    while remaining > 0:
        payload = storage_api.list_objects(limit=page_size, cursor=cursor)
        items = payload.get("items", [])
        if not items:
            break

        batch_ids: List[str] = []
        for item in items:
            bucket_name = str(item.get("bucket", "")).strip().lower()
            if bucket_name and bucket_name in hidden:
                continue
            if dataset_filter:
                if bucket_name != dataset_filter:
                    continue
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


def _normalize_job_config(payload: Any) -> Dict[str, Any]:
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
    except Exception:
        detail = exc.response.text or str(exc)
    raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc


def _is_storage_query_unavailable_error(exc: Exception) -> bool:
    if isinstance(exc, httpx.RequestError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = int(exc.response.status_code)
        return status in {502, 503, 504}
    return False


def _search_dependencies_ready(
    *,
    require_embedder: bool = True,
    require_vlm: bool = True,
    allow_embedder_http_fallback: bool = False,
) -> tuple[bool, str]:
    wait_timeout_sec = max(0.0, float(os.getenv("MODEL_BACKEND_READY_WAIT_SEC", "45")))
    poll_interval_sec = max(0.1, float(os.getenv("MODEL_BACKEND_READY_POLL_SEC", "1")))

    def _embedder_http_ready() -> bool:
        endpoint = str(EMBEDDER_ENDPOINT or "").strip().rstrip("/")
        if not endpoint:
            return False
        timeout = httpx.Timeout(min(10.0, max(1.0, float(EMBEDDER_TIMEOUT_SEC))))
        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.get(f"{endpoint}/health")
            if response.status_code >= 400:
                return False
            payload = response.json()
            return str(payload.get("status", "")).lower() == "ok"
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
                # Non-required queue is down; allow request/job that doesn't use it.
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
        elif (
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


def _embed_image(client: httpx.Client, image_bytes: bytes) -> Tuple[List[float], int]:
    return model_gateway.embed_image(client, EMBEDDER_ENDPOINT, image_bytes)


def _embed_text(client: httpx.Client, text: str) -> Tuple[List[float], int]:
    return model_gateway.embed_text(client, EMBEDDER_ENDPOINT, text)


def _embed_images(client: httpx.Client, images_bytes: List[bytes]) -> Tuple[List[List[float]], int]:
    return model_gateway.embed_images(client, EMBEDDER_ENDPOINT, images_bytes)


def _embed_image_direct(client: httpx.Client, image_bytes: bytes) -> Tuple[List[float], int]:
    return model_gateway.embed_image_http(client, EMBEDDER_ENDPOINT, image_bytes)


def _embed_text_direct(client: httpx.Client, text: str) -> Tuple[List[float], int]:
    return model_gateway.embed_text_http(client, EMBEDDER_ENDPOINT, text)


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
    return model_gateway.run_vlm(
        client,
        image_bytes=image_bytes,
        prompt=prompt,
        max_new_tokens=max_new_tokens,
        metadata={
            "job_id": job_id,
            "task_index": task_index,
            "task_total": task_total,
            "field_name": field_name,
            "object_id": object_id,
        },
    )


def _job_cancel_requested(job_id: str) -> bool:
    with jobs_lock:
        job = jobs_store.get(job_id)
        return bool(job and job.get("cancel_requested"))


def _job_install_cleanup_mode(job_id: str) -> str:
    with jobs_lock:
        job = jobs_store.get(job_id) or {}
        mode = str(job.get("install_cleanup_mode", "keep")).strip().lower()
    return mode if mode in {"keep", "delete"} else "keep"


def _chunk_object_ids(object_ids: List[str], chunk_size: int = 500) -> List[List[str]]:
    if chunk_size <= 0:
        chunk_size = 500
    normalized = [str(item).strip() for item in object_ids if str(item).strip()]
    if not normalized:
        return []
    return [normalized[i : i + chunk_size] for i in range(0, len(normalized), chunk_size)]


def _mark_job_cancelled(
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


def _append_job_log(job: Dict[str, Any], message: str) -> None:
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


def _record_job_error(
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
            _append_job_log(job, log_message)
        detail_log = str(error_item.get("log", "")).strip()
        if detail_log:
            _append_job_log(job, detail_log)


def _current_model_health_text() -> str:
    try:
        return str(model_gateway.health())
    except Exception as exc:  # noqa: BLE001
        return f"health check failed: {exc}"


def _build_error_item(exc: Exception, object_id: Optional[str] = None) -> Dict[str, str]:
    item: Dict[str, str] = {"error": str(exc), "log": traceback.format_exc().strip()}
    if object_id:
        item["object_id"] = object_id
    if "rpc timeout waiting for queue=" in str(exc).lower():
        item["model_health"] = _current_model_health_text()
    return item


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
                    valid_ids.append(object_id)
                    valid_images.append(image_bytes)
                except Exception as exc:  # noqa: BLE001
                    logger.exception("Auto-embedding failed for object_id=%s", object_id)
                    error_item = _build_error_item(exc, object_id)
                    timeout_note = ""
                    if error_item.get("model_health"):
                        timeout_note = f" | model_health={error_item['model_health']}"
                    _record_job_error(
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
                        embedding, dim = _embed_image(client, image_bytes)
                        rows.append(
                            EmbedResult(
                                object_id=object_id,
                                embedding=embedding,
                                dim=dim,
                            )
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("Auto-embedding failed for single object_id=%s", object_id)
                        error_item = _build_error_item(exc, object_id)
                        timeout_note = ""
                        if error_item.get("model_health"):
                            timeout_note = f" | model_health={error_item['model_health']}"
                        _record_job_error(
                            job_id,
                            errors,
                            error_item,
                            log_message=f"Embedding error: object_id={object_id} | {exc}{timeout_note}",
                        )
                else:
                    try:
                        embeddings, dim = _embed_images(client, valid_images)
                        if len(embeddings) != len(valid_ids):
                            raise ValueError(
                                f"batch embedding size mismatch: expected={len(valid_ids)} actual={len(embeddings)}"
                            )
                        rows.extend(
                            EmbedResult(
                                object_id=object_id,
                                embedding=embedding,
                                dim=dim,
                            )
                            for object_id, embedding in zip(valid_ids, embeddings)
                        )
                    except Exception:
                        logger.exception(
                            "Auto-embedding batch failed (size=%s), falling back to per-item",
                            len(valid_ids),
                        )
                        for object_id, image_bytes in zip(valid_ids, valid_images):
                            try:
                                embedding, dim = _embed_image(client, image_bytes)
                                rows.append(
                                    EmbedResult(
                                        object_id=object_id,
                                        embedding=embedding,
                                        dim=dim,
                                    )
                                )
                            except Exception as exc:  # noqa: BLE001
                                logger.exception("Auto-embedding fallback failed for object_id=%s", object_id)
                                error_item = _build_error_item(exc, object_id)
                                timeout_note = ""
                                if error_item.get("model_health"):
                                    timeout_note = f" | model_health={error_item['model_health']}"
                                _record_job_error(
                                    job_id,
                                    errors,
                                    error_item,
                                    log_message=f"Embedding fallback error: object_id={object_id} | {exc}{timeout_note}",
                                )

            upserted = 0
            if rows:
                try:
                    upserted = _storage_vector_upsert_batch(rows)
                    if upserted != len(rows):
                        mismatch_error = (
                            f"auto-embedding upsert mismatch: expected={len(rows)} actual={upserted}"
                        )
                        _record_job_error(
                            job_id,
                            errors,
                            {"error": mismatch_error},
                            log_message=f"Embedding upsert mismatch: {mismatch_error}",
                        )
                except Exception as exc:
                    logger.exception(
                        "Auto-embedding vector upsert failed for rows=%s", len(rows)
                    )
                    _record_job_error(
                        job_id,
                        errors,
                        {"error": str(exc)},
                        log_message=f"Embedding upsert error: {exc}",
                    )

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
    job_config = _normalize_job_config(payload)
    with jobs_lock:
        jobs_store[job_id] = {
            "job_id": job_id,
            "job_type": "backfill_embeddings",
            "job_config": job_config,
            "status": JobStatus.RUNNING.value,
            "cancel_requested": False,
            "install_cleanup_mode": "keep",
            "progress": 0,
            "total_seen": 0,
            "total_inserted": 0,
            "total_limit": payload.limit,
            "job_log": [],
            "job_log_path": str(JOB_LOG_DIR / f"{job_id}.log"),
            "errors": [],
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    total_seen = 0
    total_inserted = 0
    errors = []
    inserted_object_ids: List[str] = []
    inserted_object_ids_seen: set[str] = set()
    last_progress_log_bucket = -1
    last_progress_log_at = time.monotonic()
    upsert_flush_size = max(
        1,
        int(
            os.getenv(
                "EMBEDDINGS_BACKFILL_UPSERT_FLUSH_SIZE",
                str(min(max(payload.batch_size, 1), 4)),
            )
        ),
    )

    def _update_backfill_progress(
        seen_count: int,
        inserted_count: int,
        current_object_id: Optional[str] = None,
    ) -> int:
        progress_value = min(int((seen_count / max(planned_total, 1)) * 100), 100)
        with jobs_lock:
            if job_id in jobs_store:
                payload_update: Dict[str, Any] = {
                    "progress": progress_value,
                    "total_seen": seen_count,
                    "total_inserted": inserted_count,
                    "errors": errors,
                    "updated_at": time.time(),
                }
                if current_object_id:
                    payload_update["current_object_id"] = current_object_id
                jobs_store[job_id].update(payload_update)
        return progress_value

    def _flush_rows(rows_buffer: List[EmbedResult]) -> bool:
        nonlocal total_inserted
        if not rows_buffer or payload.dry_run:
            rows_buffer.clear()
            return True
        try:
            upserted = _storage_vector_upsert_batch(rows_buffer)
            total_inserted += upserted
            for row in rows_buffer[: max(0, upserted)]:
                if row.object_id not in inserted_object_ids_seen:
                    inserted_object_ids_seen.add(row.object_id)
                    inserted_object_ids.append(row.object_id)
            if upserted != len(rows_buffer):
                mismatch_error = (
                    f"vector upsert mismatch: expected={len(rows_buffer)} actual={upserted}"
                )
                _record_job_error(
                    job_id,
                    errors,
                    {"error": mismatch_error},
                    log_message=f"Backfill upsert mismatch: {mismatch_error}",
                )
                rows_buffer.clear()
                return False
            rows_buffer.clear()
            return True
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "Batch vector upsert failed for rows=%s", len(rows_buffer)
            )
            _record_job_error(
                job_id,
                errors,
                {"error": str(exc)},
                log_message=f"Backfill upsert error: {exc}",
            )
            rows_buffer.clear()
            return False

    def _cancel_backfill_job() -> None:
        cleanup_mode = _job_install_cleanup_mode(job_id)
        cleanup_removed = 0
        cancel_errors = list(errors)
        if cleanup_mode == "delete":
            for chunk in _chunk_object_ids(inserted_object_ids):
                try:
                    cleanup_removed += storage_api.delete_vectors(chunk)
                except Exception as exc:
                    cancel_errors.append({"error": f"cleanup vectors delete failed: {exc}"})
            cancel_errors.append(
                {
                    "error": (
                        "Cancellation cleanup removed embeddings for "
                        f"{cleanup_removed} / {len(inserted_object_ids)} objects"
                    )
                }
            )
        _mark_job_cancelled(
            job_id,
            total_seen,
            max(0, total_inserted - cleanup_removed),
            cancel_errors,
        )
        with jobs_lock:
            job = jobs_store.get(job_id)
            if job:
                _append_job_log(
                    job,
                    (
                        f"Cancelled (cleanup_mode={cleanup_mode}, "
                        f"removed_embeddings={cleanup_removed}/{len(inserted_object_ids)})"
                    ),
                )

    try:
        ready, reason = _search_dependencies_ready(require_embedder=True, require_vlm=False)
        if not ready:
            with jobs_lock:
                if job_id in jobs_store:
                    jobs_store[job_id].update(
                        {
                            "status": JobStatus.ERROR.value,
                            "errors": [{"error": reason}],
                            "updated_at": time.time(),
                        }
                    )
                    _append_job_log(jobs_store[job_id], f"Failed preflight: {reason}")
            return

        logger.info(
            "Backfill embeddings job %s started: limit=%s batch_size=%s dry_run=%s dataset=%s",
            job_id,
            payload.limit,
            payload.batch_size,
            payload.dry_run,
            str(payload.dataset or "").strip() or "all",
        )
        with jobs_lock:
            job = jobs_store.get(job_id)
            if job:
                _append_job_log(
                    job,
                    (
                        "Backfill embeddings started: "
                        f"limit={payload.limit}, batch_size={payload.batch_size}, dry_run={payload.dry_run}, "
                        f"dataset={str(payload.dataset or '').strip() or 'all'}"
                    ),
                )
        timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)

        object_ids = _list_pending_embedding_object_ids(payload.limit, dataset=payload.dataset)
        planned_total = len(object_ids)
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id]["total_limit"] = planned_total
                jobs_store[job_id]["updated_at"] = time.time()
                _append_job_log(
                    jobs_store[job_id],
                    (
                        f"Pending objects selected: {planned_total} "
                        f"(requested limit={payload.limit}, dataset={str(payload.dataset or '').strip() or 'all'})"
                    ),
                )
        logger.info(
            "Backfill embeddings job %s pending objects=%s (requested limit=%s, dataset=%s)",
            job_id,
            planned_total,
            payload.limit,
            str(payload.dataset or "").strip() or "all",
        )
        with httpx.Client(timeout=timeout) as client:
            for i in range(0, len(object_ids), payload.batch_size):
                if _job_cancel_requested(job_id):
                    _cancel_backfill_job()
                    return
                batch_ids = object_ids[i : i + payload.batch_size]
                rows: List[EmbedResult] = []
                processed_in_batch = 0
                batch_payload = storage_api.get_object_bytes_batch(batch_ids)
                by_object_id = {
                    item.get("object_id"): item for item in batch_payload if item.get("object_id")
                }
                valid_ids: List[str] = []
                valid_images: List[bytes] = []

                for object_id in batch_ids:
                    if _job_cancel_requested(job_id):
                        _cancel_backfill_job()
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
                        valid_ids.append(object_id)
                        valid_images.append(image_bytes)
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("Embedding failed for object_id=%s", object_id)
                        error_item = _build_error_item(exc, object_id)
                        timeout_note = ""
                        if error_item.get("model_health"):
                            timeout_note = f" | model_health={error_item['model_health']}"
                        _record_job_error(
                            job_id,
                            errors,
                            error_item,
                            log_message=f"Embedding error: object_id={object_id} | {exc}{timeout_note}",
                        )
                        processed_in_batch += 1
                        interim_seen = total_seen + processed_in_batch
                        _update_backfill_progress(interim_seen, total_inserted, current_object_id=object_id)
                        if payload.stop_on_error:
                            break
                    else:
                        continue

                if valid_images and not (payload.stop_on_error and errors):
                    if len(valid_ids) == 1:
                        object_id = valid_ids[0]
                        image_bytes = valid_images[0]
                        try:
                            embedding, dim = _embed_image(client, image_bytes)
                            rows.append(
                                EmbedResult(
                                    object_id=object_id,
                                    embedding=embedding,
                                    dim=dim,
                                )
                            )
                            processed_in_batch += 1
                            interim_seen = total_seen + processed_in_batch
                            _update_backfill_progress(
                                interim_seen,
                                total_inserted,
                                current_object_id=object_id,
                            )
                            if len(rows) >= upsert_flush_size:
                                flushed_ok = _flush_rows(rows)
                                _update_backfill_progress(interim_seen, total_inserted, current_object_id=object_id)
                                if payload.stop_on_error and (not flushed_ok or errors):
                                    break
                        except Exception as exc:  # noqa: BLE001
                            logger.exception("Embedding failed for single object_id=%s", object_id)
                            error_item = _build_error_item(exc, object_id)
                            timeout_note = ""
                            if error_item.get("model_health"):
                                timeout_note = f" | model_health={error_item['model_health']}"
                            _record_job_error(
                                job_id,
                                errors,
                                error_item,
                                log_message=f"Embedding error: object_id={object_id} | {exc}{timeout_note}",
                            )
                            processed_in_batch += 1
                            interim_seen = total_seen + processed_in_batch
                            _update_backfill_progress(
                                interim_seen,
                                total_inserted,
                                current_object_id=object_id,
                            )
                    else:
                        try:
                            embeddings, dim = _embed_images(client, valid_images)
                            if len(embeddings) != len(valid_ids):
                                raise ValueError(
                                    f"batch embedding size mismatch: expected={len(valid_ids)} actual={len(embeddings)}"
                                )

                            for object_id, embedding in zip(valid_ids, embeddings):
                                rows.append(
                                    EmbedResult(
                                        object_id=object_id,
                                        embedding=embedding,
                                        dim=dim,
                                    )
                                )
                                processed_in_batch += 1
                                interim_seen = total_seen + processed_in_batch
                                _update_backfill_progress(
                                    interim_seen,
                                    total_inserted,
                                    current_object_id=object_id,
                                )
                                if len(rows) >= upsert_flush_size:
                                    flushed_ok = _flush_rows(rows)
                                    _update_backfill_progress(interim_seen, total_inserted, current_object_id=object_id)
                                    if payload.stop_on_error and (not flushed_ok or errors):
                                        break
                        except Exception:
                            logger.exception(
                                "Batch embedding failed for batch_size=%s, falling back to per-item",
                                len(valid_ids),
                            )
                            for object_id, image_bytes in zip(valid_ids, valid_images):
                                if _job_cancel_requested(job_id):
                                    _cancel_backfill_job()
                                    return
                                try:
                                    embedding, dim = _embed_image(client, image_bytes)
                                    rows.append(
                                        EmbedResult(
                                            object_id=object_id,
                                            embedding=embedding,
                                            dim=dim,
                                        )
                                    )
                                    if len(rows) >= upsert_flush_size:
                                        flushed_ok = _flush_rows(rows)
                                        if payload.stop_on_error and (not flushed_ok or errors):
                                            break
                                except Exception as exc:  # noqa: BLE001
                                    logger.exception("Embedding fallback failed for object_id=%s", object_id)
                                    error_item = _build_error_item(exc, object_id)
                                    timeout_note = ""
                                    if error_item.get("model_health"):
                                        timeout_note = f" | model_health={error_item['model_health']}"
                                    _record_job_error(
                                        job_id,
                                        errors,
                                        error_item,
                                        log_message=f"Embedding fallback error: object_id={object_id} | {exc}{timeout_note}",
                                    )
                                finally:
                                    processed_in_batch += 1
                                    interim_seen = total_seen + processed_in_batch
                                    _update_backfill_progress(
                                        interim_seen,
                                        total_inserted,
                                        current_object_id=object_id,
                                    )
                                if payload.stop_on_error and errors:
                                    break

                total_seen += processed_in_batch
                if rows:
                    flushed_ok = _flush_rows(rows)
                    if payload.stop_on_error and (not flushed_ok or errors):
                        break

                progress = _update_backfill_progress(total_seen, total_inserted)
                current_bucket = progress // 10
                now_mono = time.monotonic()
                should_log_progress = False
                if total_seen > 0 and current_bucket > last_progress_log_bucket:
                    should_log_progress = True
                if total_seen > 0 and now_mono - last_progress_log_at >= 30:
                    should_log_progress = True
                if should_log_progress:
                    with jobs_lock:
                        job = jobs_store.get(job_id)
                        if job:
                            _append_job_log(
                                job,
                                (
                                    f"Progress: {total_seen}/{planned_total} ({progress}%), "
                                    f"embeddings_saved={total_inserted}, errors={len(errors)}"
                                ),
                            )
                    last_progress_log_bucket = max(last_progress_log_bucket, current_bucket)
                    last_progress_log_at = now_mono
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
                _append_job_log(
                    jobs_store[job_id],
                    (
                        f"Finished with status={final_status.value}, "
                        f"processed={total_seen}/{planned_total}, embeddings_saved={total_inserted}, "
                        f"errors={len(errors)}"
                    ),
                )
    except Exception as exc:
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
                _append_job_log(jobs_store[job_id], f"Failed: {exc}")


def _run_vlm_backfill_job(job_id: str, payload: VLMBackfillRequest):
    job_config = _normalize_job_config(payload)
    with jobs_lock:
        jobs_store[job_id] = {
            "job_id": job_id,
            "job_type": "backfill_vlm",
            "job_config": job_config,
            "status": JobStatus.RUNNING.value,
            "cancel_requested": False,
            "install_cleanup_mode": "keep",
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
            "job_log": [],
            "job_log_path": str(JOB_LOG_DIR / f"{job_id}.log"),
            "errors": [],
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    total_seen = 0
    total_inserted = 0
    errors = []
    annotated_object_ids: List[str] = []
    annotated_object_ids_seen: set[str] = set()
    last_progress_log_bucket = -1
    last_progress_log_at = time.monotonic()

    try:
        timeout = httpx.Timeout(VLM_TIMEOUT_SEC)
        dataset_filter = str(payload.dataset or "").strip()

        if payload.field_names:
            fields = _validate_existing_vlm_fields(payload.field_names)
        else:
            fields = analytics_api.get_fields()
        if not fields:
            raise ValueError("No VLM fields configured")

        field_names = [field["field_name"] for field in fields]
        object_ids = _list_object_ids(payload.limit, dataset=payload.dataset)
        object_ids = _filter_pending_vlm_object_ids(
            object_ids,
            field_names,
            payload.overwrite_existing,
        )
        planned_total = len(object_ids)
        total_tasks_planned = len(object_ids) * len(field_names)
        completed_tasks = 0
        with jobs_lock:
            job = jobs_store.get(job_id)
            if job:
                _append_job_log(
                    job,
                    (
                        f"VLM backfill started: limit={payload.limit}, fields={len(field_names)}, "
                        f"dataset={dataset_filter or 'all'}"
                    ),
                )
                _append_job_log(
                    job,
                    f"Objects selected: {planned_total} (dataset={dataset_filter or 'all'})",
                )

        def _cancel_vlm_job() -> None:
            cleanup_mode = _job_install_cleanup_mode(job_id)
            cleanup_removed = 0
            cancel_errors = list(errors)
            if cleanup_mode == "delete":
                for chunk in _chunk_object_ids(annotated_object_ids):
                    try:
                        cleanup_removed += analytics_api.delete_annotations(chunk)
                    except Exception as exc:
                        cancel_errors.append({"error": f"cleanup annotations delete failed: {exc}"})
                cancel_errors.append(
                    {
                        "error": (
                            "Cancellation cleanup removed annotations for "
                            f"{cleanup_removed} / {len(annotated_object_ids)} objects"
                        )
                    }
                )
            _mark_job_cancelled(
                job_id,
                total_seen,
                max(0, total_inserted - cleanup_removed),
                cancel_errors,
                extra_updates={
                    "total_tasks_completed": completed_tasks,
                    "total_tasks_planned": total_tasks_planned,
                },
            )
            with jobs_lock:
                job = jobs_store.get(job_id)
                if job:
                    _append_job_log(
                        job,
                        (
                            f"Cancelled (cleanup_mode={cleanup_mode}, "
                            f"removed_annotations={cleanup_removed}/{len(annotated_object_ids)})"
                        ),
                    )

        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update(
                    {
                        "total_limit": planned_total,
                        "total_tasks_planned": total_tasks_planned,
                        "updated_at": time.time(),
                    }
                )
                _append_job_log(
                    jobs_store[job_id],
                    (
                        "Backfill VLM started: "
                        f"limit={payload.limit}, batch_size={payload.batch_size}, "
                        f"fields={len(field_names)}, dry_run={payload.dry_run}, "
                        f"overwrite_existing={payload.overwrite_existing}"
                    ),
                )
                _append_job_log(
                    jobs_store[job_id],
                    (
                        f"Pending scenes selected: {planned_total} "
                        f"(tasks_planned={total_tasks_planned})"
                    ),
                )

        with httpx.Client(timeout=timeout) as client:
            for i in range(0, len(object_ids), payload.batch_size):
                if _job_cancel_requested(job_id):
                    _cancel_vlm_job()
                    return
                batch_ids = object_ids[i : i + payload.batch_size]
                batch_payload = storage_api.get_object_bytes_batch(batch_ids)
                by_object_id = {
                    item.get("object_id"): item for item in batch_payload if item.get("object_id")
                }

                for object_id in batch_ids:
                    if _job_cancel_requested(job_id):
                        _cancel_vlm_job()
                        return
                    current_scene_tasks_total = len(fields)
                    scene_tasks_completed = 0
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
                                _cancel_vlm_job()
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
                            scene_tasks_completed = field_index + 1
                            with jobs_lock:
                                if job_id in jobs_store:
                                    jobs_store[job_id].update(
                                        {
                                            "total_tasks_completed": completed_tasks,
                                            "total_tasks_planned": total_tasks_planned,
                                            "current_scene_tasks_completed": scene_tasks_completed,
                                            "current_scene_tasks_total": current_scene_tasks_total,
                                            "updated_at": time.time(),
                                        }
                                    )
                        if not payload.dry_run:
                            upserted = _upsert_vlm_annotations(
                                [{"object_id": object_id, "values": values}]
                            )
                            total_inserted += upserted
                            if upserted > 0 and object_id not in annotated_object_ids_seen:
                                annotated_object_ids_seen.add(object_id)
                                annotated_object_ids.append(object_id)
                        total_seen += 1
                    except Exception as exc:
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
                                    "current_scene_tasks_completed": scene_tasks_completed,
                                    "current_scene_tasks_total": current_scene_tasks_total,
                                    "errors": errors,
                                    "field_names": field_names,
                                    "updated_at": time.time(),
                                }
                            )
                    current_bucket = progress // 10
                    now_mono = time.monotonic()
                    should_log_progress = False
                    if total_seen > 0 and current_bucket > last_progress_log_bucket:
                        should_log_progress = True
                    if total_seen > 0 and now_mono - last_progress_log_at >= 30:
                        should_log_progress = True
                    if should_log_progress:
                        with jobs_lock:
                            job = jobs_store.get(job_id)
                            if job:
                                _append_job_log(
                                    job,
                                    (
                                        f"Progress: scenes={total_seen}/{planned_total} ({progress}%), "
                                        f"tasks={completed_tasks}/{total_tasks_planned}, "
                                        f"annotations_saved={total_inserted}, errors={len(errors)}"
                                    ),
                                )
                        last_progress_log_bucket = max(last_progress_log_bucket, current_bucket)
                        last_progress_log_at = now_mono

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
                _append_job_log(
                    jobs_store[job_id],
                    (
                        f"Finished with status={final_status.value}, "
                        f"scenes={total_seen}/{planned_total}, "
                        f"tasks={completed_tasks}/{total_tasks_planned}, "
                        f"annotations_saved={total_inserted}, errors={len(errors)}"
                    ),
                )
    except Exception as exc:
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
                _append_job_log(jobs_store[job_id], f"Failed: {exc}")


def _run_dataset_install_job(job_id: str, dataset_key: str, dataset_cfg: Dict[str, Any]):
    cfg = dict(dataset_cfg or {})
    embed_on_install = _to_bool(cfg.get("embed_on_install", False), False)
    job_config = dict(cfg)

    with jobs_lock:
        jobs_store[job_id] = {
            "job_id": job_id,
            "job_type": f"install_{dataset_key}",
            "dataset": dataset_key,
            "job_config": job_config,
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
            "extract_scene_tasks_completed": 0,
            "extract_scene_tasks_total": 0,
            "extract_scene_index": 0,
            "extract_file_name": "",
            "extract_files_done": 0,
            "download_label": "",
            "install_phase": "",
            "errors": [],
            "job_log": [],
            "job_log_path": str(JOB_LOG_DIR / f"{job_id}.log"),
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
        ready, reason = _search_dependencies_ready(require_embedder=True, require_vlm=False)
        if not ready:
            errors.append({"error": f"auto-embedding preflight failed: {reason}"})
            embed_on_install = False
            with jobs_lock:
                job = jobs_store.get(job_id)
                if job:
                    job["embed_on_install"] = False
                    job["embedding_worker_running"] = False
                    _append_job_log(
                        job,
                        f"Auto-embedding disabled for this run: {reason}",
                    )
        if embed_on_install:
            embed_queue = queue.Queue(maxsize=4096)
            with jobs_lock:
                job = jobs_store.get(job_id)
                if job:
                    _append_job_log(
                        job,
                        "Auto-embedding enabled, running in streaming mode during install.",
                    )

        def _embed_worker_runner() -> None:
            try:
                _embed_install_queue_worker(
                    job_id=job_id,
                    object_queue=embed_queue,
                    errors=errors,
                )
            except InterruptedError:
                with embed_worker_lock:
                    embed_worker_state["cancelled"] = True
            except Exception as exc:
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

        if embed_on_install:
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
                _append_job_log(job, f"Start installation for dataset={dataset_key}, planned={total}")

            if ev == "download":
                job["install_phase"] = "download"
                job["download_label"] = str(event.get("download_label", "") or "")
                file_index = int(event.get("current_scene_index", 0) or 0)
                job["current_scene_index"] = file_index
                job["current_scene_tasks_completed"] = int(
                    event.get("current_scene_tasks_completed", 0) or 0
                )
                job["current_scene_tasks_total"] = int(
                    event.get("current_scene_tasks_total", 0) or 0
                )
                job["extract_scene_tasks_completed"] = 0
                job["extract_scene_tasks_total"] = 0
                job["extract_file_name"] = ""
                job["extract_files_done"] = 0
                total = int(event.get("total_planned", job.get("total_planned", 0)) or 0)
                if total > 0:
                    job["total_limit"] = total
                    job["total_planned"] = total
                    seen = min(max(file_index, 0), total)
                    job["total_seen"] = seen
                    job["progress"] = min(100, int((seen / max(total, 1)) * 100))

            if ev == "download_detail":
                job["extract_scene_index"] = int(event.get("current_scene_index", 0) or 0)
                job["extract_scene_tasks_completed"] = int(
                    event.get("current_scene_tasks_completed", 0) or 0
                )
                job["extract_scene_tasks_total"] = int(
                    event.get("current_scene_tasks_total", 0) or 0
                )
                job["extract_file_name"] = str(event.get("file_name", "") or "")
                total = int(event.get("total_planned", job.get("total_planned", 0)) or 0)
                if total > 0:
                    job["total_limit"] = total
                    job["total_planned"] = total

            if ev == "upload_progress":
                job["install_phase"] = "upload"
                job["download_label"] = ""
                scene_index = int(event.get("episodes_done", job.get("current_scene_index", 0)) or 0)
                job["current_scene_index"] = scene_index
                job["current_scene_tasks_completed"] = int(
                    event.get("current_scene_tasks_completed", 0) or 0
                )
                job["current_scene_tasks_total"] = int(
                    event.get("current_scene_tasks_total", 0) or 0
                )
                job["extract_scene_tasks_completed"] = 0
                job["extract_scene_tasks_total"] = 0
                job["extract_file_name"] = ""
                job["extract_files_done"] = 0
                uploaded_now = int(
                    event.get(
                        "uploaded_objects_unique",
                        event.get("uploaded_objects", job.get("total_inserted", 0)),
                    )
                    or 0
                )
                failed_now = int(event.get("failed_objects", 0) or 0)
                job["total_inserted"] = uploaded_now
                if failed_now > 0:
                    job["errors"] = [{"error": f"failed objects: {failed_now}"}]
                object_id = str(event.get("last_uploaded_object_id", "") or "").strip()
                if object_id and object_id not in uploaded_object_ids_seen:
                    uploaded_object_ids_seen.add(object_id)
                    uploaded_object_ids.append(object_id)
                    if embed_on_install and embed_queue is not None:
                        object_id_to_enqueue = object_id
                        job["embedding_tasks_total"] = int(
                            job.get("embedding_tasks_total", 0) or 0
                        ) + 1

            if ev == "extract":
                job["install_phase"] = "extract"
                job["download_label"] = ""
                file_index = int(event.get("current_scene_index", 0) or 0)
                job["extract_scene_index"] = file_index
                job["extract_scene_tasks_completed"] = int(
                    event.get("current_scene_tasks_completed", 0) or 0
                )
                job["extract_scene_tasks_total"] = int(
                    event.get("current_scene_tasks_total", 0) or 0
                )
                job["extract_file_name"] = str(event.get("file_name", "") or "")
                job["extract_files_done"] = int(event.get("extracted_files", 0) or 0)
                total = int(event.get("total_planned", job.get("total_planned", 0)) or 0)
                if total > 0:
                    job["total_limit"] = total
                    job["total_planned"] = total
                    seen = min(max(file_index, 0), total)
                    job["total_seen"] = seen
                    job["progress"] = min(100, int((seen / max(total, 1)) * 100))

            if ev == "log":
                _append_job_log(job, str(event.get("message", "") or ""))

            if ev == "episode":
                seen = int(event.get("episodes_done", job.get("total_seen", 0)) or 0)
                inserted = int(
                    event.get(
                        "uploaded_objects_unique",
                        event.get("uploaded_objects", job.get("total_inserted", 0)),
                    )
                    or 0
                )
                failed = int(event.get("failed_objects", 0) or 0)
                total = int(job.get("total_planned", 0) or 0)
                if total > 0:
                    job["progress"] = min(100, int((seen / max(total, 1)) * 100))
                job["total_seen"] = seen
                job["total_inserted"] = inserted
                if failed > 0:
                    job["errors"] = [{"error": f"failed objects: {failed}"}]
                    _append_job_log(job, f"Failed objects so far: {failed}")
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
                    _append_job_log(
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
                        "total_inserted": int(
                            summary.get(
                                "uploaded_objects_unique",
                                summary.get("uploaded_objects", 0),
                            )
                            or 0
                        ),
                        "total_embeddings_inserted": int(total_embeddings_inserted),
                        "total_limit": int(summary.get("total_planned", jobs_store[job_id].get("total_limit", 0)) or 0),
                        "total_planned": int(summary.get("total_planned", jobs_store[job_id].get("total_planned", 0)) or 0),
                        "embedding_worker_running": False,
                        "current_scene_tasks_completed": 0,
                        "current_scene_tasks_total": 0,
                        "extract_scene_tasks_completed": 0,
                        "extract_scene_tasks_total": 0,
                        "install_phase": "done",
                        "errors": final_errors,
                        "updated_at": time.time(),
                    }
                )
                _append_job_log(
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
                except Exception as exc:
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
                        "extract_scene_tasks_completed": 0,
                        "extract_scene_tasks_total": 0,
                        "install_phase": "cancelled",
                        "errors": existing_errors + cleanup_errors,
                        "updated_at": time.time(),
                    }
                )
                _append_job_log(
                    jobs_store[job_id],
                    f"Cancelled (cleanup_mode={cleanup_mode}, removed={removed_count}/{len(uploaded_object_ids)})",
                )
    except Exception as exc:
        _stop_embedding_worker(wait=True)
        logger.exception("Dataset installation job failed: job_id=%s dataset=%s", job_id, dataset_key)
        errors.append({"error": str(exc), "log": traceback.format_exc()})
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update(
                    {
                        "status": JobStatus.ERROR.value,
                        "embedding_worker_running": False,
                        "install_phase": "error",
                        "errors": errors,
                        "updated_at": time.time(),
                    }
                )
                _append_job_log(jobs_store[job_id], f"Failed: {exc}")


def _start_backfill_embeddings_job(payload: BackfillRequest) -> str:
    job_id = str(uuid.uuid4())
    thread = threading.Thread(
        target=_run_backfill_job,
        args=(job_id, payload),
        daemon=True,
    )
    thread.start()
    return job_id


def _start_vlm_backfill_job(payload: VLMBackfillRequest) -> str:
    job_id = str(uuid.uuid4())
    thread = threading.Thread(
        target=_run_vlm_backfill_job,
        args=(job_id, payload),
        daemon=True,
    )
    thread.start()
    return job_id


def _start_dataset_install_job(dataset_key: str, dataset_cfg: Dict[str, Any]) -> str:
    job_id = str(uuid.uuid4())
    thread = threading.Thread(
        target=_run_dataset_install_job,
        args=(job_id, dataset_key, dataset_cfg),
        daemon=True,
    )
    thread.start()
    return job_id


def _retry_job_from_failed(source_job_id: str) -> Dict[str, Any]:
    with jobs_lock:
        source_job = jobs_store.get(source_job_id)
        if not source_job:
            raise HTTPException(status_code=404, detail="Job not found")
        snapshot = dict(source_job)

    source_status = str(snapshot.get("status", "")).strip().lower()
    if source_status != JobStatus.ERROR.value:
        raise HTTPException(status_code=400, detail="Only failed jobs can be retried")

    source_job_type = str(snapshot.get("job_type", "")).strip()
    source_config = snapshot.get("job_config")
    normalized_config = dict(source_config) if isinstance(source_config, dict) else {}

    if source_job_type == "backfill_embeddings":
        payload = BackfillRequest(**normalized_config)
        job_id = _start_backfill_embeddings_job(payload)
        return {
            "job_id": job_id,
            "status": "started",
            "source_job_id": source_job_id,
            "job_type": source_job_type,
        }

    if source_job_type == "backfill_vlm":
        payload = VLMBackfillRequest(**normalized_config)
        job_id = _start_vlm_backfill_job(payload)
        return {
            "job_id": job_id,
            "status": "started",
            "source_job_id": source_job_id,
            "job_type": source_job_type,
        }

    if source_job_type.startswith("install_"):
        dataset_key = str(snapshot.get("dataset", "")).strip().lower()
        if not dataset_key:
            dataset_key = source_job_type[len("install_") :].strip().lower()
        if not dataset_key:
            raise HTTPException(status_code=400, detail="Retry is unsupported for this install job")
        job_id = _start_dataset_install_job(dataset_key, normalized_config)
        return {
            "job_id": job_id,
            "status": "started",
            "source_job_id": source_job_id,
            "job_type": source_job_type,
            "dataset": dataset_key,
        }

    raise HTTPException(status_code=400, detail=f"Retry is unsupported for job_type='{source_job_type}'")


@app.get("/health")
def healthcheck():
    model_health = model_gateway.health()
    if model_health.get("status") != "ok":
        raise HTTPException(
            status_code=503,
            detail={
                "status": "degraded",
                "models": model_health,
            },
        )
    return {"status": "ok", "models": model_health}


@app.get("/jobs")
def get_jobs():
    with jobs_lock:
        jobs = []
        for raw_job in jobs_store.values():
            job = dict(raw_job)
            job_log = raw_job.get("job_log")
            if isinstance(job_log, list):
                if len(job_log) > JOBS_JOB_LOG_TAIL_LINES:
                    job["job_log"] = job_log[-JOBS_JOB_LOG_TAIL_LINES:]
                    job["job_log_truncated"] = True
                else:
                    job["job_log"] = list(job_log)
                    job["job_log_truncated"] = False
            jobs.append(job)
    jobs.sort(key=lambda item: item.get("created_at", 0), reverse=True)
    return {"jobs": jobs}


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except Exception:
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
    except Exception as exc:
        out["error"] = str(exc)
        return out


def _fetch_model_runtime(
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
    except Exception as exc:  # noqa: BLE001
        message = str(exc).strip()
        lowered = message.lower()
        if (
            "connection refused" in lowered
            or "all connection attempts failed" in lowered
            or "timed out" in lowered
        ):
            # Service is booting; keep config values and avoid noisy transport errors.
            result["status"] = "starting"
            result["error"] = ""
            return result
        result["error"] = message
        return result


def _sample_existing_embedding_dim(max_objects_scan: int = 512) -> Optional[int]:
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


def _build_embedding_dim_warning(query_embedding: List[float], source: str) -> Optional[Dict[str, Any]]:
    query_dim = len(query_embedding)
    if query_dim <= 0:
        return None
    try:
        total_vectors = max(0, int(storage_api.count_vectors()))
        if total_vectors == 0:
            return None
        stored_dim = _sample_existing_embedding_dim()
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
    except Exception as exc:  # noqa: BLE001
        logger.warning("failed to detect embedding dimension mismatch: %s", exc)
        return None


def _build_search_backend_unavailable_warning(reason: str, source: str) -> Dict[str, Any]:
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


@app.get("/system-info")
def get_system_info():
    try:
        cpu_percent = psutil.cpu_percent(interval=None)
        cpu_count = psutil.cpu_count()
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage("/")
        uptime_seconds = int(time.time() - psutil.boot_time())
        embedder_runtime = _fetch_model_runtime(
            "embedder",
            EMBEDDER_ENDPOINT,
            fallback_model=os.getenv(
                "EMBEDDER_MODEL_NAME",
                str(getattr(EMBEDDER_CONFIG, "MODEL_NAME", "") or ""),
            ),
            fallback_device=os.getenv(
                "EMBEDDER_DEVICE",
                str(getattr(EMBEDDER_CONFIG, "DEVICE", "") or ""),
            ),
            fallback_dtype=os.getenv(
                "EMBEDDER_TORCH_DTYPE",
                str(getattr(EMBEDDER_CONFIG, "TORCH_DTYPE", "") or ""),
            ),
            fallback_attn_type=os.getenv(
                "EMBEDDER_ATTN_IMPLEMENTATION",
                str(getattr(EMBEDDER_CONFIG, "ATTN_IMPLEMENTATION", "") or ""),
            ),
        )
        vlm_runtime = _fetch_model_runtime(
            "vlm",
            VLM_ENDPOINT,
            fallback_model=os.getenv(
                "VLM_MODEL_NAME",
                str(getattr(VLM_CONFIG, "MODEL_NAME", "") or ""),
            ),
            fallback_device=os.getenv(
                "VLM_DEVICE",
                str(getattr(VLM_CONFIG, "DEVICE", "") or ""),
            ),
            fallback_dtype=os.getenv(
                "VLM_TORCH_DTYPE",
                str(getattr(VLM_CONFIG, "TORCH_DTYPE", "") or ""),
            ),
            fallback_attn_type=os.getenv(
                "VLM_ATTN_IMPLEMENTATION",
                str(getattr(VLM_CONFIG, "ATTN_IMPLEMENTATION", "") or ""),
            ),
        )
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
    except Exception as exc:
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
    job_id = _start_backfill_embeddings_job(payload)
    return {"job_id": job_id, "status": "started"}


@app.get("/embeddings/dimensions")
def embeddings_dimensions():
    ready, reason = _search_dependencies_ready(
        require_embedder=True,
        require_vlm=False,
        allow_embedder_http_fallback=True,
    )
    if not ready:
        return {
            "status": "unavailable",
            "reason": reason,
            "query_dim": None,
            "stored_dim": None,
            "mismatch": None,
        }

    timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)
    with httpx.Client(timeout=timeout) as client:
        query_embedding, _ = _embed_text(client, "embedding-dimension-check")
    query_dim = len(query_embedding)
    stored_dim = _sample_existing_embedding_dim()
    mismatch = (
        bool(stored_dim is not None and stored_dim > 0 and query_dim > 0 and int(stored_dim) != int(query_dim))
    )
    return {
        "status": "ok",
        "query_dim": query_dim if query_dim > 0 else None,
        "stored_dim": int(stored_dim) if stored_dim is not None and stored_dim > 0 else None,
        "mismatch": mismatch,
    }


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
        job_id = _start_dataset_install_job(dataset_key, payload.configs.get(dataset_key, {}))
        jobs.append(
            {
                "dataset": dataset_key,
                "job_id": job_id,
                "status": "started",
            }
        )
    return {"jobs": jobs}


@app.post("/waymo/auth/start")
def start_waymo_auth():
    with waymo_auth_lock:
        alive = _is_waymo_auth_process_alive_locked()
        if alive:
            return {
                "session_id": waymo_auth_session.get("session_id"),
                "auth_url": waymo_auth_session.get("auth_url"),
                "awaiting_code": bool(waymo_auth_session.get("awaiting_code", False)),
                "status": "running",
            }

    created = _start_waymo_auth_session()
    deadline = time.time() + 20.0
    while time.time() < deadline:
        with waymo_auth_lock:
            current_id = waymo_auth_session.get("session_id")
            if current_id != created["session_id"]:
                break
            if waymo_auth_session.get("auth_url"):
                return {
                    "session_id": current_id,
                    "auth_url": waymo_auth_session.get("auth_url"),
                    "awaiting_code": bool(waymo_auth_session.get("awaiting_code", False)),
                    "status": "awaiting_code",
                }
            if bool(waymo_auth_session.get("finished", False)):
                logs_tail = list(waymo_auth_session.get("logs", []))[-20:]
                raise HTTPException(
                    status_code=500,
                    detail={
                        "message": "gcloud auth session exited before authorization URL was captured",
                        "logs_tail": logs_tail,
                    },
                )
        time.sleep(0.1)

    with waymo_auth_lock:
        current_id = waymo_auth_session.get("session_id")
        return {
            "session_id": current_id,
            "auth_url": waymo_auth_session.get("auth_url"),
            "awaiting_code": bool(waymo_auth_session.get("awaiting_code", False)),
            "status": "running",
        }


@app.get("/waymo/auth/status")
def waymo_auth_status():
    try:
        import google.auth

        credentials, project_id = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        credential_type = type(credentials).__name__ if credentials is not None else None
        quota_project_id = getattr(credentials, "quota_project_id", None)
        return {
            "authenticated": True,
            "project_id": project_id,
            "quota_project_id": quota_project_id,
            "credential_type": credential_type,
        }
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()
        reason = "unknown"
        if "default credentials were not found" in lowered:
            reason = "missing_adc"
        elif "could not automatically determine credentials" in lowered:
            reason = "missing_adc"
        return {
            "authenticated": False,
            "reason": reason,
            "error": message,
        }


@app.post("/waymo/auth/complete")
def complete_waymo_auth(payload: WaymoAuthCompleteRequest):
    code = payload.code.strip()
    if not code:
        raise HTTPException(status_code=400, detail="authorization code is required")

    with waymo_auth_lock:
        session_id = str(waymo_auth_session.get("session_id") or "")
        if session_id != payload.session_id:
            raise HTTPException(status_code=404, detail="Waymo auth session not found")
        proc = waymo_auth_session.get("process")
        if proc is None:
            raise HTTPException(status_code=409, detail="Waymo auth session is not active")
        if proc.poll() is not None:
            logs_tail = list(waymo_auth_session.get("logs", []))[-30:]
            raise HTTPException(
                status_code=409,
                detail={"message": "Waymo auth session already finished", "logs_tail": logs_tail},
            )
        stdin = proc.stdin
        if stdin is None:
            raise HTTPException(status_code=500, detail="Waymo auth stdin is unavailable")
        stdin.write(code + "\n")
        stdin.flush()
        waymo_auth_session["awaiting_code"] = False

    deadline = time.time() + 180.0
    while time.time() < deadline:
        with waymo_auth_lock:
            current_id = str(waymo_auth_session.get("session_id") or "")
            if current_id != payload.session_id:
                break
            proc = waymo_auth_session.get("process")
            if proc is not None and proc.poll() is not None:
                return_code = int(proc.returncode or 0)
                logs_tail = list(waymo_auth_session.get("logs", []))[-50:]
                waymo_auth_session["finished"] = True
                waymo_auth_session["returncode"] = return_code
                if return_code == 0:
                    return {
                        "status": "success",
                        "message": "Google application-default credentials updated",
                        "logs_tail": logs_tail,
                    }
                raise HTTPException(
                    status_code=400,
                    detail={
                        "message": "gcloud auth failed; check code and try again",
                        "logs_tail": logs_tail,
                    },
                )
        time.sleep(0.2)

    raise HTTPException(
        status_code=504,
        detail="Timed out waiting for gcloud auth to complete",
    )


@app.post("/search/text")
def search_text(payload: TextSearchRequest):
    try:
        ready, reason = _search_dependencies_ready(
            require_embedder=True,
            require_vlm=False,
            allow_embedder_http_fallback=True,
        )
        if not ready:
            logger.warning("search_text dependencies unavailable; returning empty results: %s", reason)
            return {
                "mode": "vector_server",
                "results": [],
                "warning": _build_search_backend_unavailable_warning(reason, source="text"),
            }

        timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)
        started_at = time.perf_counter()
        with httpx.Client(timeout=timeout) as client:
            embed_started_at = time.perf_counter()
            query_embedding, _ = _embed_text(client, payload.query)
            embed_elapsed_ms = (time.perf_counter() - embed_started_at) * 1000
        query_started_at = time.perf_counter()
        try:
            results = storage_api.query_vectors(query_embedding, payload.top_k)
        except Exception as exc:
            if not _is_storage_query_unavailable_error(exc):
                raise
            logger.warning(
                "search_text storage unavailable; returning empty results: %s",
                str(exc),
            )
            results = []
        warning = _build_embedding_dim_warning(query_embedding, source="text") if not results else None
        query_elapsed_ms = (time.perf_counter() - query_started_at) * 1000
        total_elapsed_ms = (time.perf_counter() - started_at) * 1000
        logger.info(
            "search_text completed query_len=%s top_k=%s embed_ms=%.1f vector_query_ms=%.1f total_ms=%.1f",
            len(payload.query),
            payload.top_k,
            embed_elapsed_ms,
            query_elapsed_ms,
            total_elapsed_ms,
        )
    except httpx.HTTPStatusError as exc:
        _raise_upstream_http_error(exc)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "mode": "vector_server",
        "results": results,
        "warning": warning,
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
        ready, reason = _search_dependencies_ready(
            require_embedder=True,
            require_vlm=False,
            allow_embedder_http_fallback=True,
        )
        if not ready:
            logger.warning(
                "search_image_bytes dependencies unavailable; returning empty results: %s",
                reason,
            )
            return {
                "mode": "vector_server",
                "results": [],
                "warning": _build_search_backend_unavailable_warning(reason, source="image"),
            }

        timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)
        started_at = time.perf_counter()
        with httpx.Client(timeout=timeout) as client:
            embed_started_at = time.perf_counter()
            query_embedding, _ = _embed_image(client, image_bytes)
            embed_elapsed_ms = (time.perf_counter() - embed_started_at) * 1000
        query_started_at = time.perf_counter()
        try:
            results = storage_api.query_vectors(query_embedding, max(1, top_k))
        except Exception as exc:
            if not _is_storage_query_unavailable_error(exc):
                raise
            logger.warning(
                "search_image_bytes storage unavailable; returning empty results: %s",
                str(exc),
            )
            results = []
        warning = _build_embedding_dim_warning(query_embedding, source="image") if not results else None
        query_elapsed_ms = (time.perf_counter() - query_started_at) * 1000
        total_elapsed_ms = (time.perf_counter() - started_at) * 1000
        logger.info(
            "search_image_bytes completed bytes=%s top_k=%s embed_ms=%.1f vector_query_ms=%.1f total_ms=%.1f",
            len(image_bytes),
            max(1, top_k),
            embed_elapsed_ms,
            query_elapsed_ms,
            total_elapsed_ms,
        )
    except httpx.HTTPStatusError as exc:
        _raise_upstream_http_error(exc)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "mode": "vector_server",
        "results": results,
        "warning": warning,
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

    fields = analytics_api.upsert_fields(
        normalized_fields,
        replace_missing=payload.replace_missing,
        purge_deleted_values=payload.purge_deleted_values,
    )
    return {"fields": fields}


@app.post("/vlm/backfill")
def backfill_vlm(payload: VLMBackfillRequest):
    job_id = _start_vlm_backfill_job(payload)
    return {"job_id": job_id, "status": "started"}


@app.post("/vlm/annotations/clear")
def clear_vlm_annotations():
    return analytics_api.clear_annotations()


@app.post("/vlm/annotations/upsert")
def upsert_vlm_annotations(payload: AnnotationRowsRequest):
    normalized_rows: List[Dict[str, Any]] = []
    for row in payload.rows:
        object_id = str(row.object_id or "").strip()
        if not object_id:
            continue
        normalized_values = {
            str(key).strip(): str(value).strip()
            for key, value in row.values.items()
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
        job_type = str(job.get("job_type", "")).strip()
        supports_cleanup_mode = job_type.startswith("install_") or job_type in {
            "backfill_vlm",
            "backfill_embeddings",
        }
        if supports_cleanup_mode:
            job["install_cleanup_mode"] = cleanup_mode
        job["cancel_requested"] = True
        job["updated_at"] = time.time()
    return {
        "job_id": payload.job_id,
        "status": "cancellation_requested",
        "install_cleanup_mode": cleanup_mode if supports_cleanup_mode else None,
    }


@app.post("/jobs/retry")
def retry_job(payload: RetryJobRequest):
    return _retry_job_from_failed(payload.job_id)


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
    except Exception as exc:
        errors["storage_server"] = str(exc)

    try:
        result["annotations"]["requested"] = analytics_api.delete_annotations([object_id])
    except Exception as exc:
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
