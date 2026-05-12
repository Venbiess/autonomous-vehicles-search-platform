# AVSP Build and Run (Docker)

This guide covers local Docker-based setup for the full AVSP stack.

## Prerequisites

- Docker Engine + Docker Compose plugin (`docker compose`)
- 12+ GB RAM recommended for smooth model + UI + datastore execution
- Optional for GPU mode: NVIDIA drivers + NVIDIA Container Toolkit

## Linux setup (Ubuntu/Debian)

If Docker is not installed yet:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run hello-world
```

Optional: run Docker without `sudo`:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

## Run Full Stack (CPU)

From repository root:

```bash
docker compose -f docker/docker-compose.yml up --build
```

Env file setup when running from repository root:
- Keep env in `docker/.env` (template: [`.env.example`](.env.example)) and run with:

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml up --build
```

## NVIDIA/CUDA runtime for Docker (GPU mode)

Install GPU drivers and NVIDIA Container Toolkit:

```bash
sudo apt update
sudo apt install -y ubuntu-drivers-common
sudo ubuntu-drivers autoinstall
# reboot, then:
nvidia-smi

curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit.gpg
echo "deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit.gpg] \
https://nvidia.github.io/libnvidia-container/stable/deb/amd64 /" | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Validation:

```bash
docker run --rm --gpus all nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi
```

## GPU mode

Run with the GPU override file:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.gpu.yml up --build
```

Quick runtime check:

```bash
docker exec -it avsp-embedder-worker-$USER python -c "import torch; print(f'{torch.__version__=};\\n{torch.version.cuda=};\\n{torch.cuda.is_available()=};\\n{torch.cuda.device_count()=}')"
```

To build with flash_attention_2
```
EMBEDDER_ATTN_IMPLEMENTATION=flash_attention_2 \
docker compose -f docker/docker-compose.yml -f docker/docker-compose.gpu.yml up --build
```

## macOS (Colima)

If you use Colima, start it with enough resources:

```bash
colima start --memory 12 --cpu 4 --disk 100
```
```bash
docker compose -f docker/docker-compose.yml up --build
```

## Frontend fixes without image rebuild

Frontend service in `docker/docker-compose.yml` is bind-mounted.
Image rebuild is not required for frontend code changes.

Use:

```bash
docker compose -f docker/docker-compose.yml restart frontend
```

What restart does for frontend:
- re-runs startup command (`npm run dev` if `AVSP_DEV_RELOAD=1`, otherwise `npm run build` + `npm run start`)
- reuses `node_modules` volume unless `package-lock.json` changed

## Dev reload mode (master + analytics routes + frontend)

You can enable a compose dev mode with hot reload for:
- `master-server` (FastAPI/uvicorn `--reload`)
- `frontend` (Next.js `npm run dev`, includes `pages/api/*` analytics/storage routes)

Models/workers are unchanged (no reload for embedder/vlm workers).

Set flag in env:

```bash
AVSP_DEV_RELOAD=1
```

If you run from repository root:
- set it in `docker/.env`
- and run with `--env-file docker/.env`

Then start as usual:

```bash
docker compose -f docker/docker-compose.yml up --build
```

If you changed `.env` values and need containers to pick new env (without rebuild):

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml up -d --force-recreate master-server frontend
```

Default is off:

```bash
AVSP_DEV_RELOAD=0
```

## Optional: HTTP model services profile

By default, AVSP uses RabbitMQ workers for model execution.
You can also run standalone HTTP model services:

```bash
docker compose -f docker/docker-compose.yml --profile model-http up
```

## Scale workers

```bash
docker compose -f docker/docker-compose.yml up \
  --scale embedder-worker=2 \
  --scale vlm-worker=2
```

## Storage-only compose profiles

See dedicated guide: [storage/README.md](storage/README.md).

## Helper scripts

- Start stack and auto-run synthetic preprocessing:

```bash
./docker/server/up_full_with_synth.sh
```

- Rebuild selected services and start full stack without rebuilding model images:

```bash
./docker/server/up_full_no_model_rebuild.sh
```

## Waymo auth inside master container

```bash
docker exec -it avsp-master-$USER bash
gcloud auth application-default login
```

## Run preprocessors from host (inside `master-server` container)

```bash
docker exec -it avsp-master-$USER python -m backend.processors.argoverse_preprocessor
docker exec -it avsp-master-$USER python -m backend.processors.waymo_preprocessor
docker exec -it avsp-master-$USER python -m backend.processors.nuimages_preprocessor
docker exec -it avsp-master-$USER python -m backend.processors.once_preprocessor --extract --cameras FRONT --step-sec 1.0
docker exec -it avsp-master-$USER python -m backend.processors.synthetic_preprocessor --num-images 32 --batch-size 8 --bucket synthetic --save-to-db
```

## Optional: OpenAI VLM backend

To run VLM via OpenAI API instead of local HF models, set these variables in `docker/.env`:

```bash
VLM_BACKEND=OPENAI
VLM_MODEL_NAME=gpt-5.4-mini
OPENAI_API_KEY=your_api_key
# Optional overrides:
# VLM_OPENAI_IMAGE_DETAIL=low
# VLM_OPENAI_TIMEOUT_SEC=120
# VLM_OPENAI_BATCH_SCENE_CHUNK_SIZE=32
```

Then start as usual:

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml up --build
```

To run a VLM backfill in one JSON prompt per image and process requests via OpenAI Batch API:

```bash
curl -s http://localhost:9012/vlm/backfill \
  -H "Content-Type: application/json" \
  -d '{
    "limit": 1000,
    "batch_size": 16,
    "combine_fields_into_json": true,
    "use_openai_batch_api": true
  }'
```

Check OpenAI batch status:

```bash
curl -s http://localhost:9012/vlm/openai/batch/status \
  -H "Content-Type: application/json" \
  -d '{"batch_id":"batch_..."}'
```

## Model image development workflow

```bash
cd docker/models
./build_docker.sh
./run_docker.sh
```

With Jupyter inside the model container:

```bash
./run_docker.sh --jupyter
```
