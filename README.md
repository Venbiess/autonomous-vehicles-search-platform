# autonomous-vehicles-search-platform

## Configs

## Build

### Server

```
cd docker/server/
source ./build_docker.sh
source ./run_docker.sh
```

For Waymo:
```
docker exec -it <CONTAINED_ID> bash
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
