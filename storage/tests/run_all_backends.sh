#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$ROOT_DIR/storage/tests/tests.sh"

declare -a BACKENDS=(
  "pgvector|docker/storage/docker-compose.pgvector.yml|60|20"
  "qdrant|docker/storage/docker-compose.qdrant.yml|60|20"
  "milvus|docker/storage/docker-compose.milvus.yml|120|60"
  "ytsaurus|docker/storage/docker-compose.ytsaurus.yml|180|20"
  "seaweedfs|docker/storage/docker-compose.seaweedfs.yml|60|20"
)

BUILD=1
KEEP_VENV=0
PYTHON_BIN="${PYTHON_BIN:-python3}"

usage() {
  cat <<'EOF'
Usage: run_all_backends.sh [options]

Options:
  --no-build      Do not rebuild images before each backend run
  --keep-venv     Reuse existing test venv between backend runs
  -h, --help      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      BUILD=0
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

for item in "${BACKENDS[@]}"; do
  IFS='|' read -r name compose_file ready_retries request_timeout_sec <<<"$item"
  echo "============================================================"
  echo "Running storage integration tests for backend: $name"
  echo "Compose: $compose_file"
  echo "============================================================"

  cmd=(bash "$RUNNER" --down)
  if [[ "$BUILD" -eq 0 ]]; then
    cmd+=(--no-build)
  fi
  if [[ "$KEEP_VENV" -eq 1 ]]; then
    cmd+=(--keep-venv)
  fi

  STORAGE_TEST_COMPOSE_FILE="$ROOT_DIR/$compose_file" \
  STORAGE_READY_RETRIES="$ready_retries" \
  STORAGE_TEST_TIMEOUT_SEC="$request_timeout_sec" \
  PYTHON_BIN="$PYTHON_BIN" \
  "${cmd[@]}"
done

echo "All storage backends integration tests completed successfully."
