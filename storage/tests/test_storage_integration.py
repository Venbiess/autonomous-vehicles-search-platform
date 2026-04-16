from __future__ import annotations

import base64
import uuid

def _write_headers(settings) -> dict[str, str]:
    token = settings.write_token.strip()
    if not token:
        return {}
    return {"X-Storage-Write-Token": token}


def _upload_image(s3_client, settings, prefix: str = "integration") -> dict[str, str | bytes]:
    key = f"{prefix}/{uuid.uuid4().hex}.jpg"
    payload = b"\xff\xd8\xff\xe0AVSP-TEST-" + uuid.uuid4().hex.encode("ascii") + b"\xff\xd9"
    s3_client.put_object(
        Bucket=settings.bucket,
        Key=key,
        Body=payload,
        ContentType="image/jpeg",
    )
    return {
        "bucket": settings.bucket,
        "key": key,
        "bytes": payload,
        "storage_path": f"s3://{settings.bucket}/{key}",
        "storage_path_short": f"{settings.bucket}/{key}",
    }


def _resolve_object_id(settings, http_session, headers, storage_path: str) -> str:
    response = http_session.post(
        f"{settings.storage_base_url}/objects/resolve-path",
        json={"storage_path": storage_path},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert response.status_code == 200, response.text
    return response.json()["object_id"]


def test_health_ready_and_metrics(settings, http_session):
    health = http_session.get(
        f"{settings.storage_base_url}/health",
        timeout=settings.request_timeout_sec,
    )
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    ready = http_session.get(
        f"{settings.storage_base_url}/ready",
        timeout=settings.request_timeout_sec,
    )
    assert ready.status_code == 200

    metrics = http_session.get(
        f"{settings.storage_base_url}/metrics",
        timeout=settings.request_timeout_sec,
    )
    assert metrics.status_code == 200
    assert "avsp_storage_http_requests_total" in metrics.text


def test_resolve_path_is_canonical_and_idempotent(settings, http_session, uploaded_object):
    headers = _write_headers(settings)

    resp_full = http_session.post(
        f"{settings.storage_base_url}/objects/resolve-path",
        json={"storage_path": uploaded_object["storage_path"]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert resp_full.status_code == 200, resp_full.text
    object_id_full = resp_full.json()["object_id"]

    resp_short = http_session.post(
        f"{settings.storage_base_url}/objects/resolve-path",
        json={"storage_path": uploaded_object["storage_path_short"]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert resp_short.status_code == 200, resp_short.text
    object_id_short = resp_short.json()["object_id"]

    assert object_id_full == object_id_short

    meta = http_session.get(
        f"{settings.storage_base_url}/objects/{object_id_full}",
        timeout=settings.request_timeout_sec,
    )
    assert meta.status_code == 200, meta.text
    body = meta.json()
    assert body["object_id"] == object_id_full
    assert body["storage_path"] == uploaded_object["storage_path"]
    assert body["bucket"] == uploaded_object["bucket"]
    assert body["key"] == uploaded_object["key"]


def test_get_content_and_batch(settings, http_session, uploaded_object):
    headers = _write_headers(settings)

    resolve = http_session.post(
        f"{settings.storage_base_url}/objects/resolve-path",
        json={"storage_path": uploaded_object["storage_path"]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert resolve.status_code == 200, resolve.text
    object_id = resolve.json()["object_id"]

    single = http_session.get(
        f"{settings.storage_base_url}/objects/{object_id}/content",
        timeout=settings.request_timeout_sec,
    )
    assert single.status_code == 200, single.text
    assert single.content == uploaded_object["bytes"]
    assert "image/jpeg" in single.headers.get("content-type", "")

    batch = http_session.post(
        f"{settings.storage_base_url}/objects/get-batch",
        json={"object_ids": [object_id]},
        timeout=settings.request_timeout_sec,
    )
    assert batch.status_code == 200, batch.text
    items = batch.json()["items"]
    assert len(items) == 1
    assert items[0]["object_id"] == object_id
    assert items[0].get("error", "") == ""
    assert items[0]["size_bytes"] == len(uploaded_object["bytes"])
    assert base64.b64decode(items[0]["content_base64"]) == uploaded_object["bytes"]


def test_vector_upsert_query_delete_cascade(settings, http_session, uploaded_object):
    headers = _write_headers(settings)

    resolve = http_session.post(
        f"{settings.storage_base_url}/objects/resolve-path",
        json={"storage_path": uploaded_object["storage_path"]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert resolve.status_code == 200, resolve.text
    object_id = resolve.json()["object_id"]

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
    assert len(results) >= 1
    assert any(item["object_id"] == object_id for item in results)

    delete = http_session.delete(
        f"{settings.storage_base_url}/objects/{object_id}",
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert delete.status_code == 200, delete.text
    assert delete.json()["deleted"] is True

    content_after = http_session.get(
        f"{settings.storage_base_url}/objects/{object_id}/content",
        timeout=settings.request_timeout_sec,
    )
    assert content_after.status_code == 404

    query_after = http_session.post(
        f"{settings.storage_base_url}/vectors/query",
        json={"embedding": vector, "top_k": 10},
        timeout=settings.request_timeout_sec,
    )
    assert query_after.status_code == 200, query_after.text
    object_ids = {item["object_id"] for item in query_after.json()["results"]}
    assert object_id not in object_ids


def test_user_flow_register_many_list_and_paginate(settings, http_session, s3_client):
    headers = _write_headers(settings)
    obj1 = _upload_image(s3_client, settings)
    obj2 = _upload_image(s3_client, settings)

    _ = _resolve_object_id(settings, http_session, headers, str(obj1["storage_path"]))
    _ = _resolve_object_id(settings, http_session, headers, str(obj2["storage_path"]))

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
        params={"limit": 50, "cursor": data1["next_cursor"]},
        timeout=settings.request_timeout_sec,
    )
    assert page2.status_code == 200, page2.text
    assert isinstance(page2.json()["items"], list)


def test_register_paths_batch(settings, http_session, s3_client):
    headers = _write_headers(settings)
    obj1 = _upload_image(s3_client, settings, prefix="register-paths")
    obj2 = _upload_image(s3_client, settings, prefix="register-paths")

    response = http_session.post(
        f"{settings.storage_base_url}/objects/register-paths",
        json={"storage_paths": [obj1["storage_path"], obj2["storage_path_short"]]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 2
    assert all(item["object_id"] for item in items)
    assert items[0]["storage_path"].startswith(f"s3://{settings.bucket}/")


def test_user_flow_batch_retrieval_with_partial_miss(settings, http_session, uploaded_object):
    headers = _write_headers(settings)
    object_id = _resolve_object_id(settings, http_session, headers, uploaded_object["storage_path"])

    response = http_session.post(
        f"{settings.storage_base_url}/objects/get-batch",
        json={"object_ids": [object_id, uuid.uuid4().hex]},
        headers=headers,
        timeout=settings.request_timeout_sec,
    )
    assert response.status_code == 200, response.text
    items = {item["object_id"]: item for item in response.json()["items"]}
    assert object_id in items
    assert items[object_id].get("error", "") == ""
    assert base64.b64decode(items[object_id]["content_base64"]) == uploaded_object["bytes"]
    missing_items = [it for it in response.json()["items"] if it["object_id"] != object_id]
    assert missing_items and missing_items[0].get("error", "") != ""
