# Identity Provider Framework + Gateway Plugin Architecture

> Status: Plan (reviewed 2026-02-09)
> Created: 2026-02-09
> Last Updated: 2026-02-09
>
> Dependencies:
> - Resource Management v2 (Phases 0-8) for billing integration
> - Agents/Teams/Threads primitives (already implemented)
>
> Architecture references:
> - `docs/ideas/platform-resource-plane.md` (Parts 2.1-2.3)
> - `docs/ideas/nostr-integration.md` (Nostr identity, DVMs, wallets)
> - `docs/ideas/nostrworld-agentic-paas.md` (north star vision)
> - `docs/ideas/channel-integrations-unified-plan-v3.md` (routing architecture)

## Review Findings

Issues found during codebase-validated review, addressed inline below:

**Factual corrections (plan vs codebase mismatches):**
- AuthGuard has an `isEnabled()` gate and Supabase HS256 mode — Phase 1 code omitted both
- `identities` query is `findByFingerprint(fingerprint)`, not `findByProviderAndFingerprint()` — Phase 1 used a non-existent method
- `ChatRouteRequest` already has a `user_id` field (external provider user_id) — Phase 5 said payloads "do not carry" identity; they do, but it's the wrong kind of user_id
- `findProjectMembership(userId, projectId)` is the actual query method — Phase 5 used `projectMembers.findMembership()`
- The actual DB layer is postgres.js with tagged template literals, not TypeORM/Drizzle

**Security gaps now addressed:**
- NIP-98 replay protection was commented out — now designed with full implementation
- Body hash verification for non-GET was a TODO comment — now specified
- `canonicalRequestUrl()` and `urlMatches()` were referenced but undefined — now defined
- Auth chain had no error handling — provider extraction/verification now wrapped in try/catch
- Replay table cleanup was missing — periodic purge now specified

**Architectural gaps now addressed:**
- Gateway provider interface forced webhook semantics on subscription-based providers — now split into `transport` modes
- Nostr provider had undeclared properties (`relayUrls`, `chatService`) — now properly declared
- Gateway startup discovery for Nostr relay connections was missing — now designed
- Provider lifecycle decision was left open — factory model chosen and justified
- Thread key format for Nostr was undefined — now specified
- Agent slug extraction for Nostr was handwaved — now specified
- Hot-reload and reconnection for Nostr integrations were missing — now addressed
- Open auto-provisioning replaced with invite-gated provisioning — identity verification is not authorization

## Why One Plan

Identity and gateway are coupled through Nostr: Nostr identity (NIP-98) provides request-level authentication, Nostr relays provide the message transport. Building one without the other leaves Nostr half-integrated. The pluggable identity framework also unblocks the gateway plugin architecture — each gateway provider (Slack, Nostr, Telegram) needs its own identity resolution path.

## Goals

1. **Pluggable identity verification**: Abstract the current SSH-only auth behind an `IdentityProvider` interface. Add Nostr NIP-98 as the second provider.
2. **Request-level auth chain**: Multiple authenticators tried in sequence (Bearer JWT → Nostr signature → Internal key), replacing the current single-path guard.
3. **Invite-gated provisioning**: New users join via org invite codes. No open self-registration — proving you own a keypair is not the same as being authorized to use the platform.
4. **Pluggable gateway**: Abstract the Slack-only gateway behind a `GatewayProvider` interface. Add Nostr relay as the second provider.
5. **Permission enforcement on routes**: The schema already has `permissions` on routes — enforce them.
6. **Thread session continuity**: Connect threads across gateway providers and maintain conversation context.

## Non-Goals

- OAuth/OIDC providers (Google, GitHub OAuth) — deferred, the interface supports them but we don't build them yet.
- Admin UI for integration management — CLI and API first.
- Lightning/Cashu payments — handled by balance ledger (v2 Phase 8) + payment provider plugins.
- Full NIP-90 DVM integration — that's nostrworld scope, beyond this plan.

## Current Reality

### Auth System (What Exists)

- **Auth Guard** (`apps/api/src/auth/auth.guard.ts`): Checks `authService.isEnabled()` first, then extracts Bearer token, verifies JWT (RS256 internal or HS256 Supabase), attaches `AuthUser` to request. Two global guards run: `AuthGuard` (authentication) then `PermissionGuard` (authorization via RBAC).
- **Auth Service** (`apps/api/src/auth/auth.service.ts`, ~926 lines): Three auth modes: `internal` (RS256), `supabase` (HS256), or `disabled`. Manages keyring with rotation (`EVE_AUTH_PUBLIC_KEY` + `EVE_AUTH_PUBLIC_KEY_OLD`). SSH challenge-response login via shell-out to `ssh-keygen`. Custom JWT implementation (no `jsonwebtoken` library). Bootstrap admin flow with 4 modes (auto-open, recovery, secure, closed).
- **`identities` table**: `(id, user_id, provider, public_key, fingerprint, label)` — `UNIQUE(provider, fingerprint)`. Query: `findByFingerprint(fingerprint)` returns matches across all providers for a given fingerprint.
- **`external_identities` table**: `(id, provider, account_id, external_user_id, eve_user_id)` — `UNIQUE(provider, account_id, external_user_id)`. Federation for Slack etc. Links external accounts to Eve users via membership approval.
- **`auth_challenges` table**: `(id, user_id, nonce, expires_at, used_at)` — challenge-response nonces with TTL. Currently SSH-only; no `provider` column.
- **RBAC**: `PermissionGuard` checks `@RequirePermission()` decorators. Role hierarchy: `member(1) < admin(2) < owner(3)`. System admins bypass all checks. Job tokens carry explicit `permissions[]` array.
- **DB access pattern**: postgres.js with `@Inject('DB')` token. All queries use tagged template literals. TypeID-based IDs (`user_xxxxxx`, `ident_xxxxxx`).

### Gateway (What Exists)

- **Slack controller** (`apps/gateway/src/slack.controller.ts`): Hardcoded Slack event handling — HMAC signature verification, URL verification challenge response, event parsing (app_mention + message), bot message filtering, agent command parsing (`@eve agents listen|unlisten|list|listening`).
- **Routing flow**: `Slack event → POST /internal/integrations/resolve → POST /internal/integrations/external-identities/resolve → parse command → POST /internal/orgs/{org}/chat/route (or /chat/dispatch for listeners) → Slack reply via chat.postMessage API`.
- **API client** (`apps/gateway/src/api-client.ts`): Simple HTTP wrapper using `EVE_API_URL` + `x-eve-internal-token` header.
- **Internal chat API**: `/internal/orgs/{org}/chat/route` (slug-based), `/chat/listen`, `/chat/unlisten`, `/chat/listeners`, `/chat/dispatch` — all provider-agnostic.
- **Thread + subscription model**: Threads keyed by `provider:account_id:channel_id[:thread_ts]`. Subscriptions at channel or thread scope. Agent deduplication on dispatch.
- **Team dispatch**: Fanout (parallel), council (parallel + lead), relay (sequential chain) modes.

### Alignment Notes (Important)

- **Internal service auth** is `@Public() + x-eve-internal-token` (validated inside internal controllers), not via `AuthGuard`. The gateway already uses `x-eve-internal-token` via `apps/gateway/src/api-client.ts`. **This must not change.** The auth chain only affects user-facing endpoints.
- **Membership roles** are constrained to `owner|admin|member` (DB check constraint `valid_org_role` / `valid_project_role`).
- `threads` already has `policy_json` for per-thread policy/config. Reuse it for session continuity policy.
- `integrations.tokens_json` is the current storage for provider tokens/config. There is no separate encrypted "platform secrets" store yet; any Nostr private keys stored here must be treated as sensitive (same as Slack tokens).
- **`ChatRouteRequest` has a `user_id` field** — but this is the *external provider user_id* (Slack user_id, etc.), not an Eve `user_id`. `ChatRouteBySlugRequest` extends it with `agent_slug_hint`, `command_text`, and `raw_text`. Neither carries `eve_user_id` or `external_identity_id`. Permissioned route enforcement requires adding those (Phase 5).
- **`users.email` is `NOT NULL UNIQUE`** — invite-provisioned Nostr users need synthetic emails (see Phase 2).

### What's Missing

- No plugin interface on either side (identity or gateway).
- Auth guard only tries Bearer JWT — no auth chain.
- No Nostr anything.
- Gateway is Slack-specific with no abstraction layer.
- Route permissions defined in schema but never enforced.
- No session/conversation continuity across messages.

---

## Phase 0: Identity Provider Interface + SSH Refactor

**Goal**: Extract the current SSH authentication into a pluggable `IdentityProvider` interface without changing any external behavior.

**New files**:

```
apps/api/src/auth/providers/
├── identity-provider.interface.ts    # The interface
├── provider-registry.ts              # Registry + resolution
├── ssh-identity.provider.ts          # Current SSH logic, extracted
└── index.ts
```

**Interface**:

```typescript
// identity-provider.interface.ts

export interface IdentityProvider {
  /** Provider name — matches identities.provider column */
  name: string;

  /**
   * Create a challenge for a user or prospective user.
   *
   * For established flows (SSH): userId is known from email/user_id lookup.
   * For Nostr: the caller may only have a pubkey; userId may be undefined
   * if the identity isn't registered yet (invite-provision scenario).
   *
   * The provider returns a nonce. The AuthService stores the challenge row
   * (with user_id if known, or null for pubkey-only challenges).
   */
  createChallenge(params: {
    userId?: string;
    pubkey?: string;
  }): Promise<ChallengeData>;

  /**
   * Verify a signed challenge response.
   * Returns the verified identity (user_id, provider, external_id) or null.
   *
   * For SSH: identities are pre-registered, so the list is always non-empty.
   * For Nostr: identities may be empty if the pubkey isn't registered yet —
   * the provider verifies the signature and returns externalId (pubkey hex)
   * without userId, signaling that invite lookup is needed.
   */
  verifyChallenge(
    challenge: AuthChallenge,
    proof: ChallengeProof,
    identities: Identity[],
  ): Promise<VerifiedIdentity | null>;

  /**
   * Extract credentials from an HTTP request (for request-level auth).
   * Returns null if this provider doesn't recognize the request.
   * Used by the auth chain — not by challenge/response login.
   */
  extractFromRequest?(req: FastifyRequest): ExtractedCredential | null;

  /**
   * Verify request-level credentials (extracted by extractFromRequest).
   * Returns a verified identity or null.
   */
  verifyRequestCredential?(
    credential: ExtractedCredential,
  ): Promise<VerifiedIdentity | null>;

  /**
   * Compute a canonical fingerprint for a public key.
   * Used for identity lookup and deduplication.
   */
  fingerprint(publicKey: string): Promise<string>;
}

export interface ChallengeData {
  nonce: string;
  /** Provider-specific instructions for the client */
  instructions?: string;
}

export interface ChallengeProof {
  signature: string;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface VerifiedIdentity {
  provider: string;
  externalId: string;    // fingerprint, pubkey hex, etc.
  /**
   * Set when the identity resolves to a known Eve user
   * (challenge-response with registered identity).
   * Null/undefined when the identity is valid but unregistered
   * (request-level auth → needs lookup/invite check).
   */
  userId?: string;
  displayName?: string;
  /** Provider-specific or flow-specific metadata (e.g., invite_code from request) */
  metadata?: Record<string, unknown>;
}

export interface ExtractedCredential {
  provider: string;
  /** Raw credential data — provider-specific */
  data: unknown;
}
```

**Provider Registry**:

```typescript
// provider-registry.ts

export class IdentityProviderRegistry {
  private providers = new Map<string, IdentityProvider>();

  register(provider: IdentityProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): IdentityProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Try extractFromRequest on each provider that supports it, first match wins.
   * Catches errors from individual providers to prevent one broken provider
   * from blocking the auth chain.
   */
  extractFromRequest(req: FastifyRequest): { provider: IdentityProvider; credential: ExtractedCredential } | null {
    for (const provider of this.providers.values()) {
      if (!provider.extractFromRequest) continue;
      try {
        const credential = provider.extractFromRequest(req);
        if (credential) return { provider, credential };
      } catch (err) {
        // Log and continue — one provider's parse failure shouldn't block others
        this.logger.warn(`Provider ${provider.name} extractFromRequest error: ${err}`);
      }
    }
    return null;
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}
```

**SSH Provider** (extract from `auth.service.ts`):

The current `verifyChallenge()` logic in `AuthService` moves to `SshIdentityProvider.verifyChallenge()`. Specifically:
- `verifySshSignature()` (shells out to `ssh-keygen -Y verify`) → `SshIdentityProvider.verifyChallenge()`
- `fingerprintPublicKey()` (shells out to `ssh-keygen -lf`) → `SshIdentityProvider.fingerprint()`
- SSH does not support request-level auth, so `extractFromRequest` and `verifyRequestCredential` are not implemented.

The `AuthService` becomes a thin orchestrator that delegates to the registry for provider-specific logic and keeps: token minting, challenge creation/lookup, bootstrap, JWKS.

**Code changes**:
- `apps/api/src/auth/auth.service.ts`: Extract SSH-specific verification into `SshIdentityProvider`. Keep token minting, challenge creation/lookup, and bootstrap in `AuthService`.
- `apps/api/src/auth/auth.module.ts`: Register `IdentityProviderRegistry` as a NestJS provider. Register `SshIdentityProvider` on module init. Inject registry into `AuthGuard`.

**Migration**: None. Pure refactor.

**Tests**:
- All existing auth integration tests must pass unchanged.
- New unit test: `SshIdentityProvider` verifies known SSH signatures correctly.

---

## Phase 1: Request-Level Auth Chain

**Goal**: Replace the single-path auth guard with a chain that tries multiple authenticators in order.

**Current flow**:
```
Request → AuthGuard → isEnabled()? → isPublic()? → extract Bearer token → verify JWT → AuthUser
```

**New flow**:
```
Request → AuthGuard → isEnabled()? → isPublic()? → auth chain:
  1. Bearer JWT (current — RS256 internal or HS256 Supabase) → if valid, done
  2. Provider-specific request auth (extractFromRequest) → if valid, resolve identity → done
  3. Reject (401)
```

**Note on internal services (gateway/orchestrator/worker):**

Internal endpoints stay `@Public()` and continue to validate `x-eve-internal-token` inside their controllers. This is intentionally separate from user-facing auth and must not be moved into `AuthGuard`.

**Auth Guard changes** (`auth.guard.ts`):

```typescript
async canActivate(context: ExecutionContext): Promise<boolean> {
  // Preserve existing behavior: if auth is disabled, allow all requests
  if (!this.authService.isEnabled()) return true;
  if (this.isPublic(context)) return true;

  const request = context.switchToHttp().getRequest();

  // IMPORTANT: do not require an Authorization header up-front.
  // Some providers (and future schemes) may authenticate via other headers or non-Bearer schemes.
  const authorization = request?.headers?.authorization;
  const header = Array.isArray(authorization) ? authorization[0] : authorization;

  // 1. Bearer JWT (existing path — handles both RS256 internal and HS256 Supabase tokens)
  if (header?.toLowerCase().startsWith('bearer ')) {
    request.user = await this.authService.verifyAuthorizationHeader(header);
    return true;
  }

  // 2. Try provider-specific request auth (new path)
  // Wrapped in try/catch so a broken provider can't crash the entire auth chain.
  try {
    const extracted = this.providerRegistry.extractFromRequest(request);
    if (extracted) {
      const verified = await extracted.provider.verifyRequestCredential!(extracted.credential);
      if (verified) {
        // Resolve to an AuthUser (lookup or invite-provision)
        request.user = await this.authService.resolveVerifiedIdentity(verified);
        return true;
      }
    }
  } catch (err) {
    // Log but don't expose provider internals to the client
    this.logger.warn(`Provider request auth failed: ${err}`);
  }

  throw new UnauthorizedException();
}
```

**New method on AuthService**:

```typescript
/**
 * Resolve a verified identity to an AuthUser.
 * Handles: existing user lookup, invite-gated provisioning, org membership.
 */
async resolveVerifiedIdentity(verified: VerifiedIdentity): Promise<AuthUser> {
  // 1. If the provider already resolved to a userId (challenge-response), use it
  if (verified.userId) {
    const user = await userQueries.findById(this.db, verified.userId);
    if (user) return this.buildAuthUser(user);
  }

  // 2. Look up by provider + fingerprint
  // Note: findByFingerprint returns all identities with that fingerprint.
  // Filter by provider to find the right one.
  const identities = await identityQueries.findByFingerprint(this.db, verified.externalId);
  const identity = identities.find(id => id.provider === verified.provider);

  if (identity) {
    const user = await userQueries.findById(this.db, identity.user_id);
    if (user) return this.buildAuthUser(user);
  }

  // 3. Check for a pending invite that matches this identity
  const provisioned = await this.provisionViaInvite(verified);
  if (provisioned) return this.buildAuthUser(provisioned);

  throw new UnauthorizedException('Unknown identity — request an invite from an org admin');
}

/**
 * Check if a verified but unregistered identity has a pending invite.
 * If so, create user + identity + org membership in one transaction and consume the invite.
 *
 * Invite matching: by invite code (passed in verified.metadata.invite_code)
 * or by pre-targeted identity (invite.identity_hint matches verified.externalId).
 */
private async provisionViaInvite(verified: VerifiedIdentity): Promise<User | null> {
  // 1. Check for invite code in request metadata (e.g., X-Eve-Invite header or challenge metadata)
  const inviteCode = verified.metadata?.invite_code as string | undefined;

  let invite: OrgInvite | null = null;

  if (inviteCode) {
    invite = await inviteQueries.findByCode(this.db, inviteCode);
  } else {
    // 2. Check for pre-targeted invite matching this identity
    invite = await inviteQueries.findByIdentityHint(
      this.db,
      verified.provider,
      verified.externalId,
    );
  }

  if (!invite || invite.used_at || (invite.expires_at && invite.expires_at < new Date())) {
    return null;
  }

  return this.db.begin(async (tx) => {
    // 1. Create user with synthetic email
    const syntheticEmail = `${verified.provider}:${verified.externalId.slice(0, 16)}@provision.local`;
    const user = await userQueries.create(tx, {
      email: syntheticEmail,
      display_name: verified.displayName ?? `${verified.provider}:${verified.externalId.slice(0, 8)}`,
    });

    // 2. Create identity row
    await identityQueries.create(tx, {
      user_id: user.id,
      provider: verified.provider,
      public_key: verified.externalId,
      fingerprint: verified.externalId,
    });

    // 3. Add to the inviting org with the role specified in the invite
    await membershipQueries.upsertOrgMembership(tx, {
      org_id: invite.org_id,
      user_id: user.id,
      role: invite.role ?? 'member',
    });

    // 4. Consume the invite
    await inviteQueries.markUsed(tx, invite.id, user.id);

    return user;
  });
}
```

