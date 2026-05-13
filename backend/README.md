# Backend

This directory contains AVSP application logic: API orchestration, model execution, dataset preprocessing, and service adapters.

## Directory Map

- `server/`: master API and orchestration layer (`FastAPI`)
- `models/`: embedder and VLM runtimes, worker entrypoint, backend factories
- `processors/`: dataset ingest/preprocessing pipelines
- `observability/`: worker metrics instrumentation
- `tests/`: backend integration/unit tests

## Core Runtime Flow

1. `master.py` is the control plane.
- Serves health/system endpoints, search endpoints, dataset install, VLM field/annotation APIs, and async job management.
- Uses `StorageAPI` and `AnalyticsAPI` clients for persistence/query operations.
- Uses `ModelGateway` for model inference calls.

2. `model_bus.py` bridges master and workers.
- Default execution mode is RabbitMQ RPC (`MODEL_EXECUTION_MODE=rabbitmq`).
- Supports embedder endpoint round-robin via `EMBEDDER_ENDPOINTS` for HTTP fallback/scale-out.
- Performs queue-level health probing to detect missing consumers.

3. `queue_worker.py` is the worker runtime.
- Runs embedder or VLM worker loops against RabbitMQ queues.
- `embedder` worker also hosts HTTP inference in the same process.
- Uses HTTP-priority polling to avoid starving direct HTTP requests when both modes are enabled.

4. `processors/runner.py` is the install/preprocess dispatcher.
- Maps preprocessor keys (`synthetic`, `waymo`, `argoverse`, `nuimages`, `once`, `bdd100k`, `drivingdojo`) to concrete processor classes.
- Normalizes config values, applies defaults, and emits progress payloads for long-running jobs.

## Important Operational Logic

- Job state is in-memory (`jobs_store`) with per-job logs persisted under `/tmp/avsp-job-logs`.
- Dataset visibility is controlled by `/app/storage/config/dataset_visibility.json` via `server/dataset_visibility.py`.
- Write operations to storage/analytics use `X-Storage-Write-Token` when configured.
- Service endpoints/timeouts are sourced from `configs/common.py` (with env-driven overrides).
- Runtime env reference is documented in `configs/ENVIRONMENT.md`.

## Embedder Backends

- Supported `EMBEDDER_BACKEND` values: `ALIGN`, `CLIP`, `BLIP`, `SIGLIP`, `QWEN`.
- Default model ids (when `EMBEDDER_MODEL_NAME` is not set):
  - `ALIGN`: `kakaobrain/align-base`
  - `CLIP`: `openai/clip-vit-base-patch32`
  - `BLIP`: `Salesforce/blip-itm-base-coco`
  - `SIGLIP`: `google/siglip-base-patch16-224`
  - `QWEN`: `Qwen/Qwen3-VL-Embedding-2B`
- For `SIGLIP`, text encoding uses fixed-length padding (`padding="max_length"`) to match model training setup.

## Entrypoints

- Master API:
```bash
uvicorn backend.server.master:app --host 0.0.0.0 --port 9002
```

- Workers:
```bash
python -m backend.models.queue_worker --worker embedder
python -m backend.models.queue_worker --worker vlm
```
