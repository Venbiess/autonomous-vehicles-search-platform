from __future__ import annotations

import torch
from PIL import Image
from sentence_transformers import SentenceTransformer

from backend.models.common.runtime import TorchDTypeLike
from backend.models.embedder.base import BaseEmbedder


class QwenEmbedder(BaseEmbedder):
    DEFAULT_MODEL_NAME = "Qwen/Qwen3-VL-Embedding-2B"

    def __init__(self, model_name: str, device: str, torch_dtype: TorchDTypeLike, dtype_label: str) -> None:
        super().__init__(model_name=model_name, device=device, torch_dtype=torch_dtype, dtype_label=dtype_label)
        model_kwargs = {}
        if torch_dtype is not None:
            model_kwargs["dtype"] = torch_dtype
        self.model = SentenceTransformer(
            model_name,
            device=device,
            trust_remote_code=True,
            model_kwargs=model_kwargs or None,
        )

    @property
    def backend_name(self) -> str:
        return "QWEN"

    def _encode_single(self, item: str | Image.Image) -> torch.Tensor:
        return self.model.encode(
            [item],
            convert_to_tensor=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )[0]

    def _embed_text(self, text: str) -> torch.Tensor:
        return self._encode_single(text)

    def _embed_image(self, image: Image.Image) -> torch.Tensor:
        return self._encode_single(image)
