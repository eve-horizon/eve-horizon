#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCAL_OVERLAY="$REPO_ROOT/k8s/overlays/local"
K3D_CLUSTER="eve-local"
PF_API_PID=""
PF_WORKER_PID=""

# Source configuration to get EVE_K8S_OWNER
source "$SCRIPT_DIR/_config.sh"
source "$SCRIPT_DIR/_kube_guard.sh"
K3D_CONTEXT="$EH_LOCAL_KUBE_CONTEXT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Check k8s ownership - warns/prompts if this instance doesn't own the k8s cluster
# Returns 0 if allowed to proceed, 1 if user declines
check_k8s_ownership() {
  # If EVE_K8S_OWNER is true, proceed without warning
  if [[ "${EVE_K8S_OWNER:-false}" == "true" ]]; then
    return 0
  fi

  # If running non-interactively (CI/scripts), skip the prompt and just warn
  if [[ ! -t 0 ]]; then
    echo -e "${YELLOW}Warning: This instance is NOT the k8s owner (k8s_owner: ${EVE_K8S_OWNER:-false})${NC}"
    echo "To mark as owner: ./bin/eh configure --k8s-owner"
    return 0
  fi

  # Interactive mode - warn and prompt for confirmation
  echo ""
  echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}  WARNING: This instance is NOT the k8s cluster owner${NC}"
  echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Instance:   $EVE_INSTANCE"
  echo "  K8s Owner:  ${EVE_K8S_OWNER:-false}"
  echo ""
  echo "  The k3d cluster is shared across all Eve Horizon checkouts."
  echo "  Running k8s commands from multiple instances can cause conflicts."
  echo ""
  echo "  If this is the only instance using k8s, run:"
  echo "    ./bin/eh configure --k8s-owner"
  echo ""
  read -p "  Proceed anyway? (y/N): " confirm
  echo ""

  if [[ "$confirm" =~ ^[Yy] ]]; then
    return 0
  else
    echo "Aborted. Configure k8s ownership with: ./bin/eh configure --k8s-owner"
    return 1
  fi
}

show_help() {
  echo "Eve Horizon K8s helpers"
  echo ""
  echo "Usage: eh k8s <command>"
  echo ""
  echo "Commands:"
  echo "  start    Ensure k3d cluster exists, apply local overlay"
  echo "  deploy   Build/import images, apply manifests, run migrations"
  echo "  secrets  Generate/apply auth + platform secrets to eve-app"
  echo "  stop     Delete local overlay resources"
  echo "  status   Show namespace resources and PVCs"
  echo ""
  echo "Start options:"
  echo "  --tcp-ports <ports>  Comma-separated public TCP ports to forward through k3d"
  echo "  --recreate          Delete/recreate the local k3d cluster to apply port mappings"
  echo ""
  echo "Use ./bin/eh kubectl ... for local cluster ops."
  echo "Do not use raw kubectl for local cluster operations."
  echo ""
  echo "Secrets are managed explicitly via the eve CLI:"
  echo "  eve secrets set KEY value --system     # Platform infra keys"
  echo "  eve secrets set KEY value --org <id>   # Org-level provider keys"
  echo ""
  echo "For e2e testing, see: docs/system/testing-strategy.md"
}

require_bin() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required tool: $name"
    exit 1
  fi
}

parse_tcp_ports() {
  local raw="$1"
  if [[ -z "$raw" ]]; then
    return 0
  fi

  RAW_TCP_PORTS="$raw" node <<'EOF'
const raw = process.env.RAW_TCP_PORTS || '';
const seen = new Set();
const ports = [];

for (const part of raw.split(',')) {
  const value = part.trim();
  if (!value) continue;
  if (!/^\d+$/.test(value)) {
    console.error(`Invalid TCP port '${value}'. Use a comma-separated list of numeric ports.`);
    process.exit(1);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    console.error(`Invalid TCP port '${value}'. Ports must be between 1 and 65535.`);
    process.exit(1);
  }
  if (!seen.has(port)) {
    seen.add(port);
    ports.push(port);
  }
}

process.stdout.write(ports.join(' '));
EOF
}

