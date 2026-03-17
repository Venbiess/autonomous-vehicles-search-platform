import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from math import sqrt
from typing import Any, Dict, List, Optional, Tuple

import boto3
import httpx
import psutil
import psycopg2
from botocore.client import Config
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from psycopg2 import sql
from psycopg2.extras import execute_values

from configs.common import (
    EMBEDDER_ENDPOINT,
    EMBEDDER_TIMEOUT_SEC,
    EMBEDDINGS_SCHEMA,
    EMBEDDINGS_TABLE,
    POSTGRES_DB,
    POSTGRES_HOST,
    POSTGRES_PASSWORD,
    POSTGRES_PORT,
    POSTGRES_SCHEMA,
    POSTGRES_TABLE,
    POSTGRES_USER,
    S3_ACCESS_KEY_ID,
    S3_ENDPOINT_URL,
    S3_SECRET_ACCESS_KEY,
    VLM_ANNOTATIONS_TABLE,
    VLM_ENDPOINT,
    VLM_FIELDS_TABLE,
    VLM_SCHEMA,
    VLM_TIMEOUT_SEC,
)

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


@dataclass(frozen=True)
class EmbedResult:
    storage_path: str
    embedding: List[float]
    dim: int


def _parse_storage_path(storage_path: str) -> Tuple[str, str]:
    if storage_path.startswith("s3://"):
        storage_path = storage_path[5:]
    bucket, sep, key = storage_path.partition("/")
    if not bucket or not sep or not key:
        raise ValueError(f"Invalid storage_path: {storage_path}")
    return bucket, key


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


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT_URL,
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        region_name="us-east-1",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
        ),
    )


def _db_conn():
    return psycopg2.connect(
        host=POSTGRES_HOST,
        port=POSTGRES_PORT,
        dbname=POSTGRES_DB,
        user=POSTGRES_USER,
        password=POSTGRES_PASSWORD,
    )


def _ensure_embedding_table(conn) -> None:
    create_schema_stmt = sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(
        sql.Identifier(EMBEDDINGS_SCHEMA)
    )
    create_table_stmt = sql.SQL(
        """
        CREATE TABLE IF NOT EXISTS {}.{} (
            storage_path TEXT PRIMARY KEY,
            embedding DOUBLE PRECISION[] NOT NULL,
            embedding_dim INT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT now()
        )
        """
    ).format(
        sql.Identifier(EMBEDDINGS_SCHEMA),
        sql.Identifier(EMBEDDINGS_TABLE),
    )
    with conn.cursor() as cur:
        cur.execute(create_schema_stmt)
        cur.execute(create_table_stmt)


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
            storage_path TEXT PRIMARY KEY,
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


def _fetch_pending_paths(conn, limit: int) -> List[str]:
    query = sql.SQL(
        """
        SELECT src.storage_path
        FROM {}.{} AS src
        LEFT JOIN {}.{} AS emb
            ON src.storage_path = emb.storage_path
        WHERE src.storage_path IS NOT NULL
          AND emb.storage_path IS NULL
        LIMIT %s
        """
    ).format(
        sql.Identifier(POSTGRES_SCHEMA),
        sql.Identifier(POSTGRES_TABLE),
        sql.Identifier(EMBEDDINGS_SCHEMA),
        sql.Identifier(EMBEDDINGS_TABLE),
    )
    with conn.cursor() as cur:
        cur.execute(query, (limit,))
        rows = cur.fetchall()
    return [row[0] for row in rows]


def _fetch_pending_vlm_paths(
    conn,
    field_names: List[str],
    limit: int,
    overwrite_existing: bool,
) -> List[str]:
    query = sql.SQL(
        """
        SELECT src.storage_path
        FROM {}.{} AS src
        LEFT JOIN {}.{} AS ann
            ON src.storage_path = ann.storage_path
        WHERE src.storage_path IS NOT NULL
        """
    ).format(
        sql.Identifier(POSTGRES_SCHEMA),
        sql.Identifier(POSTGRES_TABLE),
        sql.Identifier(VLM_SCHEMA),
        sql.Identifier(VLM_ANNOTATIONS_TABLE),
    )
    params: List[Any] = []
    if not overwrite_existing:
        missing_clauses = [sql.SQL("ann.storage_path IS NULL")]
        for field_name in field_names:
            missing_clauses.append(
                sql.SQL("ann.{} IS NULL").format(sql.Identifier(field_name))
            )
        query += sql.SQL(" AND ({})").format(sql.SQL(" OR ").join(missing_clauses))
    query += sql.SQL(" LIMIT %s")
    params.append(limit)
    with conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
    return [row[0] for row in rows]


