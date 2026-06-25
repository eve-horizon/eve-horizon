# Cross-Project App Links

> **Status**: Proposed
> **Last Updated**: 2026-05-15
> **Spec**: `eve-platform-specs/005 - Cross-Project App Links` (ACME-side request, opened 2026-05-14)
>
> **Inputs**:
> - `docs/plans/app-cli-framework-plan.md` (CLI bundling + distribution — implemented)
> - `docs/plans/app-service-eve-api-auth-plan.md` (`EVE_SERVICE_TOKEN` — implemented)
> - `docs/plans/agent-job-token-plan.md` and `docs/plans/job-token-path-and-mount-scope-plan.md` (`EVE_JOB_TOKEN` + resource scope — implemented)
> - `docs/plans/app-magic-link-domain-allowlist-plan.md` (precedent for cross-project allowlist resolution at sync time)
> - `eve-read-eve-docs/references/app-cli.md`, `events.md`, `secrets-auth.md`, `pipelines-workflows.md`
>
> **Dependencies (already shipped)**:
> - API-side RS256 JWT with `type` discriminator (`user` / `job` / `service` / `service_principal`); the external auth SDK and auth response schemas still need `service` + `app_link` parity in this plan.
> - `x-eve.api_spec` + `x-eve.cli` (manifest sync stores into `project_api_sources` / parsed manifest)
> - `resolveAppApis()` → `EVE_APP_API_URL_<NAME>` env vars + agent instruction block
> - App CLI distribution: repo-mode (chmod+symlink), image-mode (init container + `EVE_APP_CLI_PATHS`)
> - Event spine (`events` table, orchestrator polling, trigger evaluation metadata)
> - Webhook delivery machinery (deliveries, retries, replay, HMAC) — pattern for retry/DLQ semantics

---

## Problem

The observation-platform architecture, and every other "core + satellites" pattern Eve hopes to support, requires that **one Eve project consume another Eve project's API, CLI, and app events** without manually wiring URLs, copying CLIs, or stashing long-lived shared secrets.

Today the platform supports this **inside a single project**:

- A service declares `x-eve.api_spec` + `x-eve.cli`; agents in the same project auto-discover it.
- Workflow steps use `with_apis` to inject `EVE_APP_API_URL_<NAME>` + `EVE_JOB_TOKEN`.
- Deployed services in the same project share a namespace and can reach each other via in-cluster DNS.
- App events from `source: app` route to triggers defined in the **same** project's manifest.

Across projects, nothing connects. A consumer satellite must:

1. Hard-code or hand-roll `OBSERVATION_API_URL` env vars.
2. Mint and store a long-lived service principal token or share a project secret out-of-band.
3. Copy the producer's CLI binary into every consumer repo (or fall back to curl).
4. Re-emit producer events as webhooks into consumer-side endpoints.

That works for two projects. It is a tax on every new satellite, and the tax is paid in long-lived shared secrets that no rotation policy touches.

We want **`x-eve.app_links`**: a producer/consumer declaration with allowlist enforcement at sync time, audience-bound short-lived tokens minted by the platform, native CLI exposure, and cross-project event subscription that reuses our existing webhook delivery semantics.

---

## Insight

Three pieces of Eve infrastructure already do 80% of the work; we just have to teach them about a second project:

1. **JWTs already carry a `type` claim** that `AuthService.verifyAuthorizationHeader()` peeks before verification (`apps/api/src/auth/auth.service.ts:236-245`). Adding `aud` and a new `type: "app_link"` is a small, additive surface — not a new auth mechanism.
2. **`resolveAppApis()` already produces `EVE_APP_API_URL_<NAME>` + instruction blocks and threads CLI metadata through to harness/runner setup** (`apps/api/src/jobs/jobs.service.ts:293-344`). A sibling resolver that joins through a cross-project link table reuses every downstream pipe.
3. **The event router already polls per-project and writes evaluation metadata** (`apps/orchestrator/src/events/event-router.service.ts:36-249`). Fan-out to consumer projects is a second pass after primary trigger matching that writes a new event into the consumer project — the consumer's own trigger matcher then routes it like any other event.

The elegance is in not building anything new at the consumer end. The consumer's existing trigger matcher fires on a normal event in the `events` table; the consumer's existing `resolveAppApis()` injects the producer URL/CLI/token; the consumer's existing deployer puts the env vars on the pod. The producer-side surface is small: a new manifest block, a new mint endpoint, a fan-out pass, and a link registry.

The right primitive is the **JWT `aud` claim**: producer API trusts a token if and only if `aud === "project:<producer_id>"`, signed by the platform key, with `scopes ⊆ allowlist`. This is JWT 101. It needs zero per-project keys, zero key exchange, zero rotation infrastructure beyond what we already do for `EVE_SERVICE_TOKEN`.

---

## Goals

