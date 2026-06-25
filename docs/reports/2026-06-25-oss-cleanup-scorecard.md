# OSS Cleanup Scorecard - 2026-06-25

This scorecard tracks the public-readiness cleanup for Eve Horizon and the
in-scope satellite repositories. It records evidence for what was cleaned,
what was relocated into a private deployment-instance repository, and what still
needs approval or separate repository work.

## Rules

- Allowed public references to the original owner: MIT license/copyright and
  trademark ownership text only.
- Not allowed in public repos: live deployment details, AWS account IDs, cluster
  names, kubeconfig paths, internal hostnames, private infra paths, personal
  emails, historical Beads issue history, or private operational runbooks.
- Deployment-instance details that still matter should be preserved privately in
  the owning instance repo rather than genericized away.
- Do not mutate AWS directly. All AWS infrastructure changes must go through
  Terraform in the deployment instance repo that owns the target environment.

## Tooling

| Check | Status | Evidence |
| --- | --- | --- |
| Private-reference `rg` scan | Pass with allowed exceptions | Scan for original owner/customer/staging terms now returns only MIT copyright/trademark lines in Eve Horizon; in-scope satellite and remote-only repos have no actionable matches outside `LICENSE`/copyright text. |
| Email/private-host/ID scan | Pass with examples only | Concrete local paths, private hosts, private emails, and generated-looking org/project IDs are absent from cleaned trees. Remaining email/domain examples are placeholders or public provider behavior. |
| `gitleaks` | Unavailable locally | Not installed in this environment; rerun in CI or an environment with the tool before any final public visibility change if required. |
| `trufflehog` | Unavailable locally | Not installed in this environment; rerun in CI or an environment with the tool before any final public visibility change if required. |
| Beads bootstrap/ready | Pass with caveat | Local embedded DB was regenerated from sanitized `.beads/issues.jsonl`; `bd ready --json` now returns no ready work after closing the approved history gate and parent OSS epic. Fresh snapshot bootstrap imports eight public-safe issues. `bd doctor` reports embedded mode is not supported. |
| Package tests | Pass | `@eve/shared`, `@eve/api`, `@eve/worker`, `@eve/orchestrator`, and `@eve-horizon/cli` tests passed. |
| Monorepo build | Pass | `pnpm build` completed successfully. |
| `eve-horizon-showcase` build | Pass | `npm run build` completed successfully. `npm run lint` still fails on a pre-existing `react-hooks/set-state-in-effect` issue in `src/hooks/useMermaid.ts`. |
| `eve-skillpacks` compliance helper | Pass | `private-skills/sync-horizon/scripts/check-state-today.sh` passed. |

## Relocated Private Context

The legacy Beads database was backed up outside git at
`/private/tmp/eve-horizon-beads-private-backup-20260625T102410Z`.

The following public-tree files were removed after copying private operational
context into the private deployment-instance repo's relocated-audit area:

- `docs/reports/2026-02-04-staging-chat-agents-verification.md`
- `docs/reports/2026-02-19-eve-horizon-aws-cost-audit.md`
- `docs/reports/2026-03-30-platform-sentinel-rollout-verification.md`
- `docs/reports/2026-06-04-daily-health-cloud-cost-staging-evidence.md`
- `docs/plans/2026-02-19-aws-cost-savings-implementation.md`
- `tests/manual/scenarios/42-mailer-suppression.md`

The private repo was already dirty and behind origin before this work. To avoid
mixing unrelated dirty files into the relocation, the copied docs were committed
and pushed from a clean temporary worktree in private infra commit `6095934`.

## Repo Inventory

| Repo | Local state | Public/license state | Cleanup status | Notes |
| --- | --- | --- | --- | --- |
| `eve-horizon` | Pushed; local checkout intentionally diverged | Private source, MIT metadata; clean-history public repo at `https://github.com/eve-horizon/eve-horizon` | Current tree landed; public snapshot path approved | Cleaned tree and scorecard updates are on `origin/main`; local `main` still contains an unsafe unpushed `bd init` commit and should not be pushed. The public repo is a clean-history snapshot so legacy private source history remains private. |
| Private deployment-instance repo | Behind origin; dirty pre-existing metadata | Private | Relocation landed | Relocated private context committed in `6095934`; unrelated dirty state remains in the local checkout. |
| `../eve-horizon-starter` | Dirty local checkout, remote pushed | Public, root `LICENSE` added | Landed via clean worktree | Genericized private URLs/images and added MIT license without touching local port changes. Commit `cc5a02a`. |
| `../eve-horizon-fullstack-example` | Dirty local feature checkout, remote `main` pushed | Public, root `LICENSE` added | Landed via clean worktree | Genericized private repo/image references and added MIT license without touching local pack-lock change. Commit `a56ccc4`. |
| `../eve-horizon-showcase` | Clean, pushed | Public, root `LICENSE` added | Landed | Removed tracked `.eve/profile.yaml`, genericized private URLs/IDs, added ignored local profile path. Commit `f3eaa07`. |
| `../eve-software-factory` | Clean, pushed | Public, root `LICENSE` added | Landed | Added root MIT `LICENSE`; no actionable private-reference matches. Commit `9c30382`. |
| `../eve-skillpacks` | Clean, pushed | Public, root `LICENSE` added | Landed | Removed tracked `.eve/profile.yaml`, genericized hosted deployment examples and private repo slugs. Commit `4708154`. |
| Public remote-only repos | Verified from temporary clones | Public/MIT | Current trees clean | `eve-horizon-infra` scrubbed through `6365e30`, `eve-quickstart` through `c7eada0`, `eve-horizon-docs` through `db9693b`; `ingest-agentpack` and `learning-loop-agentpack` verified clean/public/MIT. |

## Eve Horizon Changes

| Area | Status | Action |
| --- | --- | --- |
| Agent instructions | Cleaned | Replaced deployment-instance-specific kubeconfig/context guidance with generic public safety rules. |
| Release workflow | Cleaned | Removed source-repo dispatch to a private deployment repo; release tags now publish images only. |
| Public docs and plans | Cleaned | Genericized private org/customer/deployment examples while preserving reusable platform design content. |
| Historical reports and private manual scenario | Relocated/removed | Preserved privately where useful, deleted from public tree. |
| Beads | Clean baseline | Legacy DB backed up outside git; tracked export replaced with eight public-safe issues. |

The history approval gate was resolved by choosing the clean-history public repo
path and keeping the legacy source repository private:

- `eve_horizon-tm9`: closed after approval to publish a clean-history repo under
  `eve-horizon/eve-horizon`.

## Remaining Caveats

- The legacy private source repository history still contains old tracked Beads
  and historical private docs. Keep that repository private unless a separate
  history rewrite/filtering plan is explicitly approved.
- The current local `main` has an unpushed `bd init` commit that includes the
  legacy Beads sync remote and Adam's email in commit metadata. It must be
  amended/squashed locally or avoided with a clean branch before any push.
- Private deployment-instance repo still has unrelated dirty/behind state in the
  local checkout, but relocated private context has been committed from a clean
  temporary worktree.
- Local dirty checkouts remain in `eve-horizon-starter` and
  `eve-horizon-fullstack-example`, but their remote `main` cleanup commits were
  landed from temporary clean worktrees.
- `gitleaks` and `trufflehog` are unavailable locally unless installed or run in CI.
