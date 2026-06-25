# Client Deployment Strategy & Infrastructure Extraction Plan

> Status: Draft
> Last Updated: 2026-02-10
> Purpose: Decouple Eve platform deployment infrastructure from the source repository, establish a
> neutral container registry namespace, and create a reusable infra template that enables independent
> client deployments on any supported cloud.

## Problem Statement

Eve Horizon's source code, build infrastructure, and deployment infrastructure all live in a single
private repository (`eve-horizon/eve-horizon`). This creates three problems as we onboard external clients:

1. **Registry coupling** — Container images previously published to `ghcr.io/example/*`. Now migrated
   to `ghcr.io/eve-horizon/*`. Clients pull from the neutral namespace.

2. **Source access required for deployment** — The k8s manifests, Terraform modules, and deployment
   CI all live in the source repo. Deploying Eve requires cloning a repo that also contains all
   proprietary source code.

3. **No client isolation** — the platform operator's staging deployment is hardcoded into the source repo's CI.
   There's no pattern for standing up independent deployments with their own versioning, CI, secrets,
   and domain configuration.

## Goals

- Container images published to a neutral, vendor-independent registry namespace.
- A public infra template repo that contains everything needed to deploy Eve without source access.
- Each deployment is a self-contained repo with its own CI, secrets, versioning, and domain.
- GCP support as a first-class overlay alongside existing AWS.
- the platform operator's own staging deployment migrates to the same pattern (no special snowflake).
- Source repo becomes purely about building Eve; deploying it is always done from an infra repo.

## Non-Goals

- Eve-native container registry (covered by `eve-native-container-registry-plan.md` — complementary,
  not blocking).
- Multi-region or HA deployment patterns (future).
- Managed SaaS offering with automated client provisioning (future).
- Helm charts (Kustomize remains the packaging tool).

## Current State

### Repository Layout

```
eve-horizon/eve-horizon (private)
├── apps/              ← source code + Dockerfiles
├── packages/          ← shared libraries
├── k8s/
│   ├── base/          ← canonical k8s manifests (deployments, services, RBAC, etc.)
│   └── overlays/
│       ├── local/     ← k3d development
│       ├── staging/   ← example staging (AWS)
│       └── aws/       ← generic AWS template
├── terraform/
│   └── staging/       ← example staging infra (VPC, EC2, RDS, DNS)
├── docker/compose/    ← local development
├── .github/workflows/
│   ├── ci.yml                ← test
│   ├── deploy-staging.yml    ← build images + deploy to staging (coupled)
│   ├── worker-images.yml     ← publish worker variants
│   └── publish-migrate.yml   ← publish migration image
└── bin/eh             ← developer + operator CLI
```

### Image References

- All files have been migrated from `ghcr.io/example/` to `ghcr.io/eve-horizon/`.
- Image names: `eve-horizon-api`, `eve-horizon-gateway`, `eve-horizon-orchestrator`,
  `eve-horizon-worker`, `eve-horizon-agent-runtime`, `eve-migrate`, `eve-worker-{variant}`.

### Deployment CI

`deploy-staging.yml` currently does both build AND deploy in one workflow:
1. Build 5 service images (matrix) → push to GHCR
2. Update overlay image tags via sed
3. Run migrations → apply kustomize → rollout wait → health check

This coupling means deploying requires the source repo.

## Proposed Design

### Architecture Overview

```
eve-horizon/eve-horizon (private, source)
│
│  builds + publishes images
│  ─────────────────────────→  ghcr.io/eve-horizon/*
│
│  syncs base manifests per release
│  ─────────────────────────→  eve-horizon/eve-horizon-infra (public, template)
│                                  │
│                                  │  copied/forked per deployment
│                                  ├──→ example/deployment-instance-repo (private)
│                                  │    └── deploys to AWS (eve.example.com)
│                                  │
│                                  └──→ {client}/{client}-eve-infra (private)
│                                       └── deploys to client's cloud + domain
```

### Three-Layer Separation

