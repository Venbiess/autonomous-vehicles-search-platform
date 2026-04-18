#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker/storage/docker-compose.yml"
TEST_DIR="$ROOT_DIR/storage/tests"
VENV_DIR="$TEST_DIR/.venv"

BUILD=1
DOWN_AFTER=0
KEEP_VENV=0
PYTHON_BIN="${PYTHON_BIN:-python3}"

usage() {
  cat <<'EOF'
Usage: run_storage_integration.sh [options]

Options:
  --no-build      Do not rebuild images on docker compose up
  --down          Stop compose stack after tests
  --keep-venv     Reuse existing venv and skip recreation
  -h, --help      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      BUILD=0
      shift
      ;;
    --down)
      DOWN_AFTER=1
      shift
      ;;
    --keep-venv)
      KEEP_VENV=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "$PYTHON_BIN is required" >&2
  exit 1
fi

compose_up() {
  local args=(compose -f "$COMPOSE_FILE" up -d)
  if [[ "$BUILD" -eq 1 ]]; then
    args+=(--build)
  fi
  docker "${args[@]}"
}

wait_storage_ready() {
  local base_url="${STORAGE_BASE_URL:-http://localhost:9012}"
  local timeout_sec="${STORAGE_TEST_TIMEOUT_SEC:-20}"
  local retries="${STORAGE_READY_RETRIES:-10}"

  echo "Waiting for storage health at ${base_url}/health ..."
  for ((i=1; i<=retries; i++)); do
    if curl -fsS --max-time "$timeout_sec" "${base_url}/health" >/dev/null; then
      echo "Storage is ready"
      return 0
    fi
    if (( i % 10 == 0 )); then
      echo "Still waiting... (${i}/${retries})"
    fi
    sleep 1
  done
  echo "Storage did not become ready in time" >&2
  echo "----- docker compose ps -----" >&2
  docker compose -f "$COMPOSE_FILE" ps >&2 || true
  echo "----- storage-server logs (tail 200) -----" >&2
  docker compose -f "$COMPOSE_FILE" logs --tail 200 storage-server >&2 || true
  echo "----- postgres logs (tail 120) -----" >&2
  docker compose -f "$COMPOSE_FILE" logs --tail 120 postgres >&2 || true
  echo "----- minio logs (tail 120) -----" >&2
  docker compose -f "$COMPOSE_FILE" logs --tail 120 minio >&2 || true
  return 1
}

prepare_venv() {
  if [[ "$KEEP_VENV" -eq 0 ]]; then
    rm -rf "$VENV_DIR"
  fi
  if [[ ! -d "$VENV_DIR" ]]; then
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  fi
  source "$VENV_DIR/bin/activate"
  python -m pip install --upgrade pip
  pip install -r "$TEST_DIR/requirements.txt"
}

run_tests() {
  source "$VENV_DIR/bin/activate"
  pytest -q "$TEST_DIR"
}

cleanup() {
  if [[ "$KEEP_VENV" -eq 0 && -d "$VENV_DIR" ]]; then
    rm -rf "$VENV_DIR"
  fi
  if [[ "$DOWN_AFTER" -eq 1 ]]; then
    docker compose -f "$COMPOSE_FILE" down
  fi
}

trap cleanup EXIT

echo "Starting storage stack..."
compose_up
wait_storage_ready

echo "Preparing Python test environment..."
prepare_venv

echo "Running storage integration tests..."
run_tests

echo "Storage integration pipeline completed"
