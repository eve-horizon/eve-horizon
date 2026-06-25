# Public L4 TCP Ingress Plan (device-facing services)

> **Status**: Draft
> **Last Updated**: 2026-05-14
> **Beads**: [`eve-horizon-gn5m`](../../.beads/issues.jsonl)
> **Origin**: eve-platform-spec **001 — Public L4 TCP ingress for device-facing services** (opened 2026-05-13). The PVS rebuild's `device-edge` service maintains long-lived raw-TCP sessions from vehicle trackers (A1 GT06 / Mictrack MT700 / VG42-TQ / BD Starlink on ports `33400`, `33500`, `33033`, `33334`). These protocols are vendor-defined binary framings; they will not become HTTP. Today an Eve service that opens TCP ports gets only a `ClusterIP` Service and no public reachability path, forcing every PVS deploy to be paired with an out-of-cluster NLB → ECS forwarder. This plan keeps `device-edge` inside the Eve app boundary.
> **Adjacent plans (related but different problems)**:
> - [`app-stable-egress-v2-plan.md`](./app-stable-egress-v2-plan.md) — _outbound_ source-port preservation via `hostNetwork: true` + public-subnet node group. **Not** an inbound primitive.
> - [`private-endpoints-tailscale-plan.md`](./private-endpoints-tailscale-plan.md) — cluster pods → external Tailscale services. Wrong direction.

## Why

`x-eve.ingress` is HTTP-only: it emits a K8s `Ingress` resource and wires cert-manager TLS (`apps/worker/src/deployer/deployer.service.ts:1170-1358`). A service that declares raw TCP ports gets a `ClusterIP` Service (`apps/worker/src/deployer/deployer.service.ts:1139-1162`) and nothing else — there is no platform path from the public Internet to that Service.

The Eve-native PVS rebuild treats `device-edge` as a first-class service. Without a platform-level public L4 ingress primitive, every Eve deployment of PVS has to be paired with an out-of-cluster forwarder (NLB → ECS, or a VM-hosted TCP proxy) in the same account, breaking the "Eve is the platform" property the rebuild is built around. This is the single largest "Eve has no answer yet" item in the PVS rebuild surface; everything else can be built on shipped primitives.

The verified building blocks already exist:

- The HTTP ingress generator in `apps/worker/src/deployer/deployer.service.ts:1170-1358` is ~150 LOC of YAML construction. A TCP variant is mechanically the same shape — a different K8s resource (`Service: type: LoadBalancer` with NLB annotations) instead of `Ingress`.
- `../deployment-instance/terraform/aws/modules/eks/main.tf:106-124` already opens the TCP NodePort range `30000-32767` from `0.0.0.0/0` and allows VPC-CIDR health checks. The SG plumbing for NLB → NodePort is in place.
- The only missing infrastructure piece is the **AWS Load Balancer Controller** (Helm + IRSA); standard install.

Realistic effort estimate (verified 2026-05-14 against the codebase):

| Piece | Where | Effort |
|---|---|---|
| Manifest schema field | `packages/shared/src/schemas/manifest.ts` | ~10 LOC |
| Deployer renders `Service: type: LoadBalancer` with NLB annotations | `apps/worker/src/deployer/deployer.service.ts` | ~80 LOC alongside the existing HTTP block |
| Desired hostname env injection + live NLB hostname surfaced via `eve env diagnose` | deployer + diagnose service | ~30 LOC |
| Tests | `apps/worker/src/deployer/__tests__/deployer-tcp-ingress.spec.ts` | ~100 LOC |
| AWS Load Balancer Controller install (Helm + IRSA) | `../deployment-instance/terraform/aws/` | ~1 day |
| Local k3d eval loop (extra port mappings + klipper-lb) | `bin/eh-commands/k8s.sh`, `tests/manual/scenarios/` | ~0.5 day |

**~150-250 LOC of Eve code + the Helm install. 2-3 days end-to-end.**

## Decision

A new manifest knob, `x-eve.tcp_ingress`, promotes one or more declared ports on a service to publicly reachable L4 TCP listeners. The platform owns:

1. The cloud-provider load balancer (AWS NLB on EKS, klipper-lb on k3d) or equivalent.
2. The K8s `Service` of `type: LoadBalancer` that exposes those listeners.
3. A stable, advertisable hostname for the listener set, injected into the app's env when it is deterministic.
4. Optional source-IP allowlist for hardening, enforced with `spec.loadBalancerSourceRanges` on providers that support it.
5. Source-IP-preserving load-balancer health checks that are compatible with `externalTrafficPolicy: Local`; app readiness remains the normal service `healthcheck`.

**TLS is not** required at the platform layer. Most tracker protocols are plain TCP or vendor-specific binary framings. Apps that need TLS termination handle it in the service.

## Manifest contract

