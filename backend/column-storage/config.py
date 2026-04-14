from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, List

import yaml

DEFAULT_CONFIG_PATH = "./settings.yaml"


@dataclass(frozen=True)
class AnalyticsDBConfig:
    provider: str
    dsn: str
    field_catalog_table: str
    annotation_store_table: str


@dataclass(frozen=True)
class AppConfig:
    server_name: str
    addr: str
    analytics_db: AnalyticsDBConfig
    analytics_dbs: List[AnalyticsDBConfig]


def _parse_db(raw: Dict[str, Any]) -> AnalyticsDBConfig:
    return AnalyticsDBConfig(
        provider=str(raw.get("provider", "")).strip() or "clickhouse",
        dsn=str(raw.get("dsn", "")).strip(),
        field_catalog_table=str(raw.get("field_catalog_table", "")).strip() or "vlm_field_specs",
        annotation_store_table=str(raw.get("annotation_store_table", "")).strip() or "vlm_annotations",
    )


def load_config() -> AppConfig:
    path = os.getenv("COLUMN_STORAGE_CONFIG_PATH", DEFAULT_CONFIG_PATH).strip() or DEFAULT_CONFIG_PATH
    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}

    analytics = raw.get("analytics_server", {})
    primary = _parse_db(analytics.get("analytics_db", {}))
    replicas = [_parse_db(item) for item in analytics.get("analytics_dbs", []) if isinstance(item, dict)]

    return AppConfig(
        server_name=str(analytics.get("server_name", "analytics-server")).strip() or "analytics-server",
        addr=str(analytics.get("addr", ":9012")).strip() or ":9012",
        analytics_db=primary,
        analytics_dbs=replicas,
    )
