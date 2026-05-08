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

    def _embed_text_batch(self, texts: list[str]) -> torch.Tensor:
        outputs: list[torch.Tensor] = []
        for text in texts:
            tensor = self._embed_text(text)
            if tensor.dim() == 1:
                tensor = tensor.unsqueeze(0)
            outputs.append(tensor)
        return torch.cat(outputs, dim=0) if outputs else torch.empty((0, 0), device=self.device)

    def _embed_image_batch(self, images: list[Image.Image]) -> torch.Tensor:
        outputs: list[torch.Tensor] = []
        for image in images:
            tensor = self._embed_image(image)
            if tensor.dim() == 1:
                tensor = tensor.unsqueeze(0)
            outputs.append(tensor)
        return torch.cat(outputs, dim=0) if outputs else torch.empty((0, 0), device=self.device)

    @staticmethod
    def _normalize_embeddings(outputs: torch.Tensor) -> torch.Tensor:
        if outputs.dim() == 1:
            outputs = outputs.unsqueeze(0)
        return outputs / outputs.norm(dim=-1, keepdim=True).clamp_min(1e-12)

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

        normalized = self._normalize_embeddings(outputs)
        return normalized.detach().cpu().tolist()[0]

    def get_embeddings(self, inputs: list[str] | list[Image.Image], input_type: EmbeddingInputType) -> list[list[float]]:
        if not isinstance(inputs, list) or not inputs:
            return []

        with self._inference_lock, torch.no_grad():
            if input_type == "text":
                texts = [str(item) for item in inputs]
                outputs = self._embed_text_batch(texts)
            elif input_type == "image":
                images: list[Image.Image] = []
                for item in inputs:
                    if not isinstance(item, Image.Image):
                        raise TypeError("Image embedding expects PIL.Image.Image input")
                    images.append(item)
                outputs = self._embed_image_batch(images)
            else:
                raise ValueError(f"Unsupported embedding input type: {input_type}")

        if not isinstance(outputs, torch.Tensor):
            raise TypeError(f"Embedder must return torch.Tensor, got {type(outputs)!r}")

        normalized = self._normalize_embeddings(outputs)
        return normalized.detach().cpu().tolist()