| Layer | Repository | Contains | Access |
|-------|-----------|----------|--------|
| **Source** | `eve-horizon/eve-horizon` | Application code, Dockerfiles, local dev stack, tests, build CI | Private (the platform operator only) |
| **Infra template** | `eve-horizon/eve-horizon-infra` | k8s base + overlays, Terraform modules, deploy CI, operational CLI | Public |
| **Deployment instance** | `{org}/{name}-eve-infra` | Instance-specific config, secrets refs, domain, version pin | Private (owner-controlled) |

### 1. Neutral Registry Namespace

Create a GitHub org `eve-horizon`. Publish all platform images there with simplified names:

```
ghcr.io/eve-horizon/api:{version}
ghcr.io/eve-horizon/gateway:{version}
ghcr.io/eve-horizon/orchestrator:{version}
ghcr.io/eve-horizon/worker:{version}
ghcr.io/eve-horizon/agent-runtime:{version}
ghcr.io/eve-horizon/migrate:{version}
ghcr.io/eve-horizon/worker-full:{version}
ghcr.io/eve-horizon/worker-python:{version}
ghcr.io/eve-horizon/worker-rust:{version}
ghcr.io/eve-horizon/worker-java:{version}
ghcr.io/eve-horizon/worker-kotlin:{version}
```

The `eve-horizon-` prefix is dropped from image names — the org already provides the namespace.

**Tagging strategy** (unchanged):
- `v0.1.28` — semantic version
- `sha-a1b2c3d4e5f6` — commit SHA
- `latest` — most recent release

**Auth**: Source repo CI authenticates with a PAT that has `packages:write` scope on the
`eve-horizon` org. Deployment instance repos authenticate with read-only PATs or fine-grained
tokens with `packages:read` scope.

### 2. Source Repo Changes

After extraction, the source repo retains only what developers need:

```
eve-horizon/eve-horizon (post-extraction)
├── apps/              ← unchanged
├── packages/          ← unchanged
├── k8s/
│   ├── base/          ← STAYS (canonical, used by local overlay)
│   └── overlays/
│       └── local/     ← STAYS (k3d development)
│       (staging/ removed)
│       (aws/ removed)
├── docker/compose/    ← unchanged
├── terraform/         ← REMOVED (moves to infra template)
├── .github/workflows/
│   ├── ci.yml                ← unchanged
│   ├── publish-images.yml    ← NEW (build + push only, replaces deploy-staging.yml)
│   ├── worker-images.yml     ← updated (new registry namespace)
│   └── publish-migrate.yml   ← updated (new registry namespace)
└── bin/eh             ← simplified (remove staging/deploy commands)
```

**`publish-images.yml`** replaces `deploy-staging.yml`. It:
1. Builds images (same matrix)
2. Pushes to `ghcr.io/eve-horizon/*`
3. Optionally triggers deploy in downstream infra repos via `repository_dispatch`
4. Does NOT deploy anything itself

### 3. Infra Template Repo

