# Deployment

> Status: Current
> Last Updated: 2026-02-13

## Purpose

Define the supported deployment configurations and the primary runtime targets for Eve Horizon.

## Runtime Modes

Eve Horizon supports two primary deployment modes, controlled by `EVE_RUNTIME`:

| Mode | `EVE_RUNTIME` | Purpose | Runner Execution |
|------|---------------|---------|------------------|
| Docker Compose | `docker` (default) | Quick dev iteration | Local process |
| Kubernetes | `k8s` | Integration testing, manual validation, production | Ephemeral pods |

## Kubernetes (Primary for Testing & Production)

K8s is the **primary deployment target** for integration testing, manual validation, and production workloads.

### Digest-Based Deployments

Deployments support both tag-based and digest-based image references for immutability:

- **Tag-based**: `public.ecr.aws/w7c4v0w3/namespace/service:v1.0.0` (default, traditional)
- **Digest-based**: `public.ecr.aws/w7c4v0w3/namespace/service@sha256:abc123...` (immutable, from pipeline builds)

Release objects capture `image_digests_json` from build outputs, enabling reproducible deployments with exact image pinning.
See [builds.md](./builds.md) for how BuildSpecs/BuildRuns produce artifacts.

### Quick Start

```bash
# Start k3d cluster and apply manifests
./bin/eh k8s start

# Build images and deploy stack
./bin/eh k8s deploy

# Run manual tests (see tests/manual/README.md)
# eve org ensure "manual-test-org" && eve secrets import --org org_manualtestorg --file manual-tests.secrets

# Check status
./bin/eh k8s status
```

### AWS (k3s on VPS)

Production-style AWS deployments use the **`eve-horizon/eve-horizon-infra`** template repo,
which contains the Kustomize overlay, Terraform configuration, and deploy workflow:

- Uses external Postgres (RDS or managed database)
- Assumes images are pulled from public ECR (published by `publish-images.yml` in this repo)
- Sets a placeholder Ingress host and default app domain

The AWS overlay and Terraform have been extracted from this repo. See
[docs/deploy/aws.md](../deploy/aws.md) for the template-based deployment flow.

### Architecture

- **API, Orchestrator, Worker**: Cluster-scoped deployments in the `eve` namespace (worker is not per-env)
- **Postgres**: StatefulSet with 5Gi PVC
- **Runner pods**: Ephemeral pods spawned per job attempt for isolated execution
- **Ingress access**: No port-forwarding needed - access via `http://api.eve.lvh.me`

### Web Auth Services (Supabase + SSO)

When web auth is enabled, the k8s stack also includes:

- **supabase-auth (GoTrue)** at `auth.<domain>`
- **sso** service at `sso.<domain>`
- **mailpit** at `mail.<domain>` (local-only email capture)
- **auth bootstrap job** to provision the GoTrue database role

Key env vars (API + auth services):

- `SUPABASE_AUTH_URL`, `SUPABASE_AUTH_EXTERNAL_URL`
- `SUPABASE_AUTH_SERVICE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`
- `EVE_SSO_URL`, `EVE_AUTH_ADMIN_PASSWORD`

### Runner Pod Reaper

The worker runs a periodic reaper that cleans up orphaned runner pods and PVCs
after job completion. This prevents resource leaks if the worker restarts mid-poll.

Key settings:
- `EVE_RUNNER_REAPER_ENABLED`
- `EVE_RUNNER_REAPER_INTERVAL_MS`
- `EVE_RUNNER_REAPER_GRACE_SECONDS`

### Secrets Provisioning

All secrets are managed through a system-level flow:

1. **System secrets**: Define secrets in `system-secrets.env.local`
   - Example: `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`
2. **Sync to K8s**: Run `./bin/eh k8s secrets` to sync `system-secrets.env.local` + auth-derived keys to the `eve-app` secret
3. **Restart consumers**: Restart deployments that consume `eve-app` (`eve-api`, `eve-orchestrator`, `eve-worker`) so updated env values are loaded
4. **API reads**: API reads system secrets as baseline

This provides a consistent baseline for all environments without manual patching or org-specific hacks.

### Ingress Routing

Deployed apps are accessible via Ingress with automatic URL generation:

