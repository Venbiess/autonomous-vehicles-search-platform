# AVSP Frontend

This frontend is the operator UI for **Autonomous Vehicles Search Platform (AVSP)**.
It provides a single web interface for search, VLM workflows, storage operations, and runtime observability.

## What This UI Does in AVSP

- Multimodal search:
  - text-to-image search
  - image-to-image search
- VLM workflow:
  - define VLM fields/schema
  - run VLM backfill jobs
  - filter/search by VLM annotations
- Storage operations:
  - dataset visibility toggles
  - object/embedding cleanup actions
  - import/export snapshots and transfer progress
- Runtime monitoring:
  - model/system info
  - job status and job logs

## Frontend Architecture

- Next.js app with React UI components
- Hybrid routing:
  - `app/` for page shell (`app/page.tsx`)
  - `pages/api/` for server-side proxy and orchestration endpoints
- Custom Node entrypoint: `server.js`
  - supports configurable host/port
  - supports request timeout via env

## AVSP Integration Model

The browser talks to frontend API routes (`/api/*`), and those routes call AVSP backend services:

- `MASTER_ENDPOINT` (default `http://localhost:9002`): search, VLM, jobs, system-info
- `STORAGE_SERVER_ENDPOINT` (default `http://localhost:9013`): object/vector/storage operations
- `ANALYTICS_SERVER_ENDPOINT` (optional): analytics/annotation reads (falls back to storage endpoint in some routes)

This keeps backend topology and tokens on the server side, not in browser code.

## Key API Route Groups

- `pages/api/search.js`: text/image search proxy + result normalization
- `pages/api/vlm/*`: VLM schema/backfill/search/clear endpoints
- `pages/api/storage/*`: storage stats, dataset visibility, cleanup, transfer
- `pages/api/jobs/*`: list/cancel/retry job execution
- `pages/api/system-info.js`: system and model runtime status
- `pages/api/waymo/auth/*`: Waymo auth flow helpers

## Environment Variables

Common runtime variables used by AVSP frontend:

- `MASTER_ENDPOINT`
- `MASTER_PROXY_TIMEOUT_MS`
- `STORAGE_SERVER_ENDPOINT`
- `ANALYTICS_SERVER_ENDPOINT`
- `STORAGE_WRITE_TOKEN`
- `MINIO_PUBLIC_ENDPOINT`
- `MINIO_BUCKET`
- `FRONTEND_REQUEST_TIMEOUT_MS`
- `NEXT_PUBLIC_GRAFANA_DASHBOARD_URL` (default `http://localhost:3004/d/avsp-observability/avsp-observability?orgId=1`): quick link button in Job Monitor
- `NEXT_PUBLIC_GRAFANA_CONTAINER_DASHBOARD_URL` (default `http://localhost:3004/d/avsp-container-drilldown/avsp-container-drilldown?orgId=1`): per-container drilldown dashboard
- `NEXT_PUBLIC_CADVISOR_CONTAINERS_URL` (default `http://localhost:8088/containers/`): container list with per-process tab in cAdvisor

See `docker/docker-compose.yml` for current defaults used in local stack.

## Local Development

From repository root:

```bash
cd frontend
npm install
npm run dev
```

Default local URL:

- `http://localhost:3000`

## Docker Runtime Notes

- In local Docker Compose, frontend now runs as a production process (`npm run build` + `npm run start`) to reduce runtime memory usage.
- In Kubernetes/k3s flows, frontend is packaged with `docker/frontend/frontend.k8s.Dockerfile` and runs as a production build.
- For frontend code fixes in local Compose, use container restart (no image rebuild needed):

```bash
docker compose -f docker/docker-compose.yml restart frontend
```
