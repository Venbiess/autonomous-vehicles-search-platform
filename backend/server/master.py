import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional

import httpx
import psutil
import psycopg2
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field
from psycopg2 import sql
from psycopg2.extras import execute_values

from configs.common import (
    EMBEDDER_ENDPOINT,
    EMBEDDER_TIMEOUT_SEC,
    OBJECT_SERVICE_ENDPOINT,
    OBJECT_SERVICE_TIMEOUT_SEC,
    POSTGRES_DB,
    POSTGRES_HOST,
    POSTGRES_PASSWORD,
    POSTGRES_PORT,
    POSTGRES_SCHEMA,
    POSTGRES_TABLE,
    POSTGRES_USER,
    VECTOR_SERVICE_ENDPOINT,
    VECTOR_SERVICE_TIMEOUT_SEC,
    VLM_ANNOTATIONS_TABLE,
    VLM_ENDPOINT,
    VLM_FIELDS_TABLE,
    VLM_SCHEMA,
    VLM_TIMEOUT_SEC,
)
from backend.server.storage_api import StorageAPI

logger = logging.getLogger("avsp.master")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="AVSP Master Server")

jobs_store: Dict[str, Dict[str, Any]] = {}
jobs_lock = threading.Lock()

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


class SyncObjectsRequest(BaseModel):
    limit: int = Field(100000, ge=1)
    batch_size: int = Field(500, ge=1)


@dataclass(frozen=True)
class EmbedResult:
    object_id: str
    embedding: List[float]
    dim: int