```
URL pattern: {component}.{orgSlug}-{projectSlug}-{env}.{domain}
Example:     web.acme-fstack-test.lvh.me
```

**Domain resolution order:**
1. Manifest `x-eve.ingress.domain` (if set) - per-app override
2. `EVE_DEFAULT_DOMAIN` env var - cluster-level default
3. No Ingress created (if neither set)

**Local dev:** Uses `lvh.me` which resolves to 127.0.0.1 - no /etc/hosts needed.

**Production VPS:** Set `EVE_DEFAULT_DOMAIN=apps.yourdomain.com` in the worker deployment.

### Ingress Timeouts and Body Size

Tenant HTTP ingresses support two controller-agnostic knobs under
`x-eve.ingress`:

```yaml
x-eve:
  ingress:
    public: true
    port: 3000
    timeout: 600s
    max_body_size: 100m
```

`timeout` sets nginx `proxy-read-timeout` and `proxy-send-timeout` for every
Ingress rendered for that service (default host, alias, and custom domains).
`max_body_size` sets nginx `proxy-body-size`. Platform defaults are
`EVE_DEFAULT_INGRESS_TIMEOUT=300s` and
`EVE_DEFAULT_INGRESS_MAX_BODY_SIZE=10m`; manifest values override them. Valid
ranges are `1s`-`30m` and `1k`-`1g`.

Phase 1 emits L7 tuning annotations only when `EVE_DEFAULT_INGRESS_CLASS` is
`nginx` or `nginx-ingress`. Other controllers keep routing unchanged; explicit
tenant tuning logs a warning. Confirm the live values with:

```bash
eve env diagnose <project> <env>
eve env diagnose <project> <env> --json | jq '.http_ingress'
```

### Ingress TLS (Apps)

App ingresses can be issued TLS certificates automatically via cert-manager.

**Recommended (cert-manager):**
- `EVE_DEFAULT_TLS_CLUSTER_ISSUER=letsencrypt-prod`
- Optional: `EVE_DEFAULT_INGRESS_CLASS=traefik` (or your ingress class)

When `EVE_DEFAULT_TLS_CLUSTER_ISSUER` is set, app ingresses include a `tls` block
and cert-manager annotations so certificates are issued per host.

**Wildcard cert (optional):**
- `EVE_DEFAULT_TLS_SECRET=wildcard-apps-tls`

If you provide a wildcard cert, the worker will reference that secret name in every
app ingress. Ensure the secret exists in each app namespace.

### Manifest Variable Interpolation

Environment values in manifests support variable interpolation:

| Variable | Replaced With | Example |
|----------|---------------|---------|
| `${ENV_NAME}` | Environment name | test, staging, production |
| `${PROJECT_ID}` | Project ID | proj_01kfew... |
| `${ORG_ID}` | Organization ID | org_Example... |
| `${ORG_SLUG}` | Organization slug | acme, example-org |
| `${COMPONENT_NAME}` | Current service name | api, web, db |
| `${SSO_URL}` | Platform SSO broker URL | `https://sso.eve.example.com` |
| `${secret.KEY}` | Secret value | `${secret.DB_PASSWORD}` |
| `${managed.<service>.<field>}` | Managed DB value (when provisioned) | `${managed.db.url}` |

Example manifest:
```yaml
services:
  api:
    image: public.ecr.aws/w7c4v0w3/org/api
    ports: [3000]
    environment:
      DATABASE_URL: postgres://eve:eve@${ENV_NAME}-db:5432/eve
```

### Platform-Injected Environment Variables

The deployer automatically injects these variables into all deployed service containers:

| Variable | Description |
|----------|-------------|
| `EVE_API_URL` | Internal cluster URL for server-to-server calls |
| `EVE_PUBLIC_API_URL` | Public ingress URL for browser-facing apps (when configured) |
| `EVE_SSO_URL` | SSO broker URL for user authentication (when configured) |
| `EVE_PROJECT_ID` | Current project ID |
| `EVE_ORG_ID` | Current organization ID |
| `EVE_ENV_NAME` | Current environment name |

Services can override these values by defining them explicitly in their `environment` section. Use `EVE_API_URL` for backend calls and `EVE_PUBLIC_API_URL` for browser/client-side code.

For adding SSO login to deployed apps using these variables, see [App SSO Integration](./app-sso-integration.md).

