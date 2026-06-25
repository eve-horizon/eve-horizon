# Scenario 25: Auth Token Sync (Claude + Codex)

**Time:** ~3-4 minutes
**Parallel Safe:** Yes
**LLM Required:** No

Validates the `eve auth sync` and `eve auth creds` commands including token type detection,
warning for short-lived OAuth tokens, and the internal secret write-back endpoint.

## Prerequisites

- Local k3d stack running (or any Eve cluster)
- `EVE_API_URL` set (`http://api.eve.lvh.me` for local)
- Claude Code or Codex credentials installed locally
- `eve auth login` completed

```bash
export EVE_API_URL=http://api.eve.lvh.me
export ORG_ID=org_manualtestorg
```

## Step 1: Credential inspection with `eve auth creds`

```bash
node packages/cli/bin/eve.js auth creds
```

Expected output:
- Claude Code OAuth entry shows `Type: setup-token (long-lived)` if token starts with `sk-ant-oat01-`
- Claude Code OAuth entry shows `Type: oauth (short-lived, ~15h)` for any other `sk-ant-*` token
- Codex/Code entry shows access validity, refresh usability, `last_refresh`, and expiry date if credentials exist
- If Codex refresh validation fails, output is actionable and says to run `codex login --device-auth`
- No errors

```bash
node packages/cli/bin/eve.js auth creds --json
```

Expected JSON fields: `credentials[].name`, `credentials[].found`, `credentials[].tokenType` (for Claude), and `credentials[].accessTokenValid` / `credentials[].refreshTokenUsable` (for Codex).

## Step 2: Dry-run sync shows what would be set

```bash
node packages/cli/bin/eve.js auth sync --dry-run
```

Expected:
- Lists `CLAUDE_CODE_OAUTH_TOKEN` and/or `CODEX_AUTH_JSON_B64` with masked values
- Shows target scope (`user`)
- No secrets actually written

```bash
node packages/cli/bin/eve.js auth sync --dry-run --json
```

Expected JSON: `{ "dry_run": true, "would_set": [...], "target": "user", "warnings": [] }` (or `warnings` with a message if short-lived OAuth token).

## Step 3: Sync Claude tokens to user scope

```bash
node packages/cli/bin/eve.js auth sync --claude
```

Expected:
- Sets `CLAUDE_CODE_OAUTH_TOKEN` on user scope
- No error
- If token is short-lived (not `sk-ant-oat01-`): warning message emitted to stderr

Verify the secret was created:
```bash
eve secrets list --user --json | jq '.data[] | select(.key | startswith("CLAUDE"))'
```

Expected: entry for `CLAUDE_CODE_OAUTH_TOKEN` with `masked_value`.

## Step 4: Sync Codex tokens to user scope

```bash
node packages/cli/bin/eve.js auth sync --codex
```

Expected:
- Sets `CODEX_AUTH_JSON_B64` and/or `CODEX_OAUTH_ACCESS_TOKEN` on user scope
- Validates/refreshes local Codex `auth.json` before setting `CODEX_AUTH_JSON_B64`
- No error

If local Codex auth exists but refresh fails, expected error:
```text
Codex credential file exists, but refresh token is not usable.
Run `codex login --device-auth` and then retry `eve auth sync --codex`.
```

Verify:
```bash
eve secrets list --user --json | jq '.data[] | select(.key | startswith("CODEX"))'
```

Expected: entry for `CODEX_AUTH_JSON_B64` with `masked_value`.

## Step 5: Sync to org scope

```bash
node packages/cli/bin/eve.js auth sync --org "$ORG_ID"
```

Expected:
- Sets tokens on org scope (not user)
- Output shows `target: "org org_manualtestorg"`

Verify:
```bash
eve secrets list --org "$ORG_ID" --json | jq '.data[] | select(.key | startswith("CLAUDE") or .key | startswith("CODEX"))'
```

Expected: Claude and/or Codex secrets at org scope.

## Step 6: Internal write-back endpoint

Verify the internal PATCH endpoint works (simulates what the worker does after token refresh):

