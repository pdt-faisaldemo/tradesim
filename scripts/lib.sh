# Sourced by the other scripts. Not executable on its own.
# Secrets are read from the environment. For interactive use on the EC2 host they are loaded from
# $TRADESIM_ENV_FILE (default ~/.tradesim.env, mode 600, never in the repo). In-cluster they come from Secret env vars.

ENV_FILE=${TRADESIM_ENV_FILE:-$HOME/.tradesim.env}
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

K=${KUBECTL:-kubectl}
NS=${TRADESIM_NS:-tradesim}
OWNER=$(printf '%s' "${GHCR_OWNER:-pdt-faisaldemo}" | tr '[:upper:]' '[:lower:]')
REPO_URL=${GITHUB_REPO_URL:-https://github.com/$OWNER/tradesim}
SERVICES="account market-data risk order portfolio gateway"

log() { echo "[$(basename "$0")] $*"; }
warn() { echo "[$(basename "$0")] WARNING: $*" >&2; }
die() { echo "[$(basename "$0")] ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
# Prints the command, then runs it. $K may be several words ("sudo k3s kubectl"), so it is left unquoted.
kube() { echo "+ kubectl $*"; $K "$@"; }

# Baseline image tag per service: gateway carries the UI build, everything else is v1.0.0.
baseline_tag() { if [ "$1" = gateway ]; then echo v1.0.0-ui5; else echo v1.0.0; fi; }
svc_port() {
  case "$1" in
    order) echo 8081 ;; risk) echo 8082 ;; account) echo 8083 ;; portfolio) echo 8084 ;; market-data) echo 8085 ;; gateway) echo 8080 ;;
    *) return 1 ;;
  esac
}
# Base URL of a TradeSim service: in-cluster DNS when IN_CLUSTER=1, otherwise the Service ClusterIP (reachable from the k3s host).
svc_url() {
  local host
  if [ "${IN_CLUSTER:-0}" = 1 ]; then host="$1.$NS"; else host=$($K -n "$NS" get svc "$1" -o jsonpath='{.spec.clusterIP}' 2>/dev/null); fi
  [ -n "$host" ] && echo "http://$host:$(svc_port "$1")"
}
image_ref() { echo "ghcr.io/$OWNER/tradesim-$1:$2"; }

# ---- chaos-api (flags + active scenario) ----
# CHAOS_URL wins; otherwise the Service ClusterIP (reachable from the k3s host). Empty output = not deployed.
chaos_url() {
  if [ -n "${CHAOS_URL:-}" ]; then echo "$CHAOS_URL"; return; fi
  if [ "${IN_CLUSTER:-0}" = 1 ]; then echo "http://chaos-api.platform:8090"; return; fi
  local ip
  ip=$($K -n platform get svc chaos-api -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
  if [ -n "$ip" ]; then echo "http://$ip:8090"; fi
}
# chaos_get PATH / chaos_post PATH JSON: print the response body; return 1 when chaos-api cannot be reached.
chaos_get() {
  local url
  url=$(chaos_url)
  [ -n "$url" ] || return 1
  curl -sf --max-time 3 "$url$1"
}
chaos_post() {
  local url
  url=$(chaos_url)
  [ -n "$url" ] || return 1
  curl -sf --max-time 3 -X POST -H 'content-type: application/json' -d "$2" "$url$1"
}
