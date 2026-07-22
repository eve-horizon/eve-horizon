# Eve Horizon - Project Memory

> **Purpose**: Living document for AI agents and developers. Keep concise.
> **Last Updated**: 2026-05-20

For user docs (deploying apps, running jobs), see [README.md](./README.md).

---

## CRITICAL Rules

0. **Canonical repo**: `github.com/eve-horizon/eve-horizon` is the only repo to work in. `Incept5/eve-horizon` is the retired pre-open-source ancestor — never push to it (`private-origin` push URL must be `DISABLED`). Verify with `git remote get-url origin` before starting. See [oss-release-cutover.md](./docs/deploy/oss-release-cutover.md).
1. **Load Eve docs first**: run `/eve-read-eve-docs`, then check `references/cli.md`, `references/manifest.md`, `references/jobs.md` for your task.
2. **No direct AWS changes**: ALL infra changes go through Terraform in the deployment instance repo that owns the target environment. Read-only AWS CLI is fine for diagnosis; mutations are silently reverted by Terraform.
3. **Check environment first**: run `./bin/eh status` before any build/test/dev activity. Do NOT assume URLs or ports.
4. **Fail fast on provisioning errors**: every error must propagate. No workarounds — fix root causes ("5 Whys").
5. **Fix platform gaps first**: never work around platform limitations in app-level code. Identify gap → fix in eve-horizon → tag `release-v*` → update the app.
6. **Pre-deployment phase**: no users, no backwards-compat. Simplify aggressively, refactor without fear, delete ruthlessly.
7. **CLI-first debugging**: always start with `eve` CLI. Drop to `kubectl` only when CLI is insufficient — then file an issue to add the capability.

---

## Environment Access

| Env | API URL | When |
| --- | --- | --- |
| K8s (k3d) | `http://api.eve.lvh.me` | Manual tests, deploy testing |
| Docker Compose | `http://localhost:4801` | Integration tests, quick dev |
| Local pnpm dev | `http://localhost:4801` | Hot-reload development |
| Staging | `https://api.eve.example.com` | Production-like testing |

**Platform Admin Auth:**
| Env | Email | SSH Key |
| --- | --- | --- |
| Local | `admin@example.com` | `~/.ssh/id_ed25519` |
| Staging | `admin@example.com` | `~/.ssh/id_ed25519` |

```bash
eve profile use local   # or: staging
eve auth login --email <email> --ssh-key ~/.ssh/id_ed25519
```

---

## Developer Quick Start

Prerequisites: Docker Desktop (8GB+, 4+ CPUs), k3d, kubectl.

```bash
./bin/eh status                       # 0. Always start here
./bin/eh k8s start && ./bin/eh k8s deploy
export EVE_API_URL=http://api.eve.lvh.me
eve org ensure test-org --slug test-org
eve project ensure --name test --repo-url https://github.com/org/repo --branch main
./bin/eh k8s stop                     # When done
```

No port-forwarding needed — all services on Ingress:
- API: `http://api.eve.lvh.me`
- Apps: `http://{component}.{orgSlug}-{projectSlug}-{env}.lvh.me`

For multi-project app-link work on the same local stack, use `eve local mesh`:
`eve local mesh init <name> --org <org_id> --env local`, add each checkout with
`eve local mesh add <slug> --path <path>`, then run `eve local mesh up`.

**Dev modes** (mutually exclusive):
- `./bin/eh start local` — DB container + local node processes (hot-reload)
- `./bin/eh start docker` — All services in containers
- `./bin/eh k8s start && ./bin/eh k8s deploy` — K8s stack (manual testing)

---

## Current State

**Phase**: Pre-MVP. K8s runtime, agent runtime, chat gateway, builds/deploy pipeline, auth/RBAC complete.

**Services** (6): API, orchestrator, worker, agent-runtime, gateway, SSO.

