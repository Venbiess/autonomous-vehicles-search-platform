# autonomous-vehicles-search-platform

## Configs

## Build

```
cd docker/
source ./build_docker.sh
source ./run_docker.sh
```

For Waymo:
```
docker exec -it <CONTAINED_ID> bash
gcloud auth application-default login
gcloud auth login
```

## Run package
```
python -m backend.processors.argoverse_preprocessor

python -m backend.processors.waymo_preprocessor
```