```yaml
services:
  device-edge:
    build:
      context: .
      dockerfile: apps/device-edge/Dockerfile
    ports:
      - "33334"
      - "33400"
      - "33500"
      - "33033"
    x-eve:
      tcp_ingress:                    # new block; sibling of `ingress`
        listeners:
          - name: bd-starlink
            port: 33334
          - name: a1-gt06
            port: 33400
          - name: mictrack-mt700
            port: 33500
          - name: vg42-tq
            port: 33033
          # Teltonika 33340 — operator-confirmed inactive (2026-05-13); add later
          # only when there's a deployment plan.
        allow_cidrs:                  # optional; default 0.0.0.0/0
          - 0.0.0.0/0
        hostname: trackers            # optional cluster-global alias for the LB DNS record
```

Each listener `port` must appear in the service's top-level `ports:` so the container actually listens on it. Listener `name` is a stable identifier used for env injection (`EVE_TCP_LISTENER_<NAME>_PORT`) and for `eve env diagnose` rows; it must match `^[a-z][a-z0-9-]*$`.

`hostname` is a cluster-global alias under `EVE_TCP_INGRESS_HOSTED_ZONE` (defaulting to `EVE_DEFAULT_DOMAIN`). If omitted, the platform advertises a generated service-scoped hostname: `<component>.<orgSlug>-<projectSlug>-<env>.<zone>`. If set, it must be validated like `x-eve.ingress.alias`: same format, same reserved-name rules, and one global claim per alias so two projects cannot both advertise `trackers.<zone>`.

`tcp_ingress` is strict. Unknown keys in the `tcp_ingress` block or listener objects are manifest errors; typos in externally exposed ports should fail before deployment.

There is no per-listener `health` field in Phase 1. AWS health-check annotations are Service-wide, and the source-IP-preserving shape (`externalTrafficPolicy: Local`) must use the kube-proxy health endpoint, not a TCP connect probe against the app port. App-level health stays in the existing service `healthcheck` block, which controls pod readiness and therefore endpoint eligibility.

### Env vars injected (per service)

| Variable | Example | Purpose |
|---|---|---|
| `EVE_TCP_PUBLIC_HOST` | `trackers.eve.example.com` | Single advertised host for all listeners on this service; alias/default hostname, not necessarily the raw NLB DNS name |
| `EVE_TCP_LISTENER_<NAME>_PORT` | `33334` | Public-facing port for each named listener (always equals the container port — NLB does pass-through) |
| `EVE_TCP_LISTENER_<NAME>_HOST` | `trackers.eve.example.com` | Same as `EVE_TCP_PUBLIC_HOST`, repeated per-listener for app code that wants to read listener-keyed values uniformly |

The raw cloud-provider hostname (`*.elb.amazonaws.com` on EKS, klipper status locally) is not known at manifest render time. `eve env diagnose` is the source of truth for the live LoadBalancer hostname/IP after provisioning. Env injection uses only the deterministic advertised hostname.

Apps publish these to firmware out-of-band (vendor portal, OTA config). The platform does not push to firmware — that's a vendor-coordination problem, not a platform one.

### CLI

```bash
eve env diagnose <project> <env>                            # includes tcp_ingress.listeners[].state
eve tcp-ingress test <project> <env> --listener <name>      # TCP connect probe from the operator's machine
```

`eve tcp-ingress test` performs the equivalent of `nc -vz -w 5 <host> <port>` against the listener's resolved `(host, port)` and prints the result. It does not negotiate the device protocol — protocol-correctness is the app's job.

## Resource shape

Per service with `tcp_ingress`, the deployer emits **one** `Service: type: LoadBalancer` alongside the existing per-service `ClusterIP` Service. The ClusterIP Service stays for in-cluster traffic (existing behavior unchanged); the LoadBalancer Service is the public path.

On EKS (provider = `aws-load-balancer-controller`):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: <resourceName>-tcp           # sibling of the existing <resourceName>
  namespace: <env-namespace>
  labels:
    eve.org_id: <orgId>
    eve.project_id: <projectId>
    eve.env: <envName>
    eve.component: <serviceName>
    eve.release: <releaseId>
    eve.tcp_ingress: 'true'
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: external
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: instance
    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol: HTTP
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-path: /healthz
    service.beta.kubernetes.io/aws-load-balancer-attributes: 'load_balancing.cross_zone.enabled=true'
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local       # preserves source IP; health checks hit kube-proxy healthz
  # When allow_cidrs is set. Preferred over the legacy source-ranges annotation.
  loadBalancerSourceRanges:
    - 0.0.0.0/0
  selector:
    eve.env: <envName>
    eve.component: <serviceName>
  ports:
    - name: bd-starlink
      protocol: TCP
      port: 33334
      targetPort: 33334
    - name: a1-gt06
      protocol: TCP
      port: 33400
      targetPort: 33400
    # ... one entry per listener
