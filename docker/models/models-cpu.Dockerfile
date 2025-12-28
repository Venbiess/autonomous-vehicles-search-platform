FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
ENV PYTHONPATH=/app

COPY configs/ /app/configs

RUN python - <<'PY' > /tmp/build.env
from configs.hw_settings import TORCH_CONFIG, EMBEDDER_CONFIG, VLM_CONFIG

print(f"TORCH_VERSION={TORCH_CONFIG.TORCH_VERSION}")
print(f"TORCH_CUDA_TAG={TORCH_CONFIG.TORCH_CUDA_TAG or 'cpu'}")
print(f"HF_HOME={getattr(TORCH_CONFIG, 'HF_HOME', '.cache/huggingface')}")
print(f"EMBEDDER_PORT={EMBEDDER_CONFIG.PORT}")
print(f"VLM_PORT={VLM_CONFIG.PORT}")
PY

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl \
    build-essential \
    libjpeg62-turbo libpng16-16 zlib1g \
    libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip setuptools wheel

# ---- torch ----
RUN . /tmp/build.env && \
    if [ "$TORCH_CUDA_TAG" = "cpu" ] || [ "$TORCH_CUDA_TAG" = "None" ]; then \
      pip install --no-cache-dir torch==${TORCH_VERSION} \
        --index-url https://download.pytorch.org/whl/cpu ; \
    else \
      pip install --no-cache-dir torch==${TORCH_VERSION}+${TORCH_CUDA_TAG} \
        --index-url https://download.pytorch.org/whl/${TORCH_CUDA_TAG} ; \
    fi

COPY docker/models/requirements.txt /requirements.txt
RUN pip install -r /requirements.txt

EXPOSE ${EMBEDDER_PORT}

CMD sh -c "uvicorn backend.models.embedder.embedder:app \
  --host 0.0.0.0 \
  --port ${EMBEDDER_PORT} \
  --log-level debug \
  --reload"
# uvicorn backend.models.embedder.embedder:app --host 0.0.0.0 --port 8000 --log-level debug --reload