**Capabilities**: full auth (SSH, GoTrue+SSO, service principals, custom roles, access groups), default-deny RBAC, K8s deploys with manifest interpolation, BuildKit builds + releases + pipelines, 7 harnesses (mclaude/claude/zai/gemini/code/codex/pi) via `eve-agent-cli`, provider registry, agents/teams/threads with repo-first sync + AgentPacks, Slack+Nostr gateway, org filesystem sync, org docs, cost tracking (receipts, `llm.call` events, budgets, balance ledger), analytics, webhooks, app SSO SDK (`@eve-horizon/auth`), embedded chat SDK (`@eve-horizon/chat`).

**Next**: platform-wide groups with scoped fs/DB ACLs, app compute classes, UI dashboards, Slack interactive approvals.

---

## Releases

CLI version: `0.2.36`. All releases are tag-driven via GitHub Actions, cut from
`eve-horizon/eve-horizon` only.

> ⚠️ **Cutover in progress (2026-07-22)**: this repo has no `release-v*` tags and
> no Actions secrets yet — every image through `0.1.313` was published by the
> retired private repo. Until the secrets are configured and a release is cut
> here, the OSS repo cannot ship. See
> [oss-release-cutover.md](./docs/deploy/oss-release-cutover.md).

| Package | Tag prefix | Workflow |
| --- | --- | --- |
| `@eve-horizon/cli` | `cli-v*` | `publish-cli.yml` |
| `@eve-horizon/auth` + `auth-react` | `sdk-v*` | `publish-sdk.yml` (lockstep) |
| `@eve-horizon/chat` + `chat-react` | `chat-v*` | `publish-chat.yml` (lockstep) |
| Service images | `release-v*` | `publish-images.yml` (publish only; deployment owners roll out separately) |

```bash
git tag <prefix>-v0.1.0 && git push origin <prefix>-v0.1.0
```

Hosted deployments use a three-repo model: this source repo publishes service
images; the public `eve-horizon/eve-horizon-infra` template provides the cloud
scaffold; and a private deployment instance repo created from that template
pulls the images and applies its own manifests, Terraform, secrets, and release
policies. Release tags in this source repo must not trigger hosted/staging
rollouts directly. Only the deployment owner should trigger instance rollouts
from the deployment instance repo. Keep instance-specific operational details in
the private instance repo, not in this public source repo.

```bash
git tag --list 'release-v*' --sort=-version:refname | head -1  # latest tag
```

There's also a `/cli-publish-and-install` skill for manual CLI publishing.

---

## CRITICAL: Job Routing — Agent Runtime vs Worker

The orchestrator routes by execution type. Get this wrong → build on the wrong service.

| Job Type | Routed To | Code |
| --- | --- | --- |
| Agent jobs (chat, manual, scheduled — default) | **Agent Runtime** | `apps/agent-runtime/src/invoke/invoke.service.ts` |
| `execution_type='action'` / `'script'` / legacy pipelines | Worker | `apps/worker/src/invoke/invoke.service.ts` |

`EVE_AGENT_RUNTIME_URL` is set in `k8s/base/orchestrator-deployment.yaml` → ALL agent jobs route to agent-runtime in every env. The worker's harness invoke path is fallback only.

**Rules:**
- Agent execution features (message relay, budget, context, security policy) → **agent-runtime**
- Build/deploy/pipeline features → **worker**
- Both services have `invoke.service.ts` — they are NOT the same file.

Most shared agent-execution logic now lives in `packages/shared/src/invoke/` (composition, not inheritance). See `docs/plans/invoke-parity-and-shared-module-plan.md`.

---

## Architecture

```
User -> CLI -> API -> Orchestrator ─┬─> Agent Runtime ──> Harness -> Agent
         │      │            |      │   (all agent jobs)
Chat -> Gateway ┘        Postgres   │
                                    └─> Worker (builds, deploys, pipelines, scripts)
```

CLI is a thin REST wrapper; only `EVE_API_URL` needed. Visual: [system-overview.md](./docs/system/system-overview.md).

**Key flows**: (1) job created via API → DB; (2) orchestrator claims ready → routes by exec type; (3) agent jobs → agent-runtime → harness → JSONL logs; (4) Slack → gateway → API → jobs+threads → agent-runtime; (5) pipeline step → worker → BuildKit → release → K8s deploy.

---

## Key Decisions

