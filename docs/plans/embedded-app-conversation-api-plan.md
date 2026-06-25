# Embedded App Agent Conversation API & SDK

> Status: Draft, reviewed 2026-05-05
> Created: 2026-05-05
> Reporter: Codex (gap report) / TiGz (plan)
> Purpose: Give Eve-hosted web apps a first-class, browser-native conversation surface backed by Eve threads, chat routing, and the agent runtime — without forcing every app to recreate auth, dispatch, streaming, reconnect, and product-metadata mapping by hand.

## Problem Statement

Eve already has the substrate for embedded app chat — threads, project chat routes, thread continuation, the gateway `api`/`webchat` providers, JWKS, and SSE message streams. What it does **not** have is a coherent, first-class **embedded app conversation API and client SDK** that those primitives compose into. Today an app team that wants a conversation pane in their UI has to:

1. Implement browser auth and call the chat REST routes themselves.
2. Decide between `webchat` (real-time push, but with insecure JWT decode) and `api` (no push, polling).
3. Hand-roll thread mapping from product objects (e.g. `open-design:{project_id}:{conversation_id}`) onto Eve `thread_key`s.
4. Build their own SSE bridge / reconnect logic / optimistic-send UX in the browser.
5. Maintain a parallel app-owned `conversations`/`messages`/`runs` model "just in case" Eve threads are not enough.

The Open Design port planning that motivated this work explicitly does (5) for exactly that reason. That is platform debt being paid by every app, and a sign the platform is missing a first-class capability — see CLAUDE.md "Platform Gaps First — Never Work Around Them".

The most concrete blocker is `apps/gateway/src/providers/webchat/webchat.provider.ts:25`: `verifyJwt()` decodes the JWT payload without verifying its signature. We cannot recommend `webchat` for production embedded apps until this is replaced with cryptographic verification against Eve's JWKS.

## Goals

- Provide a single, documented, **first-class embedded conversation API** that backend-proxied browser apps and direct-from-browser apps can both target.
- Verify browser tokens cryptographically through `@eve-horizon/auth` JWKS verification, never by payload decode.
- Let an app **find-or-create a durable Eve thread** keyed by an app-supplied identifier, attach product metadata, and route to an agent / team / workflow / chat.yaml route using the same primitives as external gateways.
- Return thread ID, job IDs, target metadata, and dispatch status so apps can correlate UI state to Eve work.
- Expose a replayable SSE stream for thread messages and progress. Phase 1 supports browser reloads via snapshots and polling catch-up; Phase 4 adds true `Last-Event-ID` resume.
- Ship `@eve-horizon/chat` and `@eve-horizon/chat-react` so apps can compose with `@eve-horizon/auth-react` and get a working conversation pane in <50 lines of UI code.
- Verify each phase against the local k3d stack with a manual scenario before moving on.

## Non-Goals

- Replacing app-owned product projections. Apps that need richer per-conversation state (artifacts, run summaries, attachments) keep their own model and reference the Eve `thread_id`. The plan does **not** force apps to give up their own DB.
- Real-time push for the `api` provider beyond what SSE on `/threads/:id/stream` already gives. The push-vs-poll story is "use SSE for push, fall back to polling `GET /threads/:id/messages?since=` if SSE is not available".
- Dashboards for app-originated threads. The "Could" item is deferred until Phase 3 lands.
- Slack/Nostr changes. Embedded app chat is its own provider identity, not a fix for the Slack provider.

## Current State (the substrate we are composing)

