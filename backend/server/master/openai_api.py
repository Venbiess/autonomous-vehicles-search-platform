import ast
import base64
import imghdr
import json
import re
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from .models import VLM_RESPONSE_HINTS


def env_first_nonempty(*names: str, default: str = "") -> str:
    import os

    for name in names:
        raw = os.getenv(name)
        if raw is None:
            continue
        value = str(raw).strip()
        if value:
            return value
    return default


def openai_chat_content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: List[str] = []
        for item in content:
            if isinstance(item, str):
                chunks.append(item)
                continue
            if isinstance(item, dict):
                text = item.get("text")
                if text is not None:
                    chunks.append(str(text))
                continue
            text = getattr(item, "text", None)
            if text is not None:
                chunks.append(str(text))
        return "".join(chunks)
    return str(content)


def create_openai_client_for_vlm_batch() -> Any:
    api_key = env_first_nonempty("VLM_OPENAI_API_KEY", "OPENAI_API_KEY")
    if not api_key:
        raise ValueError(
            "OpenAI API key is required for OpenAI Batch mode. "
            "Set VLM_OPENAI_API_KEY or OPENAI_API_KEY."
        )

    base_url = env_first_nonempty(
        "VLM_OPENAI_BASE_URL",
        "OPENAI_BASE_URL",
        default="https://api.openai.com/v1",
    )
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(
            f"Invalid OpenAI base URL: {base_url!r}. "
            "Expected an absolute URL with http:// or https://"
        )

    timeout_raw = env_first_nonempty("VLM_OPENAI_TIMEOUT_SEC", default="120")
    retries_raw = env_first_nonempty("VLM_OPENAI_MAX_RETRIES", default="2")
    try:
        timeout_sec = max(1.0, float(timeout_raw))
    except ValueError as exc:
        raise ValueError(f"Invalid VLM_OPENAI_TIMEOUT_SEC={timeout_raw!r}") from exc
    try:
        max_retries = max(0, int(retries_raw))
    except ValueError as exc:
        raise ValueError(f"Invalid VLM_OPENAI_MAX_RETRIES={retries_raw!r}") from exc

    organization = env_first_nonempty("VLM_OPENAI_ORG_ID", "OPENAI_ORG_ID")
    project = env_first_nonempty("VLM_OPENAI_PROJECT_ID", "OPENAI_PROJECT_ID")

    try:
        from openai import OpenAI
    except ImportError as exc:
        raise ImportError(
            "OpenAI Batch mode requires the 'openai' Python package in master-server runtime."
        ) from exc

    kwargs: Dict[str, Any] = {
        "api_key": api_key,
        "base_url": base_url,
        "timeout": timeout_sec,
        "max_retries": max_retries,
    }
    if organization:
        kwargs["organization"] = organization
    if project:
        kwargs["project"] = project
    return OpenAI(**kwargs)


def image_bytes_to_openai_data_url(image_bytes: bytes) -> str:
    if not image_bytes:
        raise ValueError("image bytes are empty")
    kind = imghdr.what(None, h=image_bytes)
    mime_by_kind = {
        "jpeg": "image/jpeg",
        "jpg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "webp": "image/webp",
    }
    mime = mime_by_kind.get(str(kind or "").lower(), "image/jpeg")
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def serialize_openai_batch(batch: Any) -> Dict[str, Any]:
    request_counts = getattr(batch, "request_counts", None)
    if request_counts is None:
        request_counts_payload: Dict[str, Any] = {}
    elif isinstance(request_counts, dict):
        request_counts_payload = dict(request_counts)
    elif hasattr(request_counts, "model_dump"):
        request_counts_payload = dict(request_counts.model_dump())  # type: ignore[arg-type]
    elif hasattr(request_counts, "dict"):
        request_counts_payload = dict(request_counts.dict())  # type: ignore[arg-type]
    else:
        request_counts_payload = {}

    metadata = getattr(batch, "metadata", None)
    metadata_payload = dict(metadata) if isinstance(metadata, dict) else {}
    return {
        "id": str(getattr(batch, "id", "")),
        "status": str(getattr(batch, "status", "")),
        "endpoint": str(getattr(batch, "endpoint", "")),
        "input_file_id": getattr(batch, "input_file_id", None),
        "output_file_id": getattr(batch, "output_file_id", None),
        "error_file_id": getattr(batch, "error_file_id", None),
        "completion_window": str(getattr(batch, "completion_window", "")),
        "request_counts": request_counts_payload,
        "metadata": metadata_payload,
    }


