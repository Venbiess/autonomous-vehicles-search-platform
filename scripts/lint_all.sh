#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GOLANGCI_LINT_CACHE="${GOLANGCI_LINT_CACHE:-$ROOT_DIR/.cache/golangci-lint}"
mkdir -p "$GOLANGCI_LINT_CACHE"

echo "[lint] ruff (backend)"
cd "$ROOT_DIR"
ruff check backend

echo "[lint] golangci-lint (storage)"
cd "$ROOT_DIR/storage"
golangci-lint run --timeout=10m ./...

echo "[lint] golangci-lint (storage/modules/pics)"
cd "$ROOT_DIR/storage/modules/pics"
golangci-lint run --timeout=10m ./...

echo "[lint] all passed"