- **Declarative both sides**: producer manifest declares exports with an explicit consumer allowlist; consumer manifest declares consumes with requested scopes. Sync fails if the producer hasn't granted what the consumer asks for.
- **Audience-bound tokens**: every token Eve mints for a cross-project call carries `aud: "project:<producer_id>"` and is verified that way. Service-surface tokens follow the existing 90-day deploy-refresh cycle, but producer verification must consult active grant state so revocation is immediate. Job-surface tokens are minted at dispatch with an explicit short TTL (v1 lean: 1 hour; this is intentionally stricter than today's 8-hour `mintJobToken()` default).
- **CLI exposure across projects**: producer's image-mode CLI is delivered to consumer agent workspaces via the same init-container pattern that already ships toolchains. Image pull is platform-mediated, not consumer-mediated.
- **Event subscription with replay/retry semantics**: producer app events fan out to subscribed consumer projects via the event spine, with deduplication, exponential-backoff retry, and replay — reusing the webhook delivery machinery rather than rebuilding it.
- **Diagnostics first**: `eve app-links list`, `eve app-links plan`, `eve app-links explain` make grants, scopes, environments, last mint, and last delivery legible. If a link silently breaks (producer revokes, scope shrinks), `explain` tells you exactly why before the next deploy fails.
- **No long-lived shared secrets**: nothing project-scoped is written into another project's secrets store. The platform mints on every deploy or job dispatch.

## Non-Goals (v1)

- **Cross-org links**. Producer and consumer must share an org. Cross-org adds invitation / approval / billing semantics that belong in their own plan.
- **Service mesh / mTLS**. We do not introduce a mesh, sidecars, or per-link mTLS in v1. We still must reconcile the existing namespace hardening rules: direct cross-namespace Service DNS only works when NetworkPolicy permits it, so v1 either emits additive app-link NetworkPolicy rules or routes through an ingress path that is already allowed. Security authorization remains at the token layer.
- **Streaming sockets (SSE/WS)**. The token-in-env-var contract is REST/HTTP-first. SSE through cross-project links can come later if needed.
- **Producer DB access**. App links are API/CLI/event-only. Direct DB sharing across projects is explicitly excluded and remains forbidden.
- **Bidirectional consumer→producer events**. v1 is one-way: producer publishes, consumer subscribes. If a consumer needs to publish back, it does so by calling a producer API endpoint via its app-link token.
- **Pushed token revocation channel**. v1 does not add a pub/sub revocation feed. Immediate revocation comes from producer-side verification consulting active grant/subscription state; pushed cache invalidation can come later if remote verification becomes a bottleneck.

---

## Design

### 1) Manifest surface

#### Producer (`x-eve.app_links.exports`)

```yaml
x-eve:
  app_links:
    exports:
      apis:
        observation:                  # export name (producer-chosen)
          service: api                # which service in this project
          cli: obs                    # optional — must match service's x-eve.cli.name
          scopes:                     # superset of all scopes consumers may request
            - observations:read
            - observations:write
            - deployments:read
            - events:read
          consumers:                  # explicit allowlist
            - project: acme-portal          # slug or proj_xxx
              scopes: [observations:read, deployments:read]
              envs: [staging, production]       # producer envs this consumer may target
            - project: vstarcam-ingest
              scopes: [observations:write, deployments:read]
              envs: [staging]
      events:
        observation-feed:             # event export name
          types:                      # event types this feed publishes (matches event.type)
            - app.observation.created
            - app.observation.updated
            - app.event.derived
          consumers:
            - project: acme-portal
              types: [app.observation.created]   # optional — narrow type subset
            - project: observation-evals
              # omitted types → all types from feed
```

Notes:

- The producer's service must already have a working `x-eve.api_spec` (and optional `x-eve.cli`). Exports are a wrapper, not a replacement.
- `consumers[].project` accepts a project slug or canonical `proj_xxx` ID. Slugs are resolved against the same org at sync time, same as `org_access.allowed_orgs` and `domain_signup.target_org` today.
- `scopes` here is the **producer's grant**. App-level authorization (tenant, role, resource) still lives in the producer app — these scopes are coarse capability claims, identical in shape to `EVE_SERVICE_TOKEN` permissions.

#### Consumer (`x-eve.app_links.consumes`)

```yaml
x-eve:
  app_links:
    consumes:
      observation:                     # local alias (consumer-chosen; namespaces env vars)
        project: observation-platform  # producer project slug or proj_xxx
        api: observation               # producer's export name
        environment: same              # same | <fixed producer env name>
        scopes: [observations:read, deployments:read]
        events:                        # optional: subscribe to a producer event export
          feed: observation-feed       # producer's event export name
          types:
            - app.observation.created
        inject_into:                   # which consumer surfaces get env vars
          services: [api, worker]
          jobs: true
```

Notes:

- `environment: same` resolves at deploy time to the matching env on the producer side (e.g., consumer deploy to `staging` → producer's `staging`). If the producer has no matching env, the consumer's deploy fails fast with a clear error from `eve app-links explain`.
- Local alias `observation` becomes the env var prefix: `EVE_APP_LINK_OBSERVATION_*`. The consumer chooses it so a consumer can talk to two providers without name collisions.
- `inject_into` is explicit by design. Omitting it records the subscription for diagnostics and event fan-out, but does not inject runtime tokens; `eve app-links explain` warns that the link is not exposed anywhere. Setting `services: []` makes the link agent-only (CLI in agent workspaces, no service env vars). Setting `jobs: false` makes the link service-only (no agent exposure).
- Event subscription must name the producer's event export (`feed`). Type-only matching is ambiguous once a producer has multiple feeds or overlapping event types.

### 2) Validation at sync time

The validation order is **producer first, consumer second**, but each project syncs independently. The trick is that the link table is the source of truth and is keyed by `(producer_project_id, export_kind, export_name, consumer_project_id)`.

**Producer sync** (`projects.service.ts → syncManifest`):

1. Parse `app_links.exports`.
2. Resolve every `consumers[].project` slug to a canonical `proj_xxx` within the same org. Unknown slug → error.
3. Diff against the existing `project_app_link_grants` table: upserts and deletes (mark `revoked_at`).
4. Coherence checks: every API `consumers[].scopes` ⊆ export `scopes`; every event `consumers[].types` ⊆ feed `types`; every `envs` member exists in this project; every event `types` entry is shaped like `app.*` or `runner.*` (advisory warning otherwise).
5. Reject the sync on any error. Warnings surface in `eve project sync` output and on `eve app-links list --project <producer>`.

**Consumer sync** (`projects.service.ts → syncManifest`):

1. Parse `app_links.consumes`.
2. For each consume block, fetch the corresponding API grant (`api`) and, when present, event grant (`events.feed`) from `project_app_link_grants`.
3. Validate:
   - Each referenced grant exists and is not revoked.
   - Consumer's requested `scopes` ⊆ API grant's `api_scopes`.
   - Consumer's requested `events.types` ⊆ event grant's `event_types`.
   - `environment` resolves to a producer env that every referenced grant allows.
   - `inject_into.services` names real consumer services; `jobs` is boolean.
4. Upsert into `project_app_link_subscriptions` table (keyed by `(consumer_project_id, local_alias)`).
5. Reject on any failure. The error message is **specific**: "Consumer `acme-portal` requested scope `observations:write`, but producer `observation-platform` only grants `observations:read` to this consumer."

Sync order is irrelevant on first run: a consumer that syncs before the producer fails with "no grant from producer X". The user re-runs producer first. We do not silently queue.

### 3) Tables

```sql
-- 00100_app_links.sql
-- Use the next migration number at implementation time if new migrations land first.

CREATE TABLE project_app_link_grants (
  id                    VARCHAR(50)  PRIMARY KEY,        -- aplg_xxx
  producer_project_id   VARCHAR(50)  NOT NULL REFERENCES projects(id),
  export_kind           VARCHAR(20)  NOT NULL CHECK (export_kind IN ('api', 'events')),
  export_name           VARCHAR(100) NOT NULL,            -- 'observation' or 'observation-feed'
  consumer_project_id   VARCHAR(50)  NOT NULL REFERENCES projects(id),
  api_scopes            JSONB        NOT NULL DEFAULT '[]',  -- api grants only: capability claims
  event_types           JSONB        NOT NULL DEFAULT '[]',  -- event grants only: published type allowlist
  envs                  JSONB        NOT NULL DEFAULT '[]',  -- producer envs allowed (empty = all)
  service_name          VARCHAR(100),                     -- for api: the producer service exposing the API
  cli_name              VARCHAR(100),                     -- for api: optional CLI binary name
  cli_image             VARCHAR(255),                     -- for api: optional CLI image (resolved from producer manifest at sync)
  cli_bin_path          VARCHAR(255),                     -- for api: optional CLI bin path (repo mode)
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (producer_project_id, export_kind, export_name, consumer_project_id)
);

CREATE INDEX idx_app_link_grants_consumer ON project_app_link_grants (consumer_project_id, revoked_at);
CREATE INDEX idx_app_link_grants_producer ON project_app_link_grants (producer_project_id, revoked_at);

CREATE TABLE project_app_link_subscriptions (
  id                       VARCHAR(50)  PRIMARY KEY,     -- apls_xxx
  consumer_project_id      VARCHAR(50)  NOT NULL REFERENCES projects(id),
  local_alias              VARCHAR(100) NOT NULL,        -- env-var prefix, e.g. 'observation'
  api_grant_id             VARCHAR(50)  REFERENCES project_app_link_grants(id),
  event_grant_id           VARCHAR(50)  REFERENCES project_app_link_grants(id),
  requested_scopes         JSONB        NOT NULL DEFAULT '[]',
  event_types              JSONB        NOT NULL DEFAULT '[]',
  environment_strategy     VARCHAR(20)  NOT NULL DEFAULT 'same',  -- 'same' | 'fixed'
  producer_env_name        VARCHAR(100),                         -- set when environment_strategy='fixed'
  inject_into_services     JSONB        NOT NULL DEFAULT '[]',   -- []=none, [...]=specific
  inject_into_jobs         BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (consumer_project_id, local_alias),
  CHECK (api_grant_id IS NOT NULL OR event_grant_id IS NOT NULL)
);

CREATE INDEX idx_app_link_subscriptions_api_grant
  ON project_app_link_subscriptions (api_grant_id)
  WHERE api_grant_id IS NOT NULL;
CREATE INDEX idx_app_link_subscriptions_event_grant
  ON project_app_link_subscriptions (event_grant_id)
  WHERE event_grant_id IS NOT NULL;

CREATE TABLE app_link_event_deliveries (
  id                       VARCHAR(50)  PRIMARY KEY,    -- alde_xxx
  subscription_id          VARCHAR(50)  NOT NULL REFERENCES project_app_link_subscriptions(id),
  source_event_id          VARCHAR(50)  NOT NULL REFERENCES events(id),
  consumer_event_id        VARCHAR(50)  REFERENCES events(id),   -- set on success
  status                   VARCHAR(20)  NOT NULL,        -- 'pending' | 'retrying' | 'success' | 'failed' | 'skipped'
  attempts                 INT          NOT NULL DEFAULT 0,
  last_attempt_at          TIMESTAMPTZ,
  next_retry_at            TIMESTAMPTZ,
  last_error               TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (subscription_id, source_event_id)
);

CREATE INDEX idx_app_link_event_deliveries_pending
  ON app_link_event_deliveries (next_retry_at)
  WHERE status IN ('pending', 'retrying');
```

The `(subscription_id, source_event_id)` uniqueness is the deduplication primitive — same dedup model as `webhook_deliveries.(subscription_id, event_id)` today.

### 4) Token: `type: "app_link"`

We add one new token type, minted by the platform on the consumer side, audience-bound to the producer.

```json
{
  "sub": "app_link:<subscription_id>",
  "type": "app_link",
  "iss": "eve",
  "aud": "project:<producer_project_id>",
  "subscription_id": "<subscription_id>",
  "consumer_project_id": "<consumer_proj>",
  "consumer_org_id": "<org>",
  "consumer_principal": "service:api | job:<job_id>",
  "consumer_env": "<consumer-env-or-null>",
  "producer_project_id": "<producer_proj>",
  "producer_env": "<producer-env>",
  "api_name": "<export name>",
  "scopes": ["observations:read", "deployments:read"],
  "iat": 1747353600,
  "exp": 1755129600
}
```

**Minting**:

- Service deploy: minted by `apps/worker/src/deployer/deployer.service.ts` at the same point it mints `EVE_SERVICE_TOKEN` (line 2297-2310). 90-day TTL, refreshed on every deploy. One token per `(consumer_project_id, local_alias, env)` injected as `EVE_APP_LINK_<ALIAS>_TOKEN`.
- Job dispatch: minted alongside `EVE_JOB_TOKEN`, but with its own explicit 1-hour TTL. Injected as `EVE_APP_LINK_<ALIAS>_TOKEN` into the agent workspace via the existing `eve-credentials.ts` path.
- Mint endpoint: `POST /internal/auth/mint-app-link-token`, behind `EVE_INTERNAL_API_KEY`, request body `{ subscription_id, consumer_principal, consumer_env, producer_env, ttl_seconds }`.
- The mint endpoint must re-read the subscription + grant in the same transaction, verify neither is revoked, verify the requested producer env is allowed, and mint scopes from the stored `requested_scopes` (never from caller-supplied scopes).

**Verification**:

- Producer-side `verifyAppLinkToken()` added to `auth.service.ts`, follows the existing `verifyJobToken` / `verifyServiceToken` pattern.
- Checks: `type === "app_link"`, signature valid, `aud === "project:<this_producer_project_id>"`, `exp > now`, `scopes` non-empty, and the referenced subscription/grant is still active.
- The existing peek-before-verify routing lives in `apps/api/src/auth/auth.service.ts`, not `auth.guard.ts`. Add an `app_link` branch there, return an `AuthUser` with `is_app_link_token`, and keep `auth.guard.ts` as the thin request-user assignment layer.
- Update `apps/api/src/auth/auth.controller.ts` and `packages/shared/src/schemas/auth.ts` so `/auth/me` and `/auth/token/verify` report `type: "service"` for service tokens and `type: "app_link"` for app-link tokens instead of collapsing them to `user`.
- Producer apps using `@eve-horizon/auth` see `req.eveAppLink` (alongside `req.eveIdentity`) — their middleware exposes the consumer context so the producer app can enforce tenant scoping in domain logic.
- Active revocation requires remote verification or a platform-backed introspection check. Local JWKS-only verification can validate signature/audience/expiry, but cannot see a revoked grant; `eveAppLinkGuard()` should default to remote verification for app-link tokens and make local-only mode an explicit opt-in with documented revocation lag.

**No new keys**. App-link tokens are signed with the same `EVE_AUTH_PRIVATE_KEY`. JWKS and key rotation work unchanged.

### 5) Env var contract

For a consumer's `consumes.observation` block, every injection surface (service pod or agent job) receives:

```text
EVE_APP_LINK_OBSERVATION_API_URL=http://staging-api.eve-acme-observation-staging.svc.cluster.local:3000
EVE_APP_LINK_OBSERVATION_TOKEN=<app-link JWT>
EVE_APP_LINK_OBSERVATION_CLI=obs                    # if producer exported a CLI
EVE_APP_LINK_OBSERVATION_SCOPES=observations:read,deployments:read
EVE_APP_LINK_OBSERVATION_PROJECT=proj_observation   # producer project ID (for app-side debugging)
EVE_APP_LINK_OBSERVATION_ENV=staging                # producer env this URL points to
```

`<ALIAS>` is the consumer-chosen local alias, uppercased with non-alphanumerics replaced by `_` (same convention as `EVE_APP_API_URL_*`).

The producer's API URL is resolved at deploy/dispatch time:

- Same-cluster (local k3d, single-cluster staging/prod): in-cluster DNS `http://<env>-<service>.<producer-namespace>.svc.cluster.local:<port>` (the same shape as `apps/api/src/projects/project-apis.service.ts::resolveBaseUrl`, but using the producer project/env).
- Different-cluster (out of scope for v1 same-org assumption): platform falls back to public ingress URL.

**NetworkPolicy requirement**: environment namespaces are hardened by default. Direct Service DNS requires an additive NetworkPolicy that allows traffic from the consumer environment namespace to the producer environment namespace for the exported service. Phase 2 must include a small reconciler that applies an `eve-app-link-<consumer-env>` policy at deploy time, or the resolver must choose an ingress path that is already permitted. Do not assume cross-namespace Service DNS works just because the DNS name resolves.

### 6) CLI distribution

When a consumer's link includes `cli`, the consumer's agent workspaces get the producer's CLI on PATH.

**Repo-mode CLI** (producer's CLI is bundled in producer's repo at `cli/bin/<name>`):

- Repo-mode does **not** cross project boundaries cleanly — we'd have to clone the producer's repo into the consumer's workspace, which is messy and authorisation-heavy.
- **Rule**: cross-project CLI export requires `image` mode. If the producer's `x-eve.cli` is repo-mode only, `eve project sync` on the consumer emits a clear error pointing to `docs/system/cross-project-app-links.md` with instructions for the producer to add a CLI image build.
- We add a small `build.cli-image` action in pipelines that packages the producer's repo-bundled CLI as `ghcr.io/<org>/<project>-cli:<sha>` so producers can adopt image-mode trivially without rewriting their build.

**Image-mode CLI**:

- The producer's CLI image reference is stored in `project_app_link_grants.cli_image` at producer sync time (resolved from the producer's manifest).
- At consumer job dispatch, the agent-runtime's k8s-runner (`apps/agent-runtime/src/invoke/k8s-runner.ts:252-274`) already injects init containers for image-mode CLIs from `invocation.appClis`. We extend the resolver to also push `{ name, image, env_prefix: 'EVE_APP_LINK_<ALIAS>' }` entries from app-link subscriptions.
- Image pull credentials: the producer's image registry is the producer's responsibility. If the registry is private, the producer's CLI image must be pushed to a registry whose pull secret is available cluster-wide (in practice: the platform's shared `ghcr.io` pull secret already covers this case for staging). For dev, we use the local k3d registry which is unauthenticated.

