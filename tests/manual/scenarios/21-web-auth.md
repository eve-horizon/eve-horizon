# Scenario 21: Web Auth (GoTrue + SSO + Token Exchange)

**Time:** ~3-4 minutes
**Parallel Safe:** Yes
**LLM Required:** No

Validates the platform web auth stack: GoTrue (Supabase Auth), Mailpit, SSO broker, dual-mode auth, token exchange, and admin invite flow.

## Prerequisites

- `EVE_API_URL` set (see main README)
- Local k3d stack deployed with web auth services (`./bin/eh k8s deploy`)
- GoTrue has `GOTRUE_MAILER_AUTOCONFIRM=true` for local testing
- CLI built from branch: `pnpm -C packages/cli build`

## Steps

### 1. GoTrue Health Check

```bash
curl -s http://auth.eve.lvh.me/health | jq .
```

**Expected:**
- Returns JSON with `name: "GoTrue"` and `version`
- HTTP 200

### 2. Mailpit Web UI

```bash
curl -s -o /dev/null -w "%{http_code}" http://mail.eve.lvh.me/
```

**Expected:**
- Returns `200`

### 3. SSO Broker Health

```bash
curl -s http://sso.eve.lvh.me/health | jq .
```

**Expected:**
- Returns `{ "status": "ok", "service": "eve-sso" }`

### 4. Auth Config Discovery

```bash
curl -s $EVE_API_URL/auth/config | jq .
```

**Expected:**
- Returns JSON with `supabase_url`, `anon_key`, and `sso_url` fields
- `supabase_url` points to `http://auth.eve.lvh.me` (uses SUPABASE_AUTH_EXTERNAL_URL if set)
- `sso_url` points to `http://sso.eve.lvh.me`
- `anon_key` is a non-empty JWT string

### 5. SSO Login Page Renders

```bash
curl -s -o /dev/null -w "%{http_code}" "http://sso.eve.lvh.me/login?redirect_to=http://api.eve.lvh.me"
```

**Expected:**
- Returns `200`

### 6. GoTrue Signup

```bash
ANON_KEY=$(curl -s $EVE_API_URL/auth/config | jq -r .anon_key)
TEST_EMAIL="test-webauth-$(date +%s)@eve.local"

SIGNUP_RESPONSE=$(curl -s -X POST http://auth.eve.lvh.me/signup \
  -H "Content-Type: application/json" \
  -H "apikey: $ANON_KEY" \
  --data-raw "{\"email\":\"$TEST_EMAIL\",\"password\":\"TestPassword123\"}")

echo "$SIGNUP_RESPONSE" | jq '{access_token: .access_token[:20], user_id: .user.id, email: .user.email, confirmed: .user.email_confirmed_at}'
```

**Expected:**
- With `GOTRUE_MAILER_AUTOCONFIRM=true`, returns both `access_token` and `user` in the response (auto-confirmed signup returns a session)
- `user.id` is a UUID
- `user.email_confirmed_at` is non-null

### 7. Mailpit Captures Email

```bash
sleep 1
curl -s "http://mail.eve.lvh.me/api/v1/messages" | jq '.messages | length'
```

**Expected:**
- At least 1 message captured (confirmation emails may still be sent even with autoconfirm)

### 8. GoTrue Password Login

```bash
LOGIN_RESPONSE=$(curl -s -X POST "http://auth.eve.lvh.me/token?grant_type=password" \
  -H "Content-Type: application/json" \
  -H "apikey: $ANON_KEY" \
  --data-raw "{\"email\":\"$TEST_EMAIL\",\"password\":\"TestPassword123\"}")

SUPABASE_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r .access_token)
echo "Has access_token: $(echo "$LOGIN_RESPONSE" | jq 'has("access_token")')"
echo "Has refresh_token: $(echo "$LOGIN_RESPONSE" | jq 'has("refresh_token")')"
echo "Token type: $(echo "$LOGIN_RESPONSE" | jq -r .token_type)"
```

**Expected:**
- Returns JSON with `access_token`, `refresh_token`, `token_type: "bearer"`
- Token is a valid HS256 JWT signed with Supabase JWT secret

### 9. Token Exchange (Supabase -> Eve RS256)

```bash
EXCHANGE_RESPONSE=$(curl -s -X POST "$EVE_API_URL/auth/exchange" \
  -H "Authorization: Bearer $SUPABASE_TOKEN")

echo "$EXCHANGE_RESPONSE" | jq .
EVE_TOKEN=$(echo "$EXCHANGE_RESPONSE" | jq -r .access_token)
EVE_USER_ID=$(echo "$EXCHANGE_RESPONSE" | jq -r .user_id)
echo "Eve user_id: $EVE_USER_ID"
```

**Expected:**
- Returns `{ access_token, token_type: "bearer", expires_at, user_id }`
- `user_id` starts with `user_`
- `access_token` is a valid RS256 JWT (header alg: RS256)

