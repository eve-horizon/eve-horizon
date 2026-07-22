# CI/CD

GitHub Actions workflows for this repo: continuous integration, and the
tag-driven publishing of every release artifact.

> **Canonical repo**: `github.com/eve-horizon/eve-horizon`. Releases are cut here
> and nowhere else. See [OSS Release Cutover](../deploy/oss-release-cutover.md).

## The one rule

**A release tag publishes artifacts. It never deploys.**

This repo builds images and npm packages. Rolling those into a cluster is done
from a *deployment instance repo* by its owner. No workflow here may hold
cluster credentials or use `repository_dispatch` to reach an instance repo — see
[deployment.md](./deployment.md) for the three-repo model.

## Workflows

### Continuous integration

| Workflow | Trigger | Does |
| --- | --- | --- |
| `ci.yml` | push + PR to `main` | pnpm install, build all packages, run unit tests |
| `kubectl-context-safety.yml` | PR to `main` | Blocks changes that could target the wrong cluster context |

### Publishing

All publishing is tag-driven. Push the tag, the workflow does the rest.

| Tag prefix | Workflow | Publishes |
| --- | --- | --- |
| `release-v*` | `publish-images.yml` | 7 service images → public ECR |
| `toolchain-images/v*` | `toolchain-images.yml` | 5 toolchain images → public ECR |
| `cli-v*` | `publish-cli.yml` | `@eve-horizon/cli` → npm |
| `sdk-v*` | `publish-sdk.yml` | `@eve-horizon/auth` + `auth-react` → npm (lockstep) |
| `chat-v*` | `publish-chat.yml` | `@eve-horizon/chat` + `chat-react` → npm (lockstep) |
| `eve-migrate/v*` | `publish-migrate.yml` | `migrate` image → public ECR |
| `worker-images/v*` | `worker-images.yml` | `worker-*` variant images → public ECR |

```bash
git tag <prefix>-v0.1.0 && git push origin <prefix>-v0.1.0
```

> **Legacy paths**: `worker-images` has never completed successfully (2 runs,
> both failed 2026-02-16) and `publish-migrate` last failed 2026-02-18. Neither
> is consumed by a deployment — migrations run from the `api` image, and worker
> toolchains ship as init containers. Repair or retire rather than assuming they
> work. Run logs have expired, so the cause is unconfirmed; one difference worth
> checking first is that these two build `linux/amd64,linux/arm64` while the
> service images build `linux/amd64` only.

## Service images (`release-v*`)

Builds seven images in a parallel matrix: `api`, `sso`, `gateway`,
`agent-runtime`, `orchestrator`, `worker`, `dashboard`.

Registry: `public.ecr.aws/w7c4v0w3/eve-horizon`

Each image gets **three tags**:

| Tag | Example | Use |
| --- | --- | --- |
| version | `0.1.313` | What deployment instances pin |
| short SHA | `sha-a1b2c3d` | Traceability |
| `staging` | `staging` | Floating; tracked by non-pinned overlays |

Build metadata (`EVE_BUILD_VERSION`, `EVE_BUILD_SHA`, `EVE_BUILD_TIME`) is passed
as build args and surfaces in `eve system health`. Registry-backed layer caching
uses a per-image `-cache` repository. Platform: `linux/amd64`.

## Toolchain images (`toolchain-images/v*`)

Builds `toolchain-{python,media,rust,java,kotlin}`, tagged with the version and
`latest`, for `linux/amd64` and `linux/arm64`.

These are on an **independent version line** from the platform. A `release-v*`
does not rebuild them; they change only when `docker/toolchains/**` does.
Deployments pull them via `EVE_TOOLCHAIN_IMAGE_PREFIX` +
`EVE_TOOLCHAIN_IMAGE_TAG` (typically `latest`) on the worker and agent-runtime
pods, which inject them as init containers.

## Required configuration

Repo → Settings → Secrets and variables → Actions.

### Secrets

| Secret | Needed by |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | every image workflow |
| `AWS_SECRET_ACCESS_KEY` | every image workflow |
| `NPM_TOKEN` | `publish-cli`, `publish-sdk`, `publish-chat` |

The npm token should be a Granular Access Token with read+write on packages, and
the `@eve-horizon` npm org must exist.

### Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `ECR_NAMESPACE` | `eve-horizon` | Repository prefix within the registry |
| `AWS_ECR_REGION` | `eu-west-1` | Only feeds credential config; set `us-east-1` to match the proven setup |

`ECR_REGISTRY` is a hardcoded `env:` (`public.ecr.aws/w7c4v0w3`) in each
workflow, not a variable. All `ecr-public` API calls pass `--region us-east-1`
explicitly, and missing ECR repositories are created on first push.

### Never add

`DEPLOY_DISPATCH_TOKEN`, `STAGING_KUBECONFIG`, `STAGING_API_URL` — any of these
in this repo would break the "publish, never deploy" rule.

## Installing a published CLI

```bash
npm install -g @eve-horizon/cli            # latest
npm install -g @eve-horizon/cli@0.2.36     # pinned
```

There is also a `/cli-publish-and-install` skill for manual publishing when CI
is unavailable.
