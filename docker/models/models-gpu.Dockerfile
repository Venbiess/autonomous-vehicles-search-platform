FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    git curl ca-certificates \
    build-essential \
    libjpeg-turbo8 libpng16-16 zlib1g \
    libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --upgrade pip setuptools wheel

# ---- torch (GPU) ----
ARG TORCH_VERSION=2.9.1
ARG TORCH_CUDA_TAG=cu121
RUN python3 -m pip install \
    torch==${TORCH_VERSION} \
    --index-url https://download.pytorch.org/whl/${TORCH_CUDA_TAG}


COPY docker/requirements.txt /app/requirements.txt
RUN python3 -m pip install -r /app/requirements.txt

ENV HF_HOME=/app/.cache/huggingface

COPY server/ /app/server/
COPY configs/ /app/configs/
COPY backend/ /app/backend/

ENV PYTHONPATH=/app
EXPOSE 8000

CMD ["uvicorn", "backend.models.embedder.embedder:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "debug", "--reload"]
# uvicorn backend.models.embedder.embedder:app --host 0.0.0.0 --port 8000 --log-level debug --reload
