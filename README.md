# Autonomous Vehicles Search Platform (AVSP)

AVSP is a multimodal retrieval platform for autonomous driving datasets.
It ingests scene data, generates embeddings and vision-language metadata, and provides search APIs and a web UI for exploration, analytics, and curation workflows.

## What AVSP Includes

- `master-server` (FastAPI): orchestration, search APIs, and model task routing
- `storage-server` (Go): object metadata, vector search integration, and analytics endpoints
- Model workers (Python): embedding and VLM task processing over RabbitMQ
- Frontend (Next.js): operator UI for search, VLM fields, transfer, and dataset tools
- Data services: PostgreSQL/pgvector (or Qdrant profile), MinIO, ClickHouse, RabbitMQ
- Observability: Prometheus, Grafana, cAdvisor

## Repository Guide

- Docker build/run docs: [docker/BUILDME.md](docker/BUILDME.md)
- Docker docs index: [docker/README.md](docker/README.md)
- Storage-only compose profiles: [docker/storage/README.md](docker/storage/README.md)
- Kubernetes and Helm docs: [deploy/README.md](deploy/README.md)
- Helm chart docs: [deploy/helm/avsp/README.md](deploy/helm/avsp/README.md)
- Frontend app source: [`frontend/`](frontend)
- Backend docs: [backend/README.md](backend/README.md)
- Backend services and models source: [`backend/`](backend)
- Storage server source: [`storage/`](storage)
- Config docs: [configs/README.md](configs/README.md)
- Dataset/model runtime config source: [`configs/`](configs)

## Quick Start

For local development with Docker Compose, use the guide in [docker/BUILDME.md](docker/BUILDME.md).

Typical local endpoints after `docker compose` startup:

- Frontend: `http://localhost:3000`
- Master API: `http://localhost:9002` (`/health` on the master service)
- Storage API: `http://localhost:9013`
- RabbitMQ UI: `http://localhost:15672`
- Grafana: `http://localhost:3004`
- Prometheus: `http://localhost:9090`

## Deployment

For k3s + Helm deployment, start with [deploy/README.md](deploy/README.md).
