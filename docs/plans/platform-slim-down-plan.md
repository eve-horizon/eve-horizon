# Platform Slim-Down Plan

> **Status**: Draft — awaiting approval (no deletions until approved)
> **Created**: 2026-07-03
> **Goal**: A leaner eve-horizon codebase. Remove features with no usage evidence across the apps running on incept5 staging (eh1), remove dead code and stale docs, keep everything in use working.
> **Evidence source**: read-only sweep of `https://api.eh1.incept5.dev` (2026-07-03) + repo manifests of all deployed apps + codebase audit.
> **Verification**: local k3d stack (`./bin/eh k8s deploy` + `pnpm build/test` + `./bin/eh test integration` + affected `tests/manual/` scenarios). Staging is never mutated by this work.

---

## 1. Staging inventory (ground truth)

16 orgs, 46 projects, **28 deployed environments across 24 projects** (the "~30 apps").
One production env: `limelee/production`. `org_manualtestorg` (mto) is the platform's own
manual-test org — usage that appears *only* there counts as test-harness usage, not app usage.

| Project (slug) | Org | Envs | Notes |
| --- | --- | --- | --- |
| alltrack | Incept5 | dev, sandbox | agents(8), workflows, Slack, custom domain, audit_log_table, object_store |
| eden | Incept5 | sandbox | agents(16), team, routes, packs, app-event workflows, CLI export |
| pmbot | Incept5 | sandbox | agents(8), team, route, packs, app-event workflows |
| evepm | Incept5 | sandbox, staging | agents(10), team, routes(10) |
| evdocs | Incept5 | sandbox, staging | github push trigger, cron workflow |
| evskill | Incept5 | (jobs only) | cron workflow (sync-horizon), codex harness |
| canopy | Incept5 | staging | cron pipelines ×4, manual workflows, job steps |
| chivospk, fema, pvscam, realta, sentmgr, trpthr, evshow | Incept5 | 1 each | standard build+deploy apps |
| ChivWP, ChivATM | Aderiz | staging each | build+deploy, ingress timeout |
| limelee | Piexrre | staging, **production** | custom domains(3), ingress.domains |
| gymparse, Bhiblee | Piexrre | 1 each | standard |
| fondr | SashaSaw | sandbox | object_store |
| obscore, obssim | demo | sandbox each | app_links, x-eve.auth, branding, cron |
| iron | misterwavey | staging | ingress.annotations |
| dtest, dtest2, fstack, … (×15) | mto | test | platform manual-test projects |

## 2. Feature-usage matrix

Legend: **USED** = real-app evidence · **TEST-ONLY** = only mto/manual tests · **ZERO** = no usage found anywhere on staging · **PLATFORM** = consumed by platform itself/operators (kept regardless of app usage) · **UNKNOWN** = could not verify read-only (RBAC default-deny blocked).

### Deploy / manifest surface

| Feature | Verdict | Evidence (consumers) |
| --- | --- | --- |
| services build/image/ports/depends_on/healthcheck | USED | 27 projects |
| `x-eve.ingress` public/port/alias | USED | 23 / 22 / 11 projects |
| `x-eve.ingress.timeout` | USED | ChivATM, ChivWP, iron |
| `x-eve.ingress.annotations` | USED | iron |
| `x-eve.ingress.domains` + custom-domains API | USED | limelee (3 domains), alltrack (1) |
| `x-eve.managed` (managed Postgres) | USED | 17 projects |
| managed extensions | USED | obscore |
| `x-eve.role` / `x-eve.permissions` | USED | 18 / 4 projects |
| `x-eve.files` | USED | 12 projects |
| `x-eve.api_spec` (+ `eve api`) | USED | 10 projects |
| `x-eve.cli` (app CLI) | USED | eden, obscore, pmbot |
| `x-eve.object_store` (buckets) | USED | alltrack, fondr |
| `x-eve.audit_log_table` / `request_id_column` | USED | alltrack, obscore / alltrack |
| `x-eve.networking.egress` | USED | pvscam |
| `x-eve.health` | USED | limelee |
| `x-eve.external` service | USED | alltrack |
| `x-eve.auth` (org_access, self_signup, login_method, invite_requires_password) | USED | alltrack, obscore |
| `x-eve.auth.org_access.domain_signup` | USED | alltrack |
| `x-eve.auth.allowed_redirect_origins` | USED | alltrack |
| `x-eve.branding` | USED | alltrack, obscore |
| `x-eve.app_links` (consumes/exports) | USED | obscore, obssim |
| `x-eve.packs` (AgentPacks) | USED | eden, evepm, evskill, fullstack, pmbot |
| `x-eve.defaults` (env/git/harness/hints/workspace) | USED | 9 projects |
| `x-eve.requires.secrets` | USED | alltrack, evqs |
| service `volumes` | USED | trpthr |
| ingest API (`eve ingest`) | UNKNOWN (likely used by eden doc-ingestion) | dingest (mto) has parsed agent |

