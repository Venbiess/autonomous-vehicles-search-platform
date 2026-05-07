from __future__ import annotations

import asyncio
from typing import Any

import httpx
from fastapi import HTTPException

import backend.server.master as master


class _FakeRequest:
    def __init__(self, body: bytes):
        self._body = body

    async def body(self) -> bytes:
        return self._body


class _FakeClient:
    def __init__(self) -> None:
        self.entered = 0

    def __enter__(self):
        self.entered += 1
        return self

    def __exit__(self, exc_type, exc, tb):
        return None


def test_search_text_returns_empty_when_dependencies_not_ready(monkeypatch) -> None:
    monkeypatch.setattr(master, "_search_dependencies_ready", lambda: (False, "embedder down"))

    result = master.search_text(master.TextSearchRequest(query="road", top_k=5))

    assert result == {"mode": "vector_server", "results": []}


def test_search_text_happy_path(monkeypatch) -> None:
    fake_client = _FakeClient()
    monkeypatch.setattr(master.httpx, "Client", lambda timeout: fake_client)
    monkeypatch.setattr(master, "_search_dependencies_ready", lambda: (True, ""))
    monkeypatch.setattr(master, "_embed_text", lambda client, text: ([0.1, 0.2], 2))
    monkeypatch.setattr(
        master.storage_api,
        "query_vectors",
        lambda embedding, top_k: [{"object_id": "obj-1", "distance": 0.01}],
    )

    result = master.search_text(master.TextSearchRequest(query="road", top_k=3))

    assert fake_client.entered == 1
    assert result["mode"] == "vector_server"
    assert result["results"] == [{"object_id": "obj-1", "distance": 0.01}]


def test_search_text_returns_empty_on_storage_unavailable(monkeypatch) -> None:
    fake_client = _FakeClient()
    monkeypatch.setattr(master.httpx, "Client", lambda timeout: fake_client)
    monkeypatch.setattr(master, "_search_dependencies_ready", lambda: (True, ""))
    monkeypatch.setattr(master, "_embed_text", lambda client, text: ([0.1, 0.2], 2))

    def _fail(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        raise httpx.RequestError("storage unavailable")

    monkeypatch.setattr(master.storage_api, "query_vectors", _fail)

    result = master.search_text(master.TextSearchRequest(query="road", top_k=3))

    assert result == {"mode": "vector_server", "results": []}


def test_search_text_raises_502_on_unexpected_error(monkeypatch) -> None:
    fake_client = _FakeClient()
    monkeypatch.setattr(master.httpx, "Client", lambda timeout: fake_client)
    monkeypatch.setattr(master, "_search_dependencies_ready", lambda: (True, ""))
    monkeypatch.setattr(master, "_embed_text", lambda client, text: ([0.1, 0.2], 2))

    def _fail(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        raise RuntimeError("boom")

    monkeypatch.setattr(master.storage_api, "query_vectors", _fail)

    try:
        master.search_text(master.TextSearchRequest(query="road", top_k=3))
    except HTTPException as exc:
        assert exc.status_code == 502
        assert exc.detail == "boom"
    else:
        raise AssertionError("expected HTTPException")


def test_search_image_bytes_rejects_empty_payload() -> None:
    try:
        asyncio.run(master.search_image_bytes(_FakeRequest(b""), top_k=5))
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Image bytes are required"
    else:
        raise AssertionError("expected HTTPException")


def test_search_image_bytes_happy_path(monkeypatch) -> None:
    fake_client = _FakeClient()
    monkeypatch.setattr(master.httpx, "Client", lambda timeout: fake_client)
    monkeypatch.setattr(master, "_search_dependencies_ready", lambda: (True, ""))
    monkeypatch.setattr(master, "_embed_image", lambda client, payload: ([0.3, 0.4], 2))
    monkeypatch.setattr(
        master.storage_api,
        "query_vectors",
        lambda embedding, top_k: [{"object_id": "obj-2", "distance": 0.02}],
    )

    result = asyncio.run(master.search_image_bytes(_FakeRequest(b"jpeg-bytes"), top_k=7))

    assert fake_client.entered == 1
    assert result["results"] == [{"object_id": "obj-2", "distance": 0.02}]


def test_search_image_bytes_returns_empty_when_dependencies_not_ready(monkeypatch) -> None:
    monkeypatch.setattr(master, "_search_dependencies_ready", lambda: (False, "storage down"))

    result = asyncio.run(master.search_image_bytes(_FakeRequest(b"jpeg-bytes"), top_k=4))

    assert result == {"mode": "vector_server", "results": []}
