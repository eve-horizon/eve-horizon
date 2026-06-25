# Unified Platform + Org Invite & Onboarding UX Plan

> Status: Draft
> Last Updated: 2026-02-17
> Purpose: Deliver a single onboarding surface for platform admins and org owners while keeping agent no-password onboarding and GitHub-key flows intact.

## Problem
- `eve admin invite` is the only explicit invite-link path and is platform-admin oriented.
- Org owners have no first-class invite-link path from `eve org` (though `eve org members add` can add users directly by email).
- There is no shared onboarding claim UX for invite-link recipients across SSO, email, and SSH-key paths.
- No platform-wide user listing endpoint or CLI command exists.
- GitHub SSH key import during onboarding is CLI-only (`eve admin invite --github`), not available in the web flow.
- `autoApplyOrgInviteByEmail` silently swallows errors — invited users can end up logged in but without org membership, with no visible feedback.

## Existing components to preserve
- **Invite table + API**: `POST /auth/invites` and `GET /auth/invites/:org_id` with `org_invites` table (`auth.invites.controller.ts`, `org-invites.ts`, migration `00042_nostr_identity.sql`).
- **Access requests**: `POST /auth/request-access`, `GET /auth/request-access/:id`, admin approve/reject (`auth.access-requests.controller.ts`).
- **Invite-gated provisioning**: `POST /auth/verify` supports `invite_code` via `provisionViaInvite` and `autoApplyOrgInviteByEmail` in `auth.service.ts`.
- **Direct member add**: `POST /orgs/:org_id/members` already adds users by email with role — this is the "no invite link needed" path.
- **CLI flows**: `eve admin invite` (with `--github`, `--web`, `--redirect-to`), `eve admin access-requests`, `eve auth request-access --wait`, `eve org members add`.
- **SSO app**: GoTrue proxy at `apps/sso/` with login/signup/magic-link pages and hash-fragment invite handling.
- **No-password, key-first agent path** must remain unchanged.

## RBAC context (important for this plan)

The plan uses "org owner" (not "org admin") because in the current RBAC model:
- `orgs:admin` permission is exclusive to the **`owner`** membership role
- The `admin` membership role does NOT have `orgs:admin` — it has `orgs:write` but not member/invite management
- All current invite and member management endpoints require `orgs:admin`
- Platform admins (`users.is_admin = true`) bypass all permission checks

**Decision needed**: Should we grant `orgs:admin` to the `admin` role too? Or introduce a narrower `orgs:invite` permission? For now, this plan assumes org owners are the invite issuers from org scope. See Open Questions.

## Target UX
1. Platform admins invite by email via invite-link or direct member addition.
2. Org owners invite from org context with parity to platform-level flow.
3. Invited users receive one onboarding link and land on a claim page showing org context.
4. Invited users can complete onboarding via SSO (magic link / password) or SSH key path.
5. Platform-scoped invites can optionally allow the recipient to create a new org during claim.
6. GitHub users can import SSH keys from their GitHub username during web onboarding.

## Two invite paths (clarification)

The system has two distinct ways to add someone to an org:

| Path | When to use | Requires recipient action? |
|------|-------------|--------------------------|
| **Direct add** (`POST /orgs/:org_id/members`) | Admin knows the user's email and wants immediate membership | No — membership is instant |
| **Invite link** (`POST /auth/invites`) | Admin wants the user to self-authenticate and claim | Yes — user must click link and authenticate |

This plan focuses on improving the **invite link** path. Direct add already works.

## Data model changes

Extend `org_invites` table in a new migration:

```sql
-- New columns on org_invites
ALTER TABLE org_invites
  ALTER COLUMN org_id DROP NOT NULL;  -- nullable for platform-scoped "create your own org" invites

ALTER TABLE org_invites
  ADD COLUMN IF NOT EXISTS allow_org_creation BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS github_username_hint TEXT,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by TEXT REFERENCES users(id);

-- Constraint: org_id is required unless allow_org_creation is true
ALTER TABLE org_invites
  ADD CONSTRAINT chk_invite_org_or_create
  CHECK (org_id IS NOT NULL OR allow_org_creation = true);
```

**What we're NOT adding** (and why):
- ~~`created_by_scope`~~ — Derivable from `created_by` → `users.is_admin`. No denormalized scope column.
- ~~`desired_org_name` / `desired_org_slug`~~ — These belong on the claim request body, not the invite. The invite says "you may create an org"; the recipient says "I want it called X".
- ~~`allowed_org_ids TEXT[]`~~ — No user journey requires "pick from N orgs." Platform invites either target a specific org or allow org creation. YAGNI.
- ~~`updated_at`~~ — Invites are write-once-then-claim or revoke. No mutation history needed.

**Backfill**: None needed. Existing rows have `org_id NOT NULL` and `allow_org_creation = false`, which satisfies the constraint.

