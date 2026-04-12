from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx


class StorageAPI:
    def __init__(
        self,
        object_endpoint: str,
        vector_endpoint: str,
        object_timeout_sec: int,
        vector_timeout_sec: int,
    ):
        self.object_endpoint = object_endpoint.rstrip("/")
        self.vector_endpoint = vector_endpoint.rstrip("/")
        self.object_timeout_sec = object_timeout_sec
        self.vector_timeout_sec = vector_timeout_sec

    def resolve_object_id(self, storage_path: str) -> str:
        with httpx.Client(timeout=httpx.Timeout(self.object_timeout_sec)) as client:
            response = client.post(
                f"{self.object_endpoint}/objects/resolve-path",
                json={"storage_path": storage_path},
            )
            response.raise_for_status()
            payload = response.json()
        return payload["object_id"]

    def get_object_bytes(self, object_id: str) -> tuple[bytes, str]:
        with httpx.Client(timeout=httpx.Timeout(self.object_timeout_sec)) as client:
            response = client.get(f"{self.object_endpoint}/objects/{object_id}/content")
            response.raise_for_status()
            return response.content, response.headers.get(
                "content-type", "application/octet-stream"
            )

    def get_object_meta(self, object_id: str) -> Dict[str, Any]:
        with httpx.Client(timeout=httpx.Timeout(self.object_timeout_sec)) as client:
            response = client.get(f"{self.object_endpoint}/objects/{object_id}")
            response.raise_for_status()
            return response.json()

    def query_vectors(self, embedding: List[float], top_k: int) -> List[Dict[str, Any]]:
        with httpx.Client(timeout=httpx.Timeout(self.vector_timeout_sec)) as client:
            response = client.post(
                f"{self.vector_endpoint}/vectors/query",
                json={"embedding": embedding, "top_k": top_k},
            )
            response.raise_for_status()
            payload = response.json()
        return payload.get("results", [])

    def register_paths(self, storage_paths: List[str]) -> List[Dict[str, str]]:
        if not storage_paths:
            return []
        with httpx.Client(timeout=httpx.Timeout(self.object_timeout_sec)) as client:
            response = client.post(
                f"{self.object_endpoint}/objects/register-paths",
                json={"storage_paths": storage_paths},
            )
            response.raise_for_status()
            payload = response.json()
        return payload.get("items", [])

    def list_objects(
        self,
        limit: int = 100,
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        with httpx.Client(timeout=httpx.Timeout(self.object_timeout_sec)) as client:
            response = client.get(f"{self.object_endpoint}/objects", params=params)
            response.raise_for_status()
            return response.json()

    def upsert_vectors(self, vectors: List[Dict[str, Any]]) -> int:
        if not vectors:
            return 0
        with httpx.Client(timeout=httpx.Timeout(self.vector_timeout_sec)) as client:
            response = client.post(
                f"{self.vector_endpoint}/vectors/upsert",
                json={"vectors": vectors},
            )
            response.raise_for_status()
            payload = response.json()
        return int(payload.get("upserted", 0))

    def delete_vectors(self, object_ids: List[str]) -> int:
        if not object_ids:
            return 0
        with httpx.Client(timeout=httpx.Timeout(self.vector_timeout_sec)) as client:
            response = client.post(
                f"{self.vector_endpoint}/vectors/delete",
                json={"object_ids": object_ids},
            )
            response.raise_for_status()
            payload = response.json()
        return int(payload.get("requested", 0))

    def delete_object(self, object_id: str) -> Dict[str, Any]:
        with httpx.Client(timeout=httpx.Timeout(self.object_timeout_sec)) as client:
            response = client.delete(f"{self.object_endpoint}/objects/{object_id}")
            response.raise_for_status()
            return response.json()
