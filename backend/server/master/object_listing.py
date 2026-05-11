from typing import Any, Dict, List, Optional

from backend.server.dataset_visibility import load_hidden_datasets


def list_object_ids(storage_api: Any, limit: int, page_size: int = 500, dataset: Optional[str] = None) -> List[str]:
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
            if dataset_filter and bucket_name != dataset_filter:
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


def list_recent_vlm_annotations(
    storage_api: Any,
    analytics_api: Any,
    limit: int,
    page_size: int = 500,
) -> List[Dict[str, Any]]:
    if limit <= 0:
        return []
    out: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    pages_read = 0
    max_pages = 50
    while len(out) < limit and pages_read < max_pages:
        pages_read += 1
        payload = storage_api.list_objects(limit=page_size, cursor=cursor)
        items = payload.get("items", [])
        if not isinstance(items, list) or not items:
            break

        object_meta: Dict[str, Dict[str, str]] = {}
        object_ids: List[str] = []
        for item in items:
            object_id = str(item.get("object_id", "")).strip()
            if not object_id:
                continue
            object_meta[object_id] = {"storage_path": str(item.get("storage_path", "") or "")}
            object_ids.append(object_id)
        if not object_ids:
            next_cursor = payload.get("next_cursor")
            if not next_cursor:
                break
            cursor = next_cursor
            continue

        rows = analytics_api.get_annotations(object_ids)
        by_object_id: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            object_id = str(row.get("object_id", "")).strip()
            values = row.get("values", {})
            if not object_id or not isinstance(values, dict):
                continue
            cleaned_values = {str(key): value for key, value in values.items() if str(value).strip()}
            if not cleaned_values:
                continue
            by_object_id[object_id] = cleaned_values

        for object_id in object_ids:
            values = by_object_id.get(object_id)
            if not values:
                continue
            meta = object_meta.get(object_id, {})
            out.append({"object_id": object_id, "storage_path": meta.get("storage_path", ""), "attributes": values})
            if len(out) >= limit:
                break

        next_cursor = payload.get("next_cursor")
        if not next_cursor:
            break
        cursor = next_cursor
    return out[:limit]


def filter_pending_embedding_object_ids(storage_api: Any, object_ids: List[str]) -> List[str]:
    if not object_ids:
        return []
    completed: set[str] = set()
    chunk_size = 500
    for i in range(0, len(object_ids), chunk_size):
        chunk = object_ids[i : i + chunk_size]
        completed.update(storage_api.completed_vector_object_ids(chunk))
    return [object_id for object_id in object_ids if object_id not in completed]


def list_pending_embedding_object_ids(
    storage_api: Any,
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
            if dataset_filter and bucket_name != dataset_filter:
                continue
            object_id = str(item.get("object_id", "")).strip()
            if object_id:
                batch_ids.append(object_id)

        if batch_ids:
            batch_pending = filter_pending_embedding_object_ids(storage_api, batch_ids)
            if batch_pending:
                take = batch_pending[:remaining]
                pending.extend(take)
                remaining -= len(take)

        next_cursor = payload.get("next_cursor")
        if not next_cursor or remaining == 0:
            break
        cursor = next_cursor
    return pending