## API surface

### New endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/orgs/:org_id/invites` | `orgs:admin` | Org-scoped invite creation (delegates to same service as `/auth/invites`) |
| `GET` | `/orgs/:org_id/invites` | `orgs:admin` | List invites for org (move from `/auth/invites/:org_id`) |
| `GET` | `/auth/onboarding/:invite_code` | Public | Return sanitized invite metadata for claim page rendering |
| `POST` | `/auth/onboarding/:invite_code/claim` | Authenticated | Finalize invite: join org or create new org (if allowed) |
| `POST` | `/auth/invites/:id/revoke` | `orgs:admin` or `system:admin` | Soft-revoke an unused invite |
| `GET` | `/system/users` | `system:admin` | List users platform-wide with `?org_id=&limit=&offset=&q=` |

### Existing endpoints to keep
- `POST /auth/invites` — Keep for backward compatibility and platform-admin use (supports `org_id: null` + `allow_org_creation: true`).
- `GET /auth/invites/:org_id` — Deprecate in favor of `GET /orgs/:org_id/invites` but keep working.
- `POST /auth/request-access` and admin approve/reject — Unchanged.
- `POST /orgs/:org_id/members` — Unchanged (direct add path).

### Onboarding endpoint detail

`GET /auth/onboarding/:invite_code` returns:
```json
{
  "invite_code": "abc123",
  "org": { "id": "org_xxx", "name": "Acme", "slug": "acme" } | null,
  "allow_org_creation": false,
  "role": "member",
  "github_username_hint": "octocat" | null,
  "expired": false,
  "used": false
}
```

`POST /auth/onboarding/:invite_code/claim` accepts:
```json
{
  "desired_org_name": "My Org",     // only if allow_org_creation && org_id is null
  "desired_org_slug": "my-org",     // optional, auto-generated if omitted
  "github_username": "octocat",     // optional, triggers SSH key import
  "ssh_public_keys": ["ssh-ed25519 ..."]  // optional, registers identity
}
```

## Query layer gaps to fill

`packages/db/src/queries/org-invites.ts` needs:
- `findById(id)` — for revoke endpoint
- `revoke(id, revokedBy)` — sets `revoked_at` and `revoked_by`
- `listAll(opts)` — platform-wide invite list with filters (status, scope)
- `findByCode` — update to also check `revoked_at IS NULL`
- `findByIdentityHint` — update to also check `revoked_at IS NULL`

`packages/db/src/queries/users.ts` needs:
- `listAll(opts)` — paginated user list with optional `org_id`, `q` (email search), `limit`, `offset`

## Service-level refactor

1. **Extract `OnboardingService`** in `apps/api/src/auth/onboarding.service.ts`:
   - `resolveInvite(code)` — validate invite (not expired, not used, not revoked)
   - `claimInvite(code, userId, opts)` — atomically: create org (if allowed), upsert membership, mark used, optionally register SSH keys / import GitHub keys
   - `revokeInvite(id, revokedBy)` — soft revoke

2. **Refactor callers**:
   - `autoApplyOrgInviteByEmail` → delegate to `OnboardingService.claimInvite` and **propagate errors** (fix silent swallowing)
   - `provisionViaInvite` → delegate invite resolution to `OnboardingService.resolveInvite`
   - Access-request approval → no change (different flow)

3. **Keep `resolveVerifiedIdentity` ladder intact** — only change is the invite-consumption step calls through `OnboardingService` instead of inline logic.

## SSO app changes

The SSO app (`apps/sso/src/main.ts`) needs:

1. **New route: `GET /onboarding/:invite_code`** — Renders an invite claim page:
   - Calls `GET /auth/onboarding/:invite_code` to fetch invite metadata
   - Shows org name (if org-scoped) or "Create your organization" form (if `allow_org_creation`)
   - Shows role being granted
   - If user is not authenticated: show login/signup form first, then claim
   - If user is authenticated: show claim button directly
   - Optional: GitHub username input for SSH key import

2. **Update invite email template** — GoTrue invite emails should link to `/onboarding/:invite_code` instead of the generic `/login` page.

3. **Post-claim redirect** — After successful claim, redirect to the org's dashboard or the `redirect_to` URL from the invite.

## CLI UX plan

### New commands
- `eve org invite <email> [--role member|admin|owner] [--web] [--github <username>] [--expires-in-hours N]` — Org-scoped invite (uses current org context from `eve org ensure` or `--org` flag).
- `eve org invites [--include-used] [--include-revoked]` — List invites for current org.
- `eve org invites revoke <invite_id>` — Revoke an unused invite.
- `eve admin users [--org <org_id>] [--limit N] [--offset N] [--query <email>]` — Platform-wide user listing.
- `eve admin invites [--org <org_id>] [--status pending|used|revoked|expired]` — Platform-wide invite listing.

