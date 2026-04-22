from __future__ import annotations

import logging
import time
import uuid
from typing import List

from fastapi import FastAPI, HTTPException, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from config import load_config
from models import (
    CompletedRequest,
    CompletedResponse,
    DeleteAnnotationsRequest,
    FieldsResponse,
    SearchRequest,
    SearchResponse,
    UpsertAnnotationsRequest,
    UpsertFieldsRequest,
)
from store import AnalyticsStore

cfg = load_config()
store = AnalyticsStore(cfg.analytics_db, cfg.analytics_dbs)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("column_storage")

app = FastAPI(title="AVSP Column Storage")

REQ_TOTAL = Counter(
    "avsp_column_storage_http_requests_total",
    "Total HTTP requests",
    ["method", "path", "status"],
)
REQ_LATENCY = Histogram(
    "avsp_column_storage_http_request_duration_seconds",
    "HTTP request latency",
    ["method", "path"],
)


@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    started = time.time()
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    path = request.url.path
    method = request.method
    try:
        response = await call_next(request)
    except Exception as exc:  # noqa: BLE001
        REQ_TOTAL.labels(method=method, path=path, status="500").inc()
        REQ_LATENCY.labels(method=method, path=path).observe(time.time() - started)
        logger.exception("request_failed path=%s request_id=%s", path, request_id)
        raise exc
    response.headers["X-Request-ID"] = request_id
    REQ_TOTAL.labels(method=method, path=path, status=str(response.status_code)).inc()
    REQ_LATENCY.labels(method=method, path=path).observe(time.time() - started)
    return response


@app.get("/health")
def health() -> dict:
    store.health()
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict:
    store.health()
    return {"status": "ok"}


@app.get("/metrics")
def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/fields", response_model=FieldsResponse)
def get_fields(field_names: str = "") -> FieldsResponse:
    names = [item.strip() for item in field_names.split(",") if item.strip()] if field_names else []
    return FieldsResponse(fields=store.get_fields(names))


@app.post("/fields", response_model=FieldsResponse)
def upsert_fields(payload: UpsertFieldsRequest) -> FieldsResponse:
    store.upsert_fields(
        payload.fields,
        replace_missing=payload.replace_missing,
        purge_deleted_values=payload.purge_deleted_values,
    )
    return FieldsResponse(fields=store.get_fields([]))


@app.post("/annotations/upsert")
def upsert_annotations(payload: UpsertAnnotationsRequest) -> dict:
    store.upsert_annotations(payload.rows)
    return {"upserted": len(payload.rows)}


@app.post("/annotations/delete")
def delete_annotations(payload: DeleteAnnotationsRequest) -> dict:
    requested = store.delete_annotations(payload.object_ids)
    return {"requested": requested}


@app.post("/annotations/clear")
def clear_annotations() -> dict:
    deleted = store.clear_annotations()
    return {"status": "cleared", "deleted_rows": deleted}


@app.post("/annotations/completed-object-ids", response_model=CompletedResponse)
def completed_object_ids(payload: CompletedRequest) -> CompletedResponse:
    ids = store.completed_object_ids(payload.object_ids, payload.field_names)
    return CompletedResponse(object_ids=ids)


@app.post("/search", response_model=SearchResponse)
def search(payload: SearchRequest) -> SearchResponse:
    if payload.limit <= 0:
        raise HTTPException(status_code=400, detail="limit must be positive")
    return SearchResponse(results=store.search(payload.filters, payload.limit))


# Backward compatible aliases
@app.get("/vlm/fields", response_model=FieldsResponse)
def vlm_get_fields(field_names: str = "") -> FieldsResponse:
    return get_fields(field_names)


@app.post("/vlm/fields", response_model=FieldsResponse)
def vlm_upsert_fields(payload: UpsertFieldsRequest) -> FieldsResponse:
    return upsert_fields(payload)


@app.post("/vlm/annotations/upsert")
def vlm_upsert_annotations(payload: UpsertAnnotationsRequest) -> dict:
    return upsert_annotations(payload)


@app.post("/vlm/annotations/delete")
def vlm_delete_annotations(payload: DeleteAnnotationsRequest) -> dict:
    return delete_annotations(payload)


@app.post("/vlm/annotations/clear")
def vlm_clear_annotations() -> dict:
    return clear_annotations()


@app.post("/vlm/annotations/completed-object-ids", response_model=CompletedResponse)
def vlm_completed_object_ids(payload: CompletedRequest) -> CompletedResponse:
    return completed_object_ids(payload)


@app.post("/vlm/search", response_model=SearchResponse)
def vlm_search(payload: SearchRequest) -> SearchResponse:
    return search(payload)
