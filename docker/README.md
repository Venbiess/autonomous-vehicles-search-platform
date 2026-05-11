# Docker Docs

This directory contains all Docker-related build and runtime documentation for AVSP.

## Start Here

- Full stack build and run: [BUILDME.md](BUILDME.md)
- Storage-only profiles (pgvector / qdrant): [storage/README.md](storage/README.md)
- Frontend Docker packaging notes: [frontend/README.md](frontend/README.md)

## Important Files

- Main compose stack: [`docker-compose.yml`](docker-compose.yml)
- GPU override compose: [`docker-compose.gpu.yml`](docker-compose.gpu.yml)
- Compose env overrides template: [`.env.example`](.env.example)
- Frontend k8s Dockerfile: [`frontend/frontend.k8s.Dockerfile`](frontend/frontend.k8s.Dockerfile)
- Model image build/runtime scripts: [`models/`](models)
- Server helper scripts: [`server/`](server)
