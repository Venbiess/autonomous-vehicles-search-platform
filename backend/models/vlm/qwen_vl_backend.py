from __future__ import annotations

import logging
from typing import List

from PIL import Image
from transformers import AutoProcessor
from transformers import Qwen3VLForConditionalGeneration

from backend.models.common.runtime import TorchDTypeLike
from backend.models.vlm.base import BaseVLM
from configs.common import VLM_DEBUG_EMPTY_OUTPUT

logger = logging.getLogger(__name__)


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
        self._debug_empty_output = bool(VLM_DEBUG_EMPTY_OUTPUT)
        tokenizer = getattr(self.processor, "tokenizer", None)
        generation_cfg = getattr(self.model, "generation_config", None)
        logger.info(
            "QWEN_VLM generation setup: pad_token_id=%s eos_token_id=%s cfg_max_length=%s cfg_max_new_tokens=%s cfg_do_sample=%s cfg_temperature=%s cfg_top_p=%s cfg_top_k=%s",
            getattr(tokenizer, "pad_token_id", None),
            getattr(tokenizer, "eos_token_id", None),
            getattr(generation_cfg, "max_length", None),
            getattr(generation_cfg, "max_new_tokens", None),
            getattr(generation_cfg, "do_sample", None),
            getattr(generation_cfg, "temperature", None),
            getattr(generation_cfg, "top_p", None),
            getattr(generation_cfg, "top_k", None),
        )

    def _log_empty_generation(
        self,
        *,
        prompt_text: str,
        prompt_len: int,
        full_ids,
        new_ids,
        decoded_full_keep_special: str,
        decoded_new_keep_special: str,
        decoded_new_skip_special: str,
    ) -> None:
        if not self._debug_empty_output:
            return
        logger.warning(
            "QWEN_VLM empty output: prompt_len=%s full_ids_len=%s new_ids_len=%s prompt_preview=%r new_ids=%s "
            "decode_full_keep_special=%r decode_new_keep_special=%r decode_new_skip_special=%r",
            prompt_len,
            len(full_ids),
            len(new_ids),
            str(prompt_text)[:180],
            list(new_ids),
            decoded_full_keep_special[:320],
            decoded_new_keep_special[:320],
            decoded_new_skip_special[:320],
        )

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

        generated_ids = self.model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            num_beams=1,
        )
        generated_ids_trimmed = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs["input_ids"], generated_ids)
        ]
        output_text = self.processor.batch_decode(
            generated_ids_trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0]
        normalized = output_text.strip()
        if not normalized:
            full_ids = generated_ids[0]
            new_ids = generated_ids_trimmed[0]
            self._log_empty_generation(
                prompt_text=prompt_text,
                prompt_len=len(inputs["input_ids"][0]),
                full_ids=full_ids,
                new_ids=new_ids,
                decoded_full_keep_special=self.processor.decode(
                    full_ids, skip_special_tokens=False, clean_up_tokenization_spaces=False
                ),
                decoded_new_keep_special=self.processor.decode(
                    new_ids, skip_special_tokens=False, clean_up_tokenization_spaces=False
                ),
                decoded_new_skip_special=self.processor.decode(
                    new_ids, skip_special_tokens=True, clean_up_tokenization_spaces=False
                ),
            )
        return normalized

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

        generated_ids = self.model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            num_beams=1,
        )
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
        normalized = [text.strip() for text in output_texts]
        if self._debug_empty_output:
            for idx, text in enumerate(normalized):
                if text:
                    continue
                full_ids = generated_ids[idx]
                new_ids = generated_ids_trimmed[idx]
                self._log_empty_generation(
                    prompt_text=prompt_texts[idx],
                    prompt_len=prompt_lengths[idx],
                    full_ids=full_ids,
                    new_ids=new_ids,
                    decoded_full_keep_special=self.processor.decode(
                        full_ids, skip_special_tokens=False, clean_up_tokenization_spaces=False
                    ),
                    decoded_new_keep_special=self.processor.decode(
                        new_ids, skip_special_tokens=False, clean_up_tokenization_spaces=False
                    ),
                    decoded_new_skip_special=self.processor.decode(
                        new_ids, skip_special_tokens=True, clean_up_tokenization_spaces=False
                    ),
                )
        return normalized
