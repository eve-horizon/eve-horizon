# Private Endpoints: Tailscale-Connected Services in Eve

> Status: Implemented (2026-03-09, commits 30da1c4, 69bd39d)
> Created: 2026-03-09
> Related: [inference-simplification-plan.md](./inference-simplification-plan.md), [deployment.md](../system/deployment.md)

## Summary

Eve apps, agent runtime pods, and worker pods all run inside a K8s cluster. Some services — like an LM Studio instance on a Mac Mini — are only reachable via Tailscale. Today there is no built-in way for those cluster workloads to reach them.

This plan introduces **private endpoints**: a platform-level networking primitive that makes Tailscale-only services accessible to all pod types in the cluster. Combined with Eve's existing BYOK secrets model, apps and agents connect to private services using standard environment variables — no custom code, no sidecars, and no per-pod Tailscale configuration.

---

## The Problem

```
┌─────────────────────────────────────────┐
│  K8s Cluster                            │
│                                         │
│  Eve App Pod  ──╳──►  ???               │
│  Agent Pod    ──╳──►  Can't reach       │
│  Worker Pod   ──╳──►  Tailscale IPs     │
│                                         │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Mac Mini (Tailscale only)              │
│  LM Studio :1234                        │
│  /v1/chat/completions                   │
│  /v1/models                             │
└─────────────────────────────────────────┘
```

The Mac Mini has no public IP. It exists only on the Tailscale network (100.x.x.x). K8s pods have no Tailscale connectivity — they can't route to those IPs.

This isn't specific to LM Studio. Any service on a private network (home lab GPU, internal API, dev machine) has the same problem.

---

## Design

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  K8s Cluster                                                │
│                                                             │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │ Eve App  │   │ Agent Runtime │   │ Worker (runner pod)│  │
│  └────┬─────┘   └──────┬───────┘   └────────┬───────────┘  │
│       │                │                     │              │
│       │  env: LLM_BASE_URL=http://myorg-lmstudio.eve-tunnels:1234/v1
│       │                │                     │              │
│       ▼                ▼                     ▼              │
│  ┌──────────────────────────────────────────────┐           │
│  │  K8s Service: myorg-lmstudio                 │           │
│  │  Namespace: eve-tunnels                      │           │
│  │  type: ExternalName + TS operator annotation │           │
│  └──────────────────┬───────────────────────────┘           │
│                     │                                       │
│  ┌──────────────────▼───────────────────┐                   │
│  │  Tailscale Operator Egress Proxy     │                   │
│  │  Routes to tailnet via WireGuard     │                   │
│  └──────────────────┬───────────────────┘                   │
└─────────────────────┼───────────────────────────────────────┘
                      │ WireGuard (encrypted)
                      ▼
┌─────────────────────────────────┐
│  Mac Mini (100.x.x.x)          │
│  LM Studio :1234               │
└─────────────────────────────────┘
```

### Three Layers

**Layer 1 — Infrastructure: Tailscale K8s Operator (one-time setup)**

The [Tailscale Kubernetes Operator](https://tailscale.com/docs/features/kubernetes-operator) runs in the cluster and manages egress proxies. It is deployed once per cluster — local k3d, staging, and production each get their own operator installation with separate Tailscale auth and credentials.

The operator watches for annotated `ExternalName` services and creates WireGuard routes automatically.

**Layer 2 — Platform: Eve manages the K8s Service**

Eve creates and manages the ExternalName Service that bridges the cluster to the tailnet device. This is the new platform primitive.

**Layer 3 — User: Standard BYOK secrets**

Apps and agents use the in-cluster service URL via standard env vars. This fits perfectly with the [BYOK model](./inference-simplification-plan.md) — Eve provides connectivity, users configure their apps with secrets.

---

## Implementation

### Phase 0: Tailscale Operator Setup (Infrastructure)

One-time setup per cluster. Not Eve-specific — pure K8s infrastructure.

**For local k3d:**

```bash
# Install Tailscale operator via Helm
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm repo update

