# Scenario 13: Identity & Auth Providers

**Time:** ~3 minutes
**Parallel Safe:** Yes
**LLM Required:** No

Verifies the multi-provider identity framework: provider registry, SSH provider (existing), Nostr NIP-98 provider, challenge-response flows, request-level auth chain, and invite-gated provisioning.

## What This Tests

| Feature | Verified By |
|---------|-------------|
| Provider registry | SSH + Nostr both registered at startup |
| SSH challenge-response | Existing login flow still works |
| Nostr challenge-response | Kind-22242 challenge login flow |
| Auth guard chain | Bearer JWT -> Provider request auth fallback |
| Auth introspection | `/auth/me` returns status without requiring auth |
| Invite provisioning | Create and list org invites with identity hints |
| Multi-provider challenges | provider field on auth_challenges table |

## Prerequisites

- Smoke tests pass (scenario 01)
- Auth enabled (`EVE_AUTH_ENABLED=true` in local stack)
- Migration `00042_nostr_identity.sql` applied (included in deploy)

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:?Set EVE_API_URL before running (see main README)}
```

## Steps

### Step 1: Verify Provider Registry

Check that both SSH and Nostr providers are registered by examining API startup logs.

```bash
# Use eve system logs (works against any cluster, no kubectl context needed)
eve system logs api --tail 100 2>&1 | grep -i "identity provider"
```

**Expected:** Two log lines:
```
Registered identity provider: github_ssh
Registered identity provider: nostr
```

### Step 2: SSH Challenge-Response (Existing Flow)

Verify the existing SSH login flow still works through the provider framework.

```bash
# Create challenge (uses provider='github_ssh' by default)
# Use the bootstrap admin email from your local setup
CHALLENGE=$(curl -s -X POST "$EVE_API_URL/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com"}')

echo "$CHALLENGE" | jq .
```

**Expected:** JSON with `challenge_id`, `nonce`, `expires_at`. If user doesn't exist, use the email from `eve auth login`.

### Step 3: Nostr Challenge Request

Create a challenge for a Nostr identity (pubkey-based, no existing user).

```bash
# Use a test pubkey (64-char hex)
TEST_PUBKEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

NOSTR_CHALLENGE=$(curl -s -X POST "$EVE_API_URL/auth/challenge" \
  -H "Content-Type: application/json" \
  -d "{\"provider\": \"nostr\", \"pubkey\": \"$TEST_PUBKEY\"}")

echo "$NOSTR_CHALLENGE" | jq .
```

**Expected:** JSON with `challenge_id`, `nonce` (64-char hex), `expires_at`. The challenge has `provider='nostr'` and `user_id=null` (since this pubkey isn't registered).

### Step 4: Auth Guard Chain

Verify the auth guard behavior on different auth header types.

```bash
# /auth/me is a status introspection endpoint - returns 200 with auth state
curl -s "$EVE_API_URL/auth/me" | jq .
# Expected: 200 with {"auth_enabled": true, "authenticated": false, ...}

# Request with valid Bearer token -> 200 with authenticated: true
TOKEN=$(eve auth token 2>/dev/null)
curl -s "$EVE_API_URL/auth/me" \
  -H "Authorization: Bearer $TOKEN" | jq .authenticated
# Expected: true

# Request with invalid Nostr header on a guarded endpoint -> 401
curl -s -o /dev/null -w "%{http_code}" "$EVE_API_URL/orgs" \
  -H "Authorization: Nostr invalidbase64"
# Expected: 401

# Request with no auth on a guarded endpoint -> 401
curl -s -o /dev/null -w "%{http_code}" "$EVE_API_URL/orgs"
# Expected: 401
```

### Step 5: Invite Create and List

Verify invite management API works (requires `owner` role — `orgs:admin` permission).

```bash
# Mint a token with owner role (orgs:admin permission required for invites)
TOKEN=$(eve auth mint --email admin@example.com --org $ORG_ID --role owner 2>/dev/null)
TEST_PUBKEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

# Create an invite with Nostr identity hint
INVITE=$(curl -s -X POST "$EVE_API_URL/auth/invites" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"org_id\": \"$ORG_ID\", \"role\": \"member\", \"provider_hint\": \"nostr\", \"identity_hint\": \"$TEST_PUBKEY\"}")

echo "$INVITE" | jq .
# Expected: JSON with invite_code, org_id, provider_hint, identity_hint, role

INVITE_CODE=$(echo "$INVITE" | jq -r '.invite_code')
echo "Invite code: $INVITE_CODE"

# List invites for org
curl -s "$EVE_API_URL/auth/invites/$ORG_ID" \
  -H "Authorization: Bearer $TOKEN" | jq 'length'
# Expected: >= 1 (at least the invite just created)
```

### Step 6: Nostr Challenge Schema Validation

Verify that the challenge endpoint rejects invalid Nostr requests.

```bash
# Nostr challenge without pubkey -> should fail validation
curl -s -X POST "$EVE_API_URL/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{"provider": "nostr"}'
# Expected: 400 (nostr provider requires pubkey or email/user_id)

# Invalid provider -> should fail validation
curl -s -o /dev/null -w "%{http_code}" -X POST "$EVE_API_URL/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{"provider": "invalid_provider"}'
# Expected: 400
```

## Verification Checklist

```
[ ] SSH provider registered in logs
[ ] Nostr provider registered in logs
[ ] SSH challenge-response returns valid challenge
[ ] Nostr challenge with pubkey returns challenge (64-char hex nonce)
[ ] /auth/me without auth returns 200 with authenticated: false
[ ] Bearer JWT on /auth/me shows authenticated: true
[ ] Invalid Nostr header on guarded endpoint returns 401
[ ] Missing auth on guarded endpoint returns 401
[ ] Invite creation with provider_hint and identity_hint succeeds
[ ] Invite listing returns created invites
[ ] Nostr challenge without pubkey returns 400
```
