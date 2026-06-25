# Plan: Observability CLI Gap Closure

> **Status**: Draft
> **Created**: 2026-04-29
> **Origin**: Four gaps raised by the `acme-portal` E2E debug program. Source documents live at `../../private/example-app/eve-platform-gaps/000{1..4}-*.md` and are quoted inline below.
> **Related**: `docs/plans/job-observability-gaps-plan.md` (closes the *job* side of the same problem); `docs/system/deploy-debug.md`; `packages/shared/src/otel.ts`; `apps/api/src/environments/env-logs.service.ts`.

## Problem

Eve gives agents a great CLI for debugging *jobs* (`eve job follow`, `eve job diagnose`, `eve job logs --grep`) but a much weaker one for debugging *deployed services*. When an E2E test or production request fails, the agent's experience is:

1. Snapshot logs only — no `--follow`. Workaround is a polling loop or post-hoc grep.
2. Regex-on-raw-text filtering — no structural filter on JSON log lines, so `--grep '"req_id":"..."'` is brittle and false-positive-prone.
3. No request-level diagnose — context is spread across logs, traces, K8s events, and DB state, and the agent has to stitch four commands together by hand.
4. No agent-accessible trace store — OTEL writes to AWS X-Ray, but X-Ray is human-only. `trace_id` becomes a correlation marker the agent cannot follow into actual spans.

The asymmetry is the headline: `eve job follow` streams; `eve env logs` does not. `eve job diagnose` integrates; `eve env diagnose` only covers env-level state, not request-level. This plan closes that asymmetry.

## Goal

Make CLI-accessible observability for deployed services equivalent to what we already have for jobs:

1. Stream service logs in real time (`eve env logs --follow`).
2. Filter JSON service logs by parsed field (`--filter k=v`), with graceful fallback to `--grep` on non-JSON lines.
3. Provide a one-shot request-level dump (`eve env diagnose --request <req_id>`) that integrates logs, K8s events, deploy metadata, optional audit-log convention, and (when 4 lands) traces.
4. Add an agent-queryable trace surface (`eve traces query`) that does not require AWS console access.

## Non-Goals

- Replace `kubectl` for cluster operators. CLI parity is the goal; raw kubectl access stays available where it adds value.
- Build a full APM UI. JSON-first CLI output is the contract; pretty rendering is secondary.
- Choose multi-cloud trace backends now. The CLI surface is invariant; the backend can be X-Ray today and swappable later.
- Index/cache logs at scale. Linear scan over `kubectl logs` output is the v1 path, same as today.

## Why Sequence Matters

The four gaps are listed independently in `acme-portal` but they are not independent in implementation. The cheapest sequence is:

1. **Gap 1 (`--follow`)** lands the SSE plumbing and multi-pod merge — same shape as `jobs/:id/stream`.
2. **Gap 2 (`--filter`)** extends the same `EnvLogsService` filter step. Reuses the SSE pipeline once it exists.
3. **Gap 4 (`eve traces query`)** is independent from logs but feeds Gap 3.
4. **Gap 3 (`--request <req_id>` diagnose)** is the integrator. It composes the primitives the prior three deliver, so it lands last.

This sequencing also lets `acme-portal` start using each capability the moment it ships, instead of waiting for the whole stack.

## Gap 1: `eve env logs --follow` (Streaming Service Logs)

> Source: `acme-portal/eve-platform-gaps/0001-eve-env-logs-follow.md`

### Current State

`eve env logs <project> <env> <service>` returns a snapshot. The CLI surface is `--tail`, `--since`, `--grep` — no streaming.

Adjacent surfaces *do* stream:

- `eve job follow <id>` (SSE, line-by-line) — `apps/api/src/jobs/jobs.controller.ts:642` `@Sse() Get('jobs/:job_id/stream')`.
- `eve pipeline logs ... --follow` — same SSE pattern.

Server side, `EnvLogsService.getServiceLogs` (`apps/api/src/environments/env-logs.service.ts`) already enumerates pods and reads each pod's logs via `coreV1Api.readNamespacedPodLog`. The Kubernetes client supports `follow=true`; we just don't use it.

### Proposed Change

Add an SSE endpoint mirroring the job stream:

```
GET /environments/:env_id/logs/stream?service=<svc>&since=<sec>&grep=<regex>&all_pods=<bool>
@Sse()
```

CLI:

```bash
eve env logs proj_xxx dev app --follow
eve env logs proj_xxx dev app --follow --since 30          # backfill 30s, then stream
eve env logs proj_xxx dev app --follow --grep 'req_01h...' # server-side filter
eve env logs proj_xxx dev app --follow --all-pods          # multi-pod merged
```

