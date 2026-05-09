from __future__ import annotations

import torch
from PIL import Image
from transformers import AlignModel, AlignProcessor

from backend.models.embedder.base import BaseEmbedder
from backend.models.common.runtime import TorchDTypeLike


class AlignEmbedder(BaseEmbedder):
    DEFAULT_MODEL_NAME = "kakaobrain/align-base"

    def __init__(self, model_name: str, device: str, torch_dtype: TorchDTypeLike, dtype_label: str) -> None:
        super().__init__(model_name=model_name, device=device, torch_dtype=torch_dtype, dtype_label=dtype_label)
        self.processor = AlignProcessor.from_pretrained(model_name)
        model_kwargs = {}
        if torch_dtype is not None:
            model_kwargs["dtype"] = torch_dtype
        self.model = AlignModel.from_pretrained(model_name, **model_kwargs).to(device)
        self.model.eval()

    @property
    def backend_name(self) -> str:
        return "ALIGN"

    def _embed_text(self, text: str) -> torch.Tensor:
        text_inputs = self.processor.tokenizer(text, return_tensors="pt", padding=True).to(self.device)
        outputs = self.model.get_text_features(
            input_ids=text_inputs["input_ids"],
            attention_mask=text_inputs["attention_mask"],
            token_type_ids=text_inputs["token_type_ids"],
        )
        if hasattr(outputs, "pooler_output"):
            return outputs.pooler_output
        return outputs

    def _embed_image(self, image: Image.Image) -> torch.Tensor:
        image_inputs = self.processor(images=image, return_tensors="pt").to(self.device)
        outputs = self.model.get_image_features(pixel_values=image_inputs["pixel_values"])
        if hasattr(outputs, "pooler_output"):
            return outputs.pooler_output
        return outputs