```

Do **not** use `service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol: TCP` with `externalTrafficPolicy: Local`. AWS Load Balancer Controller documents that TCP health checks should not be used for Local external traffic policy. Kubernetes exposes a node health endpoint for this exact shape; with `externalTrafficPolicy: Local`, kube-proxy returns success only when the node has a local endpoint for the Service. The controller defaults the health-check port to `spec.healthCheckNodePort`, so the plan sets HTTP `/healthz` and leaves the port unset.

On k3d (provider = `klipper`): same Service shape, **no NLB annotations** (k3d's klipper-lb ignores them). klipper-lb binds the listener ports on the k3d node IPs (the docker container hosts), and the cluster-creation port mappings (see "Local k3d eval loop" below) forward each port from the host to the node.

Replica count > 1 is allowed (TCP-only state lives in the app). The platform does no connection draining beyond NLB defaults. Listener ports may overlap across different namespaces on EKS because each opted-in service gets its own NLB. They **cannot** overlap on one local k3d host when the same host port is forwarded; Phase 1 does not validate cross-namespace k3d port collisions, so document the single-owner local-dev constraint.

## Provider model

A new config knob selects the provider, mirroring `EVE_COMPUTE_MODEL`:

```ts
// packages/shared/src/config/schema.ts
EVE_TCP_INGRESS_PROVIDER: z.enum(['none', 'aws-nlb', 'klipper']).default('none'),
EVE_TCP_INGRESS_HOSTED_ZONE: z.string().optional(),
```

- `none` (default): manifest field is parsed but the deployer logs a warning and emits no LoadBalancer Service. Apps that opt in see no behavioural difference; the env is silently unwired. This matches the stable-egress "noop" pattern.
- `aws-nlb`: emit NLB annotations as above. Requires the AWS Load Balancer Controller in the cluster.
- `klipper`: emit the LoadBalancer Service without NLB annotations. Relies on k3d's klipper-lb.

The local k3d overlay sets `EVE_TCP_INGRESS_PROVIDER=klipper`; the EKS overlay in `../deployment-instance` sets it to `aws-nlb`.

## Implementation

### 1. Platform repo (`eve-horizon`)

**`packages/shared/src/schemas/manifest.ts`** — add the schema next to `ServiceNetworkingSchema`:

```ts
export const TcpIngressListenerSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'listener name must be lowercase alphanumeric with hyphens'),
  port: z.number().int().min(1).max(65535),
}).strict();

export const TcpIngressConfigSchema = z.object({
  listeners: z.array(TcpIngressListenerSchema).min(1).max(20),
  allow_cidrs: z.array(z.string()).optional(),   // CIDR validation in resolveTcpIngressConfig
  hostname: z.string().optional(),               // alias subdomain, like ingress.alias
}).strict();

