import logging
from dataclasses import dataclass
from math import sqrt
from typing import List, Tuple

import boto3
import httpx
import psycopg2
from botocore.client import Config
from fastapi import FastAPI
from pydantic import BaseModel, Field
from psycopg2 import sql
from psycopg2.extras import execute_values
import time

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
)

logger = logging.getLogger("avsp.master")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="AVSP Master Server")


class BackfillRequest(BaseModel):
    limit: int = Field(1000, ge=1)
    batch_size: int = Field(50, ge=1)
    stop_on_error: bool = False
    dry_run: bool = False


class TextSearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(5, ge=1)
    max_rows: int = Field(10000, ge=1)


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


@app.get("/health")
def healthcheck():
    return {"status": "ok"}


@app.post("/embeddings/backfill")
def backfill_embeddings(payload: BackfillRequest):
    total_seen = 0
    total_inserted = 0
    errors = []

    logger.info(
        "Backfill started: limit=%s batch_size=%s dry_run=%s",
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
                    logger.info("Backfill complete: no more pending rows.")
                    break

                logger.info(
                    "Processing batch: size=%s seen=%s inserted=%s errors=%s",
                    len(paths),
                    total_seen,
                    total_inserted,
                    len(errors),
                )
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
                        logger.exception("Failed for %s", storage_path)
                        errors.append(
                            {"storage_path": storage_path, "error": str(exc)}
                        )
                        if payload.stop_on_error:
                            break

                if rows and not payload.dry_run:
                    total_inserted += _insert_embeddings(conn, rows)
                    logger.info(
                        "Batch inserted: count=%s total_inserted=%s",
                        len(rows),
                        total_inserted,
                    )

                if payload.stop_on_error and errors:
                    break

    logger.info(
        "Backfill finished: total_seen=%s total_inserted=%s errors=%s",
        total_seen,
        total_inserted,
        len(errors),
    )
    return {
        "total_seen": total_seen,
        "total_inserted": total_inserted,
        "errors": errors[:50],
    }


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
            results = [
                {"storage_path": row[0], "distance": row[1]} for row in rows
            ]
            return {"mode": "vector_distance", "results": results}

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
    results = [
        {"storage_path": storage_path, "similarity": score}
        for storage_path, score in scored[: payload.top_k]
    ]
    return {
        "mode": "python_cosine",
        "results": results,
        "evaluated_rows": len(rows),
    }
