# Identity Providers

> Status: Current
> Last Updated: 2026-02-10

## Overview

Eve uses a pluggable identity provider framework for authentication. Multiple providers (SSH, Nostr, future additions) register at startup. The auth guard implements a two-stage chain: Bearer JWT first, then request-level provider auth.

This design lets the system support diverse authentication mechanisms (SSH keys, Nostr keypairs, API keys, OAuth tokens) without modifying core auth logic. Each provider is a self-contained module that implements a standard contract.

Key source files:

| File | Purpose |
|------|---------|
| `apps/api/src/auth/providers/identity-provider.interface.ts` | Provider contract |
| `apps/api/src/auth/providers/provider-registry.ts` | Registry singleton |
| `apps/api/src/auth/providers/ssh-identity.provider.ts` | SSH provider (`github_ssh`) |
| `apps/api/src/auth/providers/nostr-identity.provider.ts` | Nostr provider (`nostr`) |
| `apps/api/src/auth/auth.guard.ts` | Auth chain (JWT + provider request auth) |
| `apps/api/src/auth/auth.service.ts` | Challenge/verify orchestration, invite provisioning |
| `packages/shared/src/crypto/nostr.ts` | Schnorr verification, URL canonicalization |

## Provider Interface

Every provider implements the `IdentityProvider` contract:

```typescript
interface IdentityProvider {
  readonly name: string;  // matches identities.provider column

  // Challenge/response (login flow)
  createChallenge(params: { userId?: string; pubkey?: string }): Promise<ChallengeData>;
  verifyChallenge(challenge: string, proof: ChallengeProof, identities: Identity[]): Promise<VerifiedIdentity | null>;
  fingerprint(publicKey: string): Promise<string>;

  // Optional: request-level auth (per-request, no login required)
  extractFromRequest?(req: { headers: Record<string, string | string[] | undefined> }): ExtractedCredential | null;
  verifyRequestCredential?(credential: ExtractedCredential): Promise<VerifiedIdentity | null>;
}
```

**Challenge/response** is the login flow: server issues a nonce, client signs it, server verifies.

**Request-level auth** is optional. Providers that support it (Nostr NIP-98, future API keys) can authenticate individual HTTP requests without a prior login. They implement `extractFromRequest` to detect their credential in headers, and `verifyRequestCredential` to validate it.

The `fingerprint` method computes a deterministic dedup key for a public key. This prevents the same key from being registered twice.

### Return Types

`VerifiedIdentity` supports two shapes:

1. **Known identity** -- `identity` is set, `userId` is set. The provider matched a registered user.
2. **Unknown identity** -- `identity` is null, `provider` + `externalId` identify the caller. Triggers invite-gated provisioning (see below).

## Provider Registry

`IdentityProviderRegistry` is an injectable NestJS singleton:

```typescript
class IdentityProviderRegistry {
  register(provider: IdentityProvider): void;    // called at module init
  get(name: string): IdentityProvider | undefined;
  list(): IdentityProvider[];
  extractFromRequest(req): ExtractedCredential | null;  // tries all providers
}
```

Providers register during `AuthModule.onModuleInit()`:

```typescript
onModuleInit(): void {
  this.registry.register(this.sshProvider);
  this.registry.register(this.nostrProvider);
}
```

`extractFromRequest` iterates all registered providers in order. Errors in individual providers are caught and logged so one broken provider does not block others. First match wins.

## Auth Chain

The `AuthGuard` implements a two-stage authentication chain:

```
Request arrives
  |
  +--> @Public() route? --> allow
  |
  +--> Stage 1: Bearer JWT
  |      Authorization: Bearer <jwt>
  |      Verifies RS256/HS256 token, resolves user
  |      --> success: attach user, allow
  |
  +--> Stage 2: Provider request auth
  |      registry.extractFromRequest(req)
  |      provider.verifyRequestCredential(credential)
  |      authService.resolveVerifiedIdentity(verified)
  |      --> success: attach user, allow
  |
  +--> 401 Unauthorized
```