read_k3d_forwarded_ports() {
  (docker inspect "k3d-${K3D_CLUSTER}-serverlb" 2>/dev/null || true) | node -e "
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  if (!input.trim()) {
    process.stdout.write('');
    return;
  }

  const inspected = JSON.parse(input);
  const bindings = inspected?.[0]?.HostConfig?.PortBindings || {};
  const ports = [];
  for (const [containerPort, hostBindings] of Object.entries(bindings)) {
    const match = /^(\\d+)\\/tcp$/.exec(containerPort);
    if (!match) continue;
    for (const binding of hostBindings || []) {
      if (binding?.HostPort === match[1]) {
        ports.push(Number(match[1]));
      }
    }
  }
  process.stdout.write([...new Set(ports)].sort((a, b) => a - b).join(' '));
});
"
}

missing_tcp_port_mappings() {
  local requested_ports="$1"
  local forwarded_ports="$2"
  local missing=()

  for port in $requested_ports; do
    if [[ " $forwarded_ports " != *" $port "* ]]; then
      missing+=("$port")
    fi
  done

  printf '%s\n' "${missing[*]}"
}

ensure_k3d_cluster() {
  local tcp_ports="${1:-}"
  local recreate="${2:-false}"

  require_bin k3d

  if [[ "$recreate" == "true" ]]; then
    echo "Recreating k3d cluster '$K3D_CLUSTER'..."
    k3d cluster delete "$K3D_CLUSTER" >/dev/null 2>&1 || true
  fi

  if ! k3d_cluster_exists; then
    echo "Creating k3d cluster '$K3D_CLUSTER'..."
    # Expose ports: 6443 for k8s API, 80/443 for Ingress (app access via *.lvh.me)
    local create_args=(
      cluster create "$K3D_CLUSTER"
      --api-port 127.0.0.1:6443
      -p "80:80@loadbalancer"
      -p "443:443@loadbalancer"
    )

    for port in $tcp_ports; do
      create_args+=(-p "${port}:${port}@loadbalancer")
    done

    k3d "${create_args[@]}"
  elif [[ -n "$tcp_ports" ]]; then
    local forwarded_ports missing_ports
    forwarded_ports="$(read_k3d_forwarded_ports)"
    missing_ports="$(missing_tcp_port_mappings "$tcp_ports" "$forwarded_ports")"

    if [[ -n "$missing_ports" ]]; then
      echo -e "${RED}ERROR: Existing k3d cluster '$K3D_CLUSTER' does not expose requested TCP port(s): ${missing_ports}${NC}" >&2
      echo "" >&2
      echo "k3d port mappings are fixed when the cluster is created." >&2
      echo "Rerun with: ./bin/eh k8s start --tcp-ports ${tcp_ports// /,} --recreate" >&2
      exit 1
    fi
  fi

  require_k3d_context
  if ! eh_kubectl_local get nodes >/dev/null 2>&1; then
    require_bin k3d
    echo "Starting k3d cluster '$K3D_CLUSTER'..."
    k3d cluster start "$K3D_CLUSTER"
  fi
}

k3d_cluster_exists() {
  k3d cluster list "$K3D_CLUSTER" >/dev/null 2>&1
}

k3d_context_exists() {
  kubectl config get-contexts "$K3D_CONTEXT" >/dev/null 2>&1
}

require_k3d_context() {
  if ! k3d_context_exists; then
    echo "Missing kube context '$K3D_CONTEXT'. Run 'eh k8s start' first."
    exit 1
  fi
}

kubectl_mutate_local() {
  eh_assert_k3d_context_or_die
  eh_kubectl_local "$@"
}

