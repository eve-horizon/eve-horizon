# Codex Harness 401 Auth Failure

> **Status**: RESOLVED — verified working against local k3d stack
> **Created**: 2026-02-24
> **Commits**: `a8532b5`, `dd43d09` (initial attempts), plus fixes in this session

## Problem

Jobs using `harness: codex` fail with `401 Unauthorized: Missing bearer or basic authentication in header` against `api.openai.com/v1/responses`. The Codex CLI sends **no auth header at all**.

Affected project: `reference-app` (`proj_example`), harness `codex`, model `gpt-5.3-codex-spark`.

## Root Causes (Three Issues)

### Issue 1: Agent-Runtime resolveCodeAuth Was Completely Broken

The orchestrator routes jobs to the **agent-runtime** (warm pods) when `EVE_AGENT_RUNTIME_URL` is set — which it always is in k3d. The worker's `resolveCodeAuth` (which was fixed in commits `a8532b5` and `dd43d09`) was never executing.

The agent-runtime's `resolveCodeAuth` was broken:
- `resolveOAuthTokens()` treated the raw base64 `CODEX_AUTH_JSON_B64` as an access token
- Set `authEnv.CODEX_AUTH_JSON_B64 = oauthTokens.accessToken` — an env var the codex binary doesn't understand
- Never wrote `auth.json` to disk
- Never set `OPENAI_API_KEY`

**Fix**: Rewrote the agent-runtime's `resolveCodeAuth` to properly decode `CODEX_AUTH_JSON_B64`, write the full `auth.json` (with `refresh_token`) to `CODEX_HOME` and fallback locations (`~/.codex`, `~/.code`).

### Issue 2: Permission Default Mismatch

The agent-runtime defaulted permission to `'default'` which maps to `--ask-for-approval on-request`. In non-interactive exec mode, this blocks all file writes because no human can approve them.

The worker defaults to `'yolo'` (`--ask-for-approval never`).

**Fix**: Changed agent-runtime permission default from `'default'` to `'yolo'`.

### Issue 3: Landlock Sandbox Fails in Containers

The Codex CLI's Landlock sandbox (`--sandbox workspace-write`) fails in Docker/k3d/k3s containers with `Sandbox(LandlockRestrict)` errors. Even `--sandbox danger-full-access` triggers the same error — Landlock's kernel integration doesn't work properly in LinuxKit-based container environments.

**Fix**: For the codex harness, use `--dangerously-bypass-approvals-and-sandbox` which completely bypasses Landlock. This is the codex CLI's intended flag for externally-sandboxed environments (i.e., containers). The `code`/`coder` harness retains the original `--sandbox workspace-write` behavior.

## Key Files Modified

| File | Change |
|------|--------|
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Rewrote `resolveCodeAuth` to properly decode and write auth.json; changed permission default to `'yolo'` |
| `apps/worker/src/invoke/invoke.service.ts` | Rewrote `resolveCodeAuth` for file-based auth (refresh_token support); added diagnostic logging |
| `packages/eve-agent-cli/src/harnesses/code.ts` | Codex: `--dangerously-bypass-approvals-and-sandbox`; Code: keeps `--sandbox workspace-write`; added auth diagnostics |

## Auth Strategy

The fix uses **file-based auth** (not `OPENAI_API_KEY` env var) so that:
1. The Codex CLI has the `refresh_token` available for automatic token refresh
2. The `access_token` is used as-is (it's a valid OAuth bearer token)
3. No `last_refresh` manipulation — the Codex CLI manages its own refresh timing

Auth resolution in the Codex CLI (Rust source):
```
1. CODEX_API_KEY env var
2. OPENAI_API_KEY env var
3. Ephemeral credential store
4. File storage (CODEX_HOME/auth.json) ← we use this
```

## Verification

Tested against local k3d stack with reference-app project (`proj_example`):

```
[codex-cli] CODEX_HOME=.../repo/.agent/harnesses/codex auth.json=true OPENAI_API_KEY_env=false
[codex-cli] auth.json: access_token=true refresh_token=true last_refresh=2026-02-16T15:19:19.536349Z
codex -C .../repo --dangerously-bypass-approvals-and-sandbox exec --json --skip-git-repo-check <prompt>
→ thread.started → turn.started → command_execution (exit_code=0) → item.completed
→ Job phase: done ✅
```

## Remaining Work

- Deploy to staging and verify with real reference-app project
- Remove debug logging once auth is stable in production
- Consider whether `--dangerously-bypass-approvals-and-sandbox` should be configurable per-project