**Invite-gated provisioning**:

New users join via org invite codes. No open self-registration.

**Invite creation** (org admin):
```bash
eve org invite create --org org_xxx --role member             # General invite code
eve org invite create --org org_xxx --pubkey <hex> --provider nostr  # Pre-targeted invite
eve org invite create --org org_xxx --expires 7d              # Expires in 7 days
```

**Invite table** (`org_invites`):
```
id            UUID PRIMARY KEY
org_id        UUID NOT NULL REFERENCES orgs(id)
created_by    UUID NOT NULL REFERENCES users(id)
invite_code   TEXT NOT NULL UNIQUE          -- e.g., "EVE-XXXX-XXXX"
provider_hint TEXT                           -- optional: restrict to provider (e.g., 'nostr')
identity_hint TEXT                           -- optional: pre-target a specific pubkey/fingerprint
role          TEXT NOT NULL DEFAULT 'member' -- role granted on join
expires_at    TIMESTAMPTZ                    -- null = no expiry
used_at       TIMESTAMPTZ                    -- null = unused
used_by       UUID REFERENCES users(id)     -- who consumed it
created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Provisioning flow**:
1. User authenticates (NIP-98 or challenge-response) — identity is verified but unregistered.
2. System checks for a matching invite: either by `invite_code` (from `X-Eve-Invite` header or challenge metadata) or by `identity_hint` matching the verified pubkey.
3. If invite found and valid (not expired, not used): create user + identity + org membership in one transaction, consume invite.
4. If no invite: reject with 401 ("Unknown identity — request an invite from an org admin").
5. Return `AuthUser` (caller can mint JWT if needed).

**Gateway interactions (no invite needed)**: Messages via Slack/Nostr DMs from unknown users still create `external_identities` + `membership_requests` rows. The user can interact but has no Eve account — the org admin approves the membership request to link them. This is the existing flow and remains unchanged.

**Dev/demo mode** (optional, off by default):
```
EVE_AUTH_OPEN_PROVISION=true    # Skip invite check — any verified identity gets an account
                                 # NEVER enable in production
```

**Tests**:
- Integration: request with Bearer JWT still works (regression).
- Integration: request with no auth returns 401.
- Integration: request with valid provider credential (mock) authenticates.
- Integration: verified identity with valid invite code provisions user + org membership.
- Integration: verified identity with pre-targeted invite (identity_hint) provisions without code.
- Integration: verified identity with no invite returns 401.
- Integration: expired invite returns 401.
- Integration: already-used invite returns 401.
- Integration: disabled auth (`EVE_AUTH_ENABLED=false`) still allows all requests.

---

## Phase 2: Nostr NIP-98 Identity Provider

**Goal**: Implement Nostr NIP-98 as the second identity provider — both for challenge-response login and request-level auth.

### NIP-98 Background

NIP-98 defines HTTP Auth using Nostr events. The client signs a Nostr event with:
- `kind: 27235`
- `tags: [["u", "<url>"], ["method", "<HTTP method>"], ["payload", "<sha256-of-body>"]]`
- `created_at`: within ±60 seconds of server time

The signed event is sent as: `Authorization: Nostr <base64-encoded-event>`.

The server verifies the event signature (secp256k1 Schnorr), checks the URL and method match, verifies the body hash for non-GET requests, and checks the timestamp.

### Security Requirements (Must-Haves)

- **Strict URL canonicalization**: NIP-98 tags typically include a full URL; the server must build and compare a canonical URL string (scheme + host + path, query sorted) derived from the request headers and URL. Avoid partial matching. Implementation defined below.
- **Replay protection**: deny replays of the same `event.id` within the allowed timestamp window (distributed-safe via DB, not in-memory). Implementation defined below.
- **Body binding for non-GET**: for `POST|PUT|PATCH|DELETE`, require and verify a `payload` tag containing SHA-256 hex of the raw request body. Implementation defined below.

### New files

```
apps/api/src/auth/providers/nostr-identity.provider.ts
apps/api/src/auth/providers/replay-store.ts              # Shared replay protection
packages/shared/src/crypto/nostr.ts                      # secp256k1 verification utilities
```

### Dependencies

```
@noble/secp256k1      # Pure JS secp256k1 (no native deps, fast)
@noble/hashes         # SHA-256 for Nostr event ID computation + body hash
```

These are lightweight, audited, pure-JS crypto libraries by Paul Miller — no native compilation required.

### URL Canonicalization

```typescript
// packages/shared/src/crypto/nostr.ts

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Build canonical URL from a Fastify request.
 * Scheme is derived from x-forwarded-proto (behind proxy) or request protocol.
 * Host from x-forwarded-host or host header.
 * Path from request URL.
 * Query params sorted alphabetically for deterministic comparison.
 */
export function canonicalRequestUrl(req: FastifyRequest): string {
  const scheme = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.hostname;
  const url = new URL(req.url, `${scheme}://${host}`);
  url.searchParams.sort();
  // Strip trailing slash for consistency, preserve root "/"
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const query = url.search; // includes "?" prefix if non-empty
  return `${url.protocol}//${url.host}${path}${query}`;
}

/**
 * Compare two URLs for NIP-98 matching.
 * Both are parsed and canonicalized before comparison.
 * Query params are sorted so order doesn't matter.
 */
