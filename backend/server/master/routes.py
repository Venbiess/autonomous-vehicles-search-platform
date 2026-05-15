import time
from typing import Any, Callable, Dict, List

import httpx
from fastapi import HTTPException, Request


def healthcheck(*, model_gateway: Any) -> Dict[str, Any]:
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


def get_jobs(*, jobs_lock: Any, jobs_store: Dict[str, Dict[str, Any]], tail_lines: int) -> Dict[str, Any]:
    with jobs_lock:
        jobs = []
        for raw_job in jobs_store.values():
            job = dict(raw_job)
            job_log = raw_job.get("job_log")
            if isinstance(job_log, list):
                if len(job_log) > tail_lines:
                    job["job_log"] = job_log[-tail_lines:]
                    job["job_log_truncated"] = True
                else:
                    job["job_log"] = list(job_log)
                    job["job_log_truncated"] = False
            jobs.append(job)
    jobs.sort(key=lambda item: item.get("created_at", 0), reverse=True)
    return {"jobs": jobs}


def embeddings_dimensions(
    *,
    search_dependencies_ready: Callable[..., tuple[bool, str]],
    embedder_timeout_sec: int,
    embed_text: Callable[[httpx.Client, str], tuple[List[float], int]],
    sample_existing_embedding_dim: Callable[[], Any],
) -> Dict[str, Any]:
    ready, reason = search_dependencies_ready(
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

    timeout = httpx.Timeout(embedder_timeout_sec)
    with httpx.Client(timeout=timeout) as client:
        query_embedding, _ = embed_text(client, "embedding-dimension-check")
    query_dim = len(query_embedding)
    stored_dim = sample_existing_embedding_dim()
    mismatch = bool(stored_dim is not None and stored_dim > 0 and query_dim > 0 and int(stored_dim) != int(query_dim))
    return {
        "status": "ok",
        "query_dim": query_dim if query_dim > 0 else None,
        "stored_dim": int(stored_dim) if stored_dim is not None and stored_dim > 0 else None,
        "mismatch": mismatch,
    }


def install_datasets(
    payload: Any,
    *,
    storage_api: Any,
    start_dataset_install_job: Callable[[str, Dict[str, Any]], str],
) -> Dict[str, Any]:
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
        job_id = start_dataset_install_job(dataset_key, payload.configs.get(dataset_key, {}))
        jobs.append(
            {
                "dataset": dataset_key,
                "job_id": job_id,
                "status": "started",
            }
        )
    return {"jobs": jobs}


def start_waymo_auth(
    *,
    waymo_auth_lock: Any,
    is_waymo_auth_process_alive_locked: Callable[[], bool],
    waymo_auth_session: Dict[str, Any],
    start_waymo_auth_session: Callable[[], Dict[str, Any]],
) -> Dict[str, Any]:
    with waymo_auth_lock:
        alive = is_waymo_auth_process_alive_locked()
        if alive:
            return {
                "session_id": waymo_auth_session.get("session_id"),
                "auth_url": waymo_auth_session.get("auth_url"),
                "awaiting_code": bool(waymo_auth_session.get("awaiting_code", False)),
                "status": "running",
            }

    created = start_waymo_auth_session()
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


def waymo_auth_status() -> Dict[str, Any]:
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


def complete_waymo_auth(
    payload: Any,
    *,
    waymo_auth_lock: Any,
    waymo_auth_session: Dict[str, Any],
) -> Dict[str, Any]:
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


def search_text(
    payload: Any,
    *,
    logger: Any,
    search_dependencies_ready: Callable[..., tuple[bool, str]],
    build_search_backend_unavailable_warning: Callable[[str, str], Dict[str, Any]],
    embedder_timeout_sec: int,
    embed_text: Callable[[httpx.Client, str], tuple[List[float], int]],
    storage_api: Any,
    is_storage_query_unavailable_error: Callable[[Exception], bool],
    build_embedding_dim_warning: Callable[[List[float], str], Any],
    raise_upstream_http_error: Callable[[httpx.HTTPStatusError], None],
) -> Dict[str, Any]:
    warning = None
    total_matching_count = None
    total_matching_min_similarity = None
    try:
        ready, reason = search_dependencies_ready(
            require_embedder=True,
            require_vlm=False,
            allow_embedder_http_fallback=True,
        )
        if not ready:
            logger.warning("search_text dependencies unavailable; returning empty results: %s", reason)
            return {
                "mode": "vector_server",
                "results": [],
                "warning": build_search_backend_unavailable_warning(reason, source="text"),
            }

        timeout = httpx.Timeout(embedder_timeout_sec)
        started_at = time.perf_counter()
        with httpx.Client(timeout=timeout) as client:
            embed_started_at = time.perf_counter()
            query_embedding, _ = embed_text(client, payload.query)
            embed_elapsed_ms = (time.perf_counter() - embed_started_at) * 1000
        query_started_at = time.perf_counter()
        try:
            results = storage_api.query_vectors(query_embedding, payload.top_k)
        except Exception as exc:
            if not is_storage_query_unavailable_error(exc):
                raise
            logger.warning("search_text storage unavailable; returning empty results: %s", str(exc))
            results = []
        if payload.count_min_similarity is not None:
            try:
                total_matching_count = storage_api.count_vectors_above_similarity(
                    query_embedding, float(payload.count_min_similarity)
                )
                total_matching_min_similarity = float(payload.count_min_similarity)
            except Exception as exc:
                logger.warning("search_text count_min_similarity failed; skipping total count: %s", str(exc))
        warning = build_embedding_dim_warning(query_embedding, source="text") if not results else None
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
        raise_upstream_http_error(exc)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    payload = {
        "mode": "vector_server",
        "results": results,
    }
    if warning is not None:
        payload["warning"] = warning
    if total_matching_count is not None and total_matching_min_similarity is not None:
        payload["total_matching_count"] = int(total_matching_count)
        payload["total_matching_min_similarity"] = float(total_matching_min_similarity)
    return payload


async def search_image_bytes(
    request: Request,
    *,
    top_k: int,
    count_min_similarity: float | None = None,
    logger: Any,
    search_dependencies_ready: Callable[..., tuple[bool, str]],
    build_search_backend_unavailable_warning: Callable[[str, str], Dict[str, Any]],
    embedder_timeout_sec: int,
    embed_image: Callable[[httpx.Client, bytes], tuple[List[float], int]],
    storage_api: Any,
    is_storage_query_unavailable_error: Callable[[Exception], bool],
    build_embedding_dim_warning: Callable[[List[float], str], Any],
    raise_upstream_http_error: Callable[[httpx.HTTPStatusError], None],
) -> Dict[str, Any]:
    warning = None
    total_matching_count = None
    total_matching_min_similarity = None
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image bytes are required")

    try:
        ready, reason = search_dependencies_ready(
            require_embedder=True,
            require_vlm=False,
            allow_embedder_http_fallback=True,
        )
        if not ready:
            logger.warning("search_image_bytes dependencies unavailable; returning empty results: %s", reason)
            return {
                "mode": "vector_server",
                "results": [],
                "warning": build_search_backend_unavailable_warning(reason, source="image"),
            }

        timeout = httpx.Timeout(embedder_timeout_sec)
        started_at = time.perf_counter()
        with httpx.Client(timeout=timeout) as client:
            embed_started_at = time.perf_counter()
            query_embedding, _ = embed_image(client, image_bytes)
            embed_elapsed_ms = (time.perf_counter() - embed_started_at) * 1000
        query_started_at = time.perf_counter()
        try:
            results = storage_api.query_vectors(query_embedding, max(1, top_k))
        except Exception as exc:
            if not is_storage_query_unavailable_error(exc):
                raise
            logger.warning("search_image_bytes storage unavailable; returning empty results: %s", str(exc))
            results = []
        if count_min_similarity is not None:
            try:
                total_matching_count = storage_api.count_vectors_above_similarity(
                    query_embedding, float(count_min_similarity)
                )
                total_matching_min_similarity = float(count_min_similarity)
            except Exception as exc:
                logger.warning("search_image_bytes count_min_similarity failed; skipping total count: %s", str(exc))
        warning = build_embedding_dim_warning(query_embedding, source="image") if not results else None
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
        raise_upstream_http_error(exc)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    payload = {
        "mode": "vector_server",
        "results": results,
    }
    if warning is not None:
        payload["warning"] = warning
    if total_matching_count is not None and total_matching_min_similarity is not None:
        payload["total_matching_count"] = int(total_matching_count)
        payload["total_matching_min_similarity"] = float(total_matching_min_similarity)
    return payload


def upsert_vlm_fields(payload: Any, *, analytics_api: Any, normalize_vlm_fields: Callable[[Any], List[Dict[str, str]]]) -> Dict[str, Any]:
    try:
        normalized_fields = normalize_vlm_fields(payload.fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    fields = analytics_api.upsert_fields(
        normalized_fields,
        replace_missing=payload.replace_missing,
        purge_deleted_values=payload.purge_deleted_values,
    )
    return {"fields": fields}


def upsert_vlm_annotations(payload: Any, *, analytics_api: Any) -> Dict[str, Any]:
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


def cancel_job(payload: Any, *, jobs_lock: Any, jobs_store: Dict[str, Dict[str, Any]], job_status_running: str) -> Dict[str, Any]:
    with jobs_lock:
        job = jobs_store.get(payload.job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job["status"] != job_status_running:
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


def search_vlm(
    payload: Any,
    *,
    normalize_field_name: Callable[[str], str],
    normalize_match_mode: Callable[[str], str],
    list_recent_vlm_annotations: Callable[[int], List[Dict[str, Any]]],
    validate_existing_vlm_fields: Callable[[List[str]], List[Dict[str, str]]],
    analytics_api: Any,
) -> Dict[str, Any]:
    try:
        normalized_filters = [
            {
                "field_name": normalize_field_name(item.field_name),
                "value": item.value.strip(),
                "match_mode": normalize_match_mode(item.match_mode),
            }
            for item in payload.filters
            if item.value.strip()
        ]
        normalized_display_field_names = [
            normalize_field_name(name)
            for name in getattr(payload, "field_names", [])
            if str(name).strip()
        ]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not normalized_filters:
        return {"results": list_recent_vlm_annotations(payload.limit)}
    validate_existing_vlm_fields([item["field_name"] for item in normalized_filters])
    if normalized_display_field_names:
        validate_existing_vlm_fields(normalized_display_field_names)

    results = analytics_api.search(normalized_filters, payload.limit)
    if not normalized_display_field_names or not results:
        return {"results": results}

    object_ids = [str(item.get("object_id", "")).strip() for item in results if str(item.get("object_id", "")).strip()]
    if not object_ids:
        return {"results": results}

    rows = analytics_api.get_annotations(object_ids)
    values_by_object_id: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        object_id = str(row.get("object_id", "")).strip()
        values = row.get("values", {})
        if not object_id or not isinstance(values, dict):
            continue
        values_by_object_id[object_id] = values

    for item in results:
        object_id = str(item.get("object_id", "")).strip()
        row_values = values_by_object_id.get(object_id, {})
        merged_attrs: Dict[str, Any] = {}
        for field_name in normalized_display_field_names:
            merged_attrs[field_name] = str(row_values.get(field_name, ""))
        item["attributes"] = merged_attrs

    return {"results": results}


def delete_object(object_id: str, *, storage_api: Any, analytics_api: Any) -> Dict[str, Any]:
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
