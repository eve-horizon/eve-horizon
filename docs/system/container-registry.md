# Container Registry

> Status: Current
> Last Updated: 2026-11-05

## Purpose

Documents how Eve Horizon manages container images: registry configuration in manifests, authentication secrets, local development workflows, and how the deployer handles image pulling.

## Current (Implemented)

### Manifest Registry Section

The project manifest (`.eve/manifest.yaml`) includes a `registry` section that configures where images are stored.
It supports three modes: Eve-native (`"eve"`), disabled (`"none"`), or a BYO registry object.

```yaml
registry:
  host: public.ecr.aws/w7c4v0w3
  namespace: eve-horizon
  auth:
    username_secret: REGISTRY_USERNAME    # Secret key for registry username
    token_secret: REGISTRY_PASSWORD        # Secret key for registry token/password
```

- `host`: The container registry hostname (e.g., `public.ecr.aws/w7c4v0w3`, `docker.io`)
- `namespace`: The registry namespace/organization (e.g., `eve-horizon`)
- `auth.username_secret`: Name of the secret containing the registry username (defaults to `REGISTRY_USERNAME`)
- `auth.token_secret`: Name of the secret containing the registry token/password (defaults to `REGISTRY_PASSWORD`)

Eve-native and disabled examples:

```yaml
registry: "eve"   # Use Eve-native registry (internal)
registry: "none"  # Skip registry handling
```

### Eve-Native Registry (Internal)

When `registry: "eve"` is set, images are pushed to and pulled from the
platform's registry, which accepts only short-lived JWTs issued by the API
(Docker v2 token auth).

Required system configuration:
- `EVE_REGISTRY_HOST` — registry hostname (e.g., `registry.eve.example.com`)
- `EVE_REGISTRY_SIGNING_KEY` — RSA private key (PEM or file path)
- `EVE_BUILDKIT_INSECURE_REGISTRIES` (optional) — comma-separated registry hosts to use with BuildKit insecure/plain-HTTP transport (useful for local in-cluster registries)
- `EVE_BUILDKIT_INSECURE_ALL` (optional) — set to `true` only for local troubleshooting to force insecure transport for all BuildKit registry operations

The signing key is needed on the API only. `EVE_INTERNAL_API_KEY`, on the API
and the worker, also signs the pull credentials described below.

Token endpoint (the registry's token realm, which must stay reachable by
BuildKit and by kubelet on every node):

```
GET  /internal/registry/token?service=eve-registry&scope=repository:<name>:<actions>   (Basic auth)
POST /internal/registry/token                                                          (x-eve-internal-token)
```

What a token grants depends on who asks. The endpoint grants the permitted
subset of the requested scopes and leaves the rest out (the registry then
refuses that operation):

| Caller | Credential | Granted |
|--------|------------|---------|
| Worker builds (BuildKit) | Basic password = `EVE_INTERNAL_API_KEY` | `pull`, `push` on any `repository` scope |
| Kubelet in an app namespace | Basic password = environment pull credential | `pull` on repositories named in the project's build artifacts |

Never granted to anyone: `delete`, `*`, and non-repository scopes such as
`registry:catalog:*`.

**Pull secrets.** For each environment the deployer writes an `eve-registry`
pull secret (username `eve-pull`) holding an environment pull credential, not
the internal API key:
`evepull1.<base64url({"p":"<project id>","e":"<environment id>","ns":"<namespace>","n":<epoch>})>.<HMAC>`,
with the HMAC key derived from `EVE_INTERNAL_API_KEY` by HKDF. The token
endpoint honours it only while:

- the environment still exists, is not terminated, and belongs to the project;
- the project is not deleted;
- the credential's epoch is the environment's current `registry_pull_epoch` or
  the one before. The deployer bumps the epoch each time it rewrites the
  secret (every deploy and every job-service run), so a credential stops
  working two rewrites after it was written. The one-epoch grace covers
  kubelet's secret cache and two rewrites racing.

It has no expiry time of its own, so pods can be rescheduled at any time while
the environment lives.

**Revocation.** Redeploy the environment twice, or delete it, to retire a
leaked pull secret. Rotating `EVE_INTERNAL_API_KEY` revokes every pull
credential at once; each environment gets a fresh one on its next deploy.
Environments deployed before environment pull credentials existed still hold
the internal key in their `eve-registry` secret until they are redeployed:
redeploy them, then rotate the key.

