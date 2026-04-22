# AVSP Helm Chart (k3s)

## k3s deploy
```bash
deploy/k3s/deploy_avsp_k3s.sh
```

## Helm install
```bash
helm upgrade --install avsp ./deploy/helm/avsp \
  --namespace avsp --create-namespace \
  -f ./deploy/helm/avsp/values-k3s.yaml
```

## Helm uninstall
```bash
helm -n avsp uninstall avsp
```

## Check
```bash
kubectl -n avsp get pods
kubectl -n avsp get svc
kubectl -n avsp logs deploy/storage-server
```
