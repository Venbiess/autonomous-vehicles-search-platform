from __future__ import annotations

from PIL import Image
from transformers import AutoModelForImageTextToText
from transformers import AutoProcessor

from backend.models.common.runtime import TorchDTypeLike
from backend.models.vlm.base import BaseVLM


class SmolVLMBackend(BaseVLM):
    DEFAULT_MODEL_NAME = "HuggingFaceTB/SmolVLM-256M-Instruct"

    def __init__(self, model_name: str, device: str, torch_dtype: TorchDTypeLike, dtype_label: str) -> None:
        super().__init__(model_name=model_name, device=device, torch_dtype=torch_dtype, dtype_label=dtype_label)
        self.processor = AutoProcessor.from_pretrained(model_name)
        model_kwargs = {
            "dtype": torch_dtype,
        }
        if device == "cuda":
            model_kwargs["_attn_implementation"] = "eager"
        self.model = AutoModelForImageTextToText.from_pretrained(model_name, **model_kwargs).to(device)
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