| Primitive | Lives in | What it gives us |
| --- | --- | --- |
| `POST /projects/:project_id/chat/route` | `apps/api/src/chat/chat.controller.ts:24` | Project-scoped routing through `chat.yaml`/agent/team — RBAC `chat:write` |
| `POST /threads/:thread_id/chat` | `apps/api/src/threads/threads.controller.ts:122` | Continue an existing Eve thread by `thr_*` ID, preserving the original dispatch target |
| `GET /threads/:thread_id/stream` | `apps/api/src/threads/threads.controller.ts:78` | SSE stream of snapshot + new messages + heartbeats |
| `GET /threads/:thread_id/messages?since=&limit=` | `apps/api/src/threads/threads.controller.ts:96` | Polling fallback / catch-up |
| `ThreadsService.ensureThread(projectId, key, channel)` | `apps/api/src/threads/threads.service.ts:38` | Find-or-create by app-supplied key — already idempotent |
| `api` gateway provider (no-op delivery) | `docs/plans/api-chat-provider-plan.md` | Lets `provider: "api"` chat routing succeed without a connected client |
| `webchat` gateway provider (WebSocket push) | `apps/gateway/src/providers/webchat/webchat.provider.ts` | Real-time browser push — but JWT verification is currently insecure |
| `verifyEveToken()` (JWKS) | `packages/auth/src/index.ts:160` | Cryptographic Eve token verification against `/.well-known/jwks.json` |
| `EveAuthProvider` / `useEveAuth` | `packages/auth-react/src/` | Browser auth flow + token storage |

### What is missing

1. **A first-party embedded provider identity.** `provider: "api"` works but is generic; `provider: "webchat"` is gateway-shaped (separate WebSocket port, integration row) and overkill for a same-origin React app whose backend already proxies chat.
2. **Cryptographic browser-token verification on the WebChat provider.** `webchat.provider.ts:verifyJwt` decodes only.
3. **A documented "embedded app" entry point** that says: "find-or-create a thread by app key, route to a target, return ids". Today the closest thing is `chat/route` plus `ThreadsService.ensureThread`, but nothing surfaces them as one capability.
4. **A browser SDK.** Apps must hand-roll fetch/SSE/reconnect logic.
5. **A server-side helper** for the recommended same-origin proxy pattern (so apps can enrich/reject turns before dispatch). `@eve-horizon/auth` currently provides Express middleware and documented NestJS guard wrappers, but there is no `@eve-horizon/auth/nest` package/subpath today.

## Design Overview

### Two supported integration shapes

The platform must support two shapes; they share the same API and SDK and differ only in where the Eve token lives.

**Shape A — Backend-proxied (recommended default).** The app backend holds an Eve user/job/service-principal token, terminates browser auth its own way (cookie session or `@eve-horizon/auth-react`), enriches/validates the turn, then calls Eve `POST /projects/:project_id/conversations/:app_key/turns`. The browser only ever talks to the app backend. App service tokens must explicitly declare `chat:write` in `x-eve.permissions`; the default deployed-service token is read-only.

**Shape B — Direct-from-browser.** An SPA holds an Eve user token (issued by `@eve-horizon/auth-react`) and calls the same Eve API directly with `Authorization: Bearer <user_token>`. Useful for thin internal tools and dashboards. Streaming must use fetch-based SSE when bearer auth is required, because native browser `EventSource` cannot set an `Authorization` header.

In both shapes, the **conversation continuity is the Eve thread**. The app may keep its own product projection and reference `thread_id`, but Eve owns context, history, and dispatch.

### The new HTTP surface (thin facade over existing primitives)

