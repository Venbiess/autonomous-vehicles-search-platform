#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BACKEND="${BACKEND:-all}"
SEED_COUNT="${SEED_COUNT:-4000}"
QUERY_COUNT="${QUERY_COUNT:-1200}"
VECTOR_SIZE="${VECTOR_SIZE:-640}"
TOPK="${TOPK:-10}"
CONCURRENCY="${CONCURRENCY:-8}"
TIMEOUT_SEC="${TIMEOUT_SEC:-30}"
REPORT_DIR="${REPORT_DIR:-$ROOT_DIR/storage/tests/.benchervs}"
NO_BUILD="${NO_BUILD:-0}"

mkdir -p "$REPORT_DIR"

run_benchervs() {
  local -a args=("$@")
  if command -v go >/dev/null 2>&1; then
    (
      cd "$ROOT_DIR/storage"
      go run ./tools/bencher vector "${args[@]}"
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
    sh -lc 'export PATH="/usr/local/go/bin:$PATH"; go run ./tools/bencher vector "$@"' sh "${docker_args[@]}"
}

run_single_backend() {
  local backend="$1"
  local compose_file
  local -a bench_args

  case "$backend" in
    pgvector)
      compose_file="${COMPOSE_FILE:-$ROOT_DIR/docker/storage/docker-compose.pgvector.yml}"
      bench_args=(
        -type pgvector
        -dsn "host=localhost port=5432 dbname=avsp user=postgres password=postgres sslmode=disable"
        -schema public
        -table image_embeddings
      )
      ;;
    qdrant)
      compose_file="${COMPOSE_FILE:-$ROOT_DIR/docker/storage/docker-compose.qdrant.yml}"
      bench_args=(
        -type qdrant
        -endpoint http://localhost:6333
        -collection image_embeddings
      )
      ;;
    milvus)
      compose_file="${COMPOSE_FILE:-$ROOT_DIR/docker/storage/docker-compose.milvus.yml}"
      bench_args=(
        -type milvus
        -endpoint http://localhost:19530
        -schema default
        -collection image_embeddings
      )
      ;;
    *)
      echo "Unsupported backend=$backend (supported: pgvector, qdrant, milvus)" >&2
      return 1
      ;;
  esac

  local json_report="$REPORT_DIR/${backend}-benchervs.json"
  local text_report="$REPORT_DIR/${backend}-benchervs.txt"

  echo "Starting stack for backend=$backend with compose=$compose_file"
  compose_up_args=(compose -f "$compose_file" up -d)
  if [[ "$NO_BUILD" != "1" ]]; then
    compose_up_args+=(--build)
  fi
  docker "${compose_up_args[@]}"

  echo "Running benchervs for backend=$backend..."
  set -o pipefail
  run_benchervs \
    "${bench_args[@]}" \
    -mode run \
    -seed-count "$SEED_COUNT" \
    -query-count "$QUERY_COUNT" \
    -vector-size "$VECTOR_SIZE" \
    -topk "$TOPK" \
    -concurrency "$CONCURRENCY" \
    -timeout-sec "$TIMEOUT_SEC" \
    -json \
    >"$json_report"
  set +o pipefail

  {
    echo "benchervs backend: $backend"
    echo "report: $json_report"
    jq -r '
      "insert: ops=\(.insert.operations) errors=\(.insert.errors) throughput=\(.insert.throughput_ops_sec|tostring) avg_ms=\(.insert.avg_ms|tostring) p95_ms=\(.insert.p95_ms|tostring)",
      "query:  ops=\(.search.operations) errors=\(.search.errors) throughput=\(.search.throughput_ops_sec|tostring) avg_ms=\(.search.avg_ms|tostring) p95_ms=\(.search.p95_ms|tostring)"
    ' "$json_report"
  } | tee "$text_report"

  echo "Done for $backend. Text summary: $text_report"
  docker compose -f "$compose_file" down >/dev/null 2>&1 || true
}

if [[ "$BACKEND" == "all" ]]; then
  for backend in pgvector qdrant milvus; do
    run_single_backend "$backend"
  done
else
  run_single_backend "$BACKEND"
fi