| Decision | Rationale | Doc |
| --- | --- | --- |
| 7 harnesses via eve-agent-cli | Uniform invocation | [harness-execution.md](./docs/system/harness-execution.md) |
| Job (not Task) terminology | Avoid cc-mirror Task* tool collision | [job-api.md](./docs/system/job-api.md) |
| Hierarchical job IDs | `{slug}-{hash8}` root, `{parent}.{n}` children | [job-api.md](./docs/system/job-api.md) |
| Phase-based lifecycle | idea → backlog → ready → active → review → done | [job-api.md](./docs/system/job-api.md) |
| Single repo per project | Simplifies execution + config | [configuration-model-refactor.md](./docs/system/configuration-model-refactor.md) |
| CLI as thin REST wrapper | Single source of truth | [api-philosophy.md](./docs/system/api-philosophy.md) |
| K8s runtime via k3d | Production-like local testing | [deployment.md](./docs/system/deployment.md) |
| Agent runtime runs ALL agent jobs | Worker is builds/pipelines only | [agent-runtime.md](./docs/system/agent-runtime.md) |
| Three-repo deploy model | Source publishes images → public infra template → private deployment instance applies manifests | [oss-release-cutover.md](./docs/deploy/oss-release-cutover.md) |
| BuildKit-first builds | Replaced kaniko | [builds.md](./docs/system/builds.md) |
| GoTrue + SSO broker | Supabase-compatible web auth, dual-mode API auth | [auth.md](./docs/system/auth.md) |
| Default-deny data plane | Members/agents need explicit group-scoped grants | [auth.md](./docs/system/auth.md) |

---

## Conventions

- **IDs**: `org_xxx`, `proj_xxx` (TypeID); root jobs `{slug}-{hash8}` (e.g., `myproj-a3f2dd12`)
- **Job phases**: `idea` → `backlog` → `ready` → `active` → `review` → `done`/`cancelled`
- **Priority**: 0-4 (P0=critical, P4=backlog, default=2)
- **K8s namespaces**: `eve-{orgSlug}-{projectSlug}-{envName}`

---

## Build & Test

Before committing or declaring work complete:

```bash
./bin/eh status              # 0. Environment
pnpm install                 # 1. Refresh workspace links
pnpm build                   # 2. Full build
pnpm test                    # 3. Unit tests
./bin/eh test integration    # 4. Integration tests (docker DB + local pnpm)
```

**Test tiers:**
| Tier | What | Env | Command |
| --- | --- | --- | --- |
| Unit | Pure logic | None | `pnpm test` |
| Integration | API, jobs, secrets | Docker DB + local pnpm | `./bin/eh test integration` |
| Manual | Happy paths on real repos | K8s stack | `tests/manual/` |

Integration tests must hit the API, not the DB directly. Add `--reset-db` for a clean test DB (`eve_test` only, not `eve`).

**Common issues:** `Cannot find module '@eve/shared'` → `pnpm install`. Cascading TS errors → still must fix; blocks CI.

### Manual testing (k8s stack)

Read `tests/manual/README.md` first. Required workflow:

```bash
./bin/eh status                    # Stack must be "running"
eve system health --json           # Must return {"status":"ok"}
eve org ensure "manual-test-org" --slug manual-test-org --json
eve secrets import --org org_manualtestorg --file manual-tests.secrets
# Run scenarios in tests/manual/scenarios/
eve job list --all --phase active
eve job follow <id>                # Real-time log
eve job diagnose <id>              # If stuck
```

---

## Debugging

| Priority | Tool |
| --- | --- |
| 1 | `eve` CLI |
| 2 | `./bin/eh status` |
| 3 | `kubectl` (last resort — then file issue to add CLI capability) |

**Job debugging:**
```bash
eve job show <id> --verbose / eve job follow <id> / eve job logs <id>
eve job result <id> / eve job diagnose <id>
eve env show <project> <env> / eve env diagnose <project> <env>
eve system health --json
```

**Build/deploy ladder:** `eve pipeline logs <pipeline> <run> --follow` → snapshot → `eve build diagnose <id>` → `eve env diagnose` → `eve job diagnose`. Build failures are classified (auth_error, clone_error, build_error, ...) with inline hints — see `docs/system/builds.md`.