### Load Balancer Recovery

k3d's load balancer can become stale after sleep/wake cycles. The `k8s.sh` script auto-recovers:

```bash
# Manual recovery if needed
docker restart k3d-eve-local-serverlb
```

See [k8s-local-stack.md](./k8s-local-stack.md) for detailed k8s documentation.

## Worker Image Registry

Eve Horizon publishes pre-built worker images to public ECR for use in production and integration environments. These images eliminate the need to build worker images locally and ensure consistent toolchain versions across deployments.

### Available Images

All worker images are published to `public.ecr.aws/w7c4v0w3/eve-horizon` and follow a consistent naming and tagging convention:

| Image | Public ECR Path | Description |
|-------|-----------|-------------|
| **base** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-base:<version>` | Runtime without toolchains - Node.js, worker harness, and base utilities only |
| **python** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-python:<version>-py3.11` | Python 3.11, pip, uv package manager |
| **rust** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-rust:<version>-rust1.75` | Rust 1.75 via rustup, cargo |
| **java** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-java:<version>-jdk21` | OpenJDK 21 |
| **kotlin** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-kotlin:<version>-kotlin2.0-jdk21` | Kotlin 2.0 + OpenJDK 21 |
| **full** | `public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:<version>` | All toolchains (default) |

### Versioning and Tags

Worker images use a structured tagging scheme for traceability and version pinning:

**Version tags** (created on git tag push):
- Format: `worker-images/vX.Y.Z` in git
- Examples:
- `public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:0.1.0`
- `public.ecr.aws/w7c4v0w3/eve-horizon/worker-python:0.1.0-py3.11`
- `public.ecr.aws/w7c4v0w3/eve-horizon/worker-rust:0.1.0-rust1.75`

**SHA tags** (created on every build):
- Format: `sha-<short-sha>`
- Example: `public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:sha-a1b2c3d`
- Use for pinning to exact commits during development

**Multi-architecture support**:
- All images are built for `linux/amd64` and `linux/arm64` platforms
- Automatic platform selection based on host architecture

### Configuration

Worker images are configured via the `EVE_RUNNER_IMAGE` environment variable in worker deployments. This variable specifies the container image used for ephemeral runner pods.

#### Kubernetes Deployments

Set `EVE_RUNNER_IMAGE` in the worker deployment manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: eve
spec:
  template:
    spec:
      containers:
      - name: worker
        image: public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:latest
        env:
        - name: EVE_RUNNER_IMAGE
          value: public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:0.1.0
```

For specialized worker pools, use variant-specific images:

```yaml
# Python-specific worker pool
- name: EVE_RUNNER_IMAGE
  value: public.ecr.aws/w7c4v0w3/eve-horizon/worker-python:0.1.0-py3.11

# Rust-specific worker pool
- name: EVE_RUNNER_IMAGE
  value: public.ecr.aws/w7c4v0w3/eve-horizon/worker-rust:0.1.0-rust1.75
```

#### Docker Compose

Set `EVE_RUNNER_IMAGE` in the worker service environment:

```yaml
services:
  worker:
    image: public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:latest
    environment:
      - EVE_RUNNER_IMAGE=public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:0.1.0
```

For multi-worker deployments with different toolchains:

```yaml
services:
  worker-python:
    image: public.ecr.aws/w7c4v0w3/eve-horizon/worker-python:0.1.0-py3.11
    environment:
      - EVE_RUNNER_IMAGE=public.ecr.aws/w7c4v0w3/eve-horizon/worker-python:0.1.0-py3.11
    ports:
      - "4812:4811"

  worker-rust:
    image: public.ecr.aws/w7c4v0w3/eve-horizon/worker-rust:0.1.0-rust1.75
    environment:
      - EVE_RUNNER_IMAGE=public.ecr.aws/w7c4v0w3/eve-horizon/worker-rust:0.1.0-rust1.75
    ports:
      - "4813:4811"
```

### Version Pinning Strategy

**Production deployments**:
- Use semantic version tags for stability: `public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:0.1.0`
- Pin to specific versions to prevent unexpected toolchain updates
- Update versions explicitly through deployment manifests

**Development/testing**:
- Use SHA tags for exact commit traceability: `public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:sha-a1b2c3d`
- Use `latest` tag for continuous integration testing (auto-updated on push)