# Create OAuth credentials (from Tailscale admin console)
kubectl create namespace eve-tunnels
kubectl -n eve-tunnels create secret generic tailscale-operator \
  --from-literal=client_id=<OAUTH_CLIENT_ID> \
  --from-literal=client_secret=<OAUTH_CLIENT_SECRET>

helm install tailscale-operator tailscale/tailscale-operator \
  -n eve-tunnels \
  --set operatorConfig.hostname=eve-k3d-operator \
  --set apiServerProxyConfig.mode=noauth  # dev-only; staging/prod must use proper auth
```

**For staging/production:**

Same approach, deployed via kustomize overlay in `deployment-instance-repo`. The Tailscale OAuth credentials are provisioned per-environment. Use ProxyGroup (Tailscale 1.76+) for redundant egress with multiple proxy replicas — see [Tailscale docs](https://tailscale.com/kb/1438/kubernetes-operator-cluster-egress).

**Eve API RBAC:** The Eve API service account needs RBAC to create/delete/list Services in the `eve-tunnels` namespace. Add a Role + RoleBinding in the k3d overlay and kustomize overlays.

**Shortcut for local k3d (no operator):** If the host Mac is already on Tailscale, k3d containers can typically route to `100.x.x.x` addresses (k3d uses Docker bridge networking, which inherits host routes). In this case you can skip the operator and use the Tailscale IP directly in secrets — but `eve endpoint add` won't work (it needs the operator to route ExternalName services). Use raw `eve secrets set` to point at the Tailscale IP instead. Validate connectivity with `kubectl run curl --image=curlimages/curl --rm -it -- curl http://100.x.x.x:1234/v1/models` before relying on this pattern.

### Phase 1: Eve Private Endpoint Primitive (~2 days)

New CLI command and API endpoint for registering private endpoints.

#### Validation and permissions

1. Endpoints are org-scoped. Caller must have write permission on the org.
2. Names must be DNS-safe (`[a-z0-9]([a-z0-9-]*[a-z0-9])?`, max 53 chars).
3. Names are unique per org. Repeated registrations for the same name+org return the existing record.
4. K8s Service names are prefixed with the org slug to prevent cross-org collisions in the shared `eve-tunnels` namespace: `{orgSlug}-{name}` (e.g., `myorg-lmstudio`).
5. The Tailscale operator must be installed in the cluster. `eve endpoint add` checks for the operator and fails fast with guidance if not found.

#### CLI

```bash
# Register a private endpoint backed by a Tailscale device
eve endpoint add \
  --name lmstudio \
  --provider tailscale \
  --tailscale-hostname mac-mini.tail12345.ts.net \
  --port 1234 \
  --org org_xxx

# List registered endpoints
eve endpoint list --org org_xxx

# Show endpoint details + connectivity status
eve endpoint show lmstudio --org org_xxx

# Remove an endpoint
eve endpoint remove lmstudio --org org_xxx
```

#### What happens on `eve endpoint add`

