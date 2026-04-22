# autonomous-vehicles-search-platform

## Configs

## Build

### Server

colima start --memory 8 --cpu 4 --disk 100

```
cd docker/server/
docker compose -f ./docker-compose.yml up
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
Frontend будет доступен на `http://localhost:3002`.
