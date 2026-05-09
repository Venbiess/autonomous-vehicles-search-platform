#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker/docker-compose.yml"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "docker compose or docker-compose is required" >&2
  exit 1
fi

SMOKE_TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-600}"

compose() {
  "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  compose logs --tail=120 master-server embedder-worker vlm-worker storage-server rabbitmq || true
  compose down -v --remove-orphans || true
}

trap cleanup EXIT

wait_http_ok() {
  local name="$1"
  local url="$2"
  local timeout_sec="${3:-300}"
  local started
  started="$(date +%s)"

  echo "Waiting for ${name} at ${url} ..."
  until curl -fsS --max-time 10 "$url" >/tmp/ci-smoke-response.txt; do
    sleep 2
    local now
    now="$(date +%s)"
    if (( now - started > timeout_sec )); then
      echo "${name} did not become ready in ${timeout_sec}s" >&2
      return 1
    fi
  done
  echo "${name} is ready"
}

assert_json() {
  local path="$1"
  python3 - "$path" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
assert isinstance(payload, dict), payload
PY
}

echo "Starting AVSP smoke stack..."
compose up -d --build \
  rabbitmq \
  clickhouse \
  postgres \
  minio \
  minio-init \
  storage-server \
  embedder-worker \
  vlm-worker \
  master-server

wait_http_ok "storage-server" "http://localhost:9013/health" "$SMOKE_TIMEOUT_SEC"
wait_http_ok "master-jobs" "http://localhost:9002/jobs" "$SMOKE_TIMEOUT_SEC"
wait_http_ok "master-health" "http://localhost:9002/health" "$SMOKE_TIMEOUT_SEC"

curl -fsS --max-time 20 "http://localhost:9002/system-info" >/tmp/system-info.json
assert_json /tmp/system-info.json

curl -fsS --max-time 20 "http://localhost:9002/jobs" >/tmp/jobs.json
assert_json /tmp/jobs.json

curl -fsS --max-time 30 \
  -H "Content-Type: application/json" \
  -d '{"query":"road","top_k":3,"max_rows":100}' \
  "http://localhost:9002/search/text" >/tmp/search-text.json
assert_json /tmp/search-text.json

python3 - <<'PY'
import json
from pathlib import Path

system_info = json.loads(Path("/tmp/system-info.json").read_text(encoding="utf-8"))
jobs = json.loads(Path("/tmp/jobs.json").read_text(encoding="utf-8"))
search = json.loads(Path("/tmp/search-text.json").read_text(encoding="utf-8"))

assert "services" in system_info, system_info
assert "jobs" in jobs and isinstance(jobs["jobs"], list), jobs
assert search.get("mode") == "vector_server", search
assert isinstance(search.get("results"), list), search
PY

echo "Full stack smoke checks passed"
