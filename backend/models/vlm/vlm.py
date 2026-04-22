import io
import logging
import os
import resource
import threading
from typing import Optional

import torch
from fastapi import FastAPI, File, Form, UploadFile
from PIL import Image
from transformers import AutoModelForVision2Seq, AutoProcessor
from transformers import logging as hf_logging

from configs.hw_settings import VLM_CONFIG

hf_logging.disable_progress_bar()

app = FastAPI(title="SmolVLM API")
logger = logging.getLogger("avsp.vlm")
logging.basicConfig(level=logging.INFO)

request_lock = threading.Lock()
requests_received = 0
requests_completed = 0
requests_in_progress = 0


def _resolve_device() -> str:
    cfg_device = VLM_CONFIG.DEVICE.lower()
    if cfg_device == "cuda" and torch.cuda.is_available():
        device = "cuda"
    elif cfg_device == "mps" and torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    return device


DEVICE = _resolve_device()
TORCH_DTYPE = torch.bfloat16 if DEVICE == "cuda" else torch.float32

processor = AutoProcessor.from_pretrained(VLM_CONFIG.MODEL_NAME)
model_kwargs = {
    "torch_dtype": TORCH_DTYPE,
}
if DEVICE == "cuda":
    model_kwargs["_attn_implementation"] = "eager"

model = AutoModelForVision2Seq.from_pretrained(
    VLM_CONFIG.MODEL_NAME,
    **model_kwargs,
).to(DEVICE)
model.eval()

cfg_device = VLM_CONFIG.DEVICE.lower()
print(
    f"Embedder has been successfully initialized.",
    f"Device: {DEVICE}.",
    f"Port: {VLM_CONFIG.PORT}"
)
if cfg_device != DEVICE:
    print(
        f"Your config device was: {DEVICE}, but currently is used {DEVICE}.",
        f"Check your {cfg_device} availability"
    )


def _process_rss_mb() -> float:
    try:
        with open("/proc/self/statm", "r", encoding="utf-8") as fp:
            parts = fp.read().strip().split()
        if len(parts) >= 2:
            resident_pages = int(parts[1])
            page_size = os.sysconf("SC_PAGE_SIZE")
            return round((resident_pages * page_size) / (1024 ** 2), 2)
    except Exception:
        pass

    try:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        rss = float(usage.ru_maxrss)
        if rss > 10 ** 8:
            return round(rss / (1024 ** 2), 2)
        return round(rss / 1024.0, 2)
    except Exception:
        return 0.0


def _runtime_payload() -> dict:
    runtime = {
        "configured_device": cfg_device,
        "selected_device": DEVICE,
        "torch_cuda_available": bool(torch.cuda.is_available()),
        "torch_mps_available": bool(torch.backends.mps.is_available()),
        "cuda_device_count": int(torch.cuda.device_count() if torch.cuda.is_available() else 0),
        "cuda_device_name": None,
        "dtype": str(TORCH_DTYPE).replace("torch.", ""),
    }
    memory = {
        "process_rss_mb": _process_rss_mb(),
        "gpu_allocated_mb": 0.0,
        "gpu_reserved_mb": 0.0,
        "gpu_total_mb": 0.0,
        "gpu_free_mb": 0.0,
    }

    if DEVICE == "cuda" and torch.cuda.is_available():
        try:
            current = torch.cuda.current_device()
            runtime["cuda_device_name"] = torch.cuda.get_device_name(current)
            memory["gpu_allocated_mb"] = round(
                torch.cuda.memory_allocated(current) / (1024 ** 2), 2
            )
            memory["gpu_reserved_mb"] = round(
                torch.cuda.memory_reserved(current) / (1024 ** 2), 2
            )
            free_bytes, total_bytes = torch.cuda.mem_get_info(current)
            memory["gpu_total_mb"] = round(total_bytes / (1024 ** 2), 2)
            memory["gpu_free_mb"] = round(free_bytes / (1024 ** 2), 2)
        except Exception:
            pass

    counters = {
        "received": requests_received,
        "completed": requests_completed,
        "in_progress": requests_in_progress,
    }
    return {"runtime": runtime, "memory": memory, "counters": counters}


def _generate_text(image: Image.Image, prompt_text: str, max_new_tokens: int) -> str:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": prompt_text},
            ],
        }
    ]
    prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
    inputs = processor(text=prompt, images=[image], return_tensors="pt")
    inputs = {key: value.to(DEVICE) for key, value in inputs.items()}

    with torch.no_grad():
        generated_ids = model.generate(**inputs, max_new_tokens=max_new_tokens)

    prompt_length = inputs["input_ids"].shape[1]
    generated_only = generated_ids[:, prompt_length:]
    generated_text = processor.batch_decode(
        generated_only,
        skip_special_tokens=True,
    )[0]
    return generated_text.strip()


@app.get("/health")
def healthcheck():
    runtime = _runtime_payload()
    return {
        "status": "ok",
        "service": "vlm",
        "model": VLM_CONFIG.MODEL_NAME,
        "device": DEVICE,
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
            "model": VLM_CONFIG.MODEL_NAME,
            "device": DEVICE,
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
