from __future__ import annotations

from backend.models.common.runtime import TorchDTypeLike
from backend.models.vlm.base import BaseVLM


def create_vlm(
    backend_name: str,
    model_name: str | None,
    device: str,
    torch_dtype: TorchDTypeLike,
    dtype_label: str,
    attn_implementation: str | None,
) -> BaseVLM:
    normalized_backend = str(backend_name).strip().upper()
    if normalized_backend == "SMOLVLM":
        from backend.models.vlm.smolvlm_backend import SmolVLMBackend

        return SmolVLMBackend(
            model_name=model_name or SmolVLMBackend.DEFAULT_MODEL_NAME,
            device=device,
            torch_dtype=torch_dtype,
            dtype_label=dtype_label,
            attn_implementation=attn_implementation,
        )
    if normalized_backend == "QWEN":
        from backend.models.vlm.qwen_vl_backend import QwenVLMBackend

        return QwenVLMBackend(
            model_name=model_name or QwenVLMBackend.DEFAULT_MODEL_NAME,
            device=device,
            torch_dtype=torch_dtype,
            dtype_label=dtype_label,
            attn_implementation=attn_implementation,
        )
    raise ValueError(
        f"Unsupported VLM_BACKEND={backend_name!r}. "
        "Supported values: SMOLVLM, QWEN."
    )
