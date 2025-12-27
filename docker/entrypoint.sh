#!/usr/bin/env bash
set -e

python -u /setup.py

exec "$@"
