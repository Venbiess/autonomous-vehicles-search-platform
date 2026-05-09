from __future__ import annotations

import io
import logging
import os
import threading
import time
from typing import List
from typing import Optional

from fastapi import FastAPI
from fastapi import File
from fastapi import Form
from fastapi import Request
from fastapi import UploadFile
from PIL import Image

from backend.models.common.hf import configure_hf_download_logging
from backend.models.common.runtime import resolve_bool_flag
from backend.models.common.runtime import resolve_device
from backend.models.common.runtime import resolve_torch_dtype
from backend.models.vlm.factory import create_vlm
from configs.hw_settings import TORCH_CONFIG
from configs.hw_settings import VLM_CONFIG

app = FastAPI(title="VLM API")
logger = logging.getLogger("avsp.vlm")
logging.basicConfig(level=logging.INFO)

request_lock = threading.Lock()
requests_received = 0
requests_completed = 0
requests_in_progress = 0
http_requests_in_progress = 0
last_request_finished_at = 0.0

cfg_device = str(VLM_CONFIG.DEVICE).lower()
device = resolve_device(cfg_device)
vlm_torch_dtype_raw = os.getenv(
    "VLM_TORCH_DTYPE",
    getattr(VLM_CONFIG, "TORCH_DTYPE", None),
)
vlm_torch_dtype, vlm_dtype_label = resolve_torch_dtype(vlm_torch_dtype_raw, device=device)
hf_download_progress = resolve_bool_flag(
    os.getenv(
        "VLM_HF_DOWNLOAD_PROGRESS",
        os.getenv(
            "HF_DOWNLOAD_PROGRESS",
            getattr(TORCH_CONFIG, "HF_DOWNLOAD_PROGRESS", True),
        ),
    ),
    default=True,
    name="HF_DOWNLOAD_PROGRESS",
)
configure_hf_download_logging(hf_download_progress)

vlm_backend = os.getenv(
    "VLM_BACKEND",
    str(getattr(VLM_CONFIG, "BACKEND", "SMOLVLM")),
)
vlm_model_name = os.getenv(
    "VLM_MODEL_NAME",
    getattr(VLM_CONFIG, "MODEL_NAME", None),
)
vlm_attn_implementation = os.getenv(
    "VLM_ATTN_IMPLEMENTATION",
    getattr(VLM_CONFIG, "ATTN_IMPLEMENTATION", None),
)
if isinstance(vlm_attn_implementation, str):
    vlm_attn_implementation = vlm_attn_implementation.strip() or None

init_started_at = time.time()
logger.info(
    "VLM init: loading backend=%s model=%s device=%s dtype=%s attn=%s",
    vlm_backend,
    vlm_model_name,
    device,
    vlm_dtype_label,
    vlm_attn_implementation or "default",
)
vlm = create_vlm(
    backend_name=vlm_backend,
    model_name=vlm_model_name,
    device=device,
    torch_dtype=vlm_torch_dtype,
    dtype_label=vlm_dtype_label,
    attn_implementation=vlm_attn_implementation,
)
logger.info("VLM init: total startup time %.1fs", max(time.time() - init_started_at, 0.0))

print(
    "VLM has been successfully initialized.",
    f"Backend: {vlm.backend_name}.",
    f"Model: {vlm.model_name}.",
    f"DType: {vlm.dtype_label}.",
    f"Attention: {getattr(vlm, 'attn_type', vlm_attn_implementation or 'default')}.",
    f"HFDownloadProgress: {hf_download_progress}.",
    f"Device: {vlm.device}.",
    f"Port: {VLM_CONFIG.PORT}",
)
if cfg_device != device:
    print(
        f"Your config device was: {cfg_device}, but currently is used {device}.",
        f"Check your {cfg_device} availability",
    )


def _runtime_payload() -> dict:
    payload = vlm.get_runtime_payload(configured_device=cfg_device)
    payload["counters"] = {
        "received": requests_received,
        "completed": requests_completed,
        "in_progress": requests_in_progress,
    }
    return payload


@app.middleware("http")
async def track_request_activity(request: Request, call_next):
    global http_requests_in_progress, last_request_finished_at
    should_track = request.url.path != "/health"
    with request_lock:
        if should_track:
            http_requests_in_progress += 1
    try:
        return await call_next(request)
    finally:
        if should_track:
            with request_lock:
                http_requests_in_progress = max(0, http_requests_in_progress - 1)
                last_request_finished_at = time.monotonic()


def has_active_http_requests(grace_period_sec: float = 0.0) -> bool:
    with request_lock:
        if http_requests_in_progress > 0:
            return True
        if grace_period_sec <= 0:
            return False
        return (time.monotonic() - last_request_finished_at) < grace_period_sec


def _generate_text(image: Image.Image, prompt_text: str, max_new_tokens: int) -> str:
    return vlm.generate_text(image=image, prompt_text=prompt_text, max_new_tokens=max_new_tokens)


def _generate_text_batch(
    images: List[Image.Image],
    prompt_texts: List[str],
    max_new_tokens: int,
) -> List[str]:
    return vlm.generate_text_batch(
        images=images,
        prompt_texts=prompt_texts,
        max_new_tokens=max_new_tokens,
    )


@app.get("/health")
def healthcheck():
    runtime = _runtime_payload()
    return {
        "status": "ok",
        "service": "vlm",
        "backend": vlm.backend_name,
        "model": vlm.model_name,
        "device": vlm.device,
        **runtime,
    }


@app.post("/generate")
async def generate(
    prompt: str = Form(...),
    file: UploadFile = File(...),
    max_new_tokens: Optional[int] = Form(128),
    job_id: Optional[str] = Form(None),
    task_index: Optional[int] = Form(None),
    task_total: Optional[int] = Form(None),
    field_name: Optional[str] = Form(None),
    storage_path: Optional[str] = Form(None),
):
    global requests_received, requests_completed, requests_in_progress

    with request_lock:
        requests_received += 1
        requests_in_progress += 1
        request_id = requests_received
        received = requests_received
        completed = requests_completed
        in_progress = requests_in_progress

    if task_index is not None and task_total is not None:
        logger.info(
            "VLM generate started: request=%s job=%s task=%s/%s in_progress=%s field=%s storage_path=%s filename=%s",
            request_id,
            job_id or "-",
            task_index,
            task_total,
            in_progress,
            field_name or "-",
            storage_path or "-",
            file.filename,
        )
    else:
        logger.info(
            "VLM generate started: request=%s completed=%s received=%s in_progress=%s filename=%s",
            request_id,
            completed,
            received,
            in_progress,
            file.filename,
        )

    try:
        image_bytes = await file.read()
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        generated_text = _generate_text(image, prompt, max_new_tokens or 64)
        return {
            "prompt": prompt,
            "response": generated_text,
            "model": vlm.model_name,
            "backend": vlm.backend_name,
            "device": vlm.device,
        }
    finally:
        with request_lock:
            requests_completed += 1
            requests_in_progress -= 1
            received = requests_received
            completed = requests_completed
            in_progress = requests_in_progress

        if task_index is not None and task_total is not None:
            logger.info(
                "VLM generate finished: request=%s job=%s task=%s/%s in_progress=%s field=%s storage_path=%s filename=%s",
                request_id,
                job_id or "-",
                task_index,
                task_total,
                in_progress,
                field_name or "-",
                storage_path or "-",
                file.filename,
            )
        else:
            logger.info(
                "VLM generate finished: request=%s completed=%s received=%s in_progress=%s filename=%s",
                request_id,
                completed,
                received,
                in_progress,
                file.filename,
            )