export type TcpIngressConfig = z.infer<typeof TcpIngressConfigSchema>;
```

Add `tcp_ingress: TcpIngressConfigSchema.optional()` to `ServiceXeveSchema`. Add helpers `resolveTcpIngressConfig(service)` and `requiresTcpIngress(service)` matching the `resolveServiceNetworking` / `requiresStableEgress` pattern at the bottom of the file.

If `hostname` remains a cluster-global alias, also add `getManifestTcpIngressAliases(manifest)` and `assertUniqueManifestTcpIngressAliases(...)` helpers mirroring `getManifestIngressAliases`. `apps/api/src/projects/projects.service.ts` must validate reserved aliases and claim/release them at project sync time. Reuse `ingress_aliases` only if the record can distinguish HTTP vs TCP ownership without breaking existing HTTP alias behavior; otherwise add a small `tcp_ingress_aliases` table/query pair with the same uniqueness rules.

**`packages/shared/src/config/schema.ts`** — add `EVE_TCP_INGRESS_PROVIDER` plus an optional `EVE_TCP_INGRESS_HOSTED_ZONE` for hostname suffix. If `EVE_TCP_INGRESS_HOSTED_ZONE` is unset, default to `EVE_DEFAULT_DOMAIN` at resolve time.

**`apps/worker/src/deployer/deployer.service.ts`** — new helpers + emission:

- `planTcpIngressInjection(service, name, provider, context)` returns one of:
  - `null` — not opted in.
  - `{ mode: 'noop', reason }` — `EVE_TCP_INGRESS_PROVIDER=none`. Logged as a warning, no Service emitted.
  - `{ mode: 'aws-nlb' | 'klipper', service: <renderedServiceManifest>, envInjection: Record<string, string> }`.
- In `renderManifest`, compute the TCP ingress plan immediately after `ports` are parsed and validated, **before** `baseEnvEntries` and the Deployment object are built. Merge `envInjection` into the app container env block (`EVE_TCP_PUBLIC_HOST`, `EVE_TCP_LISTENER_<NAME>_PORT`, `EVE_TCP_LISTENER_<NAME>_HOST`) at the same point stable-egress env is merged.
- After the existing per-service ClusterIP Service emission, push the TCP LoadBalancer Service onto `documents` if the plan returned one.
- Return a desired TCP Service name set from `renderManifest` and garbage-collect stale TCP LoadBalancer Services after apply, just like alias/custom-domain ingress cleanup. Without this, removing `x-eve.tcp_ingress` leaves the old NLB Service behind.
- Fail-fast at render time when:
  - A listener `port` is not present in the service's top-level `ports:` list.
  - Two listeners declare the same `port` within one service.
  - A listener `port` falls in `30000-32767` (the Kubernetes NodePort range — same prohibition as stable egress, same reason: the EKS node SG already allows that range from `0.0.0.0/0`, so re-using it for app ports would silently mix tenants).
  - `EVE_TCP_INGRESS_PROVIDER=aws-nlb` and the Kubernetes API is available but there is no `aws-load-balancer-controller` deployment in `kube-system`. Skip this runtime check in render-only/unit-test contexts where the K8s API is unavailable.
  - `allow_cidrs` contains an invalid CIDR.
- The existing ClusterIP Service is unchanged. The new LoadBalancer Service is `<resourceName>-tcp` to avoid name collision.
- Extend `apps/worker/src/deployer/k8s.service.ts` with `listTcpIngressServices(namespace)` and `deleteService(namespace, name)` for garbage collection, and make Service replacement preserve allocated `nodePort` values and `healthCheckNodePort` for existing LoadBalancer Services. The current helper preserves `clusterIP` fields only; TCP ingress updates must not churn NodePorts or target groups during a listener edit.

**`packages/shared/src/schemas/environment.ts`** — extend `EnvDiagnoseResponseSchema` with `tcp_ingress`.

**`apps/api/src/environments/env-diagnostics.service.ts`** — extend the env-diagnose payload with a `tcp_ingress` block, one entry per service with the manifest knob. This service currently uses `CoreV1Api` / `AppsV1Api` directly, not the worker `K8sService`, so read the live LoadBalancer Service through `coreApi.readNamespacedService` / `listNamespacedService`:

```json
{
  "service": "device-edge",
  "provider": "aws-nlb",
  "hostname": "trackers.eve.example.com",
  "listeners": [
    { "name": "bd-starlink", "port": 33334, "state": "ready", "node_target_port": 31523 },
    { "name": "a1-gt06",     "port": 33400, "state": "provisioning" }
  ]
}
```

`state` mirrors the K8s LoadBalancer Service status: `pending` (manifest opts in but Service is absent) → `provisioning` (Service exists but `status.loadBalancer.ingress[]` is empty) → `ready` (hostname/ip populated). The CLI renderer in `packages/cli/src/commands/env.ts` adds a `TCP Ingress` table to `eve env diagnose`.

**`packages/cli/src/commands/tcp-ingress.ts`** (new) — `eve tcp-ingress test <project> <env> --listener <name>`. Wire it into `packages/cli/src/index.ts` and `packages/cli/src/lib/help.ts`. Resolve the listener via env-diagnose, then run the equivalent of `nc -vz -w 5 <host> <port>` from the CLI host using Node's `node:net` socket API (no shell dependency on `nc`). Print `OK` / `FAIL` and exit code.

**Tests** — `apps/worker/src/deployer/__tests__/deployer-tcp-ingress.spec.ts`:

- Schema accepts a minimal `tcp_ingress.listeners[]` and rejects unknown tcp-ingress fields, unknown listener fields, missing names, port collisions, and listener ports not declared in `ports:`.
- `EVE_TCP_INGRESS_PROVIDER=aws-nlb` renders the LoadBalancer Service with NLB annotations and the env vars on the app container.
- `EVE_TCP_INGRESS_PROVIDER=aws-nlb` uses `externalTrafficPolicy: Local`, HTTP `/healthz` health checks, and does **not** emit a TCP NLB health check annotation.
- `EVE_TCP_INGRESS_PROVIDER=klipper` renders the LoadBalancer Service **without** NLB annotations.
- `EVE_TCP_INGRESS_PROVIDER=none` renders no LoadBalancer Service and logs a warning.
- Services that don't declare `tcp_ingress` emit no LoadBalancer Service (regression check).
- `allow_cidrs` populates `spec.loadBalancerSourceRanges`.
- Listener port in `30000-32767` → render error.
- Existing ClusterIP Service still rendered (regression).
- HTTP ingress still rendered when both `ingress` and `tcp_ingress` are present.
- Removing `tcp_ingress` from a previously opted-in service garbage-collects `<resourceName>-tcp`.
- Editing listeners preserves allocated Service `nodePort` values where Kubernetes has already assigned them.

### 2. Infra repo (`deployment-instance-repo`)

New module `terraform/aws/modules/aws-load-balancer-controller/`:

- IRSA role with the AWS-recommended trust policy and policy (`AWSLoadBalancerControllerIAMPolicy`, current JSON pulled from the upstream chart's docs).
- Helm release `aws-load-balancer-controller` in `kube-system`, pinned chart version, values:
  - `clusterName = <eks cluster name>`
  - `serviceAccount.create = true`
  - `serviceAccount.annotations."eks.amazonaws.com/role-arn" = <irsa role arn>`
  - `region`, `vpcId` from existing root outputs
  - `enableServiceMutatorWebhook = false` (we set the annotations ourselves; the mutator is the historical compatibility path).

Root wiring (`terraform/aws/`):

- New variable `aws_lb_controller_enabled` (default `false` initially → flip to `true` in the next infra release after the platform side ships).
- New variable `aws_lb_controller_chart_version` (pin string).
- Worker overlay env additions in the active staging overlay, currently `../deployment-instance/k8s/overlays/aws-eks/worker-deployment-patch.yaml` (and any older `aws` overlay still used by a deployment instance):
  - `EVE_TCP_INGRESS_PROVIDER=aws-nlb`
  - `EVE_TCP_INGRESS_HOSTED_ZONE=eve.example.com` (or omit if the deployer defaults it from `EVE_DEFAULT_DOMAIN`)
- The existing node SG rule (`nodes_nlb_client` at `terraform/aws/modules/eks/main.tf:122`) already allows `30000-32767` from `0.0.0.0/0`; the NLB target-group health-check rule (`nodes_nlb_health`) already allows VPC-CIDR on the same range. **No SG changes needed**.

The DNS record for `<hostname>.eve.example.com` → NLB DNS name is created by an external-dns-style controller in a follow-up. For Phase 1 we surface the NLB hostname directly via env-diagnose and operators add the CNAME through Terraform in `../deployment-instance` (no console or AWS CLI mutation). The hostname surface is the contract; automation is incremental.

### 3. Local k3d eval loop (this plan ships with it)

This is the critical part. Spec gaps are easy to close on paper and hard to close in practice; we run the full loop on k3d before touching staging.

**k3d already supports `Service: type: LoadBalancer`** out of the box via klipper-lb (k3s' built-in service load balancer). klipper binds the Service's ports on every k3d node container; the only missing piece is exposing those ports to the host.

**`bin/eh-commands/k8s.sh`** — extend `ensure_k3d_cluster` to accept a configurable list of TCP listener ports forwarded from the host. Two flags:

- `--tcp-ports <comma-list>` (e.g. `33033,33334,33400,33500`) on `eh k8s start` adds `-p "<port>:<port>@loadbalancer"` mappings to the `k3d cluster create` call.
- Without the flag, cluster creation behaves exactly as today (only 80/443 forwarded). Backwards-compatible.

If the cluster already exists with a different port set, `eh k8s start --tcp-ports ...` prints a clear message and exits non-zero with a `eh k8s start --recreate` hint. We do **not** silently recreate the cluster — that's destructive.

Alternative path for an existing cluster: a small docker container running `socat` per port that forwards `host:<port>` → `<k3d-node-ip>:<port>`. Wired as `bin/eh-commands/tcp-ingress.sh start|stop` calling `docker run --network k3d-eve-local --name eve-tcp-fwd-<port> ...`. We ship both paths; `--tcp-ports` is the preferred one (no extra container, no socat dependency).

**Local overlay** — add a new strategic-merge patch such as `k8s/overlays/local/worker-tcp-ingress.patch.yaml` and list it from `k8s/overlays/local/kustomization.yaml`:

```yaml
spec:
  template:
    spec:
      containers:
        - name: worker
          env:
            - name: EVE_TCP_INGRESS_PROVIDER
              value: klipper
            - name: EVE_TCP_INGRESS_HOSTED_ZONE
              value: lvh.me