### Implementation

**API** (`apps/api/src/environments/`):

1. Add `streamServiceLogs()` to `env-logs.service.ts`. For each matching pod, call `readNamespacedPodLog` with `follow=true, sinceSeconds=options.since` and obtain a node-fetch-style readable. Merge across pods with line-buffered demux (one `MessageEvent` per line, includes `pod_name` and `container` in the event payload). Yield as an `Observable<MessageEvent>` for Nest's `@Sse()`.
2. Add `streamServiceLogs` route in `environments.controller.ts` with `@Sse()`. Apply the same project-scope auth guard as the snapshot route.
3. Heartbeat: emit a `data: {"type":"heartbeat"}\n\n` every 60s so idle connections don't reap. Mirror `apps/api/src/jobs/jobs.controller.ts` pattern.
4. Reconnect semantics for pod restart: when a pod's log stream EOFs but the deployment still has matching pods, re-list and re-attach. Emit `data: {"type":"pod_changed", ...}` so the CLI can render a divider line. Terminate the SSE only when no matching pods remain or `since` window closes.
5. New-pod join: when `--all-pods` is set and a pod appears that matches the deployment label selector, attach to its log stream. Use a 5s relist tick rather than the K8s watch API for v1 — cheap and correct enough.

**CLI** (`packages/cli/src/commands/env.ts`, `env-logs` subcommand):

1. Add `--follow` flag. When set, hit the SSE route instead of the snapshot route.
2. Reuse the SSE consumer pattern already in `packages/cli/src/commands/job.ts` (search for `text/event-stream`, line ~3387). Print `pod_name` prefix when `--all-pods`. Handle Ctrl-C → clean disconnect.

### Edge Cases

- Pod restarts mid-stream → reattach + emit divider event, do not terminate.
- New pods joining → auto-include only when `--all-pods`; otherwise stay pinned to the originally selected pod and EOF on its termination.
- Idle stream → 60s heartbeats so the agent can distinguish "alive, quiet service" from "connection lost".
- Backpressure on a chatty service → cap per-pod buffer, drop with a `data: {"type":"dropped","count":N}` event rather than blocking the stream.

### Acceptance Criteria

- `eve env logs <proj> <env> <svc> --follow` streams new log lines within ~1s of emission.
- Ctrl-C disconnects cleanly; the API server emits no error.
- `--follow --since 30` backfills then transitions to streaming with no duplicated lines at the seam.
- `--all-pods` merges output from every pod in the deployment.
- Pod restart during a stream produces a visible divider; the stream continues against the new pod.

## Gap 2: Structured Filter on JSON Logs (`--filter k=v`)

> Source: `acme-portal/eve-platform-gaps/0002-eve-env-logs-structured-filter.md`

### Current State

Server-side filtering is `lines.filter(line => line.includes(grep))` (`env-logs.service.ts:177`). For pino-JSON apps that means quoted-key-quoted-value text matching — brittle to whitespace, brittle to escaping, false-positive-prone when the queried value appears inside another field.

### Proposed Change

For each log line:

1. Try `JSON.parse(line)`.
2. If parse succeeds **and** result is an object: apply `--filter` against the parsed object using exact equality on field paths.
3. If parse fails: fall back to `--grep` semantics (substring on raw line). Preserves backwards compatibility.

CLI:

```bash
eve env logs proj_xxx dev app --filter req_id=req_01h...
eve env logs proj_xxx dev app --filter level=error --filter req_id=req_01h...   # AND
eve env logs proj_xxx dev app --filter status=500 --since 300
eve env logs proj_xxx dev app --filter 'req.path=/api/cameras' --follow         # nested via dotted path
```

`--filter` is repeatable; multiple filters AND. `--filter` and `--grep` co-exist; both AND. Exact equality only in v1; defer glob/regex/range until there's a real ask.

### Implementation

**API** (`env-logs.service.ts`):

1. Add `filters?: Record<string, string>` and `filterPaths?: string[]` to the options type. Plumb through `getServiceLogs` and the new `streamServiceLogs` from Gap 1.
2. Replace the current single-pass filter with a small `matches(line, options)` helper:
   - If `options.filters` empty → existing `grep` substring path.
   - Else → JSON.parse; on success, look up each filter key as a dotted path on the parsed object; equality compare.
   - On parse failure with filters set → fall back to substring against raw line (AND with `grep` if also set).
