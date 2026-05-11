import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from .models import VLMFieldDefinition, VLM_RESPONSE_HINTS, VLM_RESPONSE_TYPES


def normalize_field_name(field_name: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_]+", "_", field_name.strip().lower())
    normalized = re.sub(r"_+", "_", normalized).strip("_")
    if not normalized:
        raise ValueError("Field name cannot be empty after normalization")
    if normalized[0].isdigit():
        normalized = f"field_{normalized}"
    return normalized


def normalize_response_type(response_type: str) -> str:
    normalized = response_type.strip().lower()
    if normalized not in VLM_RESPONSE_TYPES:
        raise ValueError(
            f"Unsupported response_type '{response_type}'. "
            f"Allowed values: {sorted(VLM_RESPONSE_TYPES)}"
        )
    return normalized


def normalize_match_mode(match_mode: str) -> str:
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


def normalize_vlm_fields(
    fields: List[VLMFieldDefinition],
) -> List[Dict[str, str]]:
    normalized_fields: List[Dict[str, str]] = []
    seen_names = set()
    for field in fields:
        field_name = normalize_field_name(field.name)
        if field_name in seen_names:
            raise ValueError(f"Duplicate field name after normalization: {field_name}")
        seen_names.add(field_name)
        normalized_fields.append(
            {
                "field_name": field_name,
                "prompt": field.prompt.strip(),
                "response_type": normalize_response_type(field.response_type),
            }
        )
    return normalized_fields


def build_vlm_prompt(prompt: str, response_type: str) -> str:
    suffix = VLM_RESPONSE_HINTS[response_type]
    return f"{prompt.strip()}\n\nFormat requirement: {suffix}"


def normalize_vlm_response(response_text: str, response_type: str) -> Tuple[str, bool, str]:
    raw = str(response_text or "")
    value = raw.strip()
    if response_type == "yes_no":
        lowered = value.lower()
        if re.search(r"\byes\b", lowered):
            return "Yes", True, ""
        if re.search(r"\bno\b", lowered):
            return "No", True, ""
        if re.search(r"\bда\b", lowered):
            return "Yes", True, ""
        if re.search(r"\bнет\b", lowered):
            return "No", True, ""
        cleaned = re.sub(r"[^a-zA-Z]", "", value)
        if cleaned.lower().startswith("yes"):
            return "Yes", True, ""
        if cleaned.lower().startswith("no"):
            return "No", True, ""
        fallback = (value or raw).strip()
        return fallback, False, "yes_no_parse_failed_fallback_raw"

    if response_type == "number":
        lowered = value.lower()
        if lowered in {"o", "о"}:
            return "0", True, "number_letter_o_coerced_to_zero"
        match = re.search(r"-?\d+(?:[.,]\d+)?", value)
        if match:
            return match.group(0).replace(",", "."), True, ""
        cleaned = re.sub(r"[^\d\-.,]", "", value)
        cleaned = cleaned.strip()
        if cleaned:
            return cleaned, True, ""
        fallback = (value or raw).strip()
        return fallback, False, "number_parse_failed_fallback_raw"

    if response_type == "category":
        cleaned = re.sub(r"[^\w\s-]", "", value, flags=re.UNICODE)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if cleaned:
            return cleaned, True, ""
        fallback = (value or raw).strip()
        return fallback, False, "category_parse_failed_fallback_raw"

    normalized = value
    if normalized:
        return normalized, True, ""
    fallback = (value or raw).strip()
    return fallback, False, "text_parse_failed_fallback_raw"


def validate_existing_vlm_fields(
    field_names: List[str],
    *,
    get_fields: Callable[[List[str]], List[Dict[str, str]]],
) -> List[Dict[str, str]]:
    normalized_names = [normalize_field_name(name) for name in field_names]
    fields = get_fields(normalized_names)
    if len(fields) != len(set(normalized_names)):
        existing = {field["field_name"] for field in fields}
        missing = sorted(set(normalized_names) - existing)
        raise ValueError(f"Unknown VLM fields: {missing}")
    return fields


def upsert_vlm_annotations(
    rows: List[Dict[str, Any]],
    *,
    upsert_annotations: Callable[[List[Dict[str, Any]]], int],
) -> int:
    if not rows:
        return 0
    return upsert_annotations(rows)


def filter_pending_vlm_object_ids(
    object_ids: List[str],
    field_names: List[str],
    overwrite_existing: bool,
    *,
    completed_object_ids: Callable[[List[str], List[str]], List[str]],
    logger: Any,
) -> List[str]:
    if overwrite_existing or not object_ids:
        return object_ids
    try:
        completed = set(completed_object_ids(object_ids, field_names))
    except Exception as exc:
        logger.warning("VLM pending filter skipped due analytics error: %s", exc)
        return object_ids
    return [object_id for object_id in object_ids if object_id not in completed]


def list_pending_vlm_object_ids(
    limit: int,
    field_names: List[str],
    overwrite_existing: bool,
    *,
    list_object_ids: Callable[[int, int, Optional[str]], List[str]],
    list_objects: Callable[..., Dict[str, Any]],
    completed_object_ids: Callable[[List[str], List[str]], List[str]],
    load_hidden_datasets: Callable[[], List[str]],
    logger: Any,
    page_size: int = 500,
    dataset: Optional[str] = None,
) -> List[str]:
    if overwrite_existing:
        return list_object_ids(limit, page_size=page_size, dataset=dataset)

    remaining = max(limit, 0)
    cursor: Optional[str] = None
    pending: List[str] = []
    dataset_filter = str(dataset or "").strip().lower()
    hidden = {name.lower() for name in load_hidden_datasets()}

    while remaining > 0:
        payload = list_objects(limit=page_size, cursor=cursor)
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
            batch_pending = filter_pending_vlm_object_ids(
                batch_ids,
                field_names,
                overwrite_existing=False,
                completed_object_ids=completed_object_ids,
                logger=logger,
            )
            if batch_pending:
                take = batch_pending[:remaining]
                pending.extend(take)
                remaining -= len(take)

        next_cursor = payload.get("next_cursor")
        if not next_cursor or remaining == 0:
            break
        cursor = next_cursor

    return pending