```

This unwires `aws-nlb` locally and points the hostname suffix at `lvh.me`. With `hostname: trackers`, listeners advertise `trackers.lvh.me` and resolve to 127.0.0.1; without `hostname`, they advertise the generated service-scoped host under `lvh.me`.

**Manual test scenario** — `tests/manual/scenarios/46-tcp-ingress.md` (next unused number after the current scenarios):

```bash
# 0. Prereqs
./bin/eh status                            # k3d running, owner
./bin/eh k8s start --tcp-ports 33033,33334,33400,33500
./bin/eh k8s deploy

# 1. Seed a minimal raw-TCP echo service named "device-edge"
PROJECT_DIR=$(mktemp -d)/tcp-edge
mkdir -p "$PROJECT_DIR/.eve"
cat > "$PROJECT_DIR/server.js" <<'JS'
const net = require('node:net');

const ports = (process.env.PORTS || '33400,33500')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);

for (const port of ports) {
  net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  }).listen(port, '0.0.0.0', () => {
    console.log(`listening:${port}`);
  });
}
JS
cat > "$PROJECT_DIR/Dockerfile" <<'DOCKER'
FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV PORTS=33400,33500
CMD ["node", "server.js"]
DOCKER
cat > "$PROJECT_DIR/.eve/manifest.yaml" <<YAML
project:
  name: tcp-edge
services:
  device-edge:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "33400"
      - "33500"
    x-eve:
      tcp_ingress:
        listeners:
          - name: a1-gt06
            port: 33400
          - name: mictrack-mt700
            port: 33500
        hostname: trackers
YAML
(cd "$PROJECT_DIR" && git init -b main && git add . && \
  git -c user.name='Eve Manual Test' -c user.email='manual-tests@example.invalid' \
  commit -m 'init tcp echo')

PROJECT_ID=$(eve project ensure --org org_manualtestorg \
  --name tcp-edge --slug tcp-edge \
  --repo-url file://"$PROJECT_DIR" --branch main --force --json \
  | jq -r '.id // .project.id')
