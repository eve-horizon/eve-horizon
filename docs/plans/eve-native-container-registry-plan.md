# Eve-Native Container Registry Plan

> Status: Draft
> Last Updated: 2026-02-11
> Purpose: Provide an Eve-managed container registry backed by cloud object storage so that Eve-compatible apps don't need their own registry.

## Problem Statement

Today every Eve project that deploys containers must:

1. **Provision a registry** — GHCR, ECR, Docker Hub, or another OCI-compatible registry.
2. **Create and rotate credentials** — GitHub PATs with correct scopes, ECR tokens, etc.
3. **Configure secrets in Eve** — `GHCR_USERNAME`, `GHCR_TOKEN` / `GITHUB_TOKEN`.
4. **Specify registry config in the manifest** — `registry.host`, `registry.namespace`, `registry.auth.*`.
5. **Manage image retention** — manually or through external tooling.

This is significant friction, especially for:
- **New users** who want fast time-to-deploy without understanding Docker registries.
- **Agents-only or simple app projects** where the service is a single container.
- **Teams on Eve's managed platform** who shouldn't need to maintain registry infrastructure.

Meanwhile, cloud object storage (S3, GCS, MinIO) is dirt cheap ($0.023/GB/month on S3), highly durable, and something Eve already has access to for its own infrastructure.

## Goals

- Zero-config image storage for Eve projects that opt in.
- No user-managed registry credentials for the default path.
- Backward-compatible — projects with `registry.host` configured keep working unchanged.
- Works across local dev (k3d), staging, and production deployments.
- Builds on proven OCI standards (Distribution registry, standard Docker pull/push).

## Non-Goals

- Replacing all external registries (BYO registry remains fully supported).
- Multi-region replication or CDN-level edge caching (future).
- Public image hosting (all images are scoped to an org, no anonymous pull).
- Full supply-chain policy enforcement or vulnerability scanning (future add-on).

## Background: How Deploys Work Today

Infrastructure has been extracted into a two-repo model (as of v0.1.86):

```
eve-horizon-2 (this repo)                 infra repo (e.g. deployment-instance-repo)
──────────────────────────                 ────────────────────────────────────
1. publish-images.yml                      3. deploy.yml (triggered by dispatch)
   ├─ Builds 5 platform images                ├─ Applies Kustomize overlay
   ├─ Pushes to ghcr.io/eve-horizon           ├─ Waits for rollouts
   └─ Fires repository_dispatch ──────────→   └─ Runs health check
2. k8s/base/ (shared manifests)            4. k8s/overlays/{env}/ (env patches)
                                           5. terraform/aws/ (infra provisioning)
```

**User app images** follow a separate path — the Eve worker builds and pushes them during pipeline execution:

```
User's Manifest           Worker Build                 Deploy
───────────────           ────────────                 ──────
registry:                 BuildKit/Buildx              K8s Deployer
  host: ghcr.io           ──push──→ ghcr.io            ──pull──→ ghcr.io
  namespace: acme                   (user's registry)             (user's registry)
  auth:                   Tags: sha-<commit>           Refs: image@sha256:...
    username_secret: ...  Digests: BuildArtifacts       ImagePullSecret: eve-registry
    token_secret: ...     ↓                             (from user's GHCR_TOKEN)
                          Release.image_digests_json
```

Key integration points (see `docs/system/container-registry.md`, `docs/system/builds.md`):

- **Manifest schema**: `registry` is `z.record(z.unknown()).optional()` in `packages/shared/src/schemas/manifest.ts`
- **Registry auth resolution**: `apps/worker/src/builder/registry-auth.service.ts` resolves credentials from project secrets
- **Image builder**: `apps/worker/src/builder/image-builder.service.ts` computes image refs and delegates to backends
- **ImagePullSecret**: `apps/worker/src/deployer/deployer.service.ts` creates K8s docker-registry secrets
- **Image ref resolution**: `apps/worker/src/deployer/deployer.service.ts` resolves digest/tag/fallback

**Important distinction**: This plan covers the registry for **user app images** (built by the worker during pipeline execution). Platform images (api, worker, orchestrator, etc.) continue to be published to GHCR via `publish-images.yml` — they are not affected by this plan.

## Proposed Design

### Architecture Overview

```
User's Manifest           Build                        Eve Registry              Cloud Storage
───────────────           ─────                        ────────────              ─────────────
registry: eve             BuildKit/Buildx              Distribution (OCI)        S3 / GCS / MinIO
  (or omitted)            ──push──→ registry.eve.host  ──layers──→ bucket
                          Auth: Eve-issued token       ──manifests──→ bucket
                          Tag: sha-<commit>
                                                       ←──pull───  K8s kubelet
                                                       Auth: Eve-issued token
                                                       ImagePullSecret: auto
```

