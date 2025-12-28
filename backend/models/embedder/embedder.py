import io
from fastapi import FastAPI
from fastapi import UploadFile, File, Request
from PIL import Image
from transformers import AlignProcessor, AlignModel
import torch


app = FastAPI(title="Align Text Embedding API")

if torch.cuda.is_available():
    device = torch.device("cuda")
elif torch.backends.mps.is_available():
    device = torch.device("mps")
else:
    device = torch.device("cpu")

processor = AlignProcessor.from_pretrained("kakaobrain/align-base")
model = AlignModel.from_pretrained("kakaobrain/align-base").to(device)
model.eval()
print("Embedder has been successfully initialized")


def extract_patches(image, patch: bool):
    return [image]


@app.post("/embedding/text")
async def inference_text(text: str):
    inputs = processor.tokenizer(
        text,
        return_tensors="pt",
        padding=True
    ).to(device)

    with torch.no_grad():
        outputs = model.get_text_features(
            input_ids=inputs['input_ids'],
            attention_mask=inputs['attention_mask'],
            token_type_ids=inputs['token_type_ids'],
        )

    embedding = outputs / outputs.norm(dim=-1, keepdim=True)  # [1, D]
    embedding = embedding.cpu().tolist()[0]

    return {
        "text": text,
        "embedding": embedding,
        "dim": len(embedding)
    }


@app.post("/embedding/image")
async def inference_image(file: UploadFile = File(...)):
    image_bytes = file.file.read()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    inputs = processor(images=image, return_tensors="pt")
    with torch.no_grad():
        outputs = model.get_image_features(
            pixel_values=inputs['pixel_values'],
        )

    embedding = outputs / outputs.norm(dim=-1, keepdim=True)
    embedding = embedding.cpu().tolist()[0]

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

    inputs = processor(images=image, return_tensors="pt")
    with torch.no_grad():
        outputs = model.get_image_features(
            pixel_values=inputs['pixel_values'],
        )

    embedding = outputs / outputs.norm(dim=-1, keepdim=True)
    embedding = embedding.cpu().tolist()[0]

    return {
        "image_shape": image.size,
        "embedding": embedding,
        "dim": len(embedding)
    }