3. Path lookup is dot-separated (`req.path`, `error.code`). No bracket syntax in v1.

**Controller**: accept `filter` as a repeatable query string `?filter=req_id=req_01h&filter=level=error`. NestJS will give an array.

**CLI** (`env.ts`):

1. Repeatable `--filter k=v` flag. Validate `k` is non-empty; reject keys containing `=` (point user at quoting). Forward to API.
2. Doc snippet in `eve env logs --help`.

### Edge Cases

- Type coercion: `"status":500` (number) vs `--filter status=500` (string). Coerce numerically when filter value parses as a number; otherwise string compare. Documented in `--help`.
- Boolean: `--filter ok=true` matches `{"ok":true}` and `{"ok":"true"}`. Coerce.
- Nested arrays: `req.headers[0]` not supported in v1; document the limitation.
- Missing field: filter `level=error` against a line missing `level` → no match.

### Acceptance Criteria

- `--filter req_id=req_01h...` matches only lines whose parsed JSON has that exact `req_id` field, never a substring match inside another field.
- `--filter` and `--grep` together AND correctly.
- Non-JSON log lines fall back to `grep` (still useful for text-formatted log services).
- Combined with Gap 1, `--filter` works under `--follow`.
- `--help` documents type coercion and unsupported nesting.

## Gap 3: `eve env diagnose --request <req_id>` (Integrated Request Dump)

> Source: `acme-portal/eve-platform-gaps/0003-eve-env-diagnose-by-request.md`

### Current State

`eve env diagnose <project> <env>` exists (`environments.controller.ts → diagnose` route) but is *environment-scoped*: deployment health, pod status, K8s events. It does not take a request ID.

To debug a specific failed request the agent runs four commands and stitches the output mentally:

1. `eve env logs ... --grep <req_id>`
2. AWS X-Ray (manual) for trace
3. `eve env diagnose ... --events`
4. `eve db sql --env <env> --sql "SELECT ... WHERE request_id = ?"`

### Proposed Change

```
GET /environments/:env_id/diagnose?request_id=<req_id>&window_seconds=60
```

```bash
eve env diagnose proj_xxx dev --request req_01h... --json
eve env diagnose proj_xxx dev --request req_01h... --window 120
```

Returns a structured report:

```json
{
  "request_id": "req_01h...",
  "request_window": { "first_seen": "...", "last_seen": "..." },
  "deploy_at_request_time": {
    "release_id": "rel_xxx",
    "git_sha": "...",
    "deployed_at": "..."
  },
  "logs": [
    { "ts": "...", "service": "acme", "pod": "acme-xxx-yyy",
      "msg": "request.received", "fields": { ... } }
  ],
  "k8s_events": [ { "ts": "...", "kind": "Warning", "reason": "...", ... } ],
  "traces": {
    "trace_id": "...",
    "available": true,
    "spans": [ ... ]
  },
  "audit_log_entries": [ { "action": "...", "before_json": ..., "after_json": ... } ]
}
```

### Implementation

**API** (new `apps/api/src/environments/env-diagnostics.service.ts` extension):

1. New method `diagnoseRequest(envId, requestId, windowSec)`:
   - Determine request time window. Strategy: use `--window` (default 60s) and a server-side cap (e.g. 600s); look back from "now" or from a `--at` timestamp if provided. v1 simple: search the last `windowSec` seconds and trim to the lines that contain a matching `req_id`.
   - **Logs section**: call `getServiceLogs` for *every* service in the env (parallel) with `filter req_id=<req_id>` (Gap 2 must be in place). Merge by timestamp. Tag each entry with `service` and `pod`.
   - **Deploy metadata**: query the releases table for the active release in the env at the request's `first_seen` timestamp. Populate `release_id`, `git_sha`, `deployed_at`. If straddling deploys, return both.
   - **K8s events**: re-use existing `env diagnose --events` query path but filter to events whose `lastTimestamp` falls in the request window.
   - **Audit log (opt-in)**: if the project's manifest declares `x-eve.audit_log_table: <table>`, run `SELECT * FROM <table> WHERE request_id = $1` via the env-scoped DB connection used by `eve db sql`. Schema: agnostic — return rows verbatim. If not declared → omit the section.
   - **Traces**: gated on Gap 4. Until Gap 4 lands, populate `{ trace_id: <derived from logs if present>, available: false, store: 'x-ray', hint: 'See AWS X-Ray console; trace CLI gap 0004 not yet closed.' }`. After Gap 4, call the trace query service for spans.

