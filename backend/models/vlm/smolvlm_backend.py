from __future__ import annotations

from typing import List

from PIL import Image
from transformers import AutoModelForImageTextToText
from transformers import AutoProcessor

from backend.models.common.runtime import TorchDTypeLike
from backend.models.vlm.base import BaseVLM


class SmolVLMBackend(BaseVLM):
    DEFAULT_MODEL_NAME = "HuggingFaceTB/SmolVLM-256M-Instruct"

    def __init__(
        self,
        model_name: str,
        device: str,
        torch_dtype: TorchDTypeLike,
        dtype_label: str,
        attn_implementation: str | None,
    ) -> None:
        super().__init__(model_name=model_name, device=device, torch_dtype=torch_dtype, dtype_label=dtype_label)
        self.processor = AutoProcessor.from_pretrained(model_name)
        requested_attn = str(attn_implementation).strip() if attn_implementation else ""
        model_kwargs = {
            "dtype": torch_dtype,
        }
        if device == "cuda":
            selected_attn = requested_attn or "eager"
            model_kwargs["attn_implementation"] = selected_attn
            self.attn_type = selected_attn
        try:
            self.model = AutoModelForImageTextToText.from_pretrained(model_name, **model_kwargs).to(device)
        except ImportError as exc:
            lowered = str(exc).lower()
            if requested_attn == "flash_attention_2" and "flash_attn" in lowered:
                fallback_kwargs = dict(model_kwargs)
                fallback_kwargs["attn_implementation"] = "sdpa"
                self.model = AutoModelForImageTextToText.from_pretrained(
                    model_name,
                    **fallback_kwargs,
                ).to(device)
                self.attn_type = "sdpa (flash_attention_2 requested, flash_attn missing)"
            else:
                raise
        self.model.eval()

    @property
    def backend_name(self) -> str:
        return "SMOLVLM"

    def _generate(self, image: Image.Image, prompt_text: str, max_new_tokens: int) -> str:
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": prompt_text},
                ],
            }
        ]
        prompt = self.processor.apply_chat_template(messages, add_generation_prompt=True)
        inputs = self.processor(text=prompt, images=[image], return_tensors="pt")
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        generated_ids = self.model.generate(**inputs, max_new_tokens=max_new_tokens)

        prompt_length = inputs["input_ids"].shape[1]
        generated_only = generated_ids[:, prompt_length:]
        generated_text = self.processor.batch_decode(
            generated_only,
            skip_special_tokens=True,
        )[0]
        return generated_text.strip()

    def _generate_batch(
        self,
        images: List[Image.Image],
        prompt_texts: List[str],
        max_new_tokens: int,
    ) -> List[str]:
        messages = [
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "image"},
                        {"type": "text", "text": prompt_text},
                    ],
                }
            ]
            for prompt_text in prompt_texts
        ]
        prompts = [
            self.processor.apply_chat_template(message, add_generation_prompt=True)
            for message in messages
        ]
        inputs = self.processor(
            text=prompts,
            images=images,
            return_tensors="pt",
            padding=True,
        )
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        generated_ids = self.model.generate(**inputs, max_new_tokens=max_new_tokens)
        attention_mask = inputs.get("attention_mask")
        if attention_mask is None:
            prompt_lengths = [int(inputs["input_ids"].shape[1])] * len(prompt_texts)
        else:
            prompt_lengths = [int(mask.sum().item()) for mask in attention_mask]
        generated_only = [
            output_ids[prompt_len:]
            for output_ids, prompt_len in zip(generated_ids, prompt_lengths)
        ]
        generated_texts = self.processor.batch_decode(
            generated_only,
            skip_special_tokens=True,
        )
        return [text.strip() for text in generated_texts]
