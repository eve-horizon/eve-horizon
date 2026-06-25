# Manual Test Suite

Fast, observable tests designed for Claude orchestration.

> **CRITICAL: These tests work with ANY Eve cluster** — local k3d, staging, or production.
> You MUST set `EVE_API_URL` before running. Never assume a specific cluster.
> - Local k3d: `export EVE_API_URL=http://api.eve.lvh.me`
> - Staging: `export EVE_API_URL=https://api.eve.example.com`

## Quick Start

```bash
# Set EVE_API_URL for your target cluster (REQUIRED)
export EVE_API_URL=<your-cluster-api-url>

# Verify prerequisites
eve system health --json # Should return healthy status

# Authenticate (required when auth is enabled)
eve auth login

# If you are testing local CLI changes, build and run the repo-local CLI:
# pnpm -C packages/cli build
# node packages/cli/bin/eve.js <command>

# Ensure stable test org exists (used by all scenarios)
eve org ensure "manual-test-org" --slug mto --json
# Returns: org_manualtestorg

# Import secrets to the test org (REQUIRED for job execution and deploys)
# Run from repo root where manual-tests.secrets lives
eve secrets import --org org_manualtestorg --file ./manual-tests.secrets

# Run all core tests via orchestration
# Ask Claude: "Run the manual test scenarios in parallel"
```

## Secrets Setup

Manual tests require secrets to be set on the test org. Create a `manual-tests.secrets` file **in the repo root** (gitignored) with:

```bash
# manual-tests.secrets
# Required for job execution (LLM harness)
Z_AI_API_KEY=your-zai-api-key
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-your-claude-setup-token

# Required for private repo access
GITHUB_TOKEN=ghp_your-github-token
```

Import to the test org (run from repo root):

```bash
eve secrets import --org org_manualtestorg --file ./manual-tests.secrets
```

### Secure Handling

- Keep `manual-tests.secrets` private and gitignored.
- Use restrictive permissions: `chmod 600 manual-tests.secrets`.
- Avoid pasting secrets into shared terminals or logs.
- Rotate keys immediately if they appear in job logs or shell history.

Secrets are inherited by all projects in the org. To verify:

```bash
eve secrets list --org org_manualtestorg --json
```

## Email Recipients in Scenarios

Manual scenarios that send email MUST use one of the following recipient kinds.
Anything else is a future SES suppression-list entry waiting to happen — see
`docs/plans/magic-link-email-silent-drop-plan.md`.

| Use case | Allowed recipients |
| --- | --- |
| Local-only (Mailpit) flows | `*@eve.local` — captured by Mailpit, never leaves the cluster. |
| Real SES delivery path | `success@simulator.amazonses.com` (always delivers), `bounce@simulator.amazonses.com` (always bounces, **no** suppression), `suppressionlist@simulator.amazonses.com` (simulated suppressed-recipient bounce). |
| Admin / human login | A real verified mailbox the team actually reads — e.g. `admin@example.com`, `dan@example.com`. |

**Never** use plus-tag throwaways like `adam+smoke-<timestamp>@example.com`,
`cli-invite-<timestamp>@example.com`, or any `+test`/`+qa_`/`+prod_`/`+partner`
alias on a production sender domain. Account-level SES suppression is global to
the domain; one bounced throwaway can silently drop mail to a real user later.

AWS mailbox simulator reference:
https://docs.aws.amazon.com/ses/latest/dg/send-an-email-using-the-mailbox-simulator.html

This is enforced by `tests/scenario-lint/forbid-fake-recipients.sh`, which runs
automatically as part of `./bin/eh test integration`. Run it directly with
`./bin/eh test scenarios-lint`.

## Stable Test Org

All manual tests use a single stable organization: `manual-test-org` (ID: `org_manualtestorg`).

This ensures:
- Consistent test environment across runs
- No stale test orgs accumulating
- Easy cleanup when needed
- Secrets shared across all test projects