We introduce `conversations` as a project-scoped, app-friendly facade. Internally it is a thin layer on top of `ChatService.routeMessage` / `ChatService.continueThread` / `ThreadsService.ensureThread` / SSE streaming — no new dispatch logic.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/projects/:project_id/conversations` | Find-or-create a thread by `app_key`, attach metadata, optionally seed an opening turn |
| `GET` | `/projects/:project_id/conversations/:app_key` | Resolve an app key to its Eve thread (thread id, metadata, last message, current target) |
| `POST` | `/projects/:project_id/conversations/:app_key/turns` | Append a user turn and route — returns thread_id, job_ids, target |
| `GET` | `/projects/:project_id/conversations/:app_key/stream` | SSE stream (snapshot + new messages + progress + heartbeats); Phase 4 adds `Last-Event-ID` resume |
| `GET` | `/projects/:project_id/conversations/:app_key/messages?since=&limit=` | Polling catch-up (already exists on threads, mirrored here for app-key addressing) |

Notes:

- `app_key` is the app-supplied identifier (e.g. `open-design:proj_xyz:conv_abc`). Path parameters must be URL-encoded by clients. The facade canonicalises it to a collision-safe thread key: `app:{app_id}:sha256:{base64url(sha256(app_key))}`. Store the raw `app_key`, `app_id`, and product metadata in `threads.metadata_json` so the key remains stable even when app keys include `/`, `:`, or long opaque IDs.
- The first turn determines the dispatch target. `ConversationTurnRequest.target` supports `{ kind: "route", route_id?: string }`, `{ kind: "agent", agent_slug: string }`, and `{ kind: "team", team_id: string }`; if omitted, the facade uses normal `chat.yaml` route matching. Subsequent turns reuse the continuation metadata stored on the thread (already implemented by `chat-thread-continuity-plan.md`).
- The endpoints map 1:1 to existing services; the controller is small. We deliberately do **not** introduce a new database table — the substrate is already there.
- All endpoints require `chat:write` for write paths and `threads:read` for read/stream paths, evaluated against the project. Both user tokens and job/service tokens work when they carry the effective permission; project member user tokens do not currently include `chat:write` by default.

### Provider identity for embedded apps: `app`

Today `provider` is a free-form string. We adopt and document the convention `provider: "app"` for embedded conversations originated by an Eve-hosted app. `account_id` is the project slug (or `app_id` if the same app spans multiple projects). This:

- Is distinct from `webchat` (gateway WebSocket) and from generic `api` (REST clients).
- Lets `chat.yaml` write rules that match `provider: app`. Current `ChatService.matchRoute()` only matches the message text, so Phase 1 must add provider-aware route predicates before documenting provider-based rules as shipped behavior.
- Reuses the `api` gateway provider's no-op delivery — no new gateway plumbing needed for Shape A.
- `webchat` remains available for apps that want a direct WebSocket from the browser to the gateway, once token verification is fixed.

### Browser SDK: `@eve-horizon/chat` and `@eve-horizon/chat-react`

`@eve-horizon/chat` is a transport-agnostic ESM client:

```ts
import { createConversationClient } from '@eve-horizon/chat';

const conv = createConversationClient({
  baseUrl: '/api/eve',                    // Shape A: same-origin proxy
  // baseUrl: 'https://api.eve.example.com',  // Shape B: direct
  getToken: async () => session.token,
  projectId: 'proj_opendesign',
  appKey: `open-design:${projectId}:${conversationId}`,
});

await conv.ensure({ metadata: { product_route: '/projects/X' } });
const { jobIds } = await conv.send('Add a navbar with auth dropdown');

for await (const event of conv.stream({ resumeFrom: lastEventId })) {
  // event.kind === 'message' | 'progress' | 'snapshot' | 'heartbeat'
}
```

`@eve-horizon/chat-react` provides `<EveConversation>` and `useEveConversation()` that compose with `EveAuthProvider`/`useEveAuth`. The Phase 4 SDK keeps Phase 1's facade as the only API surface, which gives us room to evolve transports (SSE → WebSocket) without breaking apps.

The browser SDK uses fetch-based SSE by default when `getToken` returns a bearer token, because fetch can send `Authorization` and `Last-Event-ID` headers. Native `EventSource` is only safe for same-origin cookie-authenticated proxies. Reconnect uses `Last-Event-ID` after Phase 4; before then the SDK falls back to polling catch-up via `GET .../messages?since=`.

### Server proxy helper (Shape A)

`@eve-horizon/auth` already gives apps token verification primitives and Express middleware; NestJS apps wrap those in a thin guard today. We add `EveConversationsClient` under `@eve-horizon/chat/server` that:

- Forwards `POST /turns` from the app backend to Eve, swapping the browser/session token for the app's Eve token if the app prefers proxying with a service principal.
- Exposes `enrichTurn(req)` hooks so apps can apply product RBAC, prompt enrichment, or hard rejection before dispatch.

This is **not** a framework — it is a 100-line helper that documents the pattern. Apps can also call Eve's HTTP API directly; the helper is opt-in.

## Phased Plan

Each phase ends with a **manual k3d verification loop** that runs against the local k3d stack (`./bin/eh status` must show k3d running and you must be the `k8s_owner`, per CLAUDE.md). The manual scenario is added under `tests/manual/scenarios/` and re-runnable.

### Phase 0 — Cryptographic JWT verification on `webchat`

**Why first:** the gap report calls this out explicitly, and we cannot recommend any embedded provider for production until WebChat is no longer decoding JWTs. This phase is independent of the new conversations facade and unblocks (a) WebChat-using apps today and (b) Shape B direct-from-browser later.

**Changes**

| File | Change |
| --- | --- |
| `apps/gateway/src/providers/webchat/webchat.provider.ts` | Replace `verifyJwt` with `verifyEveToken()` from `@eve-horizon/auth` (JWKS, RS256, exp/nbf) |
| `apps/gateway/package.json` | Add `@eve-horizon/auth` as a workspace dependency so gateway builds can import the verifier |
| `apps/gateway/src/providers/webchat/webchat.provider.ts` | Resolve the Eve API URL from `ProviderConfig.settings.eve_api_url` or `process.env.EVE_API_URL` so the gateway pod can fetch JWKS |
| `apps/gateway/src/providers/provider-registry.ts` | If using provider settings, merge `settings_json` for webchat instead of only `tokens_json`; today only Slack gets a special settings merge |
| `apps/gateway/src/providers/webchat/webchat.provider.ts` | Close socket with explicit reasons on token expiry / kid mismatch / signature failure |
| `apps/gateway/src/providers/webchat/webchat.provider.spec.ts` | New unit tests: valid RS256 token accepted; expired token rejected; HS256 rejected; tampered signature rejected |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/gateways.md` | Replace "v1 JWT verification only decodes the payload" wording with cryptographic-verification spec |

