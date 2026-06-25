# Auth Token Sync Refactor

Status: `In Progress`

## Context

Eve agents run in ephemeral pods and need OAuth tokens for Claude (Anthropic) and Codex/Code (OpenAI) harnesses. Today, `eve auth sync` extracts local tokens and stores them in Eve secrets. The worker/agent runtime then writes them to disk before harness execution.

## Problems

1. **Codex tokens are short-lived**. The codex/code CLI refreshes from `auth.json`, but refreshed credentials are lost when the pod exits. Jobs can repeatedly re-refresh and may fail if refresh tokens age out.
2. **Claude short-lived OAuth tokens expire quickly** (~15h). `claude setup-token` generates year-long tokens, but `eve auth sync` currently does not separate these token classes.
3. **`eve auth sync` historically picked the first-found Codex auth file**. A freshness helper (`pickFreshestCodeAuth`) now exists and is in use, but lifecycle behavior still needs to be completed end-to-end.
4. **Low visibility into token health**. Users learn about expiry only after job failures.

## Behavioral assumptions used by this plan

- OpenAI refresh tokens are managed by the CLI refresh flow; the platform should not own token-exchange logic.
- `sk-ant-oat01-*` tokens are treated as long-lived Claude setup-tokens and should be preferred.
- Concurrent Codex refresh attempts can occur; write-back should be optimistic/last-write-wins and tolerate races.
- The codex/code CLI can successfully refresh when provided a valid `auth.json`.
- Write-back failure must not fail the job; log at warn level and continue.

## Current State

The following items are **already implemented**:

- `pickFreshestCodeAuth()` in `packages/cli/src/commands/auth.ts` — reads both `~/.codex/auth.json` and `~/.code/auth.json`, selects by `tokens.expires_at`.
- `--dry-run` flag on `eve auth sync` — reports what would be set without writing secrets.
- `eve auth creds` — shows Claude expiry from `claudeAiOauth.expiresAt` when present.
- Worker `resolveCodeAuth()` — decodes `CODEX_AUTH_JSON_B64` and writes `auth.json` to both `~/.code/auth.json` and `~/.codex/auth.json` before harness execution.

The following items are **not yet implemented** and are the subject of this plan.

## Design

### Strategy by harness

#### Claude / mclaude

- Prefer long-lived setup-tokens.
- Detect token type at sync time by checking the extracted token string:
  - Long-lived: token starts with `sk-ant-oat01-` (setup-token prefix)
  - Short-lived: any other value (standard OAuth access token)
- Emit clear non-blocking guidance for short-lived OAuth tokens during `eve auth sync`:
  - `⚠ Found short-lived Claude OAuth token (expires in ~15h).`
  - `For reliable agent execution, generate a long-lived token: claude setup-token`
  - `Then re-run: eve auth sync`
- Do not implement platform-side Claude refresh logic.

#### Codex / Code

- Sync full `auth.json` through `CODEX_AUTH_JSON_B64`.
- Keep worker and agent-runtime flows aligned.
- After harness completes, read back written `auth.json` file(s) from disk.
- If content changed (byte-for-byte string comparison), persist updated credentials through an internal secret write endpoint.
- Write-back failure is non-fatal; log at `warn` level, do not mask harness result.

## Changes

### 1) CLI token intelligence

**File:** `packages/cli/src/commands/auth.ts`

**Already done:** `pickFreshestCodeAuth()`, `--dry-run`, Claude expiry in `eve auth creds`.

**Still needed:**

1. In the `sync` case: after extracting `CLAUDE_CODE_OAUTH_TOKEN`, check its prefix. If it does **not** start with `sk-ant-oat01-`, emit the short-lived warning to stderr (even when `--json` is set, include it in the JSON output as a `warnings` field).
2. In the `creds` case:
   - Claude: show token type field (`setup-token` vs `oauth`) based on the `sk-ant-oat01-` prefix. Currently only `expiresAt` is shown.
   - Codex: surface `expiresAt` from `pickFreshestCodeAuth()` result (`freshest.expiresAt`). The value is already available but not rendered in the table output.
3. `help.ts`: update `eve auth sync` / `eve auth creds` help text to mention token-class behavior.

**Note on setup-token storage:** `claude setup-token` produces a long-lived token stored in the same credential locations as OAuth (keychain / `~/.claude/.credentials.json`), but the token string has the `sk-ant-oat01-` prefix. No separate file path needed — detection is purely by prefix.

### 2) Worker codex token write-back

**File:** `apps/worker/src/invoke/invoke.service.ts`

The worker already writes `auth.json` to both `~/.code/auth.json` and `~/.codex/auth.json` (unless a `configDir` override is in play). After harness execution, the write-back must:

1. Capture the original `CODEX_AUTH_JSON_B64` value from `resolvedSecrets` before execution (retain the winning `SecretResolveItem` including its scope: type + id).
2. After harness completion (success or failure), read back:
   - If `configDir` was specified: read `{configDir}/auth.json`
   - Otherwise: read both `~/.code/auth.json` and `~/.codex/auth.json` and pick the one with the fresher `tokens.expires_at` (re-use the same logic as `pickFreshestCodeAuth`).
3. Base64-encode the post-run content. Compare to the captured original (simple `===` string comparison).
4. If different, call `updateSecret(scope.type, scope.id, 'CODEX_AUTH_JSON_B64', newB64)` (see Change 4).
5. Wrap in try/catch; on error log `warn` and continue — do not propagate.