export function urlMatches(tagUrl: string, canonicalUrl: string): boolean {
  try {
    const a = new URL(tagUrl);
    const b = new URL(canonicalUrl);
    a.searchParams.sort();
    b.searchParams.sort();
    // Compare scheme, host, path, sorted query
    return (
      a.protocol === b.protocol &&
      a.host === b.host &&
      a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

/**
 * Compute SHA-256 hex of a string (for NIP-98 body hash).
 */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}
```

### Replay Protection Store

```typescript
// apps/api/src/auth/providers/replay-store.ts

export class ReplayStore {
  constructor(private db: Db) {}

  /**
   * Assert that this (provider, replayId) has not been seen before.
   * Inserts a row with TTL. Throws if duplicate.
   * Uses ON CONFLICT to make this safe under concurrent requests.
   */
  async assertNotReplayed(provider: string, replayId: string, opts: { ttlSeconds: number }): Promise<void> {
    const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);
    const result = await this.db`
      INSERT INTO auth_request_replays (provider, replay_id, expires_at)
      VALUES (${provider}, ${replayId}, ${expiresAt})
      ON CONFLICT (provider, replay_id) DO NOTHING
      RETURNING id
    `;
    if (result.length === 0) {
      throw new UnauthorizedException('Replay detected');
    }
  }

  /**
   * Purge expired replay entries. Call periodically (e.g., every 5 minutes via cron/interval).
   */
  async purgeExpired(): Promise<number> {
    const result = await this.db`
      DELETE FROM auth_request_replays
      WHERE expires_at < NOW()
    `;
    return result.count;
  }
}
```

### NostrIdentityProvider

```typescript
// nostr-identity.provider.ts

export class NostrIdentityProvider implements IdentityProvider {
  name = 'nostr';

  constructor(
    private replayStore: ReplayStore,
  ) {}

  async createChallenge(params: { userId?: string; pubkey?: string }): Promise<ChallengeData> {
    // Nostr challenge: random 32-byte nonce
    // Client signs a kind-22242 event (NIP-42 AUTH) with the nonce as a tag
    const nonce = randomBytes(32).toString('hex');
    return {
      nonce,
      instructions: 'Sign a kind-22242 Nostr event with tag ["challenge", "<nonce>"]',
    };
  }

  async verifyChallenge(
    challenge: AuthChallenge,
    proof: ChallengeProof,
    identities: Identity[],
  ): Promise<VerifiedIdentity | null> {
    // Parse the signed Nostr event from proof.signature
    let event: NostrEvent;
    try {
      event = JSON.parse(proof.signature);
    } catch {
      return null;
    }

    // Verify event signature (secp256k1)
    if (!verifyNostrEvent(event)) return null;

    // Check the challenge nonce is in the event tags
    const challengeTag = event.tags.find(
      (t: string[]) => t[0] === 'challenge' && t[1] === challenge.nonce,
    );
    if (!challengeTag) return null;

    // Check the pubkey matches one of the user's registered identities
    const pubkeyHex = event.pubkey;
    const matchingIdentity = identities.find(
      (id) => id.provider === 'nostr' && id.fingerprint === pubkeyHex,
    );

    if (matchingIdentity) {
      return {
        userId: matchingIdentity.user_id,
        provider: 'nostr',
        externalId: pubkeyHex,
      };
    }

    // No registered identity — return verified but without userId.
    // AuthService will check for a pending invite.
    return {
      provider: 'nostr',
      externalId: pubkeyHex,
    };
  }

  extractFromRequest(req: FastifyRequest): ExtractedCredential | null {
    // NIP-98: Authorization: Nostr <base64-event>
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Nostr ')) return null;

    const base64Event = authHeader.slice(6);
    try {
      const event = JSON.parse(Buffer.from(base64Event, 'base64').toString());
      return {
        provider: 'nostr',
        data: {
          event,
          url: canonicalRequestUrl(req),
          method: req.method,
          // Capture raw body for payload hash verification (non-GET)
          rawBody: (req as any).rawBody as string | undefined,
        },
      };
    } catch {
      return null;
    }
  }

  async verifyRequestCredential(credential: ExtractedCredential): Promise<VerifiedIdentity | null> {
    const { event, url, method, rawBody } = credential.data as {
      event: NostrEvent;
      url: string;
      method: string;
      rawBody?: string;
    };

    // 1. Verify event signature
    if (!verifyNostrEvent(event)) return null;

    // 2. Check kind === 27235
    if (event.kind !== 27235) return null;

    // 3. Check URL tag matches canonical request URL
    const urlTag = event.tags.find((t: string[]) => t[0] === 'u');
    if (!urlTag || !urlMatches(urlTag[1], url)) return null;

    // 4. Check method tag matches request method
    const methodTag = event.tags.find((t: string[]) => t[0] === 'method');
    if (!methodTag || methodTag[1].toUpperCase() !== method.toUpperCase()) return null;

    // 5. Body hash verification for non-GET methods
    if (method.toUpperCase() !== 'GET') {
      const payloadTag = event.tags.find((t: string[]) => t[0] === 'payload');
      if (!payloadTag) return null; // Body hash required for non-GET
      if (!rawBody) return null;    // Raw body must be available
      const expectedHash = sha256Hex(rawBody);
      if (payloadTag[1] !== expectedHash) return null;
    }

    // 6. Check timestamp (within ±60 seconds)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(event.created_at - now) > 60) return null;

    // 7. Replay protection: reject if we've already accepted this event.id
    // TTL is 120s (double the ±60s window) to cover clock skew edge cases.
    await this.replayStore.assertNotReplayed('nostr', event.id, { ttlSeconds: 120 });

    return {
      provider: 'nostr',
      externalId: event.pubkey,
    };
  }

  async fingerprint(publicKey: string): Promise<string> {
    // Nostr pubkeys are already hex — normalize to lowercase
    return publicKey.toLowerCase();
  }
}
```

### Shared crypto utilities

```typescript
// packages/shared/src/crypto/nostr.ts

import { schnorr } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Compute the canonical event ID (SHA-256 of serialized event) */
export function computeEventId(event: Omit<NostrEvent, 'id' | 'sig'>): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

/** Verify a Nostr event: check ID computation + Schnorr signature */
export function verifyNostrEvent(event: NostrEvent): boolean {
  // 1. Recompute and verify event ID
  const expectedId = computeEventId({
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
  });
  if (event.id !== expectedId) return false;

  // 2. Verify Schnorr signature (BIP-340)
  try {
    return schnorr.verify(event.sig, event.id, event.pubkey);
  } catch {
    return false;
  }
}

// canonicalRequestUrl, urlMatches, sha256Hex defined above (co-located here)
```

### Fastify Raw Body Access

NIP-98 body hash verification requires the raw request body. Fastify doesn't preserve it by default. Add the `fastify-raw-body` plugin (or equivalent) to the API app:

```typescript
// apps/api/src/main.ts (or app setup)
await app.register(import('fastify-raw-body'), {
  field: 'rawBody',
  global: false,           // Only capture for routes that need it
  encoding: 'utf8',
  runFirst: true,
});
```

Alternatively, use a Fastify `onRequest` hook to capture `req.rawBody` for non-GET requests on auth-protected routes only (avoids memory overhead for all requests).

### CLI changes

```typescript
// New login flow: eve auth login --provider nostr [--invite EVE-XXXX-XXXX]
// 1. CLI holds Nostr keypair (or derives from nsec, or uses NIP-46 remote signer)
// 2. POST /auth/challenge { provider: 'nostr', pubkey: '<hex>' }
//    Server looks up identities(provider='nostr', fingerprint=<pubkey>).
//    If found: creates challenge tied to user_id.
//    If not found: creates challenge with user_id=null, stores pubkey in metadata.
//      (Challenge creation doesn't require an invite — verification does.)
// 3. Server returns { challenge_id, nonce }
// 4. CLI signs kind-22242 event with ["challenge", nonce] tag
// 5. POST /auth/verify { challenge_id, signature: JSON.stringify(signedEvent), invite_code?: 'EVE-...' }
// 6. Server verifies signature → if known identity, returns JWT.
//    If unknown identity + valid invite → provisions user, consumes invite, returns JWT.
//    If unknown identity + no invite → 401.
```

**Alternative (simpler):** skip token minting and use NIP-98 request auth for every CLI request (store `nsec`, sign each request, send `Authorization: Nostr ...`). This avoids introducing new "mint JWT from request-auth" endpoints. Trade-off: every request incurs signature + DB replay check overhead vs one challenge-response flow.

**CLI key storage**: Store Nostr private key in the same credential store as SSH tokens (`~/.config/eve/credentials`), encrypted. Or support NIP-46 (Nostr Connect) for remote signing — deferred.

**Schema changes** (`packages/shared/src/schemas/auth.ts`):

```typescript
// Extend challenge request to accept provider
export const AuthChallengeRequestSchema = z.object({
  provider: z.enum(['github_ssh', 'nostr']).default('github_ssh'),
  email: z.string().email().optional(),       // For SSH / fallback
  user_id: z.string().optional(),             // For SSH / fallback
  pubkey: z.string().optional(),              // For Nostr (hex pubkey)
}).superRefine((value, ctx) => {
  if (value.provider === 'github_ssh') {
    if (!value.email && !value.user_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'email or user_id is required for github_ssh' });
    }
  }

  if (value.provider === 'nostr') {
    if (!value.pubkey && !value.email && !value.user_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pubkey or (email/user_id) is required for nostr' });
    }
  }
});

// Challenge verification request — includes optional invite code for new users
export const AuthVerifyRequestSchema = z.object({
  challenge_id: z.string(),
  signature: z.string(),
  invite_code: z.string().optional(),  // For unregistered identities joining via invite
});
```

### DB migration

```sql
-- Use next available migration number (placeholder: 00042)
-- 00042_nostr_identity.sql

-- Add provider column to auth_challenges (currently implicit SSH-only)
ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'github_ssh';

-- Add metadata for provider-specific challenge data (e.g., pubkey for Nostr challenges)
ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Allow null user_id for Nostr challenges where the user doesn't exist yet
-- Current constraint: user_id is NOT NULL with FK to users(id)
-- Change: make user_id nullable (existing SSH challenges always have user_id set)
ALTER TABLE auth_challenges
  ALTER COLUMN user_id DROP NOT NULL;

-- Note: identities already has UNIQUE(provider, fingerprint), which creates an index.

-- Replay protection for request-level auth (e.g., NIP-98 event.id)
CREATE TABLE IF NOT EXISTS auth_request_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  replay_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, replay_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_request_replays_expires_at
  ON auth_request_replays(expires_at);

-- Org invite codes for gated provisioning
CREATE TABLE IF NOT EXISTS org_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  created_by UUID NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  provider_hint TEXT,                            -- optional: restrict to provider
  identity_hint TEXT,                            -- optional: pre-target a pubkey/fingerprint
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  expires_at TIMESTAMPTZ,                        -- null = no expiry
  used_at TIMESTAMPTZ,                           -- null = unused
  used_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_invites_identity_hint
  ON org_invites(provider_hint, identity_hint) WHERE identity_hint IS NOT NULL AND used_at IS NULL;

-- Schedule periodic cleanup (alternative: application-level setInterval)
-- The API should call ReplayStore.purgeExpired() every 5 minutes.
```

### Replay Table Cleanup

The `auth_request_replays` table accumulates rows. Cleanup options (pick one):

1. **Application-level**: `setInterval(() => replayStore.purgeExpired(), 5 * 60 * 1000)` in the API bootstrap.
2. **pg_cron** (if available): `SELECT cron.schedule('purge-replays', '*/5 * * * *', 'DELETE FROM auth_request_replays WHERE expires_at < NOW()');`

Option 1 is simpler and doesn't require pg_cron. Use it.

### Invite-Provisioned Users and Email Constraint (Important)

`users.email` is `NOT NULL UNIQUE`. Users provisioned via invite (without a real email) need a deterministic, collision-safe synthetic email:

- Format: `nostr:<pubkey_hex_prefix_16chars>@provision.local`
- The 16-char prefix makes collisions astronomically unlikely while keeping emails human-scannable.
- Policy for later attaching a real email: add an `eve auth link-email` CLI command that updates the user's email (with email verification). Deferred to a follow-up.

### Identity registration

```bash
# Register a Nostr identity for an existing user
eve auth add-identity --provider nostr --pubkey <hex-pubkey>