```bash
# Set the org for all commands
export ORG_ID=org_manualtestorg
```

## Test Scenarios

| # | Scenario | Time | Parallel | Description |
|---|----------|------|----------|-------------|
| 01 | [Smoke](scenarios/01-smoke.md) | ~30s | Yes | API health, CLI, zai auth |
| 02 | [Job Execution](scenarios/02-job-execution.md) | ~3-4m | Yes | Full job lifecycle with LLM |
| 03 | [Pipelines API](scenarios/03-pipelines-api.md) | ~30s | Yes | Pipeline CRUD operations |
| 04 | [Events API](scenarios/04-events-api.md) | ~30s | Yes | Event emit and list |
| 05 | [Deploy Flow](scenarios/05-deploy-flow.md) | ~3m | No | Deploy and verify mechanical + vanity ingress |
| 06 | [Builds API](scenarios/06-builds-api.md) | ~1m | Yes | Build list, show, artifacts, logs, diagnose |
| 07 | [Sentinel Deploy](scenarios/07-sentinel-deploy.md) | ~5m | No | Sentinel manager deploy + self-update flow |
| 08 | [Chat Gateway (Slack)](scenarios/08-chat-gateway-slack.md) | ~2m | Yes | Chat simulate + integration wiring + listeners |
| 09 | [Agent Secret Isolation](scenarios/09-agent-secret-isolation.md) | ~3-4m | Yes | Env allowlist, file hardening, security policy |
| 10 | [Skills CLI + AgentPacks](scenarios/10-skills-agentpacks.md) | ~3-4m | Yes | skills.sh runtime, pack resolution, overlay merge, migrate CLI |
| 11 | [Software Factory Relay](scenarios/11-software-factory-relay.md) | ~10-15m | No | Factory relay chain: PM -> Planner -> Coder -> Verifier |
| 12 | [Resource Cost Tracking](scenarios/12-resource-cost-tracking.md) | ~3-4m | Yes | Pricing, receipts, balance ledger, managed models, suspension |
| 13 | [Identity Auth Providers](scenarios/13-identity-auth-providers.md) | ~3m | Yes | Provider registry, SSH + Nostr challenges, auth guard chain, invites |
| 14 | [Gateway Plugins Routing](scenarios/14-gateway-plugins-routing.md) | ~3m | Yes | Provider factories, webhook controller, thread context, chat routing |
| 15 | [Org Docs Versions & Query](scenarios/15-org-docs-versions-query.md) | ~2m | Yes | Versioned org docs + structured metadata query |
| 16 | [Resource Refs Hydration](scenarios/16-resource-refs-hydration.md) | ~3-4m | Yes | Resolver + workspace hydration + diagnostics |
| 17 | [Batch Job Graph](scenarios/17-batch-job-graph.md) | ~2m | Yes | Atomic batch creation, validation, idempotency |
| 18 | [Org Threads](scenarios/18-org-threads.md) | ~1m | Yes | Org-scoped thread CRUD, messaging, key canonicalization |
| 19 | [Org Analytics](scenarios/19-org-analytics.md) | ~1m | Yes | Org-level analytics summary, jobs, pipelines, env health |
| 20 | [Webhook Replay](scenarios/20-webhook-replay.md) | ~2m | Yes | Replay, dry-run preview, deduplication, status polling |
| 21 | [Web Auth](scenarios/21-web-auth.md) | ~3-4m | Yes | GoTrue, Mailpit, SSO broker, token exchange, dual-mode auth, admin invite |
| 22 | [Platform Ollama](scenarios/22-platform-ollama.md) | ~3m | Yes | Target bootstrap, health probing, model pull, chat completions, 503 on offline |
| 23 | [Agent Memory Platform](scenarios/23-agent-memory-platform.md) | ~3-4m | Yes | Agent/shared memory CRUD, KV namespaces, unified search, thread distillation |
| 24 | [Project Scope Secret Behavior](scenarios/24-project-secret-scope-regression.md) | ~6-8m | No | Validate project vs org scoped secret materialization parity in runtime |
| 25 | [Auth Token Sync](scenarios/25-auth-token-sync.md) | ~3-4m | Yes | Claude token type detection, Codex sync, internal write-back endpoint |
| 26 | [Object Store](scenarios/26-object-store.md) | ~10m | Yes (Ph0-2,4) | MinIO health, presigned URL transport, text indexing, app buckets, share tokens |
| 27 | [Claude Harness Auth](scenarios/27-claude-harness-auth.md) | ~8-10m | No | Durable Claude setup-token auth, precedence, redacted diagnostics |
| 28 | [SSO SDK Packages](scenarios/28-sso-sdk-packages.md) | ~1-2m | Yes | @eve-horizon/auth + @eve-horizon/auth-react build, token claims, auth config, deployer injection |
| 29 | [Pi Harness + Skills](scenarios/29-pi-harness.md) | ~5-6m | Yes | Pi harness job execution, event normalization, provider extraction, llm.call tracking, skill auto-discovery |
| 30 | [Document Ingestion MVP](scenarios/30-document-ingestion-mvp.md) | ~10m | No | CLI ingest, presigned upload, workflow trigger, S3 hydration, audio file ingestion |
| 31 | [Production Hardening](scenarios/31-production-hardening.md) | ~5m | Yes | Content dedup, dead letters, per-phase latency, routing logs, cost-by-agent |
| 32 | [Dashboard UI](scenarios/32-dashboard-ui.md) | ~20-30m | No | Dashboard completion gate: shell, board, project anatomy, admin mode, and UX quality |
| 33 | [Sentinel Watchdog](scenarios/33-sentinel-watchdog.md) | ~8-10m | No | Watchdog detection, circuit-breaker, recovery, and env-health CLI |
| 34 | [Per-Job Harness Override](scenarios/34-per-job-harness-override.md) | ~4-5m | Yes | Per-turn harness/profile/env override propagation |
| 35 | [Embedded WebChat JWT](scenarios/35-embedded-conversation-webchat-jwt.md) | ~3m | Yes | WebChat JWKS verification and invalid-token rejection |
| 36 | [Embedded Conversation Facade](scenarios/36-embedded-conversation-facade.md) | ~4-6m | Yes | App-key conversations, turns, SSE, SDK smoke |
| 37 | [Embedded React Pane](scenarios/37-embedded-conversation-react-pane.md) | ~10m | No | React conversation pane in browser app |
| 38 | [Embedded SSE Resume](scenarios/38-embedded-conversation-sse-resume.md) | ~5m | Yes | Last-Event-ID replay and progress events |
| 39 | [App-Branded Invite Email](scenarios/39-app-branded-invite.md) | ~15-25m | No | Manifest branding, Mailpit invite rendering, and SSO click-through |
| 40 | [App Magic-Link Login Opt-In](scenarios/40-app-magic-link-login.md) | ~20-30m | No | App-scoped passwordless SSO, branded magic-link email, invite skip-password, no-self-signup |
| 41 | [App Org Access And Admin Invites](scenarios/41-app-org-access-admin-invites.md) | ~25-35m | No | App org allowlist, app-access API, in-app admin invite, Mailpit, and invite org redirect |
| 44 | [App Domain-Signup Magic-Link](scenarios/44-app-domain-signup-magic-link.md) | ~20-30m | No | Pre-approved email-domain auto-signup, Path C invite write, target_org auto-attach, public bool vs admin reveal |
| 46 | [Public TCP Ingress](scenarios/46-tcp-ingress.md) | ~20-30m | No | k3d TCP port mappings, klipper LoadBalancer, env diagnose, and host TCP probes |
| 52 | [App Bucket IAM Isolation](scenarios/52-app-bucket-iam-isolation.md) | ~20-30m | No | App object bucket isolation modes, local fail-fast IRSA, stale row cleanup, and staging cross-app denial |
| 55 | [Agent Toolchain Inline Runtime](scenarios/55-agent-toolchain-inline.md) | ~4-6m | Yes | Agent workflow `toolchains: [python]`, inline provisioning, `runtime_meta.toolchains`, and `python3` proof |
| 56 | [Delegated Init Timeout](scenarios/56-delegated-init-timeout.md) | ~3-5m | No | Claimed delegated child with null `execution_started_at`, `attempt_init_timeout`, and lead unblock |

