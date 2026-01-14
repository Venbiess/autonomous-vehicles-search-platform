#!/bin/sh
set -e

ENV_FILE="/etc/app.env"
if [ -f "$ENV_FILE" ]; then
  . "$ENV_FILE"
  export TORCH_VERSION TORCH_CUDA_TAG HF_HOME EMBEDDER_PORT VLM_PORT
fi

uvicorn backend.models.embedder.embedder:app \
  --host 0.0.0.0 \
  --port "${EMBEDDER_PORT:-8000}" \
  --log-level debug \
  --reload &

if [ "${START_JUPYTER:-false}" = "true" ]; then
  exec jupyter lab \
    --ip=0.0.0.0 \
    --port "${JUPYTER_PORT:-8888}" \
    --no-browser \
    --allow-root \
    --ServerApp.token='' \
    --ServerApp.password='' \
    --ServerApp.allow_origin='*' \
    --ServerApp.allow_remote_access=True
else
  wait
fi