# Or: import from nsec
eve auth add-identity --provider nostr --nsec <nsec1...>
```

On the server side, this creates an `identities` row with `provider = 'nostr'`, `public_key = pubkey_hex`, and `fingerprint = pubkey_hex` (Nostr pubkeys are their own fingerprint).

**Tests**:
- Unit: `verifyNostrEvent()` with known test vectors.
- Unit: `canonicalRequestUrl()` with various request shapes (proxied, direct, with query params).
- Unit: `urlMatches()` rejects mismatched host, path, query, scheme.
- Unit: NIP-98 extraction from Authorization header.
- Unit: Body hash verification (correct hash passes, wrong hash rejected, missing hash on POST rejected).
- Unit: Timestamp drift rejection (>60s).
- Unit: Replay rejection for duplicate `event.id` within TTL window.
- Integration: Full Nostr challenge-response login flow (registered identity).
- Integration: Nostr challenge-response with unregistered pubkey + valid invite → provisions user, returns token.
- Integration: Nostr challenge-response with unregistered pubkey + no invite → 401.
- Integration: NIP-98 request-level auth with pre-targeted invite → provisions and authenticates.
- Integration: NIP-98 request-level auth with no invite and unknown identity → 401.

---

## Phase 3: Gateway Provider Interface + Slack Refactor

**Goal**: Abstract the gateway into a plugin architecture and refactor Slack as the first plugin.

### Gateway Provider Interface

The key insight: Slack uses webhooks (push), Nostr uses relay subscriptions (pull). The interface must support both transport models without forcing one to pretend it's the other.

```typescript
// apps/gateway/src/providers/gateway-provider.interface.ts

export type GatewayTransport = 'webhook' | 'subscription';

export interface GatewayProvider {
  /** Provider name — matches integrations.provider column */
  name: string;

  /** Transport model: 'webhook' for HTTP push, 'subscription' for persistent connections */
  transport: GatewayTransport;

  /** Supported capabilities */
  capabilities: ('inbound' | 'outbound' | 'identity' | 'presence')[];

  /**
   * Initialize the provider for a specific integration.
   * - Webhook providers: register webhook URL patterns, validate config.
   * - Subscription providers: connect to relays/servers, start subscriptions.
   */
  initialize(config: ProviderConfig): Promise<void>;

  /** Graceful shutdown */
  shutdown(): Promise<void>;

  // --- Webhook transport methods (only called when transport === 'webhook') ---

  /**
   * Validate an inbound webhook/event signature.
   * Called before parsing — rejects unsigned/tampered requests.
   * Slack-style providers need access to the raw body for HMAC verification.
   */
  validateWebhook?(req: FastifyRequest & { rawBody?: string }): WebhookValidation;

  /**
   * Parse a raw inbound webhook event into a normalized message.
   * Returns null if the event should be ignored (e.g., bot's own messages).
   * Returns a special response for protocol handshakes (e.g., Slack url_verification).
   */
  parseWebhook?(req: FastifyRequest): Promise<WebhookParseResult>;

  // --- Shared methods ---

  /**
   * Send a message via this provider.
   * Used for replies, notifications, and proactive messages.
   */
  sendMessage(target: OutboundTarget, content: MessageContent): Promise<void>;

  /**
   * Resolve an external user identity to an Eve identity.
   * Delegates to the integrations service for mapping.
   */
  resolveIdentity?(externalUserId: string, accountId: string): Promise<ResolvedIdentity | null>;
}

export type WebhookValidation =
  | { valid: true }
  | { valid: false; status: number; body?: unknown };

export type WebhookParseResult =
  | { type: 'message'; inbound: NormalizedInbound }
  | { type: 'handshake'; response: { status: number; body: unknown } }  // e.g., Slack url_verification
  | { type: 'ignored' };  // Bot's own messages, etc.

export interface NormalizedInbound {
  /** Raw provider event type for logging */
  rawType: string;
  /** Provider name */
  provider: string;
  /** Integration account ID (Slack team_id, Nostr destination pubkey, etc.) */
  accountId: string;
  /** External user ID in the provider */
  externalUserId: string;
  /** Channel/room/relay identifier */
  channel: string;
  /** Thread identifier (for threading support) */
  threadId?: string;
  /** Extracted text content */
  text: string;
  /** Extracted agent slug hint (e.g., from @mention or DM context) */
  agentSlugHint?: string;
  /** Provider-specific event ID for deduplication */
  dedupeKey?: string;
  /** Raw payload for provider-specific processing */
  raw: unknown;

  /**
   * Populated by GatewayChatService after identity resolution (not by provider).
   * Enables permissioned route enforcement in the API.
   */
  externalIdentityId?: string;
  eveUserId?: string | null;
  membershipRequestId?: string | null;
}

export interface OutboundTarget {
  provider: string;
  accountId: string;
  channel: string;
  threadId?: string;
}

export interface MessageContent {
  text: string;
  /** Provider-specific formatting hints */
  blocks?: unknown;
}

export interface ProviderConfig {
  /** Integration row from DB */
  integration: Integration;
  /** Provider-specific config from integration.tokens_json or system settings */
  settings: Record<string, unknown>;
}

export interface ResolvedIdentity {
  externalIdentityId: string;
  eveUserId: string | null;
  membershipRequestId?: string | null;
  orgId: string;
}
```

### Provider Registry (Factory Model)

**Decision: Factory model.** Each `initialize()` call creates a per-integration instance. The registry stores instances keyed by `(provider, account_id)`. This is cleaner than the manager model because:
- Each integration's connection state is isolated.
- Shutdown of one integration doesn't affect others.
- State management is straightforward (no internal maps).

```typescript
// apps/gateway/src/providers/provider-registry.ts

export class GatewayProviderRegistry {
  /** Provider factories: name → constructor/factory */
  private factories = new Map<string, GatewayProviderFactory>();

  /** Active instances: "provider:account_id" → initialized instance */
  private instances = new Map<string, GatewayProvider>();

  registerFactory(name: string, factory: GatewayProviderFactory): void {
    this.factories.set(name, factory);
  }

  /** Get an active instance by provider name and account_id */
  getInstance(provider: string, accountId: string): GatewayProvider | undefined {
    return this.instances.get(`${provider}:${accountId}`);
  }

  /** Get any active instance by provider name (for webhook routing where account_id is unknown until parsing) */
  getByProvider(provider: string): GatewayProvider | undefined {
    for (const [key, instance] of this.instances) {
      if (key.startsWith(`${provider}:`)) return instance;
    }
    return undefined;
  }

  /** Initialize all integrations. Called on gateway startup. */
  async initializeAll(integrations: Integration[]): Promise<void> {
    for (const integration of integrations) {
      await this.initializeOne(integration);
    }
  }

  /** Initialize a single integration (for hot-reload when new integrations are added) */
  async initializeOne(integration: Integration): Promise<void> {
    const factory = this.factories.get(integration.provider);
    if (!factory) return;

    const key = `${integration.provider}:${integration.account_id}`;
    // Shutdown existing instance if reinitializing
    const existing = this.instances.get(key);
    if (existing) await existing.shutdown();

    const instance = factory.create();
    await instance.initialize({
      integration,
      settings: integration.tokens_json ?? {},
    });
    this.instances.set(key, instance);
  }

  async shutdownAll(): Promise<void> {
    for (const instance of this.instances.values()) {
      await instance.shutdown();
    }
    this.instances.clear();
  }
}

export interface GatewayProviderFactory {
  create(): GatewayProvider;
}
```

### Generic Webhook Controller

Handles webhook-transport providers only. Subscription-transport providers manage their own lifecycle and route through `GatewayChatService` directly.

```typescript
// apps/gateway/src/webhook/webhook.controller.ts

@Controller('gateway/providers')
export class WebhookController {
  constructor(
    private registry: GatewayProviderRegistry,
    private chatService: GatewayChatService,
  ) {}

  @Post(':provider/webhook')
  async handleWebhook(
    @Param('provider') providerName: string,
    @Req() req: FastifyRequest & { rawBody?: string },
    @Res() res: FastifyReply,
  ): Promise<void> {
    const provider = this.registry.getByProvider(providerName);
    if (!provider || provider.transport !== 'webhook') {
      res.status(404).send({ error: `Unknown webhook provider: ${providerName}` });
      return;
    }

    // 1. Validate signature
    const validation = provider.validateWebhook!(req);
    if (!validation.valid) {
      res.status(validation.status).send(validation.body ?? { error: 'Invalid signature' });
      return;
    }

    // 2. Parse inbound event (handles handshakes, ignored events, and real messages)
    const parsed = await provider.parseWebhook!(req);

    if (parsed.type === 'handshake') {
      // Protocol handshake (e.g., Slack url_verification)
      res.status(parsed.response.status).send(parsed.response.body);
      return;
    }

    if (parsed.type === 'ignored') {
      res.status(200).send({ ok: true });
      return;
    }

    // 3. Route message through shared chat service
    const result = await this.chatService.resolveAndRoute(parsed.inbound);

    // 4. Send reply if synchronous
    if (result.immediateReply) {
      await provider.sendMessage(
        { provider: providerName, accountId: parsed.inbound.accountId, channel: parsed.inbound.channel, threadId: parsed.inbound.threadId },
        result.immediateReply,
      );
    }

    res.status(200).send({ ok: true });
  }
}
```

### Slack Provider (Refactor)

Move existing Slack controller logic into `SlackGatewayProvider`:

```
apps/gateway/src/providers/slack/
├── slack.provider.ts           # Implements GatewayProvider (transport: 'webhook')
├── slack-signature.ts          # HMAC verification (extracted)
├── slack-parser.ts             # Event parsing (extracted)
└── slack-sender.ts             # chat.postMessage via Slack API (extracted)
```

The Slack provider:
- `transport = 'webhook'`
- `validateWebhook()`: HMAC with `x-slack-signature` + `x-slack-request-timestamp`.
- `parseWebhook()`: Returns `{ type: 'handshake' }` for `url_verification`, `{ type: 'ignored' }` for bot messages, `{ type: 'message', inbound }` for real messages. Extracts text, user, channel, thread_ts. Parses `@agent` mentions for agent slug hint. Sets `dedupeKey = 'slack:' + event.event_id`.
- `sendMessage()`: POST to `chat.postMessage` via Slack API (not incoming webhook — the current implementation uses the Slack API directly).

**URL routing**: Existing Slack URL `POST /integrations/slack/events` must remain functional (backwards compatibility). Add a redirect or alias:
```
POST /integrations/slack/events → POST /gateway/providers/slack/webhook
```

**Also note:** there is a separate API webhook endpoint at `apps/api/src/integrations/slack.controller.ts` (`POST /integrations/slack/events/:projectId`) that normalizes Slack events into Eve `events`. This plan is about the *gateway chat controller* (`apps/gateway/src/slack.controller.ts`), not the API event-ingestion endpoint.

### Gateway Chat Service (Shared Logic)

Extract the routing logic from the Slack controller into a shared service used by both webhook and subscription providers:

```typescript
// apps/gateway/src/chat/gateway-chat.service.ts