**Core tests (01-04):** ~4 minutes when run in parallel
**Security tests (09):** ~3-4 minutes (can run parallel with core)
**AgentPacks tests (10):** ~3-4 minutes (can run parallel with core)
**Identity & Gateway tests (13-14):** ~3 minutes each (can run parallel with core)
**Resource plane tests (15-16):** ~5-6 minutes (can run parallel with core)
**Batch, threads, analytics & webhooks (17-20):** ~6 minutes (can run parallel with core)
**Web auth tests (21):** ~3-4 minutes (can run parallel with core)
**Platform Ollama tests (22):** ~3 minutes (requires GPU host; can run parallel with core)
**Agent memory tests (23):** ~3-4 minutes (can run parallel with core)
**Full suite (01-23):** ~43-44 minutes
**Temporary local regression (24):** ~6-8 minutes (do not include in standard suite cadence unless investigating secret materialization)
**Object store (26):** ~10 minutes, phased (run phases individually as implementation lands)
**Dashboard UI (32):** ~20-30 minutes (browser + LLM; completion gate, not a smoke test)
**App-branded invite email (39):** ~15-25 minutes (local k3d + Mailpit + starter app deploy)
**App magic-link login opt-in (40):** ~20-30 minutes (local k3d + browser + Mailpit + starter app deploy)
**App org access/admin invites (41):** ~25-35 minutes (local k3d + browser + Mailpit + starter app deploy)
**App domain-signup magic-link (44):** ~20-30 minutes (local k3d + browser + Mailpit + starter app deploy)
**Public TCP ingress (46):** ~20-30 minutes (local k3d with explicit TCP port mappings)
**App bucket IAM isolation (52):** ~20-30 minutes (local k3d required; staging phase only after IRSA worker env is configured)
**Agent toolchain inline runtime (55):** ~4-6 minutes (local k3d required; LLM required)
**Delegated init timeout (56):** ~3-5 minutes (local k3d required; mutates local orchestrator env and restores it)