Stage 2 catches all errors and logs them as warnings. A broken provider does not cause a 500; it falls through to 401.

## SSH Provider (`github_ssh`)

The original auth mechanism, refactored to implement the provider interface.

**Challenge:** Random 32-byte `base64url` nonce.

**Verify:** Writes the public key and signature to temp files, runs `ssh-keygen -Y verify` as a subprocess. Iterates all registered SSH identities for the user until one verifies.

**Fingerprint:** Runs `ssh-keygen -lf` on the public key, returns the MD5 fingerprint hash (e.g., `MD5:ab:cd:...`).

**Request-level auth:** Not supported. SSH keys require the challenge/response dance.

### SSH Login Flow (curl)

```bash
# 1. Request challenge
curl -X POST "$EVE_API_URL/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'

# Response: { "challenge_id": "...", "nonce": "...", "expires_at": "..." }

# 2. Sign the nonce
echo -n "$NONCE" | ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n eve-auth

# 3. Submit signature
curl -X POST "$EVE_API_URL/auth/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "challenge_id": "...",
    "signature": "-----BEGIN SSH SIGNATURE-----\n..."
  }'

# Response: { "access_token": "...", "user_id": "...", "expires_at": ... }
```

## Nostr Provider (`nostr`)

Two authentication paths: challenge/verify for login, NIP-98 for per-request auth.

### Challenge/Verify (Login)

**Challenge:** Random 32-byte hex nonce. Response includes `instructions` field.

**Verify:** Client signs a kind-22242 Nostr event containing a `["challenge", "<nonce>"]` tag. Server parses the JSON event from `proof.signature`, verifies the event ID + Schnorr signature (BIP-340 via `@noble/secp256k1`), checks the challenge tag, then matches the pubkey to registered identities.

If no registered identity matches, returns `VerifiedIdentity` with `identity: null` -- this triggers invite-gated provisioning.

**Fingerprint:** Lowercase hex of the pubkey (Nostr pubkeys are already 32-byte hex).

```bash
# 1. Request challenge (note: provider field)
curl -X POST "$EVE_API_URL/auth/challenge" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "nostr",
    "pubkey": "ab1234...hex..."
  }'

# Response: { "challenge_id": "...", "nonce": "...", "expires_at": "..." }

# 2. Sign a kind-22242 event (client-side, pseudocode):
# {
#   "kind": 22242,
#   "tags": [["challenge", "<nonce>"]],
#   "content": "",
#   "pubkey": "<your-hex-pubkey>",
#   "created_at": <unix-timestamp>,
#   "id": "<sha256-of-serialized-event>",
#   "sig": "<schnorr-signature>"
# }

# 3. Submit the signed event
curl -X POST "$EVE_API_URL/auth/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "challenge_id": "...",
    "signature": "{\"kind\":22242,\"tags\":[[\"challenge\",\"...\"]],\"content\":\"\",\"pubkey\":\"...\",\"created_at\":...,\"id\":\"...\",\"sig\":\"...\"}"
  }'

# Response: { "access_token": "...", "user_id": "...", "expires_at": ... }

# With invite code (for unregistered pubkeys):
curl -X POST "$EVE_API_URL/auth/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "challenge_id": "...",
    "signature": "{...signed event...}",
    "invite_code": "abc123..."
  }'
```

### NIP-98 Request Auth

Per-request authentication via the `Authorization: Nostr <base64>` header. No prior login needed.

The client creates a kind-27235 event with tags for URL, method, and body hash, then base64-encodes the JSON event and sends it in the Authorization header.

**Server validation steps:**

1. Verify event ID + Schnorr signature (BIP-340)
2. Assert `kind === 27235`
3. URL tag (`u`) must match the canonical request URL
4. Method tag must match request method
5. For non-GET requests: `payload` tag must equal `sha256(body)`
6. Timestamp must be within +/-60 seconds of server time
7. Replay protection: event ID is checked against `auth_request_replays` table (120s TTL)

**URL canonicalization** handles reverse proxies: scheme from `x-forwarded-proto`, host from `x-forwarded-host`, trailing slashes stripped, query params sorted.

