# Storage Compose Profiles

Use these profiles when you need only the storage/data plane without the full AVSP stack.

## What This Stack Runs

- `storage-server` (Go API): object metadata, object content access, vector APIs, VLM annotation APIs
- `postgres`: metadata database
- `minio` + `minio-init`: object storage and bucket bootstrap
- `clickhouse`: analytics/annotation storage
- Optional `qdrant`: vector index provider in Qdrant profile

## Profile Selection Logic

- `docker-compose.yml` and `docker-compose.pgvector.yml` use `storage/config/storage.pgvector.yaml`
  - Vector provider: `pgvector` (inside PostgreSQL)
- `docker-compose.qdrant.yml` uses `storage/config/storage.qdrant.yaml`
  - Vector provider: `qdrant` (external vector service) while metadata remains in PostgreSQL

In all profiles, `storage-server` receives config through:
- `STORAGE_CONFIG_PATH=/app/storage/config/<profile>.yaml`
- bind mount `../../storage/config:/app/storage/config:ro`

## Start (PGVector, default)

```bash
docker compose -f docker/storage/docker-compose.yml up --build
# equivalent explicit profile:
docker compose -f docker/storage/docker-compose.pgvector.yml up --build
```

## Start (Qdrant)

```bash
docker compose -f docker/storage/docker-compose.qdrant.yml up --build
```

## Exposed Host Ports

- Storage API: `9012`
- PostgreSQL: `5432`
- MinIO API: `9002` (container `9000`)
- MinIO Console: `9001`
- ClickHouse HTTP: `8123`
- ClickHouse Native: `9000`
- Qdrant HTTP (qdrant profile only): `6333`

## Stop

```bash
docker compose -f docker/storage/docker-compose.pgvector.yml down
# or
docker compose -f docker/storage/docker-compose.qdrant.yml down
```

## Notes

- Buckets are auto-created by `minio-init` (`waymo`, `argoverse`, `nuimages`, `nuscenes`, `avsp`, and profile-dependent extras).
- All storage profile services are isolated in `storage-net` to keep this stack independent from the full compose network.
