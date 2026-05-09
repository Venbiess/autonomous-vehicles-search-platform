from __future__ import annotations

from typing import Optional

import torch
from PIL import Image
from sentence_transformers import SentenceTransformer

from backend.models.common.runtime import TorchDTypeLike
from backend.models.embedder.base import BaseEmbedder


class QwenEmbedder(BaseEmbedder):
    DEFAULT_MODEL_NAME = "Qwen/Qwen3-VL-Embedding-2B"

    def __init__(
        self,
        model_name: str,
        device: str,
        torch_dtype: TorchDTypeLike,
        dtype_label: str,
        attn_implementation: Optional[str] = None,
    ) -> None:
        super().__init__(model_name=model_name, device=device, torch_dtype=torch_dtype, dtype_label=dtype_label)
        requested_attn = str(attn_implementation).strip() if attn_implementation else ""
        self.attn_type = requested_attn or "default"
        model_kwargs = {}
        if torch_dtype is not None:
            model_kwargs["torch_dtype"] = torch_dtype
        if requested_attn:
            model_kwargs["attn_implementation"] = requested_attn

        try:
            self.model = SentenceTransformer(
                model_name,
                device=device,
                trust_remote_code=True,
                model_kwargs=model_kwargs or None,
            )
        except ImportError as exc:
            lowered = str(exc).lower()
            if requested_attn == "flash_attention_2" and "flash_attn" in lowered:
                fallback_kwargs = dict(model_kwargs)
                fallback_kwargs["attn_implementation"] = "sdpa"
                self.model = SentenceTransformer(
                    model_name,
                    device=device,
                    trust_remote_code=True,
                    model_kwargs=fallback_kwargs or None,
                )
                self.attn_type = "sdpa (flash_attention_2 requested, flash_attn missing)"
            else:
                raise
        except TypeError as exc:
            lowered = str(exc).lower()
            if requested_attn and "attn_implementation" in lowered:
                fallback_kwargs = dict(model_kwargs)
                fallback_kwargs.pop("attn_implementation", None)
                self.model = SentenceTransformer(
                    model_name,
                    device=device,
                    trust_remote_code=True,
                    model_kwargs=fallback_kwargs or None,
                )
                self.attn_type = "default (attn_implementation unsupported)"
            else:
                raise

    @property
    def backend_name(self) -> str:
        return "QWEN"

    def _encode_batch(self, items: list[str | Image.Image]) -> torch.Tensor:
        configured_batch_size = int(max(1, int(len(items))))
        return self.model.encode(
            items,
            convert_to_tensor=True,
            normalize_embeddings=True,
            show_progress_bar=False,
            batch_size=configured_batch_size,
        )

    def _embed_text(self, text: str) -> torch.Tensor:
        return self._embed_text_batch([text])[0]

    def _embed_text_batch(self, texts: list[str]) -> torch.Tensor:
        return self._encode_batch(texts)

    def _embed_image(self, image: Image.Image) -> torch.Tensor:
        return self._embed_image_batch([image])[0]

    def _embed_image_batch(self, images: list[Image.Image]) -> torch.Tensor:
        return self._encode_batch(images)
