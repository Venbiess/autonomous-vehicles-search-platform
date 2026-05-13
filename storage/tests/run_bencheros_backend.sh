#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TARGET="${TARGET:-all}" # all|minio|pics
OBJECT_SIZE="${OBJECT_SIZE:-1MB}"
OPS="${OPS:-1000}"
CONCURRENCY="${CONCURRENCY:-8}"
REPORT_DIR="${REPORT_DIR:-$ROOT_DIR/storage/tests/.bencheros}"
NO_BUILD="${NO_BUILD:-0}"

mkdir -p "$REPORT_DIR"

run_bencher_object() {
  local -a args=("$@")
  if command -v go >/dev/null 2>&1; then
    (
      cd "$ROOT_DIR/storage"
      go run ./tools/bencher object "${args[@]}"
    )
    return 0
  fi

  local -a docker_args=()
  local item
  for item in "${args[@]}"; do
    docker_args+=("${item//localhost/host.docker.internal}")
  done

  docker run --rm \
    -v "$ROOT_DIR:/app" \
    -w /app/storage \
    golang:1.25 \
    sh -lc 'export PATH="/usr/local/go/bin:$PATH"; go run ./tools/bencher object "$@"' sh "${docker_args[@]}"
}

run_target() {
  local target="$1"
  local compose_file
  local bencher_target
  local bencher_url
  local bencher_upload_url=""

  case "$target" in
    minio)
      compose_file="${COMPOSE_FILE_MINIO:-$ROOT_DIR/docker/storage/docker-compose.pgvector.yml}"
      bencher_target="minio"
      bencher_url="http://localhost:9002"
      ;;
    pics)
      compose_file="${COMPOSE_FILE_PICS:-$ROOT_DIR/docker/storage/docker-compose.pics.yml}"
      bencher_target="storage"
      bencher_url="http://localhost:9004"
      bencher_upload_url="${BENCHER_PICS_UPLOAD_URL:-http://localhost:9005}"
      ;;
    *)
      echo "Unsupported TARGET=$target (supported: minio, pics)" >&2
      return 1
      ;;
  esac

  local text_report="$REPORT_DIR/${target}-bencheros.txt"
  local -a bencher_args=(
    -target "$bencher_target"
    -url "$bencher_url"
    -bucket avsp
    -size "$OBJECT_SIZE"
    -ops "$OPS"
    -concurrency "$CONCURRENCY"
  )
  if [[ -n "$bencher_upload_url" ]]; then
    bencher_args+=(-upload-url "$bencher_upload_url")
  fi

  echo "Starting stack for target=$target with compose=$compose_file"
  local -a compose_up_args=(compose -f "$compose_file" up -d)
  if [[ "$NO_BUILD" != "1" ]]; then
    compose_up_args+=(--build)
  fi
  docker "${compose_up_args[@]}"

  echo "Running bencherOS target=$target size=$OBJECT_SIZE ops=$OPS concurrency=$CONCURRENCY"
  {
    echo "bencherOS target: $target"
    echo "size: $OBJECT_SIZE"
    echo "ops: $OPS"
    echo "concurrency: $CONCURRENCY"
    if [[ -n "$bencher_upload_url" ]]; then
      echo "upload_url: $bencher_upload_url"
    fi
    run_bencher_object "${bencher_args[@]}"
  } | tee "$text_report"

  echo "Done for $target. Text summary: $text_report"
  docker compose -f "$compose_file" down >/dev/null 2>&1 || true
}

if [[ "$TARGET" == "all" ]]; then
  run_target minio
  run_target pics
else
  run_target "$TARGET"
fi