def extract_openai_output_content(response_item: Dict[str, Any]) -> str:
    response_payload = response_item.get("response")
    if not isinstance(response_payload, dict):
        return ""
    body = response_payload.get("body")
    if not isinstance(body, dict):
        return ""
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if not isinstance(message, dict):
        return ""
    return openai_chat_content_to_text(message.get("content")).strip()


def read_openai_file_bytes(client: Any, file_id: Optional[str]) -> bytes:
    if not file_id:
        return b""
    content = client.files.content(file_id)
    if hasattr(content, "content"):
        raw = content.content
        if isinstance(raw, bytes):
            return raw
        if isinstance(raw, str):
            return raw.encode("utf-8")
    if isinstance(content, bytes):
        return content
    if isinstance(content, str):
        return content.encode("utf-8")
    if hasattr(content, "read"):
        raw = content.read()
        if isinstance(raw, bytes):
            return raw
        if isinstance(raw, str):
            return raw.encode("utf-8")
    return b""


def normalize_openai_schema_name(name: str) -> str:
    raw = str(name or "").strip()
    if not raw:
        return "vlm_annotation"
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "_", raw).strip("_")
    if not normalized:
        normalized = "vlm_annotation"
    return normalized[:64]


def build_openai_json_schema_from_fields(fields: List[Dict[str, str]]) -> Dict[str, Any]:
    properties: Dict[str, Any] = {}
    required: List[str] = []
    for field in fields:
        field_name = str(field.get("field_name", "")).strip()
        if not field_name:
            continue
        response_type = str(field.get("response_type", "text")).strip().lower()
        prompt = str(field.get("prompt", "")).strip()
        if response_type == "yes_no":
            property_schema: Dict[str, Any] = {"type": "string", "enum": ["Yes", "No"]}
        elif response_type == "number":
            property_schema = {"type": "integer"}
        else:
            property_schema = {"type": "string"}
        if prompt:
            property_schema["description"] = prompt
        properties[field_name] = property_schema
        required.append(field_name)

    return {
        "type": "object",
        "additionalProperties": False,
        "required": required,
        "properties": properties,
    }


def _parse_json_or_python_literal(payload: Any) -> Optional[Any]:
    if payload is None:
        return None
    if isinstance(payload, (dict, list)):
        return payload
    text = str(payload).strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        pass
    try:
        return ast.literal_eval(text)
    except Exception:
        return None


def _unwrap_json_schema_payload(payload: Any) -> Optional[Dict[str, Any]]:
    parsed = _parse_json_or_python_literal(payload)
    if not isinstance(parsed, dict):
        return None
    if parsed.get("type") == "json_schema" and isinstance(parsed.get("json_schema"), dict):
        inner = parsed.get("json_schema", {})
        if isinstance(inner.get("schema"), dict):
            return dict(inner.get("schema", {}))
    if isinstance(parsed.get("json_schema"), dict):
        inner = parsed.get("json_schema", {})
        if isinstance(inner.get("schema"), dict):
            return dict(inner.get("schema", {}))
    return dict(parsed)


