from __future__ import annotations

from PIL import Image
from transformers import AutoProcessor
from transformers import Qwen3VLForConditionalGeneration

from backend.models.common.runtime import TorchDTypeLike
from backend.models.vlm.base import BaseVLM


class QwenVLMBackend(BaseVLM):
    DEFAULT_MODEL_NAME = "Qwen/Qwen3-VL-8B-Thinking"

    def __init__(
        self,
        model_name: str,
        device: str,
        torch_dtype: TorchDTypeLike,
        dtype_label: str,
        attn_implementation: str | None,
    ) -> None:
        super().__init__(model_name=model_name, device=device, torch_dtype=torch_dtype, dtype_label=dtype_label)
        model_kwargs = {
            "dtype": torch_dtype,
        }
        if attn_implementation:
            model_kwargs["attn_implementation"] = attn_implementation

        self.model = Qwen3VLForConditionalGeneration.from_pretrained(model_name, **model_kwargs).to(device)
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