**What "the project's repositories" means, and what it does not.** A project's
repositories are the repository paths of the image refs in its build artifacts
(registry host, tag and digest removed). Those names come from the manifest
(the image name, or the service name when there is none) and are **not
namespaced per project**: a service `api` pushes to `<host>/api`. So this does
not isolate projects from each other. A project that builds an image with the
same name as another project's (once is enough) gets pull on that repository,
and every build may push to any repository, because builds use the internal
key. What it does guarantee: an app namespace's pull secret no longer carries
the internal key, cannot push, cannot list or delete, and cannot pull
repositories its project never built. Isolation between projects needs
per-project repository namespacing and project-scoped push credentials
(tracked as EVE-038).

Pruning builds (`eve build prune`) removes their artifacts; an image whose
repository no remaining build uses can no longer be pulled with the
environment's credential.

### Service Images

Services specify their full image path without a tag:

```yaml
services:
  api:
    image: public.ecr.aws/w7c4v0w3/eve-horizon/my-project-api
    build:
      context: ./apps/api
      dockerfile: ./apps/api/Dockerfile
```

The tag is determined by the workflow:
- Local dev: `:local`
- Pipeline builds: Git SHA or version (`:sha-abc123`, `:v1.0.0`)

### Required Secrets

For private registries (including AWS ECR mirrors), add these to `system-secrets.env.local`:

```bash
REGISTRY_USERNAME=your-registry-username
REGISTRY_PASSWORD=your-registry-token
```

**Token requirements:**
- Credentials required by your registry provider for image pushes/pulls.
- Use the corresponding CI/workflow credentials when pushing.

See [secrets.md](./secrets.md) for the full secrets resolution system.

### Deployer ImagePullSecret

When deploying to Kubernetes, the deployer (`apps/worker/src/deployer/deployer.service.ts`) creates an `imagePullSecret` if the manifest has a `registry.host`:

1. Resolves `username_secret` and `token_secret` from the secrets system
2. Creates a Docker config JSON with registry auth
3. Creates/updates a Kubernetes Secret of type `kubernetes.io/dockerconfigjson`
4. Attaches the secret to the deployment's `imagePullSecrets`

If `registry.host` is not set (or `registry: "none"`), no imagePullSecret is created (assumes public images or pre-configured cluster auth).

## Workflows

### Local Development (k3d)

For fast iteration without pushing to a remote registry:

```bash
# Build with :local tag
docker build -t public.ecr.aws/w7c4v0w3/eve-horizon/my-project-api:local ./apps/api

# Import directly into k3d cluster
k3d image import public.ecr.aws/w7c4v0w3/eve-horizon/my-project-api:local -c eve-local

# Deploy (requires explicit --ref)
eve env deploy test --ref main --repo-dir .
```

This avoids the push/pull roundtrip to the public registry, making iteration much faster.

### Pipeline Build (Implemented)

When a pipeline runs a `build` action:

1. Creates a BuildSpec (immutable inputs) and BuildRun (execution instance)
2. Executes image builds using Docker Buildx (local) or BuildKit (k8s)
3. Builds the image from the service's `build.context` and `build.dockerfile`
4. Tags with Git SHA or specified version
5. Pushes to `registry.host/registry.namespace/service-name:tag`
6. Captures image digests and stores them as BuildArtifacts (see [builds.md](./builds.md))
7. Release creation references `build_id` and derives digests from artifacts
8. Subsequent `deploy` actions pull from the registry using digest-based references

```yaml
pipelines:
  deploy:
    steps:
      - action: build
        services: [api, web]
        tag: ${GIT_SHA}
      - action: deploy
        env: staging
        services: [api, web]
```

**Build Backend:**
- Local environments: Docker Buildx
- Kubernetes environments: BuildKit (default), Kaniko fallback only if required

**Build reuse (faster local redeploys):**
- Build actions now reuse the most recent successful build artifacts when `project_id + git_sha + manifest_hash + requested services` match.
- Disable reuse per-run by setting action input `force_rebuild: true`.
- Disable reuse globally by setting `EVE_BUILD_REUSE=false` in worker env.

### CI/CD (GitHub Actions)

For CI environments that need explicit registry auth before build:

```yaml
- name: Login to container registry
  uses: docker/login-action@v3
  with:
    registry: public.ecr.aws/w7c4v0w3
    username: ${{ secrets.REGISTRY_USERNAME }}
    password: ${{ secrets.REGISTRY_PASSWORD }}
```

The Eve worker uses the manifest's `registry.auth` secrets for deployment.

## Planned (Not Implemented)

- Multi-registry support (different registries per component)
- Registry mirroring for air-gapped environments
- Automatic tag cleanup/retention policies

## Related

- [secrets.md](./secrets.md) - Secret storage and resolution
- [deployment.md](./deployment.md) - Kubernetes deployment process
- [k8s-local-stack.md](./k8s-local-stack.md) - Local k3d development setup
