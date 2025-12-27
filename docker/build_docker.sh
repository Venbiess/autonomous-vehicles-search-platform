set -a
source ../configs/waymo.env
set +a

docker build \
  -f Dockerfile \
  --build-arg PROJECT_NAME=$PROJECT_NAME \
  --build-arg GCLOUD_PROJECT=$GCLOUD_PROJECT \
  --build-arg ENVIRONMENT=$ENVIRONMENT \
  --build-arg APP_DIR=$APP_DIR \
  -t avsp ..
