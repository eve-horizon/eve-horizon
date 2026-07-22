# Private Repo Sunset Notice

Prepared text for retiring `Incept5/eve-horizon`. It lives here because pushing
to `private-origin` is forbidden — a maintainer applies the in-repo parts
manually.

## Already applied (2026-07-22)

Two notices are live on the private repo. Neither is a git push and neither
touches history, so both were safe to apply ahead of the cutover:

| What | Value | Undo |
| --- | --- | --- |
| Repo description | `⛔ RETIRED — development moved to github.com/eve-horizon/eve-horizon` | `gh api -X PATCH repos/Incept5/eve-horizon -f description="…"` |
| Pinned issue [#37](https://github.com/Incept5/eve-horizon/issues/37) | Full retirement notice | `gh issue unpin 37 -R Incept5/eve-horizon && gh issue close 37 -R Incept5/eve-horizon` |

Leave issue #37 open and pinned until the repo is archived.

## Still to apply — needs a maintainer

The steps below modify files, which requires a push. **Apply in this order** —
the banner must land *before* the archive flip, because archiving makes the repo
read-only.

---

## 1. Prepend to `README.md`

```markdown
> # ⚠️ This repository is retired
>
> Development moved to **https://github.com/eve-horizon/eve-horizon**.
>
> This repo is the pre-open-source ancestor of Eve Horizon. It is kept read-only
> for its history and for the `release-v*` tags that built the images running in
> existing deployments. **Do not open PRs, push commits, or cut releases here.**
>
> - Source of truth: https://github.com/eve-horizon/eve-horizon
> - Deploy scaffold: https://github.com/eve-horizon/eve-horizon-infra
> - Issues and discussion: the public repo
>
> Have a local clone pointed here? Re-point it:
>
> ```bash
> git remote set-url origin git@github.com:eve-horizon/eve-horizon.git
> git fetch origin && git reset --hard origin/main
> ```
```

## 2. Replace `AGENTS.md` and `CLAUDE.md` in full

Both files, same content. Agents read these first, so the notice must be
unmissable and must not be followed by stale build instructions.

```markdown
# ⛔ STOP — this repository is retired

You are in `Incept5/eve-horizon`, the **pre-open-source ancestor** of Eve
Horizon. It is archived and read-only.

**Do not do any work here.** No commits, no builds, no releases, no tests, no
deploys. Nothing you do in this repo will reach production.

## Where to go instead

| You want to | Go to |
| --- | --- |
| Change platform code | `github.com/eve-horizon/eve-horizon` |
| Change deploy manifests or Terraform | the deployment instance repo that owns the environment |
| Cut a release | `eve-horizon/eve-horizon`, tag `release-v*` |

If you have a local clone pointed at this repo, re-point it:

```bash
git remote set-url origin git@github.com:eve-horizon/eve-horizon.git
git fetch origin && git reset --hard origin/main
```

## Why this repo still exists

It holds the `release-v*` tags (through `release-v0.1.313`) that built the
images in `public.ecr.aws/w7c4v0w3/eve-horizon` used by existing deployments,
plus the full pre-open-source history. Both are worth keeping. Neither is a
reason to work here.
```

## 3. Disable the publish workflows

Before archiving, remove the release triggers so a stray tag push cannot publish
from here. Delete `.github/workflows/publish-*.yml`, `worker-images.yml`, and
`toolchain-images.yml`, or replace each `on:` block with a manual-only stub.

Leave `ci.yml` alone — harmless, and green CI on the final commit is useful.

## 4. Rotate or scope down the credentials

The private repo holds `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`NPM_TOKEN`, `DEPLOY_DISPATCH_TOKEN`, `STAGING_KUBECONFIG`, and
`STAGING_API_URL`.

Once the public repo publishes successfully with its own copies, delete them
here. `DEPLOY_DISPATCH_TOKEN`, `STAGING_KUBECONFIG`, and `STAGING_API_URL` must
**not** be recreated in the public repo — the source repo never triggers
rollouts.

## 5. Archive

GitHub → Settings → Danger Zone → **Archive this repository**.

Archiving is reversible and preserves every commit, tag, issue, and PR.

**Do not delete the repo.** Two independent reasons:

1. The `release-v*` tags are the provenance record for images currently running.
2. Unpushed work rescued from the `eve-horizon-3` checkout is stored as an
   *incremental* bundle that needs base commits which exist only here — see
   [`oss-release-cutover.md`](./oss-release-cutover.md#️-do-not-delete-eve-horizon-3-before-reading-this).

---

## Archive readiness audit

Audited 2026-07-22. **Verdict: NOT READY — two blockers, one of them a live
risk that exists today.**

### Blocker 1 — the retired repo can still publish to production

| Check | State |
| --- | --- |
| `publish-images.yml`, `publish-cli.yml`, `toolchain-images.yml` present | ✅ yes |
| AWS + NPM secrets live | ✅ 3 secrets |
| Workflow state | `active` |

A `release-v*` tag pushed here **right now** would build and push images to the
same production ECR namespace the clusters pull from — from the retired repo.

**Do not fix this by disabling the workflows yet.** Until the public repo can
publish, this repo is the *only* thing that can ship a release, including a
hotfix. Removing that ability before the cutover would leave you unable to ship
at all. The correct sequence is:

1. OSS publishes a release successfully →
2. *then* delete the secrets here and remove the publish workflows →
3. *then* archive.

Archiving also disables Actions on its own, so step 3 closes this permanently.

### Blocker 2 — four open PRs would be frozen unmergeable

| PR | Branch | On OSS? |
| --- | --- | --- |
| [#31](https://github.com/Incept5/eve-horizon/pull/31) | `feat/app-stable-egress` | ❌ no |
| [#25](https://github.com/Incept5/eve-horizon/pull/25) | `feat/chat-file-materialization` | ❌ no |
| [#14](https://github.com/Incept5/eve-horizon/pull/14) | `feat/eve-horizon-78-cli-deploy-diagnostics` | ❌ no |
| [#2](https://github.com/Incept5/eve-horizon/pull/2) | `plan/dogfood-registry` | ❌ no |

Archiving makes a repo read-only — these can never be merged afterwards. None of
the four branches exists on the OSS repo. Each needs a decision: **port to OSS**
or **close as abandoned**. The commits survive archiving either way; only the
ability to merge them here is lost.

### Cleared

| Check | Result |
| --- | --- |
| Open issues needing migration | ✅ none (only the retirement notice #37) |
| Work lost by archiving | ✅ none — archiving preserves all 62 branches, all tags, all history |
| Release tag provenance preserved | ✅ yes, provided you archive rather than delete |

> **Not a finding**: all 62 remote branches are "unreachable from OSS `main`".
> That is expected — the open-source migration rewrote history, so the two repos
> share **no common ancestor** at all. It does not indicate lost work.

### Remaining pre-flight

- [ ] `eve-horizon/eve-horizon` has its own green `release-v*` publish run
- [ ] Images for that release are pullable from public ECR
- [ ] A deployment instance has rolled that release successfully
- [ ] Secrets deleted here; publish workflows removed (**after** the above)
- [ ] The 4 open PRs ported to OSS or closed
- [ ] No local checkout still has `origin` pointed at `Incept5/eve-horizon`

Until these hold, the private repo is still the only thing that can ship a
release — see [`oss-release-cutover.md`](./oss-release-cutover.md).