**Scope resolution:** `resolvedSecrets` is a list of `SecretResolveItem[]`. When searching for `CODEX_AUTH_JSON_B64`, find the first item where `item.key === 'CODEX_AUTH_JSON_B64'` and record `{ type: item.scope_type, id: item.scope_id }`.

### 3) Internal endpoint for secret write-back

**File:** `apps/api/src/secrets/secrets.controller.ts`

Add a new `InternalSecretsController` authenticated via `EVE_INTERNAL_API_KEY` (the `x-eve-internal-token` header). This is required because the job invocation token does not have `secrets:write` permission on org/project/user scopes.

```http
PATCH /internal/secrets/:scope_type/:scope_id/:key
Headers: x-eve-internal-token: <EVE_INTERNAL_API_KEY>
Body: { "value": "string" }
```

- `scope_type`: one of `user`, `org`, `project`
- Route is internal-only (use an `InternalAuthGuard` that checks `x-eve-internal-token === EVE_INTERNAL_API_KEY`).
- Implementation: thin wrapper over the existing `SecretsService.update()`.
- The key in the URL should be URL-encoded if it contains special characters.
- Return 204 on success, 404 if the secret does not exist (do not create new secrets via this endpoint — only update existing).

### 4) Shared client API for secret updates

**File:** `packages/shared/src/api-client/secret-client.ts`

Add:

```ts
export async function updateSecret(
  scopeType: 'user' | 'org' | 'project',
  scopeId: string,
  key: string,
  value: string,
): Promise<void>
```

- Use the same internal API auth pattern as `resolveProjectSecrets()` (`EVE_API_URL` + `EVE_INTERNAL_API_KEY` in `x-eve-internal-token` header).
- On non-2xx response, throw an error with a descriptive message (caller handles it with try/catch).

### 5) Agent-runtime codex write-back

**File:** `apps/agent-runtime/src/invoke/invoke.service.ts`

Mirror worker behavior for warm pod flows:

1. Write `auth.json` to disk before execution (this likely already happens — verify).
2. Re-read after each execution invocation.
3. If content changed, persist via `updateSecret(...)`.
4. Keep consistent with worker scope resolution and comparison logic.

**Warm-pod note:** Write-back triggers after every invocation completion, not just at pod teardown. This ensures refreshed credentials are persisted even if the pod stays warm for subsequent jobs.

### 6) Documentation updates

- `docs/system/harness-execution.md`
  - Add token lifecycle section: Claude setup-token guidance and Codex write-back behavior
- `docs/system/secrets.md`
  - Add OAuth/token management guidance and internal endpoint semantics
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md`
  - Update OAuth Token Sync section with token type guidance and write-back behavior
- `packages/cli/src/lib/help.ts`
  - Update `eve auth sync` / `eve auth creds` help text with token-class behavior

## Non-functional requirements

- No clear-text token content in logs; truncate to prefix for identification.
- Preserve backward compatibility for existing stored secrets.
- Write-back failures must not mask harness runtime errors — wrap in try/catch, log at warn.
- Scope resolution and write-back logic must be local to invocation path (no global state).
- The internal endpoint (`/internal/secrets`) is not exposed to users or agents.

## What we are not doing

- No platform-side OAuth token exchange or refresh for Claude.
- No additional OAuth flow for Codex; CLI-native refresh remains source of truth.
- No cron-based background refresh service.
- No distributed token lease/rotation coordinator.
- No new secret secrets via the internal write-back endpoint (update only).

## Implementation order

1. CLI token type detection + warning output + `auth creds` improvements (token class, Codex expiry).
2. Internal secret write endpoint (`/internal/secrets`) + `InternalAuthGuard`.
3. Shared `updateSecret()` API client method.
4. Worker `CODEX_AUTH_JSON_B64` re-read/write-back after harness completion.
5. Agent-runtime `CODEX_AUTH_JSON_B64` re-read/write-back after each invocation.
6. Documentation updates.

## Definition of done

- [ ] `eve auth sync` differentiates Claude token classes and warns on short-lived OAuth tokens.
- [ ] `eve auth creds` reports token class for Claude (`setup-token` vs `oauth`) and expiry for both Claude and Codex.
- [ ] Internal secret write-back endpoint is implemented with `InternalAuthGuard`.
- [ ] Shared `updateSecret()` client function exists in `@eve/shared`.
- [ ] Worker writes back changed Codex auth safely; failure is non-fatal.
- [ ] Agent-runtime writes back changed Codex auth safely after each invocation.
- [ ] No sensitive token content is logged.
- [ ] Tests cover happy-path and refreshed `auth.json` write-back behavior.

## Verification

1. `eve auth creds` shows token type (`setup-token` vs `oauth`) and expiration info for both Claude and Codex.
2. `eve auth sync` (with a short-lived OAuth Claude token) emits warning and guidance; `--dry-run` also includes the warning.
3. `eve auth sync --org org_manualtestorg` syncs secret scope as expected; JSON output includes `warnings` array.
4. Run a Codex job and verify post-run auth write-back is visible via `eve secrets show --org ...`.
5. Run two concurrent Codex jobs; both succeed; resulting secret contains a valid refreshed credential (last write wins — either is acceptable as long as both are valid).
6. Simulate `auth.json` mutation during execution (modify content mid-run); assert write-back persists the change.
7. Simulate write-back failure (API unavailable); assert job still completes with warning in logs.