export class GatewayChatService {
  constructor(
    private api: GatewayApiClient,
  ) {}

  async resolveAndRoute(inbound: NormalizedInbound): Promise<RouteResult> {
    // 1. Resolve integration (provider + accountId → org_id)
    const integration = await this.api.resolveIntegration(
      inbound.provider,
      inbound.accountId,
    );

    // 2. Resolve external identity (provider + user → eve_user + membership request)
    const identity = await this.api.resolveExternalIdentity(
      integration.org_id,
      inbound.provider,
      inbound.accountId,
      inbound.externalUserId,
    );

    // Enrich inbound with resolved identity (for permission enforcement downstream)
    inbound.externalIdentityId = identity.external_identity_id;
    inbound.eveUserId = identity.eve_user_id;
    inbound.membershipRequestId = identity.membership_request_id;

    // 3. Check for agent commands (listen, unlisten, list)
    const command = parseAgentCommand(inbound.text);
    if (command) {
      return this.handleAgentCommand(command, integration, identity, inbound);
    }

    // 4. Route to agent/team via internal chat API.
    // Pass through eve_user_id so the API can enforce route permissions.
    return this.routeToAgent(inbound, integration, identity);
  }

  private async routeToAgent(
    inbound: NormalizedInbound,
    integration: ResolvedIntegration,
    identity: ResolvedExternalIdentity,
  ): Promise<RouteResult> {
    // Build ChatRouteBySlugRequest with identity fields
    const routePayload = {
      provider: inbound.provider,
      account_id: inbound.accountId,
      channel_id: inbound.channel,
      user_id: inbound.externalUserId,
      text: inbound.text,
      agent_slug_hint: inbound.agentSlugHint ?? integration.default_agent_slug,
      command_text: inbound.text, // After stripping slug prefix
      raw_text: inbound.text,
      thread_key: this.buildThreadKey(inbound),
      metadata: {
        dedupe_key: inbound.dedupeKey,
        // Identity context for route permission enforcement
        external_identity_id: identity.external_identity_id,
        eve_user_id: identity.eve_user_id,
      },
    };

    return this.api.routeBySlug(integration.org_id, routePayload);
  }

  /**
   * Build a deterministic thread key from inbound message data.
   * Format: "provider:account_id:channel[:thread_id]"
   */
  private buildThreadKey(inbound: NormalizedInbound): string {
    const parts = [inbound.provider, inbound.accountId, inbound.channel];
    if (inbound.threadId) parts.push(inbound.threadId);
    return parts.join(':');
  }
}
```

### Dedupe (Slack Retries, Multi-Relay Duplicates)

Inbound providers may deliver duplicate events:

- Slack will retry delivery on timeouts and sometimes redeliver events.
- Nostr relays can deliver the same event via multiple connections/subscriptions.

Each provider sets `dedupeKey` on `NormalizedInbound`:
- Slack: `slack:${event_id}`
- Nostr: `nostr:${event.id}` (the Nostr event hash — globally unique)

The gateway passes `dedupe_key` via `metadata` in the chat route request. The API-side `events` table already has a `dedupe_key` column — the `recordThreadAndEvent()` method in `chat.service.ts` should use it to skip duplicate events (ON CONFLICT DO NOTHING on the dedupe_key).

**Tests**:
- Integration: Slack webhook still works through new plugin path.
- Integration: Slack `url_verification` challenge is handled correctly.
- Unit: `SlackGatewayProvider` parses known Slack event fixtures.
- Unit: `GatewayChatService` routes to correct agents.
- Unit: Duplicate events with same `dedupeKey` are idempotent.

---

## Phase 4: Nostr Relay Gateway Provider

**Goal**: Implement the Nostr relay as a second gateway provider, enabling agents to receive commands and reply via Nostr DMs and mentions.

### Architecture

Unlike Slack (webhook-push), Nostr uses relay subscriptions (pull). The Nostr provider:
1. Connects to one or more relays via WebSocket.
2. Subscribes to events mentioning the integration's destination pubkey (`integrations.account_id`).
3. Receives events, verifies signatures, normalizes, and routes through the shared `GatewayChatService`.
4. Publishes reply events back to relays.

### Gateway Startup Discovery

On startup, the gateway must:
1. Fetch all active integrations from the API: `GET /internal/integrations?provider=nostr&status=active`
2. Pass them to `registry.initializeAll(integrations)`.
3. Each Nostr integration creates a relay pool connection.

For **hot-reload** (new integration added while gateway is running):
- Option A: Poll `/internal/integrations` every 60 seconds, diff against active instances, initialize new ones.
- Option B: The API publishes an event (via internal webhook or message queue) when integrations change. Deferred — polling is simpler for now.

### Nostr Provider

```typescript
// apps/gateway/src/providers/nostr/nostr.provider.ts

import { SimplePool, finalizeEvent, nip04 } from 'nostr-tools';
import { verifyNostrEvent, NostrEvent } from '@eve/shared/crypto/nostr';

export class NostrGatewayProvider implements GatewayProvider {
  name = 'nostr';
  transport: GatewayTransport = 'subscription';
  capabilities = ['inbound', 'outbound', 'identity'] as const;

  private relayPool: SimplePool;
  private relayUrls: string[] = [];
  private platformKeypair: { pubkey: string; privkey: string };
  private subscriptions: Sub[] = [];
  private chatService: GatewayChatService;

  constructor(chatService: GatewayChatService) {
    this.chatService = chatService;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    // 1. Load platform Nostr keypair from config
    this.platformKeypair = {
      pubkey: config.integration.account_id,
      privkey: config.settings.privkey as string,
    };

    // 2. Store relay URLs as instance property
    this.relayUrls = config.settings.relays as string[];
    if (!this.relayUrls?.length) {
      throw new Error(`Nostr integration ${config.integration.id}: no relay URLs configured`);
    }

    // 3. Connect to relays
    this.relayPool = new SimplePool();

    // 4. Subscribe to:
    //    - Kind 4 (encrypted DM) to platform pubkey
    //    - Kind 1 (text note) mentioning platform pubkey
    this.subscriptions = this.relayPool.subscribeMany(
      this.relayUrls,
      [
        { kinds: [4], '#p': [this.platformKeypair.pubkey] },
        { kinds: [1], '#p': [this.platformKeypair.pubkey] },
      ],
      {
        onevent: (event) => this.handleRelayEvent(event).catch(err => {
          // Log but don't crash — relay events should be processed best-effort
          console.error(`Nostr event handling error: ${err}`);
        }),
      },
    );
  }

  async shutdown(): Promise<void> {
    for (const sub of this.subscriptions) sub.close();
    this.subscriptions = [];
    if (this.relayPool) {
      this.relayPool.close(this.relayUrls);
    }
  }

  // Webhook methods: not applicable for subscription transport
  // (validateWebhook and parseWebhook are not defined)

  /** Handle events from relay subscriptions */
  private async handleRelayEvent(event: NostrEvent): Promise<void> {
    // 1. Verify event signature
    if (!verifyNostrEvent(event)) return;

    // 2. Skip our own events
    if (event.pubkey === this.platformKeypair.pubkey) return;

    // 3. Deduplicate across relays (same event may arrive from multiple relays)
    // The chat service handles this via dedupe_key, but we can skip processing early
    // using an in-memory LRU cache of recently-seen event IDs.
    if (this.recentEventIds.has(event.id)) return;
    this.recentEventIds.add(event.id);

    // 4. Normalize
    const inbound: NormalizedInbound = {
      rawType: `kind:${event.kind}`,
      provider: 'nostr',
      accountId: this.platformKeypair.pubkey,
      externalUserId: event.pubkey,
      channel: event.kind === 4 ? `dm:${event.pubkey}` : this.extractChannel(event),
      threadId: this.extractThreadId(event),
      text: event.kind === 4
        ? await this.decryptDM(event)
        : event.content,
      agentSlugHint: this.extractAgentSlug(event),
      dedupeKey: `nostr:${event.id}`,
      raw: event,
    };

    // 5. Route through shared chat service
    const result = await this.chatService.resolveAndRoute(inbound);

    // 6. Reply if needed
    if (result.immediateReply) {
      await this.sendMessage(
        { provider: 'nostr', accountId: inbound.accountId, channel: inbound.channel, threadId: inbound.threadId },
        result.immediateReply,
      );
    }
  }

