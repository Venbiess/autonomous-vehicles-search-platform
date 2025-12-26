docker run -d \
  -v "$(pwd)/..":/app \
  -v "vscode-server-$USER":/root/.vscode-server \
  --env-file ../configs/waymo.env \
  --name avsp-dev-$USER \
  avsp tail -f /dev/null
