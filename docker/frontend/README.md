# Frontend Docker Layout

This directory contains Docker assets for packaging the AVSP frontend for Kubernetes-style deployment.

## Files

- `frontend.k8s.Dockerfile`: multi-stage production image for the Next.js frontend

## How It Works

1. `deps` stage
- Uses `node:20-alpine`
- Installs dependencies with `npm ci` from `frontend/package*.json`

2. `builder` stage
- Copies source from `frontend/`
- Runs `npm run build` to produce `.next`

3. `runner` stage
- Copies built artifacts and runtime dependencies
- Exposes `3001`
- Starts app with:
```bash
npm run start -- --hostname 0.0.0.0 --port 3001
```

## Where This Image Is Used

- k3s helper script: `deploy/k3s/deploy_avsp_k3s.sh`
- Helm values default image: `avsp/frontend:local`

## Important Distinction

- Local Docker Compose development uses a separate `frontend` service defined in `docker/docker-compose.yml` with bind mounts and `npm run dev` (hot reload).
- `frontend.k8s.Dockerfile` is for production-style packaged runtime, not for iterative local dev.
