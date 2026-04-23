from __future__ import annotations

from typing import Any, Dict, List

import httpx


class AnalyticsAPI:
    def __init__(self, endpoint: str, timeout_sec: int, write_token: str = ""):
        self.endpoint = endpoint.rstrip("/")
        self.timeout = httpx.Timeout(timeout_sec)
        self.write_token = write_token.strip()

    def _write_headers(self) -> Dict[str, str]:
        if not self.write_token:
            return {}
        return {"X-Storage-Write-Token": self.write_token}

    def get_fields(self, field_names: List[str] | None = None) -> List[Dict[str, str]]:
        params: Dict[str, Any] = {}
        if field_names:
            params["field_names"] = ",".join(field_names)
        with httpx.Client(timeout=self.timeout) as client:
            response = client.get(f"{self.endpoint}/fields", params=params)
            response.raise_for_status()
            payload = response.json()
        return payload.get("fields", [])

    def upsert_fields(
        self,
        fields: List[Dict[str, str]],
        replace_missing: bool = False,
        purge_deleted_values: bool = False,
    ) -> List[Dict[str, str]]:
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.endpoint}/fields",
                json={
                    "fields": fields,
                    "replace_missing": bool(replace_missing),
                    "purge_deleted_values": bool(purge_deleted_values),
                },
                headers=self._write_headers(),
            )
            response.raise_for_status()
            payload = response.json()
        return payload.get("fields", [])

    def upsert_annotations(self, rows: List[Dict[str, Any]]) -> int:
        if not rows:
            return 0
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.endpoint}/annotations/upsert",
                json={"rows": rows},
                headers=self._write_headers(),
            )
            response.raise_for_status()
            payload = response.json()
        return int(payload.get("upserted", 0))

    def delete_annotations(self, object_ids: List[str]) -> int:
        if not object_ids:
            return 0
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.endpoint}/annotations/delete",
                json={"object_ids": object_ids},
                headers=self._write_headers(),
            )
            response.raise_for_status()
            payload = response.json()
        return int(payload.get("requested", 0))

    def clear_annotations(self) -> Dict[str, Any]:
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.endpoint}/annotations/clear",
                headers=self._write_headers(),
            )
            response.raise_for_status()
            return response.json()

    def completed_object_ids(self, object_ids: List[str], field_names: List[str]) -> List[str]:
        if not object_ids or not field_names:
            return []
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.endpoint}/annotations/completed-object-ids",
                json={"object_ids": object_ids, "field_names": field_names},
            )
            response.raise_for_status()
            payload = response.json()
        return payload.get("object_ids", [])

    def search(self, filters: List[Dict[str, str]], limit: int) -> List[Dict[str, Any]]:
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(
                f"{self.endpoint}/search",
                json={"filters": filters, "limit": limit},
            )
            response.raise_for_status()
            payload = response.json()
        return payload.get("results", [])
