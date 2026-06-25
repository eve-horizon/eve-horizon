# Staging Deployment Pipeline

> Status: Draft
> Last Updated: 2026-01-27
> Purpose: Set up automated staging deployment infrastructure with Terraform, CI/CD pipeline, and operational skill.

## Inputs

- docs/deploy/aws.md
- docs/system/deployment.md
- k8s/overlays/aws/
- .github/workflows/worker-images.yml
- eve-skillpacks/eve-se/

## Epic Goal

Deliver a complete staging environment for Eve Horizon with:
- **Infrastructure as Code**: Terraform modules for EC2 (k3s) + RDS PostgreSQL on AWS
- **Automated Deployment**: GitHub Actions workflow triggered on `release-v*` tags
- **Operational Skill**: New `eve-hosted-operations` skill for setup and troubleshooting (private dev pack)

## Non-goals

- Production deployment automation (staging only for now)
- Multi-region or high-availability setup
- EKS/managed Kubernetes (k3s on EC2 is sufficient for staging)
- Terraform state management backend (local state for staging)

## Definition of Done

- Terraform modules provision EC2 + RDS + networking in a single `terraform apply`
- GitHub Actions workflow builds API/Orchestrator/Worker images and deploys on `release-v*` tags
- Deployment includes health check with automatic rollback on failure
- New `eve-hosted-operations` skill documents the complete workflow (private dev pack)
- DNS configured for `api.staging.<domain>` and `*.apps.staging.<domain>`
- Manual verification: create a test job via CLI against staging API

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub Actions                            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ Build API   │    │ Build Orch  │    │ Build Worker│         │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│         └──────────────────┼──────────────────┘                 │
│                            ▼                                     │
│                    Push to GHCR                                  │
│                            │                                     │
│                            ▼                                     │
│                 Deploy to EC2 (k3s)                             │
└────────────────────────────┼────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              ▼              │
              │    ┌─────────────────┐     │  AWS VPC
              │    │   EC2 (k3s)     │     │
              │    │  ┌───────────┐  │     │
              │    │  │    API    │  │     │
              │    │  │   Orch    │  │     │
              │    │  │  Worker   │  │     │
              │    │  └───────────┘  │     │
              │    └────────┬────────┘     │
              │             │              │
              │    ┌────────▼────────┐     │
              │    │ RDS PostgreSQL  │     │
              │    └─────────────────┘     │
              └────────────────────────────┘
```

## Workstreams

### 1) Terraform Infrastructure

**Deliverables:**
- `terraform/staging/` directory with modular structure
- EC2 instance with k3s bootstrap via user_data script
- RDS PostgreSQL with private subnet placement
- Security groups for SSH, HTTP/S, K8s API, database access
- Optional Route 53 DNS records

**File Structure:**
```
terraform/staging/
├── main.tf                      # Root module + providers
├── variables.tf                 # Input variables
├── outputs.tf                   # Outputs (IPs, URLs, commands)
├── terraform.tfvars.example     # Example values (committed)
├── modules/
│   ├── network/                 # VPC, subnets, IGW, route tables
│   ├── security/                # Security groups (EC2, RDS)
│   ├── ec2/                     # EC2 instance + k3s bootstrap
│   │   └── user_data.sh.tpl    # k3s installation script
│   ├── rds/                     # RDS PostgreSQL
│   └── dns/                     # Route 53 (optional)
```

**Resource Sizing (Staging/Demo):**
| Resource | Type | Specs | Est. Monthly Cost |
|----------|------|-------|-------------------|
| EC2 | m6i.xlarge | 4 vCPU, 16GB RAM (dedicated) | ~$140 |
| RDS | db.t3.micro | 1 vCPU, 1GB RAM | ~$15 |
| EBS | gp3 | 50GB | ~$4 |
| RDS Storage | gp3 | 20GB | ~$2 |
| **Total** | | | **~$161/month** |

**Why m6i.xlarge:** Demo environment requiring fast, reliable performance with multiple concurrent projects. Dedicated CPU (no burst credits) ensures consistent performance.

**Secrets Handling:**
```bash
# Environment variables (never committed)
export TF_VAR_ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"
export TF_VAR_db_password="$(openssl rand -base64 24)"
terraform apply
```

### 2) Kustomize Staging Overlay

**Deliverables:**
- `k8s/overlays/staging/` directory based on AWS overlay
- Patches for staging-specific configuration

**File Structure:**
```
k8s/overlays/staging/
├── kustomization.yaml
├── api-deployment-patch.yaml
├── orchestrator-deployment-patch.yaml
├── worker-deployment-patch.yaml
├── api-ingress-patch.yaml
├── db-migrate-job-patch.yaml
└── remove-postgres.yaml         # Use external RDS
```

**Key Configuration:**
| Patch | Variable | Purpose |
|-------|----------|---------|
| api-deployment-patch | DATABASE_URL | RDS connection string |
| api-deployment-patch | image | Tagged API image from GHCR |
| api-ingress-patch | host | `api.staging.example.com` |
| worker-deployment-patch | EVE_DEFAULT_DOMAIN | `apps.staging.example.com` |
| worker-deployment-patch | EVE_RUNNER_IMAGE | Tagged worker image |

### 3) GitHub Actions Workflow

**Deliverables:**
- `.github/workflows/deploy-staging.yml`
- Automated build, push, deploy on release tags

**Trigger:**
```yaml
on:
  push:
    tags:
      - 'release-v*'
