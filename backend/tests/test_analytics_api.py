from __future__ import annotations

from typing import Any, Dict

from backend.server.analytics_api import AnalyticsAPI


class _FakeResponse:
    def __init__(self, payload: Dict[str, Any]):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> Dict[str, Any]:
        return self._payload


class _FakeClient:
    calls: list[Dict[str, Any]] = []
    response_payload: Dict[str, Any] = {}

    def __init__(self, timeout=None):
        self.timeout = timeout

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return None

    def get(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"method": "GET", "url": url, **kwargs})
        return _FakeResponse(dict(self.response_payload))

    def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"method": "POST", "url": url, **kwargs})
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
    monkeypatch.setattr("backend.server.analytics_api.httpx.Client", _FakeClient)
    api = AnalyticsAPI("http://storage-server:9012", 10)

    assert api.completed_object_ids([], ["field"]) == []
    assert api.completed_object_ids(["obj"], []) == []
    assert _FakeClient.calls == []
