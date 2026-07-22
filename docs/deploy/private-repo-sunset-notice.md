# Private Repo Sunset Notice

Prepared text for retiring `Incept5/eve-horizon`. It lives here because pushing
to `private-origin` is forbidden — a maintainer applies it manually.

**Apply in this order.** The banner must land *before* the archive flip, because
archiving makes the repo read-only.

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

## Pre-flight

Do not start until all of these are true:

- [ ] `eve-horizon/eve-horizon` has its own green `release-v*` publish run
- [ ] Images for that release are pullable from public ECR
- [ ] A deployment instance has rolled that release successfully
- [ ] No local checkout still has `origin` pointed at `Incept5/eve-horizon`

Until then the private repo is still the only thing that can ship a release —
see [`oss-release-cutover.md`](./oss-release-cutover.md).
