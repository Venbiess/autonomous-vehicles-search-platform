from __future__ import annotations

import base64
import uuid


def _write_headers(settings) -> dict[str, str]:
    token = settings.write_token.strip()
    if not token:
        return {}
    return {"X-Storage-Write-Token": token}


def _fake_jpeg() -> bytes:
    return b"\xff\xd8\xff\xe0AVSP-TEST-" + uuid.uuid4().hex.encode("ascii") + b"\xff\xd9"


def _upload_object(settings, http_session, headers, payload: bytes, filename: str = "image.jpg", key: str | None = None):
    data = {"bucket": settings.bucket}
    if key:
        data["key"] = key
    response = http_session.post(
        f"{settings.storage_base_url}/objects/upload",
        data=data,
        files={"file": (filename, payload, "image/jpeg")},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert response.status_code == 200, response.text
    return response.json()


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
    assert uploaded["storage_path"] == f"s3://{settings.bucket}/{key}"
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
        json={"object_ids": [up1["object_id"], up2["object_id"], uuid.uuid4().hex]},
        timeout=settings.request_timeout_sec,
    )
    assert batch.status_code == 200, batch.text
    items = {item["object_id"]: item for item in batch.json()["items"]}
    assert base64.b64decode(items[up1["object_id"]]["content_base64"]) == payload1
    assert base64.b64decode(items[up2["object_id"]]["content_base64"]) == payload2
    missing = [it for it in batch.json()["items"] if it["object_id"] not in {up1["object_id"], up2["object_id"]}]
    assert missing and missing[0].get("error", "") != ""


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

    vector = [0.1, 0.2, 0.3, 0.4]
    upsert = http_session.post(
        f"{settings.storage_base_url}/vectors/upsert",
        json={"vectors": [{"object_id": object_id, "embedding": vector}]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert upsert.status_code == 200, upsert.text
    assert upsert.json()["upserted"] == 1

    query = http_session.post(
        f"{settings.storage_base_url}/vectors/query",
        json={"embedding": vector, "top_k": 5},
        timeout=settings.request_timeout_sec,
    )
    assert query.status_code == 200, query.text
    results = query.json()["results"]
    assert any(item["object_id"] == object_id for item in results)

    count_after_upsert = http_session.get(
        f"{settings.storage_base_url}/vectors/count",
        timeout=settings.request_timeout_sec,
    )
    assert count_after_upsert.status_code == 200, count_after_upsert.text
    assert int(count_after_upsert.json().get("count", 0)) >= before_val + 1

    delete = http_session.delete(
        f"{settings.storage_base_url}/objects/{object_id}",
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert delete.status_code == 200, delete.text
    assert delete.json()["deleted"] is True

    query_after = http_session.post(
        f"{settings.storage_base_url}/vectors/query",
        json={"embedding": vector, "top_k": 10},
        timeout=settings.request_timeout_sec,
    )
    assert query_after.status_code == 200, query_after.text
    assert object_id not in {item["object_id"] for item in query_after.json()["results"]}


def test_write_endpoints_require_token(settings, http_session):
    payload = _fake_jpeg()
    upload = http_session.post(
        f"{settings.storage_base_url}/objects/upload",
        data={"bucket": settings.bucket},
        files={"file": ("x.jpg", payload, "image/jpeg")},
        timeout=settings.request_timeout_sec,
    )
    assert upload.status_code == 403

    upsert = http_session.post(
        f"{settings.storage_base_url}/vectors/upsert",
        json={"vectors": [{"object_id": uuid.uuid4().hex, "embedding": [0.1, 0.2, 0.3, 0.4]}]},
        timeout=settings.request_timeout_sec,
    )
    assert upsert.status_code == 403
