docker rm -f avsp-models-dev-$USER 2>/dev/null || true

docker run -d \
  -v "$(pwd)/../..":/app \
  -v "vscode-server-$USER":/root/.vscode-server \
  --name avsp-models-dev-$USER \
  avsp-models tail -f /dev/null
