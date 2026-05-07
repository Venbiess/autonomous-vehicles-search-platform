from __future__ import annotations

from typing import Any, Dict

from backend.server.storage_api import StorageAPI


class _FakeResponse:
    def __init__(self, payload: Dict[str, Any]):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> Dict[str, Any]:
        return self._payload


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list[Dict[str, Any]] = []

    def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"url": url, **kwargs})
        return _FakeResponse({"object_id": "obj-1", "storage_path": "s3://avsp/file.jpg"})


def test_upload_object_uses_raw_body_and_headers() -> None:
    api = StorageAPI("http://storage-server:9012", 30, "token-123")
    fake_client = _FakeClient()
    api._client = fake_client

    payload = b"jpeg-bytes"
    result = api.upload_object(
        filename="/tmp/example/frame.jpg",
        data=payload,
        bucket="synthetic",
        key="synthetic/frame.jpg",
        content_type="image/jpeg",
    )

    assert result["object_id"] == "obj-1"
    assert len(fake_client.calls) == 1

    call = fake_client.calls[0]
    assert call["url"] == "http://storage-server:9012/objects/upload"
    assert call["params"] == {
        "filename": "frame.jpg",
        "bucket": "synthetic",
        "key": "synthetic/frame.jpg",
        "content_type": "image/jpeg",
    }
    assert call["content"] == payload
    assert call["headers"]["Content-Type"] == "image/jpeg"
    assert call["headers"]["X-Storage-Write-Token"] == "token-123"
