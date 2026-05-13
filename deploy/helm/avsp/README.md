# AVSP Helm Chart

Helm chart for deploying AVSP services and datastores on Kubernetes.

## Chart location

```text
deploy/helm/avsp
```

## Prerequisites

- Kubernetes cluster (k3s supported)
- Helm 3+
- Images available to the cluster:
  - `avsp/storage-server:local`
  - `avsp/master:local`
  - `avsp/models-cpu:local`
  - `avsp/frontend:local`

For local k3s image build/import flow, see [../../k3s/README.md](../../k3s/README.md).

## Install / Upgrade

```bash
helm upgrade --install avsp ./deploy/helm/avsp \
  --namespace avsp \
  --create-namespace \
  -f ./deploy/helm/avsp/values-k3s.yaml
```

## Uninstall

```bash
helm -n avsp uninstall avsp
```

## Validate deployment

```bash
kubectl -n avsp get pods
kubectl -n avsp get svc
kubectl -n avsp logs deploy/storage-server
```

## Values files

- Base defaults: [`values.yaml`](values.yaml)
- k3s-focused overrides: [`values-k3s.yaml`](values-k3s.yaml)

## Notes

- Worker-based model execution is enabled by default (`modelExecutionMode: rabbitmq`).
- Ingress is enabled in `values-k3s.yaml` and uses Traefik by default.
- Storage backend defaults to `pgvector` in chart config.
- Milvus datastore support is available via `milvus.enabled=true` (and `storageServer.config.vectorIndex.provider=milvus`).
