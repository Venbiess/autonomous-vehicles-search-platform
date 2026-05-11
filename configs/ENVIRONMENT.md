# Environment Variables Catalog

This file is the single reference for runtime environment variables used by AVSP services.

## How to Apply

- Docker Compose: set values in `docker/.env` (based on `docker/.env.example`) or inline in `docker/docker-compose.yml`.
- Kubernetes/Helm: set values via chart values/secrets/configmaps.
- Local process run: export vars before running `uvicorn`/workers.

## Master Server (`backend.server.master`)

| Variable | Default | Purpose |
|---|---:|---|
| `STORAGE_SERVER_ENDPOINT` | `http://storage-server:9012` | Unified storage API endpoint. |
| `STORAGE_SERVER_TIMEOUT_SEC` | `30` | Storage HTTP timeout. |
| `ANALYTICS_SERVER_ENDPOINT` | `http://storage-server:9012` | Analytics API endpoint for VLM fields/annotations. |
| `ANALYTICS_SERVER_TIMEOUT_SEC` | `30` | Analytics HTTP timeout. |
| `STORAGE_WRITE_TOKEN` | `change-me-storage-write-token` | Write token for storage/analytics mutations. |
| `EMBEDDER_ENDPOINT` | `http://embedder-worker:8000` | Embedder HTTP fallback endpoint. |
| `EMBEDDER_TIMEOUT_SEC` | `30` | Embedder HTTP timeout. |
| `VLM_ENDPOINT` | `http://vlm-worker:8001` | VLM HTTP fallback endpoint. |
| `VLM_TIMEOUT_SEC` | `120` | VLM request timeout for backfill/annotation requests. |
| `MODEL_EXECUTION_MODE` | `rabbitmq` | Model execution path (`rabbitmq`/`http`). |
| `RABBITMQ_URL` | `amqp://guest:guest@rabbitmq:5672/%2f` | RabbitMQ connection URL. |
| `RABBITMQ_EMBEDDER_QUEUE` | `avsp.embedder.tasks` | Embedder RPC queue. |
| `RABBITMQ_VLM_QUEUE` | `avsp.vlm.tasks` | VLM RPC queue. |
| `RABBITMQ_RPC_TIMEOUT_SEC` | `120` | RPC call timeout in `ModelGateway`. |
| `MODEL_BACKEND_READY_WAIT_SEC` | `45` | Total wait before model-dependent operations fail readiness check. |
| `MODEL_BACKEND_READY_POLL_SEC` | `1` | Poll interval for model readiness checks. |
| `VLM_RETRY_EMPTY_VALUES` | `1` | Retry once when VLM returns empty normalized value. |
| `VLM_BACKFILL_FIELD_CHUNK_SIZE` | `0` | VLM per-scene field chunk size in batch mode. `0` means use backfill `batch_size`. |

## VLM Worker (`backend.models.queue_worker --worker vlm`)

| Variable | Default | Purpose |
|---|---:|---|
| `VLM_PORT` | `8001` | VLM worker HTTP port (when HTTP is enabled). |
| `WORKER_HTTP_ENABLED` | `1` | Enable worker HTTP server alongside RabbitMQ worker. |
| `WORKER_METRICS_PORT` | `9109` | Prometheus metrics port for worker. |
| `VLM_BACKEND` | from `configs.hw_settings` (`SMOLVLM`) | VLM backend selection (`SMOLVLM`, `QWEN`). |
| `VLM_MODEL_NAME` | backend default | HF model id override. |
| `VLM_TORCH_DTYPE` | backend/runtime default | Runtime dtype policy (`auto`, `fp16`, `bf16`, etc.). |
| `VLM_ATTN_IMPLEMENTATION` | backend/runtime default | Attention implementation override. |
| `VLM_DEBUG_EMPTY_OUTPUT` | `0` | Enable detailed empty-generation logs (`token ids`, decode with/without special tokens). |
| `VLM_HF_DOWNLOAD_PROGRESS` / `HF_DOWNLOAD_PROGRESS` | `1` | HF download progress visibility. |
| `HF_HOME` | `/app/.cache/huggingface` | HF cache directory. |

## Embedder Worker (`backend.models.queue_worker --worker embedder`)

