# compose: 1 volume

```bash
docker compose -f scripts/compose.min.yml up -d --build
```

# compose: 2 volumes

```bash
docker compose -f scripts/compose.base.yml up -d --build
```

# build unified bencher

```bash
cd ../../
go build -o bencher ./tools/bencher
```

# run tests

```bash
go test -v ./...
```

# bencher

```bash
./bencher object --target storage --url http://127.0.0.1:9000 --size 512KB --ops 500 --concurrency 6
```

```bash
bash scripts/run_minio.sh
```

```bash
./bencher object --target minio --url http://127.0.0.1:9005 --size 512KB --ops 500 --concurrency 6
```