```
eve-horizon/eve-horizon-infra
├── .github/
│   └── workflows/
│       ├── deploy.yml              # Deploy on tag push (deploy-v0.1.28)
│       ├── health-check.yml        # Scheduled health checks (cron)
│       └── upgrade-check.yml       # Check for new platform versions (cron)
├── k8s/
│   ├── base/                       # Base manifests (synced from source per release)
│   │   ├── api-deployment.yaml
│   │   ├── api-service.yaml
│   │   ├── orchestrator-deployment.yaml
│   │   ├── worker-deployment.yaml
│   │   ├── gateway-deployment.yaml
│   │   ├── agent-runtime-statefulset.yaml
│   │   ├── ... (all base manifests)
│   │   └── kustomization.yaml
│   └── overlays/
│       ├── aws/                    # AWS-specific patches
│       │   ├── kustomization.yaml
│       │   ├── *-deployment-patch.yaml
│       │   ├── *-ingress-patch.yaml
│       │   ├── remove-postgres.yaml
│       │   ├── cluster-issuer.yaml
│       │   └── db-migrate-job.yaml
│       └── gcp/                    # GCP-specific patches
│           ├── kustomization.yaml
│           ├── *-deployment-patch.yaml
│           ├── *-ingress-patch.yaml
│           ├── remove-postgres.yaml
│           ├── cluster-issuer.yaml
│           └── db-migrate-job.yaml
├── terraform/
│   ├── aws/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   ├── terraform.tfvars.example
│   │   └── modules/
│   │       ├── network/            # VPC, subnets, routing
│   │       ├── compute/            # EC2 + k3s (or EKS)
│   │       ├── database/           # RDS PostgreSQL
│   │       ├── dns/                # Route53
│   │       └── security/           # Security groups, IAM, SSH
│   └── gcp/
│       ├── main.tf
│       ├── variables.tf
│       ├── outputs.tf
│       ├── terraform.tfvars.example
│       └── modules/
│           ├── network/            # VPC, subnets, firewall rules
│           ├── compute/            # GCE + k3s (or GKE)
│           ├── database/           # Cloud SQL PostgreSQL
│           ├── dns/                # Cloud DNS
│           └── security/           # Firewall, IAM, service accounts
├── bin/
│   └── eve-infra                   # Operational CLI
├── config/
│   ├── platform.yaml              # Platform configuration (see below)
│   └── secrets.env.example        # Required secrets template
├── scripts/
│   ├── setup.sh                   # First-time cluster setup
│   ├── upgrade.sh                 # Upgrade platform version
│   ├── backup.sh                  # Database backup
│   └── health-check.sh           # Verify deployment health
├── DEPLOYMENT.md                  # Operations guide
├── UPGRADE.md                     # Version upgrade procedures
└── README.md                      # Getting started
```

### 4. Platform Configuration (`config/platform.yaml`)

Each deployment instance is driven by a single config file:

```yaml
# Platform identity
platform:
  version: "0.1.28"                    # Pinned Eve platform version
  registry: "ghcr.io/eve-horizon"      # Image registry (neutral)

# Cloud and infrastructure
cloud: aws                              # aws | gcp
region: eu-west-1                       # Cloud region

# Domain configuration
domain: eve.example.com                 # Base domain
api_host: api.eve.example.com           # API endpoint
app_domain: apps.example.com            # Deployed app wildcard domain

# TLS
tls:
  provider: cert-manager
  issuer: letsencrypt-prod
  email: ops@example.com

# Database
database:
  provider: rds                         # rds | cloud-sql | external
  instance_class: db.t3.micro           # Cloud-specific instance type

# Compute
compute:
  type: m6i.xlarge                      # Cloud-specific instance type
  disk_size_gb: 50

# Overlay selection (derived from cloud, but can be overridden)
overlay: aws                            # Maps to k8s/overlays/{overlay}
```

The deploy workflow reads this file and:
1. Resolves the overlay directory
2. Patches image tags to match `platform.version`
3. Applies kustomize
4. Runs migrations
5. Waits for rollout
6. Health checks

### 5. Deployment CI (`deploy.yml`)

```yaml
name: Deploy Eve Platform
on:
  push:
    tags: ["deploy-v*"]
  workflow_dispatch:
    inputs:
      version:
        description: "Platform version to deploy"
        required: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Read platform config
        id: config
        run: |
          VERSION=${GITHUB_REF#refs/tags/deploy-v}
          # Or from workflow_dispatch input
          # Parse config/platform.yaml for cloud, overlay, registry, domain

      - name: Update image tags
        run: |
          # Patch k8s/overlays/$OVERLAY/*-patch.yaml with version

      - name: Configure kubectl
        run: |
          echo "${{ secrets.KUBECONFIG }}" | base64 -d > kubeconfig.yaml

      - name: Run database migrations
        run: |
          kubectl apply -f k8s/overlays/$OVERLAY/db-migrate-job.yaml
          kubectl wait --for=condition=complete job/db-migrate --timeout=120s

      - name: Apply manifests
        run: |
          kubectl apply -k k8s/overlays/$OVERLAY

      - name: Wait for rollout
        run: |
          for svc in api orchestrator worker agent-runtime gateway; do
            kubectl rollout status deployment/$svc-deployment --timeout=120s
          done

      - name: Health check
        run: |
          curl -sf https://$API_HOST/health || exit 1
```

