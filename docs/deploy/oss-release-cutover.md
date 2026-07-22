# OSS Release Cutover

> **Status**: In progress · **Created**: 2026-07-22 · **Owner**: Project maintainers
>
> Moving the release-publishing pipeline from the private `Incept5/eve-horizon`
> repo to the canonical open-source `eve-horizon/eve-horizon` repo.

## Canonical repository

**`github.com/eve-horizon/eve-horizon` is the only repo that should be worked on.**

`Incept5/eve-horizon` is the pre-open-source private ancestor. It is retained for
history and for the release tags that produced the images currently running in
hosted environments. It must not receive new work.

| Remote | Repo | Use |
| --- | --- | --- |
| `origin` | `eve-horizon/eve-horizon` (public) | All work. Push here. |
| `private-origin` | `Incept5/eve-horizon` (private) | Fetch/history only. **Never push.** |

Local clones should have `private-origin`'s push URL set to `DISABLED`:

```bash
git remote set-url --push private-origin DISABLED
```

---

## Why this document exists

The open-sourcing plan
([`2026-06-18-open-sourcing-eve-horizon-plan.md`](../plans/2026-06-18-open-sourcing-eve-horizon-plan.md))
moved the **code** to the public repo but not the **release pipeline**. As of
2026-07-22 the public repo had never published an artifact:

| Check | `eve-horizon/eve-horizon` | `Incept5/eve-horizon` |
| --- | --- | --- |
| Git tags | **0** | 313 `release-v*` (latest `release-v0.1.313`, 2026-07-14) |
| Actions secrets | **0** | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`, … |
| Actions variables | **0** | `ECR_REGISTRY`, `ECR_NAMESPACE`, `AWS_ECR_REGION` |
| Publish workflow runs | **0** | 89 `Publish Images`, 13 `Publish CLI` |

Every image in `public.ecr.aws/w7c4v0w3/eve-horizon` was built by private CI.
Until the steps below are done, **hosted environments are still fed by the
private repo**, and the public repo cannot cut a release.

---

## Delivery chain

Three repos, one direction. The source repo publishes artifacts; it never
deploys.

```
eve-horizon/eve-horizon          push tag release-v*
  (source, public)          ──────────────────────────>  public.ecr.aws/w7c4v0w3/eve-horizon
         │                                                        │
         │ manifests/terraform                                    │ images pulled at pinned version
         v                                                        v
eve-horizon/eve-horizon-infra  ──template──>  <org>/<name>-eve-infra  ──deploy-v* tag──>  cluster
  (public scaffold)                            (private instance, e.g. incept5-eve-infra)
