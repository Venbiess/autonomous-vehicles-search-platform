from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from typing import Literal

import torch
from PIL import Image

from backend.models.common.runtime import resolve_device
from backend.models.common.runtime import runtime_payload
from backend.models.common.runtime import TorchDTypeLike

EmbeddingInputType = Literal["text", "image"]


class BaseEmbedder(ABC):
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
    def _embed_text(self, text: str) -> torch.Tensor:
        raise NotImplementedError

    @abstractmethod
    def _embed_image(self, image: Image.Image) -> torch.Tensor:
        raise NotImplementedError

    def get_embedding(self, inputs: str | Image.Image, input_type: EmbeddingInputType) -> list[float]:
        with self._inference_lock, torch.no_grad():
            if input_type == "text":
                outputs = self._embed_text(str(inputs))
            elif input_type == "image":
                if not isinstance(inputs, Image.Image):
                    raise TypeError("Image embedding expects PIL.Image.Image input")
                outputs = self._embed_image(inputs)
            else:
                raise ValueError(f"Unsupported embedding input type: {input_type}")

        if not isinstance(outputs, torch.Tensor):
            raise TypeError(f"Embedder must return torch.Tensor, got {type(outputs)!r}")

        if outputs.dim() == 1:
            outputs = outputs.unsqueeze(0)

        normalized = outputs / outputs.norm(dim=-1, keepdim=True).clamp_min(1e-12)
        return normalized.detach().cpu().tolist()[0]
