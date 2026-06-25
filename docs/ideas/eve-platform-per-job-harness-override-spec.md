# Eve Platform Requirements — Per-Job Harness Profile & Env Overrides

> **Status**: Draft requirements for Eve platform
> **Date**: 2026-04-21
> **Consumer**: Eden (AI-first requirements platform)
> **Related**: supersedes the earlier per-project profile sketch; shipped profile source is `x-eve.agents.profiles`
> **Contact**: Platform maintainers

## 1. Context

Eve already supports named harness profiles defined in
`x-eve.agents.profiles` and referenced by agents via `harness_profile:
<name>`. Profiles resolve at dispatch from
`agent_config.x_eve_yaml`, synced by `eve agents sync`. Secrets (BYOK
model credentials) resolve per request from the
`project > user > org > system` hierarchy, and private endpoints
(Tailscale) publish stable in-cluster DNS names.

These primitives are sufficient to run **one** harness configuration
per Eve project. They are not sufficient when a single Eve project
hosts many tenant-like sub-projects that each need a different brain
(model, endpoint, credentials, reasoning effort).

Eden is the motivating consumer: one Eve project deploys the Eden app,
but Eden holds N user-owned "Eden projects" in its own database, and
each Eden project needs to choose between frontier models (Claude
Sonnet via Anthropic), self-hosted models (Qwen3.5 on a Mac Mini via
Tailscale), or OpenAI / Gemini per owner preference.

The cleanest fix is to let the job-creating app supply a harness
profile **override at dispatch time**, without re-syncing
`agents.yaml`. This spec defines that surface across the three
dispatch paths: direct job creation, chat routing, and event-triggered
workflows.

## 2. Problem Statement

Today, to change the harness profile for a subset of jobs inside one
Eve project, the app must:

1. Mutate `eve/x-eve.yaml` or a variant.
2. Call `eve agents sync`.
3. Dispatch the job.
4. Mutate back.

This is racy (concurrent dispatches see stale config), slow (sync is
not instant), visible (changes `agent_config.x_eve_yaml` on shared
state), and impossible for chat-originated jobs which resolve profile
at the point the gateway inbound arrives.

The platform needs a first-class, per-invocation override that does
not require mutating shared agent config.

## 3. Glossary

| Term | Meaning |
|---|---|
| **Profile** | Named bundle of `{harness, model, reasoning_effort, env_overrides}` in `x-eve.agents.profiles`. |
| **Inline override** | A profile-shaped object passed at dispatch time that wins over the agent's default profile. |
| **Env overrides** | Additional environment variables injected into the harness process, supporting `${secret.KEY}` interpolation against the standard secret hierarchy. |
| **Dispatch path** | One of: direct job creation, chat routing, event-triggered workflow step. |

## 4. Requirements

### R1 — Inline harness profile override on job creation (MUST)

**Endpoint**: `POST /projects/{id}/jobs`

**Change**: accept a new optional field `harness_profile_override` in
the request body, sibling to the existing `harness_profile` string
field. When present, the inline override wins over both the agent's
default `harness_profile` and any string reference in the same
request.

```json
{
  "agent": "pm-coordinator",
  "harness_profile_override": {
    "harness": "claude",
    "model": "qwen3.5:32b-instruct",
    "reasoning_effort": "high"
  },
  "env_overrides": {
    "ANTHROPIC_BASE_URL": "${secret.EDEN_QWEN_BASE_URL}",
    "ANTHROPIC_API_KEY":  "${secret.EDEN_QWEN_API_KEY}"
  }
}
```

**Acceptance**:
- R1.1: When `harness_profile_override` is present, the worker spawns
  the harness with the declared `harness`, `model`, and
  `reasoning_effort` — ignoring the agent's `harness_profile`.
- R1.2: When `env_overrides` is present, declared keys are injected
  into the harness process env. Values support `${secret.KEY}`
  interpolation resolved at the job's effective scope (project,
  falling back through user/org/system per existing rules).
- R1.3: Unknown harness or malformed override rejects with HTTP 400
  and a structured error body naming the offending field. Validation
  happens at API time, not worker time.
- R1.4: The override is persisted on the job record so `eve job show
  <id> --json` can recover it for post-hoc debugging.
- R1.5: Jobs created without `harness_profile_override` behave exactly
  as today — zero change for existing callers.

### R2 — Per-request override for chat-routed jobs (MUST)

**Endpoint**: `POST /chat/route` and the gateway inbound pipeline.

