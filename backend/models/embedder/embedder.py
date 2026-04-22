import io
import threading
import os
import resource
from fastapi import FastAPI
from fastapi import UploadFile, File, Request
from PIL import Image
from transformers import AlignProcessor, AlignModel
from configs.hw_settings import EMBEDDER_CONFIG
import torch
from transformers import logging
from typing import Literal

from transformers import logging
logging.disable_progress_bar()

app = FastAPI(title="Align Text Embedding API")
inference_lock = threading.Lock()

# --- Choose device ---
cfg_device = EMBEDDER_CONFIG.DEVICE.lower()
if cfg_device == "cuda" and torch.cuda.is_available():
    device = "cuda"
elif cfg_device == "mps" and torch.backends.mps.is_available():
    device = "mps"
else:
    device = "cpu"

processor = AlignProcessor.from_pretrained("kakaobrain/align-base")
model = AlignModel.from_pretrained("kakaobrain/align-base").to(device)
model.eval()
print(
    f"Embedder has been successfully initialized.",
    f"Device: {device}.",
    f"Port: {EMBEDDER_CONFIG.PORT}"
)
if cfg_device != device:
    print(
        f"Your config device was: {device}, but currently is used {device}.",
        f"Check your {cfg_device} availability"
    )


def _process_rss_mb() -> float:
    # Linux containers expose resident pages in /proc/self/statm.
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
        # Linux reports KiB, macOS reports bytes.
        if rss > 10 ** 8:
            return round(rss / (1024 ** 2), 2)
        return round(rss / 1024.0, 2)
    except Exception:
        return 0.0


def _runtime_payload() -> dict:
    payload = {
        "configured_device": cfg_device,
        "selected_device": device,
        "torch_cuda_available": bool(torch.cuda.is_available()),
        "torch_mps_available": bool(torch.backends.mps.is_available()),
        "cuda_device_count": int(torch.cuda.device_count() if torch.cuda.is_available() else 0),
        "cuda_device_name": None,
    }

    memory = {
        "process_rss_mb": _process_rss_mb(),
        "gpu_allocated_mb": 0.0,
        "gpu_reserved_mb": 0.0,
        "gpu_total_mb": 0.0,
        "gpu_free_mb": 0.0,
    }

    if device == "cuda" and torch.cuda.is_available():
        try:
            current = torch.cuda.current_device()
            payload["cuda_device_name"] = torch.cuda.get_device_name(current)
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

    return {"runtime": payload, "memory": memory}


def extract_patches(image, patch: bool):
    return [image]


def get_embedding(inputs, type: Literal["text", "image"] = "image") -> torch.Tensor:
    with inference_lock, torch.no_grad():
        if type == "text":
            text_inputs = processor.tokenizer(
                inputs,
                return_tensors="pt",
                padding=True
            ).to(device)

            outputs = model.get_text_features(
                input_ids=text_inputs['input_ids'],
                attention_mask=text_inputs['attention_mask'],
                token_type_ids=text_inputs['token_type_ids']
            )
        elif type == "image":
            image_inputs = processor(
                images=inputs,
                return_tensors="pt"
            ).to(device)

            outputs = model.get_image_features(pixel_values=image_inputs['pixel_values'])
    
    if hasattr(outputs, "pooler_output"):
        outputs = outputs.pooler_output

    embedding = outputs / outputs.norm(dim=-1, keepdim=True)  # [1, D]
    embedding = embedding.cpu().tolist()[0]

    return embedding


@app.post("/embedding/text")
async def inference_text(text: str):
    embedding = get_embedding(text, type="text")

    return {
        "text": text,
        "embedding": embedding,
        "dim": len(embedding)
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
        "dim": len(embedding)
    }


@app.post("/embedding/image_bytes")
async def embedding_image_bytes(request: Request):
    image_bytes = await request.body()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    embedding = get_embedding(image, type="image")

    return {
        "image_shape": image.size,
        "embedding": embedding,
        "dim": len(embedding)
    }


@app.get("/health")
def healthcheck():
    runtime = _runtime_payload()
    return {
        "status": "ok",
        "service": "embedder",
        "model": "kakaobrain/align-base",
        **runtime,
    }
