from __future__ import annotations

import logging
from typing import List

from PIL import Image
from transformers import AutoModelForImageTextToText
from transformers import AutoProcessor

from backend.models.common.runtime import TorchDTypeLike
from backend.models.vlm.base import BaseVLM
from configs.common import VLM_DEBUG_EMPTY_OUTPUT

logger = logging.getLogger(__name__)


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
        self._debug_empty_output = bool(VLM_DEBUG_EMPTY_OUTPUT)
        tokenizer = getattr(self.processor, "tokenizer", None)
        generation_cfg = getattr(self.model, "generation_config", None)
        logger.info(
            "SMOLVLM generation setup: pad_token_id=%s eos_token_id=%s cfg_max_length=%s cfg_max_new_tokens=%s cfg_do_sample=%s cfg_temperature=%s cfg_top_p=%s cfg_top_k=%s",
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
            "SMOLVLM empty output: prompt_len=%s full_ids_len=%s new_ids_len=%s prompt_preview=%r new_ids=%s "
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
        return "SMOLVLM"

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

        prompt_length = int(inputs.get("attention_mask", inputs["input_ids"]).sum().item())
        full_ids = generated_ids[0]
        generated_only = full_ids[prompt_length:]
        generated_text = self.processor.decode(
            generated_only,
            skip_special_tokens=True,
        )
        normalized = generated_text.strip()
        if not normalized:
            decoded_full_keep_special = self.processor.decode(full_ids, skip_special_tokens=False)
            decoded_new_keep_special = self.processor.decode(generated_only, skip_special_tokens=False)
            decoded_new_skip_special = self.processor.decode(generated_only, skip_special_tokens=True)
            self._log_empty_generation(
                prompt_text=prompt_text,
                prompt_len=prompt_length,
                full_ids=full_ids,
                new_ids=generated_only,
                decoded_full_keep_special=decoded_full_keep_special,
                decoded_new_keep_special=decoded_new_keep_special,
                decoded_new_skip_special=decoded_new_skip_special,
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
        generated_only = [output_ids[prompt_len:] for output_ids, prompt_len in zip(generated_ids, prompt_lengths)]
        generated_texts = self.processor.batch_decode(
            generated_only,
            skip_special_tokens=True,
        )
        normalized = [text.strip() for text in generated_texts]
        if self._debug_empty_output:
            for idx, text in enumerate(normalized):
                if text:
                    continue
                full_ids = generated_ids[idx]
                new_ids = generated_only[idx]
                self._log_empty_generation(
                    prompt_text=prompt_texts[idx],
                    prompt_len=prompt_lengths[idx],
                    full_ids=full_ids,
                    new_ids=new_ids,
                    decoded_full_keep_special=self.processor.decode(
                        full_ids, skip_special_tokens=False
                    ),
                    decoded_new_keep_special=self.processor.decode(
                        new_ids, skip_special_tokens=False
                    ),
                    decoded_new_skip_special=self.processor.decode(
                        new_ids, skip_special_tokens=True
                    ),
                )
        return normalized
