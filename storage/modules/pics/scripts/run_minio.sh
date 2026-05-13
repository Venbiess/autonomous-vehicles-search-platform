#!/usr/bin/env bash
set -euo pipefail

NAME="${MINIO_CONTAINER_NAME:-minio}"
DATA_VOLUME="${MINIO_DATA_VOLUME:-minio_data}"
API_PORT="${MINIO_API_PORT:-9005}"
CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9006}"
ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
IMAGE="${MINIO_IMAGE:-quay.io/minio/minio:latest}"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume create "$DATA_VOLUME" >/dev/null

docker run -d \
  --name "$NAME" \
  -p "${API_PORT}:9000" \
  -p "${CONSOLE_PORT}:9001" \
  -e "MINIO_ROOT_USER=${ROOT_USER}" \
  -e "MINIO_ROOT_PASSWORD=${ROOT_PASSWORD}" \
  -v "${DATA_VOLUME}:/data" \
  "$IMAGE" \
  server /data --console-address ":9001"

echo "started"