```

**Jobs:**

1. **build-images** (parallel matrix)
   - Build API, Orchestrator, Worker images
   - Push to GHCR with version + SHA tags
   - Cache layers for faster builds

2. **deploy-staging** (sequential, needs build-images)
   - Configure kubeconfig from secret
   - Update image tags via `kustomize edit set image`
   - Apply manifests: `kubectl apply -k k8s/overlays/staging`
   - Wait for rollouts (180s timeout)
   - Health check with 10 retries
   - Automatic rollback on failure

3. **notify** (optional)
   - Slack webhook on success/failure

**Image Tagging Strategy:**
```
ghcr.io/eve-horizon/api:1.2.3      # Version tag
ghcr.io/eve-horizon/api:sha-abc123 # SHA tag
ghcr.io/eve-horizon/api:staging    # Environment tag
```

**Required GitHub Secrets:**
| Secret | Description |
|--------|-------------|
| `STAGING_KUBECONFIG` | Base64-encoded kubeconfig from EC2 |
| `STAGING_API_URL` | `https://api.staging.example.com` |
| `SLACK_WEBHOOK_URL` | (optional) Notifications |

### 4) Operational Skill

**Deliverables:**
- `private-eve-dev-skills/eve-dev/eve-hosted-operations/SKILL.md`
- Updates to pack README and ARCHITECTURE.md

**Skill Coverage:**
1. Prerequisites and setup checklist
2. Creating staging Kustomize overlay
3. Deploying to staging (secrets, apply, verify)
4. Health verification procedures
5. Update and rollback procedures
6. Troubleshooting guide (DNS, DB, registry, ingress, jobs)
7. Common commands reference

**Relationship to Existing Skills:**
```
eve-aws-provisioning (VPS + k3s setup, private dev pack)
         ↓
eve-hosted-operations (overlay + deploy + verify)  ← NEW (private dev pack)
         ↓
eve-project-bootstrap (org + project setup)
         ↓
eve-deploy-debugging (ongoing troubleshooting)
```

## Implementation Phases

### Phase 1: Terraform Infrastructure
1. Create `terraform/staging/` directory structure
2. Implement modules: network → security → rds → ec2 → dns
3. Create `terraform.tfvars.example` with placeholder values
4. Add `.gitignore` entries for `*.tfvars` and `*.tfstate`
5. Test: `terraform init && terraform plan && terraform apply`

### Phase 2: Kustomize Overlay
1. Create `k8s/overlays/staging/` directory
2. Copy and adapt patches from `k8s/overlays/aws/`
3. Update for staging-specific values
4. Test: Manual deploy to provisioned EC2

### Phase 3: GitHub Actions Workflow
1. Create `.github/workflows/deploy-staging.yml`
2. Implement build-images job with matrix strategy
3. Implement deploy-staging job with kubeconfig
4. Add health check and rollback logic
5. Test: Push `release-v0.0.1-test` tag

### Phase 4: Skill Creation
1. Create `private-eve-dev-skills/eve-dev/eve-hosted-operations/SKILL.md`
2. Update `eve-skillpacks/eve-se/README.md`
3. Update `eve-skillpacks/ARCHITECTURE.md`
4. Run `./bin/eh skills install` and `skill read eve-hosted-operations`

## Files to Create

| File | Purpose |
|------|---------|
| `terraform/staging/**` | All Terraform infrastructure |
| `k8s/overlays/staging/**` | Staging Kustomize overlay |
| `.github/workflows/deploy-staging.yml` | CI/CD workflow |
| `private-eve-dev-skills/eve-dev/eve-hosted-operations/SKILL.md` | New skill |

## Files to Modify

| File | Change |
|------|--------|
| `.gitignore` | Add Terraform patterns |
| `eve-skillpacks/eve-se/README.md` | List new skill |
| `eve-skillpacks/ARCHITECTURE.md` | Update skill listing |

## Verification Plan

### 1. Terraform Verification
```bash
cd terraform/staging
terraform init
terraform plan
terraform apply

# Verify:
ssh ubuntu@<staging-ip> "kubectl get nodes"
psql "$DATABASE_URL" -c "SELECT 1"
```

### 2. Manual Deploy Test
```bash
# On EC2
kubectl -n eve create secret docker-registry eve-registry ...
kubectl -n eve create secret generic eve-app ...
kubectl apply -k k8s/overlays/staging
curl https://api.staging.example.com/health
```

### 3. CI Pipeline Test
```bash
git tag release-v0.0.1-test
git push origin release-v0.0.1-test
# Monitor GitHub Actions
# Verify GHCR images
# Verify health check passes
```

### 4. Skill Verification
```bash
./bin/eh skills install
skill read eve-hosted-operations
grep "eve-hosted-operations" AGENTS.md
```

## Rollback Procedures

### Terraform
```bash
terraform destroy                    # Full teardown
terraform destroy -target=module.ec2 # Partial
```

### Kubernetes
```bash
kubectl -n eve rollout undo deployment/eve-api
kubectl -n eve rollout undo deployment/eve-orchestrator
kubectl -n eve rollout undo deployment/eve-worker
```

### CI Pipeline
The workflow automatically rolls back on health check failure. For manual rollback, retag and push a previous release.

## Open Questions

1. **Domain**: What domain should be used for staging? (e.g., `staging.eve-horizon.dev`)
2. **DNS Provider**: Use Route 53 or external DNS provider?
3. **Notifications**: Slack channel for deployment notifications?
4. **Approval Gate**: Should staging deploys require manual approval in GitHub?