```bash
# NIP-98 authenticated request (pseudocode for header construction):
#
# 1. Create kind-27235 event:
# {
#   "kind": 27235,
#   "tags": [
#     ["u", "https://api.eve.example.com/some/endpoint"],
#     ["method", "GET"]
#   ],
#   "content": "",
#   ...sign with Schnorr...
# }
#
# 2. Base64-encode the JSON event
# 3. Set header:

curl -X GET "$EVE_API_URL/some/endpoint" \
  -H "Authorization: Nostr $(echo -n '{"kind":27235,...}' | base64)"
```

## Invite-Gated Provisioning

When an unregistered identity authenticates (no matching fingerprint in the `identities` table), the system attempts to provision a new account via org invites.

### Creating an Invite

Admins create invites with optional provider and identity hints:

```bash
curl -X POST "$EVE_API_URL/auth/invites" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "org_id": "org_abc123",
    "provider_hint": "nostr",
    "identity_hint": "ab1234...hex-pubkey...",
    "role": "member",
    "expires_in_hours": 72
  }'

# Response:
# {
#   "id": "...",
#   "org_id": "org_abc123",
#   "invite_code": "...",
#   "provider_hint": "nostr",
#   "identity_hint": "ab1234...",
#   "role": "member",
#   "expires_at": "2026-02-13T...",
#   "used_at": null,
#   "created_at": "2026-02-10T..."
# }
```

### Provisioning Flow

1. Unregistered identity authenticates (challenge/verify or NIP-98 request auth)
2. Provider returns `VerifiedIdentity` with `identity: null`
3. `resolveVerifiedIdentity` is called, which:
   - Searches identities by fingerprint (in case the identity exists under another flow)
   - Calls `provisionViaInvite` if no match
4. Invite lookup: explicit `invite_code` takes priority, then falls back to `identity_hint` matching (`provider_hint` + `identity_hint` = `provider` + `externalId`)
5. Provisioning (atomic transaction):
   - Creates user with synthetic email (`<provider>:<externalId-prefix>@provision.local`)
   - Creates identity row linking the pubkey/fingerprint
   - Creates org membership with the invite's role
   - Marks invite as used

### Listing Invites

```bash
curl "$EVE_API_URL/auth/invites/org_abc123" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Database Schema

Migration `00042_nostr_identity.sql` adds:

### Modified: `auth_challenges`

```sql
ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'github_ssh';
ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE auth_challenges
  ALTER COLUMN user_id DROP NOT NULL;  -- nullable for Nostr (user may not exist yet)
```

### New: `auth_request_replays`

```sql
CREATE TABLE IF NOT EXISTS auth_request_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  replay_id TEXT NOT NULL,       -- e.g. Nostr event ID
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, replay_id)
);
```

Expired entries are purged every 5 minutes by `AuthModule`.

### New: `org_invites`

```sql
CREATE TABLE IF NOT EXISTS org_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  provider_hint TEXT,            -- e.g. 'nostr', 'github_ssh'
  identity_hint TEXT,            -- e.g. hex pubkey, SSH fingerprint
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Configuration

No new environment variables are required. Providers auto-register at startup via `AuthModule.onModuleInit()`.

The existing `EVE_AUTH_CHALLENGE_TTL_SECONDS` (default: 300) applies to all provider challenges. NIP-98 timestamp validation uses a hardcoded +/-60s window with 120s replay TTL.

## Adding a New Provider

1. Create a class implementing `IdentityProvider` in `apps/api/src/auth/providers/`
2. Export it from `providers/index.ts`
3. Add it to `AuthModule.providers` and inject it in the constructor
4. Register it in `onModuleInit()`

That is all. The auth guard, challenge/verify endpoints, and invite provisioning will pick it up automatically.

## Related Docs

- [Auth & Governance](./auth.md) -- JWT tokens, bootstrap, key rotation, RBAC
- [Chat Gateway](./chat-gateway.md) -- Gateway providers (Slack, Nostr relay)
- [Integrations](./integrations.md) -- External service connections