# Check cluster connectivity and auto-recover load balancer if needed
ensure_cluster_connectivity() {
  local max_attempts=3
  local attempt=1

  while [[ $attempt -le $max_attempts ]]; do
    # Try to connect - capture stderr to detect EOF
    local output
    if output=$(eh_kubectl_local get nodes 2>&1); then
      return 0
    fi

    # Check if it's an EOF error (load balancer issue)
    if echo "$output" | grep -q "EOF"; then
      echo "Cluster connection failed (EOF). Restarting load balancer (attempt $attempt/$max_attempts)..."
      docker restart "k3d-${K3D_CLUSTER}-serverlb" >/dev/null 2>&1 || true
      sleep 2
      ((attempt++))
    else
      # Different error - fail immediately
      echo "Cluster connection failed: $output" >&2
      return 1
    fi
  done

  echo "Failed to connect to cluster after $max_attempts attempts" >&2
  return 1
}

# Generate an HS256 JWT using Node.js built-in crypto (no dependencies).
# Usage: generate_hs256_jwt <json_payload> <secret>
generate_hs256_jwt() {
  local payload="$1"
  local secret="$2"
  node -e "
    const crypto = require('crypto');
    const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const payload = Buffer.from(JSON.stringify(${payload})).toString('base64url');
    const sig = crypto.createHmac('sha256', '${secret}')
      .update(header + '.' + payload).digest('base64url');
    console.log(header + '.' + payload + '.' + sig);
  "
}

