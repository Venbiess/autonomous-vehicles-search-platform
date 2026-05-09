#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/../docker-compose.yml"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Docker Compose is required"
  exit 1
fi

build_services=(
  storage-server
  master-server
)

runtime_services=(
  prometheus
  grafana
  cadvisor
  rabbitmq
  clickhouse
  postgres
  minio
  minio-init
  embedder-worker
  vlm-worker
  storage-server
  master-server
  frontend
)

echo "Rebuilding services except model images/workers: ${build_services[*]}"
"${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" build "${build_services[@]}"

echo "Starting full stack in foreground without rebuilding model workers"
exec "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" up --no-build "${runtime_services[@]}"
