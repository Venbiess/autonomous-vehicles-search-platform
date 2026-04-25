# autonomous-vehicles-search-platform

## Configs

## Build

### Server

colima start --memory 8 --cpu 4 --disk 100

```
cd docker/
docker compose -f ./docker-compose.yml up
```

```bash
# optional: run standalone HTTP model services (embedder/vlm) in addition to RabbitMQ workers
docker compose -f ./docker-compose.yml --profile model-http up
```

```bash
# scale queue workers
docker compose -f docker/docker-compose.yml up -d --scale embedder-worker=2 --scale vlm-worker=2
```

### Storage-only profiles
```bash
# pgvector (default)
docker-compose -f docker/storage/docker-compose.yml up -d --build

# qdrant
docker-compose -f docker/storage/docker-compose.qdrant.yml up -d --build
```

For Waymo:
```
docker exec -it avsp-server-$USER bash
gcloud auth application-default login
```

Run package inside docker container:
```
python -m backend.processors.argoverse_preprocessor

python -m backend.processors.waymo_preprocessor

python -m backend.processors.nuimages_preprocessor

python -m backend.processors.synthetic_preprocessor --num-images 32 --batch-size 8 --bucket synthetic --save-to-db
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
Frontend будет доступен на `http://localhost:3001`.

## Helm / k3s

```bash
./deploy/k3s/deploy_avsp_k3s.sh
```

```bash
helm upgrade --install avsp ./deploy/helm/avsp \
  --namespace avsp --create-namespace \
  -f ./deploy/helm/avsp/values-k3s.yaml
```

```bash
helm -n avsp uninstall avsp
kubectl -n avsp get pods
kubectl -n avsp get svc
```
