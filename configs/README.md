# Configs

This directory contains runtime and dataset configuration used by AVSP backend services and preprocessors.

## What Lives Here

- `common.py`: shared runtime settings (service endpoints, DB/S3 credentials, dataset list)
- `hw_settings.py`: model runtime settings (device, backend, dtype, model names)
- `ENVIRONMENT.md`: centralized environment variable catalog (defaults, scope, and where to set)
- `waymo.py`, `argoverse.py`, `once.py`, `nuscenes.py`: dataset-specific defaults

## Important Logic

1. Endpoint and timeout resolution is centralized in `common.py`.
- Most backend clients read `STORAGE_SERVER_ENDPOINT`, `ANALYTICS_SERVER_ENDPOINT`, `EMBEDDER_ENDPOINT`, and `VLM_ENDPOINT` from here.
- `_env_first(primary, secondary, default)` supports both new and legacy env var names to keep older deployments working.

2. Storage/analytics aliases are intentionally duplicated in `common.py`.
- Aliases like `OBJECT_SERVER_ENDPOINT`, `VECTOR_SERVER_ENDPOINT`, and `ANALYTICS_SERVICE_ENDPOINT` point to the same unified storage service endpoint.
- This avoids breaking older imports while the platform uses one storage API surface.

3. Dataset defaults are declarative and lightweight.
- Dataset files define camera list, sampling interval, and canonical local data subdirectory.
- `DATASETS` in `common.py` is the active dataset list used by backend flows.

4. Model hardware behavior is controlled in `hw_settings.py`.
- `EMBEDDER_CONFIG` and `VLM_CONFIG` define default backend (`ALIGN`/`QWEN`, `SMOLVLM`/`QWEN`), device (`CPU`/`CUDA`/`MPS`), and dtype policy.
- `TORCH_CONFIG` holds PyTorch/CUDA compatibility knobs and Hugging Face cache/progress behavior.

## Practical Notes

- For containerized runs, prefer changing endpoint/credentials via environment variables in compose/helm, not by editing `common.py` defaults.
- For a full runtime env reference, use [`ENVIRONMENT.md`](ENVIRONMENT.md).
- Keep secrets out of git-managed config files.
- If you change model backends or dtype settings, validate both worker startup and inference endpoints after restart.
