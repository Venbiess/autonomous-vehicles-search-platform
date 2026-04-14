from __future__ import annotations

from typing import Dict

import httpx


class CoordinatorAPI:
    def __init__(self, endpoint: str, timeout_sec: int):
        self.endpoint = endpoint.rstrip("/")
        self.timeout = httpx.Timeout(timeout_sec)

    def workflow_vector_upsert(
        self,
        object_id: str,
        embedding: list[float],
        source: str = "",
        idempotency_key: str = "",
    ) -> Dict[str, object]:
        headers = {"X-Idempotency-Key": idempotency_key} if idempotency_key else None
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.endpoint}/coordinator/workflows/vector-upsert",
                json={
                    "object_id": object_id,
                    "embedding": embedding,
                    "source": source,
                },
                headers=headers,
            )
            response.raise_for_status()
            return response.json()

    def workflow_register_path(
        self,
        storage_path: str,
        source: str = "",
        idempotency_key: str = "",
    ) -> Dict[str, object]:
        headers = {"X-Idempotency-Key": idempotency_key} if idempotency_key else None
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.endpoint}/coordinator/workflows/register-path",
                json={
                    "storage_path": storage_path,
                    "source": source,
                },
                headers=headers,
            )
            response.raise_for_status()
            return response.json()

    def workflow_delete_object(
        self,
        object_id: str,
        source: str = "",
        idempotency_key: str = "",
    ) -> Dict[str, object]:
        headers = {"X-Idempotency-Key": idempotency_key} if idempotency_key else None
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.endpoint}/coordinator/workflows/delete-object",
                json={
                    "object_id": object_id,
                    "source": source,
                },
                headers=headers,
            )
            response.raise_for_status()
            return response.json()
