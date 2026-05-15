from __future__ import annotations

import base64
import os
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
        self._supports_include_content: Optional[bool] = None

    def upload_object(
        self,
        filename: str,
        data: bytes,
        bucket: Optional[str] = None,
        key: Optional[str] = None,
        content_type: str = "application/octet-stream",
    ) -> Dict[str, Any]:
        params: Dict[str, str] = {"filename": os.path.basename(filename) or "object.bin"}
        if bucket and bucket.strip():
            params["bucket"] = bucket.strip()
        if key and key.strip():
            params["key"] = key.strip()
        if content_type.strip():
            params["content_type"] = content_type.strip()
        headers = dict(self.write_headers)
        headers["Content-Type"] = content_type
        response = self._client.post(
            f"{self.endpoint}/objects/upload",
            params=params,
            content=data,
            headers=headers,
        )
        response.raise_for_status()
        return response.json()

    def get_object_bytes(self, object_id: str) -> tuple[bytes, str]:
        response = self._client.get(f"{self.endpoint}/objects/{object_id}/content")
        response.raise_for_status()
        return response.content, response.headers.get(
            "content-type", "application/octet-stream"
        )

    def get_object_bytes_batch(self, object_ids: List[str]) -> List[Dict[str, Any]]:
        if not object_ids:
            return []
        normalized_ids = [str(item).strip() for item in object_ids if str(item).strip()]
        if not normalized_ids:
            return []

        max_batch_ids = max(
            1, int(os.getenv("STORAGE_GET_BATCH_MAX_OBJECT_IDS", "256"))
        )
        results: List[Dict[str, Any]] = []

        for i in range(0, len(normalized_ids), max_batch_ids):
            chunk = normalized_ids[i : i + max_batch_ids]
            response = self._post_get_batch(chunk)
            if response.is_error:
                detail = response.text
                try:
                    payload = response.json()
                    if isinstance(payload, dict):
                        message = payload.get("error", {}).get("message")
                        if isinstance(message, str) and message.strip():
                            detail = message
                except Exception:
                    pass
                raise RuntimeError(
                    "objects/get-batch failed: "
                    f"status={response.status_code}, chunk_size={len(chunk)}, detail={detail}"
                )

            payload = response.json()
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

    def _post_get_batch(self, chunk: List[str]) -> httpx.Response:
        endpoint = f"{self.endpoint}/objects/get-batch"
        if self._supports_include_content is not False:
            response = self._client.post(
                endpoint,
                json={"object_ids": chunk, "include_content": True},
            )
            if not self._is_unknown_include_content_error(response):
                if response.status_code < 400:
                    self._supports_include_content = True
                return response
            self._supports_include_content = False
        return self._client.post(endpoint, json={"object_ids": chunk})

    def _is_unknown_include_content_error(self, response: httpx.Response) -> bool:
        if response.status_code != 400:
            return False
        detail = ""
        try:
            payload = response.json()
            if isinstance(payload, dict):
                detail = str(payload.get("error", {}).get("message", ""))
        except Exception:
            detail = response.text or ""
        normalized = detail.lower()
        return "unknown field" in normalized and "include_content" in normalized

    def query_vectors(self, embedding: List[float], top_k: int) -> List[Dict[str, Any]]:
        response = self._client.post(
            f"{self.endpoint}/vectors/query",
            json={"embedding": embedding, "top_k": top_k},
        )
        response.raise_for_status()
        payload = response.json()
        return payload.get("results", [])

    def count_vectors_above_similarity(self, embedding: List[float], min_similarity: float) -> int:
        response = self._client.post(
            f"{self.endpoint}/vectors/count-above",
            json={"embedding": embedding, "min_similarity": min_similarity},
        )
        response.raise_for_status()
        payload = response.json()
        return int(payload.get("count", 0))

    def count_vectors(self) -> int:
        response = self._client.get(f"{self.endpoint}/vectors/count")
        response.raise_for_status()
        payload = response.json()
        return int(payload.get("count", 0))

    def get_vectors(self, object_ids: List[str]) -> List[Dict[str, Any]]:
        if not object_ids:
            return []
        response = self._client.post(
            f"{self.endpoint}/vectors/get",
            json={"object_ids": object_ids},
        )
        response.raise_for_status()
        payload = response.json()
        items = payload.get("items", [])
        return items if isinstance(items, list) else []

    def health(self) -> Dict[str, Any]:
        response = self._client.get(f"{self.endpoint}/health")
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {"status": "ok"}

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

    def count_objects(self) -> int:
        response = self._client.get(f"{self.endpoint}/objects/count")
        response.raise_for_status()
        payload = response.json()
        return int(payload.get("count", 0))

    def upsert_vectors(self, vectors: List[Dict[str, Any]]) -> int:
        if not vectors:
            return 0
        response = self._client.post(
            f"{self.endpoint}/vectors/upsert",
            json={"vectors": vectors},
            headers=self.write_headers,
        )
        if response.is_error:
            detail = response.text
            try:
                payload = response.json()
                if isinstance(payload, dict):
                    message = payload.get("error", {}).get("message")
                    if isinstance(message, str) and message.strip():
                        detail = message
            except Exception:
                pass
            raise RuntimeError(
                f"vectors/upsert failed: status={response.status_code}, detail={detail}"
            )
        payload = response.json()
        return int(payload.get("upserted", 0))

    def delete_vectors(self, object_ids: List[str]) -> int:
        if not object_ids:
            return 0
        response = self._client.post(
            f"{self.endpoint}/vectors/delete",
            json={"object_ids": object_ids},
            headers=self.write_headers,
        )
        response.raise_for_status()
        payload = response.json()
        return int(payload.get("deleted", payload.get("requested", 0)))

    def cleanup_orphan_vectors(self) -> int:
        response = self._client.post(
            f"{self.endpoint}/vectors/cleanup-orphans",
            headers=self.write_headers,
        )
        response.raise_for_status()
        payload = response.json()
        return int(payload.get("deleted", payload.get("requested", 0)))

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

    def completed_vector_object_ids(self, object_ids: List[str]) -> List[str]:
        if not object_ids:
            return []
        response = self._client.post(
            f"{self.endpoint}/vectors/completed-object-ids",
            json={"object_ids": object_ids},
        )
        response.raise_for_status()
        payload = response.json()
        ids = payload.get("object_ids", [])
        return [str(item).strip() for item in ids if str(item).strip()]

    def get_preprocessor_methods(self) -> List[Dict[str, Any]]:
        response = self._client.get(f"{self.endpoint}/preprocessors/methods")
        response.raise_for_status()
        payload = response.json()
        items = payload.get("items", [])
        return items if isinstance(items, list) else []