1. **API stores the endpoint** in the `private_endpoints` table (see [Database Schema](#database-schema) below).

2. **API verifies the Tailscale operator** is installed (checks for the operator Deployment in `eve-tunnels`). Fails fast with `"Tailscale operator not installed. Run Phase 0 setup first."` if missing.

3. **API creates the K8s ExternalName Service** in the `eve-tunnels` namespace:

   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: myorg-lmstudio                     # {orgSlug}-{name}
     namespace: eve-tunnels
     labels:
       eve.io/endpoint: "true"
       eve.io/org-id: org_xxx
       eve.io/endpoint-name: lmstudio
     annotations:
       tailscale.com/tailnet-fqdn: "mac-mini.tail12345.ts.net"
       eve.io/private-endpoint: "true"
   spec:
     type: ExternalName
     externalName: placeholder                # operator overwrites with proxy service DNS
   ```

   Note: The `externalName: placeholder` is intentional — the Tailscale operator detects the `tailscale.com/tailnet-fqdn` annotation, creates an egress proxy pod, and overwrites `externalName` to point at the proxy's ClusterIP Service. The original Service becomes a CNAME chain: `myorg-lmstudio.eve-tunnels` → proxy service → WireGuard tunnel → tailnet device.

4. **API records the in-cluster DNS name**: `myorg-lmstudio.eve-tunnels.svc.cluster.local`

5. **Status probe** — After creating the Service, the API waits up to 30s for the operator to create the proxy, then runs a TCP probe against the endpoint. On success: status → `ready`. On timeout or failure: status → `error` with diagnostic guidance in `status_msg`. This is a one-shot probe during creation; ongoing health checks are in Phase 3.

#### In-cluster URL pattern

Every private endpoint gets a stable, predictable DNS name:

```
http://<orgSlug>-<name>.eve-tunnels.svc.cluster.local:<port>
```

Example: `http://myorg-lmstudio.eve-tunnels.svc.cluster.local:1234`

This URL works from any pod in the cluster — apps, agent runtime, workers, runners — without per-pod configuration. The `eve endpoint add` command prints this URL on success so users can copy it directly into their secrets.

### Phase 2: Secrets Integration (~0.5 days)

Users wire the endpoint into their apps/agents via secrets. This is standard BYOK — Eve just provides a convenient way to reference the endpoint URL.

```bash
# Set the base URL pointing to the private endpoint (URL printed by `eve endpoint add`)
eve secrets set LLM_BASE_URL \
  "http://myorg-lmstudio.eve-tunnels.svc.cluster.local:1234/v1" \
  --scope project

# Set any auth keys the service requires
eve secrets set LLM_API_KEY "lm-studio-xxx" --scope project
```

In the app's manifest:

```yaml
x-eve:
  services:
    my-app:
      env:
        LLM_BASE_URL: "${secrets.LLM_BASE_URL}"
        LLM_API_KEY: "${secrets.LLM_API_KEY}"
```

In an agent's harness profile:

```yaml
profiles:
  my-agent:
    harness: claude
    model: sonnet-4.6
    env:
      LOCAL_LLM_URL: "${secrets.LLM_BASE_URL}"
      LOCAL_LLM_KEY: "${secrets.LLM_API_KEY}"
```

### Phase 3: Health + Diagnostics (~1 day)

Private endpoints should report connectivity status so users can debug.

#### Health probing

Simple HTTP probe on the endpoint URL. Not the heavy background service from the old inference system — a lightweight, on-demand check:

```bash
eve endpoint show lmstudio --verbose
```

```
Name:        lmstudio
Org:         manualtestorg (org_manualtestorg)
Provider:    tailscale
Hostname:    mac-mini.tail12345.ts.net
Port:        1234
Status:      ready
Cluster DNS: manualtestorg-lmstudio.eve-tunnels.svc.cluster.local:1234

Health Check:
  Last checked: 12s ago
  HTTP GET /v1/models → 200 OK (43ms)
  Models available: qwen3-32b, llama-3.1-70b
```

#### Diagnostics

```bash
eve endpoint diagnose lmstudio
```

Checks:
1. Tailscale operator is running in the cluster
2. K8s Service `{orgSlug}-{name}` exists in `eve-tunnels` namespace
3. Operator has created the egress proxy (externalName no longer `placeholder`)
4. DNS resolution for `{orgSlug}-{name}.eve-tunnels.svc.cluster.local`
5. TCP connectivity to the endpoint port
6. HTTP health check (configurable path via `health_path`, defaults to `/v1/models`)
7. Tailnet device reachability (distinguishes "device offline" from "operator misconfigured")

#### Lifecycle cleanup

Delete is explicit:

```bash
eve endpoint remove lmstudio --org org_xxx
```

`eve endpoint remove` deletes the database row and the K8s Service. The Tailscale operator detects the Service deletion and automatically cleans up any related proxy pods and StatefulSets.

---

## How Each Consumer Uses It

### Eve Apps (deployed pods)

Standard env vars via manifest interpolation:

```typescript
// App code — uses standard OpenAI SDK
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL,   // http://myorg-lmstudio.eve-tunnels.svc.cluster.local:1234/v1
  apiKey: process.env.LLM_API_KEY,
});

const response = await client.chat.completions.create({
  model: 'qwen3-32b',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### Agent Runtime (warm pods)

Agents in the same cluster can reach the endpoint directly. If an agent needs to call a local model, its system prompt or tools can use the endpoint URL from env vars:

```yaml
# x-eve.yaml agent profile — use secret interpolation, not hardcoded URLs
profiles:
  researcher:
    harness: claude
    model: sonnet-4.6
    env:
      PRIVATE_LLM_URL: "${secrets.LLM_BASE_URL}"
```

The agent calls the private LLM as a tool or sub-request. Claude/Sonnet remains the primary harness — the private model is an additional resource.

### Worker Nodes (runner pods)

Runner pods are in the same cluster. Job workspace env vars are resolved from secrets:

Secrets set at the org/project level are automatically available to all jobs in that scope — no per-job `--env` flags needed. This is the recommended pattern.

```bash
# Secrets already set (from Phase 2), so just create the job:
eve job create --harness code --prompt "Use the local LLM at $LLM_BASE_URL"
```

---

## K8s Namespace Design

**Namespace: `eve-tunnels`**

All private endpoint services live in a dedicated namespace:

- Clean separation from `eve` (platform services) and app namespaces
- Single RBAC policy for the Tailscale operator
- Easy to audit: `kubectl -n eve-tunnels get svc` shows all tunnel services
- Cross-namespace DNS works natively: `<name>.eve-tunnels.svc.cluster.local`

---

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| Tailscale auth key leakage | OAuth credentials stored as K8s Secret, operator-managed |
| Unauthorized endpoint registration | Org-scoped, requires write permission on the org |
| Network exposure | Egress only — tailnet services can't initiate connections into the cluster |
| Endpoint spoofing | Tailscale MagicDNS names are verified by the tailnet |
| Credential rotation | Tailscale OAuth keys auto-rotate; Eve secrets rotation is independent |
| K8s Service name collision | Org-slug prefix (`{orgSlug}-{name}`) prevents cross-org collisions in shared namespace |
| K8s RBAC scope | Eve API service account gets a namespaced Role in `eve-tunnels` only (create/delete/list Services) |
| Target device offline | Endpoint status degrades to `error`; `eve endpoint diagnose` distinguishes offline device from misconfiguration |

---

## Scope & Constraints

### What this plan covers

- Tailscale as the first (and initially only) tunnel provider
- ExternalName Service creation and lifecycle management
- CLI commands for endpoint CRUD
- Health checking and diagnostics
- Documentation and k3d overlay

### What this plan does NOT cover

- **Automatic model discovery** — Users configure models manually via secrets. Eve doesn't inspect what's running behind the endpoint.
- **Inference routing or proxy** — Per the [inference simplification plan](./inference-simplification-plan.md), Eve doesn't proxy inference traffic. Private endpoints provide connectivity; BYOK provides configuration.
- **Ingress tunnels** — This is egress-only (cluster → tailnet). Exposing cluster services to the tailnet is a separate concern.
- **Non-Tailscale tunnels** — WireGuard, Cloudflare Tunnel, etc. could be added later with the same `eve endpoint add --provider <x>` pattern, but aren't in scope.

---

## Database Schema

One table. Org-scoped.

```sql
CREATE TABLE private_endpoints (
  id            TEXT PRIMARY KEY,          -- ep_xxx (TypeID)
  name          TEXT NOT NULL,             -- user-friendly name (DNS-safe)
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  provider      TEXT NOT NULL DEFAULT 'tailscale',
  hostname      TEXT NOT NULL,             -- tailnet MagicDNS FQDN
  port          INTEGER NOT NULL,
  protocol      TEXT NOT NULL DEFAULT 'TCP',
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'ready' | 'error'
  status_msg    TEXT,                      -- diagnostic detail for pending/error states
  k8s_svc_name  TEXT NOT NULL,             -- K8s Service name: {orgSlug}-{name}
  k8s_namespace TEXT NOT NULL DEFAULT 'eve-tunnels',
  k8s_dns       TEXT,                      -- full DNS: {orgSlug}-{name}.eve-tunnels.svc.cluster.local
  health_path   TEXT DEFAULT '/v1/models', -- HTTP health check path (nullable to skip)
  metadata      JSONB,                     -- provider-specific config (future use)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, org_id)
);
```

Notes:
- `k8s_svc_name` is derived (`{orgSlug}-{name}`) and stored for fast lookups and cleanup.
- `health_path` defaults to `/v1/models` (OpenAI-compatible). Set to `NULL` for non-HTTP endpoints.
- No `scope_kind`/`scope_id` — endpoints are always org-scoped. Project-level access control uses standard Eve RBAC on the endpoint resource, not a separate scope column.

---

## Effort Estimate

| Phase | Work | Time |
|-------|------|------|
| 0. Tailscale operator setup (k3d) | Helm install, OAuth setup, RBAC, verify | 0.5 day |
| 1. Private endpoint primitive | DB migration, API endpoints, CLI commands, K8s service creation, operator prereq check | 2 days |
| 2. Secrets integration | Docs, examples, manifest patterns | 0.5 day |
| 3. Health + diagnostics | Probe, diagnose command, status transitions | 1 day |
| **Total** | | **4 days** |

For staging/production, add the operator install + ProxyGroup config to `deployment-instance-repo` kustomize overlays (separate from this plan, ~0.5 day).

---

## Alternatives Considered

### 1. Sidecar per pod

Run `ghcr.io/tailscale/tailscale` as a sidecar in every pod that needs access.

**Rejected**: Massive overhead. Every app pod, agent pod, and runner pod gets a sidecar. Each becomes a separate Tailscale device. Doesn't scale, wastes resources, requires `NET_ADMIN` capability everywhere.

### 2. Tailscale on the K8s node

Install Tailscale directly on the node (or Docker host for k3d).

**Partial fit**: Works for local k3d (the host Mac is already on the tailnet). Doesn't work for staging/production where nodes are EC2 instances managed by Terraform. Noted as a k3d shortcut in Phase 0.

### 3. HTTP proxy / SOCKS proxy

Run a single Tailscale pod as an HTTP proxy, configure `HTTP_PROXY` in all pods.

**Rejected**: Invasive. Requires all apps to respect proxy env vars. Breaks WebSocket connections. Adds latency and a single point of failure. The Tailscale operator's ExternalName approach is cleaner.

### 4. VPN mesh (full cluster on tailnet)

Join the entire cluster to the tailnet via subnet router.

**Rejected**: Overkill. Exposes the entire cluster network to the tailnet. Security and routing complexity far exceeds the requirement. We only need egress to specific endpoints, not bidirectional mesh.

### 5. No platform primitive — just document the manual K8s setup

Tell users to create their own ExternalName Services and secrets.

**Considered**: Viable for a single endpoint. But doesn't scale to multiple endpoints, provides no discoverability, no health checking, and no cleanup on removal. The platform primitive earns its keep by managing the full lifecycle.

---

## Future Extensions

- **Additional providers**: Cloudflare Tunnel, WireGuard, Ngrok — same `eve endpoint add --provider <x>` pattern
- **ProxyGroup HA**: Use Tailscale ProxyGroup (1.76+) for redundant multi-replica egress in production
- **Endpoint groups**: Tag endpoints and reference them in access policies
- **Auto-discovery**: Probe endpoint for capabilities (OpenAI-compat models, embeddings, etc.) and suggest secret values
- **Manifest declaration**: Define endpoints in `.eve/manifest.yaml` alongside services
- **Cost attribution**: Track traffic through private endpoints per org/project
- **Endpoint quotas**: Limit endpoints per org to prevent resource exhaustion in shared clusters