### 10. Eve RS256 Token Works

```bash
ME_RESPONSE=$(curl -s "$EVE_API_URL/auth/me" \
  -H "Authorization: Bearer $EVE_TOKEN")

echo "$ME_RESPONSE" | jq .
```

**Expected:**
- Returns `authenticated: true`
- `user_id` matches the exchange response

### 11. Dual-Mode Auth — RS256 Internal Token Still Works

```bash
# Use the existing CLI auth token (RS256, Eve-minted)
CLI_TOKEN=$(eve auth token 2>/dev/null)

curl -s "$EVE_API_URL/auth/me" \
  -H "Authorization: Bearer $CLI_TOKEN" | jq '{authenticated, user_id, is_admin}'
```

**Expected:**
- RS256 (internal) tokens still verify correctly
- `authenticated: true`
- Dual-mode doesn't break existing CLI/API auth

### 12. SSO Session Endpoint

```bash
# Simulate what a browser app does — call /session with refresh cookie and Origin
REFRESH_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r .refresh_token)

SSO_RESPONSE=$(curl -s "http://sso.eve.lvh.me/session" \
  -H "Origin: http://api.eve.lvh.me" \
  -b "eve_sso_rt=$REFRESH_TOKEN")

echo "$SSO_RESPONSE" | jq .
```

**Expected:**
- Returns `{ access_token, expires_at, user: { id, email } }`
- `user.id` starts with `user_`
- `access_token` is a valid Eve RS256 JWT

### 13. Identity Auto-Linking Verified

```bash
# The exchange in step 9 should have created a Supabase identity link.
# Verify by exchanging the same Supabase token again — should return the same Eve user.
EXCHANGE2_RESPONSE=$(curl -s -X POST "$EVE_API_URL/auth/exchange" \
  -H "Authorization: Bearer $SUPABASE_TOKEN")

EXCHANGE2_USER_ID=$(echo "$EXCHANGE2_RESPONSE" | jq -r .user_id)
echo "First exchange user_id: $EVE_USER_ID"
echo "Second exchange user_id: $EXCHANGE2_USER_ID"
```

**Expected:**
- Second exchange returns the same `user_id` as the first (identity linked, not re-provisioned)

### 14. Admin Invite via API

```bash
# Admin-only endpoint: send a default-branded Eve invite email
CLI_TOKEN=$(eve auth token 2>/dev/null)
INVITE_EMAIL="invite-test-$(date +%s)@eve.local"

INVITE_RESPONSE=$(curl -s -X POST "$EVE_API_URL/auth/supabase/invite" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLI_TOKEN" \
  --data-raw "{\"email\":\"$INVITE_EMAIL\"}")

echo "$INVITE_RESPONSE" | jq .
```

**Expected:**
- Returns `{ email, invited: true }`
- Requires system admin auth (non-admin gets 403)

### 15. CLI Admin Invite --web Flag

```bash
# CLI invite with --web flag sends GoTrue invite email
INVITE_CLI_EMAIL="cli-invite-$(date +%s)@eve.local"

node packages/cli/bin/eve.js admin invite \
  --email "$INVITE_CLI_EMAIL" --web --org org_manualtestorg --json 2>/dev/null
```

**Expected:**
- JSON output includes `web_invite_sent: true`
- Human output includes "Web invite email sent"

### 16. Invite Email in Mailpit

```bash
# Verify invite emails arrived in Mailpit
sleep 1
curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq '[.messages[] | select(.Subject == "You have been invited to Eve Horizon") | {to: .To[0].Address, subject: .Subject}] | length'
```

**Expected:**
- At least 1 invite email with subject "You have been invited to Eve Horizon"

## Success Criteria

- [ ] GoTrue healthy at auth.eve.lvh.me
- [ ] Mailpit accessible at mail.eve.lvh.me
- [ ] SSO broker healthy at sso.eve.lvh.me
- [ ] Auth config endpoint returns provider URLs, anon key, and SSO URL
- [ ] GoTrue signup creates auto-confirmed user (with autoconfirm)
- [ ] Mailpit captures email
- [ ] GoTrue password login returns tokens
- [ ] Token exchange returns Eve RS256 token with `user_` prefix ID
- [ ] Eve RS256 token accepted by /auth/me
- [ ] RS256 (internal) tokens still work (dual-mode)
- [ ] SSO session endpoint returns Eve token from refresh cookie
- [ ] Identity auto-linking is stable (same user on repeat exchange)
- [ ] Admin invite API sends GoTrue invite email
- [ ] CLI `--web` flag triggers GoTrue invite
- [ ] Invite emails captured by Mailpit

## Cleanup

```bash
# No persistent cleanup needed — test users are in GoTrue's auth schema
# The k3d stack reset clears everything
```