2. New controller route `Get('environments/:env_id/diagnose-request')` (or extend the existing `diagnose` route with a `request_id` query param — preference for the latter to keep the surface small).

**CLI** (`packages/cli/src/commands/env.ts`):

1. Add `--request <id>` and `--window <seconds>` flags to `eve env diagnose`.
2. Default output: a sectioned human-readable report. `--json` returns the structured payload above (primary contract).
3. Make `--request` mutually exclusive with `--events` flags it doesn't compose with. Prefer `--request` overriding when both set.

**Manifest extension** (`docs/system/manifest.md`):

Document opt-in:

```yaml
services:
  acme:
    x-eve:
      audit_log_table: audit_log
      request_id_column: request_id   # default 'request_id'
```

### Edge Cases

- Cross-pod requests (request hits one pod, retried on another): `logs[]` already merges across pods, so this surfaces naturally.
- Pod restart mid-request: the `k8s_events` section will show the restart; the deploy metadata will note if the release changed.
- Request straddles deploys: `deploy_at_request_time` returns an array `[{ release_id, deployed_at, served_logs_until }, { ... }]`.
- Privacy: audit-log query runs through the env-scoped DB session, which inherits project-membership scope. Same trust boundary as `eve db sql`.
- Request not found: empty `logs` and `traces.available: false`. Return the structure with empty arrays, not 404 — agents prefer "no data" to "command failed".

### Acceptance Criteria

