from __future__ import annotations

from typing import Any

import backend.server.master as master


class _FakeHTTPResponse:
    def __init__(self, status_code: int = 200):
        self.status_code = status_code
        self.is_success = 200 <= status_code < 300


class _FakeHTTPClient:
    def __init__(self, response: _FakeHTTPResponse):
        self._response = response
        self.urls: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return None

    def get(self, url: str, **kwargs: Any) -> _FakeHTTPResponse:
        del kwargs
        self.urls.append(url)
        return self._response


def test_search_dependencies_ready_prefers_embedder_http(monkeypatch) -> None:
    fake_client = _FakeHTTPClient(_FakeHTTPResponse(200))

    monkeypatch.setattr(master, "EMBEDDER_ENDPOINT", "http://embedder-worker:8000")
    monkeypatch.setattr(master.httpx, "Client", lambda timeout: fake_client)
    monkeypatch.setattr(master.storage_api, "health", lambda: {"status": "ok"})
    monkeypatch.setattr(master.model_gateway, "health", lambda: {"status": "error"})

    ready, reason = master._search_dependencies_ready(
        require_embedder=True,
        require_vlm=False,
        allow_embedder_http_fallback=True,
    )

    assert ready is True
    assert reason == ""
    assert fake_client.urls == ["http://embedder-worker:8000/health"]


def test_search_dependencies_ready_fails_on_storage_health(monkeypatch) -> None:
    fake_client = _FakeHTTPClient(_FakeHTTPResponse(200))

    monkeypatch.setattr(master, "EMBEDDER_ENDPOINT", "http://embedder-worker:8000")
    monkeypatch.setattr(master.httpx, "Client", lambda timeout: fake_client)
    monkeypatch.setattr(master.model_gateway, "health", lambda: {"status": "ok"})
    monkeypatch.setattr(master.storage_api, "health", lambda: {"status": "error", "detail": "db down"})

    ready, reason = master._search_dependencies_ready()

    assert ready is False
    assert "storage backend not ready" in reason


def test_search_dependencies_ready_waits_for_rabbit_consumers(monkeypatch) -> None:
    states = iter(
        [
            {
                "status": "error",
                "mode": "rabbitmq",
                "rabbitmq": {
                    "queues": {
                        "avsp.embedder.tasks": {"messages": 0, "consumers": 0},
                        "avsp.vlm.tasks": {"messages": 0, "consumers": 0},
                    }
                },
            },
            {
                "status": "ok",
                "mode": "rabbitmq",
                "rabbitmq": {
                    "queues": {
                        "avsp.embedder.tasks": {"messages": 0, "consumers": 1},
                        "avsp.vlm.tasks": {"messages": 0, "consumers": 0},
                    }
                },
            },
        ]
    )

    monkeypatch.setenv("MODEL_BACKEND_READY_WAIT_SEC", "1")
    monkeypatch.setenv("MODEL_BACKEND_READY_POLL_SEC", "0.01")
    monkeypatch.setattr(master.time, "sleep", lambda _: None)
    monkeypatch.setattr(master.storage_api, "health", lambda: {"status": "ok"})
    monkeypatch.setattr(master.model_gateway, "health", lambda: next(states))

    ready, reason = master._search_dependencies_ready(require_embedder=True, require_vlm=False)

    assert ready is True
    assert reason == ""
