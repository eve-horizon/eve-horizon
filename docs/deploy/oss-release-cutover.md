# OSS Release Cutover

> **Status**: Images cut over · npm still blocked · **Created**: 2026-07-22 · **Owner**: Project maintainers
>
> Moving the release-publishing pipeline from the private `Incept5/eve-horizon`
> repo to the canonical open-source `eve-horizon/eve-horizon` repo.
>
> **Done (2026-07-22)**: `release-v0.1.314` cut from this repo — all 7 service
> images green and live in `public.ecr.aws/w7c4v0w3/eve-horizon`.
> **Outstanding**: `NPM_TOKEN`, so `cli-v*`/`sdk-v*`/`chat-v*` tags still fail.

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

| Secret | Used by | Purpose | State |
| --- | --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | `publish-images`, `publish-migrate`, `worker-images`, `toolchain-images` | Public ECR push | ✅ set, proven by `0.1.314` |
| `AWS_SECRET_ACCESS_KEY` | same | Public ECR push | ✅ set, proven by `0.1.314` |
| `NPM_TOKEN` | `publish-cli`, `publish-sdk`, `publish-chat` | npm publish under `@eve-horizon` | ❌ **missing** |

**Where the AWS credential came from.** IAM user
`eve-horizon-gha-ecr-public-publisher` in account `767828750268`, policy
`AmazonElasticContainerRegistryPublicFullAccess` — the same least-privilege
identity the private repo used to ship `0.1.313`. Its secret value is
unrecoverable, so a **second access key** was minted on that user for this repo.
The private repo's original key is still active; rotate it out when that repo is
stripped of publish capability. Do not use a personal admin key here — this is a
public repo.