# Generate auth secrets and patch the eve-app K8s secret.
# Idempotent: reads existing values and only generates missing ones.
generate_auth_secrets() {
  require_bin node

  echo "Generating auth secrets..."

  local system_secrets_file="$REPO_ROOT/system-secrets.env.local"
  if [[ -f "$system_secrets_file" ]]; then
    # shellcheck disable=SC1090
    set -a && source "$system_secrets_file" && set +a
    echo -e "  system-secrets.env.local:  ${GREEN}loaded${NC}"
  else
    echo -e "  system-secrets.env.local:  ${YELLOW}missing (platform secret keys unchanged)${NC}"
  fi

  # Read existing secret values (empty string if key is missing or empty)
  local existing_jwt_secret existing_admin_pw existing_auth_private_key existing_auth_public_key
  local existing_internal_api_key existing_secrets_master_key existing_bootstrap_token
  existing_jwt_secret=$(eh_kubectl_local -n eve get secret eve-app -o jsonpath='{.data.SUPABASE_JWT_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)
  existing_admin_pw=$(eh_kubectl_local -n eve get secret eve-app -o jsonpath='{.data.EVE_AUTH_ADMIN_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)
  existing_auth_private_key=$(eh_kubectl_local -n eve get secret eve-app -o jsonpath='{.data.EVE_AUTH_PRIVATE_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)
  existing_auth_public_key=$(eh_kubectl_local -n eve get secret eve-app -o jsonpath='{.data.EVE_AUTH_PUBLIC_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)
  existing_internal_api_key=$(eh_kubectl_local -n eve get secret eve-app -o jsonpath='{.data.EVE_INTERNAL_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)
  existing_secrets_master_key=$(eh_kubectl_local -n eve get secret eve-app -o jsonpath='{.data.EVE_SECRETS_MASTER_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)
  existing_bootstrap_token=$(eh_kubectl_local -n eve get secret eve-app -o jsonpath='{.data.EVE_BOOTSTRAP_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)

  # Generate missing values
  local jwt_secret="${existing_jwt_secret}"
  local admin_pw="${existing_admin_pw}"
  local auth_private_key="${EVE_AUTH_PRIVATE_KEY:-$existing_auth_private_key}"
  local auth_public_key="${EVE_AUTH_PUBLIC_KEY:-$existing_auth_public_key}"
  local internal_api_key="${EVE_INTERNAL_API_KEY:-$existing_internal_api_key}"
  local secrets_master_key="${EVE_SECRETS_MASTER_KEY:-$existing_secrets_master_key}"
  local bootstrap_token="${EVE_BOOTSTRAP_TOKEN:-$existing_bootstrap_token}"

  if [[ -z "$jwt_secret" ]]; then
    jwt_secret=$(openssl rand -hex 32)
    echo -e "  SUPABASE_JWT_SECRET:       ${GREEN}generated${NC}"
  else
    echo -e "  SUPABASE_JWT_SECRET:       ${YELLOW}exists (kept)${NC}"
  fi

  if [[ -z "$admin_pw" ]]; then
    admin_pw=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
    echo -e "  EVE_AUTH_ADMIN_PASSWORD:   ${GREEN}generated${NC}"
  else
    echo -e "  EVE_AUTH_ADMIN_PASSWORD:   ${YELLOW}exists (kept)${NC}"
  fi

  if [[ -z "$auth_private_key" || -z "$auth_public_key" ]]; then
    local keypair_json
    keypair_json=$(node <<'EOF'
const { generateKeyPairSync } = require('crypto');
const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.stdout.write(JSON.stringify({
  privateKey: keyPair.privateKey,
  publicKey: keyPair.publicKey,
}));
EOF
)
    auth_private_key=$(KEYPAIR_JSON="$keypair_json" node -e "process.stdout.write(JSON.parse(process.env.KEYPAIR_JSON).privateKey)")
    auth_public_key=$(KEYPAIR_JSON="$keypair_json" node -e "process.stdout.write(JSON.parse(process.env.KEYPAIR_JSON).publicKey)")
    echo -e "  EVE_AUTH_KEYPAIR:          ${GREEN}generated${NC}"
  else
    echo -e "  EVE_AUTH_KEYPAIR:          ${YELLOW}exists (kept)${NC}"
  fi

  if [[ -z "$internal_api_key" ]]; then
    internal_api_key=$(openssl rand -hex 24)
    echo -e "  EVE_INTERNAL_API_KEY:      ${GREEN}generated${NC}"
  else
    echo -e "  EVE_INTERNAL_API_KEY:      ${YELLOW}exists (kept)${NC}"
  fi

  if [[ -z "$secrets_master_key" ]]; then
    secrets_master_key=$(openssl rand -hex 32)
    echo -e "  EVE_SECRETS_MASTER_KEY:    ${GREEN}generated${NC}"
  else
    echo -e "  EVE_SECRETS_MASTER_KEY:    ${YELLOW}exists (kept)${NC}"
  fi

  if [[ -z "$bootstrap_token" ]]; then
    bootstrap_token=$(openssl rand -hex 24)
    echo -e "  EVE_BOOTSTRAP_TOKEN:       ${GREEN}generated${NC}"
  else
    echo -e "  EVE_BOOTSTRAP_TOKEN:       ${YELLOW}exists (kept)${NC}"
  fi

  # Derive connection string
  local db_url="postgres://eve_auth_admin:${admin_pw}@postgres.eve.svc.cluster.local:5432/eve?sslmode=disable"

  # Generate JWTs — always re-derive from the (possibly existing) JWT secret
  # so they stay consistent if the secret was regenerated.
  local iat
  iat=$(date +%s)
  local exp=$((iat + 10 * 365 * 24 * 3600)) # 10 years

  local service_key
  service_key=$(generate_hs256_jwt "{\"role\":\"service_role\",\"iss\":\"supabase\",\"iat\":${iat},\"exp\":${exp}}" "$jwt_secret")
  echo -e "  SUPABASE_AUTH_SERVICE_KEY: ${GREEN}derived${NC}"

  local anon_key
  anon_key=$(generate_hs256_jwt "{\"role\":\"anon\",\"iss\":\"supabase\",\"iat\":${iat},\"exp\":${exp}}" "$jwt_secret")
  echo -e "  SUPABASE_ANON_KEY:         ${GREEN}derived${NC}"

  echo -e "  SUPABASE_AUTH_DATABASE_URL: ${GREEN}derived${NC}"

  local patch_json
  patch_json="$(
    SUPABASE_JWT_SECRET="$jwt_secret" \
    EVE_AUTH_ADMIN_PASSWORD="$admin_pw" \
    SUPABASE_AUTH_DATABASE_URL="$db_url" \
    SUPABASE_AUTH_SERVICE_KEY="$service_key" \
    SUPABASE_ANON_KEY="$anon_key" \
    EVE_AUTH_PRIVATE_KEY="$auth_private_key" \
    EVE_AUTH_PUBLIC_KEY="$auth_public_key" \
    EVE_INTERNAL_API_KEY="$internal_api_key" \
    EVE_SECRETS_MASTER_KEY="$secrets_master_key" \
    EVE_BOOTSTRAP_TOKEN="$bootstrap_token" \
    EVE_GITHUB_WEBHOOK_SECRET="${EVE_GITHUB_WEBHOOK_SECRET:-}" \
    EVE_GATEWAY_PROJECT_ID="${EVE_GATEWAY_PROJECT_ID:-}" \
    node <<'EOF'
const keys = [
  'SUPABASE_JWT_SECRET',
  'EVE_AUTH_ADMIN_PASSWORD',
  'EVE_AUTH_PRIVATE_KEY',
  'EVE_AUTH_PUBLIC_KEY',
  'SUPABASE_AUTH_DATABASE_URL',
  'SUPABASE_AUTH_SERVICE_KEY',
  'SUPABASE_ANON_KEY',
  'EVE_INTERNAL_API_KEY',
  'EVE_SECRETS_MASTER_KEY',
  'EVE_BOOTSTRAP_TOKEN',
  'EVE_GITHUB_WEBHOOK_SECRET',
  'EVE_GATEWAY_PROJECT_ID',
];

const stringData = {};
for (const key of keys) {
  const value = process.env[key];
  if (value !== undefined && value !== '') {
    stringData[key] = value;
  }
}
process.stdout.write(JSON.stringify({ stringData }));
EOF
  )"

  # Patch the K8s secret with auth + platform keys.
  kubectl_mutate_local -n eve patch secret eve-app --type merge -p "$patch_json"

  generate_minio_secrets

  echo "Auth secrets applied to eve-app secret."
}

# Generate MinIO credentials and patch the minio-credentials K8s secret.
# Idempotent: reads from system-secrets.env.local first, then existing K8s values,
# then generates random values if still unset.
generate_minio_secrets() {
  echo "Generating MinIO credentials..."

  # EVE_STORAGE_ACCESS_KEY / EVE_STORAGE_SECRET_KEY may already be sourced from
  # system-secrets.env.local (loaded by generate_auth_secrets before this call).
  local access_key="${EVE_STORAGE_ACCESS_KEY:-}"
  local secret_key="${EVE_STORAGE_SECRET_KEY:-}"

  local access_key_source="system-secrets.env.local"
  local secret_key_source="system-secrets.env.local"

  # Fall back to existing K8s secret values
  if [[ -z "$access_key" ]]; then
    access_key=$(eh_kubectl_local -n eve get secret minio-credentials -o jsonpath='{.data.access-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    access_key_source="existing k8s secret"
  fi
  if [[ -z "$secret_key" ]]; then
    secret_key=$(eh_kubectl_local -n eve get secret minio-credentials -o jsonpath='{.data.secret-key}' 2>/dev/null | base64 -d 2>/dev/null || true)
    secret_key_source="existing k8s secret"
  fi

  # Generate random values if still unset
  if [[ -z "$access_key" ]]; then
    access_key=$(openssl rand -hex 10)  # 20 hex chars
    access_key_source="generated"
  fi
  if [[ -z "$secret_key" ]]; then
    secret_key=$(openssl rand -hex 20)  # 40 hex chars
    secret_key_source="generated"
  fi

  if [[ "$access_key_source" == "generated" ]]; then
    echo -e "  minio access-key:          ${GREEN}generated${NC}"
  elif [[ "$access_key_source" == "existing k8s secret" ]]; then
    echo -e "  minio access-key:          ${YELLOW}exists (kept)${NC}"
  else
    echo -e "  minio access-key:          ${GREEN}loaded from ${access_key_source}${NC}"
  fi

  if [[ "$secret_key_source" == "generated" ]]; then
    echo -e "  minio secret-key:          ${GREEN}generated${NC}"
  elif [[ "$secret_key_source" == "existing k8s secret" ]]; then
    echo -e "  minio secret-key:          ${YELLOW}exists (kept)${NC}"
  else
    echo -e "  minio secret-key:          ${GREEN}loaded from ${secret_key_source}${NC}"
  fi

  local minio_patch_json
  minio_patch_json="{\"stringData\":{\"access-key\":$(printf '%s' "$access_key" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(d)))'),\"secret-key\":$(printf '%s' "$secret_key" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(d)))')}}"

  # Create the secret if it doesn't exist, then patch it
  if ! eh_kubectl_local -n eve get secret minio-credentials >/dev/null 2>&1; then
    echo "  minio-credentials secret not found — creating..."
    kubectl_mutate_local -n eve create secret generic minio-credentials \
      --from-literal=access-key="$access_key" \
      --from-literal=secret-key="$secret_key"
  else
    kubectl_mutate_local -n eve patch secret minio-credentials --type merge -p "$minio_patch_json"
  fi

  echo "MinIO credentials applied to minio-credentials secret."
}

# Run the auth DB bootstrap job (create eve_auth_admin role in Postgres).
run_auth_bootstrap() {
  local bootstrap_timeout="${EVE_K8S_BOOTSTRAP_TIMEOUT:-120s}"

  echo "Running auth DB bootstrap..."
  kubectl_mutate_local -n eve delete job/auth-db-bootstrap --ignore-not-found
  kubectl_mutate_local apply -f "$REPO_ROOT/k8s/base/auth-bootstrap-job.yaml"

  if ! eh_kubectl_local -n eve wait --for=condition=complete job/auth-db-bootstrap --timeout="$bootstrap_timeout"; then
    eh_kubectl_local -n eve logs job/auth-db-bootstrap || true
    echo "Auth DB bootstrap failed"
    exit 1
  fi
  echo "Auth DB bootstrap complete."
}

configure_registry_mirror() {
  # k3s/containerd on k3d nodes can't resolve cluster DNS names for image pulls.
  # We write a k3s registries.yaml that maps the cluster-internal registry name
  # to its ClusterIP so containerd can pull app images built by BuildKit.
  local registry_ip
  registry_ip=$(eh_kubectl_local -n eve get svc eve-registry -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)

  if [[ -z "$registry_ip" ]]; then
    echo -e "  ${YELLOW}Registry service not found, skipping mirror config${NC}"
    return 0
  fi

  local registry_host="eve-registry.eve.svc.cluster.local:5000"
  local desired_config="mirrors:
  \"${registry_host}\":
    endpoint:
      - \"http://${registry_ip}:5000\"
configs:
  \"${registry_host}\":
    tls:
      insecure_skip_verify: true"

  # Check if config already matches (avoid unnecessary k3s restart)
  local current_config
  current_config=$(docker exec k3d-${K3D_CLUSTER}-server-0 cat /etc/rancher/k3s/registries.yaml 2>/dev/null || true)

  if [[ "$current_config" == "$desired_config" ]]; then
    echo -e "  Registry mirror: ${GREEN}already configured (${registry_ip})${NC}"
    return 0
  fi

  echo "  Writing containerd registry mirror → ${registry_ip}:5000 ..."
  echo "${desired_config}" | docker exec -i "k3d-${K3D_CLUSTER}-server-0" tee /etc/rancher/k3s/registries.yaml > /dev/null

  # k3s reads registries.yaml at startup — restart the node to pick it up.
  # This is a one-time cost; subsequent deploys skip if the ClusterIP hasn't changed.
  echo "  Restarting k3d node to apply registry mirror..."
  docker restart "k3d-${K3D_CLUSTER}-server-0" >/dev/null 2>&1
  sleep 3
  # The load balancer also needs a restart after the server node restarts
  docker restart "k3d-${K3D_CLUSTER}-serverlb" >/dev/null 2>&1
  sleep 2

  local max_wait=90
  local waited=0
  while ! eh_kubectl_local get nodes >/dev/null 2>&1 && [[ $waited -lt $max_wait ]]; do
    sleep 3
    ((waited+=3))
  done

  if [[ $waited -ge $max_wait ]]; then
    echo -e "  ${RED}k3s restart timed out after ${max_wait}s${NC}"
    return 1
  fi

  echo -e "  Registry mirror: ${GREEN}configured (${registry_ip}), k3s restarted in ~$((waited+5))s${NC}"
}

read_manager_marker() {
  eh_kubectl_local get namespace eve -o jsonpath='{.metadata.annotations.eve-managed-by}' 2>/dev/null || true
}

write_manager_marker() {
  eh_kubectl_local annotate namespace eve eve-managed-by=bin-eh --overwrite 2>/dev/null || true
}

check_manager_guard() {
  local marker
  marker=$(read_manager_marker)
  if [[ -n "$marker" && "$marker" != "bin-eh" ]]; then
    echo -e "${RED}ERROR: This local stack is managed by 'eve local up' (marker: ${marker}).${NC}"
    echo ""
    echo "'./bin/eh k8s deploy' builds from source; mixing with 'eve local up' causes image conflicts."
    echo ""
    echo "To switch to repo scripts: eve local reset --force"
    echo "To continue with CLI: eve local up"
    exit 1
  fi
}

run_deploy() {
  local migrate_timeout="${EVE_K8S_MIGRATE_TIMEOUT:-180s}"

  ensure_k3d_cluster
  ensure_cluster_connectivity
  check_manager_guard

  echo "Building and importing images..."
  "$SCRIPT_DIR/k8s-image.sh" push-postgres
  "$SCRIPT_DIR/k8s-image.sh" push

  echo "Applying k8s manifests..."
  kubectl_mutate_local apply -k "$LOCAL_OVERLAY"

  echo "Applying eve-tunnels namespace + RBAC (private endpoints)..."
  kubectl_mutate_local apply -k "$REPO_ROOT/k8s/base/tunnels"

  write_manager_marker

  echo "Configuring registry mirror for containerd..."
  configure_registry_mirror

  echo "Waiting for Postgres to be ready..."
  eh_kubectl_local -n eve rollout status statefulset/postgres --timeout=180s

  echo "Running database migrations..."
  kubectl_mutate_local -n eve delete job/eve-db-migrate --ignore-not-found
  kubectl_mutate_local apply -f "$REPO_ROOT/k8s/base/db-migrate-job.yaml"

  if ! eh_kubectl_local -n eve wait --for=condition=complete job/eve-db-migrate --timeout="$migrate_timeout"; then
    eh_kubectl_local -n eve logs job/eve-db-migrate || true
    echo "Database migration failed"
    exit 1
  fi

  # --- Auth infrastructure ---
  generate_auth_secrets
  run_auth_bootstrap

  echo "Restarting deployments..."
  kubectl_mutate_local -n eve rollout restart deployment/eve-api deployment/eve-orchestrator deployment/eve-worker deployment/eve-gateway deployment/eve-dashboard deployment/eve-sso
  kubectl_mutate_local -n eve rollout restart statefulset/eve-agent-runtime
  if eh_kubectl_local -n eve get statefulset/eve-minio >/dev/null 2>&1; then
    kubectl_mutate_local -n eve rollout restart statefulset/eve-minio
    echo "  MinIO (statefulset): restarted"
  fi

  echo "Restarting auth services..."
  kubectl_mutate_local -n eve rollout restart deployment/supabase-auth deployment/mailpit

  echo "Waiting for deployments to be ready..."
  eh_kubectl_local -n eve rollout status deployment/eve-api --timeout=120s
  eh_kubectl_local -n eve rollout status deployment/eve-orchestrator --timeout=120s
  eh_kubectl_local -n eve rollout status deployment/eve-worker --timeout=120s
  eh_kubectl_local -n eve rollout status deployment/eve-dashboard --timeout=120s
  eh_kubectl_local -n eve rollout status deployment/eve-sso --timeout=120s
  eh_kubectl_local -n eve rollout status statefulset/eve-agent-runtime --timeout=180s
  if eh_kubectl_local -n eve get statefulset/eve-minio >/dev/null 2>&1; then
    eh_kubectl_local -n eve rollout status statefulset/eve-minio --timeout=180s
  fi
  eh_kubectl_local -n eve rollout status deployment/mailpit --timeout=60s
  eh_kubectl_local -n eve rollout status deployment/supabase-auth --timeout=120s

  echo ""
  echo "Deploy complete. Access via Ingress:"
  echo "  API:          http://api.eve.lvh.me"
  echo "  Supabase Auth:http://auth.eve.lvh.me"
  echo "  Mailpit:      http://mail.eve.lvh.me"
  echo ""
  echo "  export EVE_API_URL=http://api.eve.lvh.me"
  echo ""
}

COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
  show_help
  exit 1
fi
shift

require_bin kubectl

case "$COMMAND" in
  start)
    check_k8s_ownership || exit 1
    tcp_ports=""
    recreate="false"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --tcp-ports)
          if [[ $# -lt 2 || "$2" == --* ]]; then
            echo "--tcp-ports requires a comma-separated port list" >&2
            exit 1
          fi
          tcp_ports="$(parse_tcp_ports "$2")"
          shift 2
          ;;
        --recreate)
          recreate="true"
          shift
          ;;
        *)
          echo "Unknown start option: $1" >&2
          show_help
          exit 1
          ;;
      esac
    done
    ensure_k3d_cluster "$tcp_ports" "$recreate"
    ensure_cluster_connectivity
    eh_assert_k3d_context_or_die
    "$SCRIPT_DIR/k8s-image.sh" push-postgres
    kubectl_mutate_local apply -k "$LOCAL_OVERLAY"
    ;;
  deploy)
    check_k8s_ownership || exit 1
    eh_assert_k3d_context_or_die
    run_deploy
    ;;
  secrets)
    check_k8s_ownership || exit 1
    require_k3d_context
    ensure_cluster_connectivity
    eh_assert_k3d_context_or_die
    generate_auth_secrets
    run_auth_bootstrap
    echo "Restarting services to pick up updated secrets..."
    kubectl_mutate_local -n eve rollout restart deployment/eve-api deployment/eve-orchestrator deployment/eve-worker deployment/eve-gateway deployment/eve-dashboard deployment/eve-sso deployment/supabase-auth deployment/mailpit
    kubectl_mutate_local -n eve rollout restart statefulset/eve-agent-runtime
    # Restart MinIO pod to pick up updated credentials
    if eh_kubectl_local -n eve get statefulset/eve-minio >/dev/null 2>&1; then
      kubectl_mutate_local -n eve rollout restart statefulset/eve-minio
      echo "  MinIO (statefulset): restarted"
    elif eh_kubectl_local -n eve get deployment/eve-minio >/dev/null 2>&1; then
      kubectl_mutate_local -n eve rollout restart deployment/eve-minio
      echo "  MinIO (deployment): restarted"
    else
      echo "  MinIO pod not found — skipping restart"
    fi
    echo "Waiting for core services to be ready..."
    eh_kubectl_local -n eve rollout status deployment/eve-api --timeout=120s
    eh_kubectl_local -n eve rollout status deployment/eve-orchestrator --timeout=120s
    eh_kubectl_local -n eve rollout status deployment/eve-worker --timeout=120s
    eh_kubectl_local -n eve rollout status deployment/eve-dashboard --timeout=120s
    eh_kubectl_local -n eve rollout status deployment/eve-sso --timeout=120s
    eh_kubectl_local -n eve rollout status statefulset/eve-agent-runtime --timeout=180s
    ;;
  stop)
    check_k8s_ownership || exit 1
    require_k3d_context
    eh_assert_k3d_context_or_die
    kubectl_mutate_local delete -k "$LOCAL_OVERLAY" || true
    ;;
  status)
    # Status is read-only, no ownership check needed
    require_k3d_context
    eh_kubectl_local get all -n eve || true
    eh_kubectl_local get pvc -n eve || true
    ;;
  *)
    show_help
    exit 1
    ;;
esac
