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
SYNTHETIC_NUM_IMAGES="${SYNTHETIC_NUM_IMAGES:-12}"
SYNTHETIC_BATCH_SIZE="${SYNTHETIC_BATCH_SIZE:-6}"
SYNTHETIC_BUCKET="${SYNTHETIC_BUCKET:-synthetic}"
EMBEDDING_BACKFILL_LIMIT="${EMBEDDING_BACKFILL_LIMIT:-12}"
VLM_BACKFILL_LIMIT="${VLM_BACKFILL_LIMIT:-3}"
VLM_MAX_NEW_TOKENS="${VLM_MAX_NEW_TOKENS:-8}"

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

json_get() {
  local path="$1"
  local expr="$2"
  python3 - "$path" "$expr" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expr = sys.argv[2]
payload = json.loads(path.read_text(encoding="utf-8"))
value = eval(expr, {"__builtins__": {}}, {"payload": payload})
if isinstance(value, (dict, list)):
    print(json.dumps(value))
elif value is None:
    print("")
else:
    print(value)
PY
}

wait_job_status() {
  local job_id="$1"
  local expected_status="$2"
  local timeout_sec="${3:-300}"
  local started
  started="$(date +%s)"

  while true; do
    curl -fsS --max-time 20 "http://localhost:9002/jobs" >/tmp/jobs.json
    local current_status
    current_status="$(python3 - "$job_id" <<'PY'
import json
import sys
from pathlib import Path

job_id = sys.argv[1]
jobs = json.loads(Path("/tmp/jobs.json").read_text(encoding="utf-8")).get("jobs", [])
for job in jobs:
    if str(job.get("job_id")) == job_id:
        print(job.get("status", ""))
        raise SystemExit(0)
print("")
PY
)"
    if [[ "$current_status" == "$expected_status" ]]; then
      return 0
    fi
    if [[ "$current_status" == "error" || "$current_status" == "cancelled" ]]; then
      echo "Job ${job_id} ended with status ${current_status}" >&2
      python3 - "$job_id" <<'PY'
import json
import sys
from pathlib import Path

job_id = sys.argv[1]
jobs = json.loads(Path("/tmp/jobs.json").read_text(encoding="utf-8")).get("jobs", [])
for job in jobs:
    if str(job.get("job_id")) == job_id:
        print(json.dumps(job, indent=2))
        break
PY
      return 1
    fi
    local now
    now="$(date +%s)"
    if (( now - started > timeout_sec )); then
      echo "Job ${job_id} did not reach ${expected_status} in ${timeout_sec}s" >&2
      return 1
    fi
    sleep 2
  done
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
wait_http_ok "storage-ready" "http://localhost:9013/ready" "$SMOKE_TIMEOUT_SEC"
wait_http_ok "master-jobs" "http://localhost:9002/jobs" "$SMOKE_TIMEOUT_SEC"
wait_http_ok "master-health" "http://localhost:9002/health" "$SMOKE_TIMEOUT_SEC"

curl -fsS --max-time 20 "http://localhost:9002/health" >/tmp/master-health.json
assert_json /tmp/master-health.json

curl -fsS --max-time 20 "http://localhost:9002/system-info" >/tmp/system-info.json
assert_json /tmp/system-info.json

curl -fsS --max-time 20 "http://localhost:9002/jobs" >/tmp/jobs.json
assert_json /tmp/jobs.json

curl -fsS --max-time 30 \
  -H "Content-Type: application/json" \
  -d '{"query":"road","top_k":3,"max_rows":100}' \
  "http://localhost:9002/search/text" >/tmp/search-text.json
assert_json /tmp/search-text.json

curl -fsS --max-time 30 "http://localhost:9002/embeddings/dimensions" >/tmp/embeddings-dimensions.json
assert_json /tmp/embeddings-dimensions.json

echo "Generating synthetic dataset..."
compose exec -T master-server \
  python -m backend.processors.synthetic_preprocessor \
  --num-images "${SYNTHETIC_NUM_IMAGES}" \
  --batch-size "${SYNTHETIC_BATCH_SIZE}" \
  --bucket "${SYNTHETIC_BUCKET}"

curl -fsS --max-time 20 "http://localhost:9013/objects?limit=1000" >/tmp/objects.json
assert_json /tmp/objects.json
curl -fsS --max-time 20 "http://localhost:9013/vectors/count" >/tmp/vectors-count-before.json
assert_json /tmp/vectors-count-before.json

curl -fsS --max-time 20 \
  -H "Content-Type: application/json" \
  -d "{\"limit\":${EMBEDDING_BACKFILL_LIMIT},\"batch_size\":4,\"stop_on_error\":true,\"dry_run\":false}" \
  "http://localhost:9002/embeddings/backfill" >/tmp/embeddings-backfill.json
assert_json /tmp/embeddings-backfill.json
EMBED_JOB_ID="$(json_get /tmp/embeddings-backfill.json 'payload.get("job_id", "")')"
test -n "$EMBED_JOB_ID"
wait_job_status "$EMBED_JOB_ID" "success" "$SMOKE_TIMEOUT_SEC"

curl -fsS --max-time 20 "http://localhost:9013/vectors/count" >/tmp/vectors-count-after.json
assert_json /tmp/vectors-count-after.json

curl -fsS --max-time 30 \
  -H "Content-Type: application/json" \
  -d '{"query":"road cars lane","top_k":5,"max_rows":100}' \
  "http://localhost:9002/search/text" >/tmp/search-text-after.json
assert_json /tmp/search-text-after.json

