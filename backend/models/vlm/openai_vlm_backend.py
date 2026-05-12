from __future__ import annotations

import base64
import io
import logging
import os
from urllib.parse import urlparse
from typing import Any
from typing import List

from PIL import Image

from backend.models.common.runtime import TorchDTypeLike
from backend.models.vlm.base import BaseVLM

logger = logging.getLogger(__name__)


def _env_optional(*names: str) -> str | None:
    for name in names:
        raw = os.getenv(name)
        if raw is None:
            continue
        value = str(raw).strip()
        if value:
            return value
    return None


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(str(raw).strip())
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        return default


def _extract_response_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for part in content:
            if isinstance(part, str):
                chunks.append(part)
                continue
            if isinstance(part, dict):
                text = part.get("text")
            else:
                text = getattr(part, "text", None)
            if text is not None:
                chunks.append(str(text))
        return "".join(chunks)
    return str(content)


class OpenAIVLMBackend(BaseVLM):
    DEFAULT_MODEL_NAME = "gpt-5.4-mini"
    DEFAULT_BASE_URL = "https://api.openai.com/v1"

    def __init__(
        self,
        model_name: str,
        device: str,
        torch_dtype: TorchDTypeLike,
        dtype_label: str,
        attn_implementation: str | None,
    ) -> None:
        super().__init__(model_name=model_name, device=device, torch_dtype=torch_dtype, dtype_label=dtype_label)
        self.attn_type = "remote-api"

        api_key = _env_optional("VLM_OPENAI_API_KEY", "OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OpenAI VLM backend requires API key. "
                "Set VLM_OPENAI_API_KEY or OPENAI_API_KEY."
            )

        base_url = _env_optional("VLM_OPENAI_BASE_URL", "OPENAI_BASE_URL")
        if not base_url:
            base_url = self.DEFAULT_BASE_URL
        parsed_base_url = urlparse(base_url)
        if parsed_base_url.scheme not in {"http", "https"}:
            logger.warning(
                "OPENAI_VLM invalid base_url=%r; falling back to default=%s",
                base_url,
                self.DEFAULT_BASE_URL,
            )
            base_url = self.DEFAULT_BASE_URL
        organization = _env_optional("VLM_OPENAI_ORG_ID", "OPENAI_ORG_ID")
        project = _env_optional("VLM_OPENAI_PROJECT_ID", "OPENAI_PROJECT_ID")

        timeout_sec = _env_float("VLM_OPENAI_TIMEOUT_SEC", 120.0)
        max_retries = _env_int("VLM_OPENAI_MAX_RETRIES", 2)

        image_detail = str(os.getenv("VLM_OPENAI_IMAGE_DETAIL", "low")).strip().lower()
        if image_detail not in {"auto", "low", "high"}:
            raise ValueError(
                f"Unsupported VLM_OPENAI_IMAGE_DETAIL={image_detail!r}. "
                "Supported values: auto, low, high."
            )
        self.image_detail = image_detail

        image_format = str(os.getenv("VLM_OPENAI_IMAGE_FORMAT", "jpeg")).strip().lower()
        if image_format not in {"jpeg", "png"}:
            raise ValueError(
                f"Unsupported VLM_OPENAI_IMAGE_FORMAT={image_format!r}. "
                "Supported values: jpeg, png."
            )
        self.image_format = image_format
        self.jpeg_quality = max(1, min(100, _env_int("VLM_OPENAI_JPEG_QUALITY", 95)))

        raw_temperature = _env_optional("VLM_OPENAI_TEMPERATURE")
        if raw_temperature is None:
            self.temperature = None
        else:
            try:
                self.temperature = float(raw_temperature)
            except ValueError as exc:
                raise ValueError(
                    f"Unsupported VLM_OPENAI_TEMPERATURE={raw_temperature!r}. "
                    "Expected a float value, for example: 0, 0.2, 1.0."
                ) from exc
        self.system_prompt = _env_optional("VLM_OPENAI_SYSTEM_PROMPT")

        try:
            from openai import OpenAI
        except ImportError as exc:
            raise ImportError(
                "OpenAI VLM backend requires the 'openai' Python package. "
                "Install it in the models runtime image."
            ) from exc

        client_kwargs: dict[str, Any] = {
            "api_key": api_key,
            "timeout": timeout_sec,
            "max_retries": max_retries,
        }
        client_kwargs["base_url"] = base_url
        if organization:
            client_kwargs["organization"] = organization
        if project:
            client_kwargs["project"] = project

        self.client = OpenAI(**client_kwargs)
        logger.info(
            "OPENAI_VLM setup: model=%s base_url=%s org=%s project=%s timeout=%.1fs max_retries=%s detail=%s image_format=%s",
            self.model_name,
            base_url or "default",
            organization or "-",
            project or "-",
            timeout_sec,
            max_retries,
            self.image_detail,
            self.image_format,
        )

    @property
    def backend_name(self) -> str:
        return "OPENAI"

    def _image_to_data_url(self, image: Image.Image) -> str:
        buffer = io.BytesIO()
        if self.image_format == "png":
            image.save(buffer, format="PNG")
            mime = "image/png"
        else:
            image.save(buffer, format="JPEG", quality=self.jpeg_quality, optimize=True)
            mime = "image/jpeg"
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:{mime};base64,{encoded}"

    def _build_messages(self, prompt_text: str, image_url: str) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        messages.append(
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt_text},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_url,
                            "detail": self.image_detail,
                        },
                    },
                ],
            }
        )
        return messages

    def _create_completion(self, *, messages: list[dict[str, Any]], max_new_tokens: int):
        payload: dict[str, Any] = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": int(max_new_tokens),
        }
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        try:
            return self.client.chat.completions.create(**payload)
        except Exception as exc:  # noqa: BLE001
            # Some model snapshots may require max_completion_tokens instead of max_tokens.
            message = str(exc).lower()
            if "max_completion_tokens" in message and "max_tokens" in payload:
                fallback_payload = dict(payload)
                fallback_payload.pop("max_tokens", None)
                fallback_payload["max_completion_tokens"] = int(max_new_tokens)
                return self.client.chat.completions.create(**fallback_payload)
            raise

    def _generate(self, image: Image.Image, prompt_text: str, max_new_tokens: int) -> str:
        image_url = self._image_to_data_url(image)
        completion = self._create_completion(
            messages=self._build_messages(prompt_text=prompt_text, image_url=image_url),
            max_new_tokens=max_new_tokens,
        )
        try:
            content = completion.choices[0].message.content
        except Exception:  # noqa: BLE001
            logger.warning("OPENAI_VLM response without standard choices[0].message.content")
            return ""
        return _extract_response_text(content).strip()

    def _generate_batch(
        self,
        images: List[Image.Image],
        prompt_texts: List[str],
        max_new_tokens: int,
    ) -> List[str]:
        outputs: list[str] = []
        for image, prompt_text in zip(images, prompt_texts):
            outputs.append(
                self._generate(
                    image=image,
                    prompt_text=prompt_text,
                    max_new_tokens=max_new_tokens,
                )
            )
        return outputs
