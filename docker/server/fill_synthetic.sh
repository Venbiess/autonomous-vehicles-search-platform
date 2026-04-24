#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "docker compose or docker-compose is required"
  exit 1
fi

SYNTHETIC_NUM_IMAGES="${SYNTHETIC_NUM_IMAGES:-64}"
SYNTHETIC_BATCH_SIZE="${SYNTHETIC_BATCH_SIZE:-16}"
SYNTHETIC_BUCKET="${SYNTHETIC_BUCKET:-synthetic}"
SYNTHETIC_KEEP_LOCAL_IMAGES="${SYNTHETIC_KEEP_LOCAL_IMAGES:-0}"
MASTER_READY_TIMEOUT_SEC="${MASTER_READY_TIMEOUT_SEC:-180}"

compose() {
  "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" "$@"
}

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

wait_http "master-server" "http://localhost:9002/health" "${MASTER_READY_TIMEOUT_SEC}"

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
compose exec -T avsp-server "${preprocess_cmd[@]}"