### Updated commands
- `eve admin invite` — Add `--allow-org-create` and `--invite-code-only` (print code without sending email) flags. Note: `--github`, `--web`, `--redirect-to` already exist.
- `eve auth login --invite-code <code>` — SSH-key login with invite code claim in one step.

### Preserved commands (no changes)
- `eve auth request-access --wait` — Agent self-service path unchanged.
- `eve admin access-requests` — Approve/reject path unchanged.
- `eve org members add/list/remove` — Direct member management unchanged.

## User journey details

### A) Platform admin invites user to specific org (web path)
1. Admin runs `eve admin invite --email user@co.com --org org_xxx --web`.
2. User receives GoTrue magic-link email, clicks link.
3. SSO app authenticates user, calls `POST /auth/onboarding/:code/claim`.
4. User is added to org with specified role. Redirect to dashboard.

### B) Platform admin invites user with org creation allowed
1. Admin runs `eve admin invite --email user@co.com --allow-org-create --web`.
2. User clicks magic link, authenticates.
3. SSO app shows onboarding page: "Create your organization" form (name, optional slug).
4. User submits → `POST /auth/onboarding/:code/claim { desired_org_name: "..." }`.
5. Org is created, user gets `owner` membership.

### C) Org owner invites member (web path)
1. Owner runs `eve org invite user@co.com --role member --web`.
2. User receives invite, clicks link, authenticates.
3. SSO app shows: "You've been invited to join **Acme** as a member."
4. User clicks "Accept" → claim endpoint fires.

### D) Org owner invites member (code-only / SSH path)
1. Owner runs `eve org invite user@co.com --role member --invite-code-only`.
2. Owner shares the invite code out-of-band (Slack, email, etc.).
3. Recipient runs `eve auth login --invite-code <code>` with their SSH key.
4. `provisionViaInvite` resolves the code, creates user + membership.

### E) Agent / no-password onboarding (unchanged)
1. Agent runs `eve auth request-access --org "Team Org" --ssh-key ~/.ssh/id_ed25519.pub --wait`.
2. Admin approves from `eve admin access-requests approve <id>`.
3. Agent auto-logs in with SSH key. No invite link involved.

## Bug fix: silent invite application failure

`autoApplyOrgInviteByEmail` (auth.service.ts:317) currently catches all errors and logs a warning. This means a user can authenticate successfully but silently fail to join the org they were invited to.

**Fix**: Propagate the error to the caller. The `autoProvisionSupabaseUser` flow should return an `invite_applied: boolean` field so the SSO callback can show a warning or retry prompt if invite claim failed.

## Non-goals
- No changes to core project/manifest behavior.
- No replacement of job/service principal token model.
- No removal of manual admin approval in access-request flow.
- No changes to the `POST /orgs/:org_id/members` direct-add path.

## Milestones

### Phase 1: Foundation
- Migration: make `org_id` nullable, add `allow_org_creation`, `github_username_hint`, `revoked_at/by`.
- Query layer: add `findById`, `revoke`, `listAll` to `org-invites.ts`; add `listAll` to `users.ts`.
- API: `GET /system/users`, `POST /auth/invites/:id/revoke`, `GET /orgs/:org_id/invites`.
- CLI: `eve admin users`, `eve org invite`, `eve org invites`.
- Fix: `autoApplyOrgInviteByEmail` error propagation.

### Phase 2: Unified claim
- API: `GET /auth/onboarding/:invite_code`, `POST /auth/onboarding/:invite_code/claim`.
- Service: `OnboardingService` with `resolveInvite`, `claimInvite`, `revokeInvite`.
- Refactor: `provisionViaInvite` and `autoApplyOrgInviteByEmail` delegate to `OnboardingService`.
- CLI: `eve auth login --invite-code`.
- SSO: `/onboarding/:invite_code` claim page.

### Phase 3: Polish
- GitHub SSH key import in SSO onboarding page.
- Invite expiration warnings in CLI output.
- Richer invite list output (status badges, time-to-expiry).
- Platform-wide invite dashboard endpoint with filters.

## Decisions (resolved from open questions)
- **Invite mode**: Invites are auth-mode-agnostic. The recipient chooses SSO or SSH at claim time. No mode flag from sender needed.
- **Org slug generation**: Auto-generate slug from org name (using existing `slugify` convention), with optional explicit `desired_org_slug` override.
- **`allow_org_creation` scope**: Platform admins only. Org-scoped invites always target the issuing org. This is enforced at the API level — `POST /orgs/:org_id/invites` ignores `allow_org_creation`.

## Open questions (remaining)
- Should the `admin` membership role gain `orgs:admin` (or a new `orgs:invite`) permission so org admins (not just owners) can issue invites?
- Should revoked invites be hard-deleted after N days, or kept indefinitely for audit?
- Should the onboarding claim page support adding SSH keys via browser (paste public key), or keep that CLI-only?
