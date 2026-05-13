from __future__ import annotations

import base64
import time
import uuid


def _write_headers(settings) -> dict[str, str]:
    token = settings.write_token.strip()
    if not token:
        return {}
    return {"X-Storage-Write-Token": token}


def _fake_jpeg() -> bytes:
    return b"\xff\xd8\xff\xe0AVSP-TEST-" + uuid.uuid4().hex.encode("ascii") + b"\xff\xd9"


def _fake_embedding(settings, base: float = 0.1) -> list[float]:
    return [base] * settings.vector_size


def _upload_object(settings, http_session, headers, payload: bytes, filename: str = "image.jpg", key: str | None = None):
    params = {"bucket": settings.bucket, "filename": filename, "content_type": "image/jpeg"}
    if key:
        params["key"] = key
    req_headers = dict(headers)
    req_headers["Content-Type"] = "image/jpeg"
    response = http_session.post(
        f"{settings.storage_base_url}/objects/upload",
        params=params,
        data=payload,
        headers=req_headers,
        timeout=settings.request_timeout_sec,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _wait_until(predicate, timeout_sec: int = 15, sleep_sec: float = 0.5) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(sleep_sec)
    return False


def _collect_query_results(settings, http_session, embedding: list[float], out: list[dict]) -> bool:
    query = http_session.post(
        f"{settings.storage_base_url}/vectors/query",
        json={"embedding": embedding, "top_k": 5},
        timeout=settings.request_timeout_sec,
    )
    if query.status_code != 200:
        return False
    out.clear()
    out.extend(query.json().get("results", []))
    return len(out) > 0


def _count_vectors(settings, http_session) -> int:
    response = http_session.get(
        f"{settings.storage_base_url}/vectors/count",
        timeout=settings.request_timeout_sec,
    )
    if response.status_code != 200:
        return -1
    return int(response.json().get("count", 0))


def _collect_vectors_get(settings, http_session, object_ids: list[str], out: list[dict]) -> bool:
    fetched = http_session.post(
        f"{settings.storage_base_url}/vectors/get",
        json={"object_ids": object_ids},
        timeout=settings.request_timeout_sec,
    )
    if fetched.status_code != 200:
        return False
    out.clear()
    out.extend(fetched.json().get("items", []))
    return len(out) > 0


def _is_object_absent_in_query(settings, http_session, embedding: list[float], object_id: str) -> bool:
    query = http_session.post(
        f"{settings.storage_base_url}/vectors/query",
        json={"embedding": embedding, "top_k": 10},
        timeout=settings.request_timeout_sec,
    )
    if query.status_code != 200:
        return False
    ids = {item.get("object_id", "") for item in query.json().get("results", [])}
    return object_id not in ids


def test_health_ready_and_metrics(settings, http_session):
    health = http_session.get(f"{settings.storage_base_url}/health", timeout=settings.request_timeout_sec)
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    ready = http_session.get(f"{settings.storage_base_url}/ready", timeout=settings.request_timeout_sec)
    assert ready.status_code == 200

    metrics = http_session.get(f"{settings.storage_base_url}/metrics", timeout=settings.request_timeout_sec)
    assert metrics.status_code == 200
    assert "avsp_storage_http_requests_total" in metrics.text


def test_upload_get_meta_get_content_and_delete(settings, http_session):
    headers = _write_headers(settings)
    payload = _fake_jpeg()
    key = f"integration/{uuid.uuid4().hex}.jpg"

    uploaded = _upload_object(settings, http_session, headers, payload, filename="frame.jpg", key=key)
    object_id = uploaded["object_id"]
    assert uploaded["bucket"] == settings.bucket
    assert uploaded["key"] == key
    assert uploaded["storage_path"].endswith(f"{settings.bucket}/{key}")
    assert uploaded["storage_path"].startswith(("s3://", "yt://", "seaweedfs://", "pics://"))
    assert uploaded["size_bytes"] == len(payload)

    meta = http_session.get(
        f"{settings.storage_base_url}/objects/{object_id}",
        timeout=settings.request_timeout_sec,
    )
    assert meta.status_code == 200, meta.text
    body = meta.json()
    assert body["object_id"] == object_id
    assert body["bucket"] == settings.bucket
    assert body["key"] == key

    content = http_session.get(
        f"{settings.storage_base_url}/objects/{object_id}/content",
        timeout=settings.request_timeout_sec,
    )
    assert content.status_code == 200, content.text
    assert content.content == payload

    deleted = http_session.delete(
        f"{settings.storage_base_url}/objects/{object_id}",
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["deleted"] is True

    missing = http_session.get(
        f"{settings.storage_base_url}/objects/{object_id}",
        timeout=settings.request_timeout_sec,
    )
    assert missing.status_code == 404


def test_delete_object_is_idempotent(settings, http_session):
    headers = _write_headers(settings)
    uploaded = _upload_object(
        settings,
        http_session,
        headers,
        _fake_jpeg(),
        filename="delete-idempotent.jpg",
        key=f"integration/{uuid.uuid4().hex}-delete-idempotent.jpg",
    )
    object_id = uploaded["object_id"]

    first_delete = http_session.delete(
        f"{settings.storage_base_url}/objects/{object_id}",
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert first_delete.status_code == 200, first_delete.text
    assert first_delete.json()["deleted"] is True

    second_delete = http_session.delete(
        f"{settings.storage_base_url}/objects/{object_id}",
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert second_delete.status_code == 200, second_delete.text
    assert second_delete.json()["deleted"] is False


def test_user_flow_list_pagination_and_batch(settings, http_session):
    headers = _write_headers(settings)
    payload1 = _fake_jpeg()
    payload2 = _fake_jpeg()

    up1 = _upload_object(
        settings,
        http_session,
        headers,
        payload1,
        filename="a.jpg",
        key=f"integration/{uuid.uuid4().hex}-a.jpg",
    )
    up2 = _upload_object(
        settings,
        http_session,
        headers,
        payload2,
        filename="b.jpg",
        key=f"integration/{uuid.uuid4().hex}-b.jpg",
    )

    page1 = http_session.get(
        f"{settings.storage_base_url}/objects",
        params={"limit": 1},
        timeout=settings.request_timeout_sec,
    )
    assert page1.status_code == 200, page1.text
    data1 = page1.json()
    assert len(data1["items"]) == 1
    assert data1.get("next_cursor", "") != ""

    page2 = http_session.get(
        f"{settings.storage_base_url}/objects",
        params={"limit": 100, "cursor": data1["next_cursor"]},
        timeout=settings.request_timeout_sec,
    )
    assert page2.status_code == 200, page2.text
    assert isinstance(page2.json()["items"], list)

    batch = http_session.post(
        f"{settings.storage_base_url}/objects/get-batch",
        json={
            "object_ids": [up1["object_id"], up2["object_id"], uuid.uuid4().hex],
            "include_content": True,
        },
        timeout=settings.request_timeout_sec,
    )
    assert batch.status_code == 200, batch.text
    items = {item["object_id"]: item for item in batch.json()["items"]}
    assert base64.b64decode(items[up1["object_id"]]["content_base64"]) == payload1
    assert base64.b64decode(items[up2["object_id"]]["content_base64"]) == payload2
    missing = [it for it in batch.json()["items"] if it["object_id"] not in {up1["object_id"], up2["object_id"]}]
    assert missing and missing[0].get("error", "") != ""


def test_batch_get_preserves_duplicates_without_content(settings, http_session):
    headers = _write_headers(settings)
    payload = _fake_jpeg()
    uploaded = _upload_object(
        settings,
        http_session,
        headers,
        payload,
        filename="dup.jpg",
        key=f"integration/{uuid.uuid4().hex}-dup.jpg",
    )
    object_id = uploaded["object_id"]

    batch = http_session.post(
        f"{settings.storage_base_url}/objects/get-batch",
        json={
            "object_ids": [object_id, object_id, uuid.uuid4().hex],
            "include_content": False,
        },
        timeout=settings.request_timeout_sec,
    )
    assert batch.status_code == 200, batch.text
    items = batch.json()["items"]
    assert [item["object_id"] for item in items[:2]] == [object_id, object_id]
    assert items[0]["size_bytes"] == len(payload)
    assert items[1]["size_bytes"] == len(payload)
    assert "content_base64" not in items[0]
    assert "content_base64" not in items[1]
    assert items[2]["object_id"] != object_id
    assert items[2].get("error", "") != ""


def test_vector_upsert_query_count_and_delete_cascade(settings, http_session):
    headers = _write_headers(settings)
    uploaded = _upload_object(
        settings,
        http_session,
        headers,
        _fake_jpeg(),
        filename="vec.jpg",
        key=f"integration/{uuid.uuid4().hex}-vec.jpg",
    )
    object_id = uploaded["object_id"]

    count_before = http_session.get(
        f"{settings.storage_base_url}/vectors/count",
        timeout=settings.request_timeout_sec,
    )
    assert count_before.status_code == 200, count_before.text
    before_val = int(count_before.json().get("count", 0))

    vector = _fake_embedding(settings)
    upsert = http_session.post(
        f"{settings.storage_base_url}/vectors/upsert",
        json={"vectors": [{"object_id": object_id, "embedding": vector}]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert upsert.status_code == 200, upsert.text
    assert upsert.json()["upserted"] == 1

    query_results: list[dict] = []
    assert _wait_until(
        lambda: _collect_query_results(settings, http_session, vector, query_results),
        timeout_sec=20,
    ), "vector did not become query-visible in time"
    assert any(item["object_id"] == object_id for item in query_results)

    assert _wait_until(
        lambda: _count_vectors(settings, http_session) >= before_val + 1,
        timeout_sec=20,
    ), "vector count did not update in time"

    delete = http_session.delete(
        f"{settings.storage_base_url}/objects/{object_id}",
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert delete.status_code == 200, delete.text
    assert delete.json()["deleted"] is True

    assert _wait_until(
        lambda: _is_object_absent_in_query(settings, http_session, vector, object_id),
        timeout_sec=20,
    ), "deleted vector is still visible in query results"


def test_vectors_get_and_completed_ids_ignore_missing(settings, http_session):
    headers = _write_headers(settings)
    uploaded_a = _upload_object(
        settings,
        http_session,
        headers,
        _fake_jpeg(),
        filename="vec-a.jpg",
        key=f"integration/{uuid.uuid4().hex}-vec-a.jpg",
    )
    uploaded_b = _upload_object(
        settings,
        http_session,
        headers,
        _fake_jpeg(),
        filename="vec-b.jpg",
        key=f"integration/{uuid.uuid4().hex}-vec-b.jpg",
    )
    object_id_a = uploaded_a["object_id"]
    object_id_b = uploaded_b["object_id"]

    vector_a = _fake_embedding(settings, base=0.11)
    vector_b = _fake_embedding(settings, base=0.22)
    upsert = http_session.post(
        f"{settings.storage_base_url}/vectors/upsert",
        json={
            "vectors": [
                {"object_id": object_id_a, "embedding": vector_a},
                {"object_id": object_id_b, "embedding": vector_b},
            ]
        },
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert upsert.status_code == 200, upsert.text
    assert upsert.json()["upserted"] == 2

    missing_id = uuid.uuid4().hex
    items: list[dict] = []
    assert _wait_until(
        lambda: _collect_vectors_get(
            settings,
            http_session,
            [object_id_b, missing_id, object_id_a, object_id_b],
            items,
        ),
        timeout_sec=20,
    ), "vectors/get did not return expected rows in time"
    assert [item["object_id"] for item in items] == [object_id_b, object_id_a]
    assert items[0]["embedding"] == vector_b
    assert items[1]["embedding"] == vector_a

    completed = http_session.post(
        f"{settings.storage_base_url}/vectors/completed-object-ids",
        json={"object_ids": [object_id_a, missing_id, object_id_b]},
        timeout=settings.request_timeout_sec,
    )
    assert completed.status_code == 200, completed.text
    assert set(completed.json()["object_ids"]) == {object_id_a, object_id_b}


def test_analytics_schema_annotations_completed_and_search(settings, http_session):
    headers = _write_headers(settings)
    object_id = _upload_object(
        settings,
        http_session,
        headers,
        _fake_jpeg(),
        filename="vlm.jpg",
        key=f"integration/{uuid.uuid4().hex}-vlm.jpg",
    )["object_id"]
    field_name = f"weather_{uuid.uuid4().hex[:8]}"

    fields = http_session.post(
        f"{settings.storage_base_url}/fields",
        json={
            "fields": [
                {
                    "field_name": field_name,
                    "prompt": "Describe weather",
                    "response_type": "text",
                }
            ]
        },
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert fields.status_code == 200, fields.text
    assert any(item["field_name"] == field_name for item in fields.json()["fields"])

    annotations = http_session.post(
        f"{settings.storage_base_url}/annotations/upsert",
        json={"rows": [{"object_id": object_id, "values": {field_name: "sunny road"}}]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert annotations.status_code == 200, annotations.text
    assert annotations.json()["upserted"] == 1

    completed = http_session.post(
        f"{settings.storage_base_url}/annotations/completed-object-ids",
        json={"object_ids": [object_id], "field_names": [field_name]},
        timeout=settings.request_timeout_sec,
    )
    assert completed.status_code == 200, completed.text
    assert object_id in completed.json()["object_ids"]

    search = http_session.post(
        f"{settings.storage_base_url}/search",
        json={
            "filters": [{"field_name": field_name, "value": "sunny", "match_mode": "contains"}],
            "limit": 10,
        },
        timeout=settings.request_timeout_sec,
    )
    assert search.status_code == 200, search.text
    assert any(item["object_id"] == object_id for item in search.json()["results"])

    deleted = http_session.post(
        f"{settings.storage_base_url}/annotations/delete",
        json={"object_ids": [object_id]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["requested"] == 1


def test_replace_missing_fields_purges_deleted_annotation_values(settings, http_session):
    headers = _write_headers(settings)
    object_id = _upload_object(
        settings,
        http_session,
        headers,
        _fake_jpeg(),
        filename="purge.jpg",
        key=f"integration/{uuid.uuid4().hex}-purge.jpg",
    )["object_id"]
    keep_field = f"keep_{uuid.uuid4().hex[:8]}"
    drop_field = f"drop_{uuid.uuid4().hex[:8]}"

    fields = http_session.post(
        f"{settings.storage_base_url}/fields",
        json={
            "fields": [
                {"field_name": keep_field, "prompt": "Keep", "response_type": "text"},
                {"field_name": drop_field, "prompt": "Drop", "response_type": "text"},
            ]
        },
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert fields.status_code == 200, fields.text

    annotations = http_session.post(
        f"{settings.storage_base_url}/annotations/upsert",
        json={
            "rows": [
                {
                    "object_id": object_id,
                    "values": {
                        keep_field: "kept value",
                        drop_field: "deleted value",
                    },
                }
            ]
        },
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert annotations.status_code == 200, annotations.text

    before = http_session.post(
        f"{settings.storage_base_url}/annotations/get",
        json={"object_ids": [object_id]},
        timeout=settings.request_timeout_sec,
    )
    assert before.status_code == 200, before.text
    row_before = before.json()["rows"][0]
    assert row_before["values"][keep_field] == "kept value"
    assert row_before["values"][drop_field] == "deleted value"

    replaced = http_session.post(
        f"{settings.storage_base_url}/fields",
        json={
            "fields": [
                {"field_name": keep_field, "prompt": "Keep updated", "response_type": "text"},
            ],
            "replace_missing": True,
            "purge_deleted_values": True,
        },
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert replaced.status_code == 200, replaced.text
    field_names_after_replace = {
        str(item.get("field_name", "")).strip()
        for item in replaced.json().get("fields", [])
        if str(item.get("field_name", "")).strip()
    }
    # ClickHouse ALTER DELETE is asynchronous; assert stable invariant only.
    assert keep_field in field_names_after_replace

    after = http_session.post(
        f"{settings.storage_base_url}/annotations/get",
        json={"object_ids": [object_id]},
        timeout=settings.request_timeout_sec,
    )
    assert after.status_code == 200, after.text
    row_after = after.json()["rows"][0]
    assert row_after["values"][keep_field] == "kept value"
    assert drop_field not in row_after["values"]

    completed_keep = http_session.post(
        f"{settings.storage_base_url}/annotations/completed-object-ids",
        json={"object_ids": [object_id], "field_names": [keep_field]},
        timeout=settings.request_timeout_sec,
    )
    assert completed_keep.status_code == 200, completed_keep.text
    assert completed_keep.json()["object_ids"] == [object_id]

    completed_drop = http_session.post(
        f"{settings.storage_base_url}/annotations/completed-object-ids",
        json={"object_ids": [object_id], "field_names": [drop_field]},
        timeout=settings.request_timeout_sec,
    )
    assert completed_drop.status_code == 200, completed_drop.text
    assert completed_drop.json()["object_ids"] == []

    dropped_search = http_session.post(
        f"{settings.storage_base_url}/search",
        json={
            "filters": [{"field_name": drop_field, "value": "deleted", "match_mode": "contains"}],
            "limit": 10,
        },
        timeout=settings.request_timeout_sec,
    )
    assert dropped_search.status_code == 200, dropped_search.text
    assert dropped_search.json()["results"] == []


def test_annotations_clear_resets_completed_and_search(settings, http_session):
    headers = _write_headers(settings)
    object_id = _upload_object(
        settings,
        http_session,
        headers,
        _fake_jpeg(),
        filename="clear-annotations.jpg",
        key=f"integration/{uuid.uuid4().hex}-clear-annotations.jpg",
    )["object_id"]
    field_name = f"clear_{uuid.uuid4().hex[:8]}"

    fields = http_session.post(
        f"{settings.storage_base_url}/fields",
        json={"fields": [{"field_name": field_name, "prompt": "Clear me", "response_type": "text"}]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert fields.status_code == 200, fields.text

    upsert = http_session.post(
        f"{settings.storage_base_url}/annotations/upsert",
        json={"rows": [{"object_id": object_id, "values": {field_name: "to be cleared"}}]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert upsert.status_code == 200, upsert.text
    assert upsert.json()["upserted"] == 1

    completed_before = http_session.post(
        f"{settings.storage_base_url}/annotations/completed-object-ids",
        json={"object_ids": [object_id], "field_names": [field_name]},
        timeout=settings.request_timeout_sec,
    )
    assert completed_before.status_code == 200, completed_before.text
    assert object_id in completed_before.json()["object_ids"]

    cleared = http_session.post(
        f"{settings.storage_base_url}/annotations/clear",
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json().get("status") == "cleared"

    completed_after = http_session.post(
        f"{settings.storage_base_url}/annotations/completed-object-ids",
        json={"object_ids": [object_id], "field_names": [field_name]},
        timeout=settings.request_timeout_sec,
    )
    assert completed_after.status_code == 200, completed_after.text
    assert completed_after.json()["object_ids"] == []

    search = http_session.post(
        f"{settings.storage_base_url}/search",
        json={
            "filters": [{"field_name": field_name, "value": "cleared", "match_mode": "contains"}],
            "limit": 10,
        },
        timeout=settings.request_timeout_sec,
    )
    assert search.status_code == 200, search.text
    assert search.json()["results"] == []


def test_write_endpoints_require_token(settings, http_session):
    payload = _fake_jpeg()
    upload = http_session.post(
        f"{settings.storage_base_url}/objects/upload",
        params={"bucket": settings.bucket, "filename": "x.jpg", "content_type": "image/jpeg"},
        data=payload,
        headers={"Content-Type": "image/jpeg"},
        timeout=settings.request_timeout_sec,
    )
    assert upload.status_code == 403

    upsert = http_session.post(
        f"{settings.storage_base_url}/vectors/upsert",
        json={"vectors": [{"object_id": uuid.uuid4().hex, "embedding": _fake_embedding(settings)}]},
        timeout=settings.request_timeout_sec,
    )
    assert upsert.status_code == 403

    fields = http_session.post(
        f"{settings.storage_base_url}/fields",
        json={"fields": [{"field_name": "x", "prompt": "x", "response_type": "text"}]},
        timeout=settings.request_timeout_sec,
    )
    assert fields.status_code == 403


def test_objects_count_endpoint(settings, http_session):
    before = http_session.get(
        f"{settings.storage_base_url}/objects/count",
        timeout=settings.request_timeout_sec,
    )
    assert before.status_code == 200, before.text
    before_count = int(before.json().get("count", 0))

    headers = _write_headers(settings)
    uploaded = _upload_object(
        settings,
        http_session,
        headers,
        _fake_jpeg(),
        filename="count.jpg",
        key=f"integration/{uuid.uuid4().hex}-count.jpg",
    )
    object_id = uploaded["object_id"]

    after_upload = http_session.get(
        f"{settings.storage_base_url}/objects/count",
        timeout=settings.request_timeout_sec,
    )
    assert after_upload.status_code == 200, after_upload.text
    after_upload_count = int(after_upload.json().get("count", 0))
    assert after_upload_count >= before_count + 1

    deleted = http_session.delete(
        f"{settings.storage_base_url}/objects/{object_id}",
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json().get("deleted") is True

    after_delete = http_session.get(
        f"{settings.storage_base_url}/objects/count",
        timeout=settings.request_timeout_sec,
    )
    assert after_delete.status_code == 200, after_delete.text
    after_delete_count = int(after_delete.json().get("count", 0))
    assert after_delete_count <= after_upload_count - 1