**Security updates**:
- Monitor registry for published CVE fixes
- Update pinned versions in deployment manifests when new versions are released

### Publishing Workflow

Images are automatically published via GitHub Actions when git tags matching `worker-images/v*` are pushed:

```bash
# Create and push a new version tag
git tag worker-images/v0.2.0
git push origin worker-images/v0.2.0
```

The CI workflow:
1. Extracts the version from the tag (e.g., `worker-images/v0.2.0` becomes `0.2.0`)
2. Builds all worker image variants in parallel
3. Tags each image with:
   - Version tag: `<version>` or `<version>-<variant>` (e.g., `0.2.0`, `0.2.0-py3.11`)
   - SHA tag: `sha-<short-sha>` (e.g., `sha-a1b2c3d`)
4. Pushes images to public ECR with multi-architecture support (amd64 and arm64)
5. Uses Docker BuildKit layer caching for faster rebuilds

### Image Pull Authentication

ECR images are public by default. For private deployments:

**Kubernetes**:
Create an image pull secret:
```bash
kubectl create secret docker-registry ecr-pull-secret \
  --docker-server=public.ecr.aws/w7c4v0w3 \
  --docker-username=<registry-username> \
  --docker-password=<registry-password> \
  --namespace=eve
```

Reference in deployment:
```yaml
spec:
  imagePullSecrets:
  - name: ecr-pull-secret
```

**Docker Compose**:
Login to a private registry before starting the stack:
```bash
echo $REGISTRY_PASSWORD | docker login public.ecr.aws/w7c4v0w3 -u <registry-username> --password-stdin
docker compose up
```

## Docker Compose (Quick Dev Loop)

Docker Compose is optimized for **fast local iteration** during development.

**Security note:** Docker Compose is dev-only. It exposes services on localhost and uses simple defaults. Do not run it in shared or internet-exposed environments.

### Quick Start

```bash
# Start the stack
./bin/eh start docker
```

### When to Use

- Daily development with frequent code changes
- Quick iteration without k8s overhead
- Running integration tests locally (stub harness by default)

### Comparison

| Aspect | Docker Compose | K8s (k3d) |
|--------|----------------|-----------|
| Startup time | ~10s | ~60s |
| Resource usage | Lower | Higher |
| Production parity | Moderate | High |
| Runner pods | No (local process) | Yes (ephemeral pods) |
| Primary use | Daily dev, quick iteration | Integration, manual validation, production |

## macOS Local Development

- **Prereqs**: Docker Desktop (8GB+ memory, 4+ CPUs), Node.js, pnpm
- **K8s extras**: k3d, kubectl
- **Local config**: `.env` for secrets, `system-secrets.env.local` for auth keys, `.eve-horizon.yaml` for ports

## Runtime Environment Variables (Key)

Orchestrator:
- `ORCH_LOOP_INTERVAL_MS`
- `ORCH_CONCURRENCY`
- `ORCH_CONCURRENCY_MIN` / `ORCH_CONCURRENCY_MAX`
- `ORCH_TUNER_ENABLED`
- `ORCH_TUNER_INTERVAL_MS`
- `ORCH_TUNER_CPU_THRESHOLD`
- `ORCH_TUNER_MEMORY_THRESHOLD`
- `EVE_WORKER_POLL_INTERVAL_MS`
- `EVE_AGENT_RUNTIME_POLL_INTERVAL_MS`
- `EVE_ORCH_RECOVERY_INTERVAL_TICKS`
- `EVE_ORCH_STALE_RECOVERY_INTERVAL_TICKS`
- `EVE_ORCH_STALE_RUNNING_SECONDS`
- `EVE_ORCH_STALE_IDLE_SECONDS`
- `EVE_ORCH_TIMEOUT_GRACE_SECONDS`
- `EVE_ORCH_ATTEMPT_STALE_MINUTES`

Worker:
- `EVE_RUNNER_REAPER_ENABLED`
- `EVE_RUNNER_REAPER_INTERVAL_MS`
- `EVE_RUNNER_REAPER_GRACE_SECONDS`