### Pipelines / workflows / jobs

| Feature | Verdict | Evidence |
| --- | --- | --- |
| pipelines: build→release→deploy | USED | 21 projects |
| pipeline `job`/`run` service steps | USED | canopy (7), 9 projects migrate steps |
| pipeline `create-pr` action | USED | evqs, fullstack (remediation) |
| pipeline `agent` steps | USED | evqs, fullstack |
| github push triggers | USED | evdocs, evqs, fullstack |
| cron triggers | USED | canopy(4), evdocs, evqs, evskill, obscore |
| system event triggers (job.failed, ingestion) | USED | evqs, fullstack, eden, pmbot |
| app event triggers | USED | eden, pmbot |
| workflows (invoke) | USED | 9 projects |
| jobs API (agent jobs) | USED | 743 jobs sampled; all orgs |
| job batch / batch graphs | TEST-ONLY | batcht (mto) |
| resource_refs | TEST-ONLY (12 jobs, mto) | rrtest (mto) |
| budgets (hints.max_cost/max_tokens) | USED | alltrack |
| harness profiles | USED | alltrack (8 profiles), fullstack |

### Harnesses (job sample: latest ≤100/org + manifest defaults)

| Harness | Verdict | Evidence |
| --- | --- | --- |
| claude | USED | Incept5+mto jobs; alltrack, sentmgr manifests |
| codex | USED | Incept5 jobs; alltrack, evskill manifests |
| mclaude | USED (light) | evqs manifest; mto jobs |
| zai | TEST-ONLY-ish | fullstack manifest; mto jobs only |
| pi | TEST-ONLY | mto jobs only (integration plan Phase 2 pending) |
| gemini | **ZERO** | no jobs, no manifests |
| code | **ZERO** | no jobs, no manifests (codex uses same adapter family) |

### Agents / chat / gateway

| Feature | Verdict | Evidence |
| --- | --- | --- |
| agents/teams/chat routes (repo-first sync) | USED | alltrack(8/0/0), eden(16/1/2), pmbot(8/1/1), evepm(10/1/10) |
| Slack gateway plugin | USED | org_Incept5 + mto active integrations |
| Nostr gateway plugin | **ZERO** | 0 integrations on staging |
| webchat plugin / embedded chat SDK (`@eve-horizon/chat`) | **ZERO** (no integrations) | 0 webchat integrations |
| api gateway provider | TEST-ONLY | `eve chat simulate` path |
| org threads API | TEST-ONLY | only mto (4) |
| agent memory / KV | UNKNOWN (RBAC) | likely used by alltrack/eden agents |
| supervise / coordination threads | USED (via teams) | eden, pmbot, evepm teams |

### Platform / org features

| Feature | Verdict | Evidence |
| --- | --- | --- |
| SSH auth, GoTrue+SSO, magic links | USED / PLATFORM | all login flows |
| service principals | USED | org_Incept5 (3) |
| custom roles | TEST-ONLY | mto (1 role) |
| access groups | **ZERO** | 0 across all orgs |
| webhooks (outbound) | **ZERO** | 0 subscriptions across all orgs |
| cloud-fs (Drive mounts) | **ZERO** | 0 mounts across all orgs |
| private endpoints (Tailscale) | **ZERO** | 0 across all orgs |
| org-fs sync | UNKNOWN (RBAC 403) | — |
| org docs | UNKNOWN (RBAC 403); mto has 4 | eden/pmbot ingestion may write docs |
| cost tracking / receipts / budgets / balance | PLATFORM | dashboard + operators |
| analytics | PLATFORM | dashboard Home/Costs |
| dashboard (Horizon UI) | PLATFORM | operators |
| GPU wake via ASG | **ALREADY REMOVED** | inference-simplification-plan complete; CLAUDE.md stale |

