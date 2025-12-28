docker build \
  -f models-cpu.Dockerfile \
  --build-arg APP_DIR=$APP_DIR \
  -t avsp-models ../..
