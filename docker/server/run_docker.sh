docker rm -f avsp-server-dev-$USER 2>/dev/null || true

docker run -d \
  -v "$(pwd)/../..":/app \
  -v "vscode-server-$USER":/root/.vscode-server \
  --name avsp-server-dev-$USER \
  -p 9100:9000 \
  avsp-server