storage_api = StorageAPI(
    object_endpoint=OBJECT_SERVICE_ENDPOINT,
    vector_endpoint=VECTOR_SERVICE_ENDPOINT,
    object_timeout_sec=OBJECT_SERVICE_TIMEOUT_SEC,
    vector_timeout_sec=VECTOR_SERVICE_TIMEOUT_SEC,
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


def _db_conn():
    return psycopg2.connect(
        host=POSTGRES_HOST,
        port=POSTGRES_PORT,
        dbname=POSTGRES_DB,
        user=POSTGRES_USER,
        password=POSTGRES_PASSWORD,
    )

def _ensure_vlm_tables(conn) -> None:
    create_schema_stmt = sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(
        sql.Identifier(VLM_SCHEMA)
    )
    create_fields_stmt = sql.SQL(
        """
        CREATE TABLE IF NOT EXISTS {}.{} (
            field_name TEXT PRIMARY KEY,
            prompt TEXT NOT NULL,
            response_type TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        )
        """
    ).format(
        sql.Identifier(VLM_SCHEMA),
        sql.Identifier(VLM_FIELDS_TABLE),
    )
    create_annotations_stmt = sql.SQL(
        """
        CREATE TABLE IF NOT EXISTS {}.{} (
            object_id TEXT PRIMARY KEY,
            updated_at TIMESTAMPTZ DEFAULT now()
        )
        """
    ).format(
        sql.Identifier(VLM_SCHEMA),
        sql.Identifier(VLM_ANNOTATIONS_TABLE),
    )
    with conn.cursor() as cur:
        cur.execute(create_schema_stmt)
        cur.execute(create_fields_stmt)
        cur.execute(create_annotations_stmt)


def _ensure_vlm_columns(conn, field_names: List[str]) -> None:
    if not field_names:
        return
    with conn.cursor() as cur:
        for field_name in field_names:
            cur.execute(
                sql.SQL(
                    "ALTER TABLE {}.{} ADD COLUMN IF NOT EXISTS {} TEXT"
                ).format(
                    sql.Identifier(VLM_SCHEMA),
                    sql.Identifier(VLM_ANNOTATIONS_TABLE),
                    sql.Identifier(field_name),
                )
            )


def _upsert_vlm_field_specs(conn, fields: List[Dict[str, str]]) -> None:
    if not fields:
        return
    insert_stmt = sql.SQL(
        """
        INSERT INTO {}.{} (field_name, prompt, response_type)
        VALUES %s
        ON CONFLICT (field_name)
        DO UPDATE SET prompt = EXCLUDED.prompt,
                      response_type = EXCLUDED.response_type,
                      updated_at = now()
        """
    ).format(
        sql.Identifier(VLM_SCHEMA),
        sql.Identifier(VLM_FIELDS_TABLE),
    )
    values = [
        (field["field_name"], field["prompt"], field["response_type"])
        for field in fields
    ]
    with conn.cursor() as cur:
        execute_values(cur, insert_stmt.as_string(cur), values)


def _fetch_vlm_fields(
    conn,
    requested_names: Optional[List[str]] = None,
) -> List[Dict[str, str]]:
    base_query = sql.SQL(
        """
        SELECT field_name, prompt, response_type
        FROM {}.{}
        """
    ).format(
        sql.Identifier(VLM_SCHEMA),
        sql.Identifier(VLM_FIELDS_TABLE),
    )
    params: List[Any] = []
    if requested_names:
        query = base_query + sql.SQL(" WHERE field_name = ANY(%s)")
        params.append(requested_names)
    else:
        query = base_query
    query += sql.SQL(" ORDER BY field_name")
    with conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
    return [
        {
            "field_name": row[0],
            "prompt": row[1],
            "response_type": row[2],
        }
        for row in rows
    ]


def _validate_existing_vlm_fields(conn, field_names: List[str]) -> List[Dict[str, str]]:
    normalized_names = [_normalize_field_name(name) for name in field_names]
    fields = _fetch_vlm_fields(conn, normalized_names)
    if len(fields) != len(set(normalized_names)):
        existing = {field["field_name"] for field in fields}
        missing = sorted(set(normalized_names) - existing)
        raise ValueError(f"Unknown VLM fields: {missing}")
    return fields


def _fetch_source_paths(conn, limit: int) -> List[str]:
    query = sql.SQL(
        """
        SELECT DISTINCT src.storage_path
        FROM {}.{} AS src
        WHERE src.storage_path IS NOT NULL
          AND src.storage_path <> ''
        LIMIT %s
        """
    ).format(
        sql.Identifier(POSTGRES_SCHEMA),
        sql.Identifier(POSTGRES_TABLE),
    )
    with conn.cursor() as cur:
        cur.execute(query, (limit,))
        rows = cur.fetchall()
    return [row[0] for row in rows]


def _upsert_vlm_annotations(
    conn,
    rows: List[Dict[str, Any]],
    field_names: List[str],
) -> int:
    if not rows or not field_names:
        return 0

    insert_columns = ["object_id"] + field_names
    insert_stmt = sql.SQL(
        """
        INSERT INTO {}.{} ({})
        VALUES %s
        ON CONFLICT (object_id)
        DO UPDATE SET {},
                      updated_at = now()
        """
    ).format(
        sql.Identifier(VLM_SCHEMA),
        sql.Identifier(VLM_ANNOTATIONS_TABLE),
        sql.SQL(", ").join(sql.Identifier(column) for column in insert_columns),
        sql.SQL(", ").join(
            sql.SQL("{} = EXCLUDED.{}").format(
                sql.Identifier(field_name),
                sql.Identifier(field_name),
            )
            for field_name in field_names
        ),
    )
    values = [
        (row["object_id"],) + tuple(row["values"].get(field_name) for field_name in field_names)
        for row in rows
    ]
    with conn.cursor() as cur:
        execute_values(cur, insert_stmt.as_string(cur), values)
    return len(rows)


def _filter_pending_vlm_object_ids(
    conn,
    object_ids: List[str],
    field_names: List[str],
    overwrite_existing: bool,
) -> List[str]:
    if overwrite_existing or not object_ids:
        return object_ids
    completed_predicate = sql.SQL(" AND ").join(
        [sql.SQL("{} IS NOT NULL").format(sql.Identifier(name)) for name in field_names]
    )
    query = sql.SQL(
        """
        SELECT object_id
        FROM {}.{}
        WHERE object_id = ANY(%s)
          AND {}
        """
    ).format(
        sql.Identifier(VLM_SCHEMA),
        sql.Identifier(VLM_ANNOTATIONS_TABLE),
        completed_predicate,
    )
    with conn.cursor() as cur:
        cur.execute(query, (object_ids,))
        rows = cur.fetchall()
    completed = {row[0] for row in rows}
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


def _fetch_image_bytes(object_id: str) -> bytes:
    content, _ = storage_api.get_object_bytes(object_id)
    return content


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


def _run_backfill_job(job_id: str, payload: BackfillRequest):
    with jobs_lock:
        jobs_store[job_id] = {
            "job_id": job_id,
            "job_type": "backfill_embeddings",
            "status": JobStatus.RUNNING.value,
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

        object_ids = _list_object_ids(payload.limit)
        with httpx.Client(timeout=timeout) as client:
            for i in range(0, len(object_ids), payload.batch_size):
                batch_ids = object_ids[i : i + payload.batch_size]
                rows: List[EmbedResult] = []

                for object_id in batch_ids:
                    try:
                        image_bytes = _fetch_image_bytes(object_id)
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
                        if payload.stop_on_error:
                            break

                total_seen += len(batch_ids)
                if rows and not payload.dry_run:
                    total_inserted += storage_api.upsert_vectors(
                        [
                            {"object_id": row.object_id, "embedding": row.embedding}
                            for row in rows
                        ]
                    )

                progress = min(int((total_seen / max(payload.limit, 1)) * 100), 100)
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
                        "errors": errors + [{"error": str(exc)}],
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

        with _db_conn() as conn:
            _ensure_vlm_tables(conn)
            if payload.field_names:
                fields = _validate_existing_vlm_fields(conn, payload.field_names)
            else:
                fields = _fetch_vlm_fields(conn)
            if not fields:
                raise ValueError("No VLM fields configured")

            field_names = [field["field_name"] for field in fields]
            _ensure_vlm_columns(conn, field_names)
            object_ids = _list_object_ids(payload.limit)
            object_ids = _filter_pending_vlm_object_ids(
                conn,
                object_ids,
                field_names,
                payload.overwrite_existing,
            )
            total_tasks_planned = len(object_ids) * len(field_names)
            completed_tasks = 0
            conn.commit()

            with jobs_lock:
                if job_id in jobs_store:
                    jobs_store[job_id].update(
                        {
                            "total_tasks_planned": total_tasks_planned,
                            "updated_at": time.time(),
                        }
                    )

            with httpx.Client(timeout=timeout) as client:
                for object_id in object_ids:
                    if _job_cancel_requested(job_id):
                        _mark_job_cancelled(job_id, total_seen, total_inserted, errors)
                        return
                    try:
                        image_bytes = _fetch_image_bytes(object_id)
                        values: Dict[str, str] = {}
                        current_scene_index = total_seen + 1
                        current_scene_tasks_total = len(fields)
                        current_scene_tasks_completed = 0
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
                            current_scene_tasks_completed = field_index + 1
                        if not payload.dry_run:
                            total_inserted += _upsert_vlm_annotations(
                                conn,
                                [{"object_id": object_id, "values": values}],
                                field_names,
                            )
                            conn.commit()
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
                        "errors": errors + [{"error": str(exc)}],
                        "updated_at": time.time(),
                    }
                )