API mailer / SES feedback (only meaningful when `GOTRUE_SMTP_HOST` is `*.amazonaws.com`; see [auth.md → Mail Delivery and SES Suppression](./auth.md#mail-delivery-and-ses-suppression)):

| Variable | Default | Notes |
| --- | --- | --- |
| `EVE_MAILER_CHECK_SUPPRESSION` | `auto` | `auto` = enabled when SMTP host is SES; `true`/`false` force override. Set `false` for Mailpit / local dev. |
| `EVE_MAILER_SES_REGION` | parsed from `GOTRUE_SMTP_HOST` | Region for `GetSuppressedDestination` (e.g. `us-west-2`). Falls back to host parsing for `email-smtp.<region>.amazonaws.com`. |
| `EVE_SES_CONFIGURATION_SET` | — | Sent as `X-SES-CONFIGURATION-SET` header on every outbound mail so SES routes Bounce/Complaint/Delivery/Reject events to the SNS topic. |
| `EVE_SES_FEEDBACK_TOPIC_ARN` | — | Topic ARN allowed to POST to `/webhooks/ses-feedback`. Mismatches are rejected — protects against spoofed SNS payloads. |

For the AWS EKS overlay, the API pod's IRSA role must include `ses:GetSuppressedDestination`. This is granted in `deployment-instance-repo` under `terraform/aws/modules/ses-feedback`. The mailer fails open on any AWS error other than `NotFoundException`, so a missing or broken IRSA never blocks delivery for unsuppressed addresses — but it will spam `mailer.suppression_check_failed` log lines until fixed.

## Production Deployment

Production uses Kubernetes (k3s or managed k8s):

- **Worker images**: Use published ECR images (see [Worker Image Registry](#worker-image-registry) above)
  - Pin to specific versions: `public.ecr.aws/w7c4v0w3/eve-horizon/worker-full:0.1.0`
  - Avoid `latest` tag in production for stability
- **ConfigMaps/Secrets**: Environment configuration and credentials
- **Persistent volumes**: Database and workspace storage
- **RBAC**: Worker service account permissions (pods, PVCs, services CRUD)
- **Manifests**: Same base manifests as local k3d with production-specific overlays

See [worker-types.md](./worker-types.md) for details on worker image variants, routing configuration, and adding custom worker types.

## Workspace Janitor (Disk Safety)

Workspace reuse and session workspaces require active disk management in production.

Recommended operator controls:
- `EVE_WORKSPACE_MAX_GB`: total workspace budget per instance
- `EVE_WORKSPACE_MIN_FREE_GB`: hard floor; refuse new claims if below
- `EVE_WORKSPACE_TTL_HOURS`: idle TTL for job worktrees
- `EVE_SESSION_TTL_HOURS`: idle TTL for session workspaces
- `EVE_MIRROR_MAX_GB`: cap for bare mirrors

Policies:
- LRU eviction of worktrees when over budget.
- TTL cleanup for idle job/session worktrees.
- Mirror maintenance via `git fetch --prune` and periodic `git gc --prune=now`.
- Emit system events on low disk; do not start new attempts when below minimum free space.

K8s notes:
- Per-attempt PVCs are deleted after completion.
- Session-scoped PVCs should have TTL cleanup and storage quotas.

## Diagnosing a Failed Deploy

Since the deploy-error-surfacing work (releases post 2026-04-21) a failed deploy
should give you a structured answer without reaching for `kubectl`.

**Step-by-step:**

1. `eve pipeline logs <pipeline> <run-id>` — the top of the output includes a
   `Failure:` block with the `DeployFailure` kind, the affected service/pod, and
   a `Next step` hint.
2. `eve env show <project> <env>` — when the DB and cluster have diverged (for
   example a partially applied manifest) the output shows `Current Release`
   marked `(last ready)` and `Last Applied` marked `DRIFT — cluster differs from
   last-ready`, plus the failure kind on `Last Failure`.
3. `eve job diagnose <job-id>` — works for any job; renders the same
   `DeployFailure` block with a pod snapshot.
4. `eve env diagnose <project> <env>` — live K8s view (pods, events, readiness).
5. `eve env logs <project> <env> <service> --previous` — previous-container log
   excerpt. The CLI hint in the `app_crash_loop` path links here directly.

For a request-specific incident after the app is running, prefer the request
diagnose and trace commands:

```bash
eve env diagnose <project> <env> --request req_01h... --window 120 --json
eve env logs <project> <env> <service> --follow --filter req_id=req_01h...
eve traces query --project <project> --request-id req_01h... --json
```

### TCP Ingress Diagnostics

`eve env diagnose <project> <env>` includes a `TCP Ingress` table when a
service declares `x-eve.tcp_ingress`. The JSON shape is available at
`.tcp_ingress[]` and reports each service, provider, advertised host, external
LoadBalancer address, listener port, listener state, and local node target port
when Kubernetes allocates one.

Listener states mirror the live LoadBalancer service:

| State | Meaning |
|-------|---------|
| `pending` | Manifest opts in but the `eve.tcp_ingress=true` Service is absent. |
| `provisioning` | Service exists but `status.loadBalancer.ingress[]` is still empty. |
| `ready` | Kubernetes reports an external hostname or IP. |

Probe a ready listener from the operator machine:

```bash
eve tcp-ingress test <project> <env> --listener a1-gt06
eve tcp-ingress test <project> <env> --listener a1-gt06 --timeout 10 --json
```

This is a TCP connect probe only; it does not speak the device protocol. For
local k3d, raw TCP ports must be mapped into the cluster load balancer at
creation time:

```bash
./bin/eh k8s start --tcp-ports 33400,33500 --recreate
```

**DeployFailure kinds** (see `apps/worker/src/deployer/deploy-failure.ts`):

| Kind | Typical cause | Next step |
| --- | --- | --- |
| `k8s_api_error` | Platform API issue | Share `attempt_id` with Eve support. |
| `manifest_invalid` | Invalid YAML or schema rejected by K8s | `eve manifest validate`. |
| `image_pull_error` | Bad image digest or missing `imagePullSecret` | `eve env diagnose`. |
| `app_crash_loop` | App process exits on start | `eve env logs <svc> --previous`. |
| `readiness_timeout` | Pods up but not passing readiness probes | `eve env diagnose`. |
| `dependency_timeout` | `depends_on` service didn't become healthy | `eve env logs <dep>`. |
| `ingress_conflict` | Another env already owns the hostname | `eve domain list` + `eve domain transfer`. |

## Custom Domain Ownership

Custom domains can be declared at `services.<svc>.x-eve.ingress.domains` or in
environment overrides at
`environments.<env>.overrides.services.<svc>.x-eve.ingress.domains`.
`eve project sync` registers manifest-managed domains. A domain declared in
exactly one environment override is bound to that environment during sync, so
the first deploy of that env can render its Ingress without a wrapper script.

Custom domains are owned by **exactly one environment at a time**. Top-level
domains keep first-bind-wins behavior: the first env to deploy with the
hostname owns it. Subsequent deploys of other envs that reference the same
hostname log `owned by environment "<A>" — skipping` and leave the owning env's
ingress alone. Imperative reservations use:

```bash
eve domain register api.example.com --project <project> --service api --env staging
```

`eve domain status api.example.com --json` exposes stable `owner_env`,
`dns_state`, `cert_state`, and `last_verified_at` fields for scripts.

To move ownership deliberately:

```bash
eve domain list                                       # see hostname → env mapping
eve domain transfer api.example.com --to staging      # DB-only ownership move
eve env deploy production                             # removes stale ingress from losing env
eve env deploy staging                                # creates new ingress in new owner's ns
```

`eve domain unbind <hostname>` clears the env binding without picking a new
owner — the next deploy that declares the hostname claims it.

## Manifest Resolution for Deploys

`eve env deploy --ref <sha>` resolves the pipeline's manifest from the ref:

1. If the ref has been previously synced (`eve project sync --ref <sha>` or an
   earlier deploy of that ref), the pipeline run binds to that ref's manifest.
2. Otherwise it falls back to the project's latest manifest AND the worker's
   post-clone check compares the workspace's expanded manifest hash with the
   pipeline's frozen hash. Workflow `$ref` entries and `agent.prompt_file`
   prompts are expanded before hashing, matching `eve project sync`.
3. On mismatch the deploy fails with `ManifestDrift` and a
   `Run \`eve project sync --ref <sha>\` from a checkout of that ref` hint —
   no silent stale deploys.

## Legacy / Removed

- None.
