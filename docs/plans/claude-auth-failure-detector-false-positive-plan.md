# Claude Auth Failure Detector False-Positive Fix Plan

> **Status**: Complete; implemented, locally verified, and shipped to staging
> **Date**: 2026-06-05
> **Source**: Operator bug report plus local code audit
> **Component**: `packages/shared/src/invoke/claude-auth.ts`, `apps/worker/src/invoke/invoke.service.ts`, `apps/agent-runtime/src/invoke/invoke.service.ts`
> **Related plan**: `docs/plans/claude-setup-token-auth-durability-plan.md`

## Verdict

Yes, this is a real issue in the current tree.

`detectClaudeAuthFailure()` currently stringifies every parsed harness event and matches `/\b401\b|invalid authentication credentials|oauth token has expired|api key/i`. Both the worker and agent-runtime invoke paths call it on every parsed stdout event plus raw stdout parse errors and stderr chunks. A successful assistant, tool, system, or result event that merely contains the phrase "api key" can therefore be classified as `claude_auth_failed`.

The impact is also real: both services call `deliverProvisioningError(... errorCode: 'claude_auth_failed' ...)` from `emitClaudeAuthFailed()` immediately when the stream detector first matches. The final user-facing error text is gated on a nonzero exit, but the lifecycle/log event and assignee/parent provisioning delivery are not.

## Evidence From Code

- Shared detector: `packages/shared/src/invoke/claude-auth.ts` has the bare `api key` alternative and no event-type gating.
- Worker call path: `apps/worker/src/invoke/invoke.service.ts` calls `maybeEmitClaudeAuthFailed()` for parsed stdout JSON, raw stdout parse-error lines, and stderr chunks.
- Agent-runtime call path: `apps/agent-runtime/src/invoke/invoke.service.ts` has the same pattern.
- Immediate delivery: both `emitClaudeAuthFailed()` implementations append a `claude_auth_failed` log/lifecycle event and then call `deliverProvisioningError()` before the final process exit code is known.
- Existing tests: `packages/shared/src/invoke/__tests__/claude-auth.spec.ts` covers auth selection and materialization, but not `detectClaudeAuthFailure()`.
- Adjacent pattern: `packages/shared/src/harnesses/auth-errors.ts` also contains `/api key/i`, but it is used only after a nonzero worker error message. It is not the direct source of this false-positive delivery path, but should be audited while fixing the detector.

## Goals

- Make `claude_auth_failed` authoritative: emit it only for a failed Claude-family invocation with a credible auth-failure signal.
- Preserve detection for real Claude auth failures: `apiKeySource === 'none'`, HTTP 401, Anthropic `authentication_error`, invalid or expired API keys, and expired OAuth/setup-token credentials.
- Prevent `deliverProvisioningError(errorCode: 'claude_auth_failed')` for any invocation that exits successfully.
- Keep worker and agent-runtime behavior symmetric.
- Add focused regression coverage so successful events mentioning "api key" stay silent.

## Non-Goals

- Do not change Claude auth selection precedence, setup-token materialization, or `eve auth verify`.
- Do not remove `claude_auth_selected`; it is the useful positive diagnostic.
- Do not make AWS or staging infrastructure changes.

## Implementation Plan

### Phase 1: Harden the Shared Detector

Update `packages/shared/src/invoke/claude-auth.ts`.

- Replace the broad regex with auth-error phrasing only. The bare phrase `api key` must not match by itself.
- Add an error-bearing event gate for object inputs:
  - `type === 'result' && is_error === true`
  - `type === 'error'`
  - `type === 'system_error'`
  - `type === 'spawn_error'`
  - `type === 'stderr'`
- Keep `apiKeySource === 'none'` as a reliable structured signal from `system/init`.
- Avoid scanning successful `assistant`, `user`, `tool_result`, `system/init` with a non-`none` source, and `result` with `is_error !== true`.
- Consider an optional detector context for raw strings, because current services pass both stderr text and non-JSON stdout parse-error lines as strings. If adding context, scan raw strings only when they came from stderr or another known error stream; keep backwards-compatible tests for direct string input where practical.