**Last resort (kubectl):**
```bash
kubectl -n eve get pods
kubectl -n eve logs -f deployment/eve-orchestrator
```
Startup errors (auth, clone, workspace) appear in orchestrator/worker/runner logs, not `eve job logs`.

---

## Multi-Instance & K8s Ownership

Multiple repo checkouts can run integration tests in parallel. Docker/Postgres/ports are per-instance via `EVE_INSTANCE` prefix and `base_port`. The **k3d cluster is shared** — only one instance should "own" it.

```bash
./bin/eh configure --k8s-owner     # Claim ownership
./bin/eh configure --no-k8s-owner  # Release
./bin/eh configure --staging-owner # Separate flag for staging
```

Config in `.eve-horizon.yaml` (gitignored): `instance`, `base_port`, `k8s_owner`. Default ports: API=4801, Orchestrator=4802, DB=4803, Worker=4811.

**Agent permissions:**
- **Owner** (`k8s_owner: true`): freely rebuild/redeploy/restart. No approval needed.
- **Guest** (`k8s_owner: false`): CAN use CLI + fix code. CANNOT `k8s deploy`/`k8s-image push`/restart. Ask owner or get explicit approval.

Updating secrets:
```bash
./bin/eh k8s secrets                                            # System auth keys from system-secrets.env.local
eve secrets import --org org_manualtestorg --file manual-tests.secrets  # Org/project API keys
```

---

## Sister Repositories