The result: a consumer agent runs `obs observations list` and the binary is already on PATH, with token + URL already in env vars. No installation, no auth setup, no copying repos.

### 7) Event subscription fan-out

The producer's `events` table stays project-scoped (no table shape change; `EventSourceSchema` still gains `app_link`). The fan-out happens after primary trigger matching in the orchestrator.

```
[producer project event arrives]
        |
        v
EventRouterService.processEvent (apps/orchestrator/src/events/event-router.service.ts)
        |
        +-- existing: matchTriggersForEvent (producer's own pipelines/workflows)
        |
        +-- new: fanOutAppLinkEvent
              |
              +-- SELECT * FROM project_app_link_subscriptions sub
              |   JOIN   project_app_link_grants     g ON g.id = sub.event_grant_id
              |   WHERE  g.producer_project_id = <event.project_id>
              |     AND  g.export_kind = 'events'
              |     AND  g.revoked_at IS NULL
              |     AND  <event.type matches sub.event_types intersected with g.event_types>
              |
              +-- For each subscription, INSERT INTO app_link_event_deliveries if absent
              |
              +-- Delivery processor INSERTs INTO events with:
              |   - project_id = subscription.consumer_project_id
              |   - source     = 'app_link'  (add to EventSourceSchema)
              |   - type       = original event.type   (preserved — consumer's trigger.event.type matches verbatim)
              |   - payload_json = {
              |       producer_event_id: <evt_xxx>,
              |       producer_project_id: <proj_xxx>,
              |       producer_env_name: <env or null>,
              |       link_alias: <consumer's local alias>,
              |       original: <original payload_json>,
              |     }
              |   - dedupe_key = "app_link:<subscription_id>:<source_event_id>"
              |   - actor_type / actor_id  copied from source event
              |
              +-- UPDATE app_link_event_deliveries (status='success', consumer_event_id=<evt>)
```

