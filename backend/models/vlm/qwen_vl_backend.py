from __future__ import annotations

from typing import List

from PIL import Image
from transformers import AutoProcessor
from transformers import Qwen3VLForConditionalGeneration

from backend.models.common.runtime import TorchDTypeLike
from backend.models.vlm.base import BaseVLM


class QwenVLMBackend(BaseVLM):
    DEFAULT_MODEL_NAME = "Qwen/Qwen3-VL-2B-Thinking"

    def __init__(
        self,
        model_name: str,
        device: str,
        torch_dtype: TorchDTypeLike,
        dtype_label: str,
        attn_implementation: str | None,
    ) -> None:
        super().__init__(model_name=model_name, device=device, torch_dtype=torch_dtype, dtype_label=dtype_label)
        requested_attn = str(attn_implementation).strip() if attn_implementation else ""
        self.attn_type = requested_attn or "default"
        model_kwargs = {
            "dtype": torch_dtype,
        }
        if requested_attn:
            model_kwargs["attn_implementation"] = requested_attn

        try:
            self.model = Qwen3VLForConditionalGeneration.from_pretrained(model_name, **model_kwargs).to(device)
        except ImportError as exc:
            lowered = str(exc).lower()
            if requested_attn == "flash_attention_2" and "flash_attn" in lowered:
                fallback_kwargs = dict(model_kwargs)
                fallback_kwargs["attn_implementation"] = "sdpa"
                self.model = Qwen3VLForConditionalGeneration.from_pretrained(
                    model_name,
                    **fallback_kwargs,
                ).to(device)
                self.attn_type = "sdpa (flash_attention_2 requested, flash_attn missing)"
            else:
                raise
        self.model.eval()
        self.processor = AutoProcessor.from_pretrained(model_name)

    @property
    def backend_name(self) -> str:
        return "QWEN"

    def _generate(self, image: Image.Image, prompt_text: str, max_new_tokens: int) -> str:
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": prompt_text},
                ],
            }
        ]

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        )
        inputs.pop("token_type_ids", None)
        inputs = {key: value.to(self.device) for key, value in inputs.items()}

        generated_ids = self.model.generate(**inputs, max_new_tokens=max_new_tokens)
        generated_ids_trimmed = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs["input_ids"], generated_ids)
        ]
        output_text = self.processor.batch_decode(
            generated_ids_trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0]
        return output_text.strip()

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
                        {"type": "image", "image": image},
                        {"type": "text", "text": prompt_text},
                    ],
                }
            ]
            for image, prompt_text in zip(images, prompt_texts)
        ]
        # Qwen3-VL docs recommend left padding for batched generation.
        self.processor.tokenizer.padding_side = "left"
        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
            padding=True,
        )
        inputs.pop("token_type_ids", None)
        inputs = {key: value.to(self.device) for key, value in inputs.items()}

        generated_ids = self.model.generate(**inputs, max_new_tokens=max_new_tokens)
        attention_mask = inputs.get("attention_mask")
        if attention_mask is None:
            prompt_lengths = [int(inputs["input_ids"].shape[1])] * len(prompt_texts)
        else:
            prompt_lengths = [int(mask.sum().item()) for mask in attention_mask]
        generated_ids_trimmed = [
            out_ids[prompt_len:]
            for out_ids, prompt_len in zip(generated_ids, prompt_lengths)
        ]
        output_texts = self.processor.batch_decode(
            generated_ids_trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )
        return [text.strip() for text in output_texts]