eve project sync --project "$PROJECT_ID" --dir "$PROJECT_DIR" --json
eve env create test --type persistent --project "$PROJECT_ID" --json
eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json
NAMESPACE=$(eve env show "$PROJECT_ID" test --json | jq -r '.namespace')
HOST=$(eve env diagnose "$PROJECT_ID" test --json | jq -r '.tcp_ingress[] | select(.service=="device-edge") | .hostname')

# 2. Inspect rendered resources
./bin/eh kubectl get svc -n "$NAMESPACE"
# Expect: <resourceName>-tcp  LoadBalancer  <cluster-ip>  <node-ip>  33400:NNNN/TCP,33500:NNNN/TCP

# 3. Diagnose surface
eve env diagnose "$PROJECT_ID" test --json | jq '.tcp_ingress'
# Expect: provider=klipper, listeners each in state=ready, hostname=trackers.lvh.me

# 4. Probe from the host
nc -vz -w 5 "$HOST" 33400  # → succeeded
nc -vz -w 5 "$HOST" 33500  # → succeeded

# 5. End-to-end CLI probe
eve tcp-ingress test "$PROJECT_ID" test --listener a1-gt06         # → OK
eve tcp-ingress test "$PROJECT_ID" test --listener mictrack-mt700  # → OK

# 6. Send actual bytes through the listener
printf 'HELLO\n' | nc -w 2 "$HOST" 33400
# Expect: HELLO

# 7. Remove a listener and re-deploy
yq -i '.services.device-edge.x-eve.tcp_ingress.listeners |= map(select(.name != "mictrack-mt700"))' \
  "$PROJECT_DIR/.eve/manifest.yaml"
eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json
./bin/eh kubectl get svc -n "$NAMESPACE" -l eve.tcp_ingress=true -o jsonpath='{.items[0].spec.ports[*].name}'
# Expect: only "a1-gt06"
nc -vz -w 2 "$HOST" 33500  # → refused / closed (port removed)

# 8. Source-IP allowlist
yq -i '.services.device-edge.x-eve.tcp_ingress.allow_cidrs = ["10.99.99.0/24"]' \
  "$PROJECT_DIR/.eve/manifest.yaml"
eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json
nc -vz -w 2 "$HOST" 33400  # → connection refused / timeout
# klipper does not enforce loadBalancerSourceRanges on a Service of type
# LoadBalancer in older k3s — if k3d reports it as a known limitation, document
# it and rely on EKS to prove the allowlist path (Steps 11+).

# 9. Full opt-out
yq -i 'del(.services.device-edge.x-eve.tcp_ingress)' "$PROJECT_DIR/.eve/manifest.yaml"
eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json
./bin/eh kubectl get svc -n "$NAMESPACE" -l eve.tcp_ingress=true | grep tcp || echo "no tcp svc (expected)"

# 10. Recovery
yq -i '.services.device-edge.x-eve.tcp_ingress.listeners = [{name:"a1-gt06",port:33400}]' \
  "$PROJECT_DIR/.eve/manifest.yaml"
eve env deploy test --project "$PROJECT_ID" --ref HEAD --repo-dir "$PROJECT_DIR" --direct --json
nc -vz -w 5 "$HOST" 33400  # → succeeded
```

Acceptance for the k3d eval loop: steps 1–10 pass on a fresh `./bin/eh k8s start --tcp-ports 33033,33334,33400,33500 && ./bin/eh k8s deploy`. The scenario is added to `tests/manual/scenarios/` and listed in the manual-test README. Step 8 may be relaxed to "documented limitation on k3d" if klipper-lb's source-range support is incomplete; the EKS verification (Step 17 below) is the source of truth for `allow_cidrs`.

## Verification loop (staging)

Steps 11+ run after the k3d loop passes and the platform release tag is cut.

### Staging safety pre-flight

```bash
./bin/eh status                                # Staging Owner: true required
cd ../deployment-instance && ./bin/eve-infra kubeconfig doctor

KUBECTL="kubectl --kubeconfig ../deployment-instance/config/kubeconfig.yaml \
  --context <explicit-eks-context>"
```

### Step 11 — Provision the AWS Load Balancer Controller

```bash
cd ../deployment-instance/terraform/aws
# terraform.tfvars:
#   aws_lb_controller_enabled = true
terraform fmt -recursive && terraform plan && terraform apply
terraform plan                                  # must show no changes
$KUBECTL -n kube-system get deploy aws-load-balancer-controller
```

Expected: `2/2 Ready` (the chart defaults to two replicas).

### Step 12 — Cut a platform release

```bash
LATEST="$(git tag --list 'release-v*' --sort=-version:refname | head -1)"
NEXT="$(echo "$LATEST" | awk -F. '{print $1"."$2"."$3+1}')"
git tag "$NEXT" && git push origin "$NEXT"
gh run watch --repo example-org/deployment-instance
eve system health --json | jq .status           # "ok"
```

### Step 13 — Deploy `device-edge` to staging

In the PVS rebuild repo (or a placeholder echo-server with the same manifest):

```yaml
services:
  device-edge:
    x-eve:
      tcp_ingress:
        listeners:
          - { name: a1-gt06,         port: 33400 }
          - { name: mictrack-mt700,  port: 33500 }
          - { name: vg42-tq,         port: 33033 }
          - { name: bd-starlink,     port: 33334 }
        hostname: trackers
