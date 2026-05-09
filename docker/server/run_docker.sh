docker rm -f avsp-master-dev-$USER 2>/dev/null || true

docker run \
  -v "$(pwd)/../..":/app \
  -v "vscode-server-$USER":/root/.vscode-server \
  --name avsp-master-dev-$USER \
  -p 9002:9000 \
  avsp-master
