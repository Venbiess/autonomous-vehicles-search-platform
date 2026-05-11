# Docker Docs

This directory contains all Docker-related build and runtime documentation for AVSP.

## Start Here

- Full stack build and run: [BUILDME.md](BUILDME.md)
- Dev reload flag (`AVSP_DEV_RELOAD`) for master + frontend/API routes: [BUILDME.md#dev-reload-mode-master--analytics-routes--frontend](BUILDME.md#dev-reload-mode-master--analytics-routes--frontend)
- Storage-only profiles (pgvector / qdrant): [storage/README.md](storage/README.md)
- Frontend Docker packaging notes: [frontend/README.md](frontend/README.md)

## Important Files

- Main compose stack: [`docker-compose.yml`](docker-compose.yml)
- GPU override compose: [`docker-compose.gpu.yml`](docker-compose.gpu.yml)
- Compose env overrides template: [`.env.example`](.env.example)
- Frontend k8s Dockerfile: [`frontend/frontend.k8s.Dockerfile`](frontend/frontend.k8s.Dockerfile)
- Model image build/runtime scripts: [`models/`](models)
- Server helper scripts: [`server/`](server)
