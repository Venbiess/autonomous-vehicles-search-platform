from __future__ import annotations

import json
from pathlib import Path
from typing import Set


_VISIBILITY_PATH = Path("/app/storage/config/dataset_visibility.json")


def load_hidden_datasets() -> Set[str]:
    try:
        if not _VISIBILITY_PATH.exists():
            return set()
        payload = json.loads(_VISIBILITY_PATH.read_text(encoding="utf-8"))
        items = payload.get("hidden_datasets", [])
        if not isinstance(items, list):
            return set()
        return {str(item).strip() for item in items if str(item).strip()}
    except Exception:
        return set()


def is_dataset_visible(dataset: str) -> bool:
    name = str(dataset or "").strip()
    if not name:
        return True
    return name not in load_hidden_datasets()