| Variable | Default | Purpose |
|---|---:|---|
| `EMBEDDER_PORT` | `8000` | Embedder worker HTTP port (when HTTP is enabled). |
| `WORKER_HTTP_ENABLED` | `1` | Enable worker HTTP server alongside RabbitMQ worker. |
| `WORKER_METRICS_PORT` | `9108` | Prometheus metrics port for worker. |
| `EMBEDDER_BACKEND` | from `configs.hw_settings` (`ALIGN`) | Embedder backend selection (`ALIGN`, `QWEN`). |
| `EMBEDDER_MODEL_NAME` | backend default | HF model id override. |
| `EMBEDDER_TORCH_DTYPE` | backend/runtime default | Runtime dtype policy override. |
| `EMBEDDER_ATTN_IMPLEMENTATION` | backend/runtime default | Attention implementation override. |
| `HF_HOME` | `/app/.cache/huggingface` | HF cache directory. |

## Worker / RabbitMQ Shared

| Variable | Default | Purpose |
|---|---:|---|
| `RABBITMQ_URL` | `amqp://guest:guest@rabbitmq:5672/%2f` | RabbitMQ connection URL. |
| `RABBITMQ_EMBEDDER_QUEUE` | `avsp.embedder.tasks` | Embedder queue name. |
| `RABBITMQ_VLM_QUEUE` | `avsp.vlm.tasks` | VLM queue name. |
| `RABBITMQ_PREFETCH` | `1` | Consumer prefetch count. |
| `RABBITMQ_HEARTBEAT_SEC` | `900` | Heartbeat interval. |
| `RABBITMQ_BLOCKED_CONNECTION_TIMEOUT_SEC` | `max(300, heartbeat+60)` | Blocked connection timeout. |
| `RABBITMQ_CONNECT_RETRY_DELAY_SEC` | `3` | Retry delay when connecting worker to RabbitMQ. |
| `RABBITMQ_CONNECT_MAX_ATTEMPTS` | `0` | Max retries (`0` = infinite). |
| `RABBITMQ_POLL_INTERVAL_SEC` | `0.1` | Worker polling interval. |
| `WORKER_HTTP_PRIORITY_GRACE_SEC` | `0.5` | Grace window to prioritize HTTP requests. |

## Frontend Server (`frontend` Next.js container)

| Variable | Default | Purpose |
|---|---:|---|
| `MASTER_ENDPOINT` | `http://localhost:9002` (or compose service URL) | Proxy target for master API routes. |
| `MASTER_PROXY_TIMEOUT_MS` | `10000` | Timeout for frontend->master proxy endpoints. |
| `STORAGE_SERVER_ENDPOINT` | `http://localhost:9013` | Storage endpoint for frontend API helpers. |
| `ANALYTICS_SERVER_ENDPOINT` / `ANALYTICS_ENDPOINT` | `STORAGE_SERVER_ENDPOINT` fallback | Analytics endpoint for storage stats/VLM reads. |
| `STORAGE_WRITE_TOKEN` | empty | Write token forwarded by frontend storage API routes. |
| `MINIO_PUBLIC_ENDPOINT` | `http://localhost:9000` | Public MinIO URL used in search result links. |
| `MINIO_BUCKET` | `avsp` | Default bucket for generated public URLs. |
| `FRONTEND_REQUEST_TIMEOUT_MS` | `0` | Node server request timeout (`0` means disabled). |
| `STORAGE_TRANSFER_IMPORT_MAX_BYTES` | `17179869184` | Snapshot import max payload size. |
| `STORAGE_STATS_TIMEOUT_MS` | `6000` | Storage stats API timeout for storage server calls. |
| `STORAGE_ANALYTICS_TIMEOUT_MS` | `4000` | Storage stats API timeout for analytics calls. |
| `STORAGE_MASTER_TIMEOUT_MS` | `4000` | Storage stats API timeout for master calls. |
| `STORAGE_STATS_CACHE_TTL_MS` | `30000` | Cache TTL for full storage stats. |
| `STORAGE_STATS_LITE_CACHE_TTL_MS` | `5000` | Cache TTL for lite stats. |
| `STORAGE_STATS_LIST_PAGE_LIMIT` | `1000` | Page size for full storage object scans in stats API. |

## Notes

- `VLM_RETRY_EMPTY_VALUES`, `VLM_BACKFILL_FIELD_CHUNK_SIZE` are consumed by **master-server** only.
- `VLM_DEBUG_EMPTY_OUTPUT` is consumed by **VLM model runtime** (worker and model-http profile).
- If you set variables in `docker/.env`, restart relevant containers after changes.
