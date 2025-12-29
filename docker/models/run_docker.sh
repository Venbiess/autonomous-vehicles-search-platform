#!/usr/bin/env bash
set -e

START_JUPYTER=false

if [[ "$1" == "--jupyter" ]]; then
  START_JUPYTER=true
fi

docker rm -f avsp-models-dev-$USER 2>/dev/null || true

docker run --rm -it \
  -e START_JUPYTER=$START_JUPYTER \
  -p 8000:8000 \
  -p 8888:8888 \
  -v "$(pwd)/../..":/app \
  -v "vscode-server-$USER":/root/.vscode-server \
  --name avsp-models-dev-$USER \
  avsp-models