FROM python:3.10-slim

ARG TARGETARCH

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
ENV PYTHONPATH=/app

COPY configs/__init__.py /app/configs/__init__.py
COPY configs/hw_settings.py /app/configs/hw_settings.py

RUN python - <<'PY' > /etc/app.env
from configs.hw_settings import TORCH_CONFIG

print(f"TORCH_VERSION={TORCH_CONFIG.TORCH_VERSION}")
print(f"TORCH_CUDA_TAG={TORCH_CONFIG.TORCH_CUDA_TAG or 'cpu'}")
print(f"HF_HOME={getattr(TORCH_CONFIG, 'HF_HOME', 'app/.cache/huggingface')}")
PY

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl \
    build-essential \
    libjpeg62-turbo libpng16-16 zlib1g \
    libglib2.0-0 libsm6 libxext6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip setuptools wheel

# ---- torch ----
RUN . /etc/app.env && \
    TORCH_VERSION="${TORCH_VERSION:-2.9.1}" && \
    TORCH_CUDA_TAG="${TORCH_CUDA_TAG:-cpu}" && \
    if [ "$TORCH_CUDA_TAG" = "cpu" ] || [ "$TORCH_CUDA_TAG" = "None" ]; then \
      if [ "$TARGETARCH" = "arm64" ]; then \
        pip install --no-cache-dir --retries 10 --timeout 120 torch==${TORCH_VERSION} ; \
      else \
        pip install --no-cache-dir --retries 10 --timeout 120 torch==${TORCH_VERSION} \
          --index-url https://download.pytorch.org/whl/cpu ; \
      fi ; \
    else \
      pip install --no-cache-dir --retries 10 --timeout 120 torch==${TORCH_VERSION} \
        --index-url https://download.pytorch.org/whl/${TORCH_CUDA_TAG} ; \
    fi

COPY docker/models/requirements.txt /requirements.txt
RUN pip install -r /requirements.txt

COPY docker/models/start.sh /start.sh
RUN chmod +x /start.sh
ENV EMBEDDER_PORT=8000 \
    JUPYTER_PORT=8888
EXPOSE 8000 8001 8888
CMD ["/start.sh"]

# uvicorn backend.models.embedder.embedder:app --host 0.0.0.0 --port 8000 --log-level debug --reload
