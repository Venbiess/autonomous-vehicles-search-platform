import os
import queue
import threading
import time
import traceback
import uuid
from typing import Any, Dict

import httpx
from fastapi import HTTPException
from configs.common import (
    VLM_BACKFILL_FIELD_CHUNK_SIZE as DEFAULT_VLM_BACKFILL_FIELD_CHUNK_SIZE,
    VLM_RETRY_EMPTY_VALUES as DEFAULT_VLM_RETRY_EMPTY_VALUES,
    VLM_TIMEOUT_SEC as DEFAULT_VLM_TIMEOUT_SEC,
)


def _master():
    import backend.server.master as master

    return master


def run_backfill_job(job_id: str, payload: Any) -> None:
    master = _master()

    job_config = master._normalize_job_config(payload)
    with master.jobs_lock:
        master.jobs_store[job_id] = {
            "job_id": job_id,
            "job_type": "backfill_embeddings",
            "job_config": job_config,
            "status": master.JobStatus.RUNNING.value,
            "cancel_requested": False,
            "install_cleanup_mode": "keep",
            "progress": 0,
            "total_seen": 0,
            "total_inserted": 0,
            "total_limit": payload.limit,
            "job_log": [],
            "job_log_path": str(master.JOB_LOG_DIR / f"{job_id}.log"),
            "errors": [],
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    total_seen = 0
    total_inserted = 0
    errors = []
    inserted_object_ids = []
    inserted_object_ids_seen = set()
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
        current_object_id: str | None = None,
    ) -> int:
        progress_value = min(int((seen_count / max(planned_total, 1)) * 100), 100)
        with master.jobs_lock:
            if job_id in master.jobs_store:
                payload_update: Dict[str, Any] = {
                    "progress": progress_value,
                    "total_seen": seen_count,
                    "total_inserted": inserted_count,
                    "errors": errors,
                    "updated_at": time.time(),
                }
                if current_object_id:
                    payload_update["current_object_id"] = current_object_id
                master.jobs_store[job_id].update(payload_update)
        return progress_value

    def _flush_rows(rows_buffer: list[Any]) -> bool:
        nonlocal total_inserted
        if not rows_buffer or payload.dry_run:
            rows_buffer.clear()
            return True
        try:
            upserted = master._storage_vector_upsert_batch(rows_buffer)
            total_inserted += upserted
            for row in rows_buffer[: max(0, upserted)]:
                if row.object_id not in inserted_object_ids_seen:
                    inserted_object_ids_seen.add(row.object_id)
                    inserted_object_ids.append(row.object_id)
            if upserted != len(rows_buffer):
                mismatch_error = f"vector upsert mismatch: expected={len(rows_buffer)} actual={upserted}"
                master._record_job_error(
                    job_id,
                    errors,
                    {"error": mismatch_error},
                    log_message=f"Backfill upsert mismatch: {mismatch_error}",
                )
                rows_buffer.clear()
                return False
            rows_buffer.clear()
            return True
        except Exception as exc:
            master.logger.exception("Batch vector upsert failed for rows=%s", len(rows_buffer))
            master._record_job_error(
                job_id,
                errors,
                {"error": str(exc)},
                log_message=f"Backfill upsert error: {exc}",
            )
            rows_buffer.clear()
            return False

    def _cancel_backfill_job() -> None:
        cleanup_mode = master._job_install_cleanup_mode(job_id)
        cleanup_removed = 0
        cancel_errors = list(errors)
        if cleanup_mode == "delete":
            for chunk in master._chunk_object_ids(inserted_object_ids):
                try:
                    cleanup_removed += master.storage_api.delete_vectors(chunk)
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
        master._mark_job_cancelled(
            job_id,
            total_seen,
            max(0, total_inserted - cleanup_removed),
            cancel_errors,
        )
        with master.jobs_lock:
            job = master.jobs_store.get(job_id)
            if job:
                master._append_job_log(
                    job,
                    f"Cancelled (cleanup_mode={cleanup_mode}, removed_embeddings={cleanup_removed}/{len(inserted_object_ids)})",
                )

    try:
        ready, reason = master._search_dependencies_ready(require_embedder=True, require_vlm=False)
        if not ready:
            with master.jobs_lock:
                if job_id in master.jobs_store:
                    master.jobs_store[job_id].update(
                        {
                            "status": master.JobStatus.ERROR.value,
                            "errors": [{"error": reason}],
                            "updated_at": time.time(),
                        }
                    )
                    master._append_job_log(master.jobs_store[job_id], f"Failed preflight: {reason}")
            return

        hidden_datasets = sorted({name for name in master.load_hidden_datasets() if str(name).strip()})
        master.logger.info(
            "Backfill embeddings job %s started: limit=%s batch_size=%s dry_run=%s dataset=%s",
            job_id,
            payload.limit,
            payload.batch_size,
            payload.dry_run,
            str(payload.dataset or "").strip() or "all",
        )
        with master.jobs_lock:
            job = master.jobs_store.get(job_id)
            if job:
                master._append_job_log(
                    job,
                    "Backfill embeddings started: "
                    f"limit={payload.limit}, batch_size={payload.batch_size}, dry_run={payload.dry_run}, "
                    f"dataset={str(payload.dataset or '').strip() or 'all'}",
                )
                master._append_job_log(
                    job,
                    "Dataset visibility: "
                    + (f"hidden={','.join(hidden_datasets)}" if hidden_datasets else "hidden=<none>"),
                )
        timeout = httpx.Timeout(master.EMBEDDER_TIMEOUT_SEC)

        object_ids = master._list_pending_embedding_object_ids(payload.limit, dataset=payload.dataset)
        planned_total = len(object_ids)
        with master.jobs_lock:
            if job_id in master.jobs_store:
                master.jobs_store[job_id]["total_limit"] = planned_total
                master.jobs_store[job_id]["updated_at"] = time.time()
                master._append_job_log(
                    master.jobs_store[job_id],
                    f"Pending objects selected: {planned_total} (requested limit={payload.limit}, dataset={str(payload.dataset or '').strip() or 'all'})",
                )
        master.logger.info(
            "Backfill embeddings job %s pending objects=%s (requested limit=%s, dataset=%s)",
            job_id,
            planned_total,
            payload.limit,
            str(payload.dataset or "").strip() or "all",
        )
        with httpx.Client(timeout=timeout) as client:
            for i in range(0, len(object_ids), payload.batch_size):
                if master._job_cancel_requested(job_id):
                    _cancel_backfill_job()
                    return
                batch_ids = object_ids[i : i + payload.batch_size]
                rows = []
                processed_in_batch = 0
                batch_payload = master.storage_api.get_object_bytes_batch(batch_ids)
                by_object_id = {item.get("object_id"): item for item in batch_payload if item.get("object_id")}
                valid_ids = []
                valid_images = []

                for object_id in batch_ids:
                    if master._job_cancel_requested(job_id):
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
                    except Exception as exc:
                        master.logger.exception("Embedding failed for object_id=%s", object_id)
                        error_item = master._build_error_item(exc, object_id)
                        timeout_note = f" | model_health={error_item['model_health']}" if error_item.get("model_health") else ""
                        master._record_job_error(
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

                if valid_images and not (payload.stop_on_error and errors):
                    if len(valid_ids) == 1:
                        object_id = valid_ids[0]
                        image_bytes = valid_images[0]
                        try:
                            embedding, dim = master._embed_image(client, image_bytes)
                            rows.append(master.EmbedResult(object_id=object_id, embedding=embedding, dim=dim))
                            processed_in_batch += 1
                            interim_seen = total_seen + processed_in_batch
                            _update_backfill_progress(interim_seen, total_inserted, current_object_id=object_id)
                            if len(rows) >= upsert_flush_size:
                                flushed_ok = _flush_rows(rows)
                                _update_backfill_progress(interim_seen, total_inserted, current_object_id=object_id)
                                if payload.stop_on_error and (not flushed_ok or errors):
                                    break
                        except Exception as exc:
                            master.logger.exception("Embedding failed for single object_id=%s", object_id)
                            error_item = master._build_error_item(exc, object_id)
                            timeout_note = f" | model_health={error_item['model_health']}" if error_item.get("model_health") else ""
                            master._record_job_error(
                                job_id,
                                errors,
                                error_item,
                                log_message=f"Embedding error: object_id={object_id} | {exc}{timeout_note}",
                            )
                            processed_in_batch += 1
                            interim_seen = total_seen + processed_in_batch
                            _update_backfill_progress(interim_seen, total_inserted, current_object_id=object_id)
                    else:
                        try:
                            embeddings, dim = master._embed_images(client, valid_images)
                            if len(embeddings) != len(valid_ids):
                                raise ValueError(
                                    f"batch embedding size mismatch: expected={len(valid_ids)} actual={len(embeddings)}"
                                )

                            for object_id, embedding in zip(valid_ids, embeddings):
                                rows.append(master.EmbedResult(object_id=object_id, embedding=embedding, dim=dim))
                                processed_in_batch += 1
                                interim_seen = total_seen + processed_in_batch
                                _update_backfill_progress(interim_seen, total_inserted, current_object_id=object_id)
                                if len(rows) >= upsert_flush_size:
                                    flushed_ok = _flush_rows(rows)
                                    _update_backfill_progress(interim_seen, total_inserted, current_object_id=object_id)
                                    if payload.stop_on_error and (not flushed_ok or errors):
                                        break
                        except Exception:
                            master.logger.exception(
                                "Batch embedding failed for batch_size=%s, falling back to per-item",
                                len(valid_ids),
                            )
                            for object_id, image_bytes in zip(valid_ids, valid_images):
                                if master._job_cancel_requested(job_id):
                                    _cancel_backfill_job()
                                    return
                                try:
                                    embedding, dim = master._embed_image(client, image_bytes)
                                    rows.append(master.EmbedResult(object_id=object_id, embedding=embedding, dim=dim))
                                    if len(rows) >= upsert_flush_size:
                                        flushed_ok = _flush_rows(rows)
                                        if payload.stop_on_error and (not flushed_ok or errors):
                                            break
                                except Exception as exc:
                                    master.logger.exception("Embedding fallback failed for object_id=%s", object_id)
                                    error_item = master._build_error_item(exc, object_id)
                                    timeout_note = f" | model_health={error_item['model_health']}" if error_item.get("model_health") else ""
                                    master._record_job_error(
                                        job_id,
                                        errors,
                                        error_item,
                                        log_message=f"Embedding fallback error: object_id={object_id} | {exc}{timeout_note}",
                                    )
                                finally:
                                    processed_in_batch += 1
                                    interim_seen = total_seen + processed_in_batch
                                    _update_backfill_progress(interim_seen, total_inserted, current_object_id=object_id)
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
                    with master.jobs_lock:
                        job = master.jobs_store.get(job_id)
                        if job:
                            master._append_job_log(
                                job,
                                f"Progress: {total_seen}/{planned_total} ({progress}%), embeddings_saved={total_inserted}, errors={len(errors)}",
                            )
                    last_progress_log_bucket = max(last_progress_log_bucket, current_bucket)
                    last_progress_log_at = now_mono
                if payload.stop_on_error and errors:
                    break

        final_status = master.JobStatus.SUCCESS if not errors else master.JobStatus.ERROR
        with master.jobs_lock:
            if job_id in master.jobs_store:
                master.jobs_store[job_id].update(
                    {
                        "status": final_status.value,
                        "progress": 100,
                        "total_seen": total_seen,
                        "total_inserted": total_inserted,
                        "errors": errors,
                        "updated_at": time.time(),
                    }
                )
                master._append_job_log(
                    master.jobs_store[job_id],
                    f"Finished with status={final_status.value}, processed={total_seen}/{planned_total}, embeddings_saved={total_inserted}, errors={len(errors)}",
                )
    except Exception as exc:
        master.logger.exception("Backfill embeddings job %s failed", job_id)
        with master.jobs_lock:
            if job_id in master.jobs_store:
                master.jobs_store[job_id].update(
                    {
                        "status": master.JobStatus.ERROR.value,
                        "errors": errors + [{"error": str(exc), "log": traceback.format_exc()}],
                        "updated_at": time.time(),
                    }
                )
                master._append_job_log(master.jobs_store[job_id], f"Failed: {exc}")


def run_vlm_backfill_job(job_id: str, payload: Any) -> None:
    master = _master()
    _normalize_job_config = master._normalize_job_config
    jobs_lock = master.jobs_lock
    jobs_store = master.jobs_store
    JOB_LOG_DIR = master.JOB_LOG_DIR
    JobStatus = master.JobStatus
    logger = master.logger
    load_hidden_datasets = master.load_hidden_datasets
    analytics_api = master.analytics_api
    _validate_existing_vlm_fields = master._validate_existing_vlm_fields
    _build_vlm_prompt = master._build_vlm_prompt
    _list_pending_vlm_object_ids = master._list_pending_vlm_object_ids
    _append_job_log = master._append_job_log
    _job_install_cleanup_mode = master._job_install_cleanup_mode
    _chunk_object_ids = master._chunk_object_ids
    _mark_job_cancelled = master._mark_job_cancelled
    _normalize_vlm_response = master._normalize_vlm_response
    _run_vlm = master._run_vlm
    _run_vlm_batch = master._run_vlm_batch
    _build_vlm_json_prompt = master._build_vlm_json_prompt
    _extract_first_json_object = master._extract_first_json_object
    _normalize_values_from_json_object = master._normalize_values_from_json_object
    _build_openai_response_format = master._build_openai_response_format
    _run_openai_batch_for_json_annotations = master._run_openai_batch_for_json_annotations
    _job_cancel_requested = master._job_cancel_requested
    _upsert_vlm_annotations = master._upsert_vlm_annotations
    vlm_timeout_raw = str(os.getenv("VLM_TIMEOUT_SEC", str(DEFAULT_VLM_TIMEOUT_SEC))).strip()
    try:
        vlm_timeout_sec = max(1.0, float(vlm_timeout_raw))
    except ValueError:
        vlm_timeout_sec = float(DEFAULT_VLM_TIMEOUT_SEC)
    retry_empty_values_default = bool(DEFAULT_VLM_RETRY_EMPTY_VALUES)
    field_chunk_size_default = int(DEFAULT_VLM_BACKFILL_FIELD_CHUNK_SIZE)

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
            "parse_warnings_total": 0,
            "parse_warnings_by_field": {},
            "parse_warnings_samples": [],
            "saved_full_annotations": 0,
            "saved_partial_annotations": 0,
            "job_log": [],
            "job_log_path": str(JOB_LOG_DIR / f"{job_id}.log"),
            "errors": [],
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    total_seen = 0
    total_inserted = 0
    errors = []
    parse_warnings_total = 0
    parse_warnings_by_field: Dict[str, int] = {}
    parse_warnings_samples = []
    saved_full_annotations = 0
    saved_partial_annotations = 0
    parse_warning_log_step = 50
    annotated_object_ids = []
    annotated_object_ids_seen = set()
    last_progress_log_bucket = -1
    last_progress_log_at = time.monotonic()
    partial_scene_parse_log_limit = 30
    retry_empty_values_raw = str(
        os.getenv("VLM_RETRY_EMPTY_VALUES", "1" if retry_empty_values_default else "0")
    ).strip().lower()
    retry_empty_values = retry_empty_values_raw not in {"0", "false", "no", "off"}
    field_chunk_size_raw = str(
        os.getenv("VLM_BACKFILL_FIELD_CHUNK_SIZE", str(field_chunk_size_default))
    ).strip()
    try:
        field_chunk_size_env = int(field_chunk_size_raw)
    except ValueError:
        field_chunk_size_env = int(field_chunk_size_default)
    field_chunk_size_override = max(1, field_chunk_size_env if field_chunk_size_env > 0 else int(payload.batch_size))

    try:
        timeout = httpx.Timeout(vlm_timeout_sec)
        dataset_filter = str(payload.dataset or "").strip()
        hidden_datasets = sorted({name for name in load_hidden_datasets() if str(name).strip()})

        if payload.field_names:
            fields = _validate_existing_vlm_fields(payload.field_names)
        else:
            fields = analytics_api.get_fields()
        if not fields:
            raise ValueError("No VLM fields configured")

        field_names = [field["field_name"] for field in fields]
        prepared_fields = [
            {
                "field_name": field["field_name"],
                "response_type": field["response_type"],
                "prompt": str(field["prompt"]).strip(),
                "single_prompt": _build_vlm_prompt(field["prompt"], field["response_type"]),
            }
            for field in fields
        ]
        field_total = len(prepared_fields)
        combine_fields_into_json = bool(getattr(payload, "combine_fields_into_json", False))
        use_openai_batch_api = bool(getattr(payload, "use_openai_batch_api", False))
        if use_openai_batch_api and not combine_fields_into_json:
            raise ValueError(
                "use_openai_batch_api=true requires combine_fields_into_json=true "
                "because batch mode expects one JSON response per scene."
            )
        openai_response_format = _build_openai_response_format(
            prepared_fields=prepared_fields,
            payload=payload,
        )
        if openai_response_format and not use_openai_batch_api:
            raise ValueError(
                "openai_use_json_schema/openai_json_schema requires use_openai_batch_api=true."
            )
        if openai_response_format and not combine_fields_into_json:
            raise ValueError(
                "openai_use_json_schema/openai_json_schema requires combine_fields_into_json=true."
            )
        combined_prompt_text = _build_vlm_json_prompt(
            prepared_fields,
            combined_prompt=getattr(payload, "combined_prompt", None),
        )
        task_total_per_scene = 1 if combine_fields_into_json else field_total
        expected_scene_tasks_completed = task_total_per_scene
        combined_json_max_new_tokens = min(
            512,
            max(int(payload.max_new_tokens), 64, field_total * 16),
        )
        object_ids = _list_pending_vlm_object_ids(
            payload.limit,
            field_names,
            payload.overwrite_existing,
            dataset=payload.dataset,
        )
        planned_total = len(object_ids)
        total_tasks_planned = len(object_ids) * task_total_per_scene
        completed_tasks = 0
        with jobs_lock:
            job = jobs_store.get(job_id)
            if job:
                _append_job_log(job, f"VLM backfill started: limit={payload.limit}, fields={len(field_names)}, dataset={dataset_filter or 'all'}, combine_fields_into_json={combine_fields_into_json}")
                _append_job_log(job, "Dataset visibility: " + (f"hidden={','.join(hidden_datasets)}" if hidden_datasets else "hidden=<none>"))
                _append_job_log(job, f"Objects selected: {planned_total} (dataset={dataset_filter or 'all'})")
                if openai_response_format:
                    schema_name = str(openai_response_format.get("json_schema", {}).get("name", "")).strip()
                    strict = bool(openai_response_format.get("json_schema", {}).get("strict", False))
                    _append_job_log(
                        job,
                        f"OpenAI structured output schema enabled: name={schema_name or 'vlm_annotation'}, strict={strict}",
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
                    {"error": f"Cancellation cleanup removed annotations for {cleanup_removed} / {len(annotated_object_ids)} objects"}
                )
            _mark_job_cancelled(
                job_id,
                total_seen,
                max(0, total_inserted - cleanup_removed),
                cancel_errors,
                extra_updates={"total_tasks_completed": completed_tasks, "total_tasks_planned": total_tasks_planned},
            )
            with jobs_lock:
                job = jobs_store.get(job_id)
                if job:
                    _append_job_log(job, f"Cancelled (cleanup_mode={cleanup_mode}, removed_annotations={cleanup_removed}/{len(annotated_object_ids)})")

        def _log_partial_scene_parse_details(entry: Dict[str, Any], reason: str) -> None:
            parse_items = entry.get("parse_failed_fields")
            if not isinstance(parse_items, list) or not parse_items:
                return
            object_id = str(entry.get("object_id") or "").strip()
            scene_index = int(entry.get("scene_index") or 0)
            with jobs_lock:
                job = jobs_store.get(job_id)
                if not job:
                    return
                _append_job_log(job, f"Partial scene parse details: object_id={object_id or '<unknown>'}, scene={scene_index}, reason={reason}, items={len(parse_items)}")
                for item in parse_items[:partial_scene_parse_log_limit]:
                    field_name = str(item.get("field_name") or "").strip() or "<unknown>"
                    response_type = str(item.get("response_type") or "").strip() or "<unknown>"
                    note = str(item.get("note") or "").strip() or "fallback"
                    raw_response = repr(str(item.get("raw_response") or ""))
                    normalized_value = repr(str(item.get("normalized_value") or ""))
                    _append_job_log(job, f"  parse_failed: field={field_name}, type={response_type}, note={note}, raw={raw_response[:260]}, normalized={normalized_value[:260]}")

        def _effective_max_new_tokens_for_response_type(response_type: str) -> int:
            base = int(payload.max_new_tokens)
            normalized_type = str(response_type or "").strip().lower()
            minimum = {"yes_no": 4, "number": 4, "category": 8, "short_text": 16, "text": 32}.get(normalized_type, 8)
            return max(base, minimum)

        def _normalize_with_retry_if_empty(*, client: httpx.Client, entry: Dict[str, Any], field: Dict[str, str], response_text: str, task_index: int, max_new_tokens: int):
            normalized_value, parsed_ok, parse_note = _normalize_vlm_response(response_text, field["response_type"])
            if str(normalized_value).strip() or not retry_empty_values:
                return normalized_value, parsed_ok, parse_note

            retry_prompt = f"{field['single_prompt']}\n\nImportant: previous answer was empty. Return a non-empty answer now and strictly follow the format requirement."
            retry_text = _run_vlm(
                client,
                entry["image_bytes"],
                retry_prompt,
                max_new_tokens,
                job_id=job_id,
                task_index=task_index,
                task_total=total_tasks_planned if total_tasks_planned > 0 else None,
                field_name=field["field_name"],
                object_id=entry["object_id"],
            )
            retry_value, retry_parsed_ok, retry_note = _normalize_vlm_response(retry_text, field["response_type"])
            if str(retry_value).strip():
                return retry_value, retry_parsed_ok, f"{retry_note or 'retry'}_after_empty"
            return retry_value, retry_parsed_ok, f"{retry_note or 'retry'}_still_empty"

        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update({"total_limit": planned_total, "total_tasks_planned": total_tasks_planned, "updated_at": time.time()})
                _append_job_log(
                    jobs_store[job_id],
                    f"Backfill VLM started: limit={payload.limit}, batch_size={payload.batch_size}, fields={len(field_names)}, dry_run={payload.dry_run}, overwrite_existing={payload.overwrite_existing}",
                )
                _append_job_log(
                    jobs_store[job_id],
                    f"Backfill VLM runtime options: retry_empty_values={retry_empty_values}, field_chunk_size={field_chunk_size_override}, base_max_new_tokens={payload.max_new_tokens}, use_openai_batch_api={bool(getattr(payload, 'use_openai_batch_api', False))}",
                )
                if combine_fields_into_json:
                    custom_prompt_set = bool(str(getattr(payload, "combined_prompt", "") or "").strip())
                    _append_job_log(
                        jobs_store[job_id],
                        f"Combined JSON mode enabled: custom_prompt={custom_prompt_set}, scene_tasks_total={task_total_per_scene}",
                    )
                _append_job_log(jobs_store[job_id], f"Pending scenes selected: {planned_total} (tasks_planned={total_tasks_planned})")

        with httpx.Client(timeout=timeout) as client:
            for i in range(0, len(object_ids), payload.batch_size):
                if _job_cancel_requested(job_id):
                    _cancel_vlm_job()
                    return
                batch_ids = object_ids[i : i + payload.batch_size]
                batch_payload = master.storage_api.get_object_bytes_batch(batch_ids)
                by_object_id = {item.get("object_id"): item for item in batch_payload if item.get("object_id")}
                batch_entries = []
                batch_base_seen = total_seen
                for local_index, object_id in enumerate(batch_ids):
                    if _job_cancel_requested(job_id):
                        _cancel_vlm_job()
                        return
                    scene_index = batch_base_seen + local_index + 1
                    try:
                        batch_item = by_object_id.get(object_id)
                        if not batch_item:
                            raise ValueError("object not returned in batch response")
                        if batch_item.get("error"):
                            raise ValueError(str(batch_item.get("error")))
                        image_bytes = batch_item.get("content", b"")
                        if not image_bytes:
                            raise ValueError("empty content")
                        batch_entries.append({"object_id": object_id, "image_bytes": image_bytes, "scene_index": scene_index, "values": {}, "scene_tasks_completed": 0, "parse_failed_fields": [], "failed": False})
                    except Exception as exc:
                        logger.exception("VLM failed for object_id=%s", object_id)
                        errors.append({"object_id": object_id, "error": str(exc)})
                        total_seen += 1
                        progress = min(int((total_seen / max(len(object_ids), 1)) * 100), 100)
                        with jobs_lock:
                            if job_id in jobs_store:
                                jobs_store[job_id].update({"progress": progress, "total_seen": total_seen, "total_inserted": total_inserted, "total_tasks_completed": completed_tasks, "total_tasks_planned": total_tasks_planned, "current_scene_index": scene_index, "current_scene_tasks_completed": 0, "current_scene_tasks_total": task_total_per_scene, "errors": errors, "field_names": field_names, "updated_at": time.time()})
                        if payload.stop_on_error:
                            break
                if payload.stop_on_error and errors:
                    break

                batch_openai_outputs: Dict[str, str] = {}
                batch_openai_errors: Dict[str, str] = {}
                if combine_fields_into_json and use_openai_batch_api and batch_entries:
                    last_batch_progress_update_at = 0.0

                    def _on_openai_batch_progress(event: Dict[str, Any]) -> None:
                        nonlocal last_batch_progress_update_at
                        now_mono = time.monotonic()
                        status_value = str(event.get("status", "")).strip().lower()
                        is_final_status = status_value in {"completed", "failed", "expired", "cancelled"}
                        if (now_mono - last_batch_progress_update_at) < 5.0 and not is_final_status:
                            return
                        batch_entries_total_local = max(
                            1,
                            int(event.get("batch_entries_total", len(batch_entries)) or len(batch_entries)),
                        )
                        batch_entries_done_estimate = max(
                            0,
                            min(
                                int(event.get("batch_entries_completed_estimate", 0) or 0),
                                batch_entries_total_local,
                            ),
                        )
                        estimated_total_seen = min(planned_total, batch_base_seen + batch_entries_done_estimate)
                        estimated_progress = min(int((estimated_total_seen / max(planned_total, 1)) * 100), 100)
                        with jobs_lock:
                            if job_id in jobs_store:
                                current_progress = int(jobs_store[job_id].get("progress", 0) or 0)
                                jobs_store[job_id].update(
                                    {
                                        "progress": max(current_progress, estimated_progress),
                                        "current_scene_index": min(estimated_total_seen + 1, planned_total) if planned_total > 0 else 0,
                                        "current_scene_tasks_completed": batch_entries_done_estimate,
                                        "current_scene_tasks_total": batch_entries_total_local,
                                        "updated_at": time.time(),
                                    }
                                )
                        last_batch_progress_update_at = now_mono

                    try:
                        (
                            batch_openai_outputs,
                            batch_openai_errors,
                            created_batch_ids,
                        ) = _run_openai_batch_for_json_annotations(
                            entries=batch_entries,
                            combined_prompt_text=combined_prompt_text,
                            max_new_tokens=combined_json_max_new_tokens,
                            job_id=job_id,
                            response_format=openai_response_format,
                            progress_callback=_on_openai_batch_progress,
                            logger=logger,
                        )
                        if created_batch_ids:
                            with jobs_lock:
                                job = jobs_store.get(job_id)
                                if job:
                                    _append_job_log(
                                        job,
                                        (
                                            "OpenAI batch chunks completed: "
                                            f"count={len(created_batch_ids)}, "
                                            f"ids={','.join(created_batch_ids[:5])}"
                                            + ("..." if len(created_batch_ids) > 5 else "")
                                        ),
                                    )
                    except Exception as exc:
                        logger.exception(
                            "OpenAI batch JSON mode failed for job_id=%s batch_start=%s",
                            job_id,
                            i,
                        )
                        for entry in batch_entries:
                            object_id = str(entry.get("object_id", "")).strip()
                            if not object_id:
                                continue
                            batch_openai_errors[object_id] = f"OpenAI batch mode failed: {exc}"
                        if payload.stop_on_error:
                            break

                for entry in batch_entries:
                    if _job_cancel_requested(job_id):
                        _cancel_vlm_job()
                        return
                    if payload.stop_on_error and errors:
                        break
                    if entry["failed"]:
                        continue
                    scene_index = int(entry["scene_index"])
                    with jobs_lock:
                        if job_id in jobs_store:
                            jobs_store[job_id].update({"current_scene_index": scene_index, "current_scene_tasks_completed": int(entry["scene_tasks_completed"]), "current_scene_tasks_total": task_total_per_scene, "updated_at": time.time()})
                    if combine_fields_into_json:
                        try:
                            if use_openai_batch_api:
                                object_id = str(entry["object_id"])
                                if object_id in batch_openai_errors:
                                    raise RuntimeError(batch_openai_errors[object_id])
                                combined_response_text = str(batch_openai_outputs.get(object_id, "")).strip()
                                if not combined_response_text:
                                    raise RuntimeError("OpenAI batch response is missing for scene")
                            else:
                                combined_response_text = _run_vlm(
                                    client,
                                    entry["image_bytes"],
                                    combined_prompt_text,
                                    combined_json_max_new_tokens,
                                    job_id=job_id,
                                    task_index=completed_tasks + 1,
                                    task_total=total_tasks_planned if total_tasks_planned > 0 else None,
                                    field_name="__combined_json__",
                                    object_id=entry["object_id"],
                                )

                            json_object = _extract_first_json_object(combined_response_text)
                            values, parse_failed_fields, warning_count = _normalize_values_from_json_object(
                                json_object,
                                prepared_fields,
                            )
                            entry["values"].update(values)
                            parse_warnings_total += int(warning_count)
                            if warning_count > 0 and isinstance(entry.get("parse_failed_fields"), list):
                                entry["parse_failed_fields"].extend(parse_failed_fields[:])  # type: ignore[arg-type]
                                for parse_item in parse_failed_fields:
                                    field_name = str(parse_item.get("field_name") or "").strip() or "<unknown>"
                                    response_type = str(parse_item.get("response_type") or "").strip() or "<unknown>"
                                    note = str(parse_item.get("note") or "").strip() or "fallback"
                                    warning_key = f"{field_name}[{response_type}]::{note}"
                                    parse_warnings_by_field[warning_key] = int(parse_warnings_by_field.get(warning_key, 0)) + 1
                                if len(parse_warnings_samples) < 30:
                                    parse_warnings_samples.extend(
                                        [
                                            {
                                                "object_id": str(entry["object_id"]),
                                                "field_name": str(item.get("field_name") or ""),
                                                "response_type": str(item.get("response_type") or ""),
                                                "normalized_value": str(item.get("normalized_value") or "")[:200],
                                                "raw_response": str(item.get("raw_response") or "")[:500],
                                                "note": str(item.get("note") or "fallback"),
                                            }
                                            for item in parse_failed_fields[
                                                : max(0, 30 - len(parse_warnings_samples))
                                            ]
                                        ]
                                    )
                            entry["scene_tasks_completed"] = expected_scene_tasks_completed
                            completed_tasks += 1
                            with jobs_lock:
                                if job_id in jobs_store:
                                    jobs_store[job_id].update(
                                        {
                                            "total_tasks_completed": completed_tasks,
                                            "total_tasks_planned": total_tasks_planned,
                                            "current_scene_index": entry["scene_index"],
                                            "current_scene_tasks_completed": entry["scene_tasks_completed"],
                                            "current_scene_tasks_total": task_total_per_scene,
                                            "parse_warnings_total": int(parse_warnings_total),
                                            "parse_warnings_by_field": dict(parse_warnings_by_field),
                                            "parse_warnings_samples": list(parse_warnings_samples),
                                            "updated_at": time.time(),
                                        }
                                    )
                        except Exception as exc:
                            logger.exception("VLM combined JSON failed for object_id=%s", entry["object_id"])
                            entry["failed"] = True
                            errors.append({"object_id": entry["object_id"], "error": str(exc)})
                            if payload.stop_on_error:
                                break
                    else:
                        remaining_fields = [field for field in prepared_fields if field["field_name"] not in entry["values"]]
                        chunk_size = field_chunk_size_override

                        for field_offset in range(0, len(remaining_fields), chunk_size):
                            if _job_cancel_requested(job_id):
                                _cancel_vlm_job()
                                return
                            if entry["failed"]:
                                break
                            if payload.stop_on_error and errors:
                                break
                            field_chunk = remaining_fields[field_offset : field_offset + chunk_size]
                            chunk_max_new_tokens = max(_effective_max_new_tokens_for_response_type(field["response_type"]) for field in field_chunk)
                            task_items = [
                                {"image_bytes": entry["image_bytes"], "prompt": field["single_prompt"], "metadata": {"job_id": job_id, "task_index": completed_tasks + idx + 1, "task_total": total_tasks_planned if total_tasks_planned > 0 else None, "field_name": field["field_name"], "object_id": entry["object_id"]}}
                                for idx, field in enumerate(field_chunk)
                            ]
                            try:
                                responses = _run_vlm_batch(client, task_items, chunk_max_new_tokens)
                            except Exception as exc:
                                logger.exception("VLM batch inference failed for object_id=%s fields=%s; falling back to per-item", entry["object_id"], len(field_chunk))
                                with jobs_lock:
                                    job = jobs_store.get(job_id)
                                    if job:
                                        _append_job_log(job, f"VLM batch inference failed; falling back to per-item: object_id={entry['object_id']}, fields={len(field_chunk)}, error={exc}")
                                responses = None

                            response_iter = zip(field_chunk, responses) if responses is not None else [(field, None) for field in field_chunk]
                            for field, response_text in response_iter:
                                if _job_cancel_requested(job_id):
                                    _cancel_vlm_job()
                                    return
                                if entry["failed"]:
                                    break
                                try:
                                    if responses is None:
                                        response_text = _run_vlm(
                                            client,
                                            entry["image_bytes"],
                                            field["single_prompt"],
                                            _effective_max_new_tokens_for_response_type(field["response_type"]),
                                            job_id=job_id,
                                            task_index=completed_tasks + 1,
                                            task_total=total_tasks_planned if total_tasks_planned > 0 else None,
                                            field_name=field["field_name"],
                                            object_id=entry["object_id"],
                                        )
                                    normalized_value, parsed_ok, parse_note = _normalize_with_retry_if_empty(
                                        client=client,
                                        entry=entry,
                                        field=field,
                                        response_text=str(response_text or ""),
                                        task_index=completed_tasks + 1,
                                        max_new_tokens=_effective_max_new_tokens_for_response_type(field["response_type"]),
                                    )
                                    entry["values"][field["field_name"]] = normalized_value
                                    if not parsed_ok:
                                        parse_warnings_total += 1
                                        parse_failed_fields = entry.get("parse_failed_fields")
                                        if isinstance(parse_failed_fields, list):
                                            parse_failed_fields.append({"field_name": str(field["field_name"]), "response_type": str(field["response_type"]), "note": parse_note or "fallback", "raw_response": str(response_text)[:500], "normalized_value": normalized_value[:200]})
                                        warning_key = f"{field['field_name']}[{field['response_type']}]::{parse_note or 'fallback'}"
                                        parse_warnings_by_field[warning_key] = int(parse_warnings_by_field.get(warning_key, 0)) + 1
                                        if len(parse_warnings_samples) < 30:
                                            parse_warnings_samples.append({"object_id": str(entry["object_id"]), "field_name": str(field["field_name"]), "response_type": str(field["response_type"]), "normalized_value": normalized_value[:200], "raw_response": str(response_text)[:500], "note": parse_note or "fallback"})
                                    entry["scene_tasks_completed"] += 1
                                    completed_tasks += 1
                                    with jobs_lock:
                                        if job_id in jobs_store:
                                            jobs_store[job_id].update({"total_tasks_completed": completed_tasks, "total_tasks_planned": total_tasks_planned, "current_scene_index": entry["scene_index"], "current_scene_tasks_completed": entry["scene_tasks_completed"], "current_scene_tasks_total": task_total_per_scene, "parse_warnings_total": int(parse_warnings_total), "parse_warnings_by_field": dict(parse_warnings_by_field), "parse_warnings_samples": list(parse_warnings_samples), "updated_at": time.time()})
                                    if parse_warnings_total > 0 and parse_warnings_total % parse_warning_log_step == 0:
                                        with jobs_lock:
                                            if job_id in jobs_store:
                                                _append_job_log(jobs_store[job_id], f"VLM parse fallback used {parse_warnings_total} times (latest: object_id={entry['object_id']}, field={field['field_name']}, note={parse_note})")
                                except Exception as exc:
                                    logger.exception("VLM failed for object_id=%s field=%s", entry["object_id"], field["field_name"])
                                    entry["failed"] = True
                                    errors.append({"object_id": entry["object_id"], "error": str(exc)})
                                    if payload.stop_on_error:
                                        break

                            if payload.stop_on_error and errors:
                                break

                    object_id = str(entry["object_id"])
                    scene_tasks_completed = int(entry["scene_tasks_completed"])
                    if not entry["failed"] and scene_tasks_completed == expected_scene_tasks_completed:
                        filtered_values = {field_name: str(entry["values"].get(field_name, "")).strip() for field_name in field_names if str(entry["values"].get(field_name, "")).strip()}
                        if not payload.dry_run:
                            upserted = _upsert_vlm_annotations([{"object_id": object_id, "values": filtered_values}])
                            total_inserted += upserted
                            if upserted > 0 and object_id not in annotated_object_ids_seen:
                                annotated_object_ids_seen.add(object_id)
                                annotated_object_ids.append(object_id)
                            if upserted > 0:
                                saved_non_empty_fields = len(filtered_values)
                                if saved_non_empty_fields >= len(field_names):
                                    saved_full_annotations += 1
                                else:
                                    saved_partial_annotations += 1
                                    missing_fields = [field_name for field_name in field_names if not str(entry["values"].get(field_name, "")).strip()]
                                    _log_partial_scene_parse_details(entry, f"saved_partial_after_upsert ({saved_non_empty_fields}/{len(field_names)}), missing={','.join(missing_fields[:20])}")
                    elif not entry["failed"]:
                        entry["failed"] = True
                        errors.append({"object_id": object_id, "error": f"incomplete annotation values generated ({scene_tasks_completed}/{expected_scene_tasks_completed})"})
                        _log_partial_scene_parse_details(entry, f"incomplete_values_{scene_tasks_completed}_of_{expected_scene_tasks_completed}")
                    elif entry["failed"]:
                        _log_partial_scene_parse_details(entry, "scene_failed")
                    total_seen += 1
                    progress = min(int((total_seen / max(len(object_ids), 1)) * 100), 100)
                    next_scene_index = min(total_seen + 1, len(object_ids))
                    reset_scene_tasks = total_seen < len(object_ids) and not (payload.stop_on_error and errors)
                    display_scene_index = next_scene_index if reset_scene_tasks else int(entry["scene_index"])
                    display_scene_tasks_completed = 0 if reset_scene_tasks else scene_tasks_completed
                    with jobs_lock:
                        if job_id in jobs_store:
                            jobs_store[job_id].update({"progress": progress, "total_seen": total_seen, "total_inserted": total_inserted, "total_tasks_completed": completed_tasks, "total_tasks_planned": total_tasks_planned, "current_scene_index": display_scene_index, "current_scene_tasks_completed": display_scene_tasks_completed, "current_scene_tasks_total": task_total_per_scene, "parse_warnings_total": int(parse_warnings_total), "parse_warnings_by_field": dict(parse_warnings_by_field), "parse_warnings_samples": list(parse_warnings_samples), "saved_full_annotations": int(saved_full_annotations), "saved_partial_annotations": int(saved_partial_annotations), "errors": errors, "field_names": field_names, "updated_at": time.time()})
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
                                _append_job_log(job, f"Progress: scenes={total_seen}/{planned_total} ({progress}%), tasks={completed_tasks}/{total_tasks_planned}, annotations_saved={total_inserted}, saved_full={saved_full_annotations}, saved_partial={saved_partial_annotations}, errors={len(errors)}")
                        last_progress_log_bucket = max(last_progress_log_bucket, current_bucket)
                        last_progress_log_at = now_mono
                    if payload.stop_on_error and errors:
                        break
                if payload.stop_on_error and errors:
                    break

        final_status = JobStatus.SUCCESS if not errors else JobStatus.ERROR
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update({"status": final_status.value, "progress": 100, "total_seen": total_seen, "total_inserted": total_inserted, "total_tasks_completed": completed_tasks, "total_tasks_planned": total_tasks_planned, "current_scene_tasks_completed": 0, "current_scene_tasks_total": 0, "parse_warnings_total": int(parse_warnings_total), "parse_warnings_by_field": dict(parse_warnings_by_field), "parse_warnings_samples": list(parse_warnings_samples), "saved_full_annotations": int(saved_full_annotations), "saved_partial_annotations": int(saved_partial_annotations), "errors": errors, "updated_at": time.time()})
                if parse_warnings_total > 0:
                    top_parse_items = sorted(parse_warnings_by_field.items(), key=lambda item: int(item[1]), reverse=True)[:5]
                    _append_job_log(jobs_store[job_id], f"Parse fallback summary: total={parse_warnings_total}, top=" + ", ".join([f"{name}:{count}" for name, count in top_parse_items]))
                _append_job_log(jobs_store[job_id], f"Finished with status={final_status.value}, scenes={total_seen}/{planned_total}, tasks={completed_tasks}/{total_tasks_planned}, annotations_saved={total_inserted}, saved_full={saved_full_annotations}, saved_partial={saved_partial_annotations}, errors={len(errors)}")
    except Exception as exc:
        logger.exception("Backfill VLM job %s failed", job_id)
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update({"status": JobStatus.ERROR.value, "errors": errors + [{"error": str(exc), "log": traceback.format_exc()}], "updated_at": time.time()})
                _append_job_log(jobs_store[job_id], f"Failed: {exc}")


def run_dataset_install_job(job_id: str, dataset_key: str, dataset_cfg: Dict[str, Any]) -> None:
    master = _master()
    _to_bool = master._to_bool
    jobs_lock = master.jobs_lock
    jobs_store = master.jobs_store
    JOB_LOG_DIR = master.JOB_LOG_DIR
    JobStatus = master.JobStatus
    _search_dependencies_ready = master._search_dependencies_ready
    _append_job_log = master._append_job_log
    _embed_install_queue_worker = master._embed_install_queue_worker
    _job_cancel_requested = master._job_cancel_requested
    _job_install_cleanup_mode = master._job_install_cleanup_mode
    storage_api = master.storage_api
    logger = master.logger

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

    errors = []
    uploaded_object_ids = []
    uploaded_object_ids_seen = set()
    embed_queue = None
    embed_thread = None
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
                    _append_job_log(job, f"Auto-embedding disabled for this run: {reason}")
        if embed_on_install:
            embed_queue = queue.Queue(maxsize=4096)
            with jobs_lock:
                job = jobs_store.get(job_id)
                if job:
                    _append_job_log(job, "Auto-embedding enabled, running in streaming mode during install.")

        def _embed_worker_runner() -> None:
            try:
                _embed_install_queue_worker(job_id=job_id, object_queue=embed_queue, errors=errors)
            except InterruptedError:
                with embed_worker_lock:
                    embed_worker_state["cancelled"] = True
            except Exception as exc:
                logger.exception("Streaming auto-embedding worker failed: job_id=%s dataset=%s", job_id, dataset_key)
                with embed_worker_lock:
                    embed_worker_state["error"] = {"error": str(exc), "log": traceback.format_exc()}
            finally:
                with jobs_lock:
                    job = jobs_store.get(job_id)
                    if job:
                        job["embedding_worker_running"] = False
                        job["updated_at"] = time.time()

        if embed_on_install:
            embed_thread = threading.Thread(target=_embed_worker_runner, name=f"embed-install-{job_id[:8]}", daemon=True)
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
        object_id_to_enqueue = None
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
            if ev == "download_detail":
                job["extract_scene_index"] = int(event.get("current_scene_index", 0) or 0)
                job["extract_scene_tasks_completed"] = int(event.get("current_scene_tasks_completed", 0) or 0)
                job["extract_scene_tasks_total"] = int(event.get("current_scene_tasks_total", 0) or 0)
                job["extract_file_name"] = str(event.get("file_name", "") or "")
            if ev == "upload_progress":
                job["install_phase"] = "upload"
                uploaded_now = int(event.get("uploaded_objects_unique", event.get("uploaded_objects", job.get("total_inserted", 0))) or 0)
                job["total_inserted"] = uploaded_now
                object_id = str(event.get("last_uploaded_object_id", "") or "").strip()
                if object_id and object_id not in uploaded_object_ids_seen:
                    uploaded_object_ids_seen.add(object_id)
                    uploaded_object_ids.append(object_id)
                    if embed_on_install and embed_queue is not None:
                        object_id_to_enqueue = object_id
                        job["embedding_tasks_total"] = int(job.get("embedding_tasks_total", 0) or 0) + 1
            if ev == "extract":
                job["install_phase"] = "extract"
                job["extract_file_name"] = str(event.get("file_name", "") or "")
                job["extract_files_done"] = int(event.get("extracted_files", 0) or 0)
            if ev == "log":
                _append_job_log(job, str(event.get("message", "") or ""))
            if ev == "episode":
                seen = int(event.get("episodes_done", job.get("total_seen", 0)) or 0)
                inserted = int(event.get("uploaded_objects_unique", event.get("uploaded_objects", job.get("total_inserted", 0))) or 0)
                total = int(job.get("total_planned", 0) or 0)
                if total > 0:
                    job["progress"] = min(100, int((seen / max(total, 1)) * 100))
                job["total_seen"] = seen
                job["total_inserted"] = inserted
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
        summary = master.run_preprocessor_method(
            dataset_key,
            cfg,
            progress_callback=_on_progress,
            cancel_requested_callback=lambda: _job_cancel_requested(job_id),
        )
        if embed_on_install:
            with jobs_lock:
                job = jobs_store.get(job_id)
                if job:
                    _append_job_log(job, "Dataset download finished, waiting for remaining embedding tasks...")
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
                total_embeddings_inserted = int(jobs_store[job_id].get("total_embeddings_inserted", 0) or 0)
                jobs_store[job_id].update({"status": JobStatus.SUCCESS.value if failed_objects == 0 and not final_errors else JobStatus.ERROR.value, "progress": 100, "total_seen": int(summary.get("episodes_done", 0) or 0), "total_inserted": int(summary.get("uploaded_objects_unique", summary.get("uploaded_objects", 0)) or 0), "total_embeddings_inserted": int(total_embeddings_inserted), "total_limit": int(summary.get("total_planned", jobs_store[job_id].get("total_limit", 0)) or 0), "total_planned": int(summary.get("total_planned", jobs_store[job_id].get("total_planned", 0)) or 0), "embedding_worker_running": False, "current_scene_tasks_completed": 0, "current_scene_tasks_total": 0, "extract_scene_tasks_completed": 0, "extract_scene_tasks_total": 0, "install_phase": "done", "errors": final_errors, "updated_at": time.time()})
                _append_job_log(jobs_store[job_id], f"Finished with status={jobs_store[job_id]['status']}, uploaded={jobs_store[job_id].get('total_inserted', 0)}, embeddings={jobs_store[job_id].get('total_embeddings_inserted', 0)}")
    except InterruptedError:
        _stop_embedding_worker(wait=True)
        cleanup_mode = _job_install_cleanup_mode(job_id)
        removed_count = 0
        cleanup_errors = []
        if cleanup_mode == "delete":
            for object_id in uploaded_object_ids:
                try:
                    delete_result = storage_api.delete_object(object_id)
                    if bool(delete_result.get("deleted", False)):
                        removed_count += 1
                except Exception as exc:
                    cleanup_errors.append({"object_id": object_id, "error": f"cleanup failed: {exc}"})

        with jobs_lock:
            if job_id in jobs_store:
                existing_errors = list(jobs_store[job_id].get("errors", []))
                if cleanup_mode == "delete":
                    existing_errors.append({"error": f"Cancellation cleanup removed {removed_count} / {len(uploaded_object_ids)} uploaded objects"})
                jobs_store[job_id].update({"status": JobStatus.CANCELLED.value, "total_inserted": max(0, int(jobs_store[job_id].get('total_inserted', 0) or 0) - removed_count), "embedding_worker_running": False, "current_scene_tasks_completed": 0, "current_scene_tasks_total": 0, "extract_scene_tasks_completed": 0, "extract_scene_tasks_total": 0, "install_phase": "cancelled", "errors": existing_errors + cleanup_errors, "updated_at": time.time()})
                _append_job_log(jobs_store[job_id], f"Cancelled (cleanup_mode={cleanup_mode}, removed={removed_count}/{len(uploaded_object_ids)})")
    except Exception as exc:
        _stop_embedding_worker(wait=True)
        logger.exception("Dataset installation job failed: job_id=%s dataset=%s", job_id, dataset_key)
        errors.append({"error": str(exc), "log": traceback.format_exc()})
        with jobs_lock:
            if job_id in jobs_store:
                jobs_store[job_id].update({"status": JobStatus.ERROR.value, "embedding_worker_running": False, "install_phase": "error", "errors": errors, "updated_at": time.time()})
                _append_job_log(jobs_store[job_id], f"Failed: {exc}")


def start_backfill_embeddings_job(payload: Any) -> str:
    job_id = str(uuid.uuid4())
    thread = threading.Thread(target=run_backfill_job, args=(job_id, payload), daemon=True)
    thread.start()
    return job_id


def start_vlm_backfill_job(payload: Any) -> str:
    job_id = str(uuid.uuid4())
    thread = threading.Thread(target=run_vlm_backfill_job, args=(job_id, payload), daemon=True)
    thread.start()
    return job_id


def start_dataset_install_job(dataset_key: str, dataset_cfg: Dict[str, Any]) -> str:
    job_id = str(uuid.uuid4())
    thread = threading.Thread(target=run_dataset_install_job, args=(job_id, dataset_key, dataset_cfg), daemon=True)
    thread.start()
    return job_id


def retry_job_from_failed(source_job_id: str) -> Dict[str, Any]:
    master = _master()
    with master.jobs_lock:
        source_job = master.jobs_store.get(source_job_id)
        if not source_job:
            raise HTTPException(status_code=404, detail="Job not found")
        snapshot = dict(source_job)

    source_status = str(snapshot.get("status", "")).strip().lower()
    if source_status != master.JobStatus.ERROR.value:
        raise HTTPException(status_code=400, detail="Only failed jobs can be retried")

    source_job_type = str(snapshot.get("job_type", "")).strip()
    source_config = snapshot.get("job_config")
    normalized_config = dict(source_config) if isinstance(source_config, dict) else {}

    if source_job_type == "backfill_embeddings":
        payload = master.BackfillRequest(**normalized_config)
        job_id = start_backfill_embeddings_job(payload)
        return {"job_id": job_id, "status": "started", "source_job_id": source_job_id, "job_type": source_job_type}

    if source_job_type == "backfill_vlm":
        payload = master.VLMBackfillRequest(**normalized_config)
        job_id = start_vlm_backfill_job(payload)
        return {"job_id": job_id, "status": "started", "source_job_id": source_job_id, "job_type": source_job_type}

    if source_job_type.startswith("install_"):
        dataset_key = str(snapshot.get("dataset", "")).strip().lower()
        if not dataset_key:
            dataset_key = source_job_type[len("install_") :].strip().lower()
        if not dataset_key:
            raise HTTPException(status_code=400, detail="Retry is unsupported for this install job")
        job_id = start_dataset_install_job(dataset_key, normalized_config)
        return {
            "job_id": job_id,
            "status": "started",
            "source_job_id": source_job_id,
            "job_type": source_job_type,
            "dataset": dataset_key,
        }

    raise HTTPException(status_code=400, detail=f"Retry is unsupported for job_type='{source_job_type}'")