**Verification (k3d)**

Add `tests/manual/scenarios/35-embedded-conversation-webchat-jwt.md` (35 is the next free scenario number in this repo as of 2026-05-05):

1. `./bin/eh status` — confirm k3d running and you own the cluster.
2. `./bin/eh k8s deploy` to roll the gateway image with the change.
3. Mint a real Eve user token via `eve auth token --raw`; open a WebSocket to `ws://gateway.eve.lvh.me/?token=$TOKEN`; expect `{"type":"connected"}`.
4. Mutate the signature byte and reconnect; expect close code `4001` and no connection ack.
5. Issue a forged HS256 token with the same payload; expect close code `4001`.
6. Wait past `exp`; reconnect; expect close code `4001` with reason `token_expired`.
7. Tail gateway logs and confirm `webchat.token_invalid` events show signature failure / expiry rather than "decoded fine".

### Phase 1 — Conversations facade endpoints

**Why next:** ships the embedded app capability without any new gateway plumbing. Backend-proxied apps (Shape A) can adopt this immediately by calling Eve from their NestJS backend.

**Changes**

| File | Change |
| --- | --- |
| `packages/shared/src/schemas/agent-primitives.ts` | New Zod schemas: `EnsureConversationRequest`, `ConversationResponse`, `ConversationTurnRequest`, `ConversationTurnResponse` (re-uses `ChatHints`) |
| `packages/shared/src/schemas/agent-config.ts` | Add optional route predicates such as `providers?: string[]` and `account_ids?: string[]` so `chat.yaml` can distinguish `provider: "app"` from Slack/Nostr/webchat |
| `apps/api/src/conversations/conversations.controller.ts` | New controller mounted on `/projects/:project_id/conversations` with `RequirePermission('chat:write')` on writes and `RequirePermission('threads:read')` on reads |
| `apps/api/src/conversations/conversations.service.ts` | Thin facade: canonicalises `app_key` → thread key, calls `ThreadsService.ensureThread`, persists/merges `metadata_json` (provider/app_id/product hints), delegates dispatch to `ChatService.routeMessage`, `routeMessageToAgent`, `routeMessageToTeam`, or `continueThread` |
| `apps/api/src/conversations/conversations.service.ts` | Validate explicit targets: route IDs must exist and preserve route permissions; agent/team targets must reuse or extract the gateway-policy checks from `ChatGatewayController` so direct embedded targets do not bypass routability rules |
| `apps/api/src/conversations/conversations.module.ts` | Wire into `AppModule`; reuse `ChatModule`, `ThreadsModule` |
| `apps/api/src/app.module.ts` | Import `ConversationsModule` |
| `apps/api/src/threads/threads.module.ts` | Export `ThreadsService`; today it is a provider but not exported, so a separate `ConversationsModule` cannot inject it by importing `ThreadsModule` alone |
| `apps/api/src/threads/threads.service.ts` | Persist and merge `metadata_json` on `ensureThread` (currently passed as `null`) so app product metadata round-trips without clobbering continuation/harness metadata |
| `apps/api/src/chat/chat.service.ts` | Change `RouteEntry`/`matchRoute()` to evaluate text plus provider/account context; add tests proving provider predicates do not shadow text default routes |
| `apps/api/test/integration/conversations.integration.test.ts` | Integration test covering ensure → explicit target first turn → continuation → metadata round-trip → message replay |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/agents-teams.md` | Add "Embedded app conversations" section with the 5 endpoints, the `provider: "app"` convention, permission requirements, and Shape A/B decision matrix |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/gateways.md` | Cross-link to the new section; clarify when to use `app` vs `webchat` vs `api` |

