from __future__ import annotations

from fastapi.testclient import TestClient

import backend.server.master as master


def test_health_route_returns_ok_when_model_gateway_ok(monkeypatch) -> None:
    monkeypatch.setattr(master.model_gateway, "health", lambda: {"status": "ok", "mode": "rabbitmq"})

    client = TestClient(master.app)
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_health_route_returns_503_when_model_gateway_unhealthy(monkeypatch) -> None:
    monkeypatch.setattr(
        master.model_gateway,
        "health",
        lambda: {"status": "error", "error": "missing consumers"},
    )

    client = TestClient(master.app)
    response = client.get("/health")

    assert response.status_code == 503
    payload = response.json()
    assert payload["detail"]["status"] == "degraded"


def test_search_text_route_end_to_end_in_process(monkeypatch) -> None:
    monkeypatch.setattr(master, "_search_dependencies_ready", lambda: (True, ""))
    monkeypatch.setattr(master, "_embed_text", lambda client, text: ([0.2, 0.8], 2))
    monkeypatch.setattr(
        master.storage_api,
        "query_vectors",
        lambda embedding, top_k: [{"object_id": "obj-42", "similarity": 0.99}],
    )

    client = TestClient(master.app)
    response = client.post("/search/text", json={"query": "road", "top_k": 5, "max_rows": 100})

    assert response.status_code == 200
    assert response.json() == {
        "mode": "vector_server",
        "results": [{"object_id": "obj-42", "similarity": 0.99}],
    }


def test_vlm_fields_route_reads_from_analytics_api(monkeypatch) -> None:
    monkeypatch.setattr(
        master.analytics_api,
        "get_fields",
        lambda: [{"field_name": "weather", "prompt": "Describe weather", "response_type": "text"}],
    )

    client = TestClient(master.app)
    response = client.get("/vlm/fields")

    assert response.status_code == 200
    assert response.json()["fields"][0]["field_name"] == "weather"


def test_backfill_embeddings_route_returns_started_job(monkeypatch) -> None:
    monkeypatch.setattr(master, "_start_backfill_embeddings_job", lambda payload: "job-123")

    client = TestClient(master.app)
    response = client.post("/embeddings/backfill", json={"limit": 10, "batch_size": 2})

    assert response.status_code == 200
    assert response.json() == {"job_id": "job-123", "status": "started"}


def test_backfill_vlm_route_accepts_combined_json_and_batch_flags(monkeypatch) -> None:
    monkeypatch.setattr(master, "_start_vlm_backfill_job", lambda payload: "job-vlm-1")

    client = TestClient(master.app)
    response = client.post(
        "/vlm/backfill",
        json={
            "limit": 10,
            "batch_size": 2,
            "combine_fields_into_json": True,
            "combined_prompt": "Return compact JSON with all fields.",
            "use_openai_batch_api": True,
        },
    )

    assert response.status_code == 200
    assert response.json() == {"job_id": "job-vlm-1", "status": "started"}


def test_openai_batch_status_route(monkeypatch) -> None:
    class _FakeBatches:
        def retrieve(self, batch_id: str):
            assert batch_id == "batch_123"

            class _Batch:
                id = "batch_123"
                status = "in_progress"
                request_counts = {"total": 10, "completed": 3, "failed": 0}
                input_file_id = "file_in"
                output_file_id = None
                error_file_id = None
                endpoint = "/v1/chat/completions"
                completion_window = "24h"
                metadata = {"source": "test"}

            return _Batch()

    class _FakeClient:
        batches = _FakeBatches()

    monkeypatch.setattr(master, "_create_openai_client_for_vlm_batch", lambda: _FakeClient())

    client = TestClient(master.app)
    response = client.post("/vlm/openai/batch/status", json={"batch_id": "batch_123"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["id"] == "batch_123"
    assert payload["status"] == "in_progress"
