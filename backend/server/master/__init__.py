import subprocess
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import Request

from backend.server.dataset_visibility import load_hidden_datasets
from configs.common import (
    EMBEDDER_ENDPOINT,
    EMBEDDER_TIMEOUT_SEC,
    MODEL_BACKEND_READY_POLL_SEC,
    MODEL_BACKEND_READY_WAIT_SEC,
    VLM_ENDPOINT,
)
from configs.hw_settings import EMBEDDER_CONFIG, VLM_CONFIG

from . import embedder as master_embedder
from . import job_support as master_job_support
from . import jobs as master_jobs
from . import object_listing as master_object_listing
from . import routes as master_routes
from . import system as master_system
from . import vlm as master_vlm
from . import waymo_auth as master_waymo_auth
from .models import (
    AnnotationRowRequest,
    AnnotationRowsRequest,
    BackfillRequest,
    CancelJobRequest,
    DatasetInstallRequest,
    EmbedResult,
    JobStatus,
    ObjectIDsRequest,
    RetryJobRequest,
    TextSearchRequest,
    VLMBackfillRequest,
    VLMFieldDefinition,
    VLMFieldsRequest,
    VLMFilterDefinition,
    VLMSearchRequest,
    WaymoAuthCompleteRequest,
)
from .state import (
    JOBS_JOB_LOG_TAIL_LINES,
    JOB_LOG_DIR,
    analytics_api,
    app,
    jobs_lock,
    jobs_store,
    logger,
    model_gateway,
    storage_api,
)

WAYMO_AUTH_MAX_LOG_LINES = master_waymo_auth.WAYMO_AUTH_MAX_LOG_LINES
waymo_auth_lock = master_waymo_auth.waymo_auth_lock
waymo_auth_session = master_waymo_auth.waymo_auth_session

_extract_first_url = master_waymo_auth.extract_first_url
_is_waymo_auth_process_alive_locked = master_waymo_auth.is_process_alive_locked
_append_waymo_auth_log_locked = master_waymo_auth.append_log_locked
_waymo_auth_reader = master_waymo_auth.auth_reader
_start_waymo_auth_session = master_waymo_auth.start_session

_normalize_field_name = master_vlm.normalize_field_name
_normalize_response_type = master_vlm.normalize_response_type
_normalize_match_mode = master_vlm.normalize_match_mode
_normalize_vlm_fields = master_vlm.normalize_vlm_fields
_build_vlm_prompt = master_vlm.build_vlm_prompt
_normalize_vlm_response = master_vlm.normalize_vlm_response

_to_bool = master_job_support.to_bool
_normalize_job_config = master_job_support.normalize_job_config
_raise_upstream_http_error = master_embedder.raise_upstream_http_error
_is_storage_query_unavailable_error = master_embedder.is_storage_query_unavailable_error
_job_cancel_requested = master_job_support.job_cancel_requested
_job_install_cleanup_mode = master_job_support.job_install_cleanup_mode
_chunk_object_ids = master_job_support.chunk_object_ids
_append_job_log = master_job_support.append_job_log
_current_model_health_text = master_job_support.current_model_health_text
_build_error_item = master_job_support.build_error_item
_embed_install_queue_worker = master_job_support.embed_install_queue_worker

_run_backfill_job = master_jobs.run_backfill_job
_run_vlm_backfill_job = master_jobs.run_vlm_backfill_job
_run_dataset_install_job = master_jobs.run_dataset_install_job
_start_backfill_embeddings_job = master_jobs.start_backfill_embeddings_job
_start_vlm_backfill_job = master_jobs.start_vlm_backfill_job
_start_dataset_install_job = master_jobs.start_dataset_install_job
_retry_job_from_failed = master_jobs.retry_job_from_failed

_to_float = master_system.to_float
_to_int = master_system.to_int
_collect_nvidia_info = master_system.collect_nvidia_info

