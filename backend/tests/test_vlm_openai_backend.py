from __future__ import annotations

import sys
import types

from PIL import Image

from backend.models.vlm.factory import create_vlm


def _install_fake_openai_module(monkeypatch, create_fn):
    module = types.ModuleType("openai")

    class _FakeCompletions:
        def create(self, **kwargs):
            return create_fn(**kwargs)

    class _FakeChat:
        def __init__(self) -> None:
            self.completions = _FakeCompletions()

    class OpenAI:  # noqa: N801
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs
            self.chat = _FakeChat()

    module.OpenAI = OpenAI
    monkeypatch.setitem(sys.modules, "openai", module)


def _fake_completion_with_text(text: str):
    return types.SimpleNamespace(
        choices=[
            types.SimpleNamespace(
                message=types.SimpleNamespace(content=text),
            )
        ]
    )


def test_create_vlm_openai_backend_generates_text(monkeypatch) -> None:
    calls: list[dict] = []

    def _create_completion(**kwargs):
        calls.append(kwargs)
        return _fake_completion_with_text("  road scene  ")

    _install_fake_openai_module(monkeypatch, _create_completion)
    monkeypatch.setenv("VLM_OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("VLM_OPENAI_IMAGE_DETAIL", "low")
    monkeypatch.setenv("VLM_OPENAI_IMAGE_FORMAT", "jpeg")
    monkeypatch.delenv("VLM_OPENAI_SYSTEM_PROMPT", raising=False)

    vlm = create_vlm(
        backend_name="OPENAI",
        model_name=None,
        device="cpu",
        torch_dtype=None,
        dtype_label="float32",
        attn_implementation=None,
    )

    image = Image.new("RGB", (4, 4), color=(255, 255, 255))
    generated = vlm.generate_text(image=image, prompt_text="Describe image", max_new_tokens=32)

    assert generated == "road scene"
    assert len(calls) == 1
    payload = calls[0]
    assert payload["model"] == "gpt-5.4-mini"
    assert payload["max_tokens"] == 32
    assert payload["messages"][0]["role"] == "user"
    user_content = payload["messages"][0]["content"]
    assert user_content[0]["type"] == "text"
    assert user_content[0]["text"] == "Describe image"
    assert user_content[1]["type"] == "image_url"
    image_url = user_content[1]["image_url"]
    assert image_url["detail"] == "low"
    assert str(image_url["url"]).startswith("data:image/jpeg;base64,")


def test_openai_backend_fallbacks_to_max_completion_tokens(monkeypatch) -> None:
    calls: list[dict] = []

    def _create_completion(**kwargs):
        calls.append(kwargs)
        if "max_tokens" in kwargs:
            raise RuntimeError("Use max_completion_tokens instead of max_tokens")
        return _fake_completion_with_text("ok")

    _install_fake_openai_module(monkeypatch, _create_completion)
    monkeypatch.setenv("VLM_OPENAI_API_KEY", "test-key")

    vlm = create_vlm(
        backend_name="OPENAI",
        model_name="gpt-5.4-mini",
        device="cpu",
        torch_dtype=None,
        dtype_label="float32",
        attn_implementation=None,
    )

    image = Image.new("RGB", (2, 2), color=(0, 0, 0))
    generated = vlm.generate_text(image=image, prompt_text="p", max_new_tokens=17)

    assert generated == "ok"
    assert len(calls) == 2
    assert calls[0]["max_tokens"] == 17
    assert "max_tokens" not in calls[1]
    assert calls[1]["max_completion_tokens"] == 17


def test_openai_backend_requires_api_key(monkeypatch) -> None:
    monkeypatch.delenv("VLM_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    _install_fake_openai_module(monkeypatch, lambda **kwargs: _fake_completion_with_text("unused"))

    try:
        create_vlm(
            backend_name="OPENAI",
            model_name="gpt-5.4-mini",
            device="cpu",
            torch_dtype=None,
            dtype_label="float32",
            attn_implementation=None,
        )
    except ValueError as exc:
        assert "API key" in str(exc)
    else:
        raise AssertionError("Expected ValueError when OpenAI API key is missing")
