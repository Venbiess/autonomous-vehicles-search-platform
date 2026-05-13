# AVSP Docker Swarm

Stack deployment for AVSP with `docker stack deploy`.

## Files

- [`docker-stack.yml`](docker-stack.yml): swarm-compatible stack definition
- [`deploy_avsp_swarm.sh`](deploy_avsp_swarm.sh): helper that optionally builds local images and deploys the stack

## Prerequisites

- Docker Engine with Swarm mode available
- Run on Swarm manager node

## Deploy

```bash
./deploy/swarm/deploy_avsp_swarm.sh
```

By default the script:

1. Initializes swarm if needed.
2. Builds local images:
   - `avsp/storage-server:swarm`
   - `avsp/master:swarm`
   - `avsp/models-cpu:swarm`
   - `avsp/frontend:swarm`
3. Deploys stack `avsp`.

### Useful options

```bash
# reuse already-built images
BUILD_IMAGES=0 ./deploy/swarm/deploy_avsp_swarm.sh

# custom stack name
STACK_NAME=avsp-dev ./deploy/swarm/deploy_avsp_swarm.sh
```

## Validate

```bash
docker stack services avsp
docker stack ps avsp
```

## Remove stack

```bash
docker stack rm avsp
```