python3 - <<'PY'
import base64
import json
from pathlib import Path
import urllib.request

objects = json.loads(Path("/tmp/objects.json").read_text(encoding="utf-8"))
items = objects.get("items", [])
assert items, objects
first_object_id = items[0]["object_id"]

payload = json.dumps({"object_ids": [first_object_id], "include_content": True}).encode("utf-8")
req = urllib.request.Request(
    "http://localhost:9013/objects/get-batch",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=30) as resp:
    body = json.loads(resp.read().decode("utf-8"))
content_b64 = body["items"][0]["content_base64"]
image_bytes = base64.b64decode(content_b64)
req = urllib.request.Request(
    "http://localhost:9002/search/image_bytes?top_k=3",
    data=image_bytes,
    headers={"Content-Type": "image/jpeg"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=30) as resp:
    search = json.loads(resp.read().decode("utf-8"))
Path("/tmp/search-image.json").write_text(json.dumps(search), encoding="utf-8")
PY
assert_json /tmp/search-image.json

curl -fsS --max-time 20 \
  -H "Content-Type: application/json" \
  -d '{"fields":[{"name":"road_present","prompt":"Is there a road in this driving scene?","response_type":"yes_no"}],"replace_missing":false,"purge_deleted_values":false}' \
  "http://localhost:9002/vlm/fields" >/tmp/vlm-fields-upsert.json
assert_json /tmp/vlm-fields-upsert.json

curl -fsS --max-time 20 \
  -H "Content-Type: application/json" \
  -d "{\"field_names\":[\"road_present\"],\"limit\":${VLM_BACKFILL_LIMIT},\"batch_size\":1,\"stop_on_error\":true,\"dry_run\":false,\"overwrite_existing\":true,\"max_new_tokens\":${VLM_MAX_NEW_TOKENS}}" \
  "http://localhost:9002/vlm/backfill" >/tmp/vlm-backfill.json
assert_json /tmp/vlm-backfill.json
VLM_JOB_ID="$(json_get /tmp/vlm-backfill.json 'payload.get("job_id", "")')"
test -n "$VLM_JOB_ID"
wait_job_status "$VLM_JOB_ID" "success" "$SMOKE_TIMEOUT_SEC"

curl -fsS --max-time 20 "http://localhost:9002/vlm/fields" >/tmp/vlm-fields.json
assert_json /tmp/vlm-fields.json

python3 - <<'PY'
import json
from pathlib import Path
import urllib.request

objects = json.loads(Path("/tmp/objects.json").read_text(encoding="utf-8"))
object_ids = [item["object_id"] for item in objects.get("items", [])[:5]]
payload = json.dumps({"object_ids": object_ids}).encode("utf-8")
req = urllib.request.Request(
    "http://localhost:9002/vlm/annotations/get",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=30) as resp:
    annotations = json.loads(resp.read().decode("utf-8"))
Path("/tmp/vlm-annotations.json").write_text(json.dumps(annotations), encoding="utf-8")
PY
assert_json /tmp/vlm-annotations.json

python3 - <<'PY'
import json
from pathlib import Path

system_info = json.loads(Path("/tmp/system-info.json").read_text(encoding="utf-8"))
master_health = json.loads(Path("/tmp/master-health.json").read_text(encoding="utf-8"))
jobs = json.loads(Path("/tmp/jobs.json").read_text(encoding="utf-8"))
search_before = json.loads(Path("/tmp/search-text.json").read_text(encoding="utf-8"))
embedding_dimensions = json.loads(Path("/tmp/embeddings-dimensions.json").read_text(encoding="utf-8"))
search_after = json.loads(Path("/tmp/search-text-after.json").read_text(encoding="utf-8"))
search_image = json.loads(Path("/tmp/search-image.json").read_text(encoding="utf-8"))
objects = json.loads(Path("/tmp/objects.json").read_text(encoding="utf-8"))
vectors_before = json.loads(Path("/tmp/vectors-count-before.json").read_text(encoding="utf-8"))
vectors_after = json.loads(Path("/tmp/vectors-count-after.json").read_text(encoding="utf-8"))
vlm_fields = json.loads(Path("/tmp/vlm-fields.json").read_text(encoding="utf-8"))
vlm_annotations = json.loads(Path("/tmp/vlm-annotations.json").read_text(encoding="utf-8"))

assert "services" in system_info, system_info
assert master_health.get("status") == "ok", master_health
models = master_health.get("models", {})
assert models.get("mode") == "rabbitmq", models
assert "jobs" in jobs and isinstance(jobs["jobs"], list), jobs
assert search_before.get("mode") == "vector_server", search_before
assert isinstance(search_before.get("results"), list), search_before
assert embedding_dimensions.get("status") == "ok", embedding_dimensions
assert int(embedding_dimensions.get("query_dim") or 0) > 0, embedding_dimensions
assert isinstance(objects.get("items"), list) and len(objects["items"]) >= 1, objects
assert int(vectors_before.get("count", 0)) >= 0, vectors_before
assert int(vectors_after.get("count", 0)) >= int(vectors_before.get("count", 0)) + 1, (vectors_before, vectors_after)
assert search_after.get("mode") == "vector_server", search_after
assert len(search_after.get("results", [])) >= 1, search_after
assert search_image.get("mode") == "vector_server", search_image
assert len(search_image.get("results", [])) >= 1, search_image
assert any(field.get("field_name") == "road_present" for field in vlm_fields.get("fields", [])), vlm_fields
assert len(vlm_annotations.get("rows", [])) >= 1, vlm_annotations
PY

echo "Full stack smoke checks passed"
