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

Audited 2026-07-22, re-audited after remediation. **Verdict: ONE BLOCKER LEFT —
the retired repo can still publish to production. Everything else is clear.**

| Precondition | State |
| --- | --- |
| Sunset notices carried | ✅ description + pinned issue [#37](https://github.com/Incept5/eve-horizon/issues/37) |
| Open PRs frozen by archiving | ✅ none — all 4 closed 2026-07-22 |
| Open issues needing migration | ✅ none |
| Work destroyed by archiving | ✅ none — archive preserves all branches, tags, history |
| **Can still publish to production** | ❌ **blocker — see below** |

That last one cannot be cleared until the public repo can publish, because until
then this repo is the only thing that can ship a release.

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

### ~~Blocker 2~~ — CLEARED 2026-07-22: all four PRs closed

Archiving makes a repo read-only, so open PRs can never be merged afterwards.
None of the four branches exists on the OSS repo. **Triaged 2026-07-22 against
OSS `main` — three are superseded and can simply be closed:**

| PR | Branch | Verdict | Evidence in OSS |
| --- | --- | --- | --- |
| [#25](https://github.com/Incept5/eve-horizon/pull/25) | `feat/chat-file-materialization` | ✅ **landed — close** | `docs/plans/chat-file-materialization-plan.md` reads *"Status: Implemented (2026-03-09)"*; all 14 of the PR's files present, including both files it created (`schemas/chat-file.ts`, `lib/sanitize-filename.ts`) |
| [#14](https://github.com/Incept5/eve-horizon/pull/14) | `feat/eve-horizon-78-cli-deploy-diagnostics` | ✅ **landed — close** | `eve env diagnose` implemented (`packages/cli/src/commands/env.ts:297`) with the `--events/--request/--window` flags |
| [#31](https://github.com/Incept5/eve-horizon/pull/31) | `feat/app-stable-egress` | ✅ **pivoted away from — close** | `app-stable-egress-v2-plan.md` explicitly supersedes the v1 Tailscale sidecar design this PR implements; the replacement `networking.egress: nat\|stable` knob is live in `schemas/manifest.ts` |
| [#2](https://github.com/Incept5/eve-horizon/pull/2) | `plan/dogfood-registry` | ⚠️ **needs a human** | Registry manifests exist in `k8s/base/` and `container-registry.md` is written, but `eve-native-container-registry-plan.md` is still **Draft**. Partially landed at best; +1708/−77 across 34 files, last touched 2026-01-20 |

**All four were closed on 2026-07-22**, each with a comment citing the evidence
above. The repo now has **0 open PRs**, so archiving freezes nothing.

> ⚠️ **#2 was closed as a judgement call, against the weaker evidence.** Its
> work only partially landed and its plan is still Draft. If the Eve-native
> registry is still wanted, port it onto OSS `main` as fresh work — the
> histories are disjoint, so reviving the branch is not the route. The closing
> comment on #2 records this. Commits survive on the branch either way.

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
- [ ] PRs #25, #14, #31 closed as superseded (no porting needed — see triage above)
- [ ] PR #2 (`plan/dogfood-registry`) reviewed and closed or ported
- [ ] No local checkout still has `origin` pointed at `Incept5/eve-horizon`

Until these hold, the private repo is still the only thing that can ship a
release — see [`oss-release-cutover.md`](./oss-release-cutover.md).