  /**
   * Extract channel identifier from a Nostr event.
   * For public notes (kind 1), use the root event's 'e' tag if present (thread context),
   * otherwise use the platform pubkey as channel (all public mentions in one channel).
   */
  private extractChannel(event: NostrEvent): string {
    const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root');
    if (rootTag) return `thread:${rootTag[1]}`;
    return `public:${this.platformKeypair.pubkey}`;
  }

  /**
   * Extract thread ID from a Nostr event.
   * NIP-10: 'e' tag with 'root' marker = thread root, 'reply' marker = parent.
   * Use root event ID as thread ID for consistent thread grouping.
   */
  private extractThreadId(event: NostrEvent): string | undefined {
    const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root');
    if (rootTag) return rootTag[1]; // root event ID
    // If no root tag but has any 'e' tag, treat first 'e' as the thread root (NIP-10 positional)
    const firstE = event.tags.find(t => t[0] === 'e');
    return firstE?.[1];
  }

  /**
   * Extract agent slug from Nostr event content.
   * Patterns:
   *   DM: "/agent-slug command text" or "agent-slug: command text"
   *   Public: text after the @mention of platform pubkey, first word as slug
   *
   * Fallback: null (uses org's default_agent_slug).
   */
  private extractAgentSlug(event: NostrEvent): string | undefined {
    const text = event.content.trim();

    // DM pattern: "/slug ..." or "slug: ..."
    if (event.kind === 4) {
      const slashMatch = text.match(/^\/(\S+)/);
      if (slashMatch) return slashMatch[1];
      const colonMatch = text.match(/^(\S+):\s/);
      if (colonMatch) return colonMatch[1];
      return undefined;
    }

    // Public mention pattern: look for a word that isn't an npub/nprofile
    // After stripping nostr: URIs, the first remaining word-like token is the slug
    const stripped = text
      .replace(/nostr:(npub|nprofile|note|nevent)\w+/g, '')
      .trim();
    const firstWord = stripped.match(/^(\S+)/);
    if (firstWord && firstWord[1].length <= 64 && /^[a-z0-9-]+$/.test(firstWord[1])) {
      return firstWord[1];
    }
    return undefined;
  }

  private async decryptDM(event: NostrEvent): Promise<string> {
    // NIP-04 encrypted DM decryption
    return nip04.decrypt(
      this.platformKeypair.privkey,
      event.pubkey,
      event.content,
    );
  }

  async sendMessage(target: OutboundTarget, content: MessageContent): Promise<void> {
    const isDM = target.channel.startsWith('dm:');
    const recipientPubkey = isDM ? target.channel.slice(3) : undefined;

    if (isDM && recipientPubkey) {
      // NIP-04 encrypted DM (upgrade to NIP-44 when nostr-tools support is stable)
      const encrypted = await nip04.encrypt(
        this.platformKeypair.privkey,
        recipientPubkey,
        content.text,
      );
      const event = finalizeEvent({
        kind: 4,
        content: encrypted,
        tags: [['p', recipientPubkey]],
        created_at: Math.floor(Date.now() / 1000),
      }, this.platformKeypair.privkey);

      await this.relayPool.publish(this.relayUrls, event);
    } else {
      // Public reply (kind 1)
      const event = finalizeEvent({
        kind: 1,
        content: content.text,
        tags: this.buildReplyTags(target),
        created_at: Math.floor(Date.now() / 1000),
      }, this.platformKeypair.privkey);

      await this.relayPool.publish(this.relayUrls, event);
    }
  }

  /**
   * Build NIP-10 reply tags for public replies.
   * References the thread root and immediate parent.
   */
  private buildReplyTags(target: OutboundTarget): string[][] {
    const tags: string[][] = [];
    if (target.threadId) {
      // 'e' tag with 'root' marker for thread root
      tags.push(['e', target.threadId, '', 'root']);
    }
    // Always tag the recipient
    if (target.channel.startsWith('public:')) {
      // Don't tag ourselves in public replies
    }
    return tags;
  }

  // In-memory LRU for cross-relay event dedup (keeps last 10000 event IDs)
  private recentEventIds = new LruSet<string>(10000);
}
```

### Thread Key Format for Nostr

Nostr thread keys follow the same `provider:account_id:channel[:thread_id]` pattern:

| Scenario | Thread Key | Example |
|----------|-----------|---------|
| DM | `nostr:<platform_pubkey>:dm:<sender_pubkey>` | `nostr:abcd1234:dm:ef567890` |
| Public mention (no thread) | `nostr:<platform_pubkey>:public:<platform_pubkey>` | Single channel for all public mentions |
| Public reply thread | `nostr:<platform_pubkey>:thread:<root_event_id>` | `nostr:abcd1234:thread:deadbeef` |

### Dependencies

```
nostr-tools     # Relay pool, event creation, NIP-04 encryption, NIP-19 encoding
```

### Platform Nostr Keypair

To support multi-tenant routing, Nostr should behave like Slack:

- `integrations.provider = 'nostr'`
- `integrations.account_id = <destination_pubkey_hex>` (the pubkey users DM/mention)
- `integrations.tokens_json` stores relay list + key material (sensitive). Example: `{ relays: [...], pubkey: "<hex>", privkey: "<hex>" }`

This lets inbound Nostr events route to the correct org via `/internal/integrations/resolve` using `(provider, account_id)` without guessing based on relay URLs.

### Integration Registration

```bash
# Enable Nostr gateway for an org
eve integrations connect nostr \
  --org org_xxx \
  --relays "wss://relay.damus.io,wss://nos.lol" \
  --nsec <nsec1...>   # optional; if omitted, server generates a keypair