**Secrets required per deployment repo** (GitHub Actions secrets):
- `KUBECONFIG` — base64-encoded kubeconfig for the target cluster
- `REGISTRY_TOKEN` — read-only PAT for `ghcr.io/eve-horizon` packages
- (Optional) `SLACK_WEBHOOK` — deploy notifications

All Eve application secrets (`EVE_SECRETS_MASTER_KEY`, `DATABASE_URL`, etc.) are managed in-cluster
via `kubectl create secret`, NOT in GitHub Actions.

### 6. Operational CLI (`bin/eve-infra`)

A lightweight bash CLI for day-to-day operations:

```bash
eve-infra status              # Show platform version, service health, pod status
eve-infra version             # Show current + latest available version
eve-infra upgrade <version>   # Update platform.yaml, patch overlays, commit
eve-infra deploy              # Apply current config (same as CI but manual)
eve-infra secrets sync        # Push secrets.env → k8s eve-app secret
eve-infra secrets show        # Show which secrets are configured
eve-infra db migrate          # Run migration job
eve-infra db backup           # Trigger database backup
eve-infra db connect          # Open psql session (via port-forward)
eve-infra logs <service>      # Tail logs (api, worker, orchestrator, gateway, agent-runtime)
eve-infra restart <service>   # Rolling restart of a service
eve-infra health              # Run health checks
```

Reads config from `config/platform.yaml` and kubeconfig from `~/.kube/eve-{instance}.yaml`
(or `KUBECONFIG` env var).

### 7. GCP Terraform Modules

Parallel to the existing AWS modules, targeting k3s on GCE (consistent with the AWS pattern):

```
terraform/gcp/modules/
├── network/
│   ├── main.tf          # VPC, subnet, Cloud Router, Cloud NAT
│   ├── variables.tf     # vpc_cidr, region
│   └── outputs.tf       # vpc_id, subnet_id
├── compute/
│   ├── main.tf          # GCE instance, startup script (k3s install)
│   ├── variables.tf     # machine_type, disk_size, ssh_key
│   └── outputs.tf       # instance_ip, ssh_command
├── database/
│   ├── main.tf          # Cloud SQL PostgreSQL instance
│   ├── variables.tf     # tier, db_version, backup_config
│   └── outputs.tf       # connection_name, ip, database_url
├── dns/
│   ├── main.tf          # Cloud DNS zone + records
│   ├── variables.tf     # domain, zone_name
│   └── outputs.tf       # nameservers
└── security/
    ├── main.tf          # Firewall rules, service account, IAM bindings
    ├── variables.tf     # allowed_ssh_cidrs, service_account_roles
    └── outputs.tf       # service_account_email
```

**Outputs** (same shape as AWS for consistency):
```
instance_ip       = "34.89.xx.xx"
database_url      = "postgresql://eve:***@10.x.x.x:5432/eve"
ssh_command        = "gcloud compute ssh eve-k3s --zone europe-west1-b"
api_url           = "https://api.eve.example.com"
kubeconfig_cmd    = "scp eve-k3s:/etc/rancher/k3s/k3s.yaml ~/.kube/eve-instance.yaml"
```

### 8. Sync Process (Source → Infra Template)

When a new Eve version is released, `k8s/base/` in the infra template must be updated to match.

**Mechanism**: A sync script (or skill) in the source repo that:

1. Copies `k8s/base/*` from the source repo into a checkout of the infra template
2. Updates the default version in `config/platform.yaml`
3. Commits and tags the infra template

This runs as part of the release process:

```
Source repo: merge to main → tag release-v0.1.29
  → CI: build images → push to ghcr.io/eve-horizon/*:0.1.29
  → CI: trigger sync workflow
      → checkout eve-horizon-infra
      → copy k8s/base/ from source
      → update config/platform.yaml default version
      → commit + tag infra-v0.1.29
      → push
```

**Why copy, not submodule**: Deployment repos fork/copy the infra template and own it. Submodules
require access to the source repo. Copies are self-contained and version-pinned — the same
model as `eve-horizon-starter`.

### 9. Deployment Instantiation Flow

```bash
# 1. Create deployment repo from template
gh repo create {org}/{name}-eve-infra \
  --template eve-horizon/eve-horizon-infra --private

# 2. Clone and configure
cd {name}-eve-infra
# Edit config/platform.yaml (domain, cloud, region, version)
# Copy secrets.env.example → secrets.env and fill in values

# 3. Provision infrastructure
cd terraform/{cloud}
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars (region, domain, ssh_key, db_password, etc.)
terraform init && terraform plan && terraform apply

# 4. Configure cluster access
# Use terraform output to get kubeconfig
# e.g.: scp eve-k3s:/etc/rancher/k3s/k3s.yaml ~/.kube/eve-instance.yaml

# 5. Create cluster secrets
./bin/eve-infra secrets sync   # Pushes secrets.env → k8s

# 6. Create registry pull secret
kubectl create secret docker-registry eve-registry \
  --docker-server=ghcr.io \
  --docker-username=eve-horizon-pull \
  --docker-password=$REGISTRY_TOKEN \
  -n eve

# 7. Deploy
git tag deploy-v0.1.28
git push origin deploy-v0.1.28
# GitHub Actions handles: migrate → apply → rollout → health check

# 8. Verify
./bin/eve-infra health
curl https://api.eve.example.com/health
```

### 10. Upgrade Flow

When a new Eve version is available:

```bash
# Option A: Manual upgrade
./bin/eve-infra upgrade 0.1.29
# Updates config/platform.yaml, patches overlay image tags
# Commits the change
git tag deploy-v0.1.29 && git push origin deploy-v0.1.29

# Option B: Merge from upstream template
git remote add upstream https://github.com/eve-horizon/eve-horizon-infra
git fetch upstream
git merge upstream/infra-v0.1.29
# Resolve any conflicts in overlays (local customizations preserved)
git tag deploy-v0.1.29 && git push origin deploy-v0.1.29

# Option C: Automated (upgrade-check.yml cron)
# CI detects new version → opens PR → human reviews and merges → auto-deploys
```

### 11. the platform operator Staging Migration

the platform operator's staging deployment becomes just another instance of the infra template:

```
example/deployment-instance-repo (private)
├── config/platform.yaml
│   cloud: aws
│   domain: eve.example.com
│   version: 0.1.28
├── k8s/overlays/aws/        # From template, customized
├── terraform/aws/            # From template, with example's tfvars
└── .github/workflows/
    └── deploy.yml            # Auto-deploy on tag (same as any deployment)
```

The current `deploy-staging.yml` in the source repo is retired. Build and deploy are fully
decoupled. A `repository_dispatch` from the source repo's build CI can trigger automatic
deployment in the example infra repo if desired.

### 12. New Skill: `eve-infra-bootstrap`

An agent skill for setting up a new deployment:

```
Skill: eve-infra-bootstrap

Inputs (gathered via conversation):
  - Deployment name / org
  - GitHub org for deployment repo
  - Cloud provider (aws | gcp)
  - Region
  - Domain
  - Platform version

Steps:
  1. Create repo from template (gh repo create --template)
  2. Edit config/platform.yaml with deployment values
  3. Generate terraform.tfvars from inputs
  4. Guide through terraform apply
  5. Configure kubeconfig
  6. Guide through secrets setup
  7. Create registry pull secret
  8. Run first deploy
  9. Health check
  10. Print summary (URLs, next steps)
```

## Implementation Plan

### Phase 1: Neutral Registry Namespace

**Goal**: All images publish to `ghcr.io/eve-horizon/*` with clean names.

