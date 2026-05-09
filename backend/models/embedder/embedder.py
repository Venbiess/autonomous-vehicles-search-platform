from __future__ import annotations

import io
import os
import threading
import time
from typing import Literal
from typing import Optional

from fastapi import FastAPI
from fastapi import File
from fastapi import Request
from fastapi import UploadFile
from PIL import Image

from backend.models.common.hf import configure_hf_download_logging
from backend.models.common.runtime import resolve_bool_flag
from backend.models.common.runtime import resolve_torch_dtype
from backend.models.embedder.base import resolve_device
from backend.models.embedder.base import runtime_payload
from backend.models.embedder.factory import create_embedder
from configs.hw_settings import EMBEDDER_CONFIG
from configs.hw_settings import TORCH_CONFIG

app = FastAPI(title="Embedder API")

request_lock = threading.Lock()
requests_in_progress = 0
last_request_finished_at = 0.0

cfg_device = str(EMBEDDER_CONFIG.DEVICE).lower()
device = resolve_device(cfg_device)
embedder_backend = os.getenv(
    "EMBEDDER_BACKEND",
    str(getattr(EMBEDDER_CONFIG, "BACKEND", "ALIGN")),
)
embedder_model_name = os.getenv(
    "EMBEDDER_MODEL_NAME",
    getattr(EMBEDDER_CONFIG, "MODEL_NAME", None),
)
embedder_torch_dtype_raw = os.getenv(
    "EMBEDDER_TORCH_DTYPE",
    getattr(EMBEDDER_CONFIG, "TORCH_DTYPE", None),
)
embedder_torch_dtype, embedder_dtype_label = resolve_torch_dtype(
    embedder_torch_dtype_raw,
    device=device,
    default_cuda="float32",
    default_other="float32",
)
embedder_attn_implementation_raw = os.getenv(
    "EMBEDDER_ATTN_IMPLEMENTATION",
    getattr(EMBEDDER_CONFIG, "ATTN_IMPLEMENTATION", None),
)
embedder_attn_implementation: Optional[str] = (
    str(embedder_attn_implementation_raw).strip() if embedder_attn_implementation_raw else None
)
if embedder_attn_implementation == "":
    embedder_attn_implementation = None
hf_download_progress = resolve_bool_flag(
    os.getenv(
        "EMBEDDER_HF_DOWNLOAD_PROGRESS",
        os.getenv(
            "HF_DOWNLOAD_PROGRESS",
            getattr(TORCH_CONFIG, "HF_DOWNLOAD_PROGRESS", True),
        ),
    ),
    default=True,
    name="HF_DOWNLOAD_PROGRESS",
)

configure_hf_download_logging(hf_download_progress)

embedder = create_embedder(
    backend_name=embedder_backend,
    model_name=embedder_model_name,
    device=device,
    torch_dtype=embedder_torch_dtype,
    dtype_label=embedder_dtype_label,
    attn_implementation=embedder_attn_implementation,
)
print(
    "Embedder has been successfully initialized.",
    f"Backend: {embedder.backend_name}.",
    f"Model: {embedder.model_name}.",
    f"DType: {embedder.dtype_label}.",
    f"Attention: {getattr(embedder, 'attn_type', embedder_attn_implementation or 'default')}.",
    f"HFDownloadProgress: {hf_download_progress}.",
    f"Device: {device}.",
    f"Port: {EMBEDDER_CONFIG.PORT}",
)
if cfg_device != device:
    print(
        f"Your config device was: {cfg_device}, but currently is used {device}.",
        f"Check your {cfg_device} availability",
    )


@app.middleware("http")
async def track_request_activity(request: Request, call_next):
    global requests_in_progress, last_request_finished_at
    should_track = request.url.path != "/health"
    with request_lock:
        if should_track:
            requests_in_progress += 1
    try:
        return await call_next(request)
    finally:
        if should_track:
            with request_lock:
                requests_in_progress = max(0, requests_in_progress - 1)
                last_request_finished_at = time.monotonic()


def has_active_http_requests(grace_period_sec: float = 0.0) -> bool:
    with request_lock:
        if requests_in_progress > 0:
            return True
        if grace_period_sec <= 0:
            return False
        return (time.monotonic() - last_request_finished_at) < grace_period_sec


def get_embedding(inputs, type: Literal["text", "image"] = "image") -> list[float]:
    return embedder.get_embedding(inputs=inputs, input_type=type)


def get_embeddings(inputs, type: Literal["text", "image"] = "image") -> list[list[float]]:
    return embedder.get_embeddings(inputs=inputs, input_type=type)


def _runtime_payload() -> dict:
    payload = runtime_payload(configured_device=cfg_device, selected_device=device)
    payload["runtime"]["dtype"] = embedder.dtype_label
    payload["runtime"]["attn_type"] = getattr(embedder, "attn_type", embedder_attn_implementation or "default")
    return payload


@app.post("/embedding/text")
async def inference_text(text: str):
    embedding = get_embedding(text, type="text")

    return {
        "text": text,
        "embedding": embedding,
        "dim": len(embedding),
    }


@app.post("/embedding/image")
async def inference_image(file: UploadFile = File(...)):
    image_bytes = file.file.read()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    embedding = get_embedding(image, type="image")

    return {
        "filename": file.filename,
        "image_shape": image.size,
        "embedding": embedding,
        "dim": len(embedding),
    }


@app.post("/embedding/image_bytes")
async def embedding_image_bytes(request: Request):
    image_bytes = await request.body()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    embedding = get_embedding(image, type="image")

    return {
        "image_shape": image.size,
        "embedding": embedding,
        "dim": len(embedding),
    }


@app.get("/health")
def healthcheck():
    runtime = _runtime_payload()
    return {
        "status": "ok",
        "service": "embedder",
        "backend": embedder.backend_name,
        "model": embedder.model_name,
        **runtime,
    }