def build_openai_response_format(
    *,
    prepared_fields: List[Dict[str, str]],
    payload: Any,
) -> Optional[Dict[str, Any]]:
    use_json_schema = bool(getattr(payload, "openai_use_json_schema", False))
    custom_schema_raw = getattr(payload, "openai_json_schema", None)
    custom_schema = _unwrap_json_schema_payload(custom_schema_raw)
    if not use_json_schema and not custom_schema:
        return None

    schema_object: Dict[str, Any]
    if isinstance(custom_schema, dict) and custom_schema:
        schema_object = custom_schema
    elif use_json_schema:
        schema_object = build_openai_json_schema_from_fields(prepared_fields)
    else:
        raise ValueError("openai_json_schema must be a non-empty JSON object")

    if str(schema_object.get("type", "")).strip().lower() != "object":
        raise ValueError('Custom JSON schema must contain "type": "object".')

    schema_name = normalize_openai_schema_name(
        str(getattr(payload, "openai_json_schema_name", "vlm_annotation"))
    )
    schema_payload: Dict[str, Any] = {
        "name": schema_name,
        "strict": bool(getattr(payload, "openai_json_schema_strict", True)),
        "schema": schema_object,
    }
    description = str(getattr(payload, "openai_json_schema_description", "") or "").strip()
    if description:
        schema_payload["description"] = description

    return {
        "type": "json_schema",
        "json_schema": schema_payload,
    }


def build_vlm_json_prompt(
    fields: List[Dict[str, str]],
    combined_prompt: Optional[str] = None,
) -> str:
    lines: List[str] = []
    custom_prompt = str(combined_prompt or "").strip()
    if custom_prompt:
        lines.append(custom_prompt)
    else:
        lines.append("Analyze the image and fill all requested fields.")
    lines.append("")
    lines.append("Return exactly one compact JSON object, without markdown and without extra keys.")
    lines.append("Required keys and field constraints:")
    for field in fields:
        field_name = str(field.get("field_name", "")).strip()
        response_type = str(field.get("response_type", "text")).strip().lower()
        field_prompt = str(field.get("prompt", "")).strip()
        response_hint = VLM_RESPONSE_HINTS.get(response_type, VLM_RESPONSE_HINTS["text"])
        lines.append(f'- "{field_name}": {field_prompt}. Format requirement: {response_hint}')
    lines.append("")
    lines.append("Output JSON only.")
    return "\n".join(lines).strip()


