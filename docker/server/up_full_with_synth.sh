#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "docker-compose is required (docker compose is not used in this script)"
  exit 1
fi

build_services=(
  storage-server
  analytics-server
  avsp-server
)

runtime_services=(
  clickhouse
  postgres
  minio
  minio-init
  embedder
  vlm
  analytics-server
  storage-server
  avsp-server
  frontend
)

wait_http() {
  local name="$1"
  local url="$2"
  local timeout_sec="${3:-180}"
  local started
  started="$(date +%s)"

  echo "Waiting for ${name} at ${url} ..."
  until curl -fsS --max-time 5 "${url}" >/dev/null; do
    sleep 2
    local now
    now="$(date +%s)"
    if (( now - started > timeout_sec )); then
      echo "${name} did not become ready in ${timeout_sec}s"
      return 1
    fi
  done
  echo "${name} is ready"
}

echo "Building selected services (without models): ${build_services[*]}"
"${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" build "${build_services[@]}"

echo "Starting full stack"
"${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" up -d "${runtime_services[@]}"

# Frontend code is bind-mounted; no forced recreate to avoid reinstalling deps each run.
echo "Ensuring frontend container is running"
"${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" up -d frontend

wait_http "storage-server" "http://localhost:9013/health" "${STORAGE_READY_TIMEOUT_SEC:-240}"
wait_http "master-server" "http://localhost:9002/health" "${MASTER_READY_TIMEOUT_SEC:-240}"

SYNTHETIC_NUM_IMAGES="${SYNTHETIC_NUM_IMAGES:-64}"
SYNTHETIC_BATCH_SIZE="${SYNTHETIC_BATCH_SIZE:-16}"
SYNTHETIC_BUCKET="${SYNTHETIC_BUCKET:-synthetic}"
SYNTHETIC_KEEP_LOCAL_IMAGES="${SYNTHETIC_KEEP_LOCAL_IMAGES:-0}"

preprocess_cmd=(
  python -m backend.processors.synthetic_preprocessor
  --num-images "${SYNTHETIC_NUM_IMAGES}"
  --batch-size "${SYNTHETIC_BATCH_SIZE}"
  --bucket "${SYNTHETIC_BUCKET}"
)
if [[ "${SYNTHETIC_KEEP_LOCAL_IMAGES}" == "1" ]]; then
  preprocess_cmd+=(--keep-local-images)
fi

echo "Running synthetic preprocessor: ${preprocess_cmd[*]}"
"${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" exec -T avsp-server "${preprocess_cmd[@]}"

echo "Done"
echo "Frontend: http://localhost:3003"
echo "Master:   http://localhost:9002/health"
echo "Storage:  http://localhost:9013/health"
