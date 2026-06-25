# App-Initiated User Onboarding

> **Status**: Shipped (c40f442)
> **Date**: 2026-03-18
> **Builds on**: `unified-platform-org-invite-onboarding-ux-plan.md` (draft, partially shipped)
> **First consumer**: Eden (story map app)
> **Estimated effort**: ~1 week (3 workstreams, partially parallel)
>
> **Goal**: Allow org admins using an Eve-compatible app to invite new users
> into the platform, have them receive a branded email, set their password,
> and land in the target app with correct org and app-level roles — all
> without leaving the app's UI.

---

## Problem

An Eden project owner wants to invite a collaborator. Today this requires:

1. A **platform admin** runs `eve admin invite --email x --web` from the CLI
2. The user gets a generic magic-link email
3. After setting their password, they land on the SSO broker — not in Eden
4. The Eden owner must then separately add them to the Eden project

This is four manual steps across two tools. The desired flow is one step:

```
Eden owner clicks "Invite" → enters email + picks Eden role → user gets
email → clicks link → sets password → lands in Eden with the right role
```

### Secondary use case: assign existing org members

If the user is **already** in the org, the Eden owner should see them in a
picker and assign a project role directly. No invite email needed.

---

## Architecture

```
Eden UI                Eden API              Eve API                GoTrue
  │                      │                     │                      │
  │ POST /invite         │                     │                      │
  │─────────────────────►│                     │                      │
  │                      │ GET /orgs/:id/      │                      │
  │                      │   members           │                      │
  │                      │────────────────────►│                      │
  │                      │◄────────────────────│                      │
  │                      │                     │                      │
  │                      │ [user in org?]       │                      │
  │                      │                     │                      │
  │                      │── YES: insert ──►   │                      │
  │                      │   project_members   │                      │
  │                      │                     │                      │
  │                      │── NO: POST /orgs/   │                      │
  │                      │   :id/invites       │                      │
  │                      │────────────────────►│                      │
  │                      │                     │ POST /invite         │
  │                      │                     │─────────────────────►│
  │                      │                     │                      │── email
  │                      │                     │                      │
  │                      │   insert            │                      │
  │                      │   project_invites   │                      │
  │◄─────────────────────│                     │                      │
  │ { status: invited }  │                     │                      │
```

After the user clicks the email link, sets their password, and the SSO
callback fires:

```
GoTrue → SSO /callback → Eve /auth/exchange (auto-applies org invite)
                        → redirect to Eden URL
                        → Eden first-access hook converts project_invite → project_members
```

---

## Workstream 1: Platform Permission & Member Listing

### 1a. Add `orgs:members:read` permission

The platform's member listing endpoint (`GET /orgs/:id/members`) requires
`orgs:admin` — a permission only org **owners** have. This is too coarse.
Apps need to list members without having org-delete power.

**Changes:**

| File | Change |
|------|--------|
| `packages/shared/src/permissions.ts` | Add `'orgs:members:read'` to `ALL_PERMISSIONS` |
| `apps/api/src/auth/permissions.ts` | Add `'orgs:members:read'` to `MEMBER_PERMISSIONS` |
| `apps/api/src/orgs/orgs.controller.ts` | Change `GET :org_id/members` from `@RequirePermission('orgs:admin')` to `@RequirePermission('orgs:members:read')` |

After this change, every authenticated org member can list who else is in
the org. Add/remove members and org deletion still require `orgs:admin`.

### 1b. Add `orgs:invite` permission

Org invites currently require `orgs:admin` (owner-only). Org admins should
be able to invite without being able to delete the org.

**Changes:**

| File | Change |
|------|--------|
| `packages/shared/src/permissions.ts` | Add `'orgs:invite'` to `ALL_PERMISSIONS` |
| `apps/api/src/auth/permissions.ts` | Add `'orgs:invite'` to `ADMIN_EXTRA` |

### 1c. Add member search endpoint

Apps need autocomplete for the invite picker. Add a search endpoint scoped
to org members:

```
GET /orgs/:org_id/members/search?q=<email-or-name-prefix>
```

**Permission:** `orgs:members:read`

**Returns:** `{ data: [{ user_id, email, display_name, role }] }` — max 20
results, filtered by email prefix or display_name prefix (case-insensitive).

**Implementation:** Add `searchOrgMembers(orgId, query)` to
`packages/db/src/queries/memberships.ts`:

```sql
SELECT u.id AS user_id, u.email, u.display_name, om.role
FROM org_memberships om
JOIN users u ON u.id = om.user_id
WHERE om.org_id = $1
  AND (u.email ILIKE $2 || '%' OR u.display_name ILIKE $3 || '%')
ORDER BY u.email
LIMIT 20
```

Build the two `ILIKE` patterns (`$2`, `$3`) as escaped prefix matches in the
service layer (for example `foo%`), after escaping wildcard chars (`%`, `_`, `\`)
in user input.

---

## Workstream 2: Org-Scoped Invite with Email + App Context

### 2a. Extend `org_invites` table

```sql
ALTER TABLE org_invites
    ADD COLUMN IF NOT EXISTS redirect_to TEXT,
    ADD COLUMN IF NOT EXISTS app_context JSONB;
```

- `redirect_to` — URL where the user lands after completing onboarding.
  The SSO callback already supports `redirect_to`; this persists it on the
  invite so it survives the GoTrue → SSO → Eve token exchange chain.
- `app_context` — opaque JSON the originating app attaches. Rides along
  with the invite. Not interpreted by the platform. Apps read it after
  the user arrives.

**Update the query layer** (`packages/db/src/queries/org-invites.ts`):
- Extend `OrgInvite` interface with `redirect_to` and `app_context`
- Accept both fields in `create()`
- Return both in `findByCode()` and `findByIdentityHint()`

### 2b. `POST /orgs/:org_id/invites` endpoint

New org-scoped invite endpoint (from the unified plan, not yet built).

**Permission:** `orgs:invite` (admins + owners)

**Request body:**

```typescript
{
    email: string;           // required
    role?: string;           // 'owner' | 'admin' | 'member' (default: 'member')
    send_email?: boolean;    // default: true — sends GoTrue invite email
    redirect_to?: string;    // where to send user after onboarding (validated allowlist)
    app_context?: object;    // app-specific metadata (opaque to platform)
}
```

**Implementation** (new method on `OrgsService` or extracted `InviteService`):

```typescript
async createOrgInvite(orgId: string, createdBy: string, body) {
    // 1. Generate invite code
    const invite_code = generateInviteCode(); // base64url(randomBytes(24))

    // 2. Create org_invites row
    const invite = await this.orgInvites.create({
        org_id: orgId,
        created_by: createdBy,
        invite_code,
        provider_hint: 'supabase',
        identity_hint: body.email,
        role: body.role ?? 'member',
        redirect_to: body.redirect_to,
        app_context: body.app_context,
        expires_at: addHours(new Date(), 72), // 3-day expiry
    });

    // 3. Send GoTrue invite email (if requested)
    if (body.send_email !== false) {
        // redirect_to for GoTrue points to SSO, which handles the rest
        const redirectTo = sanitizeRedirectTo(body.redirect_to, ctx.appConfig.redirectHosts);
        const ssoRedirect = `${EVE_SSO_URL}/?redirect_to=${encodeURIComponent(redirectTo || '')}`;
        await this.authService.sendSupabaseInvite(body.email, ssoRedirect);
    }

    return invite;
}
```

**Controller** (add to `orgs.controller.ts`):

```typescript
@RequirePermission('orgs:invite')
@Post(':org_id/invites')
@HttpCode(HttpStatus.CREATED)
async createInvite(
    @Param('org_id') orgId: string,
    @Body() body: OrgInviteRequest,
    @Req() req,
) {
    return this.orgsService.createOrgInvite(orgId, req.user.user_id, body);
}
```

### 2c. Fix `autoApplyOrgInviteByEmail` error propagation

Currently (`auth.service.ts:302-315`), this method catches all errors and
logs a warning. A user can authenticate but silently fail to join the org.

**Fix:** Return a result object so the exchange flow can surface the error:

```typescript
private async autoApplyOrgInviteByEmail(
    userId: string,
    email: string,
): Promise<{ applied: boolean; org_id?: string; error?: string }> {
    try {
        const invite = await this.orgInvites.findByIdentityHint('supabase', email);
        if (!invite || invite.used_at || ...) {
            return { applied: false };
        }
        await this.memberships.upsertOrgMembership(invite.org_id, userId, role);
        await this.orgInvites.markUsed(invite.id, userId);
        return { applied: true, org_id: invite.org_id };
    } catch (err) {
        this.logger.error(`Failed to apply org invite for ${email}: ${err}`);
        return { applied: false, error: String(err) };
    }
}
```

### 2d. Pass `redirect_to` through the invite chain

The invite's `redirect_to` must survive: GoTrue email → SSO callback → app.

**Current flow:**
1. GoTrue sends email with magic link pointing to `GOTRUE_SITE_URL/callback`
2. SSO callback extracts tokens and `redirect_to` from query params
3. SSO sets cookies and redirects to `redirect_to`

**The gap:** The `redirect_to` sent to GoTrue's `/invite` endpoint is
embedded in the magic link. When the user clicks it, GoTrue redirects to
`GOTRUE_SITE_URL/callback#access_token=...&type=invite`. The
`redirect_to` is included as a query parameter by GoTrue.

**No SSO code change needed** — the SSO `/callback` handler already reads
`redirect_to` from query params (`main.ts:679`) and redirects there after
token exchange. We just need to make sure `sendSupabaseInvite` passes a
validated `redirect_to` value.

**What needs verification:** That GoTrue preserves `redirect_to` through
the magic-link flow. The `GOTRUE_MAILER_URLPATHS_INVITE` is set to
`/callback` — GoTrue appends `?redirect_to=...` to this path. Verify in
the k3d stack by checking the actual email link in Mailpit.

---

## Workstream 3: Eden App Integration

### 3a. `project_invites` table (Eden migration)

```sql
CREATE TABLE project_invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          TEXT NOT NULL,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    eve_invite_code TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'expired')),
    invited_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now(),
    claimed_at      TIMESTAMPTZ,
    UNIQUE (project_id, email)
);

ALTER TABLE project_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON project_invites
    USING (org_id = current_setting('app.org_id', true));
```

### 3b. Eden invite endpoint

```
POST /projects/:id/invite
Body: { email: string, role: 'editor' | 'viewer' }
Auth: OwnerGuard (project owner only)
```

**Logic:**

```typescript
async inviteToProject(ctx, projectId, { email, role }) {
    // 1. List org members via Eve API
    const members = await this.eveClient.listOrgMembers(ctx.org_id);
    const existing = members.find(m => m.email === email);

    if (existing) {
        // User is already in the org — add to project directly
        await this.membersService.invite(ctx, projectId, {
            user_id: existing.user_id,
            email,
            role,
        });
        return { status: 'added', user_id: existing.user_id };
    }

    // 2. User is NOT in org — create Eve org invite + Eden project invite
    const invite = await this.eveClient.createOrgInvite(ctx.org_id, {
        email,
        role: 'member',
        send_email: true,
        redirect_to: `${EDEN_WEB_URL}/projects/${projectId}`,
        app_context: {
            app: 'eden',
            project_id: projectId,
            role,
        },
    });

    await this.projectInvites.create(ctx, {
        project_id: projectId,
        email,
        role,
        eve_invite_code: invite.invite_code,
        invited_by: ctx.user_id,
    });

    return { status: 'invited', invite_code: invite.invite_code };
}
```

### 3c. `EveClient` service (Eden)

New service in Eden's API that wraps Eve API calls:

```typescript
class EveClient {
    constructor(
        private readonly apiUrl: string,     // EVE_API_URL
        private readonly serviceToken: string, // EVE_SERVICE_TOKEN
    ) {}

    async listOrgMembers(orgId: string) {
        // Calls GET /orgs/:org_id/members
        // Uses the requesting user's token (forwarded), not the service token
        // This works because orgs:members:read is on MEMBER_PERMISSIONS
    }

    async searchOrgMembers(orgId: string, query: string) {
        // Calls GET /orgs/:org_id/members/search?q=...
    }

    async createOrgInvite(orgId: string, body: OrgInviteRequest) {
        // Calls POST /orgs/:org_id/invites
        // Must use a token with orgs:invite permission
        // The user's own token works if they're an org admin/owner
    }
}
```

**Auth strategy:** Forward the user's own Eve JWT (from `req.user`) to
Eve API calls. This way:
- `listOrgMembers` works because all members have `orgs:members:read`
- `createOrgInvite` works because only admins/owners have `orgs:invite`
- No service token needed for these operations

Eden's API receives the Eve JWT via `eveUserAuth()` middleware — extract
it from the `Authorization` header and forward it.

### 3d. First-access invite conversion

When a user first accesses an Eden project after onboarding, convert any
pending `project_invites` row into a real `project_members` row.

**Add to `ProjectRoleMiddleware`** (Phase 6a):

```typescript
// After resolving the project role, check for pending invites
if (req.user?.email) {
    const pending = await this.projectInvites.findPending(
        projectId, req.user.email,
    );
    if (pending) {
        await this.membersService.invite(ctx, projectId, {
            user_id: req.user.id,
            email: req.user.email,
            role: pending.role,
        });
        await this.projectInvites.markClaimed(pending.id);
        // Re-resolve role with the new membership
        resolvedRole = pending.role;
    }
}
```

### 3e. Member picker UI + invite modal

**Member picker** (for existing org members):
- `GET /projects/:id/members/candidates` — returns org members minus
  already-invited members. Calls Eve API `listOrgMembers`, filters out
  existing `project_members`.
- Frontend: autocomplete dropdown in the invite modal

**Invite modal states:**

| Input | Result |
|-------|--------|
| Email matches org member | Show "Add to project" (instant) |
| Email does NOT match | Show "Invite to platform + project" (sends email) |

**Frontend components:**

```
components/projects/
    InviteModal.tsx         # Email input + role picker + submit
    MemberPicker.tsx        # Autocomplete dropdown for existing org members
    PendingInvites.tsx      # List of pending project invites (owner view)
```

### 3f. Pending invites management

```
GET    /projects/:id/invites         List pending project invites (owner)
DELETE /projects/:id/invites/:invite_id  Cancel a pending invite (owner)
```

---

## Verification Protocol

All verification runs against the local k3d stack. The loop is:

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. Build + deploy platform changes to k3d                         │
│       pnpm build                                                    │
│       ./bin/eh k8s deploy                                           │
│                                                                     │
│  2. Verify platform changes via CLI + curl                         │
│                                                                     │
│  3. Build + deploy Eden changes                                     │
│       cd ../../eve-horizon/eden                                     │
│       npm run build                                                 │
│       eve env deploy sandbox --ref HEAD --repo-dir .                │
│                                                                     │
│  4. Verify Eden flow via API + Mailpit                             │
│                                                                     │
│  5. If any step fails → fix → restart from step 1                  │
│  6. Run regression (existing manual test scenarios)                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Step 1: Platform Permission Verification

After deploying platform changes to k3d:

```bash
# Login as a regular org member (not owner/admin)
eve profile use local
eve auth login --email member@test.com --ssh-key ~/.ssh/id_ed25519

# Verify: org member can list members (was 403, now 200)
curl -s -H "Authorization: Bearer $(eve auth token)" \
    "$EVE_API_URL/orgs/$ORG_ID/members" | jq '.data | length'
# Expected: ≥ 1

# Verify: org member CANNOT create invites (still 403)
curl -s -o /dev/null -w '%{http_code}' \
    -X POST -H "Authorization: Bearer $(eve auth token)" \
    -H "Content-Type: application/json" \
    "$EVE_API_URL/orgs/$ORG_ID/invites" \
    -d '{"email":"test@example.com"}'
# Expected: 403

# Verify: org admin CAN create invites
eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
curl -s -X POST -H "Authorization: Bearer $(eve auth token)" \
    -H "Content-Type: application/json" \
    "$EVE_API_URL/orgs/$ORG_ID/invites" \
    -d '{"email":"newuser@example.com","role":"member","send_email":true,"redirect_to":"http://eden.test.lvh.me"}'
# Expected: 201 with invite_code

# Verify: member search works
curl -s -H "Authorization: Bearer $(eve auth token)" \
    "$EVE_API_URL/orgs/$ORG_ID/members/search?q=ajc" | jq '.data'
# Expected: matching members
```

### Step 2: Email Delivery Verification

```bash
# Check Mailpit for the invite email
# macOS: open http://mail.eve.lvh.me:8025
# Linux/CI: browse to http://mail.eve.lvh.me:8025

# Verify:
# 1. Email was received for newuser@example.com
# 2. Email contains a magic link
# 3. Magic link points to GOTRUE_SITE_URL/callback with redirect_to param
# 4. redirect_to in the link matches what was passed in the invite
```

### Step 3: Onboarding Flow Verification

```bash
# Extract the magic link from Mailpit and open it in a browser
# This should:
# 1. Redirect to SSO /callback
# 2. SSO exchanges token and applies org invite
# 3. User is added to the org with 'member' role
# 4. Browser redirects to redirect_to URL (Eden)

# Verify the user was added to the org
curl -s -H "Authorization: Bearer $(eve auth token)" \
    "$EVE_API_URL/orgs/$ORG_ID/members" | jq '.data[] | select(.email=="newuser@example.com")'
# Expected: { user_id, email, role: "member" }
```

### Step 4: Eden Invite Flow Verification

After deploying Eden changes:

```bash
EDEN_API=http://eden-api.<org-slug>-<proj-slug>-sandbox.lvh.me

# As Eden project owner, invite an existing org member
curl -s -X POST -H "Authorization: Bearer $(eve auth token)" \
    -H "Content-Type: application/json" \
    "$EDEN_API/projects/$PROJECT_ID/invite" \
    -d '{"email":"existinguser@example.com","role":"editor"}'
# Expected: { status: "added", user_id: "..." }

# Verify: user appears in project members
curl -s -H "Authorization: Bearer $(eve auth token)" \
    "$EDEN_API/projects/$PROJECT_ID/members" | jq '.data'
# Expected: includes existinguser@example.com with role "editor"

# As Eden project owner, invite a NEW user (not in org)
curl -s -X POST -H "Authorization: Bearer $(eve auth token)" \
    -H "Content-Type: application/json" \
    "$EDEN_API/projects/$PROJECT_ID/invite" \
    -d '{"email":"brandnew@example.com","role":"viewer"}'
# Expected: { status: "invited", invite_code: "..." }

# Verify: project_invites row created
curl -s -H "Authorization: Bearer $(eve auth token)" \
    "$EDEN_API/projects/$PROJECT_ID/invites" | jq '.data'
# Expected: includes brandnew@example.com with status "pending"

# Verify: email sent (check Mailpit)
# macOS: open http://mail.eve.lvh.me:8025
# Linux/CI: browse to http://mail.eve.lvh.me:8025
# Expected: invite email for brandnew@example.com
```

### Step 5: Full Round-Trip Verification

```bash
# 1. Extract magic link from Mailpit for brandnew@example.com
# 2. Open in browser → set password → SSO callback fires
# 3. User lands in Eden (redirect_to URL)
# 4. Eden first-access hook converts project_invite → project_members

# Verify: pending invite is now claimed
curl -s -H "Authorization: Bearer $(eve auth token)" \
    "$EDEN_API/projects/$PROJECT_ID/invites" | jq '.data'
# Expected: brandnew@example.com with status "claimed"

# Verify: user has project membership with correct role
# (login as the new user)
curl -s -H "Authorization: Bearer $NEW_USER_TOKEN" \
    "$EDEN_API/projects/$PROJECT_ID/my-role"
# Expected: { role: "viewer" }
```

### Step 6: Regression

```bash
# Platform: existing auth flows still work
eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
eve system health --json

# Platform: existing member management unchanged
eve org members --org $ORG_ID

# Eden: existing scenarios still pass (01-14)
# Run scenarios 01, 04, 08 as representative sample
```

---

## Implementation Order

```
WS1 (platform permissions)  ──┐
                               ├──► WS2 (org-scoped invites)  ──► WS3 (Eden)
WS1 can start immediately     │
                               │
WS2 depends on WS1b           │
(orgs:invite permission)       │
                               │
WS3 depends on WS1a + WS2     │
(needs member listing +        │
 invite endpoint)              │
```

**Practical order:**

| Day | Work | Where |
|-----|------|-------|
| 1 | WS1: permissions + member search endpoint | eve-horizon |
| 2 | WS2a-b: migration + org-scoped invite endpoint | eve-horizon |
| 2 | WS2c: fix autoApplyOrgInviteByEmail error handling | eve-horizon |
| 3 | WS2d: verify redirect_to chain in k3d (Mailpit → SSO → app) | eve-horizon |
| 3 | Deploy platform to k3d, run verification steps 1-3 | eve-horizon |
| 4 | WS3a-b: project_invites table + Eden invite endpoint | eden |
| 4 | WS3c: EveClient service | eden |
| 5 | WS3d-e: first-access hook + invite modal UI | eden |
| 5 | WS3f: pending invites management | eden |
| 5 | Full round-trip verification (steps 4-6) | both |

---

## Risks

| Risk | Mitigation |
|------|-----------|
| GoTrue doesn't preserve `redirect_to` through magic-link invite flow | Verify in k3d with Mailpit before building Eden side. If broken, pass redirect_to via invite code lookup instead. |
| `orgs:members:read` on all members is too permissive for some orgs | This is standard behavior (Google Workspace, Slack, GitHub all let members see each other). If needed later, add an org setting to restrict. |
| Token forwarding from Eden API to Eve API fails with CORS or auth issues | Test early in WS3c. Fallback: use EVE_SERVICE_TOKEN with orgs:members:read scope. |
| Invite email lands in spam | GoTrue default templates are plain. For production, configure custom SMTP sender and email templates via GoTrue env vars. |

---

## What Does NOT Ship

| Feature | Reason |
|---------|--------|
| Custom email templates | GoTrue defaults are sufficient for MVP. Customize later via GoTrue env vars. |
| Invite revocation | From unified plan Phase 3 (polish). Not needed for first release. |
| SSO onboarding claim page | From unified plan Phase 2. The existing GoTrue magic-link flow works — user clicks link, sets password, gets redirected. No custom claim page needed yet. |
| `eve org invite` CLI command | From unified plan. Good to have but not needed for app-initiated flow. |
| Platform-wide user listing (`/system/users`) | From unified plan. Not needed for app-scoped invites. |
| GitHub SSH key import in web flow | From unified plan Phase 3. SSH is CLI-only for now. |
| `allow_org_creation` on invites | From unified plan. Apps invite into existing orgs, not create new ones. |

---

## Exit Criteria

This plan is complete when:

- [ ] Org members can list other org members (`orgs:members:read`)
- [ ] Org admins can create invites (`orgs:invite`) with email sending
- [ ] Invite email contains a working magic link with `redirect_to`
- [ ] User can click link → set password → land in target app
- [ ] `autoApplyOrgInviteByEmail` propagates errors (not silent)
- [ ] Eden can invite existing org members to a project (instant)
- [ ] Eden can invite new users (sends email, creates pending invite)
- [ ] New user lands in Eden after onboarding with correct project role
- [ ] All verification steps pass against local k3d stack
- [ ] Existing auth flows and Eden scenarios are not broken
