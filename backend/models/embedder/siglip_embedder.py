from __future__ import annotations

from typing import Optional

import torch
from PIL import Image
from transformers import SiglipModel, SiglipProcessor

from backend.models.common.runtime import TorchDTypeLike
from backend.models.embedder.base import BaseEmbedder


class SiglipEmbedder(BaseEmbedder):
    DEFAULT_MODEL_NAME = "google/siglip-base-patch16-224"

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

        self.processor = SiglipProcessor.from_pretrained(model_name)
        self.model = self._load_model(model_name, torch_dtype, requested_attn).to(device)
        self.model.eval()

        vision_model = getattr(self.model, "vision_model", None)
        if vision_model is not None:
            try:
                self._vision_input_dtype = next(vision_model.parameters()).dtype
            except StopIteration:
                self._vision_input_dtype = torch.float32
        else:
            try:
                self._vision_input_dtype = next(self.model.parameters()).dtype
            except StopIteration:
                self._vision_input_dtype = torch.float32

    @staticmethod
    def _extract_features(outputs) -> torch.Tensor:
        if isinstance(outputs, tuple):
            outputs = outputs[0]
        if hasattr(outputs, "pooler_output"):
            outputs = outputs.pooler_output
        if outputs.dim() == 3:
            outputs = outputs[:, 0, :]
        return outputs

    def _load_model(
        self,
        model_name: str,
        torch_dtype: TorchDTypeLike,
        requested_attn: str,
    ) -> SiglipModel:
        model_kwargs = {}
        if torch_dtype is not None:
            model_kwargs["torch_dtype"] = torch_dtype
        if requested_attn:
            model_kwargs["attn_implementation"] = requested_attn

        try:
            return SiglipModel.from_pretrained(model_name, **model_kwargs)
        except ImportError as exc:
            lowered = str(exc).lower()
            if requested_attn == "flash_attention_2" and "flash_attn" in lowered:
                fallback_kwargs = dict(model_kwargs)
                fallback_kwargs["attn_implementation"] = "sdpa"
                self.attn_type = "sdpa (flash_attention_2 requested, flash_attn missing)"
                return SiglipModel.from_pretrained(model_name, **fallback_kwargs)
            raise
        except TypeError as exc:
            lowered = str(exc).lower()
            if requested_attn and "attn_implementation" in lowered:
                fallback_kwargs = dict(model_kwargs)
                fallback_kwargs.pop("attn_implementation", None)
                self.attn_type = "default (attn_implementation unsupported)"
                return SiglipModel.from_pretrained(model_name, **fallback_kwargs)
            raise

    @property
    def backend_name(self) -> str:
        return "SIGLIP"

    def _embed_text(self, text: str) -> torch.Tensor:
        return self._embed_text_batch([text])[0]

    def _embed_text_batch(self, texts: list[str]) -> torch.Tensor:
        # SigLIP retrieval quality depends on fixed-length padding.
        text_inputs = self.processor(
            text=texts,
            return_tensors="pt",
            padding="max_length",
            truncation=True,
        )
        text_inputs = {
            key: value.to(self.device)
            for key, value in text_inputs.items()
            if key in {"input_ids", "attention_mask", "token_type_ids", "position_ids"}
        }
        outputs = self.model.get_text_features(**text_inputs)
        return self._extract_features(outputs)

    def _embed_image(self, image: Image.Image) -> torch.Tensor:
        return self._embed_image_batch([image])[0]

    def _embed_image_batch(self, images: list[Image.Image]) -> torch.Tensor:
        image_inputs = self.processor(images=images, return_tensors="pt")
        pixel_values = image_inputs["pixel_values"].to(self.device)
        if pixel_values.dtype != self._vision_input_dtype:
            pixel_values = pixel_values.to(dtype=self._vision_input_dtype)
        outputs = self.model.get_image_features(pixel_values=pixel_values)
        return self._extract_features(outputs)