Recommended regex shape:

```ts
const CLAUDE_AUTH_ERROR_RE =
  /\b401\b|invalid authentication credentials|oauth token has expired|authentication_error|invalid x-api-key|invalid api[\s_-]?key|api[\s_-]?key (?:is )?(?:invalid|missing|required|expired|not (?:found|provided))|no api[\s_-]?key (?:found|provided)|could not (?:find|resolve) (?:an? )?api[\s_-]?key/i;
```

### Phase 2: Defer Authoritative Failure Emission Until Final Exit

Update both invoke services symmetrically.

- Change the stream handler from "emit on first match" to "record first auth-failure candidate".
- Store the candidate failure, latest `apiKeySource`, and selected `ClaudeAuthDecision` context during streaming.
- After the child process closes and the final exit code is known, emit `claude_auth_failed` only when:
  - a candidate exists, and
  - the final exit code is nonzero.
- Move `deliverProvisioningError()` into that same final nonzero branch.
- Build the final `errorMessage` after the deferred auth message is emitted, preserving the current behavior where the auth remediation text is appended only on failed invocations.
- Keep the single-emission latch so repeated 401/stderr lines do not produce duplicate logs or relays.

This makes `claude_auth_failed` an authoritative failure signal instead of an early stream guess.

### Phase 3: Tighten Tests

Add focused unit coverage in `packages/shared/src/invoke/__tests__/claude-auth.spec.ts`.

Cover silent successful events:

- Assistant text mentioning "api key".
- `system/init` with `apiKeySource: 'user'`.
- `result` with `is_error: false` and text mentioning "api key".
- Tool/user payloads mentioning "invalid api key" as ordinary content, if the detector scans nested JSON.

Cover real failures:

- `system/init` with `apiKeySource: 'none'`.
- `result` with `is_error: true` and `401 Unauthorized`.
- Anthropic-style `{ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }`.
- Stderr/raw error text such as `error: invalid api key`.

Add service-level regression coverage where feasible:

- A successful mocked Claude-family invocation emits an assistant/result event containing "api key", exits `0`, and produces no `claude_auth_failed` logs and no provisioning relay.
- A failing mocked Claude-family invocation emits a credible auth error and exits nonzero, producing exactly one `claude_auth_failed` log/lifecycle event and one provisioning relay.

If the existing service test harness is too heavy, start with shared unit coverage plus a small extracted helper test for the finalization decision. Then add an integration/manual scenario before release.

### Phase 4: Audit Adjacent Auth Text Classifiers

- Review `packages/shared/src/harnesses/auth-errors.ts`.
- Keep or tighten the generic `/api key/i` only if it remains gated behind nonzero process errors.
- Do not reuse the generic auth-error helper for `claude_auth_failed`; the Claude provisioning signal needs stricter semantics.

### Phase 5: Verification

Run focused tests first:

```bash
pnpm test packages/shared/src/invoke/__tests__/claude-auth.spec.ts
```

Then run the repo's relevant quality gates for the touched scope:

```bash
pnpm build
pnpm test
```

Manual/local verification, if a Claude credential is available:

```bash
eve job create --project <project-id> --harness claude --model sonnet --permission yolo \
  --description "Auth check only. Mention api key once, then reply exactly: AUTH_OK"
eve job logs <job-id> | grep -E 'claude_auth_failed|claude_auth_selected'
```

Expected manual result: `claude_auth_selected` appears, the job exits successfully, and `claude_auth_failed` does not appear.

## Acceptance Criteria

- Successful `claude` and `mclaude` jobs whose prompt, output, injected context, or tool content contains "api key" emit no `claude_auth_failed` log or lifecycle event.
- Successful `claude` and `mclaude` jobs never call `deliverProvisioningError()` with `errorCode: 'claude_auth_failed'`.
- Genuine failed auth cases still produce exactly one `claude_auth_failed` event and one provisioning relay.
- The detector remains shared; worker and agent-runtime do not grow divergent auth heuristics.
- Regression tests cover both false-positive and real-failure cases.

## Implementation Notes