A consumer subscribes via its existing trigger machinery:

```yaml
workflows:
  ingest-observation:
    trigger:
      event:
        source: app_link
        type: app.observation.created
    steps:
      - name: process
        agent: { prompt: "Process the observation event" }
```

Or for stricter routing keyed to a specific producer:

```yaml
trigger:
  app_link:                    # new convenience trigger
    alias: observation         # match the consumer's local alias
    type: app.observation.created
```

Both forms work; the `app_link` shorthand is recommended for clarity.

**Retry / DLQ**: app-link fan-out must use `app_link_event_deliveries` as a real retry queue, not just observability. The producer event router queues one delivery per matching subscription and may then mark the producer event completed. A delivery processor performs the consumer-event insert, updates `attempts`, `last_attempt_at`, `next_retry_at`, and backs off exactly like webhook delivery. Exhausted deliveries become `failed` and are visible in `eve app-links explain`; over-rate-limit deliveries become `skipped`. This avoids relying on source event status for retry, because today's event router marks processing errors as `failed` and does not automatically retry failed events.

**Replay**: `eve app-links replay --subscription <id> --from <event_id_or_time>` walks the producer's `events` table for the window and re-runs fan-out, using the existing dedup key to skip already-delivered events. Same shape as `webhook_replays` today.