### Legacy shims — staging-app dependency check

| Shim | Verdict | Evidence |
| --- | --- | --- |
| `x_eve` (underscore spelling) | ZERO — removable | 0 staging manifests, 0 repo manifests |
| `api_spec` (singular) | **USED — keep** | 10 apps use singular; `api_specs` array has **zero** users (drop the array shape instead) |
| `project:` alias of `name:` | **USED — keep** | 16 repo manifests use `project:`, only 6 use `name:` |
| chat legacy `commands`/`default_assistant` | ZERO on staging | routes come from routes[] in all 4 agent apps |
| `.eve/secrets.yaml` fallback | ZERO | all repos use dev-secrets.yaml or none |

---

## 3. Codebase audit findings (summary)

Full agent reports archived in session transcripts; figures below are `wc -l` based.

**Scale**: API 455 endpoints / 88 controllers; CLI 49 command groups / ~380 leaf commands / 37k LOC; shared 23.5k LOC (non-test); docs ~358 md files / ~136k lines.

### 3.1 Provably dead code (no reachable path)

| # | Finding | Location | ~LOC | Risk |
| --- | --- | --- | --- | --- |
| D1 | Legacy step-based pipeline chain: nothing writes `status='pending' AND run_mode != 'jobs'` rows; `createRun()` unconditionally delegates to jobs path | `apps/worker/src/pipeline-runner/*`, orchestrator `claimNextPipelineRun`/`processPipelineRun`/`dispatchPipeline`/`copyPipelineOutputToRootJob`, `packages/db` step-run helpers, API legacy fallbacks + 66-line commented block in `pipeline-runs.service.ts` | ~1,250 | LOW |
| D2 | Dead modules/files: `apps/orchestrator/src/workspace/` (unregistered), `packages/shared/src/invoke/env-utils.ts` (duplicate, 0 importers), `apps/dashboard/src/components/skeleton.tsx`, unused barrels, `orchestrator/src/triggers/` (964-LOC spec, no prod code — relocate or delete) | various | ~1,300 | LOW |
| D3 | Unused exports/types (knip, hand-verified 39+36) incl. `apps/api/src/auth/permissions.ts` shim | various | ~400 | LOW |
| D4 | Tests that never run: `packages/db/src/queries/*.test.ts` (no test script), agent-runtime placement test (not matched by vitest config), `oauth-refresh.integration.test.ts` (skip-stub for removed model) | various | ~640 | LOW |
| D5 | Dead manifest/agent-config schema fields (zero consumers): top-level `versioning`, service `x-eve.worker_type`, compose `labels`, agent `skill` (required-but-unused!), agent `schedule.heartbeat_cron`, agent `access.envs/services/api_specs`, agent `policies.git.*`, agent `workflow` (dispatch never implemented), team `dispatch.max_parallel`, chat `routes[].permissions.envs`, workflow `db_access`, `api_specs` array shape, `x_eve` spelling | `packages/shared/src/schemas/*` | ~250 + validator noise | LOW |
| D6 | Dead env-var fragments: `AGENT_RUNTIME_WORKER_URL` (compose), `SSO_URL` legacy fallback ×3, `WORKER_TIMEOUT_MS` naming drift | various | ~20 | LOW |
| D7 | Unused deps: `@aws-sdk/client-s3` (×4 apps), `@aws-sdk/s3-request-presigner`, `@aws-sdk/client-auto-scaling` (GPU/ASG code already removed), `@testing-library/*` (dashboard), `yaml` (root). NOT dead: `client-xray`, `nostr-tools`, `fastify*`, `@eve/eve-agent-cli` (dynamic imports) | package.json ×6 | 0 (image/install size) | LOW |
| D8 | `packages/worker-cli/` local leftover (not git-tracked; a test asserts it's not referenced) + 129 gitignored `workspaces/` scratch dirs | disk only | 0 | LOW |

### 3.2 Decision-gated removals

| # | Finding | ~LOC | Recommendation |
| --- | --- | --- | --- |
| G1 | **Worker agent-invoke fallback**: `apps/worker/src/invoke/*` + orchestrator glue. `EVE_AGENT_RUNTIME_URL` is set in k8s base, compose, CLI local assets, and `bin/eh` — the fallback is unreachable in every shipped environment. Worker `k8s-runner.ts` is a 582-LOC near-copy of agent-runtime's (80 diff lines); `invoke.service.ts` is a diverged 2,658-LOC fork | ~3,440 | **Remove.** Make orchestrator fail fast if `EVE_AGENT_RUNTIME_URL` unset. Kills the largest remaining cross-service duplication |
| G2 | **Kaniko builder** + Dockerfile stages: `EVE_BUILD_BACKEND=kaniko` set nowhere in this repo | ~300 + image layers | **Remove** after confirming deployment-instance repos don't set it |
| G3 | Skipped billing test suites (budget-enforcement 210, spend-aggregation 188; malformed `describe.skip` signatures) | 400 dormant | Fix and re-enable (budget enforcement is live platform behavior) — or delete; decide |
| G4 | Legacy shims with zero users: `x_eve` spelling, `api_specs` array, chat `commands`/`default_assistant` normalizer, `metadata.hints` fallback, `.eve/secrets.yaml` fallback, legacy `scopes` permission names, legacy `migrate`/`migrations` route aliases, `hints.permission_policy='default'`, action `run`+service auto-resolve, `dispatch_json` fallback, `parsed_agents` manifest column, deprecated snapshot-storage overloads | ~600 | **Remove.** Keep `api_spec` singular + `project:` alias (actively used) |
| G5 | Deprecated/vestigial CLI: `eve agents sync` (deprecated alias), `chat simulate --project` (legacy path), `profile use --global` (throws "removed"), `migrate skills-to-packs` (one-shot done), `system envs` (endpoint never implemented), `db wipe` alias, `workflow run`/`invoke` merge, `env services` (view over diagnose), legacy Supabase password login, legacy profile-format shims | ~500 | **Remove**; document `job runner-logs`/`system orchestrator`/`db --url` bypasses as dev-only or remove |
| G6 | Pipeline dual-API: legacy `POST .../pipelines/:name/run` (step-run model) vs expander `POST .../runs` | ~300 | **Consolidate on expander**; CLI `pipeline run` already event-driven |

### 3.3 Zero-usage features (product decisions — each independently removable)

| Feature | ~LOC (API+CLI+shared+runtime) | Staging evidence | Recommendation |
| --- | --- | --- | --- |
| Nostr gateway plugin | ~450 | 0 integrations ever | **Remove** (idea doc stays for future) |
| Gemini harness adapter | ~150 | 0 jobs, 0 manifests | **Remove** registry entry + adapter (builder pattern makes re-adding trivial) |
| Cloud-FS (Drive mounts) | ~2,900 | 0 mounts across all orgs | User decision — recent investment (pagination Jun-2026), but zero adoption |
| Private endpoints (Tailscale) | ~1,300 | 0 across all orgs | User decision — shipped Mar-2026, zero adoption |
| Outbound webhooks | ~2,000 | 0 subscriptions | User decision — integration surface often expected by external devs |
| Access groups | ~800 | 0 across all orgs | **Keep** — foundation of "platform-wide groups with scoped fs/DB ACLs" (CLAUDE.md Next) |
| Embedded chat SDK (webchat plugin + `@eve-horizon/chat`/`chat-react`) | ~530 gateway + 2 packages | 0 webchat integrations | User decision — published SDK product |
| Org threads write surface | (kept) | teams/coordination USE threads; only the org-level controller is test-only | Keep; fix scope bug (bd filed) |
| Job batch / resource_refs | small | test-only, but used by orchestration skills | Keep (cheap, documented capability) |

### 3.4 Latent bugs found (filed in beads, fixed alongside batches)

- `EVE_NAMESPACE` vs `EVE_K8S_NAMESPACE` mismatch in `apps/api` (env-logs, system service) — breaks if platform namespace ≠ `eve`.
- `UserSecretsController` missing permission checks (bd: security).
- `org-threads` writes gated by `orgs:read` (bd: security).
- Coherence validator omits `app_link` trigger type → false warnings on valid manifests.
- `EVE_SIMULATE_ENABLED` pinned `"true"` in k8s base — test endpoint enabled everywhere; confirm intent.
- Malformed `describe.skip(fn)` signatures in two billing suites.

### 3.5 Docs (~136k lines of markdown)

- **~100 SHIPPED plans** in `docs/plans/` (~45-50k lines) — delete (git history preserves). ~40 of them carry stale Draft/Proposed markers despite being shipped; the docs-audit list corrects those.
- **~19 superseded ideas** (~10k lines incl. software-factory v1-v3, manifest-v2 pair) — delete.
- `docs/work/` — 12 historical tombstones — delete dir (incl. `example.claude.credentials.json`, which should not ship in an OSS repo).
- Artifacts: `eve-dashboard-prototype.html` (122KB), `docs/.DS_Store` — delete; `aws-cost-analysis.pdf` — archive decision.
- **Stale docs to rewrite**: `apps/ARCHITECTURE.md` (lists 3 of 7 services), `apps/worker/ARCHITECTURE.md` (contradicts agent-runtime routing), `docs/system/harness-adapters.md` (describes non-existent dir, missing claude/pi), `agent-secret-isolation.md` (moved path), `system-apps.md` (config/platform.yaml claim), CLAUDE.md (GPU-wake claim — feature was removed; "6 harnesses" — there are 7 incl. pi), `docs/system/builds.md` kaniko fallback claim, scenario 55 stub-files instruction, scenario 05 kaniko mention, duplicate scenario numbering (4× `46-*`).
- Missing: ARCHITECTURE.md for agent-runtime, gateway, sso, dashboard.
- `docs/issues/`: 2 resolved → delete; `worker-git-auto-commit-not-executing.md` → verify then close.

---

## 4. Execution plan — batches

Ordering: smallest-risk first; each batch = one bd issue, one commit series, gates green before the next. **Nothing in Phase B/C starts until this plan is approved.**

### Phase A — hygiene (no product decisions, no runtime behavior change)
| Batch | Content | Verification |
| --- | --- | --- |
| A1 | Docs purge: SHIPPED plans, superseded ideas, docs/work, resolved issues, artifacts | link check; `git grep` for inbound references from kept docs/CLAUDE.md |
| A2 | Docs rewrite: stale ARCHITECTURE files, harness-adapters.md, CLAUDE.md corrections, scenario fixes, missing ARCHITECTURE stubs | review only |
| A3 | Test hygiene: wire-or-delete unrun tests, delete oauth-refresh stub, fix malformed describe.skip, fix/re-enable billing suites (G3 decision) | `pnpm test` + `./bin/eh test integration` |

### Phase B — provably dead code
| Batch | Content | Verification |
| --- | --- | --- |
| B1 | Legacy pipeline chain (D1) + pipeline dual-API consolidation (G6) | build/test/integration + k3d deploy + scenarios 05-07 (pipelines/deploys) |
| B2 | Dead files/exports/deps/env-fragments (D2, D3, D6, D7) + `EVE_NAMESPACE` bug fix | build/test/integration + k3d smoke |
| B3 | Dead schema fields (D5) + `app_link` validator fix | build/test + `eve manifest validate` against all 22 collected app manifests (fixtures) + k3d agents scenarios |

### Phase C — decision-gated (each gated on §6 decisions)
| Batch | Content | Verification |
| --- | --- | --- |
| C1 | Worker agent-invoke fallback removal (G1); orchestrator fail-fast; delete dup k8s-runner | k3d full: `eh k8s deploy`, scenarios 01-08 + agent scenarios; verify agent jobs, toolchains, budgets, relay |
| C2 | Kaniko removal (G2) after infra-repo check | k3d build scenarios; worker image builds |
| C3 | Legacy shims (G4) + deprecated CLI (G5) | integration + CLI help audit + skillpacks cli.md sync |
| C4 | Approved zero-usage feature removals (§3.3, per user selection) with DB migrations dropping orphaned tables | k3d full pass + integration; confirm staging apps unaffected (features had zero usage) |

### Phase D — consolidation & docs sync
| Batch | Content | Verification |
| --- | --- | --- |
| D-1 | Small dedups: k8s client helper, requiredEnv/sleep, k8s-error alignment (if client versions allow) | build/test |
| D-2 | eve-skillpacks reference updates (cli.md, manifest.md, pipelines-workflows.md, harnesses.md, gateways.md, overview.md) + eve-horizon-docs | doc review |
| D-3 | Final full k3d verification: `./bin/eh k8s deploy`, all manual scenarios (01-08 parallel-safe + 05-07 sequential), `eve system health` | scenario pass/fail report |

## 5. What stays (explicitly protected)

Everything marked USED/PLATFORM in §2, plus: `api_spec` singular, `project:` alias, zai/mclaude/pi harnesses, access groups, threads/teams/coordination, job batch + resource_refs, Slack gateway + interactive endpoints, cost/billing/analytics pipeline, org-fs sync + org docs (UNKNOWN verdicts default to KEEP), ingest API, all `x-eve` deploy features in the matrix, orchestrator cron flags (deployment-instance repos may enable them — verify there before touching anything guarded by them).

## 6. Decisions required before Phase C

1. **G1** Remove worker agent-invoke fallback? (recommended: yes)
2. **G2** Remove kaniko? (recommended: yes, pending instance-repo grep)
3. **G3** Billing test suites: fix or delete? (recommended: fix)
4. **§3.3** Which zero-usage features to remove: nostr (rec: remove), gemini adapter (rec: remove), cloud-fs (?), private endpoints (?), outbound webhooks (?), embedded chat SDK (?)
5. Docs: delete shipped plans outright vs move to `docs/archive/`? (recommended: delete)

## 6a. Pre-execution baseline (2026-07-03)

Recorded before any batch work, on `main` @ `78ae47f1`:

- `pnpm install --frozen-lockfile && pnpm build` — **green**
- `pnpm test` (unit, full workspace) — **green**
- `./bin/eh test integration --reset-db` — **200/216 passing, 13 intentionally skipped, 3 timing-flaky** (`harness-matrix`, `job-context`, `job-wait` — all pass 8/8 in isolation; they assume jobs linger in `ready`, which fails on a fast clean DB). Without `--reset-db` the shared `eve_test` DB carried a 408-job stale backlog that starved current runs and leaked a `zai` org-default harness into `receipt-v2` — always reset for gate runs. Flake hardening → batch A3.
- **G2 precondition verified**: `EVE_BUILD_BACKEND`/kaniko appears in neither `incept5-eve-infra` nor `eve-horizon-infra` outside vendored skillpack docs — no deployment instance selects the kaniko backend.
- `docs/issues/worker-git-auto-commit-not-executing.md` verified **obsolete**: predates invoke-parity (complete 2026-03-11); agent-runtime implements post-execution auto-commit/push (`apps/agent-runtime/src/invoke/invoke.service.ts:1723`) and evskill's daily cron workflow exercises it on staging. Goes into the A1 resolved-issues deletion set.
- Local instance is k8s owner (`k8s_owner: true`) — k3d verification deploys are unblocked.

## 7. Estimated impact

- Code: ~2,600 LOC provably dead (Phase B) + ~4,400 LOC decision-gated (C1-C3) + up to ~7,300 LOC optional features (C4) → **~7k-14k TS LOC removed**, 14 unused deps, smaller worker image.
- Docs: **~60-70k markdown lines removed**, remaining docs corrected to match reality.
- Risk posture: every removal traceable to a matrix row or a "provably dead" finding; staging untouched; k3d + integration gates per batch.

