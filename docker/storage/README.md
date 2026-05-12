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

## Start (PGVector with SeaweedFS objects)

```bash
docker compose -f docker/storage/docker-compose.seaweedfs.yml up -d --build
```

## Start (Qdrant)

```bash
docker compose -f docker/storage/docker-compose.qdrant.yml up --build
```

## Benchmark Vector Search with `benchervs`

`benchervs` is a CLI runner for practical vector-search checks. You can run it directly against a backend with `--type`, without storage config files. The default mode is `run`: first it inserts `N` vectors, then it executes `M` search queries and prints timing plus latency percentiles.

Run a complete insert + search pass against PGVector:

```bash
go run ./storage/cmd/benchervs \
  -type pgvector \
  -dsn 'host=localhost port=5432 dbname=avsp user=postgres password=postgres sslmode=disable' \
  -seed-count 20000 \
  -query-count 5000 \
  -batch-size 256 \
  -concurrency 16 \
  -topk 20 \
  -query-pattern self \
  -manifest /tmp/benchervs-pg.json
```

Run the same benchmark against Qdrant:

```bash
go run ./storage/cmd/benchervs \
  -type qdrant \
  -endpoint http://localhost:6333 \
  -mode query \
  -query-count 5000 \
  -concurrency 16 \
  -topk 20 \
  -query-pattern hot \
  -manifest /tmp/benchervs-pg.json
```

Only measure insert speed:

```bash
go run ./storage/cmd/benchervs \
  -type pgvector \
  -dsn 'host=localhost port=5432 dbname=avsp user=postgres password=postgres sslmode=disable' \
  -mode insert \
  -seed-count 50000 \
  -batch-size 512
```

Only measure search speed against an already inserted dataset:

```bash
go run ./storage/cmd/benchervs \
  -type pgvector \
  -dsn 'host=localhost port=5432 dbname=avsp user=postgres password=postgres sslmode=disable' \
  -mode query \
  -query-count 10000 \
  -concurrency 32 \
  -topk 20 \
  -query-pattern hot \
  -manifest /tmp/benchervs-pg.json
```

Mixed read/write pressure:

```bash
go run ./storage/cmd/benchervs \
  -type pgvector \
  -dsn 'host=localhost port=5432 dbname=avsp user=postgres password=postgres sslmode=disable' \
  -mode mixed \
  -mixed-ops 10000 \
  -concurrency 16 \
  -write-percent 25 \
  -query-pattern hot
```

You can still use `-config ./storage/config/<file>.yaml` if you want to reuse project configs.

### One-Click Benchmarks in GitHub Actions

There is a manual workflow button now:

- **Actions** → **BencherVS** → **Run workflow**

It runs `benchervs` for:

- `pgvector`
- `qdrant`
- `ydb`

You can run one backend or `all`, tune `seed_count/query_count/vector_size/topk/concurrency`, and get:

- clear text summary in workflow step summary
- JSON/text artifacts per backend

### Local Bench Script (single backend)

```bash
storage/tests/run_benchervs_backend.sh
# по умолчанию: all (pgvector -> qdrant -> ydb)

BACKEND=pgvector storage/tests/run_benchervs_backend.sh
# or BACKEND=qdrant / BACKEND=ydb
```

Outputs are saved in:

- `storage/tests/.benchervs/<backend>-benchervs.json`
- `storage/tests/.benchervs/<backend>-benchervs.txt`

### Run Integration Tests Across All Storage Variants

```bash
storage/tests/run_all_backends.sh
```

This runs `storage/tests/tests.sh` sequentially for:

- `pgvector`
- `qdrant`
- `ydb`
- `ytsaurus`
- `seaweedfs`

## External YTsaurus as Object Store

`storage-server` now supports `provider: ytsaurus` for object blobs through the YTsaurus HTTP proxy and Cypress file nodes.

Required object store fields:

- `provider: ytsaurus`
- `endpoint_url`: YTsaurus HTTP proxy base URL
- `auth_token`: OAuth token for the proxy
- `path_prefix`: Cypress root for stored files, for example `//tmp/avsp`

You can also override them via env:

- `OBJECT_STORE_PROVIDER=ytsaurus`
- `OBJECT_STORE_ENDPOINT_URL=http://yt-proxy:80`
- `OBJECT_STORE_AUTH_TOKEN=<token>`
- `OBJECT_STORE_PATH_PREFIX=//tmp/avsp`

## External YDB as Vector Store

`storage-server` also supports `vector_index.provider: ydb`.

Required vector fields:

- `provider: ydb`
- `conn_str`: YDB connection string, for example `grpc://localhost:2136/local`
- `table`: vector table name

Optional fields:

- `schema`: table directory or path prefix
- `distance`: `cosine`, `euclidean`, or `manhattan`
- `vector_size`
- `index_name`: existing YDB vector index name to query through `VIEW`
- `search_top_size`: value for `PRAGMA ydb.KMeansTreeSearchTopSize`

Current behavior:

- writes use ordinary `UPSERT`
- default search is exact KNN without a vector index
- if `index_name` is set, search uses `VIEW <index_name>`

This is intentional because YDB currently documents limitations around vector index updates after mutations.

## External Milvus as Vector Store

`storage-server` also supports `vector_index.provider: milvus`.

Required vector fields:

- `provider: milvus`
- `endpoint_url`: Milvus REST endpoint, for example `http://milvus:19530`
- `table` or `collection`: Milvus collection name

Optional fields:

- `schema`: Milvus database name, defaults to `default`
- `api_key`: auth token in `username:password` format, for example `root:Milvus`
- `distance`: `cosine`, `ip`, or `euclidean`
- `vector_size`
- `timeout_sec`

Current behavior:

- collection is auto-created on first upsert/search if it does not exist
- collection schema is fixed by the adapter:
  - primary key field: `object_id` (`VarChar`)
  - vector field: `embedding`
- writes use Milvus `upsert`
- reads use `search`, `get`, and `get_stats` through REST v2 APIs

## Exposed Host Ports

- Storage API: `9012`
- PostgreSQL: `5432`
- MinIO API: `9002` (container `9000`)
- MinIO Console: `9001`
- SeaweedFS S3 API (seaweedfs profile only): `8333`
- SeaweedFS Filer UI/API (seaweedfs profile only): `8888`
- SeaweedFS Master UI/API (seaweedfs profile only): `9333`
- ClickHouse HTTP: `8123`
- ClickHouse Native: `9000`
- Qdrant HTTP (qdrant profile only): `6333`

## Stop

```bash
docker compose -f docker/storage/docker-compose.pgvector.yml down
# or
docker compose -f docker/storage/docker-compose.qdrant.yml down
# or
docker compose -f docker/storage/docker-compose.seaweedfs.yml down
```

## Notes

- Buckets are auto-created by `minio-init` (`waymo`, `argoverse`, `nuimages`, `nuscenes`, `avsp`, and profile-dependent extras).
- All storage profile services are isolated in `storage-net` to keep this stack independent from the full compose network.