```

```bash
eve env deploy sandbox --project "$PVS_PROJECT_ID" --ref HEAD --repo-dir . --direct
$KUBECTL -n eve-example-sample-sandbox get svc -l eve.tcp_ingress=true -o yaml \
  | yq '.items[].metadata.annotations'
```

Expected annotations match the NLB block above. `EXTERNAL-IP` populates with the NLB DNS name (`a1b2c3.elb.eu-west-1.amazonaws.com`) within ~2 min.

### Step 14 — Wire the NLB hostname

```bash
NLB="$($KUBECTL -n eve-example-sample-sandbox get svc -l eve.tcp_ingress=true \
  -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}')"
echo "NLB hostname: $NLB"
# Add a Terraform-managed CNAME in ../deployment-instance:
#   trackers.eve.example.com → $NLB
# Do not create the record through the Route 53 console or AWS CLI.
```

### Step 15 — Probe each listener

```bash
for p in 33033 33334 33400 33500; do
  nc -vz -w 5 trackers.eve.example.com "$p" || echo "FAIL port $p"
done
eve tcp-ingress test $PVS_PROJECT_ID sandbox --listener a1-gt06
eve env diagnose $PVS_PROJECT_ID sandbox --json | jq '.tcp_ingress'
```

Expected: all four listeners report `OK` / `ready`.

### Step 16 — Real tracker bytes

Point one development tracker at `trackers.eve.example.com:33400` (out-of-band vendor portal config). Watch:

```bash
eve env logs $PVS_PROJECT_ID sandbox device-edge --tail 100 --follow
```

Expected: vendor's GT06 login frame parsed; ACK sent back; heartbeat loop established. If TCP connects but protocol negotiation fails, the platform path is correct and the remaining work is app/firmware.

### Step 17 — Source-IP allowlist on EKS

```bash
# Add allow_cidrs to manifest, redeploy
yq -i '.services.device-edge.x-eve.tcp_ingress.allow_cidrs = ["1.2.3.4/32"]' \
  .eve/manifest.yaml
git commit -am 'temp: allowlist 1.2.3.4 only'
eve env deploy sandbox --project "$PVS_PROJECT_ID" --ref HEAD --repo-dir . --direct
nc -vz -w 5 trackers.eve.example.com 33400      # → timeout (we are not 1.2.3.4)
yq -i 'del(.services.device-edge.x-eve.tcp_ingress.allow_cidrs)' .eve/manifest.yaml
git commit -am 'revert allowlist'
eve env deploy sandbox --project "$PVS_PROJECT_ID" --ref HEAD --repo-dir . --direct
nc -vz -w 5 trackers.eve.example.com 33400      # → succeeded
```

### Step 18 — Drain a listener cleanly

```bash
yq -i '.services.device-edge.x-eve.tcp_ingress.listeners |= map(select(.name != "vg42-tq"))' \
  .eve/manifest.yaml
