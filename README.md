# Autonomous Vehicles Search Platform (AVSP)

AVSP is a multimodal retrieval platform for autonomous driving datasets.
It ingests scene data, generates embeddings and vision-language metadata, and provides search APIs and a web UI for exploration, analytics, and curation workflows.

## What You Can Do in the Platform

### BROWSER (Text Search)

Use natural language to find relevant scenes directly in the browser UI, then refine and inspect results interactively.

![Text Search Demo](https://github.com/user-attachments/assets/6c2a571a-4a78-4d9e-a527-f474b6c646dd)

### BROWSER (Image Search)

Use image-based search to retrieve visually similar scenes and quickly pivot between related samples.

![Image Search Demo](https://github.com/user-attachments/assets/94dd819a-6132-43dc-a43c-db68728608b6)

### VLM

Run VLM-based filtering to query scenes by extracted semantic attributes and structured annotation fields.

![VLM Search Demo](https://github.com/user-attachments/assets/ba8d499f-9159-4489-9de2-fdd107c05544)

### STORAGE

Manage objects and datasets in Storage: filter by dataset/key, inspect entries, and control pagination for large catalogs.

![Storage Demo](https://github.com/user-attachments/assets/4b29254e-bb78-4b7b-8ffc-f11bbc79f794)

### JOB MONITOR

Track long-running jobs and system activity in Job Monitor, including progress and operational status across services.

![Job Monitor](https://github.com/user-attachments/assets/c9c26dbe-1b78-4f3d-96ba-ae9ffb1bb65c)

### ANNOTATION

Use Annotation tools to configure dataset workflows, launch enrichment tasks, and curate metadata-driven pipelines.

![Annotation](https://github.com/user-attachments/assets/de7e2593-0b31-4f7b-a546-7e1782c6745e)

## What AVSP Includes

- `master-server` (FastAPI): orchestration, search APIs, and model task routing
- `storage-server` (Go): object metadata, vector search integration, and analytics endpoints
- Model workers (Python): embedding and VLM task processing over RabbitMQ
- Frontend (Next.js): operator UI for search, VLM fields, transfer, and dataset tools
- Data services: PostgreSQL/pgvector, Qdrant, Milvus, MinIO, ClickHouse, RabbitMQ
- Observability: Prometheus, Grafana, cAdvisor

## Architecture

AVSP combines API services, model workers, and vector-aware storage into a single retrieval pipeline.
This architecture supports multimodal indexing and fast scene-level search across large autonomous driving datasets.

![AVSP Architecture](https://github.com/user-attachments/assets/023d4deb-0608-4212-b433-579c9333eeae)

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
- Environment variables catalog: [configs/ENVIRONMENT.md](configs/ENVIRONMENT.md)
- Dataset/model runtime config source: [`configs/`](configs)

## Quick Start

For local development with Docker Compose, use the guide in [docker/BUILDME.md](docker/BUILDME.md).
If you run compose from repository root, use `docker/.env` (template: [`docker/.env.example`](docker/.env.example)) via `--env-file docker/.env`.

Typical local endpoints after `docker compose` startup:

- Frontend: `http://localhost:3000`
- Master API: `http://localhost:9002` (`/health` on the master service)
- Storage API: `http://localhost:9013`
- RabbitMQ UI: `http://localhost:15672`
- Grafana: `http://localhost:3004`
- Prometheus: `http://localhost:9090`

## Deployment

For k3s + Helm deployment, start with [deploy/README.md](deploy/README.md).
