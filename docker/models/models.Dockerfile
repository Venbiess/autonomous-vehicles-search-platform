FROM python:3.10-slim

ARG TARGETARCH
ARG EMBEDDER_ATTN_IMPLEMENTATION_OVERRIDE=""

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
ENV PYTHONPATH=/app

COPY configs/__init__.py /app/configs/__init__.py
COPY configs/hw_settings.py /app/configs/hw_settings.py

RUN python - <<'PY' > /etc/app.env
from configs.hw_settings import EMBEDDER_CONFIG, TORCH_CONFIG, VLM_CONFIG

print(f"TORCH_VERSION={TORCH_CONFIG.TORCH_VERSION}")
print(f"TORCH_CUDA_TAG={TORCH_CONFIG.TORCH_CUDA_TAG or 'cpu'}")
print(f"HF_HOME={getattr(TORCH_CONFIG, 'HF_HOME', 'app/.cache/huggingface')}")
print(f"EMBEDDER_PORT={EMBEDDER_CONFIG.PORT}")
print(f"VLM_PORT={VLM_CONFIG.PORT}")
print(f"EMBEDDER_ATTN_IMPLEMENTATION={getattr(EMBEDDER_CONFIG, 'ATTN_IMPLEMENTATION', '') or ''}")
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

# Optional FlashAttention install:
# install only when embedder attention is explicitly set to flash_attention_2.
# Project recommendation: pip install flash-attn --no-build-isolation.
RUN . /etc/app.env && \
    TORCH_CUDA_TAG="${TORCH_CUDA_TAG:-cpu}" && \
    EMBEDDER_ATTN_IMPLEMENTATION="${EMBEDDER_ATTN_IMPLEMENTATION:-}" && \
    EFFECTIVE_ATTN_IMPLEMENTATION="${EMBEDDER_ATTN_IMPLEMENTATION_OVERRIDE:-$EMBEDDER_ATTN_IMPLEMENTATION}" && \
    if [ "$TORCH_CUDA_TAG" != "cpu" ] && [ "$TORCH_CUDA_TAG" != "None" ] && [ "$EFFECTIVE_ATTN_IMPLEMENTATION" = "flash_attention_2" ]; then \
      echo "flash_attention_2 requested: attempting to install flash-attn"; \
      pip install --no-cache-dir --retries 10 --timeout 120 packaging psutil ninja && \
      MAX_JOBS="${FLASH_ATTN_MAX_JOBS:-4}" pip install --no-cache-dir --retries 3 --timeout 180 flash-attn --no-build-isolation || \
      echo "WARNING: flash-attn install failed; runtime will fall back to non-flash attention"; \
    else \
      echo "flash-attn install skipped (attn=${EFFECTIVE_ATTN_IMPLEMENTATION}, cuda_tag=${TORCH_CUDA_TAG})"; \
    fi

# Re-pin torch stack from the same PyTorch index after installing generic deps.
# This avoids mixed CUDA runtime packages pulled by transitive dependencies.
RUN . /etc/app.env && \
    TORCH_VERSION="${TORCH_VERSION:-2.9.1}" && \
    TORCH_CUDA_TAG="${TORCH_CUDA_TAG:-cpu}" && \
    TORCHVISION_VERSION="0.24.1" && \
    if [ "$TORCH_CUDA_TAG" = "cpu" ] || [ "$TORCH_CUDA_TAG" = "None" ]; then \
      if [ "$TARGETARCH" = "arm64" ]; then \
        pip install --no-cache-dir --retries 10 --timeout 120 --force-reinstall \
          torch==${TORCH_VERSION} torchvision==${TORCHVISION_VERSION} ; \
      else \
        pip install --no-cache-dir --retries 10 --timeout 120 --force-reinstall \
          torch==${TORCH_VERSION} torchvision==${TORCHVISION_VERSION} \
          --index-url https://download.pytorch.org/whl/cpu ; \
      fi ; \
    else \
      pip install --no-cache-dir --retries 10 --timeout 120 --force-reinstall \
        torch==${TORCH_VERSION} torchvision==${TORCHVISION_VERSION} \
        --index-url https://download.pytorch.org/whl/${TORCH_CUDA_TAG} ; \
    fi

# Ensure NVRTC libraries are available for both CUDA12 and CUDA13 package layouts.
RUN . /etc/app.env && \
    TORCH_CUDA_TAG="${TORCH_CUDA_TAG:-cpu}" && \
    if [ "$TORCH_CUDA_TAG" != "cpu" ] && [ "$TORCH_CUDA_TAG" != "None" ]; then \
      case "$TORCH_CUDA_TAG" in \
        cu13*) \
          pip install --no-cache-dir --retries 10 --timeout 120 \
            nvidia-cuda-runtime \
            nvidia-cuda-nvrtc \
            nvidia-nvjitlink ;; \
        *) \
          pip install --no-cache-dir --retries 10 --timeout 120 \
            nvidia-cuda-runtime-cu12 \
            nvidia-cuda-nvrtc-cu12 \
            nvidia-nvjitlink-cu12 ;; \
      esac ; \
    fi

# Create compatibility symlink for runtime-builtins when package exposes x.y but runtime requests x.0.
RUN python - <<'PY'
import glob
import os

libdir = "/usr/local/lib/python3.10/site-packages/nvidia/cuda_nvrtc/lib"
if os.path.isdir(libdir):
    for major in ("12", "13"):
        expected = os.path.join(libdir, f"libnvrtc-builtins.so.{major}.0")
        if os.path.exists(expected):
            continue
        candidates = sorted(glob.glob(os.path.join(libdir, f"libnvrtc-builtins.so.{major}.*")))
        if not candidates:
            continue
        selected = os.path.basename(candidates[-1])
        try:
            os.symlink(selected, expected)
        except FileExistsError:
            pass
PY

COPY docker/models/start.sh /start.sh
RUN chmod +x /start.sh
ENV EMBEDDER_PORT=8000 \
    JUPYTER_PORT=8888
EXPOSE 8000 8001 8888
CMD ["/start.sh"]

# uvicorn backend.models.embedder.embedder:app --host 0.0.0.0 --port 8000 --log-level debug --reload
