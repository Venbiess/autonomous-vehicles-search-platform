from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from typing import Dict, List, Sequence, Tuple
from urllib.parse import unquote, urlparse

import clickhouse_connect

from config import AnalyticsDBConfig
from models import AnalyticsField, AnnotationRow, SearchFilter, SearchResult

IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _q(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _ident(value: str) -> str:
    if not IDENT_RE.fullmatch(value):
        raise ValueError(f"invalid ClickHouse identifier: {value!r}")
    return f"`{value}`"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _fnv_shard(key: str, total: int) -> int:
    if total <= 1:
        return 0
    h = 2166136261
    for ch in key.encode("utf-8"):
        h ^= ch
        h = (h * 16777619) & 0xFFFFFFFF
    return h % total


class ClickHouseShard:
    def __init__(self, cfg: AnalyticsDBConfig):
        parsed = urlparse(cfg.dsn)
        secure = parsed.scheme in {"https", "clickhouses"}
        host = parsed.hostname or "localhost"
        port = parsed.port or (8443 if secure else 8123)
        username = unquote(parsed.username or "default")
        password = unquote(parsed.password or "")
        database = (parsed.path or "/default").lstrip("/") or "default"

        self.fields_table = cfg.field_catalog_table
        self.annotations_table = cfg.annotation_store_table
        self.fields_table_sql = _ident(cfg.field_catalog_table)
        self.annotations_table_sql = _ident(cfg.annotation_store_table)
        self.client = self._connect_with_retry(
            host=host,
            port=port,
            username=username,
            password=password,
            database=database,
            secure=secure,
        )

    @staticmethod
    def _connect_with_retry(**kwargs):
        last_exc: Exception | None = None
        for attempt in range(1, 11):
            try:
                return clickhouse_connect.get_client(
                    **kwargs,
                    connect_timeout=5,
                    send_receive_timeout=30,
                )
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if attempt == 10:
                    break
                time.sleep(min(attempt, 5))
        raise last_exc or RuntimeError("failed to connect to ClickHouse")

    def ensure(self) -> None:
        self.client.command(
            f"""
            CREATE TABLE IF NOT EXISTS {self.fields_table_sql} (
                field_name String,
                prompt String,
                response_type String,
                updated_at DateTime64(3, 'UTC')
            )
            ENGINE = ReplacingMergeTree(updated_at)
            ORDER BY field_name
            """
        )
        self.client.command(
            f"""
            CREATE TABLE IF NOT EXISTS {self.annotations_table_sql} (
                object_id String,
                values_json String,
                updated_at DateTime64(3, 'UTC')
            )
            ENGINE = ReplacingMergeTree(updated_at)
            ORDER BY object_id
            """
        )

    def health(self) -> None:
        self.client.command("SELECT 1")

    def get_fields(self, field_names: Sequence[str]) -> List[AnalyticsField]:
        query = (
            "SELECT field_name, argMax(prompt, updated_at), argMax(response_type, updated_at) "
            f"FROM {self.fields_table_sql}"
        )
        if field_names:
            values = ", ".join(_q(name) for name in field_names)
            query += f" WHERE field_name IN ({values})"
        query += " GROUP BY field_name ORDER BY field_name"
        rows = self.client.query(query).result_rows
        return [
            AnalyticsField(field_name=row[0], prompt=row[1], response_type=row[2])
            for row in rows
        ]

    def upsert_fields(self, fields: Sequence[AnalyticsField]) -> None:
        if not fields:
            return
        now = _now_utc()
        data = [
            [
                item.field_name.strip(),
                item.prompt.strip(),
                item.response_type.strip().lower(),
                now,
            ]
            for item in fields
        ]
        self.client.insert(
            self.fields_table,
            data,
            column_names=["field_name", "prompt", "response_type", "updated_at"],
        )

    def _get_annotation_values(self, object_id: str) -> Dict[str, str]:
        query = (
            f"SELECT argMax(values_json, updated_at) "
            f"FROM {self.annotations_table_sql} WHERE object_id = {_q(object_id)}"
        )
        rows = self.client.query(query).result_rows
        if not rows or not rows[0] or rows[0][0] in (None, ""):
            return {}
        try:
            data = json.loads(rows[0][0])
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}

    def upsert_annotations(self, rows: Sequence[AnnotationRow]) -> None:
        if not rows:
            return
        now = _now_utc()
        data = []
        for row in rows:
            merged = self._get_annotation_values(row.object_id)
            merged.update(row.values)
            data.append([row.object_id, json.dumps(merged, ensure_ascii=True), now])
        self.client.insert(
            self.annotations_table,
            data,
            column_names=["object_id", "values_json", "updated_at"],
        )

    def delete_annotations(self, object_ids: Sequence[str]) -> None:
        if not object_ids:
            return
        values = ", ".join(_q(item) for item in object_ids)
        self.client.command(
            f"ALTER TABLE {self.annotations_table_sql} DELETE WHERE object_id IN ({values})"
        )

    def clear_annotations(self) -> int:
        count_rows = self.client.query(
            f"SELECT COUNT() FROM (SELECT object_id FROM {self.annotations_table_sql} GROUP BY object_id)"
        ).result_rows
        count = int(count_rows[0][0]) if count_rows else 0
        self.client.command(f"TRUNCATE TABLE {self.annotations_table_sql}")
        return count

    def completed_object_ids(self, object_ids: Sequence[str], field_names: Sequence[str]) -> List[str]:
        if not object_ids or not field_names:
            return []
        values = ", ".join(_q(item) for item in object_ids)
        rows = self.client.query(
            f"""
            SELECT object_id, argMax(values_json, updated_at)
            FROM {self.annotations_table_sql}
            WHERE object_id IN ({values})
            GROUP BY object_id
            """
        ).result_rows
        completed: List[str] = []
        for object_id, values_json in rows:
            try:
                attrs = json.loads(values_json) if values_json else {}
            except json.JSONDecodeError:
                attrs = {}
            is_complete = True
            for field_name in field_names:
                if not str(attrs.get(field_name, "")).strip():
                    is_complete = False
                    break
            if is_complete:
                completed.append(object_id)
        return completed

    def search(self, filters: Sequence[SearchFilter], limit: int) -> List[Tuple[datetime, SearchResult]]:
        if not filters:
            return []
        limit = max(limit, 1)
        subquery = (
            f"SELECT object_id, argMax(values_json, updated_at) AS values_json, max(updated_at) AS latest_updated_at "
            f"FROM {self.annotations_table_sql} GROUP BY object_id"
        )
        clauses: List[str] = []
        for flt in filters:
            extract = f"ifNull(JSONExtractString(values_json, {_q(flt.field_name)}), '')"
            if flt.match_mode.lower() == "contains":
                clauses.append(f"positionCaseInsensitiveUTF8({extract}, {_q(flt.value)}) > 0")
            else:
                clauses.append(f"lowerUTF8({extract}) = lowerUTF8({_q(flt.value)})")

        where_sql = " AND ".join(clauses) if clauses else "1"
        query = (
            f"SELECT object_id, values_json, latest_updated_at FROM ({subquery}) "
            f"WHERE {where_sql} ORDER BY latest_updated_at DESC LIMIT {int(limit)}"
        )
        rows = self.client.query(query).result_rows
        out: List[Tuple[datetime, SearchResult]] = []
        for object_id, values_json, latest_updated_at in rows:
            try:
                attrs = json.loads(values_json) if values_json else {}
            except json.JSONDecodeError:
                attrs = {}
            selected = {
                flt.field_name: str(attrs.get(flt.field_name, ""))
                for flt in filters
                if flt.field_name in attrs
            }
            out.append(
                (
                    latest_updated_at,
                    SearchResult(object_id=object_id, attributes=selected),
                )
            )
        return out


