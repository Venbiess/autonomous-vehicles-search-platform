# autonomous-vehicles-search-platform

## Configs

## Build

### Server

colima start --memory 8 --cpu 4 --disk 100

```
cd docker/server/
docker compose -f ./docker-compose.yml up
```

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