eve env deploy sandbox --project "$PVS_PROJECT_ID" --ref HEAD --repo-dir . --direct
$KUBECTL -n eve-example-sample-sandbox describe svc -l eve.tcp_ingress=true | grep -A1 Ports
nc -vz -w 5 trackers.eve.example.com 33033       # → refused after NLB drain (≤ 5 min)
```

Existing connections respect the NLB target-group default deregistration delay (300 s). Document this — apps cannot assume immediate close on listener removal.

### Step 19 — Disable the feature for the service

```bash
yq -i 'del(.services.device-edge.x-eve.tcp_ingress)' .eve/manifest.yaml
eve env deploy sandbox --project "$PVS_PROJECT_ID" --ref HEAD --repo-dir . --direct
$KUBECTL -n eve-example-sample-sandbox get svc -l eve.tcp_ingress=true || echo "no svc (expected)"
```

Expected: NLB is deleted by the AWS Load Balancer Controller within ~3 min. CNAME record outlives the NLB until manually removed (or external-dns reaps it once wired).

## Acceptance

The plan is shipped when:

- [ ] k3d eval loop (Steps 1–10) passes on a clean `./bin/eh k8s start --tcp-ports ... && ./bin/eh k8s deploy`.
- [ ] AWS Load Balancer Controller is installed in the staging cluster (Step 11).
- [ ] Platform release tag deployed (Step 12).
- [ ] Staging deploy of `device-edge` with four listeners is reachable from the public Internet (Step 15).
- [ ] At least one real vendor protocol (A1 GT06 preferred — lowest-risk legacy tracker) completes a login + heartbeat round-trip from a real device (Step 16).
- [ ] `allow_cidrs` denies disallowed sources on EKS (Step 17).
- [ ] Listener removal drains within NLB default timeout (Step 18).
- [ ] Full opt-out leaves the namespace clean (Step 19).
- [ ] `apps/worker/src/deployer/__tests__/deployer-tcp-ingress.spec.ts` passes in CI.
- [ ] `references/manifest.md` in `eve-skillpacks` documents `x-eve.tcp_ingress`.
- [ ] `references/deploy-debug.md` in `eve-skillpacks` documents TCP ingress diagnostics, NLB drain timing, and the `nodes_nlb_client` SG note.
- [ ] `tests/manual/scenarios/46-tcp-ingress.md` exists and is referenced from the manual-test README.
- [ ] `references/cli.md` in `eve-skillpacks` documents `eve tcp-ingress test`.

## Non-goals

- **TLS termination at the platform layer.** Apps that want TLS handle it themselves. TLS-aware NLBs (with cert ARNs) are a possible Phase 2 toggle.
- **UDP listeners.** Different problem. Stable Egress already covers UDP source-port preservation outbound; a UDP ingress primitive would need NLB UDP target groups + separate SG plumbing.
- **Per-tenant TCP ingress** (different ports per tenant on one service). A tenant-aware listener can be modelled inside the app or by multiple `device-edge` deployments. v1 is one listener set per service.
- **Protocol-aware load-balancer health checks.** The platform uses kube-proxy/node health for source-IP-preserving LoadBalancer Services and the app's existing readiness/healthcheck for pod eligibility. Per-protocol HEARTBEAT probes belong to the app.
- **Automated DNS wiring of `<hostname>.<zone>` → NLB**. Surface the NLB DNS name; operators add Terraform-managed CNAMEs in `../deployment-instance` until external-dns lands as a separate plan.
- **`hostNetwork`-based shape.** Stable Egress's pod shape is wrong for inbound. The LoadBalancer Service + NodePort + NLB path is the standard K8s answer here.
- **Cross-namespace port-collision validation on k3d.** Tracked separately; not blocking single-tenant local dev.
- **NLB cost / capacity dashboards**. Operator-visible metrics on listeners are deferred.

## Risks and follow-ups

- **NLB cost per service.** Each opted-in service gets its own NLB ($~16/mo + LCU). For PVS this is one NLB. If many services opt in, consider a shared NLB with `service.beta.kubernetes.io/aws-load-balancer-name` reuse — a Phase 2 toggle.
- **`externalTrafficPolicy: Local` only sends traffic to nodes with local ready endpoints.** With replicas=1, only the node running the pod is healthy; cross-zone load balancing helps, but there is no platform-level HA if all endpoints are unavailable or concentrated on a drained node. Apps that need HA should run multiple replicas spread across nodes.
- **NLB drain timeout (default 300 s).** Documented in deploy-debug.
- **klipper-lb source-range coverage on k3d** may be incomplete. Document as a k3d limitation; EKS is the source of truth.
- **AWS Load Balancer Controller chart drift.** Pin the chart version in Terraform; bump intentionally.
- **No port-collision validation across namespaces** on k3d (klipper binds to node IPs). Two opted-in services in two namespaces on the same listener port will fight. EKS gives each its own NLB, so the conflict is k3d-local.
- **DNS wiring is manual in Phase 1.** Adding external-dns is a single follow-up plan; it's not on the critical path for "PVS device-edge reaches Eve".

## See also

- eve-platform-spec **001 — Public L4 TCP ingress for device-facing services** (the requesting spec).
- [`app-stable-egress-v2-plan.md`](./app-stable-egress-v2-plan.md) — related but outbound.
- [`private-endpoints-tailscale-plan.md`](./private-endpoints-tailscale-plan.md) — related but outbound.
- [`ingress-aliases-plan.md`](./ingress-aliases-plan.md) — HTTP alias model, the analogous shape for hostnames.
- `apps/worker/src/deployer/deployer.service.ts:1139-1358` — the existing HTTP-ingress + ClusterIP-Service emission this plan parallels.
- `../deployment-instance/terraform/aws/modules/eks/main.tf:106-124` — the EKS node SG rules that already cover the NLB → NodePort path.
- [Amazon EKS — route TCP/UDP traffic with Network Load Balancers](https://docs.aws.amazon.com/eks/latest/userguide/network-load-balancing.html) — source for the `external` NLB + `instance` target annotations.
- [AWS Load Balancer Controller service annotations](https://kubernetes-sigs.github.io/aws-load-balancer-controller/v2.6/guide/service/annotations/) — source for NLB annotations, source ranges, and the `externalTrafficPolicy: Local` health-check caveat.
- [Kubernetes Service traffic policies](https://kubernetes.io/docs/reference/networking/virtual-ips/#external-traffic-policy) — source for `externalTrafficPolicy: Local` and kube-proxy load-balancer health behavior.

## Sister-plan deltas

- `references/manifest.md` in `eve-skillpacks` — add the `x-eve.tcp_ingress` block.
- `references/deploy-debug.md` in `eve-skillpacks` — add the `tcp_ingress` field returned by `eve env diagnose`, the NLB drain timing note, and the listener probe recipe.
- `references/cli.md` in `eve-skillpacks` — add `eve tcp-ingress test`.
- `bin/eh-commands/k8s.sh` — `--tcp-ports` flag on `eh k8s start`.
- `tests/manual/scenarios/46-tcp-ingress.md` — new scenario, listed in the scenarios README.