**Minting the npm token.** All `@eve-horizon` packages are maintained solely by
npm user `tigz <ajchesney@gmail.com>`, so the token must come from that account.
Verify any candidate before setting it:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" https://registry.npmjs.org/-/whoami
```

`401` means the registry does not recognise the string at all — that is not an
npm-CLI or `.npmrc` problem, so don't go looking for one. The token previously
stored in repo-root `secrets.env` as `CLI_NPM_PUBLISH_TOKEN` fails this check and
is dead. Prefer `npm login` followed by `npm token create`, which lets you verify
at the moment of creation rather than pasting a value that may be masked,
truncated, or IP-restricted.

### Variables (optional — defaults work)

| Variable | Default in workflow | Private repo value | Set here |
| --- | --- | --- | --- |
| `ECR_NAMESPACE` | `eve-horizon` | `eve-horizon` | ✅ `eve-horizon` |
| `AWS_ECR_REGION` | `eu-west-1` | `us-east-1` | ✅ `us-east-1` |

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

Two pre-checks were run on 2026-07-22 so the first release doesn't fail on
something avoidable.

> **Workflow drift check**: every publish workflow here was diffed against the
> version in the private repo that actually shipped `release-v0.1.313`.
> `publish-cli`, `publish-sdk`, `publish-chat`, `publish-migrate`,
> `worker-images` and `ci` are byte-identical; `publish-images` differs only by a
> guardrail comment. The OSS workflows are functionally the proven ones.

> **Image build check**: `ci.yml` runs `pnpm build` and unit tests but never
> exercises a Dockerfile, so no image had ever been built from OSS `main`. All
> seven were built locally at the same targets and platform the release uses —
> **all seven succeeded**, and the `api` image was confirmed to contain
> `pg_dump 16.14` (the 2026-07-14 snapshot fix). Sizes: api 940 MB, sso 75 MB,
> gateway 85 MB, agent-runtime 1.53 GB, orchestrator 164 MB, worker 1.68 GB,
> dashboard 63 MB.
>
> That gap is now closed permanently by
> [`image-build-check.yml`](../../.github/workflows/image-build-check.yml),
> which builds all seven without pushing on every PR and `main` push.

Together these mean **missing secrets are the only thing blocking a release** —
not workflow drift and not image breakage. That was borne out: once the AWS
credential was set, `0.1.314` went green first time.

### 1. Configure secrets — ✅ *AWS done · npm outstanding*

Add the three secrets above to `eve-horizon/eve-horizon`. Confirm:

```bash
gh secret list -R eve-horizon/eve-horizon      # expect 3; currently 2
gh variable list -R eve-horizon/eve-horizon
```

### 2. Cut the first OSS release — ✅ *done: `release-v0.1.314`, 2026-07-22*

```bash
git checkout main && git pull
git tag -a release-v0.1.314 -m "..."
git push origin refs/tags/release-v0.1.314    # single refspec — see warning
gh run watch -R eve-horizon/eve-horizon
```

All 7 matrix jobs must be green. They were, in ~4 min.

> ⚠️ **Never `git push --tags` from a long-lived checkout.** Local clones carry
> the 313 historical `release-v*` tags inherited from the private repo, and the
> OSS remote has none of them. Pushing them all would trigger `publish-images.yml`
> 313 times. Always push one explicit refspec.

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

Verified 2026-07-22: all 7 present, tagged `0.1.314` / `sha-7dbfb3e` / `staging`.

> ⚠️ Prefer the registry API above over
> `aws ecr-public describe-images --query "imageDetails[?contains(imageTags,'…')]"`.
> Untagged cache layers have a **null** `imageTags`, and `contains()` on null
> makes the whole JMESPath filter fail — it returns empty rather than erroring, so
> a successful publish reads as a total miss. Filter client-side if you use the
> AWS CLI.

### 4. Bump the deployment instance

In the instance repo (e.g. `incept5-eve-infra`):

```bash
bin/eve-infra upgrade 0.1.314   # updates config/platform.yaml + overlay image tags
git diff                        # version strings only
```

**Dry-run validated 2026-07-22** against `incept5-eve-infra` (changes reverted).
`upgrade 0.1.314` touched exactly 9 files — `config/platform.yaml` plus the 7
service patches and `db-migrate-job-patch.yaml` — rewriting only version strings.
That the migrate job moves with the `api` tag confirms migrations run from the
`api` image, not the `migrate` image.

> **Which overlay is live matters.** The instance sets `overlay: aws-eks`, whose
> patches **pin** versions (`api:0.1.312`). The repo also carries an unused `aws`
> overlay that tracks the floating `:staging` tag.
>
> This is load-bearing: every `release-v*` build also pushes a `staging` tag. If
> the live overlay were `aws`, a publish would silently roll the cluster,
> breaking the "instance repos roll out explicitly" guarantee. Because it pins,
> publishing is inert until someone bumps the version. **Keep it that way** — do
> not point a hosted environment at the `staging` tag.

### 5. Roll the cluster — *user action*

```bash
bin/eve-infra deploy
bin/eve-infra db migrate        # if the release has schema changes
bin/eve-infra health
```

### 6. Sunset the private repo — *user action*

The private repo already carries two notices, applied 2026-07-22 without a push:
its **description** reads `⛔ RETIRED — development moved to …`, and **pinned
issue [#37](https://github.com/Incept5/eve-horizon/issues/37)** holds the full
retirement notice.

Once a release cut from OSS has deployed green, finish the job:

1. Apply the in-repo file changes from
   [`private-repo-sunset-notice.md`](./private-repo-sunset-notice.md) (README
   banner, `AGENTS.md`/`CLAUDE.md` replacement, delete publish workflows) —
   these need a push, so a maintainer does them.
2. Delete the Actions secrets there once OSS publishes successfully.
3. Archive the repo on GitHub (read-only; preserves history and tags).
   **Archive, never delete** — see the two reasons above.
4. Re-point or delete stale local checkouts (see below), after running the
   unpushed-work check.

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
stale checkout, so an agent starting there is told immediately. Each is a
**local-only commit** — committed so it survives `git checkout .`, never pushed,
since pushing to `private-origin` is forbidden.

> `eve-horizon-3` needed `--no-verify`: it carries a stale beads pre-commit hook
> using the removed `bd hook` syntax, which blocks every commit in that checkout.

### ⚠️ Do not delete `eve-horizon-3` before reading this

That checkout contains **four branches whose commits are on no remote** —
`code-claude-opus-4-5-integrate-builds-releases`,
`code-claude-opus-4-6-scan-main-starter`, `feat/agent-app-api-access`,
`feat/orchestrator-multi-job-concurrency` (Jan–Feb 2026) — plus a stash with
~100 lines of WIP. None of those subjects appear on OSS `main`.

They have been bundled to `/Users/adam/dev/incept5/eve-horizon-3-RESCUE/`
(see its `README.md`). The bundle is **incremental**: unpacking it needs four
base commits that live only in `Incept5/eve-horizon`.

**This is a second, independent reason to archive that repo rather than delete
it.** Before any checkout is deleted, run the same check on it:

```bash
git for-each-ref --format='%(refname:short)' refs/heads/ | while read b; do
  n=$(git rev-list --count origin/main..$b 2>/dev/null)
  [ "${n:-0}" -gt 0 ] && echo "$b: $n commits ahead"
done
git stash list
```

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