_embed_image = lambda client, image_bytes: model_gateway.embed_image(client, EMBEDDER_ENDPOINT, image_bytes)
_embed_text = lambda client, text: model_gateway.embed_text(client, EMBEDDER_ENDPOINT, text)
_embed_images = lambda client, images_bytes: model_gateway.embed_images(client, EMBEDDER_ENDPOINT, images_bytes)
_embed_image_direct = lambda client, image_bytes: model_gateway.embed_image_http(client, EMBEDDER_ENDPOINT, image_bytes)
_embed_text_direct = lambda client, text: model_gateway.embed_text_http(client, EMBEDDER_ENDPOINT, text)
_run_vlm = lambda client, image_bytes, prompt, max_new_tokens, job_id=None, task_index=None, task_total=None, field_name=None, object_id=None: model_gateway.run_vlm(
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
_run_vlm_batch = lambda client, items, max_new_tokens: model_gateway.run_vlm_batch(
    client,
    items=items,
    max_new_tokens=max_new_tokens,
)


def _validate_existing_vlm_fields(field_names: List[str]) -> List[Dict[str, str]]:
    return master_vlm.validate_existing_vlm_fields(field_names, get_fields=analytics_api.get_fields)


def _upsert_vlm_annotations(rows: List[Dict[str, Any]]) -> int:
    return master_vlm.upsert_vlm_annotations(rows, upsert_annotations=analytics_api.upsert_annotations)


def _filter_pending_vlm_object_ids(
    object_ids: List[str],
    field_names: List[str],
    overwrite_existing: bool,
) -> List[str]:
    return master_vlm.filter_pending_vlm_object_ids(
        object_ids,
        field_names,
        overwrite_existing,
        completed_object_ids=analytics_api.completed_object_ids,
        logger=logger,
    )


def _list_object_ids(limit: int, page_size: int = 500, dataset: Optional[str] = None) -> List[str]:
    return master_object_listing.list_object_ids(storage_api, limit, page_size, dataset)


def _list_pending_vlm_object_ids(
    limit: int,
    field_names: List[str],
    overwrite_existing: bool,
    page_size: int = 500,
    dataset: Optional[str] = None,
) -> List[str]:
    return master_vlm.list_pending_vlm_object_ids(
        limit,
        field_names,
        overwrite_existing,
        list_object_ids=_list_object_ids,
        list_objects=storage_api.list_objects,
        completed_object_ids=analytics_api.completed_object_ids,
        load_hidden_datasets=load_hidden_datasets,
        logger=logger,
        page_size=page_size,
        dataset=dataset,
    )


def _list_recent_vlm_annotations(limit: int, page_size: int = 500) -> List[Dict[str, Any]]:
    return master_object_listing.list_recent_vlm_annotations(storage_api, analytics_api, limit, page_size)


def _filter_pending_embedding_object_ids(object_ids: List[str]) -> List[str]:
    return master_object_listing.filter_pending_embedding_object_ids(storage_api, object_ids)


def _list_pending_embedding_object_ids(
    limit: int,
    page_size: int = 500,
    dataset: Optional[str] = None,
) -> List[str]:
    return master_object_listing.list_pending_embedding_object_ids(storage_api, limit, page_size, dataset)


def _storage_vector_upsert_batch(rows: List[EmbedResult]) -> int:
    return master_embedder.storage_vector_upsert_batch(rows, upsert_vectors=storage_api.upsert_vectors)


def _search_dependencies_ready(
    *,
    require_embedder: bool = True,
    require_vlm: bool = True,
    allow_embedder_http_fallback: bool = False,
) -> tuple[bool, str]:
    return master_embedder.search_dependencies_ready(
        model_gateway=model_gateway,
        storage_api=storage_api,
        embedder_endpoint=EMBEDDER_ENDPOINT,
        embedder_timeout_sec=EMBEDDER_TIMEOUT_SEC,
        model_backend_ready_wait_sec=MODEL_BACKEND_READY_WAIT_SEC,
        model_backend_ready_poll_sec=MODEL_BACKEND_READY_POLL_SEC,
        require_embedder=require_embedder,
        require_vlm=require_vlm,
        allow_embedder_http_fallback=allow_embedder_http_fallback,
    )


def _search_dependencies_ready_for_routes(
    *,
    require_embedder: bool = True,
    require_vlm: bool = True,
    allow_embedder_http_fallback: bool = False,
) -> tuple[bool, str]:
    try:
        return _search_dependencies_ready(
            require_embedder=require_embedder,
            require_vlm=require_vlm,
            allow_embedder_http_fallback=allow_embedder_http_fallback,
        )
    except TypeError as exc:
        message = str(exc)
        if "unexpected keyword argument" not in message and "positional arguments" not in message:
            raise
        return _search_dependencies_ready()


def _mark_job_cancelled(
    job_id: str,
    total_seen: int,
    total_inserted: int,
    errors: List[Dict[str, str]],
    extra_updates: Optional[Dict[str, Any]] = None,
) -> None:
    master_job_support.mark_job_cancelled(
        job_id,
        total_seen,
        total_inserted,
        errors,
        extra_updates=extra_updates,
    )


def _record_job_error(
    job_id: str,
    errors: List[Dict[str, str]],
    error_item: Dict[str, str],
    *,
    log_message: Optional[str] = None,
) -> None:
    master_job_support.record_job_error(job_id, errors, error_item, log_message=log_message)


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
    return master_system.fetch_model_runtime(
        name,
        endpoint,
        timeout_sec,
        fallback_model=fallback_model,
        fallback_device=fallback_device,
        fallback_dtype=fallback_dtype,
        fallback_attn_type=fallback_attn_type,
    )


def _sample_existing_embedding_dim(max_objects_scan: int = 512) -> Optional[int]:
    return master_system.sample_existing_embedding_dim(storage_api, max_objects_scan)


def _build_embedding_dim_warning(query_embedding: List[float], source: str) -> Optional[Dict[str, Any]]:
    return master_system.build_embedding_dim_warning(
        query_embedding=query_embedding,
        source=source,
        storage_api=storage_api,
        logger=logger,
    )


def _build_search_backend_unavailable_warning(reason: str, source: str) -> Dict[str, Any]:
    return master_embedder.build_search_backend_unavailable_warning(reason, source)


@app.get("/health")
def healthcheck():
    return master_routes.healthcheck(model_gateway=model_gateway)


@app.get("/jobs")
def get_jobs():
    return master_routes.get_jobs(
        jobs_lock=jobs_lock,
        jobs_store=jobs_store,
        tail_lines=JOBS_JOB_LOG_TAIL_LINES,
    )


@app.get("/system-info")
def get_system_info():
    try:
        return master_system.build_system_info(
            embedder_endpoint=EMBEDDER_ENDPOINT,
            vlm_endpoint=VLM_ENDPOINT,
            embedder_config=EMBEDDER_CONFIG,
            vlm_config=VLM_CONFIG,
        )
    except Exception as exc:
        logger.error("Error getting system info: %s", exc)
        return {
            "error": str(exc),
            "cpu": {"usage_percent": 0, "cores": 0},
            "memory": {"total_gb": 0, "used_gb": 0, "available_gb": 0, "usage_percent": 0},
            "disk": {"total_gb": 0, "used_gb": 0, "available_gb": 0, "usage_percent": 0},
            "gpu": {"available": False, "driver_version": "", "cuda_version": "", "gpus": [], "error": str(exc)},
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
    return master_routes.embeddings_dimensions(
        search_dependencies_ready=_search_dependencies_ready_for_routes,
        embedder_timeout_sec=EMBEDDER_TIMEOUT_SEC,
        embed_text=_embed_text,
        sample_existing_embedding_dim=_sample_existing_embedding_dim,
    )


@app.post("/datasets/install")
def install_datasets(payload: DatasetInstallRequest):
    return master_routes.install_datasets(
        payload,
        storage_api=storage_api,
        start_dataset_install_job=_start_dataset_install_job,
    )


@app.post("/waymo/auth/start")
def start_waymo_auth():
    return master_routes.start_waymo_auth(
        waymo_auth_lock=waymo_auth_lock,
        is_waymo_auth_process_alive_locked=_is_waymo_auth_process_alive_locked,
        waymo_auth_session=waymo_auth_session,
        start_waymo_auth_session=_start_waymo_auth_session,
    )


@app.get("/waymo/auth/status")
def waymo_auth_status():
    return master_routes.waymo_auth_status()


@app.post("/waymo/auth/complete")
def complete_waymo_auth(payload: WaymoAuthCompleteRequest):
    return master_routes.complete_waymo_auth(
        payload,
        waymo_auth_lock=waymo_auth_lock,
        waymo_auth_session=waymo_auth_session,
    )


@app.post("/search/text")
def search_text(payload: TextSearchRequest):
    return master_routes.search_text(
        payload,
        logger=logger,
        search_dependencies_ready=_search_dependencies_ready_for_routes,
        build_search_backend_unavailable_warning=_build_search_backend_unavailable_warning,
        embedder_timeout_sec=EMBEDDER_TIMEOUT_SEC,
        embed_text=_embed_text,
        storage_api=storage_api,
        is_storage_query_unavailable_error=_is_storage_query_unavailable_error,
        build_embedding_dim_warning=_build_embedding_dim_warning,
        raise_upstream_http_error=_raise_upstream_http_error,
    )


@app.post("/search/image_bytes")
async def search_image_bytes(request: Request, top_k: int = 5, max_rows: int = 10000):
    del max_rows
    return await master_routes.search_image_bytes(
        request,
        top_k=top_k,
        logger=logger,
        search_dependencies_ready=_search_dependencies_ready_for_routes,
        build_search_backend_unavailable_warning=_build_search_backend_unavailable_warning,
        embedder_timeout_sec=EMBEDDER_TIMEOUT_SEC,
        embed_image=_embed_image,
        storage_api=storage_api,
        is_storage_query_unavailable_error=_is_storage_query_unavailable_error,
        build_embedding_dim_warning=_build_embedding_dim_warning,
        raise_upstream_http_error=_raise_upstream_http_error,
    )


@app.get("/vlm/fields")
def get_vlm_fields():
    return {"fields": analytics_api.get_fields()}


@app.post("/vlm/fields")
def upsert_vlm_fields(payload: VLMFieldsRequest):
    return master_routes.upsert_vlm_fields(
        payload,
        analytics_api=analytics_api,
        normalize_vlm_fields=_normalize_vlm_fields,
    )


@app.post("/vlm/backfill")
def backfill_vlm(payload: VLMBackfillRequest):
    job_id = _start_vlm_backfill_job(payload)
    return {"job_id": job_id, "status": "started"}


@app.post("/vlm/annotations/clear")
def clear_vlm_annotations():
    return analytics_api.clear_annotations()


@app.post("/vlm/annotations/upsert")
def upsert_vlm_annotations(payload: AnnotationRowsRequest):
    return master_routes.upsert_vlm_annotations(payload, analytics_api=analytics_api)


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
    return master_routes.cancel_job(
        payload,
        jobs_lock=jobs_lock,
        jobs_store=jobs_store,
        job_status_running=JobStatus.RUNNING.value,
    )


@app.post("/jobs/retry")
def retry_job(payload: RetryJobRequest):
    return _retry_job_from_failed(payload.job_id)


@app.post("/search/vlm")
def search_vlm(payload: VLMSearchRequest):
    return master_routes.search_vlm(
        payload,
        normalize_field_name=_normalize_field_name,
        normalize_match_mode=_normalize_match_mode,
        list_recent_vlm_annotations=_list_recent_vlm_annotations,
        validate_existing_vlm_fields=_validate_existing_vlm_fields,
        analytics_api=analytics_api,
    )


@app.delete("/objects/{object_id}")
def delete_object(object_id: str):
    return master_routes.delete_object(
        object_id,
        storage_api=storage_api,
        analytics_api=analytics_api,
    )
