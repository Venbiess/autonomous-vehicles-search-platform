from __future__ import annotations

from pathlib import Path

import backend.server.dataset_visibility as dataset_visibility


def test_load_hidden_datasets_reads_trimmed_unique_values(monkeypatch, tmp_path: Path) -> None:
    payload_path = tmp_path / "dataset_visibility.json"
    payload_path.write_text(
        '{"hidden_datasets": [" waymo ", "", "once", "waymo", 123]}',
        encoding="utf-8",
    )
    monkeypatch.setattr(dataset_visibility, "_VISIBILITY_PATH", payload_path)

    hidden = dataset_visibility.load_hidden_datasets()

    assert hidden == {"waymo", "once", "123"}


def test_load_hidden_datasets_handles_missing_or_invalid_payload(monkeypatch, tmp_path: Path) -> None:
    missing_path = tmp_path / "missing.json"
    monkeypatch.setattr(dataset_visibility, "_VISIBILITY_PATH", missing_path)
    assert dataset_visibility.load_hidden_datasets() == set()

    invalid_path = tmp_path / "invalid.json"
    invalid_path.write_text("{not-json", encoding="utf-8")
    monkeypatch.setattr(dataset_visibility, "_VISIBILITY_PATH", invalid_path)
    assert dataset_visibility.load_hidden_datasets() == set()


def test_is_dataset_visible_uses_hidden_set(monkeypatch) -> None:
    monkeypatch.setattr(dataset_visibility, "load_hidden_datasets", lambda: {"once"})

    assert dataset_visibility.is_dataset_visible("") is True
    assert dataset_visibility.is_dataset_visible("waymo") is True
    assert dataset_visibility.is_dataset_visible("once") is False