**Change**: accept `harness_profile_override` and `env_overrides`
inside the existing `hints` object on inbound chat payloads. The chat
service propagates them to every job it creates (lead + member +
relay/fanout children in team dispatch) unless the inbound specifies
otherwise.

```json
{
  "provider": "slack",
  "project_id": "proj_xxx",
  "message": "@eve pm review this doc",
  "hints": {
    "thread_id": "1712345678.000100",
    "harness_profile_override": { "harness": "claude", "model": "sonnet" },
    "env_overrides": {
      "ANTHROPIC_BASE_URL": "${secret.EDEN_FRONTIER_BASE_URL}"
    }
  }
}
```

**Acceptance**:
- R2.1: The override propagates to team-dispatched child jobs
  (fanout/council/relay, including staged council).
- R2.2: The override is written to the coordination thread metadata
  so `eve thread messages` can surface it for debugging.
- R2.3: If the override references secrets not present at the
  project's effective scope, job creation fails fast with a
  descriptive error delivered back to the originating chat thread
  (not silently swallowed).
- R2.4: The gateway itself does not interpolate secrets — the chat
  service hands the raw override through to the job create path, and
  the worker's existing secret resolver does the interpolation.

### R3 — Per-step override in event-triggered workflows (SHOULD)

**Surface**: workflow step bodies in `workflows.yaml`, and workflow
inputs at trigger time.

**Change**: allow workflow steps to take a `harness_profile` that
references a template expression resolved against the triggering event
payload and `workflow.inputs`. Support a new `harness_profile_override`
step field for inline bundles.

```yaml
workflows:
  ingestion-pipeline:
    trigger:
      system:
        event: doc.ingest
    inputs:
      harness_profile:
        from: event.payload.harness_profile
        default: coordinator
    steps:
      - name: extract
        agent:
          name: extraction
          harness_profile: "${inputs.harness_profile}"
      - name: synthesize
        depends_on: [extract]
        agent:
          name: synthesis
          harness_profile: "${inputs.harness_profile}"
```

**Acceptance**:
- R3.1: `workflow.inputs.*` supports `from: event.payload.<path>`
  with a `default` fallback. Existing static input values continue to
  work.
- R3.2: `agent.harness_profile` accepts both a literal string and a
  template expression `${inputs.<key>}`. Undefined or unresolved
  expressions fall back to the agent's default profile with a warning
  log event.
- R3.3: `agent.harness_profile_override` accepts an inline bundle
  matching the R1 shape; template expressions are allowed inside
  field values (`model: "${inputs.model}"`).
- R3.4: Validation at `eve agents sync` rejects unknown template
  variables and malformed bundles.

### R4 — Profile validation & introspection (MUST)

**Endpoint**: `POST /projects/{id}/harness-profile/validate`

Given an inline profile + env_overrides, return:
- whether the harness binary is available on the worker
- whether all `${secret.KEY}` references resolve at the requested
  scope
- a dry-run `buildCommand` result (no execution, no billing)

**Acceptance**:
- R4.1: No inference traffic is generated during validation.
- R4.2: Response includes per-secret resolution status (`resolved`,
  `missing`, `wrong_scope`) with remediation hints.
- R4.3: CLI support: `eve harness validate --profile-file p.json
  --project proj_xxx`.

### R5 — Receipts & cost attribution (MUST)

Harness invocation receipts (`execution_logs`, receipts table) already
record the harness profile name. Extend to capture inline overrides:

**Acceptance**:
- R5.1: Receipts include a `harness_profile_source` enum:
  `agent_default | string_ref | inline_override | workflow_template`.
- R5.2: When `source = inline_override`, the receipt stores a stable
  hash of the override bundle plus the raw harness/model/effort so
  cost reports can group by effective profile.
- R5.3: `eve analytics cost --group-by harness_profile` surfaces
  inline overrides as distinct rows, not silently merged under the
  agent's default profile name.

### R6 — Backwards compatibility (MUST)

**Acceptance**:
- R6.1: All existing callers (no override fields present) observe
  zero behavior change.
- R6.2: Existing `harness_profile: <string>` resolution continues to
  read from `agent_config.x_eve_yaml` as today.
- R6.3: If both `harness_profile` (string) and
  `harness_profile_override` (inline) are provided, the inline
  override wins and the server emits a single warning log event —
  not an error — to aid migration.

### R7 — Secret boundary (MUST)

**Acceptance**:
- R7.1: `env_overrides` values are stored on the job record with
  `${secret.KEY}` placeholders intact — never resolved plaintext.
- R7.2: Resolution happens in the existing worker secret resolver;
  the same `[resolveSecrets]` fail-fast behavior applies.