```bash
# Get a user secret that exists (use CODEX_AUTH_JSON_B64 synced in step 4)
# First confirm it exists
eve secrets show CODEX_AUTH_JSON_B64 --user --json

# Test the write-back endpoint via curl (requires EVE_INTERNAL_API_KEY)
# Note: this is platform-internal, not exposed to end users
USER_ID=$(eve auth whoami --json | jq -r '.user_id')
NEW_VALUE=$(echo -n '{"updated_by":"test"}' | base64)
curl -s -X PATCH \
  "$EVE_API_URL/internal/secrets/user/$USER_ID/CODEX_AUTH_JSON_B64" \
  -H "Content-Type: application/json" \
  -H "x-eve-internal-token: $(cat system-secrets.env.local | grep EVE_INTERNAL_API_KEY | cut -d= -f2)" \
  -d "{\"value\": \"$NEW_VALUE\"}" \
  -w "\nHTTP %{http_code}"
```

Expected: HTTP 204 (No Content)

Try to update a secret that doesn't exist — should 404:
```bash
curl -s -X PATCH \
  "$EVE_API_URL/internal/secrets/user/$USER_ID/NONEXISTENT_SECRET_XYZ" \
  -H "Content-Type: application/json" \
  -H "x-eve-internal-token: $(cat system-secrets.env.local | grep EVE_INTERNAL_API_KEY | cut -d= -f2)" \
  -d '{"value": "test"}' \
  -w "\nHTTP %{http_code}"
```

Expected: HTTP 404

Try with wrong internal token — should 401:
```bash
curl -s -X PATCH \
  "$EVE_API_URL/internal/secrets/user/$USER_ID/CODEX_AUTH_JSON_B64" \
  -H "Content-Type: application/json" \
  -H "x-eve-internal-token: wrong-token" \
  -d '{"value": "test"}' \
  -w "\nHTTP %{http_code}"
```

Expected: HTTP 401

## Step 7: JSON output format

```bash
node packages/cli/bin/eve.js auth sync --json
```

Expected JSON shape:
```json
{
  "results": [...],
  "success": <n>,
  "failed": 0,
  "warnings": []
}
```

If `warnings` is non-empty, it means a short-lived Claude OAuth token was found.

## Step 8: Cleanup

Remove the org-level test secrets (keep user-level for ongoing use):

```bash
eve secrets delete CLAUDE_CODE_OAUTH_TOKEN --org "$ORG_ID" || true
eve secrets delete CODEX_AUTH_JSON_B64 --org "$ORG_ID" || true
eve secrets delete CODEX_OAUTH_ACCESS_TOKEN --org "$ORG_ID" || true
```

## Success Criteria

- [ ] `eve auth creds` shows `tokenType` for Claude (setup-token vs oauth)
- [ ] `eve auth creds --json` includes `tokenType` in JSON output
- [ ] `eve auth creds --codex` reports Codex access validity and refresh usability
- [ ] `eve auth sync --dry-run` shows what would be set without writing
- [ ] `eve auth sync --dry-run --json` includes `warnings` array
- [ ] `eve auth sync --claude` creates Claude secrets at user scope
- [ ] `eve auth sync --codex` validates Codex refresh usability before creating secrets at user scope
- [ ] `eve auth sync --org <id>` creates secrets at org scope
- [ ] Internal PATCH endpoint returns 204 on valid update
- [ ] Internal PATCH endpoint returns 404 for non-existent secret
- [ ] Internal PATCH endpoint returns 401 for wrong token
- [ ] `eve auth sync --json` includes `warnings` field

## Notes

**Token type mapping:**
- `sk-ant-oat01-*` prefix = `setup-token` (long-lived, generated by `claude setup-token`)
- Other `sk-ant-*` = `oauth` (short-lived, ~15h)
- Warning fires when syncing a short-lived token

**Write-back in production:**
The internal PATCH endpoint is also called automatically by the worker and agent-runtime after each
codex/code harness invocation, if the `auth.json` on disk changed (token was refreshed by the CLI).
This keeps `CODEX_AUTH_JSON_B64` fresh without manual re-sync.
