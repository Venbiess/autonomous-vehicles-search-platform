# Storage compose profiles

## PGVector profile (default)
```bash
docker-compose -f docker/storage/docker-compose.yml up -d --build
# or explicit:
docker-compose -f docker/storage/docker-compose.pgvector.yml up -d --build
```

Uses:
- postgres (pgvector) for metadata + vector index
- minio for objects
- clickhouse + analytics-server

## Qdrant profile
```bash
docker-compose -f docker/storage/docker-compose.qdrant.yml up -d --build
```

Uses:
- postgres for metadata only
- qdrant for vector index
- minio for objects
- clickhouse + analytics-server

## Stop
```bash
docker-compose -f docker/storage/docker-compose.pgvector.yml down
# or
docker-compose -f docker/storage/docker-compose.qdrant.yml down
```