**Tasks:**

1. Create `eve-horizon` GitHub org
2. Create a bot account or PAT with `packages:write` on the org
3. Update image names in all 27 files (mechanical find-and-replace):
   - `.github/workflows/deploy-staging.yml` → `publish-images.yml`
   - `.github/workflows/worker-images.yml`
   - `.github/workflows/publish-migrate.yml`
   - `k8s/overlays/staging/*-patch.yaml` (14 files)
   - `k8s/overlays/aws/*-patch.yaml`
   - `k8s/base/` (if any local image refs)
   - Documentation files (7)
   - `examples/fullstack-example/.eve/manifest.yaml`
4. Update `deploy-staging.yml` to use new registry credentials
5. Publish first set of images under new namespace
6. Update staging overlay to pull from new namespace
7. Verify staging deployment works with new image refs

**Naming convention:**

| Old | New |
|-----|-----|
| `ghcr.io/eve-horizon/eve-horizon-api` | `ghcr.io/eve-horizon/api` |
| `ghcr.io/eve-horizon/eve-horizon-gateway` | `ghcr.io/eve-horizon/gateway` |
| `ghcr.io/eve-horizon/eve-horizon-orchestrator` | `ghcr.io/eve-horizon/orchestrator` |
| `ghcr.io/eve-horizon/eve-horizon-worker` | `ghcr.io/eve-horizon/worker` |
| `ghcr.io/eve-horizon/eve-horizon-agent-runtime` | `ghcr.io/eve-horizon/agent-runtime` |
| `ghcr.io/eve-horizon/eve-migrate` | `ghcr.io/eve-horizon/migrate` |
| `ghcr.io/eve-horizon/eve-worker-full` | `ghcr.io/eve-horizon/worker-full` |
| `ghcr.io/eve-horizon/eve-worker-python` | `ghcr.io/eve-horizon/worker-python` |
| `ghcr.io/eve-horizon/eve-worker-rust` | `ghcr.io/eve-horizon/worker-rust` |
| `ghcr.io/eve-horizon/eve-worker-java` | `ghcr.io/eve-horizon/worker-java` |
| `ghcr.io/eve-horizon/eve-worker-kotlin` | `ghcr.io/eve-horizon/worker-kotlin` |

### Phase 2: Create Infra Template Repo

**Goal**: `eve-horizon/eve-horizon-infra` exists with AWS overlay working.

**Tasks:**

1. Create the repo under the `eve-horizon` org
2. Copy `k8s/base/` from source repo
3. Move `k8s/overlays/aws/` to infra repo (update image refs to new namespace)
4. Move `terraform/staging/` to infra repo as `terraform/aws/`
5. Create `config/platform.yaml` schema and default
6. Create `config/secrets.env.example`
7. Create `bin/eve-infra` operational CLI (start with `status`, `secrets sync`, `health`)
8. Create `.github/workflows/deploy.yml`
9. Write `README.md` and `DEPLOYMENT.md`
10. Tag `infra-v0.1.28` (matching current platform version)

### Phase 3: Migrate the platform operator Staging

**Goal**: the platform operator's staging runs from its own infra repo, source repo no longer deploys.

**Tasks:**

1. Create `example/deployment-instance-repo` from the template
2. Configure `platform.yaml` for `eve.example.com`
3. Move `terraform.tfvars` (staging-specific values) into the new repo
4. Move GitHub Actions secrets (`STAGING_KUBECONFIG`) to the new repo
5. Set up `repository_dispatch` from source repo build CI → example infra repo deploy
6. Test full deploy cycle (tag in infra repo → deploy to staging)
7. Remove `deploy-staging.yml` from source repo (replace with `publish-images.yml`)
8. Remove `k8s/overlays/staging/` and `terraform/staging/` from source repo
9. Remove staging-related commands from `bin/eh`

### Phase 4: GCP Support

**Goal**: GCP overlay and Terraform modules ready in the infra template.

**Tasks:**