```

This creates an `integrations` row with `provider = 'nostr'`, `account_id = pubkey_hex`, and `tokens_json = { relays: [...], pubkey, privkey }`.

### Agent Addressing via Nostr

Users address agents via DM or mention:

**DM (kind 4):**
```
/deploy-bot deploy staging
deploy-bot: deploy staging
just plain text (uses org's default_agent_slug)
```

**Public mention (kind 1):**
```
nostr:npub1platform... deploy-bot refactor the auth module
```

The `extractAgentSlug()` method (defined above) parses these patterns.

### External Identity Mapping

When a Nostr user first contacts the platform via gateway (DM/mention):
1. `external_identities` row created: `(provider=nostr, account_id=destination_pubkey_hex, external_user_id=sender_pubkey)`.
2. If the user has previously provisioned via invite and `eve auth login --provider nostr`, the `eve_user_id` is linked. (The API's `resolveExternalIdentity` checks `identities(provider='nostr', fingerprint=sender_pubkey)` and auto-links if found.)
3. If not, a `membership_request` is created. An org admin must approve before the external identity is linked to an Eve user.
4. Unlinked identities can still interact via unpermissioned routes (no Eve account needed for gateway chat).

**Important:** `external_identities.account_id` must match `integrations.account_id` for stable resolution across multiple relays.

### Reconnection and Resilience

`nostr-tools` `SimplePool` handles basic reconnection internally. Additional measures:
- Log relay disconnect/reconnect events for observability.
- If all relays disconnect for > 30 seconds, emit a health check warning.
- On gateway restart, all subscriptions are re-established from `initializeAll()`.

### Tests
- Unit: Nostr event parsing and normalization.
- Unit: Agent slug extraction from DM and mention patterns.
- Unit: Thread key generation for DM, public, and threaded conversations.
- Unit: DM decryption with known test vectors.
- Integration: Mock relay → provider → chat service → route response.
- Integration: Cross-relay dedup (same event from two relays → one job).

---

## Phase 5: Route Permission Enforcement

**Goal**: The `permissions` field on routes is already in the schema (`RoutePermissionsSchema` in `packages/shared/src/schemas/agent-config.ts`) but never checked. Enforce it.

**Current schema** (from `project_agent_configs.parsed_routes`):

```json
{
  "id": "prod-deploy",
  "match": "deploy.*production",
  "target": "agent:deploy-bot",
  "permissions": {
    "project_roles": ["owner", "admin"],
    "envs": ["production"]
  }
}
```

**Enforcement point**: `apps/api/src/chat/chat.service.ts` → `routeMessage()` (and `routeMessageToAgent()` for slug-based routing).

### Required Plumbing: Identify the Sender

Today, the gateway → API chat route requests carry `user_id` (the *external* provider user_id, e.g., Slack user ID), but not the *Eve* user identity needed for RBAC.

To enforce permissions:

1. **Gateway** (Phase 3): After calling `/internal/integrations/external-identities/resolve`, pass `eve_user_id` and `external_identity_id` via the `metadata` field of `ChatRouteBySlugRequest`:
   ```typescript
   metadata: {
     external_identity_id: identity.external_identity_id,
     eve_user_id: identity.eve_user_id,
   }
   ```

2. **API chat.service.ts**: Extract `eve_user_id` from `metadata` before route matching.

This avoids changing the `ChatRouteRequest` schema (which is shared and used by the public API too). The identity fields are gateway-internal context, not part of the public chat API contract.

Before dispatching to the target agent/team, check:

```typescript
async routeMessage(projectId: string, request: ChatRouteRequest): Promise<ChatRouteResponse> {
  // Existing: fetch config, normalize routes, match route

  // NEW: Extract sender identity from gateway metadata
  const eveUserId = request.metadata?.eve_user_id as string | null | undefined;

  // Existing: match route
  const matchedRoute = this.matchRoute(routes, request.text);

  // NEW: Check permissions before dispatch
  if (matchedRoute?.permissions) {
    const allowed = await this.checkRoutePermissions(
      matchedRoute.permissions,
      { eveUserId },
      projectId,
    );
    if (!allowed) {
      // Record the denied attempt for audit, then return denial
      return {
        thread_id: threadId,
        route_id: matchedRoute.id,
        target: matchedRoute.target,
        job_ids: [],
        event_id: null,
        denied: true,
        denial_reason: `Required roles: ${matchedRoute.permissions.project_roles?.join(', ')}`,
      };
    }
  }

  // Existing: dispatch to agent/team
}

private async checkRoutePermissions(
  permissions: RoutePermissions,
  sender: { eveUserId?: string | null },
  projectId: string,
): Promise<boolean> {
  if (permissions.project_roles) {
    if (!sender.eveUserId) {
      // Unlinked external identity — no Eve user, no permissions
      return false;
    }

    // Use the actual query method from memberships
    const membership = await membershipQueries.findProjectMembership(
      this.db,
      sender.eveUserId,
      projectId,
    );
    if (!membership || !permissions.project_roles.includes(membership.role)) {
      return false;
    }
  }

  // Check env access (for deploy routes) — requires additional context
  // Deferred: env permissions checked when env_name is part of the route match
  if (permissions.envs) {
    // TODO: Extract env from matched text and check against allowed envs
  }

  return true;
}
```

**Edge case**: Messages from external identities (Slack, Nostr) that aren't linked to an Eve user. Policy:
- Unlinked identities have no permissions → route denied for permissioned routes.
- Unlinked identities can use unpermissioned (no `permissions` field) routes.
- No configuration needed — this follows naturally from "no eve_user_id = no role = no access."

**Response schema change**: Add optional `denied` and `denial_reason` to `ChatRouteResponse` so the gateway can relay permission denials back to the user.

### Missing Feature: Approving/Linking External Identities

`membership_requests` rows are created today, but there is no public approval/link flow yet. Add:
- API: list membership requests for an org, approve/deny, and link `external_identities.eve_user_id`.
- CLI: `eve org membership-requests list/approve/deny`.
- Auto-link for known identities: When resolving an external identity, if `identities(provider, fingerprint)` finds a match (user previously provisioned via invite), auto-link `eve_user_id` without requiring a membership request. Unknown identities go through the membership request approval flow.

**Tests**:
- Integration: Permissioned route rejects sender with no `eve_user_id`.
- Integration: Permissioned route rejects sender with wrong role.
- Integration: Permissioned route allows sender with correct role.
- Integration: Unpermissioned route allows any sender (including unlinked).
- Integration: Auto-linked Nostr identity passes permission checks.

---

## Phase 6: Thread Session Continuity

**Goal**: Maintain conversation context across messages in a thread, so agents can have multi-turn conversations.

### Problem

Currently each message is routed independently. The agent gets a fresh job with no memory of previous turns. Thread messages are stored in `thread_messages`, but the agent doesn't receive them.

### Design

When a message arrives in an existing thread:

1. Load recent thread history from `thread_messages` (configurable limit, e.g., last 20 messages).
2. Include history in the job's `harness_options` or a context file in the workspace.
3. The harness reads the context and includes it in the system prompt / conversation history.

### Implementation

**Thread context injection** (`apps/api/src/chat/chat.service.ts`):

When creating a job from a routed message:

```typescript
// Load thread history
const threadMessages = await threadMessageQueries.listRecent(this.db, threadId, { limit: 20 });

// Include as job context
const jobHints = {
  ...existingHints,
  thread_context: threadMessages.map(m => ({
    direction: m.direction,      // 'inbound' | 'outbound'
    actor: m.actor_type === 'agent' ? m.actor_id : 'user',
    text: m.body,
    timestamp: m.created_at,
  })),
};
```

**Harness-side**: The worker writes thread context to a file in the workspace (e.g., `.eve/thread-context.json`) before invoking the harness. The harness skill reads it.

**Thread summary** (optional enhancement):
- After N messages (configurable), trigger a summarization job that updates `threads.summary`.
- Subsequent jobs receive the summary + recent messages (not full history).
- This keeps context compact for long conversations.

### Session policies

Reuse `threads.policy_json` (already exists) for per-thread session policy:

```sql
-- policy_json: { session: { max_messages: 20, summarize_after: 50, ttl_hours: 24 } }
-- No schema change required for initial implementation.
```

Default policy comes from `chat.yaml`:

```yaml
chat:
  session_policy:
    max_messages: 20
    summarize_after: 50
    ttl_hours: 24
```

**Tests**:
- Integration: Second message in a thread includes first message in context.
- Integration: Thread summary is generated after threshold.

---

## Parallelization Map

- Phase 0 and Phase 3 can proceed in parallel (identity interface + gateway interface are independent).
- Phase 1 depends on Phase 0 (auth chain needs provider interface).
- Phase 2 depends on Phase 1 (Nostr provider needs auth chain).
- Phase 4 depends on Phase 2 and Phase 3 (Nostr gateway needs both identity verification and gateway interface).
- Phase 5 can start after Phase 3 (needs gateway to pass identity mapping; enforcement lives in API chat service).
- Phase 6 can start after Phase 3 (session continuity is API/worker-side and applies to all providers once threading keys are stable).

```
Phase 0 (Identity Interface)  ──→  Phase 1 (Auth Chain)  ──→  Phase 2 (Nostr Identity)  ──┐
                                                                                            ├→  Phase 4 (Nostr Gateway)
Phase 3 (Gateway Interface)  ──→  Phase 5 (Route Permissions)                              ─┘
                              ──→  Phase 6 (Session Continuity)
```

---

## Security Notes

- Nostr private keys (per-integration keypairs) follow the same handling as Slack tokens: stored in `integrations.tokens_json` (initially) → gateway process memory → never in logs/events/receipts. Long-term: move to an encrypted secret store.
- NIP-98 request auth validates URL (scheme + host + path + sorted query), method, and body hash strictly — partial matching opens replay attacks.
- Body hash (`payload` tag) is **required** for all non-GET NIP-98 requests. Requests without it are rejected.
- NIP-04 encrypted DMs use AES-256-CBC. This is the current Nostr standard but has known weaknesses (no padding, no authentication). NIP-44 (versioned encryption with padding + HMAC) is the successor — upgrade when `nostr-tools` NIP-44 support is stable. Both decryption paths should be supported during transition.
- Provisioning requires a valid org invite (code or pre-targeted identity). No open self-registration. Dev-only `EVE_AUTH_OPEN_PROVISION=true` flag exists but must never be enabled in production. Invite codes are single-use by default and support expiry.
- Thread context sent to agents must not include messages from other users' private threads — scope by thread, not by channel. The current `thread_messages` table is already scoped by `thread_id`, so this is naturally enforced.
- Replay protection uses DB-backed dedup (not in-memory) with automatic TTL cleanup. The window is 120s (double the ±60s timestamp window) to account for clock skew.
- `rawBody` capture for NIP-98 body hash: only enable on non-GET routes behind auth to avoid memory overhead on public/static endpoints.

## Design Decisions

### Why not NIP-46 (Nostr Connect) for platform signing?

NIP-46 is for remote signing — it requires a separate signing service. The platform holds its own keypair (it's the platform's identity), so direct signing is simpler and has no external dependency. NIP-46 is appropriate for *user* key management (deferred).

### Why `nostr-tools` and not a custom implementation?

`nostr-tools` is the de facto TypeScript Nostr library, actively maintained, used by most Nostr clients. It handles relay pool management, subscription lifecycle, and NIP implementations. Building our own would be slower and less reliable.

### Why not WebSocket gateway for all providers?

Each provider has its own transport semantics (Slack uses webhooks, Nostr uses relay subscriptions, Telegram uses long polling or webhooks). A unified WebSocket gateway would be an abstraction that doesn't match any provider's native transport. The `GatewayProvider` interface abstracts at the right level — each provider handles its own transport via the `transport` property.

### Why factory model over manager model for gateway providers?

Each integration may connect to different relay sets, hold different keypairs, and have independent connection state. A per-integration instance (factory model) keeps this naturally isolated. The manager model would require careful internal state management keyed by `account_id` — more complex with no real benefit given the low instance count (typically <10 integrations per gateway).

### Why pass identity via metadata instead of schema fields?

`ChatRouteRequest` is a public API contract (used by both the gateway internal API and the public project API). Adding `eve_user_id` / `external_identity_id` as top-level fields would expose internal identity plumbing to public API consumers. Using `metadata` keeps the public schema clean while allowing the gateway to pass identity context for permission enforcement.