## Running with Orchestration

### Parallel Execution (Recommended)

Ask Claude to run scenarios 01-04 in parallel:

```
Run manual test scenarios 01-04 in parallel.
For each scenario, execute the commands and report pass/fail.
Use `eve job follow <id>` to watch job progress in real-time.
```

### Sequential Execution

For debugging or when you want to see each step:

```
Run manual test scenario 02 (job execution) step by step.
Show me the output of each command.
```

### Single Scenario

```
Run manual test scenario 03 (pipelines API).
```

## Attempt Watchdog Repro (Deterministic)

To reproduce and validate stale-attempt recovery without model randomness:

```bash
# Requires EVE_API_URL and a project id
tests/manual/bin/repro-stale-attempt-watchdog.sh \
  --project <proj_id> \
  --pause-orchestrator \
  --count 20 \
  --watch-timeout 180
```

`--pause-orchestrator` makes setup deterministic by scaling orchestrator to
zero during claim setup, then restoring replicas before the watchdog wait.
This creates jobs, claims them manually as `orchestrator`, and verifies the
platform recovers stuck `running` attempts back to terminal states.

## Interpreting Results

Each scenario has explicit **Success Criteria**. A scenario passes when:

1. All commands complete without error
2. All assertions in "Expected" sections are true
3. Success criteria checklist is satisfied

## Observability

Unlike automated e2e tests, manual tests provide real-time visibility using Eve CLI:

### User-Level Debugging (Job-Scoped)

```bash
# Real-time log streaming (PREFERRED - use this first)
eve job follow <job_id>

# Comprehensive diagnostics with recommendations
eve job diagnose <job_id>

# View execution logs
eve job logs <job_id>

# List execution attempts
eve job attempts <job_id>

# Job details and current state
eve job show <job_id> --json
```

### Admin-Level Debugging (System-Wide)

```bash
# System health overview (admin-only)
eve system status

# Service logs (api, orchestrator, worker, postgres)
eve system logs worker --tail 50
eve system logs api --tail 50

# Cluster pods (admin view)
eve system pods

# Cluster events (admin view)
eve system events
```

**Note:** System endpoints require admin scope. If you see HTTP 403:
- Use a system admin user, or
- Mint an org-scoped admin token: `eve auth mint --email you@example.com --org org_manualtestorg --role admin`
- If you belong to multiple orgs, prefer a system admin token to avoid ambiguity.

### When to Use kubectl (Infrastructure Issues Only)

Only fall back to kubectl when you suspect infrastructure problems:

```bash
# Node issues, resource exhaustion, networking
kubectl get nodes
kubectl describe node <node>
kubectl get events -A --sort-by='.lastTimestamp'
```

**Rule:** If `eve system status` shows healthy but jobs are failing, use `eve job diagnose`.
Only use kubectl if system-level commands indicate infrastructure issues.

## Prerequisites

Before running tests:

1. **EVE_API_URL set:** Must point to your target cluster's API (e.g., `http://api.eve.lvh.me` for local, `https://api.eve.example.com` for staging)
2. **API accessible:** `eve system health --json` returns OK
3. **Secrets imported:** `eve secrets list --org org_manualtestorg --json` shows required keys
4. **No stale test resources:** Previous test orgs/projects cleaned up
6. **Gateway routing:** Slack app configured for `app_mention` events; agent slugs configured in `agents.yaml`

## Troubleshooting

**Rule:** Always use Eve CLI first. Only fall back to kubectl for infrastructure issues.

### Missing secrets

```bash
# Check what's set on the org
eve secrets list --org org_manualtestorg --json

# Re-import from repo root
eve secrets import --org org_manualtestorg --file ./manual-tests.secrets
```

### Job stuck in "active" phase

```bash
# First: Comprehensive diagnostics (shows recommendations)
eve job diagnose <job_id>

# Real-time streaming (see what's happening now)
eve job follow <job_id>

# Check execution attempts
eve job attempts <job_id> --json

# System-level: Is the worker healthy?
eve system status
eve system logs worker --tail 50
```

**Only if system commands show infra issues:**
```bash
kubectl get pods -n eve | grep runner
kubectl get events -n eve --sort-by='.lastTimestamp' | tail -10
```

### API connection errors

```bash
# First: Eve CLI health check
eve system health --json

# System status (shows all services)
eve system status

# API logs
eve system logs api --tail 50
```

**Only if CLI commands fail:**
```bash
curl -s $EVE_API_URL/health | jq
kubectl get pods -n eve -l app=eve-api
```

### Cleanup test resources

```bash
# List test orgs (look for manual-test-* or similar)
eve org list --json

# Delete if needed
eve org delete <org_id>
```

## CLI Gaps (Improvement Opportunities)

During testing, note any debugging scenarios where kubectl was needed but shouldn't be:

| Gap | Current Workaround | Suggested CLI Addition |
|-----|-------------------|----------------------|
| View env pod status | `kubectl get pods -n <ns>` | `eve env pods <proj> <env>` |
| Stream component logs | `kubectl logs -n <ns> -l app=X` | `eve env logs <proj> <env> <component>` |
| Check deploy health | `curl` the endpoint | `eve env health <proj> <env>` |

**If you find a gap:** Note it in the scenario file under "CLI Gaps Identified" section.
