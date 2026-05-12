from __future__ import annotations

from typing import Any, Dict

from backend.server.analytics_api import AnalyticsAPI


class _FakeResponse:
    def __init__(self, payload: Dict[str, Any]):
        self._payload = payload
        self.is_success = True
        self.status_code = 200

    def raise_for_status(self) -> None:
        return None

    def json(self) -> Dict[str, Any]:
        return self._payload


class _FakeClient:
    calls: list[Dict[str, Any]] = []
    response_payload: Dict[str, Any] = {}
    response_fn = None

    def __init__(self, timeout=None):
        self.timeout = timeout

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return None

    def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"method": "GET", "url": url, **kwargs})
        response_fn = type(self).response_fn
        if response_fn is not None:
            payload = response_fn("GET", url, kwargs)
            return _FakeResponse(payload)
        return _FakeResponse(dict(self.response_payload))

    def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"method": "POST", "url": url, **kwargs})
        response_fn = type(self).response_fn
        if response_fn is not None:
            payload = response_fn("POST", url, kwargs)
            return _FakeResponse(payload)
        return _FakeResponse(dict(self.response_payload))


def test_get_fields_sends_joined_field_names(monkeypatch) -> None:
    _FakeClient.calls = []
    _FakeClient.response_payload = {"fields": [{"field_name": "weather"}]}
    monkeypatch.setattr("backend.server.analytics_api.httpx.Client", _FakeClient)

    api = AnalyticsAPI("http://storage-server:9012", 10, "secret")
    fields = api.get_fields(["weather", "road_type"])

    assert fields == [{"field_name": "weather"}]
    call = _FakeClient.calls[0]
    assert call["method"] == "GET"
    assert call["url"] == "http://storage-server:9012/fields"
    assert call["params"] == {"field_names": "weather,road_type"}


def test_upsert_fields_and_annotations_send_write_token(monkeypatch) -> None:
    _FakeClient.calls = []
    _FakeClient.response_payload = {"fields": [{"field_name": "scene"}]}
    monkeypatch.setattr("backend.server.analytics_api.httpx.Client", _FakeClient)

    api = AnalyticsAPI("http://storage-server:9012", 10, "secret")
    result = api.upsert_fields(
        [{"field_name": "scene", "prompt": "Describe", "response_type": "text"}],
        replace_missing=True,
        purge_deleted_values=True,
    )

    assert result == [{"field_name": "scene"}]
    call = _FakeClient.calls[0]
    assert call["headers"]["X-Storage-Write-Token"] == "secret"
    assert call["json"]["replace_missing"] is True
    assert call["json"]["purge_deleted_values"] is True

    _FakeClient.calls = []
    _FakeClient.response_payload = {"upserted": 2}
    upserted = api.upsert_annotations(
        [{"object_id": "obj-1", "values": {"scene": "sunny"}}]
    )
    assert upserted == 2
    assert _FakeClient.calls[0]["headers"]["X-Storage-Write-Token"] == "secret"


def test_completed_object_ids_short_circuits_empty_inputs(monkeypatch) -> None:
    _FakeClient.calls = []
    _FakeClient.response_fn = None
    monkeypatch.setattr("backend.server.analytics_api.httpx.Client", _FakeClient)
    api = AnalyticsAPI("http://storage-server:9012", 10)

    assert api.completed_object_ids([], ["field"]) == []
    assert api.completed_object_ids(["obj"], []) == []
    assert _FakeClient.calls == []


def test_completed_object_ids_chunks_large_requests(monkeypatch) -> None:
    _FakeClient.calls = []

    def _response(method: str, _url: str, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        assert method == "POST"
        req_ids = kwargs.get("json", {}).get("object_ids", [])
        # Return one completed id per chunk to prove chunk fanout/merge works.
        return {"object_ids": [req_ids[0]] if req_ids else []}

    _FakeClient.response_fn = _response
    monkeypatch.setattr("backend.server.analytics_api.httpx.Client", _FakeClient)
    api = AnalyticsAPI("http://storage-server:9012", 10)

    object_ids = [f"obj-{idx}" for idx in range(1200)]
    completed = api.completed_object_ids(object_ids, ["field-a"])

    assert completed == ["obj-0", "obj-500", "obj-1000"]
    assert len(_FakeClient.calls) == 3
    assert [len(call["json"]["object_ids"]) for call in _FakeClient.calls] == [500, 500, 200]
