docker rm -f avsp-server-dev-$USER 2>/dev/null || true

docker run \
  -v "$(pwd)/../..":/app \
  -v "vscode-server-$USER":/root/.vscode-server \
  --name avsp-server-dev-$USER \
  -p 1002:1000 \
  avsp-server
