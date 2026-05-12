from __future__ import annotations

import backend.server.master as master


def test_build_vlm_json_prompt_includes_keys_and_json_keyword() -> None:
    prompt = master._build_vlm_json_prompt(
        [
            {
                "field_name": "scene_type",
                "prompt": "Classify scene type",
                "response_type": "category",
            },
            {
                "field_name": "has_people",
                "prompt": "Whether people are present",
                "response_type": "yes_no",
            },
        ]
    )
    assert "scene_type" in prompt
    assert "has_people" in prompt
    assert "JSON" in prompt


def test_extract_first_json_object_from_wrapped_text() -> None:
    payload = master._extract_first_json_object(
        "```json\n{\"scene_type\":\"road\",\"has_people\":\"No\"}\n```"
    )
    assert payload["scene_type"] == "road"
    assert payload["has_people"] == "No"


def test_normalize_values_from_json_object_uses_response_types() -> None:
    values, parse_failed_fields, warning_count = master._normalize_values_from_json_object(
        {
            "has_people": "No",
            "car_count": "about 12 cars",
            "scene_type": "urban road",
        },
        [
            {"field_name": "has_people", "response_type": "yes_no", "prompt": "..."},
            {"field_name": "car_count", "response_type": "number", "prompt": "..."},
            {"field_name": "scene_type", "response_type": "category", "prompt": "..."},
        ],
    )

    assert values["has_people"] == "No"
    assert values["car_count"] == "12"
    assert values["scene_type"] == "urban road"
    assert parse_failed_fields == []
    assert warning_count == 0
