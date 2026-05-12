#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

BACKEND="${BACKEND:-pgvector}"
SEED_COUNT="${SEED_COUNT:-4000}"
QUERY_COUNT="${QUERY_COUNT:-1200}"
VECTOR_SIZE="${VECTOR_SIZE:-640}"
TOPK="${TOPK:-10}"
CONCURRENCY="${CONCURRENCY:-8}"
TIMEOUT_SEC="${TIMEOUT_SEC:-30}"
REPORT_DIR="${REPORT_DIR:-$ROOT_DIR/storage/tests/.benchervs}"
NO_BUILD="${NO_BUILD:-0}"

case "$BACKEND" in
  pgvector)
    COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker/storage/docker-compose.pgvector.yml}"
    BENCH_ARGS=(
      -type pgvector
      -dsn "host=localhost port=5432 dbname=avsp user=postgres password=postgres sslmode=disable"
      -schema public
      -table image_embeddings
    )
    ;;
  qdrant)
    COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker/storage/docker-compose.qdrant.yml}"
    BENCH_ARGS=(
      -type qdrant
      -endpoint http://localhost:6333
      -collection image_embeddings
    )
    ;;
  ydb)
    COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker/storage/docker-compose.ydb.yml}"
    BENCH_ARGS=(
      -type ydb
      -dsn "grpc://localhost:2136/local"
      -schema avsp
      -table image_embeddings
    )
    ;;
  *)
    echo "Unsupported BACKEND=$BACKEND (supported: pgvector, qdrant, ydb)" >&2
    exit 1
    ;;
esac

mkdir -p "$REPORT_DIR"
JSON_REPORT="$REPORT_DIR/${BACKEND}-benchervs.json"
TEXT_REPORT="$REPORT_DIR/${BACKEND}-benchervs.txt"

cleanup() {
  docker compose -f "$COMPOSE_FILE" down >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting stack for backend=$BACKEND with compose=$COMPOSE_FILE"
compose_up_args=(compose -f "$COMPOSE_FILE" up -d)
if [[ "$NO_BUILD" != "1" ]]; then
  compose_up_args+=(--build)
fi
docker "${compose_up_args[@]}"

echo "Running benchervs..."
set -o pipefail
go run ./storage/cmd/benchervs \
  "${BENCH_ARGS[@]}" \
  -mode run \
  -seed-count "$SEED_COUNT" \
  -query-count "$QUERY_COUNT" \
  -vector-size "$VECTOR_SIZE" \
  -topk "$TOPK" \
  -concurrency "$CONCURRENCY" \
  -timeout-sec "$TIMEOUT_SEC" \
  -json \
  >"$JSON_REPORT"
set +o pipefail

{
  echo "benchervs backend: $BACKEND"
  echo "report: $JSON_REPORT"
  jq -r '
    "insert: ops=\(.insert.operations) errors=\(.insert.errors) throughput=\(.insert.throughput_ops_sec|tostring) avg_ms=\(.insert.avg_ms|tostring) p95_ms=\(.insert.p95_ms|tostring)",
    "query:  ops=\(.search.operations) errors=\(.search.errors) throughput=\(.search.throughput_ops_sec|tostring) avg_ms=\(.search.avg_ms|tostring) p95_ms=\(.search.p95_ms|tostring)"
  ' "$JSON_REPORT"
} | tee "$TEXT_REPORT"

echo "Done. Text summary: $TEXT_REPORT"