- R7.3: `eve job show <id> --json` returns the placeholder form,
  never plaintext, matching current secret-in-env display rules.
- R7.4: An override that references a secret not present at the
  effective scope fails the job at `resolveSecrets` time (today's
  behavior), not at spawn.

### R8 — Permission model (MUST)

**Acceptance**:
- R8.1: Creating a job with `harness_profile_override` requires
  `jobs:write` (unchanged).
- R8.2: Creating a job with `env_overrides` that references a secret
  requires `secrets:read` at the resolved scope, enforced at
  validation time (R4) and at resolve time.
- R8.3: A new optional permission `jobs:harness_override` can be
  introduced to let orgs gate inline overrides. Default grant:
  everyone who has `jobs:write`. Orgs may remove it from custom roles
  to lock the feature down.

## 5. Non-Goals

- Eve is not asked to manage a model catalog, run inference, or proxy
  harness traffic. BYOK stays the model.
- Eve is not asked to understand Eden's `projects` table. Eden is
  responsible for mapping its internal project IDs to overrides.
- Eve is not asked to introduce a UI for picking profiles — that
  lives in the consuming app.
- Eve is not asked to change how `x-eve.agents.profiles` works as the
  default source. Inline override is additive.

## 6. Migration Plan

1. **Ship R1 + R6 + R7 + R8** in one release. Eden can build
   per-project profiles on day one using only direct job creation
   (wizard, changeset apply, question evolution via one-shot jobs).
2. **Ship R4** alongside R1 — validation is low-risk and unblocks
   wizard UX.
3. **Ship R2** in the next release. Unblocks chat-originated jobs
   (Slack `@eve pm`, web chat panel).
4. **Ship R3** when template expression engine in workflow YAML is
   ready. Unblocks event-triggered pipelines (`doc.ingest`,
   `changeset.accepted`, `question.answered`).
5. **Ship R5** concurrent with R1 if receipts pipeline already
   supports structured columns; otherwise follow-up release.

## 7. Acceptance Test Plan

Each requirement ships with contract tests in the Eve CI suite:

| Req | Test |
|---|---|
| R1.1 | Create job with override → worker spawns declared harness/model; assert via execution log. |
| R1.3 | Malformed override → 400 with field-level error. |
| R2.1 | Inbound Slack message with override → all team-dispatched child jobs share override (assert on `job.harness_options`). |
| R2.3 | Override with missing secret → delivery_failed status, error posted to thread. |
| R3.1 | Event payload with `harness_profile` → workflow step resolves template; missing → default path. |
| R4.2 | Validation probe with missing secret → `missing` status + remediation hint. |
| R5.1 | Receipts query groups inline-override jobs as distinct rows. |
| R6.1 | Regression suite: all existing tests pass unchanged with no override fields. |
| R7.1 | Stored job record contains `${secret.X}` placeholder verbatim; plaintext never written. |
| R8.2 | Caller without `secrets:read` at resolved scope → 403 at validation. |

## 8. Open Questions

- **Q1**: Should `env_overrides` allow literal (non-secret) values?
  Tentative yes, but with a size cap to prevent abuse.
- **Q2**: Should inline override support `variant` (per-harness
  config root overlay) in addition to model? Tentative yes, same
  field shape as existing harness_options.
- **Q3**: Should we let the inline override specify
  `permission_policy` too? That conflates two concerns — recommend
  keeping permission policy sourced from the agent default and only
  varying the model/endpoint bundle.
- **Q4**: Rate-limit per-project override volume? If an app can burn
  through N different Qwen endpoints per hour, the worker's
  per-attempt secret resolution may become chatty. Start without a
  limit, add if observed.

## 9. Out-of-Scope Alternatives Considered

- **Dynamic `eve agents sync` before each dispatch** — racy, slow,
  mutates shared state.
- **Per-tenant Eve project** — forces one cluster namespace, one
  managed DB, one ingress per tenant. Does not scale for consumer
  apps like Eden.
- **Eve-managed model catalog** — violates BYOK principle; deferred
  indefinitely.
- **App-side harness proxy** — Eden terminates inference in a local
  sidecar and speaks a single API surface to the harness. Works, but
  bypasses Eve's receipts/cost tracking and duplicates what BYOK +
  private endpoints already solve.

---

Ship R1–R8 and Eden can deliver per-Eden-project brains through a
wizard radio button, with no shared-state races, clean cost
attribution, and a path to air-gapped Qwen-on-Mac-Mini as a
first-class option.
