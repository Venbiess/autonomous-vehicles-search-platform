docker rm -f avsp-dev-$USER 2>/dev/null || true

docker run -d \
  -v "$(pwd)/..":/app \
  -v "vscode-server-$USER":/root/.vscode-server \
  --name avsp-dev-$USER \
  avsp tail -f /dev/null