### 8) Refactoring required

These are not "nice to have" — the design is only clean if we collapse what we have:

1. **Unify `resolveAppApis` into a single resolver that knows about both same-project and cross-project sources.** Today `apps/api/src/jobs/jobs.service.ts` and `apps/api/src/workflows/workflows.service.ts` each resolve same-project `hints.app_apis` from `project_api_sources` plus manifest fallback. Extract that into `packages/shared/src/app-apis/resolver.ts`, and add a second source: `project_app_link_subscriptions` joined to `project_app_link_grants`. Output is a single `ResolvedApi[]` with `origin: 'project' | 'app_link'` and, for app links, `{ subscription_id, producer_project_id, producer_env_name, env_prefix }`.

2. **Make link references first-class in job/workflow hints.** Keep `hints.app_apis: string[]` for same-project API names and add `hints.app_links: string[]` for cross-project aliases. Extend workflow/chat `with_apis` parsing to accept `[{ service: api }]` and `[{ link: observation }]`, and add a CLI affordance (`eve job create --with-links observation` or equivalent) instead of overloading comma-separated `--with-apis`.

3. **Move env var construction to one place.** `buildAppApiEnvVars()` in `packages/shared/src/schemas/api-source.ts` currently outputs `EVE_APP_API_URL_<NAME>` for same-project APIs. Extend it (or replace it with `buildResolvedApiEnvVars()`) to also output `EVE_APP_LINK_<ALIAS>_*` for cross-project ones. The deployer (`apps/worker/src/deployer/deployer.service.ts`) and the worker/agent-runtime invoke paths both call this single function — no duplication.

4. **Promote CLI metadata to a first-class invocation field.** Today `HarnessInvocation.appClis` exists but is unpopulated (`packages/shared/src/types/harness.ts:68`). Wire it from the unified resolver so both repo-mode (same-project) and image-mode (any project, including cross-project) flow through the same field. The k8s-runner already handles image-mode; the worker/agent-runtime local invoke paths already handle repo-mode from `resolved_app_apis`. We need to populate the invocation field and keep the repo-mode setup path for non-k8s execution.

5. **Centralise token minting in `packages/shared/src/api-client/auth-client.ts`.** It already exposes `mintJobToken()` and `mintServiceToken()`. Add `mintAppLinkToken()` next to them so deployer + orchestrator + worker all call one helper. No new HTTP client patterns; just a third sibling.

6. **Trigger matcher fan-out lives next to existing trigger matching.** `apps/orchestrator/src/events/event-router.service.ts` gets one new method `fanOutAppLinkEvent()` invoked after `matchTriggersForEvent()`. Extend `packages/shared/src/schemas/event.ts` and `packages/db/src/queries/events.ts` so `triggers_evaluated` can represent app-link outcomes (`type: 'app_link'`, `name: <alias>`, `matched`, `reason`, `subscription_id`, `delivery_id`) without losing fields in API responses.

### 9) CLI: `eve app-links *`