def _count_pending_vlm_paths(
    conn,
    field_names: List[str],
    overwrite_existing: bool,
) -> int:
    query = sql.SQL(
        """
        SELECT COUNT(*)
        FROM {}.{} AS src
        LEFT JOIN {}.{} AS ann
            ON src.storage_path = ann.storage_path
        WHERE src.storage_path IS NOT NULL
        """
    ).format(
        sql.Identifier(POSTGRES_SCHEMA),
        sql.Identifier(POSTGRES_TABLE),
        sql.Identifier(VLM_SCHEMA),
        sql.Identifier(VLM_ANNOTATIONS_TABLE),
    )
    params: List[Any] = []
    if not overwrite_existing:
        missing_clauses = [sql.SQL("ann.storage_path IS NULL")]
        for field_name in field_names:
            missing_clauses.append(
                sql.SQL("ann.{} IS NULL").format(sql.Identifier(field_name))
            )
        query += sql.SQL(" AND ({})").format(sql.SQL(" OR ").join(missing_clauses))
    with conn.cursor() as cur:
        cur.execute(query, params)
        row = cur.fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _embedding_column_is_vector(conn) -> bool:
    query = """
        SELECT data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = %s
          AND table_name = %s
          AND column_name = 'embedding'
    """
    with conn.cursor() as cur:
        cur.execute(query, (EMBEDDINGS_SCHEMA, EMBEDDINGS_TABLE))
        row = cur.fetchone()
    if not row:
        return False
    data_type, udt_name = row
    return data_type == "USER-DEFINED" and udt_name == "vector"


def _vector_literal(values: List[float]) -> str:
    return "[" + ",".join(f"{value:.8f}" for value in values) + "]"


def _insert_embeddings(conn, rows: List[EmbedResult]) -> int:
    if not rows:
        return 0
    insert_stmt = sql.SQL(
        """
        INSERT INTO {}.{} (storage_path, embedding, embedding_dim)
        VALUES %s
        ON CONFLICT (storage_path)
        DO UPDATE SET embedding = EXCLUDED.embedding,
                      embedding_dim = EXCLUDED.embedding_dim
        """
    ).format(
        sql.Identifier(EMBEDDINGS_SCHEMA),
        sql.Identifier(EMBEDDINGS_TABLE),
    )
    values = [(row.storage_path, row.embedding, row.dim) for row in rows]
    with conn.cursor() as cur:
        execute_values(cur, insert_stmt.as_string(cur), values)
    return len(rows)


