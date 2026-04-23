#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAMESPACE="${NAMESPACE:-avsp}"
RELEASE_NAME="${RELEASE_NAME:-avsp}"
VALUES_FILE="${VALUES_FILE:-$REPO_ROOT/deploy/helm/avsp/values-k3s.yaml}"

cd "$REPO_ROOT"

echo "[1/4] Building local images"
docker build -f docker/storage/storage-server.Dockerfile -t avsp/storage-server:local .
docker build -f docker/server/server.k8s.Dockerfile -t avsp/master:local .
docker build -f docker/models/models-cpu.k8s.Dockerfile -t avsp/models-cpu:local .
docker build -f docker/frontend/frontend.k8s.Dockerfile -t avsp/frontend:local .

echo "[2/4] Importing images into k3s containerd"
for image in \
  avsp/storage-server:local \
  avsp/master:local \
  avsp/models-cpu:local \
  avsp/frontend:local; do
  docker save "$image" | sudo k3s ctr images import -
done

echo "[3/4] Installing/upgrading Helm release"
helm upgrade --install "$RELEASE_NAME" "$REPO_ROOT/deploy/helm/avsp" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  -f "$VALUES_FILE"

echo "[4/4] Done"
kubectl -n "$NAMESPACE" get pods
