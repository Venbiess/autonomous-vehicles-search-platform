from __future__ import annotations

import threading
from abc import ABC, abstractmethod

import torch
from PIL import Image

from backend.models.common.runtime import TorchDTypeLike
from backend.models.common.runtime import runtime_payload


class BaseVLM(ABC):
    def __init__(self, model_name: str, device: str, torch_dtype: TorchDTypeLike, dtype_label: str) -> None:
        self.model_name = model_name
        self.device = device
        self.torch_dtype = torch_dtype
        self.dtype_label = dtype_label
        self._inference_lock = threading.Lock()

    @property
    @abstractmethod
    def backend_name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def _generate(self, image: Image.Image, prompt_text: str, max_new_tokens: int) -> str:
        raise NotImplementedError

    def generate_text(self, image: Image.Image, prompt_text: str, max_new_tokens: int) -> str:
        with self._inference_lock, torch.no_grad():
            return self._generate(image=image, prompt_text=prompt_text, max_new_tokens=max_new_tokens)

    def get_runtime_payload(self, configured_device: str) -> dict:
        payload = runtime_payload(configured_device=configured_device, selected_device=self.device)
        payload["runtime"]["dtype"] = self.dtype_label
        return payload