| Repo | Path | Purpose |
| --- | --- | --- |
| [eve-horizon-starter](https://github.com/eve-horizon/eve-horizon-starter) | `../eve-horizon-starter` | Starter template |
| [eve-horizon-fullstack-example](https://github.com/eve-horizon/eve-horizon-fullstack-example) | `../eve-horizon-fullstack-example` | Example app for deploy testing |
| [eve-skillpacks](https://github.com/eve-horizon/eve-skillpacks) | `../eve-skillpacks` | Published skill packs |
| ingest-agentpack | `../../eve-horizon/ingest-agentpack` | Document ingestion AgentPack |

If these are present at expected paths, agents may commit and push to `main` without explicit approval.

### CRITICAL: eve-skillpacks sync obligation

`eve-skillpacks/eve-work/eve-read-eve-docs/references/` is the public docs agents read to learn Eve. When platform behavior changes, update the matching reference file:

| Change | Reference |
| --- | --- |
| CLI commands/flags | `cli.md` |
| Manifest schema, x-eve | `manifest.md` |
| Event types, triggers | `events.md` |
| Job fields, phases, git | `jobs.md` |
| Build/release model | `builds-releases.md` |
| Agent/team/chat YAML | `agents-teams.md` |
| Pipelines/workflows | `pipelines-workflows.md` |
| Secrets, auth | `secrets-auth.md`, `app-context.md` |
| Skills system | `skills-system.md` |
| Deploy, debugging | `deploy-debug.md` |
| Harness profiles, models | `harnesses.md` |
| Gateway plugins | `gateways.md` |
| Architecture, IDs | `overview.md` |
| New file added | `SKILL.md` (index) |

Outdated docs → agents make wrong assumptions, write broken manifests. See `eve-docs-upkeep` skill.

---

## Documentation Map

Most-used:
- [ARCHITECTURE.md](./ARCHITECTURE.md) · [docs/system/README.md](./docs/system/README.md) (index)
- [deployment.md](./docs/system/deployment.md) · [staging.md](./docs/deploy/staging.md) · [secrets.md](./docs/system/secrets.md)
- [oss-release-cutover.md](./docs/deploy/oss-release-cutover.md) · [ci-cd.md](./docs/system/ci-cd.md) — canonical repo, release tags, artifact inventory
- [job-cli.md](./docs/system/job-cli.md) · [agent-runtime.md](./docs/system/agent-runtime.md) · [agents.md](./docs/system/agents.md)
- [chat-gateway.md](./docs/system/chat-gateway.md) · [integrations.md](./docs/system/integrations.md) · [auth.md](./docs/system/auth.md)
- [eve-sdk.md](./docs/system/eve-sdk.md) · [eve-auth-sdk.md](./docs/system/eve-auth-sdk.md) · [app-sso-integration.md](./docs/system/app-sso-integration.md)
- [builds.md](./docs/system/builds.md) · [pipelines.md](./docs/system/pipelines.md) · [harness-execution.md](./docs/system/harness-execution.md)
- [pricing-and-billing.md](./docs/system/pricing-and-billing.md) · [analytics.md](./docs/system/analytics.md) · [webhooks.md](./docs/system/webhooks.md)

---

## Codebase Knowledge Graph (graphify)

Local-only tooling (gitignored). **If `graphify-out/graph.json` exists**, prefer it for structural questions over grep.

| Use graph | Use Grep/Read |
| --- | --- |
| "How does X connect to Y?", god nodes, cross-cutting concerns | "Where is `foo()` called?", current code, recent changes |

```
/graphify query "..."     /graphify path "A" "B"     /graphify explain "Node"
```

**Caveats**: graph can be stale — verify with Read/Grep before acting. Edges tagged EXTRACTED (trust), INFERRED (lead), AMBIGUOUS (verify). Don't commit `graphify-out/`. Don't run `/graphify` unprompted — it's a multi-minute, multi-dollar op.

---

## Beads Work Tracking

Use `bd` for task tracking. Update status immediately after work. Beads state is
Dolt-backed; keep public-safe issue content only, and do not hard-code private
sync remotes in tracked config.

```bash
bd ready                              # What's available
bd create --title "..." --type task
bd update <id> --status in_progress
bd close <id> --reason "..."
```

---

## Landing the Plane (Session Completion)

Work is NOT complete until `git push` succeeds.

1. File issues for follow-up work
2. Run quality gates (tests, lint, build) if code changed
3. Update issue status (close finished, update in-progress)
4. **Push:**
   ```bash
   git pull --rebase && git push && git status   # must show "up to date with origin"
   ```
5. Clean up stashes; prune remote branches
6. Verify all committed AND pushed
7. Hand off context for next session

Never stop before pushing. Never say "ready to push when you are" — push it.

---

## Update Log

- **2026-07-22**: OSS release cutover started. Audit found `eve-horizon/eve-horizon` has **0 git tags and 0 Actions secrets** — every image through `0.1.313` was published by the retired `Incept5/eve-horizon`, so hosted envs are still fed by the private repo. New [oss-release-cutover.md](./docs/deploy/oss-release-cutover.md) (canonical repo, required secrets, verified artifact inventory, cutover steps) + [private-repo-sunset-notice.md](./docs/deploy/private-repo-sunset-notice.md). `docs/system/ci-cd.md` rewritten to cover all 9 workflows. Corrected the deploy model from "two-repo" to three-repo (source → public infra template → private instance). Verified: OSS workflows are clean of rollout coupling; only 7 service images + 5 toolchain images are consumed by a deployment; `worker-images` has never succeeded and `publish-migrate` last failed 2026-02-18, but neither is a cutover blocker. Also fixed `toolchain-images.yml`: it combined a `paths:` filter with a tag trigger, so a toolchain publish could silently no-op when the tagged commit didn't touch `docker/toolchains/**` — no images, no failure. Disambiguation banners added to the `eve-source` checkout (proprietary predecessor whose CLAUDE.md calls itself "Eve Horizon") and stop banners to `eve-horizon-3/-4/-5`. Verified every publish workflow against the private versions that shipped `0.1.313`: functionally identical (only a guardrail comment differs), so missing secrets are the sole blocker, not drift. Found unpushed work in the `eve-horizon-3` checkout — 4 branches on no remote plus a stash — bundled to `eve-horizon-3-RESCUE/`; it needs base commits that exist only in the private repo, so that repo must be **archived, not deleted**. Blocked on user: add `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`NPM_TOKEN` to the OSS repo, then cut `release-v0.1.314`.
- **2026-07-14**: Fixed manual DB snapshots crashing the API pod (`release-v0.1.313`): `apps/api/Dockerfile` now installs postgresql-client-16 (pg_dump ran in-pod but was never installed; the unhandled spawn `error` event killed the whole API and orphaned the snapshot row as `in_progress`, blocking retries). `executeSnapshot`/`executeRestore` in `packages/shared/src/managed-db/snapshot-executor.ts` now listen for spawn errors from spawn time and surface the process error over secondary stream errors. Staging infra now sets `EVE_DB_SNAPSHOT_BUCKET` (was defaulting to nonexistent `eve-local-db-snapshots`) and enables the snapshot pruner. New deployment instances need the same env wiring — see template backport issue.
- **2026-06-12**: Dashboard rebuilt as read-only "Horizon" UI (`apps/dashboard`): new IA (Home/Apps/Jobs/Costs/System-admin) with legacy-route redirects, responsive shell (desktop sidebar, tablet rail, mobile bottom tabs), dark-first design system. New per-app cloud cost attribution: `GET /orgs/:org_id/cost/apps` (`orgs:read`, cluster figures redacted) + `GET /admin/cost/apps` (`system:admin`), allocating `cloud_cost_snapshots` (AWS CE) across apps by OpenCost weights with explicit platform-overhead remainder — see `apps/api/src/billing/app-cost.service.ts`. Fixed `@eve-horizon/auth-react` StrictMode race that cleared valid tokens on cancelled bootstrap. Demo cost seed: `tests/manual/seed-demo-costs.sql`. Screenshot harness: `apps/dashboard/scripts/shoot.mjs`.
- **2026-06-03**: Agent-runtime inline execution now honors declared `toolchains` using shared on-demand provisioning before harness start, fails fast with `toolchain_unavailable`, records `runtime_meta.toolchains`, and orchestrator watchdogs now classify pre-acceptance/pre-harness wedges as `attempt_init_timeout` / `attempt_startup_timeout`.
- **2026-06-02**: Cloud FS browse/search now support provider-neutral pagination (`page_token`, `page_size`, `order_by`) and search MIME filters. `eve cloud-fs ls/search --all` auto-pages with `complete`/`page_count` JSON metadata, while recursive browse is bounded server-side and rejects cursors.
- **2026-05-20**: Budget enforcement is cache-aware: `max_tokens` compares weighted tokens, discounting cache-read tokens by the active rate card while `max_cost` remains the authoritative cap; `budget.summary` and `budget.exceeded` logs expose the raw/weighted breakdown.
- **2026-05-19**: Agents-only projects no longer need stub `teams.yaml` or `chat.yaml` files; implicit missing teams/chat config defaults to empty teams/routes, explicit manifest paths remain strict, and `eve agents config --json` reports resolved agent/team/route summaries.
- **2026-05-18**: Added HTTP ingress tuning for tenant apps. `x-eve.ingress.timeout` and `max_body_size` render nginx-ingress timeout/body-size annotations with platform defaults `EVE_DEFAULT_INGRESS_TIMEOUT=300s` and `EVE_DEFAULT_INGRESS_MAX_BODY_SIZE=10m`; `eve env diagnose` now surfaces `.http_ingress[]`.
- **2026-05-12**: Shipped `domain_signup` v2 schema (breaking) in `release-v0.1.281`. `x-eve.auth.org_access.domain_signup.domains` is now a list of `{ domain, target_org, role }` — one rule per domain. Sync validates per-rule `target_org ∈ allowed_orgs`, rejects duplicates, IDN-normalizes. `sendAppMagicLink` Path C does first-match in declaration order; matched rule's `target_org` becomes the invite's org. Unblocks ACME Portal multi-tenant from one project.
- **2026-05-12**: SSO session cookies use `SameSite=None` when `EVE_SSO_SECURE_COOKIES=true` (`apps/sso/src/main.ts`), fixing custom-domain redirect loop on the cross-site `fetch(SSO/session)` probe. Local k3d keeps `Lax` (no `Secure`).
- **2026-05-11**: Shipped `release-v0.1.279` (app magic-link domain allowlist) + `release-v0.1.278` (project-scoped redirect allowlist for custom-domain apps; `x-eve.auth.allowed_redirect_origins` plus auto-derived cross-org domains). New CLI: `eve project auth-context <project_id>`.

Older entries in git log.