```bash
# List exports and consumes for a project
eve app-links list --project <slug-or-id>
# Output (text):
#   Exports:
#     api/observation  →  acme-portal (observations:read, deployments:read)
#                         vstarcam-ingest  (observations:write, deployments:read)
#     events/observation-feed → acme-portal, observation-evals
#   Consumes:
#     observation     ← observation-platform  api/observation  scopes=[...] last_token=2h ago

# Validate a consumer manifest against current producer state without syncing
eve app-links plan --project <consumer> --env <env> [--file .eve/manifest.yaml]
# Output: green checks for resolvable links, red errors for missing/insufficient grants.

# Why is this link broken / what does it allow?
eve app-links explain --consumer <consumer> --producer <producer> --api <export>
# Output:
#   Producer grant      observation-platform / api / observation
#     Allowed scopes:   observations:read, observations:write, deployments:read, events:read
#     Allowed envs:     staging, production
#     For consumer:     acme-portal
#   Consumer subscription  acme-portal / observation
#     Requested scopes:    observations:read, deployments:read   ✓ within grant
#     Env strategy:        same  (staging→staging ✓, production→production ✓)
#     Last token mint:     2026-05-15T14:02:11Z  (consumer service `api`)
#     Last token aud:      project:proj_observation_xxx
#   Status: OK

# Replay producer events into a consumer subscription (recovery / backfill)
eve app-links replay --subscription <id> --from <event_id_or_time> [--dry-run]
```

All commands return `--json` for agent consumption.

### 10) Producer-side app integration

A producer app using `@eve-horizon/auth` should not hand-parse app-link JWTs. We update `packages/auth/src/unified.ts` and exports in `packages/auth/src/index.ts`, then add `eveAppLinkGuard()` that:

- Calls the unified token resolver with remote verification by default.
- If the token is an `app_link` token, exposes `req.eveAppLink = { consumer_project_id, scopes, ... }`.
- The producer's app code checks scopes in its existing authorization layer (same shape as checking `EVE_SERVICE_TOKEN` permissions).

The producer can introspect the consumer:

```typescript
@Get('/observations')
@RequireScope('observations:read')   // new decorator, sibling of @RequirePermission
async list(@AppLinkContext() ctx: AppLinkRequestContext) {
  // ctx.consumer_project_id, ctx.scopes — for tenant-scoping in domain logic
}
```

If the producer doesn't want to differentiate by consumer, they ignore the context and treat the call like any authenticated request.

---

## Phasing

The plan implements in four phases, each independently verifiable on local k3d.

### Phase 1 — Manifest schema + grant registry (foundation)

**Code**:
- `packages/shared/src/schemas/manifest.ts`: add `AppLinksExportsSchema`, `AppLinksConsumesSchema`, wire into project-level `ManifestXeveSchema` as `x-eve.app_links`. Do not add this to `ServiceXeve`; per-service API/CLI declarations stay on services, while links are project-level policy.
- DB migration `00100_app_links.sql` (or next available migration number; tables above).
- `packages/db/src/queries/app-link-grants.ts`, `app-link-subscriptions.ts` (typed query helpers).
- `apps/api/src/projects/projects.service.ts`: extend `syncManifest()` to reconcile grants + subscriptions, with explicit validation errors. Pattern: same as `domain_signup` v2 reconciliation in 2026-05-12 update.
- `apps/api/src/app-links/`: new module with `app-links.service.ts`, `app-links.controller.ts`, REST endpoints `GET /projects/:id/app-links` (list), `POST /projects/:id/app-links/explain`.
- `apps/api/src/app.module.ts`: register the new app-links module.
- `packages/cli/src/commands/app-links.ts`: `list`, `plan`, `explain` (no token mint yet).

**Out of scope (Phase 1)**: token mint, env injection, CLI distribution, event fan-out.

**Verification (Phase 1)**:
- Local scenario `tests/manual/scenarios/40-cross-project-links-grants.md`:
  1. Create producer project, sync manifest with `app_links.exports`.
  2. `eve app-links list --project producer` shows the grant.
  3. Create consumer project in same org, sync manifest with `app_links.consumes`. Sync succeeds, `eve app-links list --project consumer` shows the subscription.
  4. Edit consumer manifest to request a scope the producer hasn't granted — `eve project sync` fails with the exact missing-scope error.
  5. Edit consumer manifest to point at a non-existent producer — sync fails with a "no grant from producer X" error.
  6. Edit producer to revoke the consumer — re-sync producer; `eve app-links explain` on consumer shows `Status: REVOKED` with the timestamp.

### Phase 2 — Token minting + env injection

**Code**:
- `apps/api/src/auth/auth.service.ts`: add `mintAppLinkToken()` + `verifyAppLinkToken()` paired with existing `mintJobToken` / `verifyJobToken`; add the `app_link` branch to `verifyAuthorizationHeader()`.
- `apps/api/src/auth/auth.internal.controller.ts`: add `POST /internal/auth/mint-app-link-token`.
- `apps/api/src/auth/auth.controller.ts` + `packages/shared/src/schemas/auth.ts`: return `service` and `app_link` token types from `/auth/me` and `/auth/token/verify`, with app-link claims.
- `apps/api/src/auth/auth.service.ts`: extend `AuthUser` with `is_app_link_token`, `consumer_project_id`, `producer_project_id`, `producer_env`, `consumer_principal`, and app-link scopes.
- `packages/shared/src/api-client/auth-client.ts`: add `mintAppLinkToken()` helper.
- `packages/shared/src/schemas/job.ts`, `packages/shared/src/schemas/agent-config.ts`, workflow/chat extraction code, and `packages/cli/src/commands/job.ts`: add first-class link references (`hints.app_links`, `with_apis: [{ link }]`, CLI `--with-links` or equivalent).
- `packages/shared/src/app-apis/resolver.ts`: new unified resolver; replace direct callers in `jobs.service.ts` + `workflows.service.ts`.
- `packages/shared/src/schemas/api-source.ts`: extend `buildAppApiEnvVars()` for app-link sources.
- `apps/worker/src/deployer/deployer.service.ts`: at deploy time, for each subscription that matches `inject_into_services`, mint app-link service token (90-day TTL, refreshed each deploy) and inject env vars alongside `EVE_SERVICE_TOKEN`.
- `apps/worker/src/deployer/deployer.service.ts` or a helper beside namespace hardening: reconcile the additive NetworkPolicy required for producer namespace ingress from the consumer namespace when direct Service DNS is used.
- `packages/shared/src/invoke/eve-credentials.ts`: extend to mint per-link app-link tokens at job dispatch (1-hour TTL) and write into harness env.
- `packages/auth/src/unified.ts` + `packages/auth/src/index.ts` (the `@eve-horizon/auth` SDK): handle `type: "service"` and `type: "app_link"`, expose `req.eveAppLink`, and default app-link verification to the remote path for active revocation.