def extract_first_json_object(response_text: str) -> Dict[str, Any]:
    text = str(response_text or "").strip()
    if not text:
        raise ValueError("Empty VLM response")
    text = re.sub(r"^\s*```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```\s*$", "", text)
    decoder = json.JSONDecoder()
    for idx, char in enumerate(text):
        if char != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[idx:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("VLM response does not contain a valid JSON object")


def normalize_values_from_json_object(
    json_object: Dict[str, Any],
    fields: List[Dict[str, str]],
    *,
    normalize_vlm_response: Callable[[str, str], Tuple[str, bool, str]],
) -> Tuple[Dict[str, str], List[Dict[str, str]], int]:
    values: Dict[str, str] = {}
    parse_failed_fields: List[Dict[str, str]] = []
    for field in fields:
        field_name = str(field.get("field_name", "")).strip()
        response_type = str(field.get("response_type", "text")).strip().lower()
        if not field_name:
            continue
        if field_name not in json_object:
            parse_failed_fields.append(
                {
                    "field_name": field_name,
                    "response_type": response_type,
                    "note": "json_key_missing",
                    "raw_response": "",
                    "normalized_value": "",
                }
            )
            continue

        raw_value = json_object.get(field_name)
        if raw_value is None:
            raw_text = ""
        elif isinstance(raw_value, (dict, list)):
            raw_text = json.dumps(raw_value, ensure_ascii=False)
        else:
            raw_text = str(raw_value)

        normalized_value, parsed_ok, parse_note = normalize_vlm_response(raw_text, response_type)
        normalized_value = str(normalized_value).strip()
        if normalized_value:
            values[field_name] = normalized_value
        if not parsed_ok:
            parse_failed_fields.append(
                {
                    "field_name": field_name,
                    "response_type": response_type,
                    "note": parse_note or "fallback",
                    "raw_response": raw_text[:500],
                    "normalized_value": normalized_value[:200],
                }
            )

    return values, parse_failed_fields, len(parse_failed_fields)


def run_openai_batch_for_json_annotations(
    *,
    entries: List[Dict[str, Any]],
    combined_prompt_text: str,
    max_new_tokens: int,
    job_id: str,
    response_format: Optional[Dict[str, Any]] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    logger: Any = None,
) -> Tuple[Dict[str, str], Dict[str, str], List[str]]:
    if not entries:
        return {}, {}, []

    client = create_openai_client_for_vlm_batch()
    model_name = env_first_nonempty("VLM_MODEL_NAME", default="gpt-5.4-mini")
    image_detail = env_first_nonempty("VLM_OPENAI_IMAGE_DETAIL", default="low").lower()
    if image_detail not in {"auto", "low", "high"}:
        image_detail = "low"
    completion_window = env_first_nonempty("VLM_OPENAI_BATCH_COMPLETION_WINDOW", default="24h")
    poll_raw = env_first_nonempty("VLM_OPENAI_BATCH_POLL_SEC", default="15")
    chunk_raw = env_first_nonempty("VLM_OPENAI_BATCH_SCENE_CHUNK_SIZE", default="32")
    max_input_raw = env_first_nonempty("VLM_OPENAI_BATCH_MAX_INPUT_BYTES", default="190000000")
    system_prompt = env_first_nonempty("VLM_OPENAI_SYSTEM_PROMPT")
    temperature_raw = env_first_nonempty("VLM_OPENAI_TEMPERATURE")
    token_param_raw = env_first_nonempty(
        "VLM_OPENAI_TOKEN_PARAM",
        default="max_completion_tokens",
    ).strip().lower()
    token_param = (
        token_param_raw
        if token_param_raw in {"max_tokens", "max_completion_tokens"}
        else "max_completion_tokens"
    )
    try:
        poll_sec = max(1.0, float(poll_raw))
    except ValueError:
        poll_sec = 15.0
    try:
        chunk_size = max(1, int(chunk_raw))
    except ValueError:
        chunk_size = 32
    try:
        max_input_bytes = max(1_000_000, int(max_input_raw))
    except ValueError:
        max_input_bytes = 190_000_000

    temperature: Optional[float] = None
    if temperature_raw:
        try:
            temperature = float(temperature_raw)
        except ValueError:
            temperature = None

    outputs: Dict[str, str] = {}
    errors: Dict[str, str] = {}
    batch_ids: List[str] = []

    batch_entries_total = len(entries)
    for start in range(0, len(entries), chunk_size):
        chunk_entries = entries[start : start + chunk_size]
        lines: List[str] = []
        total_bytes = 0
        for entry in chunk_entries:
            object_id = str(entry.get("object_id", "")).strip()
            if not object_id:
                continue
            data_url = image_bytes_to_openai_data_url(entry.get("image_bytes", b""))
            messages: List[Dict[str, Any]] = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": combined_prompt_text},
                        {"type": "image_url", "image_url": {"url": data_url, "detail": image_detail}},
                    ],
                }
            )
            body: Dict[str, Any] = {"model": model_name, "messages": messages}
            body[token_param] = int(max_new_tokens)
            if temperature is not None:
                body["temperature"] = temperature
            if response_format:
                body["response_format"] = response_format
            request = {
                "custom_id": object_id,
                "method": "POST",
                "url": "/v1/chat/completions",
                "body": body,
            }
            line = json.dumps(request, ensure_ascii=False)
            lines.append(line)
            total_bytes += len(line.encode("utf-8")) + 1

        if not lines:
            continue
        if total_bytes > max_input_bytes:
            raise ValueError(
                f"OpenAI batch input chunk is too large ({total_bytes} bytes > {max_input_bytes}). "
                "Decrease VLM_OPENAI_BATCH_SCENE_CHUNK_SIZE."
            )

        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as temp_file:
            temp_file.write("\n".join(lines))
            temp_file.write("\n")
            input_path = temp_file.name

        try:
            with open(input_path, "rb") as file_handle:
                input_file = client.files.create(file=file_handle, purpose="batch")
            batch = client.batches.create(
                input_file_id=input_file.id,
                endpoint="/v1/chat/completions",
                completion_window=completion_window,
                metadata={"job_id": job_id, "batch_start": str(start), "batch_size": str(len(chunk_entries))},
            )
            batch_id = str(getattr(batch, "id", "")).strip()
            if not batch_id:
                raise RuntimeError("OpenAI Batch API returned empty batch id")
            batch_ids.append(batch_id)

            last_progress_signature = ""

            def _emit_progress(current_batch: Any, *, force: bool = False) -> None:
                if progress_callback is None:
                    return
                status_value = str(getattr(current_batch, "status", "")).strip().lower()
                request_counts = getattr(current_batch, "request_counts", None)
                completed_count = 0
                total_count = len(chunk_entries)
                failed_count = 0
                if isinstance(request_counts, dict):
                    completed_count = int(request_counts.get("completed", 0) or 0)
                    total_count = int(request_counts.get("total", total_count) or total_count)
                    failed_count = int(request_counts.get("failed", 0) or 0)
                elif request_counts is not None:
                    completed_count = int(getattr(request_counts, "completed", 0) or 0)
                    total_count = int(getattr(request_counts, "total", total_count) or total_count)
                    failed_count = int(getattr(request_counts, "failed", 0) or 0)

                batch_entries_completed_estimate = min(
                    batch_entries_total,
                    start + min(total_count, max(0, completed_count + failed_count)),
                )
                signature = (
                    f"{batch_id}:{status_value}:{completed_count}:{total_count}:"
                    f"{batch_entries_completed_estimate}"
                )
                nonlocal last_progress_signature
                if not force and signature == last_progress_signature:
                    return
                last_progress_signature = signature
                progress_callback(
                    {
                        "batch_id": batch_id,
                        "status": status_value,
                        "request_counts": {
                            "completed": completed_count,
                            "failed": failed_count,
                            "total": total_count,
                        },
                        "batch_entries_total": batch_entries_total,
                        "batch_entries_completed_estimate": batch_entries_completed_estimate,
                    }
                )

            while True:
                current = client.batches.retrieve(batch_id)
                _emit_progress(current)
                status = str(getattr(current, "status", "")).strip().lower()
                if status in {"completed", "failed", "expired", "cancelled"}:
                    break
                time.sleep(poll_sec)

            current = client.batches.retrieve(batch_id)
            _emit_progress(current, force=True)
            status = str(getattr(current, "status", "")).strip().lower()
            output_file_id = getattr(current, "output_file_id", None)
            error_file_id = getattr(current, "error_file_id", None)

            output_bytes = read_openai_file_bytes(client, output_file_id)
            error_bytes = read_openai_file_bytes(client, error_file_id)

            if output_bytes:
                for raw_line in output_bytes.decode("utf-8", errors="replace").splitlines():
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except Exception as exc:
                        if logger is not None:
                            logger.warning("OpenAI batch output line parse failed: %s", exc)
                        continue
                    custom_id = str(item.get("custom_id", "")).strip()
                    if not custom_id:
                        continue
                    if item.get("error"):
                        errors[custom_id] = json.dumps(item.get("error"), ensure_ascii=False)
                        continue
                    response_text = extract_openai_output_content(item)
                    if response_text:
                        outputs[custom_id] = response_text
                    else:
                        errors[custom_id] = "OpenAI batch response is empty"

            if error_bytes:
                for raw_line in error_bytes.decode("utf-8", errors="replace").splitlines():
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except Exception:
                        continue
                    custom_id = str(item.get("custom_id", "")).strip()
                    if not custom_id:
                        continue
                    if custom_id in errors:
                        continue
                    errors[custom_id] = json.dumps(item, ensure_ascii=False)

            if status != "completed":
                for entry in chunk_entries:
                    object_id = str(entry.get("object_id", "")).strip()
                    if not object_id:
                        continue
                    if object_id not in outputs and object_id not in errors:
                        errors[object_id] = (
                            f"OpenAI batch ended with status={status}. "
                            "No output returned for this item."
                        )
        finally:
            try:
                import os

                os.remove(input_path)
            except Exception:
                pass

    return outputs, errors, batch_ids