class AnalyticsStore:
    def __init__(self, cfg: AnalyticsDBConfig, shards: Sequence[AnalyticsDBConfig]):
        configs = list(shards) if shards else [cfg]
        self.shards = [ClickHouseShard(item) for item in configs]
        for shard in self.shards:
            shard.ensure()

    def health(self) -> None:
        for shard in self.shards:
            shard.health()

    def get_fields(self, field_names: Sequence[str]) -> List[AnalyticsField]:
        return self.shards[0].get_fields(field_names)

    def upsert_fields(self, fields: Sequence[AnalyticsField]) -> None:
        for shard in self.shards:
            shard.upsert_fields(fields)

    def upsert_annotations(self, rows: Sequence[AnnotationRow]) -> None:
        grouped: List[List[AnnotationRow]] = [[] for _ in self.shards]
        for row in rows:
            idx = _fnv_shard(row.object_id, len(self.shards))
            grouped[idx].append(row)
        for idx, bucket in enumerate(grouped):
            if bucket:
                self.shards[idx].upsert_annotations(bucket)

    def delete_annotations(self, object_ids: Sequence[str]) -> int:
        normalized = sorted({item.strip() for item in object_ids if item.strip()})
        grouped: List[List[str]] = [[] for _ in self.shards]
        for object_id in normalized:
            idx = _fnv_shard(object_id, len(self.shards))
            grouped[idx].append(object_id)
        for idx, bucket in enumerate(grouped):
            if bucket:
                self.shards[idx].delete_annotations(bucket)
        return len(normalized)

    def clear_annotations(self) -> int:
        total = 0
        for shard in self.shards:
            total += shard.clear_annotations()
        return total

    def completed_object_ids(self, object_ids: Sequence[str], field_names: Sequence[str]) -> List[str]:
        grouped: List[List[str]] = [[] for _ in self.shards]
        for object_id in object_ids:
            idx = _fnv_shard(object_id, len(self.shards))
            grouped[idx].append(object_id)
        out: List[str] = []
        for idx, bucket in enumerate(grouped):
            if bucket:
                out.extend(self.shards[idx].completed_object_ids(bucket, field_names))
        return out

    def search(self, filters: Sequence[SearchFilter], limit: int) -> List[SearchResult]:
        merged: List[Tuple[datetime, SearchResult]] = []
        seen: set[str] = set()
        for shard in self.shards:
            for updated_at, item in shard.search(filters, limit):
                if item.object_id in seen:
                    continue
                seen.add(item.object_id)
                merged.append((updated_at, item))
        merged.sort(key=lambda item: item[0], reverse=True)
        return [item for _, item in merged[:limit]]