**Auth & RBAC**

- `POST /conversations`, `POST /conversations/:app_key/turns` → `chat:write` on the project.
- `GET /conversations/:app_key`, `GET .../stream`, `GET .../messages` → `threads:read` on the project.
- Both user tokens and job/service tokens accepted when they carry the required permissions, matching the permission guard and `requireThreadAccess` project check in `threads.controller.ts`.
- Shape A app service tokens must declare `x-eve.permissions: ["chat:write"]` in addition to the default read-only service permissions.

**Verification (k3d)**

Add `tests/manual/scenarios/36-embedded-conversation-facade.md`:

1. `./bin/eh status`; `eve org ensure manual-test-org --slug manual-test-org`.
2. Sync agents from `../eve-horizon-fullstack-example`; pick one whose YAML gateway policy is `routable`.
3. `curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST $EVE_API_URL/projects/$PROJECT/conversations -d '{"app_key":"manual:conv-1","app_id":"manual-app","metadata":{"product_route":"/x"}}'` → expect `thread_id`, a canonical `key` prefixed with `app:manual-app:sha256:`, and metadata containing the raw `app_key`.
4. `POST /conversations/manual%3Aconv-1/turns` with `{"text":"hello","target":{"kind":"agent","agent_slug":"od-designer"}}` → expect `thread_id` echo, `job_ids[]`, and `target.kind=agent`.
5. Open SSE on `GET /conversations/manual%3Aconv-1/stream` with a bearer-capable fetch client; observe snapshot then live append after agent reply lands.
6. Reload (close/reopen SSE); expect snapshot includes prior messages — proves browser-reload resumability.
7. Try to continue from a different project's user token; expect `403`.
8. Confirm `GET /projects/$PROJECT/conversations/manual%3Aconv-1` returns the same app metadata you wrote. Do not rely on `eve thread show`; the current CLI thread response does not expose `metadata_json`.

### Phase 2 — Browser SDK (`@eve-horizon/chat`)

**Why next:** with Phase 1 the wire format is stable. The SDK formalises retries, SSE handling, and metadata mapping so apps stop hand-rolling.

**Changes**

| File | Change |
| --- | --- |
| `packages/chat/package.json` + `src/` | New transport-agnostic ESM package: `createConversationClient`, `ensure`, `send`, `stream`, `messages` |
| `packages/chat/src/sse.ts` | Fetch-based SSE parser that sends `Authorization` and, after Phase 4, `Last-Event-ID`; native `EventSource` is an opt-in cookie-auth path only |
| `packages/chat/src/types.ts` | Re-exports the Zod-derived types from `@eve/shared` so apps get full typing |
| `packages/chat/test/` | Vitest tests against mocked `fetch` streams, reconnect, abort, and polling fallback |
| `packages/chat/README.md` | Quick-start; both Shape A (proxy) and Shape B (direct) examples |
| `.github/workflows/publish-chat.yml` | New workflow gated on `chat-v*` tags, mirroring `publish-sdk.yml` |
| `CLAUDE.md` | Bump under "What exists" / add "@eve-horizon/chat publish" sub-section |

**Verification (k3d)**

Run the SDK against the same k3d stack as Phase 1 from a Node script:

1. `pnpm --filter @eve-horizon/chat build`; create a tiny script under `tests/manual/scripts/embedded-conversation-sdk.ts` that imports the locally-built SDK.
2. Point `baseUrl` at `http://api.eve.lvh.me`; pass an `eve auth token` value as `getToken`.
3. Call `conv.ensure(...)`, `conv.send('hi')`, `for await (const ev of conv.stream())` and assert events arrive in order, including across a forced reconnect (`AbortController`).
4. Repeat from a Vite dev server in `../eve-horizon-fullstack-example` inside Chrome to verify it works in a real browser without polyfills.
5. Document this as the "SDK smoke" section of `tests/manual/scenarios/36-embedded-conversation-facade.md`.

### Phase 3 — `@eve-horizon/chat-react` and a reference UI

**Why next:** apps will not adopt this unless the UI surface is trivial. The React package is the proof.

**Changes**

| File | Change |
| --- | --- |
| `packages/chat-react/` | `EveConversationProvider`, `useEveConversation`, `<EveConversationPane>` (headless), `<EveConversationDefaultPane>` (styled minimal UI) |
| `packages/chat-react/README.md` | <50-line embed example composing with `EveAuthProvider` |
| `../eve-horizon-fullstack-example` (sister repo) | Add a "Chat with Designer" page that mounts `<EveConversationDefaultPane projectId="proj_xxx" appKey="example-conv-1" />` |

**Verification (k3d)**

1. Deploy the example app to k3d via `eve env deploy` against the manual-test org.
2. Open `http://web.exapp-test.lvh.me/chat` and sign in via Eve SSO.
3. Send three turns; observe progress messages stream into the UI; reload the page mid-stream and confirm history persists; sign out and back in with a different user and confirm RBAC denies access to the original conversation when scoped to a different project.
4. Add this scenario as `37-embedded-conversation-react-pane.md`.

### Phase 4 — Resumable SSE (`Last-Event-ID`) and progress events

**Why last:** Phase 1 SSE works for connect-time snapshots and live appends, but does not formally support resume across a process restart. This phase upgrades the existing stream rather than adding a new one.

**Changes**

| File | Change |
| --- | --- |
| `packages/db/migrations/<next>_thread_message_kind.sql` | Add message kind/progress metadata so progress frames are distinguishable without parsing message text; recommendation: `kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'progress'))` |
| `packages/db/src/queries/threads.ts` | Add `listAfterMessageId(threadId, messageId)` or equivalent id-based replay; timestamp-only `created_at > since` can miss messages that share a timestamp |
| `packages/shared/src/schemas/agent-primitives.ts` | Add `kind?: "message" \| "progress"` (or metadata equivalent) to `ThreadMessageResponseSchema` and conversation stream events |
| `apps/api/src/threads/threads.service.ts` | Emit `id:` lines on each message/progress frame keyed off `thread_messages.id`; honour `Last-Event-ID` request header by replaying messages strictly after that id |
| `apps/api/src/threads/threads.controller.ts` | Extract `Last-Event-ID` from the request headers and forward to `streamMessages` |
| `apps/api/src/conversations/conversations.controller.ts` | Same wiring for the conversations facade |
| `apps/api/src/chat/chat.service.ts` | Persist progress deliveries with the progress kind and originating job id; today `deliverChatResult(progress: true)` stores an outbound message but drops `job_id` |
| `packages/shared/src/invoke/eve-message-relay.ts` | Include `job_id` when POSTing progress to `/internal/projects/:project_id/chat/deliver`; this is the actual relay path, not `apps/agent-runtime/src/relay/...` |
| `packages/chat/src/sse.ts` | Track and re-send `Last-Event-ID` on reconnect |

**Verification (k3d)**

1. Open `conv.stream()` from Phase 2's smoke script.
2. Run a long-running agent job (use a `pnpm sleep`-style harness profile or a workflow agent).
3. Kill the SSE connection (`AbortController`) mid-stream; capture the last seen `eventId`.
4. Reconnect with `resumeFrom: lastEventId`; assert no message is delivered twice and no message is missed.
5. Restart the API pod (`kubectl -n eve rollout restart deploy/eve-api`); reconnect; assert the same property holds.
6. Document as `38-embedded-conversation-sse-resume.md`.

