import io
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


def extract_patches(image, patch: bool):
    return [image]


def get_embedding(inputs, type: Literal["text", "image"] = "image") -> torch.Tensor:
    with torch.no_grad():
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
