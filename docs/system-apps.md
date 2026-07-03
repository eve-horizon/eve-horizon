# System Apps

System apps are the platform components that ship with every Eve Horizon instance. Unlike user-deployed applications, system apps are built from this source repo, published to ECR as container images, and deployed atomically as a single versioned release.

## Current System Apps

| App | Description |
|-----|-------------|
| api | Core platform API |
| gateway | Edge proxy / API gateway |
| orchestrator | Job and workflow orchestration |
| worker | Background task execution |
| agent-runtime | Agent execution environment |
| sso | Single sign-on service |
| dashboard | Platform management UI |

All system apps share a single version derived from the `release-v*` git tag (see `.github/workflows/publish-images.yml`) and deploy together.

## Image Registry

System apps are published to **ECR Public**:

```
public.ecr.aws/w7c4v0w3/eve-horizon/<name>
```

ECR repos are auto-created by the CI workflow's `ensure_repo` step. Do not use the Eve internal registry or GHCR for system apps.

## Adding a New System App

### 1. Create the application

Add the app source under `apps/<name>/` with a multi-stage Dockerfile. The final stage must be named `production`:

```dockerfile
# apps/<name>/Dockerfile
FROM node:20-alpine AS build
# ... build steps ...

FROM node:20-alpine AS production
# ... runtime only ...
```

### 2. Add to CI image build matrix

Edit `.github/workflows/publish-images.yml` and add an entry to `matrix.include`:

```yaml
- service: <name>
  dockerfile: apps/<name>/Dockerfile
  target: production
  image: <name>
```

### 3. Add Kubernetes base manifests

Create base manifests in `k8s/base/` within this source repo:

- `<name>-deployment.yaml` -- use image tag `<name>:local` (for k3d local dev)
- `<name>-service.yaml`
- `<name>-ingress.yaml` (only if the service needs external access)

### 4. Add to base kustomization

Add the new manifest files to `k8s/base/kustomization.yaml`.

### 5. Propagate to infrastructure template repo

In `eve-horizon-infra` (the template at `../../eve-horizon/eve-horizon-infra`):

- Copy base manifests to the template's `k8s/base/`
- Add overlay patches for each deployment target (`aws-eks`, `aws`, `gcp`) that replace the `:local` image tag with the versioned ECR image
- Add the new files to each overlay's `kustomization.yaml`

### 6. Update the deploy workflow

Edit `.github/workflows/deploy.yml` in each infra repo:

- [ ] Add to the image verification service list
- [ ] Add to the image tag update loop
- [ ] Add a rollout wait step (`kubectl rollout status`)
- [ ] Add to the annotation loop
- [ ] Add to diagnostics and rollback sections

### 7. Update the `bin/eve-infra` CLI

- [ ] Add to `SERVICE_MAP`
- [ ] Add to `SERVICE_LABELS`
- [ ] Add to `VALID_SERVICES`
- [ ] Add to the deploy rollout wait loop

### 8. ECR repository

No manual action needed. The `ensure_repo` step in `publish-images.yml` automatically creates ECR repos (and their cache repos) on first build.

## Key Conventions

- **Atomic versioning**: all system apps share the version from the `release-v*` git tag. Never version system apps independently.
- **Base manifests use `:local` tags**: overlays patch these to versioned ECR images per environment.
- **Multi-stage Dockerfiles**: the CI `target` field selects which stage to build. Use `production` for all apps (the `worker` is the sole exception, using `base`).