## Acceptance Criteria

Mapped from the gap report:

| Criterion | Phase | How verified |
| --- | --- | --- |
| Open Design routes a signed-in browser conversation to `od-designer` via Eve thread/chat APIs without opening a direct gateway WebSocket or creating a fake external integration | Phase 1, 2, 3 | Scenarios 36 + 37 against k3d |
| A browser reload resumes the same Eve thread stream and correlates messages to the created job IDs | Phase 1 (snapshot replay), Phase 4 (true resume) | Scenario 36 step 6, scenario 38 |
| App backend can enrich or reject a turn before dispatch without bypassing Eve thread continuity | Phase 1 (Shape A pattern) | Scenario 36: backend-proxied turn that rejects with 422 still records nothing on the thread; accepted turn produces `job_ids` |
| WebChat token verification is cryptographic before WebChat is recommended for production | Phase 0 | Scenario 35 |

Additional internal acceptance:

- `@eve-horizon/chat` and `@eve-horizon/chat-react` are published to npm under the existing release workflow.
- `eve-read-eve-docs` references include "Embedded app conversations" section with the 5 endpoints, the `provider: "app"` convention, both shapes, and a Shape A / Shape B decision matrix.
- `pnpm test` and `./bin/eh test integration` are green after each phase.

## Open Questions / Decisions to Confirm

1. **Should service tokens get `chat:write` by default?** Recommendation: no. Keep deployed-service defaults read-only and require apps to opt in via `x-eve.permissions`.
2. **Do we expose `provider: "app"` in `chat.yaml` route matching?** Recommendation: yes; Phase 1 should add route predicates and tests before public docs claim provider matching.
3. **Should Phase 2 also publish a Vue/Svelte client?** No — keep scope React-only until at least one app uses it.
4. **Backend proxy helper as a new package or part of `@eve-horizon/chat`?** Use `@eve-horizon/chat/server` subpath export to avoid package sprawl.
5. **Publish tags for chat packages.** Recommendation: use `chat-v*` for `@eve-horizon/chat` + `@eve-horizon/chat-react` lockstep versions, mirroring the auth SDK workflow without coupling auth and chat releases.

## Risks

- **Scope creep into a generic "Eve chat SDK".** Mitigation: keep the facade strictly thread-backed; do not introduce new persistence or new RBAC primitives.
- **JWKS verification adds latency on the WebChat handshake.** Mitigation: `verifyEveToken` already caches JWKS for 15 minutes (`packages/auth/src/index.ts:88`); only the first connection per gateway pod pays the fetch.
- **Native `EventSource` cannot authenticate direct browser calls with bearer tokens.** Mitigation: SDK defaults to fetch-based SSE for token auth and only uses native `EventSource` for cookie-authenticated same-origin proxies.
- **Provider-aware route docs could outrun implementation.** Mitigation: ship route predicates in Phase 1 before adding provider-matching language to the public docs.
- **SSE reconnect semantics drift between providers.** Mitigation: Phase 4 standardises `Last-Event-ID` on the threads stream — the only stream the SDK consumes.
- **Apps continue to keep parallel `conversations`/`messages` tables.** Mitigation: that is allowed (and sometimes correct), but the platform makes it unnecessary for the MVP UI; the Open Design plan should be updated once Phase 1 ships.

## References

- Gap report: this plan's preamble.
- Open Design port planning (external consumer driving this; not present in this repository as of review).
- `apps/gateway/src/providers/webchat/webchat.provider.ts:25` (insecure JWT).
- `apps/api/src/chat/chat.controller.ts`, `apps/api/src/threads/threads.controller.ts`, `apps/api/src/threads/threads.service.ts`.
- `packages/auth/src/index.ts:160` (`verifyEveToken`).
- `docs/plans/chat-thread-continuity-plan.md` (gives us `POST /threads/:id/chat`).
- `docs/plans/api-chat-provider-plan.md` (gives us the no-op `api` provider).
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/agents-teams.md`, `references/gateways.md` (must be updated per CLAUDE.md skillpack sync obligation).