Implemented on 2026-06-05 for bead `eve-horizon-zkud4`.

- `packages/shared/src/invoke/claude-auth.ts` now unwraps Eve normalized Claude events under `raw`, keeps `apiKeySource=none` as a structured signal, scans only error-bearing object events, skips non-JSON stdout text, and removes the bare `api key` regex alternative.
- `apps/worker/src/invoke/invoke.service.ts` and `apps/agent-runtime/src/invoke/invoke.service.ts` now record the first auth-failure candidate while streaming and emit `claude_auth_failed`/`deliverProvisioningError()` only after the final exit code is known to be nonzero.
- `packages/shared/src/invoke/__tests__/claude-auth.spec.ts` now covers successful false-positive cases, wrapped Eve event envelopes, stdout text suppression, `apiKeySource=none`, `401`, `authentication_error`, and stderr invalid-key text.

## Local Verification Evidence

- Focused detector tests: `pnpm --filter @eve/shared exec vitest run src/invoke/__tests__/claude-auth.spec.ts` passed, 19 tests.
- Build: `pnpm build` passed.
- Full test suite: `pnpm test` passed under escalation because the pack resolver test writes to `~/.eve/cache/packs`.
- Local k3d: `./bin/eh k8s deploy` completed after rebuilding/importing updated worker and agent-runtime images.
- Local health: `curl http://127.0.0.1:5802/health` returned `status:"ok"` and `database:"connected"`.
- Claude exit-0 false-positive check: job `cladet-b608e7a8` exited `0` with result `AUTH_OK`; logs showed `claude_auth_selected=1`, `claude_auth_failed=0`, `claude_auth_failed lifecycle=0`, provisioning relays `0`.
- Thread relay negative check: hinted Claude job `cladet-a39f71b6` exited `0` with "api key" in the prompt; logs showed no `claude_auth_failed`, and local `thread_messages` had `0` `claude_auth_failed` messages for thread `thr_01ktcamdjvfk3t1ck6xk02mamk`.
- Real nonzero failure check: mclaude job `cladet-7158fea7` exited `1` with `Not logged in`; logs showed exactly one `claude_auth_failed` and one lifecycle mirror with reason `apiKeySource=none`.
- Thread relay positive check: hinted mclaude job `cladet-7c858708` exited `1`; logs showed exactly one `claude_auth_failed` and local `thread_messages` had exactly one `claude_auth_failed` message for that job.
- Invalid credential check: Claude job `cladet-84eddd82` used an intentionally invalid setup-token, exited `1` with `401 Invalid bearer token`, and emitted exactly one `claude_auth_failed` log and one lifecycle mirror; the valid setup-token was restored afterward.

Follow-up filed: `eve-horizon-1ywgl` for `eve auth verify` returning `ok:false` when a setup-token-selected Claude job has `model_replied:true` but reports `apiKeySource:"none"`. This was kept out of scope because the detector now suppresses exit-0 auth-failure delivery correctly.

## Release and Staging Evidence

- Code commit: `adb1b319fe64689d46b17320ca3d6b30fbcdff3e` (`fix: harden claude auth failure detection`) pushed to `origin/main`.
- Release tag: `release-v0.1.311` pushed to origin.
- Image publish workflow: eve-horizon/eve-horizon run `27027955726` completed successfully and dispatched the staging deploy.
- Staging deploy workflow: example-org/deployment-instance run `27028370553` completed successfully in 5m31s.
- Public staging health: `curl -fsSL https://api.eve.example.com/health` returned `status:"ok"`, `database:"connected"`, build `version:"0.1.311"`, `gitSha:"adb1b31"`, and `buildTime:"2026-06-05T16:48:34Z"`.
- Staging workload images:
  - `eve-api`: `public.ecr.aws/w7c4v0w3/eve-horizon/api:0.1.311`
  - `eve-worker`: `public.ecr.aws/w7c4v0w3/eve-horizon/worker:0.1.311`
  - `eve-agent-runtime`: `public.ecr.aws/w7c4v0w3/eve-horizon/agent-runtime:0.1.311`
