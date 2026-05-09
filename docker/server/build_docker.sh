#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

docker build \
  -f "$SCRIPT_DIR/server.Dockerfile" \
  -t avsp-master \
  "$SCRIPT_DIR/../.."
