# autonomous-vehicles-search-platform

## Configs

Storage servers use one YAML config:
- `backend/storage/config/storage.yaml`
- override path via `STORAGE_CONFIG_PATH`

## Build

### Server

```
cd docker/server/
docker compose -f ./docker-compose.yml up
```

### Storage only

Run only storage infrastructure and servers (`object`, `vector`, `analytics`):

```bash
cd docker/storage/
docker compose -f ./docker-compose.yml up
```

This stack includes:
- `object-server` (Go object API + Pebble metadata)
- `vector-server` (Go vector API with pgvector adapter)
- `analytics-server` (Go VLM analytics API backed by ClickHouse)
- infra: `postgres` (pgvector), `clickhouse`, and local `minio` as default S3-compatible backend

Go storage servers are structured as:
- `backend/storage/cmd/{objectserver,vectorserver,analyticsserver}`
- `backend/storage/transport/http`
- `backend/storage/server`
- `backend/storage/infra`
- `backend/storage/config`
- `backend/storage/observability`
- `backend/storage/platform/httpx`

Old:
```
cd docker/server/
source ./build_docker.sh
source ./run_docker.sh
```

For Waymo:
```
docker exec -it avsp-server-$USER bash
gcloud auth application-default login
gcloud auth login
```

Run package inside docker container:
```
python -m backend.processors.argoverse_preprocessor

python -m backend.processors.waymo_preprocessor
```

### Models
```
cd docker/models/
source ./build_docker.sh
source ./run_docker.sh
```
 
 ### Frontend

 ```
 cd frontend/
 npm install
 npm run dev
 ```
