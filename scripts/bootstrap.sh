#!/usr/bin/env bash
# Idempotent first-time setup + (re)apply of everything in k8s/base. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
# Loads ~/.tradesim.env (KUBECTL etc.) and sets K.
. scripts/lib.sh

echo "==> namespaces"
$K apply -f k8s/base/namespace.yaml

echo "==> secret tradesim-secrets (tradesim namespace)"
if $K -n tradesim get secret tradesim-secrets >/dev/null 2>&1; then
  echo "exists, leaving as is"
else
  PW=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  $K -n tradesim create secret generic tradesim-secrets --from-literal=DB_PASSWORD="$PW"
  echo "created with a generated DB_PASSWORD"
fi

echo "==> configmaps"
$K apply -f k8s/base/configmaps/

echo "==> postgres"
$K apply -f k8s/base/postgres.yaml
$K -n tradesim rollout status deploy/postgres --timeout=120s

echo "==> seed job"
$K -n tradesim delete job seed --ignore-not-found
$K apply -f k8s/base/seed-job.yaml
$K -n tradesim wait --for=condition=complete job/seed --timeout=120s

echo "==> redis"
$K apply -f k8s/base/redis.yaml
$K -n tradesim rollout status deploy/redis --timeout=120s

# Dependency order: account, market-data, then the services that call them.
SERVICES="account market-data risk order portfolio gateway"
for svc in $SERVICES; do
  echo "==> $svc"
  $K apply -f k8s/base/$svc.yaml
done
for svc in $SERVICES; do
  $K -n tradesim rollout status deploy/$svc --timeout=120s
done

echo "==> platform (chaos-api flags, loadgen)"
$K apply -f k8s/platform/
for d in chaos-api loadgen; do
  $K -n platform rollout status deploy/$d --timeout=120s
done

echo "==> ingress"
$K apply -f k8s/base/ingress.yaml
echo "bootstrap done"