def _upsert_vlm_annotations(
    conn,
    rows: List[Dict[str, Any]],
    field_names: List[str],
) -> int:
    if not rows or not field_names:
        return 0

    insert_columns = ["storage_path"] + field_names
    insert_stmt = sql.SQL(
        """
        INSERT INTO {}.{} ({})
        VALUES %s
        ON CONFLICT (storage_path)
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
        (row["storage_path"],) + tuple(row["values"].get(field_name) for field_name in field_names)
        for row in rows
    ]
    with conn.cursor() as cur:
        execute_values(cur, insert_stmt.as_string(cur), values)
    return len(rows)


def _fetch_image_bytes(s3, storage_path: str) -> bytes:
    if storage_path.startswith(("http://", "https://")):
        response = httpx.get(storage_path, timeout=EMBEDDER_TIMEOUT_SEC)
        response.raise_for_status()
        return response.content
    bucket, key = _parse_storage_path(storage_path)
    obj = s3.get_object(Bucket=bucket, Key=key)
    return obj["Body"].read()


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
    storage_path: Optional[str] = None,
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
            "storage_path": storage_path or "",
        },
        files={"file": ("image.jpg", image_bytes, "image/jpeg")},
    )
    response.raise_for_status()
    payload = response.json()
    return payload["response"].strip()


def _cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
    if len(vec_a) != len(vec_b):
        raise ValueError("Embedding dimensions do not match")
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for a, b in zip(vec_a, vec_b):
        dot += a * b
        norm_a += a * a
        norm_b += b * b
    denom = sqrt(norm_a) * sqrt(norm_b)
    if denom == 0.0:
        return 0.0
    return dot / denom


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
        s3 = _s3_client()
        timeout = httpx.Timeout(EMBEDDER_TIMEOUT_SEC)

        with _db_conn() as conn:
            _ensure_embedding_table(conn)
            with httpx.Client(timeout=timeout) as client:
                while total_seen < payload.limit:
                    batch_limit = min(payload.batch_size, payload.limit - total_seen)
                    paths = _fetch_pending_paths(conn, batch_limit)
                    if not paths:
                        break

                    total_seen += len(paths)
                    rows: List[EmbedResult] = []

                    for storage_path in paths:
                        try:
                            image_bytes = _fetch_image_bytes(s3, storage_path)
                            embedding, dim = _embed_image(client, image_bytes)
                            rows.append(
                                EmbedResult(
                                    storage_path=storage_path,
                                    embedding=embedding,
                                    dim=dim,
                                )
                            )
                        except Exception as exc:  # noqa: BLE001
                            logger.exception("Embedding failed for %s", storage_path)
                            errors.append(
                                {"storage_path": storage_path, "error": str(exc)}
                            )
                            if payload.stop_on_error:
                                break

                    if rows and not payload.dry_run:
                        total_inserted += _insert_embeddings(conn, rows)

                    progress = min(int((total_seen / payload.limit) * 100), 100)
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
        s3 = _s3_client()
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
            pending_paths = _count_pending_vlm_paths(
                conn,
                field_names,
                payload.overwrite_existing,
            )
            total_paths_planned = min(payload.limit, pending_paths)
            total_tasks_planned = total_paths_planned * len(field_names)
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
                while total_seen < payload.limit:
                    if _job_cancel_requested(job_id):
                        _mark_job_cancelled(job_id, total_seen, total_inserted, errors)
                        return

                    batch_limit = min(payload.batch_size, payload.limit - total_seen)
                    paths = _fetch_pending_vlm_paths(
                        conn,
                        field_names,
                        batch_limit,
                        payload.overwrite_existing,
                    )
                    if not paths:
                        break

                    for storage_path in paths:
                        if _job_cancel_requested(job_id):
                            _mark_job_cancelled(job_id, total_seen, total_inserted, errors)
                            return
                        try:
                            image_bytes = _fetch_image_bytes(s3, storage_path)
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
                                prompt = _build_vlm_prompt(
                                    field["prompt"],
                                    field["response_type"],
                                )
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
                                    storage_path=storage_path,
                                )
                                values[field["field_name"]] = _normalize_vlm_response(
                                    values[field["field_name"]],
                                    field["response_type"],
                                )
                                completed_tasks += 1
                                current_scene_tasks_completed = field_index + 1
                                with jobs_lock:
                                    if job_id in jobs_store:
                                        jobs_store[job_id].update(
                                            {
                                                "progress": (
                                                    min(
                                                        int(
                                                            (total_seen / total_paths_planned)
                                                            * 100
                                                        ),
                                                        100,
                                                    )
                                                    if total_paths_planned > 0
                                                    else 100
                                                ),
                                                "total_seen": total_seen,
                                                "total_tasks_completed": completed_tasks,
                                                "total_tasks_planned": total_tasks_planned,
                                                "current_scene_index": current_scene_index,
                                                "current_scene_tasks_completed": (
                                                    current_scene_tasks_completed
                                                ),
                                                "current_scene_tasks_total": (
                                                    current_scene_tasks_total
                                                ),
                                                "updated_at": time.time(),
                                            }
                                        )
                            if not payload.dry_run:
                                total_inserted += _upsert_vlm_annotations(
                                    conn,
                                    [{"storage_path": storage_path, "values": values}],
                                    field_names,
                                )
                                conn.commit()
                            total_seen += 1
                            progress = (
                                min(int((total_seen / total_paths_planned) * 100), 100)
                                if total_paths_planned > 0
                                else 100
                            )
                            with jobs_lock:
                                if job_id in jobs_store:
                                    jobs_store[job_id].update(
                                        {
                                            "progress": progress,
                                            "total_seen": total_seen,
                                            "total_inserted": total_inserted,
                                            "total_tasks_completed": completed_tasks,
                                            "total_tasks_planned": total_tasks_planned,
                                            "current_scene_index": current_scene_index,
                                            "current_scene_tasks_completed": 0,
                                            "current_scene_tasks_total": current_scene_tasks_total,
                                            "updated_at": time.time(),
                                        }
                                    )
                        except Exception as exc:  # noqa: BLE001
                            logger.exception("VLM failed for %s", storage_path)
                            errors.append(
                                {"storage_path": storage_path, "error": str(exc)}
                            )
                            total_seen += 1
                            progress = (
                                min(int((total_seen / total_paths_planned) * 100), 100)
                                if total_paths_planned > 0
                                else 100
                            )
                            with jobs_lock:
                                if job_id in jobs_store:
                                    jobs_store[job_id].update(
                                        {
                                            "progress": progress,
                                            "total_seen": total_seen,
                                            "total_inserted": total_inserted,
                                            "total_tasks_completed": completed_tasks,
                                            "total_tasks_planned": total_tasks_planned,
                                            "current_scene_index": total_seen,
                                            "current_scene_tasks_completed": 0,
                                            "current_scene_tasks_total": 0,
                                            "errors": errors,
                                            "updated_at": time.time(),
                                        }
                                    )
                            if payload.stop_on_error:
                                break

                    progress = (
                        min(int((total_seen / total_paths_planned) * 100), 100)
                        if total_paths_planned > 0
                        else 100
                    )
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
                                    "current_scene_tasks_total": 0,
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

    with _db_conn() as conn:
        if _embedding_column_is_vector(conn):
            vector_value = _vector_literal(query_embedding)
            query = sql.SQL(
                """
                SELECT storage_path, embedding <-> %s::vector AS distance
                FROM {}.{}
                ORDER BY embedding <-> %s::vector
                LIMIT %s
                """
            ).format(
                sql.Identifier(EMBEDDINGS_SCHEMA),
                sql.Identifier(EMBEDDINGS_TABLE),
            )
            with conn.cursor() as cur:
                cur.execute(query, (vector_value, vector_value, payload.top_k))
                rows = cur.fetchall()
            return {
                "mode": "vector_distance",
                "results": [
                    {"storage_path": row[0], "distance": row[1]} for row in rows
                ],
            }

        query = sql.SQL(
            """
            SELECT storage_path, embedding
            FROM {}.{}
            LIMIT %s
            """
        ).format(
            sql.Identifier(EMBEDDINGS_SCHEMA),
            sql.Identifier(EMBEDDINGS_TABLE),
        )
        with conn.cursor() as cur:
            cur.execute(query, (payload.max_rows,))
            rows = cur.fetchall()

    scored = []
    for storage_path, embedding in rows:
        similarity = _cosine_similarity(query_embedding, embedding)
        scored.append((storage_path, similarity))
    scored.sort(key=lambda item: item[1], reverse=True)
    return {
        "mode": "python_cosine",
        "results": [
            {"storage_path": storage_path, "similarity": score}
            for storage_path, score in scored[: payload.top_k]
        ],
        "evaluated_rows": len(rows),
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

        select_columns = [sql.SQL("storage_path")]
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
        storage_path = row[0]
        attributes = {
            field_name: row[index + 1]
            for index, field_name in enumerate(selected_fields)
        }
        results.append(
            {
                "storage_path": storage_path,
                "attributes": attributes,
            }
        )
    return {"results": results}
