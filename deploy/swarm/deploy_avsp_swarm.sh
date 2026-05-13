#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STACK_FILE="${SCRIPT_DIR}/docker-stack.yml"
STACK_NAME="${STACK_NAME:-avsp}"
BUILD_IMAGES="${BUILD_IMAGES:-1}"

if ! docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null | grep -qE 'active|pending'; then
  echo "Initializing Docker Swarm on this node..."
  docker swarm init >/dev/null
fi

if [[ "${BUILD_IMAGES}" == "1" ]]; then
  echo "Building local AVSP images for Swarm..."
  docker build -f "${PROJECT_ROOT}/docker/storage/storage-server.Dockerfile" -t avsp/storage-server:swarm "${PROJECT_ROOT}"
  docker build -f "${PROJECT_ROOT}/docker/server/server.Dockerfile" -t avsp/master:swarm "${PROJECT_ROOT}"
  docker build -f "${PROJECT_ROOT}/docker/models/models.Dockerfile" -t avsp/models-cpu:swarm "${PROJECT_ROOT}"
  docker build -f "${PROJECT_ROOT}/docker/frontend/frontend.k8s.Dockerfile" -t avsp/frontend:swarm "${PROJECT_ROOT}"
fi

echo "Deploying stack '${STACK_NAME}' from ${STACK_FILE}..."
PROJECT_ROOT="${PROJECT_ROOT}" docker stack deploy --compose-file "${STACK_FILE}" --prune "${STACK_NAME}"

echo "Done. Watch services with:"
echo "  docker stack services ${STACK_NAME}"
echo "  docker stack ps ${STACK_NAME}"
