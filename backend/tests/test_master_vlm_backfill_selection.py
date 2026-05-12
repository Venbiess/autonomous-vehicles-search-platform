from __future__ import annotations

import backend.server.master as master


def test_list_pending_vlm_object_ids_fills_limit_after_filtering(monkeypatch) -> None:
    pages = [
        {
            "items": [
                {"object_id": f"obj-{idx}", "bucket": "synthetic"} for idx in range(10)
            ],
            "next_cursor": "cursor-1",
        },
        {
            "items": [
                {"object_id": f"obj-{idx}", "bucket": "synthetic"} for idx in range(10, 20)
            ],
            "next_cursor": "",
        },
    ]
    list_calls = {"count": 0}

    def _list_objects(*, limit: int, cursor: str | None = None):
        index = list_calls["count"]
        list_calls["count"] += 1
        assert limit == 10
        if index >= len(pages):
            return {"items": [], "next_cursor": ""}
        return pages[index]

    def _completed_object_ids(object_ids: list[str], field_names: list[str]) -> list[str]:
        assert field_names == ["scene_type"]
        return [obj for obj in object_ids if obj in {"obj-0", "obj-1", "obj-2", "obj-3"}]

    monkeypatch.setattr(master.storage_api, "list_objects", _list_objects)
    monkeypatch.setattr(master.analytics_api, "completed_object_ids", _completed_object_ids)
    monkeypatch.setattr(master, "load_hidden_datasets", lambda: [])

    selected = master._list_pending_vlm_object_ids(
        limit=10,
        field_names=["scene_type"],
        overwrite_existing=False,
        page_size=10,
        dataset="synthetic",
    )

    assert selected == [
        "obj-4",
        "obj-5",
        "obj-6",
        "obj-7",
        "obj-8",
        "obj-9",
        "obj-10",
        "obj-11",
        "obj-12",
        "obj-13",
    ]
