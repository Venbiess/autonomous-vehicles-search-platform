from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from contextlib import nullcontext
from typing import List

from PIL import Image

from backend.models.common.runtime import TorchDTypeLike
from backend.models.common.runtime import runtime_payload

try:
    import torch
except ModuleNotFoundError:  # pragma: no cover - OpenAI-only runtime may not install torch
    torch = None  # type: ignore[assignment]


class BaseVLM(ABC):
    def __init__(self, model_name: str, device: str, torch_dtype: TorchDTypeLike, dtype_label: str) -> None:
        self.model_name = model_name
        self.device = device
        self.torch_dtype = torch_dtype
        self.dtype_label = dtype_label
        self.attn_type = "default"
        self._inference_lock = threading.Lock()

    @property
    @abstractmethod
    def backend_name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def _generate(self, image: Image.Image, prompt_text: str, max_new_tokens: int) -> str:
        raise NotImplementedError

    def _generate_batch(
        self,
        images: List[Image.Image],
        prompt_texts: List[str],
        max_new_tokens: int,
    ) -> List[str]:
        return [
            self._generate(image=image, prompt_text=prompt_text, max_new_tokens=max_new_tokens)
            for image, prompt_text in zip(images, prompt_texts)
        ]

    def generate_text(self, image: Image.Image, prompt_text: str, max_new_tokens: int) -> str:
        inference_ctx = torch.inference_mode() if torch is not None else nullcontext()
        with self._inference_lock, inference_ctx:
            return self._generate(image=image, prompt_text=prompt_text, max_new_tokens=max_new_tokens)

    def generate_text_batch(
        self,
        images: List[Image.Image],
        prompt_texts: List[str],
        max_new_tokens: int,
    ) -> List[str]:
        if len(images) != len(prompt_texts):
            raise ValueError(
                f"batch size mismatch: images={len(images)} prompts={len(prompt_texts)}"
            )
        if not images:
            return []
        inference_ctx = torch.inference_mode() if torch is not None else nullcontext()
        with self._inference_lock, inference_ctx:
            return self._generate_batch(
                images=images,
                prompt_texts=prompt_texts,
                max_new_tokens=max_new_tokens,
            )

    def get_runtime_payload(self, configured_device: str) -> dict:
        payload = runtime_payload(configured_device=configured_device, selected_device=self.device)
        payload["runtime"]["dtype"] = self.dtype_label
        payload["runtime"]["attn_type"] = self.attn_type
        return payload
