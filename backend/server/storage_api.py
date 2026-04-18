from __future__ import annotations

import base64
from typing import Any, Dict, List, Optional

import httpx


class StorageAPI:
    def __init__(
        self,
        endpoint: str,
        timeout_sec: int,
        write_token: str,
    ):
        self.endpoint = endpoint.rstrip("/")
        self.timeout_sec = timeout_sec
        self._timeout = httpx.Timeout(self.timeout_sec)
        self._client = httpx.Client(timeout=self._timeout)
        self.write_headers = (
            {"X-Storage-Write-Token": write_token.strip()} if write_token.strip() else {}
        )

    def resolve_object_id(self, storage_path: str) -> str:
        response = self._client.post(
            f"{self.endpoint}/objects/resolve-path",
            json={"storage_path": storage_path},
            headers=self.write_headers,
        )
        response.raise_for_status()
        payload = response.json()
        return payload["object_id"]

    def get_object_bytes(self, object_id: str) -> tuple[bytes, str]:
        response = self._client.get(f"{self.endpoint}/objects/{object_id}/content")
        response.raise_for_status()
        return response.content, response.headers.get(
            "content-type", "application/octet-stream"
        )

    def get_object_bytes_batch(self, object_ids: List[str]) -> List[Dict[str, Any]]:
        if not object_ids:
            return []
        response = self._client.post(
            f"{self.endpoint}/objects/get-batch",
            json={"object_ids": object_ids},
        )
        response.raise_for_status()
        payload = response.json()

        results: List[Dict[str, Any]] = []
        for item in payload.get("items", []):
            encoded = item.get("content_base64", "")
            content = b""
            if encoded:
                content = base64.b64decode(encoded)
            results.append(
                {
                    "object_id": item.get("object_id", ""),
                    "content": content,
                    "content_type": item.get(
                        "content_type", "application/octet-stream"
                    ),
                    "size_bytes": int(item.get("size_bytes", 0)),
                    "error": item.get("error", ""),
                }
            )
        return results

    def query_vectors(self, embedding: List[float], top_k: int) -> List[Dict[str, Any]]:
        response = self._client.post(
            f"{self.endpoint}/vectors/query",
            json={"embedding": embedding, "top_k": top_k},
        )
        response.raise_for_status()
        payload = response.json()
        return payload.get("results", [])

    def list_objects(
        self,
        limit: int = 100,
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        response = self._client.get(f"{self.endpoint}/objects", params=params)
        response.raise_for_status()
        return response.json()

    def upsert_vectors(self, vectors: List[Dict[str, Any]]) -> int:
        if not vectors:
            return 0
        response = self._client.post(
            f"{self.endpoint}/vectors/upsert",
            json={"vectors": vectors},
            headers=self.write_headers,
        )
        response.raise_for_status()
        payload = response.json()
        return int(payload.get("upserted", 0))

    def delete_object(self, object_id: str) -> Dict[str, Any]:
        if self.write_headers:
            response = self._client.delete(
                f"{self.endpoint}/objects/{object_id}",
                headers=self.write_headers,
            )
        else:
            response = self._client.delete(f"{self.endpoint}/objects/{object_id}")
        response.raise_for_status()
        return response.json()