The core idea: Eve runs an instance of [Distribution](https://github.com/distribution/distribution) (the reference OCI registry implementation used by Docker Hub, GHCR, GitLab, and most self-hosted registries) as a platform service. Image layers and manifests are stored in cloud object storage. Eve handles all auth.

### Image Namespace Convention

```
registry.{eve-domain}/{org_slug}/{project_slug}/{service_name}:{tag}
registry.{eve-domain}/{org_slug}/{project_slug}/{service_name}@sha256:...
```

Examples:
```
registry.eve.example.com/acme/fstack/api:sha-a1b2c3d4e5f6
registry.eve.example.com/acme/fstack/api@sha256:abc123...
registry.eve.example.com/acme/fstack/web:v1.0.0
```

### Manifest Experience

**Option A — Explicit opt-in (recommended for Phase 1):**

```yaml
registry: eve
# That's it. No host, namespace, or auth needed.

services:
  api:
    image: api                            # Short name, Eve prefixes automatically
    build:
      context: ./apps/api
```

**Option B — Default when omitted (Phase 2):**

```yaml
# No registry section at all → uses Eve-native by default
services:
  api:
    image: api
    build:
      context: ./apps/api
```

**BYO registry still works (unchanged):**

```yaml
registry:
  host: ghcr.io
  namespace: acme
  auth:
    username_secret: GHCR_USERNAME
    token_secret: GHCR_TOKEN
```

### Auth Model

Eve issues short-lived, scoped tokens using the [Docker Token Authentication](https://docs.docker.com/registry/spec/auth/token/) protocol. No user-managed credentials.

**Build-time (push):**
1. Worker starts a build for project P in org O.
2. Worker requests a push-scoped token from Eve API: `scope=repository:O/P/*:push,pull`.
3. Eve API validates the caller is an authorized worker, issues a JWT (5-minute TTL).
4. Worker passes the token to BuildKit/Buildx as Docker config JSON.
5. BuildKit pushes layers + manifest to Distribution, which validates the JWT.

**Deploy-time (pull):**
1. Deployer creates an ImagePullSecret for the environment namespace.
2. Instead of resolving user-provided GHCR credentials, it requests a pull-scoped token from Eve API.
3. Eve API issues a longer-lived JWT (1-hour TTL, auto-refreshed by a sidecar or CronJob).
4. The ImagePullSecret is created with the Eve-issued token.
5. kubelet pulls from the Eve registry using standard Docker auth.

**Token structure:**
```json
{
  "sub": "eve-worker",
  "aud": "registry.eve.{domain}",
  "iss": "eve-api",
  "access": [
    {
      "type": "repository",
      "name": "{org_slug}/{project_slug}/{service}",
      "actions": ["push", "pull"]
    }
  ],
  "exp": 1700000300,
  "iat": 1700000000
}
```

### Storage Backend

Distribution natively supports pluggable storage drivers:

| Backend | When to use | Notes |
|---------|-------------|-------|
| **S3** | AWS deployments (primary) | IAM role auth, no static keys |
| **GCS** | GCP deployments | Service account auth |
| **MinIO** | Self-hosted / air-gapped | S3-compatible, runs in-cluster |
| **Filesystem** | Local dev (k3d) | PVC-backed, simplest option |

**Example Distribution config (S3):**

```yaml
storage:
  s3:
    region: us-west-2
    bucket: eve-registry-staging
    rootdirectory: /images
    # IAM role on EC2/EKS — no static credentials
  cache:
    blobdescriptor: inmemory
  delete:
    enabled: true
  maintenance:
    uploadpurging:
      enabled: true
      age: 168h        # 7 days for incomplete uploads
```

**Cost estimate:**

| Scenario | Storage | Monthly Cost (S3) |
|----------|---------|--------------------|
| Small team (5 projects, ~5GB) | 5 GB | ~$0.12 |
| Medium team (20 projects, ~50GB) | 50 GB | ~$1.15 |
| Large org (100 projects, ~500GB) | 500 GB | ~$11.50 |

Layer deduplication means shared base images (node, python, etc.) are stored once across all projects.

### Garbage Collection & Retention

Distribution has built-in GC. Eve wraps it with project-aware policies:

```yaml
# Eve platform config (not per-project)
eve_registry:
  retention:
    untagged_ttl: 7d               # Delete unreferenced manifests after 7 days
    max_tags_per_repo: 50           # Keep last 50 tags, prune oldest
    min_age_before_gc: 24h          # Never GC anything less than 24h old
  gc:
    schedule: "0 3 * * *"           # Run daily at 3am
    dry_run: false
```

Per-project overrides (future):
```yaml
# In x-eve.yaml
registry:
  eve:
    retention:
      max_tags: 100                 # Override for this project
```

## Implementation Plan

### Phase 1: Platform Registry Service

**Goal**: Run Distribution as a platform service, wire it into the build pipeline.

**Tasks:**

1. **K8s manifest for Distribution** (`k8s/base/registry-deployment.yaml`)
   - Deployment with 1 replica, Distribution v2 image
   - ConfigMap for Distribution config (storage backend, auth)
   - Service exposing port 5000
   - Ingress at `registry.{domain}` with TLS

2. **Storage backend provisioning** (in infra repo template)
   - Terraform module: S3 bucket (`eve-registry-{env}`) with IAM policy for EC2 role
   - K3d local: PVC-backed filesystem storage (or MinIO addon)
   - Kustomize overlay patches: S3 config for AWS, filesystem for local

3. **Manifest schema update** (`packages/shared/src/schemas/manifest.ts`)
   - Support `registry: "eve"` as a string literal (alongside the existing object form)
   - `getRegistryConfig()` returns a well-known Eve registry config when value is `"eve"`

4. **Registry auth service update** (`apps/worker/src/builder/registry-auth.service.ts`)
   - When registry is `eve`, generate a push-scoped token from Eve API instead of resolving user secrets
   - Token endpoint: `POST /internal/registry/token` (worker → API)

5. **Image builder update** (`apps/worker/src/builder/image-builder.service.ts`)
   - When registry is `eve`, compute image ref as `registry.{domain}/{org}/{project}/{service}`
   - Pass Eve-issued Docker config to build backend

6. **Deployer update** (`apps/worker/src/deployer/deployer.service.ts`)
   - `ensureImagePullSecret()`: when registry is `eve`, request a pull-scoped token from Eve API
   - Create ImagePullSecret with Eve-issued credentials instead of user-provided ones

**Files touched (this repo — `eve-horizon-2`):**
- `k8s/base/registry-deployment.yaml` (new — base manifest for Distribution)
- `packages/shared/src/schemas/manifest.ts` (schema change)
- `apps/api/src/internal/registry-token.controller.ts` (new — token endpoint)
- `apps/worker/src/builder/registry-auth.service.ts` (Eve registry path)
- `apps/worker/src/builder/image-builder.service.ts` (image ref computation)
- `apps/worker/src/deployer/deployer.service.ts` (pull secret for Eve registry)

**Files touched (infra repo template — `eve-horizon-infra`):**
- `k8s/overlays/{env}/registry-config-patch.yaml` (new — S3/storage backend config per environment)
- `terraform/aws/modules/registry/` (new module — S3 bucket + IAM)
- `terraform/aws/main.tf` (add registry module)

### Phase 2: Token Auth Service

**Goal**: Secure the registry with Eve-issued JWTs scoped to org/project.

**Tasks:**

1. **Token endpoint** (`apps/api/src/internal/registry-token.controller.ts`)
   - `POST /internal/registry/token` — called by worker
   - Input: `{ scope: "repository:org/project/service:push,pull", service: "eve-registry" }`
   - Output: `{ token: "<jwt>", expires_in: 300 }`
   - Validates caller is an authenticated Eve worker (internal API key)
   - Signs JWT with a registry-specific signing key (`EVE_REGISTRY_SIGNING_KEY`)

2. **Distribution auth config**
   ```yaml
   auth:
     token:
       realm: https://api.{domain}/internal/registry/token
       service: eve-registry
       issuer: eve-api
       rootcertbundle: /etc/registry/signing-cert.pem
   ```

3. **Signing key management**
   - RSA key pair generated at platform setup
   - Private key in Eve API (signs tokens)
   - Public cert mounted into Distribution (validates tokens)
   - Stored as K8s Secret, rotatable

### Phase 3: Local Dev Integration

**Goal**: Make `registry: eve` work seamlessly in k3d local development.

**Tasks:**

1. **In-cluster registry for k3d**
   - k3d natively supports registry mirrors and local registries
   - Add `k3d-registry.yaml` config that creates `k3d-registry.localhost:5000`
   - Distribution runs in-cluster with filesystem storage (PVC)
   - Update `./bin/eh k8s start` to configure k3d registry mirror

2. **Build shortcut** — skip push/pull for local dev
   - When `EVE_RUNTIME=k8s` and registry is local, use k3d image import as fast path
   - Fallback to push/pull through local registry for full pipeline testing

3. **CLI experience**
   ```bash
   # No registry config needed — just works
   eve build create --project my-proj --ref HEAD
   eve build run <build_id>
   eve env deploy test --ref HEAD --direct
   ```

### Phase 4: GC, Retention & Observability

**Goal**: Automated image lifecycle management.

**Tasks:**

1. **Garbage collection CronJob** (`k8s/base/registry-gc-cronjob.yaml`)
   - Runs Distribution GC on schedule
   - Deletes unreferenced layers and untagged manifests
   - Emits metrics/logs for cleanup stats

2. **Tag retention policy**
   - Eve API exposes `GET /internal/registry/repos/{org}/{project}/{service}/tags`
   - CronJob prunes tags exceeding `max_tags_per_repo` (oldest first, never delete digests referenced by releases)

3. **CLI commands**
   ```bash
   eve registry list                          # List repos in current project
   eve registry tags <service>                # List tags for a service
   eve registry gc --dry-run                  # Preview what would be cleaned
   eve registry stats                         # Storage usage per project
   ```

4. **Observability**
   - Distribution exposes Prometheus metrics at `/metrics`
   - Scrape via existing OTEL collector
   - Dashboard: push/pull rates, storage usage, error rates

### Phase 5: Default Registry (Optional)

**Goal**: Make Eve-native registry the default when no `registry` section is specified.

**Tasks:**
- Update `getRegistryConfig()` to return Eve registry config when `registry` is `undefined`
- Migration path: existing projects without registry config currently assume public images — add a `registry: none` escape hatch
- Update docs and manifest validation

## Migration Path

| Project State | Behavior |
|---------------|----------|
| `registry: { host: "ghcr.io", ... }` | Unchanged — BYO registry |
| `registry: eve` | Uses Eve-native registry (Phase 1) |
| No `registry` section | Phase 1-4: assumes public images (current behavior). Phase 5: defaults to Eve registry |
| `registry: none` | Explicit opt-out — assumes public images or pre-configured cluster auth |

Existing projects are never broken. `registry: eve` is opt-in until Phase 5.

## Key Design Decisions

### Why Distribution (not a custom OCI store)?

Distribution is the reference OCI registry implementation. Docker Hub, GHCR, GitLab Container Registry, and Harbor all use it. It:
- Implements the full OCI Distribution Spec (push, pull, manifests, blobs, tags)
- Has native S3/GCS/Azure storage drivers
- Supports Docker token auth protocol out of the box
- Handles content-addressable deduplication at the layer level
- Is battle-tested at massive scale

Building a custom OCI store on S3 (e.g., using ORAS or crane) would require reimplementing catalog, manifest resolution, layer streaming, and auth — for no practical benefit.

### Why not a managed registry (ECR/GAR/ACR)?

- **Cloud lock-in**: ECR is AWS-only, GAR is GCP-only.
- **Credential complexity**: ECR tokens expire every 12 hours, require `aws ecr get-login-password`.
- **Cost**: Managed registries charge per-image pricing on top of storage. S3 is just storage.
- **Control**: Eve manages the full lifecycle — creation, auth, GC, retention — without external dependencies.
- **Self-hosted parity**: MinIO + Distribution works identically for on-prem / air-gapped Eve deployments.

### Why short-lived JWTs (not static tokens)?

- Limits blast radius if a token is leaked.
- Scoped to specific repositories (org/project/service) — no lateral access.
- No secrets to rotate or manage per user.
- Aligns with Eve's existing internal API key model for worker authentication.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Distribution availability (single replica) | Health checks + restart policy. Future: 2 replicas behind LB. Registry downtime doesn't affect running workloads, only builds/deploys. |
| S3 egress costs on frequent pulls | Layer caching on k8s nodes (containerd). Most pulls are cache hits after first deploy. |
| Storage growth without bounds | GC CronJob + tag retention policy. Release-referenced digests are protected. |
| Token signing key compromise | Key rotation procedure. Short TTLs limit exposure. Revocation via Distribution restart with new cert. |
| Multi-cluster deployments (future) | Registry is internet-facing with TLS + auth. External clusters can pull with Eve-issued tokens. |
| Local dev latency (push/pull to remote) | k3d local registry runs in-cluster. No network round-trip for local builds. |

## Acceptance Criteria

- [ ] `registry: eve` in a manifest causes builds to push to the Eve-native registry
- [ ] Deploys from Eve registry succeed without any user-provided registry credentials
- [ ] BYO registry (`registry.host: ghcr.io`) continues to work unchanged
- [ ] Local dev (k3d) builds and deploys work with Eve registry
- [ ] GC runs on schedule and reclaims unreferenced layers
- [ ] `eve registry list` and `eve registry tags` show project images
- [ ] Storage usage is visible via CLI or API

## Related

- [container-registry.md](../system/container-registry.md) — Current registry documentation
- [builds-first-class-primitive-plan.md](./builds-first-class-primitive-plan.md) — Build system design
- [pipeline-build-and-registry-push-plan.md](./pipeline-build-and-registry-push-plan.md) — Build pipeline implementation
- [deployment.md](../system/deployment.md) — Deployment architecture
- [staging.md](../deploy/staging.md) — Staging environment (two-repo model)
- [aws.md](../deploy/aws.md) — AWS deployment via infra template repo
- [managed-postgres-dbaas-plan.md](./managed-postgres-dbaas-plan.md) — Managed Postgres (sibling platform service)
