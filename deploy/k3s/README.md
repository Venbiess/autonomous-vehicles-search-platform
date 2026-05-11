bcgh# AVSP on k3s

Use this flow when running AVSP on a local k3s cluster with locally built images.

## Prerequisites

- Running k3s cluster
- `kubectl`, `helm`, and `docker` available in shell
- Permission to run `sudo k3s ctr images import -`

## One-command deploy

From repository root:

```bash
./deploy/k3s/deploy_avsp_k3s.sh
```

The script performs:

1. Build local AVSP images
2. Import images into k3s containerd
3. Install/upgrade the Helm release
4. Print pod status

## Environment overrides

You can override defaults:

```bash
NAMESPACE=avsp RELEASE_NAME=avsp VALUES_FILE=./deploy/helm/avsp/values-k3s.yaml ./deploy/k3s/deploy_avsp_k3s.sh
```

## Verify

```bash
kubectl -n avsp get pods
kubectl -n avsp get svc
kubectl -n avsp logs deploy/storage-server
```