**Verification (Phase 2)**:
- Local scenario `tests/manual/scenarios/41-cross-project-links-tokens.md`:
  1. Producer with a simple API service (`/observations` endpoint returning fixture data, scope-gated via `@RequireScope`).
  2. Consumer with a service that on startup calls `GET ${EVE_APP_LINK_OBSERVATION_API_URL}/observations` with `Authorization: Bearer ${EVE_APP_LINK_OBSERVATION_TOKEN}`.
  3. Deploy producer, then consumer. Consumer logs show successful fetch.
  4. Decode the consumer's token: `aud === "project:<producer>"`, scopes match.
  5. Tamper with `EVE_APP_LINK_OBSERVATION_TOKEN` (replace with consumer's `EVE_SERVICE_TOKEN`) — producer rejects with `aud` mismatch.
  6. Consumer agent job: dispatch a workflow with `with_apis: [{ link: observation }]`; agent gets short-lived (1h) token + URL in env.

### Phase 3 — CLI distribution + agent integration

**Code**:
- `apps/api/src/projects/projects.service.ts`: at producer sync, resolve and store `cli_image`, `cli_name`, `cli_bin_path` on the grant row.
- `packages/shared/src/app-apis/resolver.ts`: include CLI metadata on `ResolvedApi.link_origin`.
- `apps/agent-runtime/src/invoke/k8s-runner.ts`: extend init-container construction for app-link CLIs (same flow as existing `appClis`, with image pulled from producer's registry).
- `packages/shared/src/schemas/api-source.ts` (`buildAppApiInstructionBlock` or its replacement): produce a clear instruction block for cross-project links, e.g. "**observation** (cross-project app link to `observation-platform`): CLI `obs`, URL `$EVE_APP_LINK_OBSERVATION_API_URL`".
- Reject repo-mode CLI in cross-project exports during producer sync with an explicit error pointing to `docs/system/cross-project-app-links.md`.
- New pipeline action `build.cli-image` (optional v1 convenience): packages a repo-bundled CLI into an OCI image for export.

**Verification (Phase 3)**:
- Local scenario `tests/manual/scenarios/42-cross-project-links-cli.md`:
  1. Producer has an image-mode CLI `obs` declared and pushed to the local k3d registry.
  2. Consumer dispatches an agent job referencing the link.
  3. Agent workspace: `which obs` resolves; `obs --help` runs; `obs observations list --json` returns producer data.
  4. Agent uses `obs` to call a scope the consumer doesn't have — producer rejects, CLI prints a clear scope-denied error.
  5. Job description includes the cross-project instruction block.

### Phase 4 — Event subscription fan-out

**Code**:
- `apps/orchestrator/src/events/event-router.service.ts`: add `fanOutAppLinkEvent()` after `matchTriggersForEvent()`.
- `apps/orchestrator/src/events/event-router.service.ts` or a sibling delivery service: process pending `app_link_event_deliveries` with exponential backoff and DLQ-style failure.
- `apps/orchestrator/src/events/trigger-matcher.service.ts`: add `app_link` shorthand trigger.
- `packages/db/src/queries/app-link-event-deliveries.ts`: insert + select helpers.
- `packages/shared/src/schemas/event.ts`: add `app_link` to `EventSourceSchema` and extend trigger evaluation entries for fan-out metadata.
- `apps/api/src/events/events.controller.ts`: include `app_link` source in standard list/show; surface in `triggers_evaluated`.
- `packages/cli/src/commands/app-links.ts`: add `replay` subcommand.
- Coherence rule: reject sync if a consumer subscribes to event types not in the grant's `types` list.

**Verification (Phase 4)**:
- Local scenario `tests/manual/scenarios/43-cross-project-links-events.md`:
  1. Producer service emits `app.observation.created` via `EVE_SERVICE_TOKEN` calling `POST /projects/<producer>/events`.
  2. Consumer has a workflow with `trigger.app_link.alias: observation, type: app.observation.created`.
  3. Event arrives in producer; orchestrator processes; consumer event materialises (visible via `eve event list --project consumer --source app_link`); consumer workflow runs.
  4. `eve event show <producer-event-id>` shows fan-out outcome in `triggers_evaluated`.
  5. Emit duplicate event with same `dedupe_key` — consumer receives only one.
  6. Producer revokes the event grant; emit again — consumer does **not** receive.
  7. `eve app-links replay --subscription <id> --from <prior-event-id>` re-fans the prior events; dedupe prevents duplicates.

---

## Verification loop on local k3d

The scenarios in `tests/manual/scenarios/40-43` use two real apps so the end-to-end signal is unambiguous. Suggested fixture:

```
tests/manual/fixtures/
  producer-app/
    .eve/manifest.yaml           # x-eve.app_links.exports
    apps/api/                    # Express app exposing /observations
    cli/                         # image-mode obs CLI
    Dockerfile
    Dockerfile.cli
  consumer-app/
    .eve/manifest.yaml           # x-eve.app_links.consumes
    apps/api/                    # Express app that calls observation API on startup
    .eve/workflows.yaml          # trigger on app.observation.created
```

The standard k3d loop:

```bash
./bin/eh status                                            # 1. confirm cluster up
./bin/eh k8s deploy                                         # 2. fresh deploy with new code
eve org ensure manual-test-org --slug manual-test-org
eve secrets import --org org_manualtestorg --file manual-tests.secrets

# Producer first
eve project ensure --name producer-app --repo-url <fixture>
eve project sync --project producer-app
eve env deploy producer-app staging --direct

# Consumer second
eve project ensure --name consumer-app --repo-url <fixture>
eve project sync --project consumer-app               # validates against producer grant
eve env deploy consumer-app staging --direct

# Walk scenarios 40 → 41 → 42 → 43
```

Every phase ends with `./bin/eh k8s deploy && eve project sync … && <scenario>` and re-runs from the same baseline, so regressions surface immediately. Each scenario is parallel-safe within the producer/consumer pair.

Each phase also adds an integration test against the Docker-Compose API: `./bin/eh test integration --target <app-links-test-file>` covers the manifest validation, mint/verify, and fan-out paths without requiring a k3d cluster.

---

## Risks and unknowns

1. **Producer CLI image registry credentials**. Image-mode CLI requires the consumer's k3d/cluster to pull from the producer's registry. For local dev this is the local k3d registry (no auth). For staging, both projects today push to `ghcr.io/eve-horizon/*` under shared pull credentials. Mitigation: document the constraint and validate at sync time that the producer's CLI image registry is in the cluster's known-pullable set.

2. **Grant divergence under simultaneous sync**. Producer and consumer can both sync at the same instant from different operators. We resolve via row-level locks on `project_app_link_grants` during sync and a final coherence pass that re-validates the subscription against the freshly-written grant inside the same transaction. If the producer revokes mid-flight, the consumer sync sees the revoked grant and fails — operator re-runs.

3. **Producer that exports many event types to a lazy consumer**. A producer firing 1000 events/second to a consumer that subscribes to all of them is a fan-out amplifier. Mitigation: per-subscription rate cap (default 10/s burst, 1000/min sustained); over-limit events go to `app_link_event_deliveries` with `status: 'skipped'` and a metric. Tighten if needed.

4. **Token aud collision with future audience uses**. We adopt `aud: "project:<id>"` as the canonical project-audience format. If we ever introduce service-level or env-level audiences, they should be `service:<id>` / `env:<id>` to keep the prefix scheme open.

5. **Producer manifest revoke breaks consumer service at next mint**. Long-lived service-surface tokens (90-day deploy refresh) remain signed until they expire or the consumer redeploys. Mitigation: producer verification consults the grant/subscription table and rejects revoked subscription IDs immediately. For apps using `@eve-horizon/auth`, that means app-link verification must use the remote/introspection path by default; local JWKS-only verification cannot provide immediate revocation.

6. **`with_apis` semantics for cross-project**. Today `with_apis: [{ service: api }]` references same-project services. We extend with `with_apis: [{ link: observation }]` for explicit cross-project requests; default auto-discovery on a job includes all subscriptions with `inject_into_jobs: true`. The instruction block makes it obvious which APIs are local vs cross-project.

7. **Same-org constraint**. Enforcing same-org in v1 keeps billing, quotas, and consent simple. Cross-org links are a deliberate non-goal — when we add them, the producer must explicitly opt into `cross_org: true` per consumer, with an approval flow that lives in a future plan.

8. **Namespace hardening blocks direct service DNS**. The default NetworkPolicy only allows same-namespace ingress plus configured namespaces. Mitigation: Phase 2 must either reconcile additive app-link NetworkPolicies or resolve app-link URLs through an allowed ingress path. The implementation should fail `eve app-links explain` with a connectivity reason if neither route is available.

---

## Documentation impact

When this ships, update **before tagging the release**:

- `eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` — add `x-eve.app_links.{exports,consumes}` schema and examples.
- `eve-skillpacks/.../references/secrets-auth.md` — document `type: "app_link"` token, `aud` semantics, env var contract.
- `eve-skillpacks/.../references/events.md` — document `source: app_link`, `trigger.app_link.*`, dedupe semantics.
- `eve-skillpacks/.../references/cli.md` — document `eve app-links {list,plan,explain,replay}`.
- `eve-skillpacks/.../references/app-cli.md` — cross-project CLI distribution constraint (image-mode required), instruction block additions.
- `eve-skillpacks/.../references/pipelines-workflows.md` — `with_apis: [{ link: <alias> }]` syntax.
- New `docs/system/cross-project-app-links.md` covering the full mental model, link state machine (proposed → active → revoked), and operator playbook.
- New `tests/manual/scenarios/40-cross-project-links-grants.md`, `41-cross-project-links-tokens.md`, `42-cross-project-links-cli.md`, and `43-cross-project-links-events.md` with the four phase verification scripts.

---

## Open questions

1. Should job-surface `consumer_principal` use `job:<job_id>`, `agent:<slug>`, or both? Current plan includes `consumer_principal` and should also include `agent_slug` when known, but the exact audit shape needs final schema naming.

2. Should the platform offer a managed event mirror in addition to push fan-out — i.e., the consumer's event router *pulls* from the producer's event stream by subscription, like a Kafka consumer group? Push is simpler and matches existing trigger model; pull would let consumers replay arbitrary windows without an explicit replay command. Lean: stick with push for v1.

3. CLI image build convenience action (`build.cli-image`) — ship in v1 or v2? Producers can hand-roll today; an in-platform builder shrinks the cliff. Lean: v1 with a minimal implementation that takes the existing `cli/bin/<name>` artifact and produces a `busybox:stable`-based image.

4. Do we need a per-link **chain of trust** signature beyond JWT signature (e.g., the producer signs the grant payload)? Not in v1 — the grant lives in our DB, the platform is the trust root. If we ever federate Eve instances, signed grants become important.
