from __future__ import annotations

from typing import Optional

from backend.models.common.runtime import TorchDTypeLike
from backend.models.embedder.base import BaseEmbedder


def create_embedder(
    backend_name: str,
    model_name: str | None,
    device: str,
    torch_dtype: TorchDTypeLike,
    dtype_label: str,
    attn_implementation: Optional[str] = None,
) -> BaseEmbedder:
    normalized_backend = str(backend_name).strip().upper()
    if normalized_backend == "ALIGN":
        from backend.models.embedder.align_embedder import AlignEmbedder

        return AlignEmbedder(
            model_name or AlignEmbedder.DEFAULT_MODEL_NAME,
            device=device,
            torch_dtype=torch_dtype,
            dtype_label=dtype_label,
            attn_implementation=attn_implementation,
        )
    if normalized_backend == "QWEN":
        from backend.models.embedder.qwen_embedder import QwenEmbedder

        return QwenEmbedder(
            model_name or QwenEmbedder.DEFAULT_MODEL_NAME,
            device=device,
            torch_dtype=torch_dtype,
            dtype_label=dtype_label,
            attn_implementation=attn_implementation,
        )
    raise ValueError(
        f"Unsupported EMBEDDER_BACKEND={backend_name!r}. "
        "Supported values: ALIGN, QWEN."
    )
