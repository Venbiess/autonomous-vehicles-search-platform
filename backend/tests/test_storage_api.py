from __future__ import annotations

import base64
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


class _BatchResponse:
    def __init__(self, status_code: int, payload: Dict[str, Any]):
        self.status_code = status_code
        self._payload = payload
        self.is_error = status_code >= 400
        self.text = str(payload)

    def json(self) -> Dict[str, Any]:
        return self._payload


class _BatchClient:
    def __init__(self, responses: list[_BatchResponse]) -> None:
        self.responses = responses
        self.calls: list[Dict[str, Any]] = []

    def post(self, url: str, **kwargs: Any) -> _BatchResponse:
        self.calls.append({"url": url, **kwargs})
        if not self.responses:
            raise AssertionError("No queued fake responses left")
        return self.responses.pop(0)


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


def test_get_object_bytes_batch_falls_back_when_include_content_unknown() -> None:
    encoded = base64.b64encode(b"abc").decode()
    api = StorageAPI("http://storage-server:9012", 30, "token-123")
    fake_client = _BatchClient(
        responses=[
            _BatchResponse(
                400,
                {"error": {"message": 'json: unknown field "include_content"'}},
            ),
            _BatchResponse(
                200,
                {
                    "items": [
                        {
                            "object_id": "obj-1",
                            "content_base64": encoded,
                            "content_type": "image/jpeg",
                            "size_bytes": 3,
                        }
                    ]
                },
            ),
        ]
    )
    api._client = fake_client

    rows = api.get_object_bytes_batch(["obj-1"])

    assert len(rows) == 1
    assert rows[0]["object_id"] == "obj-1"
    assert rows[0]["content"] == b"abc"
    assert len(fake_client.calls) == 2
    assert fake_client.calls[0]["json"] == {
        "object_ids": ["obj-1"],
        "include_content": True,
    }
    assert fake_client.calls[1]["json"] == {"object_ids": ["obj-1"]}


def test_get_object_bytes_batch_caches_fallback_mode() -> None:
    encoded = base64.b64encode(b"xyz").decode()
    api = StorageAPI("http://storage-server:9012", 30, "token-123")
    fake_client = _BatchClient(
        responses=[
            _BatchResponse(
                400,
                {"error": {"message": 'json: unknown field "include_content"'}},
            ),
            _BatchResponse(200, {"items": []}),
            _BatchResponse(
                200,
                {
                    "items": [
                        {
                            "object_id": "obj-2",
                            "content_base64": encoded,
                            "content_type": "image/jpeg",
                            "size_bytes": 3,
                        }
                    ]
                },
            ),
        ]
    )
    api._client = fake_client

    api.get_object_bytes_batch(["obj-1"])
    rows = api.get_object_bytes_batch(["obj-2"])

    assert rows[0]["content"] == b"xyz"
    # first request: 2 calls (with and without include_content), second request: only fallback call
    assert len(fake_client.calls) == 3
    assert fake_client.calls[2]["json"] == {"object_ids": ["obj-2"]}