1. Create `k8s/overlays/gcp/` in the infra template
   - Start from AWS overlay, adapt annotations/ingress for GCP
   - Cloud SQL connection pattern (Cloud SQL Proxy sidecar or direct IP)
   - GCE ingress vs Traefik on k3s (Traefik is simpler, consistent with AWS)
2. Create `terraform/gcp/` modules
   - `network/` — VPC, subnet, Cloud Router, Cloud NAT
   - `compute/` — GCE instance with k3s startup script
   - `database/` — Cloud SQL PostgreSQL
   - `dns/` — Cloud DNS zone and records
   - `security/` — Firewall rules, service account, IAM
3. Create `terraform/gcp/terraform.tfvars.example`
4. Test full GCP deployment end-to-end
5. Update `config/platform.yaml` schema to support `cloud: gcp`
6. Update `deploy.yml` to handle GCP-specific steps (if any)

### Phase 5: Sync Automation & Bootstrap Skill

**Goal**: Release process automatically updates the infra template; new deployments can self-serve.

**Tasks:**

1. Create sync workflow in source repo (copies k8s/base to infra template on release)
2. Create `eve-infra-bootstrap` skill
3. Create `eve-infra-sync` skill (for manual sync during development)
4. Document the full release process (source → images → infra template → deployment repos)

## Source Repo Post-Extraction

After all phases, the source repo contains:

```
eve-horizon/eve-horizon
├── apps/                      ← source code + Dockerfiles (unchanged)
├── packages/                  ← shared libraries (unchanged)
├── k8s/
│   ├── base/                  ← canonical manifests (still here for local dev)
│   └── overlays/
│       └── local/             ← k3d dev only
├── docker/compose/            ← local dev (unchanged)
├── .github/workflows/
│   ├── ci.yml                 ← test (unchanged)
│   ├── publish-images.yml     ← build + push to ghcr.io/eve-horizon/*
│   ├── worker-images.yml      ← publish worker variants
│   └── publish-migrate.yml    ← publish migration image
├── bin/eh                     ← developer CLI (local dev + build only)
├── tests/                     ← unchanged
└── docs/                      ← unchanged
```

**Removed from source repo:**
- `k8s/overlays/staging/` → `example/deployment-instance-repo`
- `k8s/overlays/aws/` → `eve-horizon/eve-horizon-infra`
- `terraform/staging/` → `eve-horizon/eve-horizon-infra` (as `terraform/aws/`)
- `deploy-staging.yml` → replaced by `publish-images.yml`
- Staging-related `bin/eh` commands → `bin/eve-infra` in infra repos

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| k8s/base drift between source and infra repos | Automated sync on every release tag. CI validates base manifests match. |
| Breaking manifest change requires coordinated update | Release notes document manifest changes. Upgrade guide in infra template. |
| Deployment runs old version with known vulnerability | `upgrade-check.yml` cron detects stale versions, opens PR. |
| GCP Terraform modules untested at scale | Start with single-node k3s (proven pattern from AWS). GKE support deferred. |
| Registry org name squatted | Register `eve-horizon` org immediately. Fallback: `evehorizon` or `eve-platform`. |
| the platform operator staging downtime during migration | Phase 3 runs new infra repo in parallel, cuts over only after green health check. |

## Dependencies

- `eve-native-container-registry-plan.md` — complementary, not blocking. The neutral GHCR namespace
  works immediately. Eve-native registry is a future upgrade path for deployments that want zero
  registry management.
- GitHub org creation (`eve-horizon`) — blocks Phase 1.

## Related

- [eve-native-container-registry-plan.md](./eve-native-container-registry-plan.md) — Future Eve-managed registry
- [p0-epic-production-baseline.md](./p0-epic-production-baseline.md) — Production baseline (AWS-first)
- [staging-deployment-pipeline.md](./staging-deployment-pipeline.md) — Current staging CI/CD
- [deployment.md](../system/deployment.md) — Deployment architecture
- [aws.md](../deploy/aws.md) — AWS deployment guide
