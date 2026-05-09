from __future__ import annotations

from typing import Optional

import torch
from PIL import Image
from transformers import AlignModel, AlignProcessor

from backend.models.embedder.base import BaseEmbedder
from backend.models.common.runtime import TorchDTypeLike


class AlignEmbedder(BaseEmbedder):
    DEFAULT_MODEL_NAME = "kakaobrain/align-base"

    def __init__(
        self,
        model_name: str,
        device: str,
        torch_dtype: TorchDTypeLike,
        dtype_label: str,
        attn_implementation: Optional[str] = None,
    ) -> None:
        super().__init__(model_name=model_name, device=device, torch_dtype=torch_dtype, dtype_label=dtype_label)
        self.attn_type = str(attn_implementation).strip() if attn_implementation else "default"
        self.processor = AlignProcessor.from_pretrained(model_name)
        model_kwargs = {}
        if torch_dtype is not None:
            model_kwargs["torch_dtype"] = torch_dtype
        if attn_implementation:
            model_kwargs["attn_implementation"] = str(attn_implementation).strip()
        self.model = AlignModel.from_pretrained(model_name, **model_kwargs).to(device)
        self.model.eval()
        vision_conv = self.model.vision_model.embeddings.convolution
        self._vision_input_dtype = vision_conv.weight.dtype

    @property
    def backend_name(self) -> str:
        return "ALIGN"

    def _embed_text(self, text: str) -> torch.Tensor:
        return self._embed_text_batch([text])[0]

    def _embed_text_batch(self, texts: list[str]) -> torch.Tensor:
        text_inputs = self.processor.tokenizer(texts, return_tensors="pt", padding=True).to(self.device)
        outputs = self.model.get_text_features(
            input_ids=text_inputs["input_ids"],
            attention_mask=text_inputs["attention_mask"],
            token_type_ids=text_inputs["token_type_ids"],
        )
        if hasattr(outputs, "pooler_output"):
            return outputs.pooler_output
        return outputs

    def _embed_image(self, image: Image.Image) -> torch.Tensor:
        return self._embed_image_batch([image])[0]

    def _embed_image_batch(self, images: list[Image.Image]) -> torch.Tensor:
        image_inputs = self.processor(images=images, return_tensors="pt").to(self.device)
        pixel_values = image_inputs["pixel_values"]
        if pixel_values.dtype != self._vision_input_dtype:
            pixel_values = pixel_values.to(dtype=self._vision_input_dtype)
        outputs = self.model.get_image_features(pixel_values=pixel_values)
        if hasattr(outputs, "pooler_output"):
            return outputs.pooler_output
        return outputs
