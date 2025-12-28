FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl \
    build-essential \
    libjpeg62-turbo libpng16-16 zlib1g \
    libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip setuptools wheel

# ---- torch (CPU) ----
ARG TORCH_VERSION=2.9.1
RUN pip install torch==${TORCH_VERSION} --index-url https://download.pytorch.org/whl/cpu

COPY docker/models/requirements.txt /requirements.txt
RUN pip install -r /requirements.txt

ENV HF_HOME=/app/.cache/huggingface

# COPY configs/ /app/configs/

ENV PYTHONPATH=/app
EXPOSE 8000

CMD ["uvicorn", "backend.models.embedder.embedder:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "debug", "--reload"]
# uvicorn backend.models.embedder.embedder:app --host 0.0.0.0 --port 8000 --log-level debug --reload