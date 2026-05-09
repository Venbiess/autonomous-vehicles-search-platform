from __future__ import annotations

from typing import Any, Dict

from backend.server.model_bus import ModelGateway


class _FakeResponse:
    def __init__(self, payload: Dict[str, Any]):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> Dict[str, Any]:
        return self._payload


class _FakeHTTPClient:
    def __init__(self) -> None:
        self.calls: list[Dict[str, Any]] = []

    def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"url": url, **kwargs})
        if url.endswith("/embedding/text"):
            return _FakeResponse({"embedding": [0.1, 0.2], "dim": 2})
        return _FakeResponse({"embedding": [0.3, 0.4], "dim": 2})


class _FakeRPC:
    def __init__(self, snapshot: Dict[str, Any], probes: Dict[str, bool] | None = None) -> None:
        self._snapshot = snapshot
        self._probes = probes or {}

    def health_snapshot(self) -> Dict[str, Any]:
        return self._snapshot

    def probe_queue(self, queue_name: str) -> bool:
        return bool(self._probes.get(queue_name, False))


def test_embedder_http_round_robin(monkeypatch) -> None:
    monkeypatch.setenv("EMBEDDER_ENDPOINTS", "http://embedder-a:8000,http://embedder-b:8000")
    gateway = ModelGateway()
    gateway._rpc = None

    client = _FakeHTTPClient()
    gateway.embed_text_http(client, "http://fallback:8000", "road")
    gateway.embed_text_http(client, "http://fallback:8000", "car")

    assert client.calls[0]["url"] == "http://embedder-a:8000/embedding/text"
    assert client.calls[1]["url"] == "http://embedder-b:8000/embedding/text"


def test_health_reports_missing_consumers(monkeypatch) -> None:
    monkeypatch.delenv("EMBEDDER_ENDPOINTS", raising=False)
    gateway = ModelGateway()
    gateway._rpc = _FakeRPC(
        {
            "connected": True,
            "queues": {
                "avsp.embedder.tasks": {"messages": 0, "consumers": 0},
                "avsp.vlm.tasks": {"messages": 0, "consumers": 1},
            },
        },
        probes={
            "avsp.embedder.tasks": False,
            "avsp.vlm.tasks": True,
        },
    )

    health = gateway.health()

    assert health["status"] == "error"
    assert health["missing_consumers"] == ["avsp.embedder.tasks"]