- One command returns logs, K8s events, deploy metadata, optional audit rows, and a trace pointer for a given `req_id`.
- `--json` output is stable, documented, and scriptable.
- Audit-log inclusion is opt-in via manifest.
- The command works with `req_id` values not previously seen by the platform (don't require pre-registration).
- Composes with Gap 1's `--follow` philosophy as a one-shot snapshot — no streaming for v1, but the structure is friendly to a future `--follow-request`.

## Gap 4: Agent-Queryable Trace Store (`eve traces query`)

> Source: `acme-portal/eve-platform-gaps/0004-eve-traces-cli-query.md`

### Current State

Eve has the *write* side of distributed tracing:

- `packages/shared/src/otel.ts` — initializer for services and (opt-in) deployed apps.
- `k8s/addons/otel-collector-aws.yaml` — AWS X-Ray exporter.

There is no read side accessible to agents. Spans live in X-Ray; the only path to inspect them is the AWS console. CLI agents (and most app developers) don't have AWS credentials. So `trace_id` ends up as a log correlation marker only.

### Proposed Change

```bash
eve traces query --service acme --request-id req_01h... --json
eve traces query --service acme --trace-id <trace-id> --json
eve traces query --service acme --since 5m --error
eve traces query --service acme --route "POST /api/cameras" --since 1h --p99
```

Output: structured spans (service hops, durations, error attribution, OTEL attributes), JSON-first.

### Implementation Choice: X-Ray Wrapper (v1)

Two backends were on the table — X-Ray wrapper vs in-cluster Tempo/Jaeger. v1 ships the X-Ray wrapper because:

- Cluster already has IAM via IRSA; no new infra.
- Smaller blast radius; no new persistence to operate.
- The CLI surface is the same regardless of backend, so we can swap to Tempo later without a CLI break.

**API** (new `apps/api/src/traces/`):

1. `TracesModule`, `TracesService`, `TracesController`.
2. `TracesService.query(opts)` calls AWS X-Ray SDK:
   - `--request-id` → `GetTraceSummaries` with annotation filter `annotation.request_id = <id>` (requires apps to set X-Ray annotation when emitting; document in `references/observability.md`).
   - `--trace-id` → `BatchGetTraces` with the literal trace ID.
   - `--since 5m --error` → `GetTraceSummaries` with filter `error = true` over the time window.
   - `--route` → annotation filter `http.route = <route>`.
   - `--p99` → fetch summaries, compute percentile client-side; document the cap (e.g. 1000 traces).
3. Auth: project-scoped. Caller must have the project membership the service belongs to.
4. Output normalisation: convert X-Ray's segment tree to a flat OTEL-shaped span list. CLI consumes one schema; backend swaps remain invisible.

**CLI** (new `packages/cli/src/commands/traces.ts`):

1. `eve traces query [opts]`. Flags as listed above. JSON-first; pretty render shows a span tree.
2. Register in `packages/cli/src/index.ts`.

**Manifest / app-side** (`docs/system/observability.md`):

Document the OTEL annotation contract: apps that want `--request-id` filtering must set `request_id` as an X-Ray annotation. Provide a small helper in `packages/shared/src/otel.ts` (`stampRequestId(span, reqId)`) to make this one line.

### Edge Cases

- Cardinality / cost: X-Ray query rate limits. Cache results for 30s in the API service; document `--no-cache`.
- Cross-service traces: surfaced naturally (X-Ray returns the full segment tree). Restrict the response to spans whose service belongs to the caller's project.
- Privacy: same scoping rule as `eve env logs`.
- Sampling: document that span availability depends on the OTEL sampler config; not every request will produce spans.
- Backend swap: when we move to Tempo, the CLI surface and JSON shape stay identical. `TracesService` becomes a strategy switch on a config flag.

### Acceptance Criteria

- `eve traces query --request-id <id>` returns structured spans for that request, no AWS console required.
- `--service`, `--since`, `--error`, `--route` filters work in combination.
- `--json` output is documented and stable across the X-Ray-vs-Tempo backend swap.
- After this lands, Gap 3's `traces.spans` array is populated rather than `available: false`.

## Sequencing & Milestones

| Order | Gap | Why this order | Estimated effort |
|---|---|---|---|
| 1 | Gap 1 — `--follow` | Lands the SSE plumbing for env logs; immediate value to `acme-portal`. | Small (1–2 days) |
| 2 | Gap 2 — `--filter` | Same code path as Gap 1; cheap once 1 is in. Required by Gap 3's log section. | Small (1 day) |
| 3 | Gap 4 — `eve traces query` | Independent from logs. Required by Gap 3's trace section. | Medium (3–5 days, mostly X-Ray API plumbing). |
| 4 | Gap 3 — `--request <id>` diagnose | Composes 1, 2, 4 plus deploy metadata + audit-log opt-in. The integrator. | Medium (2–3 days). |

Each gap ships as its own PR, gated on:

- Tests in the relevant `*.spec.ts`.
- Docs update in `docs/system/observability.md` and `docs/system/deploy-debug.md`.
- **Mandatory**: corresponding update to `eve-skillpacks/eve-work/eve-read-eve-docs/references/{observability,deploy-debug,cli}.md` (per `CLAUDE.md` skillpacks sync obligation).
- A `acme-portal` regression run (`tests/e2e/test-runner-helpers.ts`) using the new flag, demonstrating end-to-end value before merge.

## Risks & Open Questions

1. **SSE through ingress / reverse proxies**: Existing job stream works through k3d ingress and staging ALB, so the precedent is solid. We still need to verify the merged multi-pod stream doesn't trip per-connection buffer limits. Mitigation: write a 5-min sustained-stream test in CI.
2. **X-Ray annotation contract**: filter by `request_id` only works if the app stamps the annotation. We need a default in `packages/shared/src/otel.ts` so opting into Eve OTEL gives this for free; otherwise Gap 4 is a "sometimes works" surface.
3. **Audit-log convention sprawl**: `x-eve.audit_log_table` is one more app-level convention. The alternative is to skip it in v1 and let agents continue to run `eve db sql` manually. Recommend keeping it — the cost is one optional manifest field, the value is making Gap 3 truly one-shot.
4. **Tempo migration timing**: don't block Gap 4 on this. The CLI shape is the contract; the backend is a strategy.
5. **K8s log streaming reliability**: `readNamespacedPodLog(follow=true)` is known to occasionally drop on long-lived pods. Reattach logic in Gap 1 must handle this; otherwise a "silent loss" looks worse than the current snapshot model.

## What This Does Not Do

- Doesn't add log retention beyond what `kubectl logs` provides today (per-pod ring buffer). If we want time-bounded retrospection beyond a pod's lifetime, that's a separate "log archive" plan.
- Doesn't unify CLI across `eve job` and `eve env` surfaces. The verbs differ (`follow` vs `logs --follow`) for historical reasons; harmonising them is a UX cleanup outside this plan's scope.
- Doesn't address build/release log streaming — `eve pipeline logs --follow` already covers that.

## References

- Source gap docs: `~/dev/eve-horizon/sample/acme-portal/eve-platform-gaps/000{1..4}-*.md`
- Platform code: `apps/api/src/environments/env-logs.service.ts`, `apps/api/src/environments/environments.controller.ts`, `apps/api/src/jobs/jobs.controller.ts` (SSE precedent), `packages/shared/src/otel.ts`, `k8s/addons/otel-collector-aws.yaml`
- Companion plan: `docs/plans/job-observability-gaps-plan.md`
- Skillpack docs requiring update on each gap landing: `eve-skillpacks/eve-work/eve-read-eve-docs/references/{observability,deploy-debug,cli}.md`
