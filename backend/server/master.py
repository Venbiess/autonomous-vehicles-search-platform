import logging
from dataclasses import dataclass
from typing import List, Tuple

import boto3
import httpx
import psycopg2
from botocore.client import Config
from fastapi import FastAPI
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
)

logger = logging.getLogger("avsp.master")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="AVSP Master Server")


class BackfillRequest(BaseModel):
    limit: int = Field(1000, ge=1)
    batch_size: int = Field(50, ge=1)
    stop_on_error: bool = False
    dry_run: bool = False


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
    print(s3, storage_path)
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


@app.get("/health")
def healthcheck():
    return {"status": "ok"}


@app.post("/embeddings/backfill")
def backfill_embeddings(payload: BackfillRequest):
    total_seen = 0
    total_inserted = 0
    errors = []

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
                        logger.exception("Failed for %s", storage_path)
                        errors.append(
                            {"storage_path": storage_path, "error": str(exc)}
                        )
                        if payload.stop_on_error:
                            break

                if rows and not payload.dry_run:
                    total_inserted += _insert_embeddings(conn, rows)

                if payload.stop_on_error and errors:
                    break

    return {
        "total_seen": total_seen,
        "total_inserted": total_inserted,
        "errors": errors[:50],
    }