```

**Guardrail**: a `release-v*` tag publishes images and nothing else. Rollouts are
triggered only from the deployment instance repo, by its owner. The source repo
must never hold `DEPLOY_DISPATCH_TOKEN`, `STAGING_KUBECONFIG`, or
`STAGING_API_URL`, and no workflow may use `repository_dispatch` to reach an
instance repo. (Verified clean as of 2026-07-22.)

---

## Required CI configuration

Set these on `eve-horizon/eve-horizon` → Settings → Secrets and variables → Actions.

### Secrets (all three required)

| Secret | Used by | Purpose |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | `publish-images`, `publish-migrate`, `worker-images`, `toolchain-images` | Public ECR push |
| `AWS_SECRET_ACCESS_KEY` | same | Public ECR push |
| `NPM_TOKEN` | `publish-cli`, `publish-sdk`, `publish-chat` | npm publish under `@eve-horizon` |

### Variables (optional — defaults work)

| Variable | Default in workflow | Private repo value |
| --- | --- | --- |
| `ECR_NAMESPACE` | `eve-horizon` | `eve-horizon` |
| `AWS_ECR_REGION` | `eu-west-1` | `us-east-1` |

`ECR_REGISTRY` is a hardcoded `env:` in each workflow (`public.ecr.aws/w7c4v0w3`),
**not** a variable — setting it as a variable has no effect.

`AWS_ECR_REGION` only feeds `configure-aws-credentials`; every `ecr-public` CLI
call passes `--region us-east-1` explicitly, so the `eu-west-1` default is
harmless. Set it to `us-east-1` anyway to match the proven configuration.

### Do not copy

| Secret | Why not |
| --- | --- |
| `DEPLOY_DISPATCH_TOKEN` | Would let the source repo trigger hosted rollouts |
| `STAGING_KUBECONFIG` | Cluster credentials belong in the instance repo |
| `STAGING_API_URL` | Instance-specific; not needed to publish |

---

## Artifact inventory

Tag prefixes and what each produces. Verified against public ECR on 2026-07-22.

| Tag | Workflow | Publishes | In ECR today |
| --- | --- | --- | --- |
| `release-v*` | `publish-images.yml` | `api`, `sso`, `gateway`, `agent-runtime`, `orchestrator`, `worker`, `dashboard` | ✅ through `0.1.313` |
| `toolchain-images/v*` | `toolchain-images.yml` | `toolchain-{python,media,rust,java,kotlin}` | ✅ `1.0.0` + `latest` |
| `cli-v*` | `publish-cli.yml` | `@eve-horizon/cli` | n/a (npm) |
| `sdk-v*` | `publish-sdk.yml` | `@eve-horizon/auth` + `auth-react` | n/a (npm) |
| `chat-v*` | `publish-chat.yml` | `@eve-horizon/chat` + `chat-react` | n/a (npm) |
| `eve-migrate/v*` | `publish-migrate.yml` | `migrate` | ⚠️ `1.0.1`, last run **failed** (2026-02-18) |
| `worker-images/v*` | `worker-images.yml` | `worker-{base,python,rust,java,kotlin,full}` | ❌ **0 tags — never succeeded** |

Each `release-v*` build pushes three tags per image: the version (`0.1.313`), the
short SHA (`sha-abc1234`), and the floating `staging` tag.

### What a deployment instance actually needs

Only the **first two rows**. A cluster rollout consumes:

- the **7 service images** at the pinned `platform.version`, and
- the **5 toolchain images**, pulled at `latest` via `EVE_TOOLCHAIN_IMAGE_PREFIX`
  and `EVE_TOOLCHAIN_IMAGE_TAG` on the worker and agent-runtime pods.

Database migrations run from the **`api`** image (`db-migrate-job`), not the
`migrate` image. The `worker-*` variant images are superseded by the toolchain
init-container model.

> The failing `worker-images` and `eve-migrate` workflows are therefore **not**
> cutover blockers. They are unused legacy paths — either repair or retire them,
> tracked separately.

Toolchain images are on an **independent version line** (`1.0.0`), not the
platform version. Bumping the platform does not rebuild them; they only change
when `docker/toolchains/**` does.

---

## Cutover procedure

Steps 1, 2 and 5 need a human with repo-admin or cluster authority.

### 1. Configure secrets — *user action*

Add the three secrets above to `eve-horizon/eve-horizon`. Confirm:

```bash
gh secret list -R eve-horizon/eve-horizon      # expect 3
gh variable list -R eve-horizon/eve-horizon
```

### 2. Cut the first OSS release — *user action*

```bash
git checkout main && git pull
git tag release-v0.1.314 && git push origin release-v0.1.314
gh run watch -R eve-horizon/eve-horizon
```

All 7 matrix jobs must be green.

### 3. Verify images reached the registry

```bash
TOKEN=$(curl -s https://public.ecr.aws/token/ | jq -r .token)
for r in api sso gateway agent-runtime orchestrator worker dashboard; do
  printf '%-14s ' "$r"
  curl -s -H "Authorization: Bearer $TOKEN" \
    "https://public.ecr.aws/v2/w7c4v0w3/eve-horizon/$r/tags/list" \
  | jq -r '.tags | map(select(. == "0.1.314")) | if length > 0 then "ok" else "MISSING" end'
done
```

### 4. Bump the deployment instance

In the instance repo (e.g. `incept5-eve-infra`):

```bash
bin/eve-infra upgrade 0.1.314   # updates config/platform.yaml + overlay image tags
git diff                        # version strings only
```

### 5. Roll the cluster — *user action*

```bash
bin/eve-infra deploy
bin/eve-infra db migrate        # if the release has schema changes
bin/eve-infra health
```

### 6. Sunset the private repo — *user action*

Once a release cut from OSS has deployed green:

1. Apply the notice in [`private-repo-sunset-notice.md`](./private-repo-sunset-notice.md)
   to `Incept5/eve-horizon`.
2. Archive the repo on GitHub (read-only; preserves history and tags).
3. Re-point or delete stale local checkouts (see below).

---

## Stale local checkouts

Clones that still point at the private origin will silently take agents to the
wrong codebase.

| Path | Origin | State | Action |
| --- | --- | --- | --- |
| `eve-horizon`, `eve-horizon-2` | `eve-horizon/eve-horizon` | current | ✅ correct |
| `eve-horizon-3`, `-4`, `-5` | `Incept5/eve-horizon` | stale (Feb 2026) | ⚠️ banner applied — re-point to OSS or delete |
| `eve-source` | `Incept5/eve-source` | predecessor product | ⚠️ banner applied — **not this codebase**, see below |

A "⛔ STOP" banner has been prepended to `AGENTS.md` and `CLAUDE.md` in each
stale checkout, so an agent starting there is told immediately. These are
**uncommitted local edits** — deliberately, since pushing to `private-origin` is
forbidden. They disappear if the checkout is reset, which is fine: resetting to
the OSS remote is the fix.

Re-point a stale checkout:

```bash
git remote set-url origin git@github.com:eve-horizon/eve-horizon.git
git fetch origin && git reset --hard origin/main
```

> ⚠️ **`eve-source` is a different product.** It is the proprietary predecessor
> (single-server agent IDE) and shares no architecture with this platform — but
> its README banner also reads "Eve Horizon", which makes it easy to misidentify.
> It is explicitly out of scope for open-sourcing. Do not treat it as a stale
> copy of this repo, and do not relicense or publish it.

---

## Verification

The cutover is complete when all of these hold:

```bash
# 1. OSS repo has release tags of its own
git ls-remote --tags origin 'refs/tags/release-v*' | tail -3

# 2. OSS repo is configured to publish
gh secret list -R eve-horizon/eve-horizon

# 3. A publish run from OSS is green
gh run list -R eve-horizon/eve-horizon -w publish-images.yml -L 3

# 4. The instance repo runs a version published by OSS
grep 'version:' config/platform.yaml     # in the instance repo
bin/eve-infra health
```

Plus: the private repo is archived, and no local checkout points at it.