@app.get("/health")
def healthcheck():
    return {"status": "ok"}


@app.get("/jobs")
def get_jobs():
    with jobs_lock:
        jobs = list(jobs_store.values())
    jobs.sort(key=lambda item: item.get("created_at", 0), reverse=True)
    return {"jobs": jobs}


@app.get("/system-info")
def get_system_info():
    try:
        cpu_percent = psutil.cpu_percent(interval=1)
        cpu_count = psutil.cpu_count()
        memory = psutil.virtual_memory()
        disk = psutil.disk_usage("/")
        uptime_seconds = int(time.time() - psutil.boot_time())

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


@app.post("/search/text")
def search_text(payload: TextSearchRequest):
    timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)
    with httpx.Client(timeout=timeout) as client:
        query_embedding, _ = _embed_text(client, payload.query)
    results = storage_api.query_vectors(query_embedding, payload.top_k)
    return {
        "mode": "vector_service",
        "results": results,
    }


@app.get("/vlm/fields")
def get_vlm_fields():
    with _db_conn() as conn:
        _ensure_vlm_tables(conn)
        return {"fields": _fetch_vlm_fields(conn)}


@app.post("/vlm/fields")
def upsert_vlm_fields(payload: VLMFieldsRequest):
    try:
        normalized_fields = _normalize_vlm_fields(payload.fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    with _db_conn() as conn:
        _ensure_vlm_tables(conn)
        _ensure_vlm_columns(conn, [field["field_name"] for field in normalized_fields])
        _upsert_vlm_field_specs(conn, normalized_fields)
        fields = _fetch_vlm_fields(conn)
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
    with _db_conn() as conn:
        _ensure_vlm_tables(conn)
        with conn.cursor() as cur:
            cur.execute(
                sql.SQL("SELECT COUNT(*) FROM {}.{}").format(
                    sql.Identifier(VLM_SCHEMA),
                    sql.Identifier(VLM_ANNOTATIONS_TABLE),
                )
            )
            row = cur.fetchone()
            deleted_rows = int(row[0]) if row and row[0] is not None else 0
            cur.execute(
                sql.SQL("TRUNCATE TABLE {}.{}").format(
                    sql.Identifier(VLM_SCHEMA),
                    sql.Identifier(VLM_ANNOTATIONS_TABLE),
                )
            )
        conn.commit()
    return {"status": "cleared", "deleted_rows": deleted_rows}


@app.post("/jobs/cancel")
def cancel_job(payload: CancelJobRequest):
    with jobs_lock:
        job = jobs_store.get(payload.job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job["status"] != JobStatus.RUNNING.value:
            raise HTTPException(status_code=400, detail="Job is not running")
        job["cancel_requested"] = True
        job["updated_at"] = time.time()
    return {"job_id": payload.job_id, "status": "cancellation_requested"}


@app.post("/objects/sync-from-frames")
def sync_objects_from_frames(payload: SyncObjectsRequest):
    with _db_conn() as conn:
        paths = _fetch_source_paths(conn, payload.limit)
    total_registered = 0
    for i in range(0, len(paths), payload.batch_size):
        batch = paths[i : i + payload.batch_size]
        items = storage_api.register_paths(batch)
        total_registered += len(items)
    return {
        "status": "ok",
        "source_paths": len(paths),
        "registered_objects": total_registered,
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

    with _db_conn() as conn:
        _ensure_vlm_tables(conn)
        _validate_existing_vlm_fields(
            conn,
            [item["field_name"] for item in normalized_filters],
        )

        selected_fields = []
        seen_fields = set()
        for item in normalized_filters:
            if item["field_name"] not in seen_fields:
                selected_fields.append(item["field_name"])
                seen_fields.add(item["field_name"])

        select_columns = [sql.SQL("object_id")]
        select_columns.extend(
            sql.Identifier(field_name) for field_name in selected_fields
        )
        query = sql.SQL("SELECT {} FROM {}.{} WHERE ").format(
            sql.SQL(", ").join(select_columns),
            sql.Identifier(VLM_SCHEMA),
            sql.Identifier(VLM_ANNOTATIONS_TABLE),
        )

        clauses = []
        params: List[Any] = []
        for item in normalized_filters:
            identifier = sql.Identifier(item["field_name"])
            if item["match_mode"] == "contains":
                clauses.append(sql.SQL("{} ILIKE %s").format(identifier))
                params.append(f"%{item['value']}%")
            else:
                clauses.append(sql.SQL("LOWER({}) = LOWER(%s)").format(identifier))
                params.append(item["value"])

        query += sql.SQL(" AND ").join(clauses)
        query += sql.SQL(" ORDER BY updated_at DESC LIMIT %s")
        params.append(payload.limit)

        with conn.cursor() as cur:
            cur.execute(query, params)
            rows = cur.fetchall()

    results = []
    for row in rows:
        object_id = row[0]
        attributes = {
            field_name: row[index + 1]
            for index, field_name in enumerate(selected_fields)
        }
        results.append(
            {
                "object_id": object_id,
                "attributes": attributes,
            }
        )
    return {"results": results}


@app.get("/objects/{object_id}/content")
def get_object_content(object_id: str):
    try:
        image_bytes, content_type = storage_api.get_object_bytes(object_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return Response(content=image_bytes, media_type=content_type)
