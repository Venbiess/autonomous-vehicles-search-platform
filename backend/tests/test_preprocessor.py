from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from backend.processors.preprocessor import Preprocessor


class _DummyPreprocessor(Preprocessor):
    def __iter__(self):
        return self

    def __next__(self):
        raise StopIteration


class _FakeResponse:
    def __init__(self, payload: Dict[str, Any]):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> Dict[str, Any]:
        return self._payload


def test_upload_to_storage_posts_raw_image_bytes(monkeypatch, tmp_path: Path) -> None:
    image_path = tmp_path / "frame.jpg"
    image_bytes = b"\xff\xd8test-image\xff\xd9"
    image_path.write_bytes(image_bytes)

    captured: Dict[str, Any] = {}

    def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
        body = kwargs["data"].read()
        captured.update({"url": url, **kwargs, "body": body})
        return _FakeResponse({"object_id": "obj-2", "storage_path": "s3://synthetic/frame.jpg"})

    monkeypatch.setattr("backend.processors.preprocessor.requests.post", fake_post)

    preprocessor = _DummyPreprocessor(remove_local_images=False)
    payload = preprocessor.upload_to_storage(
        str(image_path),
        bucket="synthetic",
        object_name="synthetic/frame.jpg",
    )

    assert payload is not None
    assert payload["object_id"] == "obj-2"
    assert captured["url"].endswith("/objects/upload")
    assert captured["params"]["bucket"] == "synthetic"
    assert captured["params"]["key"] == "synthetic/frame.jpg"
    assert captured["params"]["filename"] == "frame.jpg"
    assert captured["headers"]["Content-Type"] == "image/jpeg"
    assert captured["body"] == image_bytes
