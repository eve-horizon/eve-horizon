# App Org Access and Admin Invites

> **Status**: Draft plan
> **Date**: 2026-05-10
> **Builds on**:
> - `docs/plans/app-branded-invite-emails-phase-1-plan.md`
> - `docs/plans/app-magic-link-login-opt-in-plan.md`
> - `docs/plans/app-initiated-user-onboarding-plan.md`
>
> **Goal**: Let an Eve-compatible app declare which orgs can use it, expose that app-scoped org access policy through simple SDK/API helpers, and give admins in those orgs a small in-app invite flow that adds new users to their org as regular members and sends them through the existing app-branded magic-link onboarding flow.

---

## Research Summary

The recent invite and magic-link work gives us the right foundation:

- `x-eve.branding` is synced onto `projects.branding` and is already used for app-branded invite and magic-link emails.
- `x-eve.auth` is synced onto `projects.auth_config` with:
  - `login_method`
  - `self_signup`
  - `invite_requires_password`
- `GET /auth/app-context?project_id=...` returns safe public project branding/auth policy for SSO rendering.
- `POST /auth/magic-link` sends branded app-scoped magic-link emails, but eligibility is currently tied to the project owner org or explicit project membership.
- `POST /orgs/:org_id/invites` exists and sends branded invite emails when a same-org `project_id` is provided.
- `orgs:invite` already exists and is granted to org `admin` and `owner`.
- Direct org membership changes still require `orgs:admin`, which is owner-only. That is good: org admins can invite but cannot directly add/remove arbitrary members.
- `@eve-horizon/auth` and `@eve-horizon/auth-react` currently assume a deployed app is bound to a single `EVE_ORG_ID` for user access checks.
- Local k3d already includes Mailpit at `http://mail.eve.lvh.me`; Scenarios 39 and 40 validate app-branded invite and magic-link email flows against the existing `../eve-horizon-starter` app.

The main gap is that the platform still treats the project owner org as the app's only org for app SSO and SDK authorization. For apps that are intentionally available to one or more customer orgs, we need an app access policy that is independent of project ownership.

---

## Product Semantics

### Who Can Invite

In v1, an in-app invite can be created by a user who satisfies all of these:

1. The caller is authenticated with an Eve user token.
2. The target org is allowed by the app's `x-eve.auth.org_access` policy.
3. The caller is a member of the target org.
4. The caller has role `admin` or `owner` in the target org, unless the app narrows this further.
5. The app's invite policy is enabled.

Use the existing platform permission model as the base rule:

- `orgs:invite` is the permission that allows invite creation.
- Today `orgs:invite` is granted to org `admin` and `owner`.
- The app-scoped endpoint should also enforce the app policy so a user cannot use an app to invite into an org that the app is not allowed to serve.

Regular org members can use the app if their org is allowed, but they cannot invite.

### Which Org The New User Joins

The invite target org is explicit. The in-app admin page sends `org_id`, and the server verifies it.

The created invite:

- stores `org_invites.org_id = target org`;
- stores `role = member`;
- stores `app_context.project_id = app project`;
- stores `app_context.org_id = target org`;
- sends the app-branded invite email;
- on first authentication, `autoApplyOrgInviteByEmail` creates `org_memberships(target_org, user, member)`.

No project membership is created by default. The app should treat membership in an allowed org as app access. If a future app needs app-specific roles, those should live in the app's own data model or in a later platform app-role layer.

### Branding

Use the same project branding for:

- app invite emails;
- app magic-link login emails;
- SSO login UI.

Do not add per-org branding in this phase. A project-scoped brand is simpler and matches the current invite/magic-link implementation.

---

## Proposed Manifest Shape

Extend `ProjectAuthConfigSchema` under `x-eve.auth`:

```yaml
x-eve:
  branding:
    app_name: "ACME Portal"
    primary_color: "#1f6feb"
    email_from_name: "ACME Portal"
  auth:
    login_method: magic_link
    self_signup: false
    invite_requires_password: false
    org_access:
      mode: allowlist
      allowed_orgs:
        - acme-retail
        - org_01khx...
      invite:
        enabled: true
        admin_roles: [admin, owner]
        invited_role: member
```

Schema intent:

```ts
const AppInvitePolicySchema = z.object({
  enabled: z.boolean().default(false),
  admin_roles: z.array(z.enum(['admin', 'owner'])).default(['admin', 'owner']),
  invited_role: z.literal('member').default('member'),
}).default({ enabled: false });

const AppOrgAccessConfigSchema = z.object({
  mode: z.enum(['project_org', 'allowlist']).default('project_org'),
  allowed_orgs: z.array(z.string().min(1)).default([]),
  invite: AppInvitePolicySchema,
}).default({ mode: 'project_org', allowed_orgs: [], invite: { enabled: false } });
```

Rules:

- `mode: project_org` is the default and preserves current behavior.
- `mode: allowlist` means the app can be used by the listed orgs.
- `allowed_orgs` accepts org IDs and org slugs.
- During manifest sync, resolve slugs to canonical org IDs and store normalized IDs in `projects.auth_config`.
- The project owner org may be included, but it is not implicitly included when `mode: allowlist` is used unless listed.
- `invite.invited_role` is fixed to `member` in v1. Do not let an app-facing invite endpoint create org admins or owners.
- `invite.enabled` is explicit. An app can be org-locked without exposing a self-serve invite UI.

---

## Access Model

The app is allowed for an org if:

- `mode = project_org` and `org_id == project.org_id`; or
- `mode = allowlist` and `org_id` is in the normalized allowlist.

A user can enter the app if:

- the user has an active Eve session;
- the user has org membership in at least one allowed org; and
- the app backend validates requests against an allowed active org.

Magic-link eligibility should use the same rule:

- existing user with membership in any allowed org can request a branded magic link;
- pending invite matching `(email, project_id, allowed org)` should return generic success and not send a separate generic magic login;
- unknown email with `self_signup=false` returns generic success without creating a GoTrue user or sending mail;
- `self_signup=true` remains supported but should not be the default for customer apps.

This keeps "org access", "magic-link eligibility", "app admin capabilities", and "SDK request auth" on one policy.

---

## API Design

### Public App Context

Keep the existing public endpoint:

```http
GET /auth/app-context?project_id=proj_xxx
```

Do not expose raw allowed org lists publicly by default. Public app context can include only a safe summary:

```json
{
  "project_id": "proj_xxx",
  "org_id": "org_project_owner",
  "branding": { "app_name": "ACME Portal" },
  "auth": {
    "login_method": "magic_link",
    "self_signup": false,
    "invite_requires_password": false,
    "org_access": {
      "mode": "allowlist",
      "multi_org": true,
      "invite_enabled": true
    }
  }
}
```

If exposing even the mode is considered too much, omit `org_access` from public app context and keep it on the authenticated endpoint only.

### Authenticated App Access

Add:

```http
GET /auth/app-access?project_id=proj_xxx
Authorization: Bearer <eve-user-token>
```

Response:

```json
{
  "project_id": "proj_xxx",
  "orgs": [
    {
      "id": "org_acme",
      "slug": "acme-retail",
      "name": "ACME Portal Retail",
      "role": "admin",
      "capabilities": {
        "enter_app": true,
        "invite_members": true
      }
    }
  ],
  "admin_orgs": [
    {
      "id": "org_acme",
      "slug": "acme-retail",
      "name": "ACME Portal Retail",
      "role": "admin"
    }
  ]
}
```

Return only orgs that are both allowed by the app and present in the caller's memberships. A project owner/system admin diagnostic mode can return all configured allowed orgs later, but the app UI only needs the caller's usable/admin orgs.

### App-Scoped Invite

Add a narrow app-facing invite endpoint:

```http
POST /auth/app-invites
Authorization: Bearer <eve-user-token>
Content-Type: application/json

{
  "project_id": "proj_xxx",
  "org_id": "org_acme",
  "email": "new.user@example.com",
  "redirect_to": "https://acme.example/admin/users"
}
```

Response:

```json
{
  "status": "invited",
  "org_id": "org_acme",
  "email": "new.user@example.com",
  "role": "member"
}
```

Rules:

- Require target org to be allowed for the app.
- Require caller to be `admin` or `owner` in that org, unless narrowed by `invite.admin_roles`.
- Force `role = member`.
- Force `send_email = true`.
- Force `app_context.project_id = project_id`.
- Force `app_context.org_id = org_id`.
- Use project branding for the email even when `project.org_id != org_id`, but only after app-org policy has approved that org.
- If email already belongs to a user who is already a target-org member, return `status: "already_member"` and do not create an invite.
- If an unused invite for the same `(project_id, org_id, email)` already exists, return `status: "pending"` and optionally resend only when the request includes `resend: true`.

Keep `POST /orgs/:org_id/invites` for CLI/platform admin usage. It remains broader and same-org project-branded by default. Apps should call the app-scoped endpoint.

---

## Refactoring Plan

### 1. Extract App Auth Policy Resolution

Add `apps/api/src/auth/app-auth-policy.service.ts`.

Responsibilities:

- Load project and parse `ProjectAuthConfig`.
- Normalize default config.
- Resolve `org_access.allowed_orgs` from slugs/IDs during manifest sync or on read.
- Return allowed org IDs for a project.
- Check whether an org is allowed for a project.
- Return app access context for a user:
  - allowed org memberships;
  - admin orgs;
  - invite capability per org.
- Check magic-link eligibility for a user/email.
- Check app invite authorization.

Primary methods:

```ts
getProjectPolicy(projectId: string): Promise<ProjectAppAuthPolicy>
getAllowedOrgIds(projectId: string): Promise<string[]>
isOrgAllowed(projectId: string, orgId: string): Promise<boolean>
getUserAppAccess(projectId: string, userId: string): Promise<AppAccessResponse>
assertCanInvite(projectId: string, orgId: string, userId: string): Promise<void>
```

Consumers:

- `AuthService.getAppAuthContext`
- `AuthService.sendAppMagicLink`
- new authenticated app access endpoint
- new app-scoped invite endpoint
- SDK remote verification route

### 2. Normalize Manifest Auth Config

Files:

- `packages/shared/src/schemas/manifest.ts`
- `apps/api/src/projects/projects.service.ts`
- `packages/shared/src/__tests__/manifest.spec.ts` or existing manifest tests

Changes:

- Extend `ProjectAuthConfigSchema` with `org_access`.
- Add a normalization step in `ProjectsService.syncManifest`:
  - parse `x-eve.auth`;
  - resolve `allowed_orgs` entries:
    - `org_...` is treated as an org ID;
    - otherwise treat as an org slug;
  - reject missing/deleted org refs with a clear `400`;
  - store canonical IDs in `projects.auth_config`.
- Preserve current behavior when `org_access` is omitted.

### 3. Refactor Invite Creation

Current `OrgsService.createOrgInvite` rejects project branding unless `project.org_id === invite.org_id`. That is correct for generic org invites, but too strict for a multi-org app whose project is owned by a platform org and allowed for customer orgs.

Add `OrgInviteService` or `AppInviteService`:

```ts
createOrgInvite(input: {
  orgId: string;
  createdBy: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  projectId?: string;
  redirectTo?: string;
  appContext?: Record<string, unknown>;
  allowCrossOrgProjectBranding?: boolean;
})
```

Rules:

- Generic `/orgs/:org_id/invites` calls it with `allowCrossOrgProjectBranding = false`.
- New `/auth/app-invites` calls it with `allowCrossOrgProjectBranding = true`, but only after `AppAuthPolicyService.assertCanInvite(...)` passes.
- The app-scoped controller never exposes `role` and always passes `member`.

This keeps the existing safe same-org invariant for broad org APIs while enabling controlled app-branded cross-org invites.

### 4. Update Magic-Link Eligibility

File:

- `apps/api/src/auth/auth.service.ts`

Replace the current project-owner-org-only check in `sendAppMagicLink` with app policy resolution:

1. Load project policy.
2. Ensure `login_method` allows magic links.
3. Resolve allowed org IDs.
4. If email belongs to an existing Eve user:
   - allow if the user has membership in any allowed org;
   - optionally allow explicit project membership for backwards compatibility.
5. Check pending invites across allowed orgs, not only `project.org_id`.
6. If matching pending invite exists, return generic success and do not send generic magic login.
7. If unknown and `self_signup=false`, return generic success and send nothing.
8. Otherwise send branded magic-link email.

Add an org-aware pending invite query:

```ts
findPendingByIdentityHintForOrgs(provider, email, orgIds)
```

or loop over the small allowed-org list in v1.

### 5. Improve Invite Redirect Org Context

To make the target org unambiguous after the user clicks an invite:

- store `app_context.org_id` on app-scoped invites;
- extend `AuthExchangeResponseSchema` with:
  - `invite_org_id?: string`
  - `invite_app_context?: Record<string, unknown>`
- have `autoApplyOrgInviteByEmail` return that context;
- have SSO append `eve_org_id=<target-org-id>` to the final redirect when an invite context has `org_id` and the app redirect does not already include it;
- have `@eve-horizon/auth-react` initialize `activeOrg` from `eve_org_id` query when it matches a user membership, then persist it in the existing `eve_active_org_id` storage.

This is not required for access control, but it makes the UX deterministic for users who belong to multiple allowed orgs.

### 6. SDK Helpers

Backend package `@eve-horizon/auth`:

- Keep existing `eveUserAuth()` behavior for single-org apps.
- Add `eveAppUserAuth()` for app-org allowlists.

Proposed API:

```ts
app.use(eveAppUserAuth({
  projectId: process.env.EVE_PROJECT_ID,
  eveApiUrl: process.env.EVE_API_URL,
  orgHeader: 'x-eve-org-id',
  strategy: 'remote',
}));
```

Behavior:

- Verify token.
- Call Eve API `GET /auth/app-access?project_id=...` with the user token.
- Select active org from `X-Eve-Org-Id`, `eve_org_id` query, stored frontend active org, or first allowed org.
- Attach `req.eveUser` only when selected org is allowed and present in user app access.
- Cache app access for a short TTL if needed.

React package `@eve-horizon/auth-react`:

- Add `useEveAppAccess(projectId?)`.
- Add `inviteMember({ orgId, email, redirectTo })`.
- Filter `orgs` to app-allowed orgs for app UI controls.
- Expose `adminOrgs` for a simple admin page:

```ts
const { adminOrgs, inviteMember } = useEveAppAccess();
```

Apps can then implement the admin page with a small form:

- org selector from `adminOrgs`;
- email input;
- submit calls `inviteMember`;
- success state says the email has been invited.

### 7. Optional CLI Support

Keep `eve org invite` unchanged for generic org work.

Add a project-aware diagnostic command only if useful:

```bash
eve app access --project proj_xxx --json
eve app invite user@example.com --project proj_xxx --org org_xxx --redirect-to http://app...
```

This is not necessary for app developers if the SDK helper is good enough, but it helps manual verification.

---

## File-Level Change Map

| File | Change |
| --- | --- |
| `packages/shared/src/schemas/manifest.ts` | Extend `ProjectAuthConfigSchema` with `org_access` |
| `packages/shared/src/schemas/auth.ts` | Add `AppAccessResponseSchema`, `AppInviteRequestSchema`, `AppInviteResponseSchema`, exchange invite context fields |
| `apps/api/src/projects/projects.service.ts` | Normalize org refs during manifest sync |
| `apps/api/src/auth/app-auth-policy.service.ts` | New policy resolver/service |
| `apps/api/src/auth/auth.controller.ts` | Add `GET /auth/app-access`, `POST /auth/app-invites` |
| `apps/api/src/auth/auth.service.ts` | Use app policy for app context, magic-link eligibility, exchange invite context |
| `apps/api/src/orgs/orgs.service.ts` | Move invite creation/email composition to shared invite service or add controlled cross-org app invite path |
| `packages/db/src/queries/org-invites.ts` | Add pending invite lookup by org list and project context |
| `packages/auth/src/user.ts` | Add `eveAppUserAuth`, expose active org selection |
| `packages/auth/src/unified.ts` | Mirror app-org behavior for unified user/agent middleware where applicable |
| `packages/auth-react/src/provider.tsx` | Initialize active org from invite redirect query; support app access hook |
| `packages/auth-react/src/types.ts` | Add app access/admin org types |
| `docs/system/app-sso-integration.md` | Document `x-eve.auth.org_access` and app invite flow after implementation |
| `docs/system/eve-auth-sdk.md` | Document `eveAppUserAuth` and `useEveAppAccess` after implementation |
| `tests/manual/scenarios/41-app-org-access-admin-invites.md` | New local k3d verification scenario |
| `tests/manual/README.md` | Add Scenario 41 entry |

---

## Test Plan

### Unit Tests

`ProjectAuthConfigSchema`:

- accepts omitted `org_access` and defaults to `project_org`;
- accepts `allowlist` with org IDs/slugs;
- rejects invalid roles and `invited_role != member`;
- rejects public self-signup defaults unchanged.

`AppAuthPolicyService`:

- `project_org` returns only `project.org_id`;
- `allowlist` returns normalized org IDs;
- caller member in allowed org can enter;
- caller member in unlisted org cannot enter;
- caller admin/owner in allowed org can invite when enabled;
- caller member cannot invite;
- caller admin in unlisted org cannot invite;
- invite disabled blocks app invites even when caller is org admin.

`sendAppMagicLink`:

- existing user in any allowed org receives branded magic-link email;
- existing user only in unlisted org gets generic success and no email;
- pending invite in any allowed org suppresses generic magic login;
- unknown email with `self_signup=false` gets generic success and no email;
- password-only project still rejects app-scoped magic-link request.

`AppInvite`:

- forces `role=member`;
- stores `app_context.project_id` and `app_context.org_id`;
- uses project branding for allowed cross-org app invite;
- rejects cross-org project branding through generic `/orgs/:org_id/invites`;
- returns already-member/pending states without duplicate invite spam.

SDK:

- `eveAppUserAuth` accepts selected allowed org;
- rejects selected unallowed org;
- falls back to first allowed org;
- `useEveAppAccess` exposes `adminOrgs` and invite helper.

### Integration Tests

- Auth controller tests for `GET /auth/app-access`.
- Auth controller tests for `POST /auth/app-invites`.
- Permission guard regression: `orgs:invite` remains admin/owner, not member.
- Manifest sync integration resolving org slug to ID.
- OpenAPI schema generation includes new endpoints and schemas.

### Regression Tests

- Scenario 21 web auth remains green.
- Scenario 39 app-branded invite remains green for same-org project invite.
- Scenario 40 app magic-link login remains green for single-org app.
- Default app without `x-eve.auth.org_access` remains single project-org behavior.

---

## Manual / Agent E2E: Scenario 41

Add `tests/manual/scenarios/41-app-org-access-admin-invites.md`.

The scenario must be runnable by an agent against local k3d and reuse:

- `../eve-horizon-starter`;
- local GoTrue;
- local SSO;
- local Mailpit at `http://mail.eve.lvh.me`;
- existing `./bin/eh browser` or Playwright browser flow.

### Setup

```bash
./bin/eh status
./bin/eh k8s start
./bin/eh k8s deploy

export EVE_API_URL=http://api.eve.lvh.me
eve profile use local
eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
pnpm -C packages/cli build

curl -fsS http://api.eve.lvh.me/health | jq .
curl -fsS http://auth.eve.lvh.me/health | jq .
curl -fsS http://sso.eve.lvh.me/health | jq .
curl -fsS http://mail.eve.lvh.me/api/v1/messages | jq '.messages | length'
```

Expected:

- k3d stack is deployed;
- API, GoTrue, SSO, and Mailpit are reachable;
- current checkout owns k3d or the agent has approval to deploy.

### Create Orgs

```bash
APP_ORG=org_appownerverify
TENANT_A=org_tenantaverify
TENANT_B=org_tenantbverify
TENANT_C=org_tenantcverify

eve org ensure "$APP_ORG" --name "app-owner-verify" --slug appowner --json
eve org ensure "$TENANT_A" --name "tenant-a-verify" --slug tena --json
eve org ensure "$TENANT_B" --name "tenant-b-verify" --slug tenb --json
eve org ensure "$TENANT_C" --name "tenant-c-verify" --slug tenc --json
```

Expected:

- app project owner org exists;
- two allowed tenant orgs exist;
- one unlisted tenant org exists for negative checks.

### Deploy Existing Starter App

Use the same starter app pattern as Scenarios 39 and 40:

```bash
export STARTER_DIR=${STARTER_DIR:-../eve-horizon-starter}
export REPO_DIR=$(mktemp -d)/repo
cp -R "$STARTER_DIR" "$REPO_DIR"

PROJECT_JSON=$(eve project ensure \
  --org "$APP_ORG" \
  --name "org-access-starter" \
  --slug orgacc \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter \
  --branch main \
  --force \
  --json)
export PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.id // .data.id')

eve secrets set POSTGRES_PASSWORD eve --project "$PROJECT_ID" --json
eve env create sandbox --type persistent --project "$PROJECT_ID" --json || true
eve env deploy sandbox --ref main --repo-dir "$REPO_DIR" --project "$PROJECT_ID"

curl -fsS "http://api.appowner-orgacc-sandbox.lvh.me/health" | jq .
```

Expected:

- starter app deploys;
- health endpoint is reachable.

### Sync App Branding, Magic Link, And Org Access

Inject:

```yaml
x-eve:
  branding:
    app_name: "ACME Portal"
    app_logo_url: "https://sandbox.acme.example/assets/logo.svg"
    primary_color: "#1f6feb"
    email_from_name: "ACME Portal"
    reply_to_email: "support@acme.example"
    support_email: "support@acme.example"
    support_url: "https://acme.example/help"
  auth:
    login_method: magic_link
    self_signup: false
    invite_requires_password: false
    org_access:
      mode: allowlist
      allowed_orgs:
        - tena
        - tenb
      invite:
        enabled: true
        admin_roles: [admin, owner]
        invited_role: member
```

Then:

```bash
eve project sync --project "$PROJECT_ID" --dir "$REPO_DIR" --json
curl -fsS "$EVE_API_URL/auth/app-context?project_id=$PROJECT_ID" | jq .
```

Expected:

- manifest sync succeeds;
- org slugs are resolved to IDs in stored auth config;
- public app context remains safe;
- app SSO still renders with project branding.

### Seed Admin And Member Users

Use existing platform auth helpers to create or invite users into tenant orgs:

- `tenant-a-admin@example.eve.local` as `admin` in `TENANT_A`;
- `tenant-a-member@example.eve.local` as `member` in `TENANT_A`;
- `tenant-c-admin@example.eve.local` as `admin` in `TENANT_C`.

Expected:

- tenant A admin has `orgs:invite`;
- tenant A member does not have `orgs:invite`;
- tenant C admin has `orgs:invite` in an org the app does not allow.

### Verify App Access Listing

As tenant A admin:

```bash
curl -fsS "$EVE_API_URL/auth/app-access?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $TENANT_A_ADMIN_TOKEN" \
  | tee /tmp/app-access-tenant-a-admin.json | jq .
```

Pass conditions:

- response includes `TENANT_A`;
- response does not include `TENANT_C`;
- `TENANT_A.capabilities.enter_app == true`;
- `TENANT_A.capabilities.invite_members == true`;
- `admin_orgs` includes `TENANT_A`.

As tenant A member:

- response includes `TENANT_A`;
- `invite_members == false`;
- `admin_orgs` is empty.

As tenant C admin:

- response has no allowed orgs;
- app backend SDK guard rejects protected app routes for that user.

### Verify App Admin Invite

As tenant A admin:

```bash
INVITE_EMAIL="tenant-a-invite-$(date +%s)@eve.local"

curl -fsS -X POST "$EVE_API_URL/auth/app-invites" \
  -H "Authorization: Bearer $TENANT_A_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\":\"$PROJECT_ID\",
    \"org_id\":\"$TENANT_A\",
    \"email\":\"$INVITE_EMAIL\",
    \"redirect_to\":\"http://api.appowner-orgacc-sandbox.lvh.me/health\"
  }" \
  | tee /tmp/app-org-invite-response.json | jq .
```

Pass conditions:

- response status is `invited`;
- role is `member`;
- invite row has `org_id == TENANT_A`;
- invite row has `app_context.project_id == PROJECT_ID`;
- invite row has `app_context.org_id == TENANT_A`.

Assert Mailpit:

```bash
sleep 1
MESSAGE_ID=$(curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq -r --arg email "$INVITE_EMAIL" '
    .messages[]
    | select((.To[]?.Address // "") == $email)
    | select(.Subject | contains("ACME Portal"))
    | .ID
  ' | head -1)

test -n "$MESSAGE_ID"
curl -s "http://mail.eve.lvh.me/api/v1/message/$MESSAGE_ID" \
  | tee /tmp/app-org-invite-mail.json

jq -e '.From.Name == "ACME Portal"' /tmp/app-org-invite-mail.json
jq -e '.Subject | contains("ACME Portal")' /tmp/app-org-invite-mail.json
jq -e '(.HTML // "") | contains("https://sandbox.acme.example/assets/logo.svg")' /tmp/app-org-invite-mail.json
jq -e '(.HTML // "") | contains("#1f6feb")' /tmp/app-org-invite-mail.json
```

Open the action link in browser:

```bash
ACTION_LINK=$(jq -r '
  (.Text // "")
  | capture("Accept invite: (?<url>https?://[^[:space:]]+)").url
' /tmp/app-org-invite-mail.json)

test -n "$ACTION_LINK"
./bin/eh browser open "$ACTION_LINK"
```

Pass conditions:

- browser completes GoTrue to SSO flow;
- browser does not land on `/set-password`;
- final redirect reaches the starter app;
- new user is an org `member` in `TENANT_A`;
- new user is not a member of `APP_ORG`, `TENANT_B`, or `TENANT_C`;
- app access endpoint for the new user's token includes only `TENANT_A`.

### Verify Negative Cases

As tenant A member:

- `POST /auth/app-invites` to `TENANT_A` returns `403`.

As tenant C admin:

- `POST /auth/app-invites` to `TENANT_C` returns `403`.

As tenant A admin:

- `POST /auth/app-invites` with `org_id = TENANT_C` returns `403`.
- trying to pass `"role": "admin"` is ignored or rejected; created role must still be `member`.

Magic-link checks:

- invited user can request branded app magic link after invite acceptance;
- unknown email gets generic success and no Mailpit message;
- user in unlisted `TENANT_C` gets generic success and no Mailpit message.

Regression checks:

- Scenario 39 still passes.
- Scenario 40 still passes.
- default project with no `org_access` remains project-org only.

---

## Rollout Order

1. Shared schemas and auth config normalization.
2. `AppAuthPolicyService`.
3. App access endpoint.
4. App-scoped invite endpoint and invite service refactor.
5. Magic-link eligibility refactor.
6. SDK helpers.
7. SSO invite org redirect polish.
8. Scenario 41 and docs updates.
9. Full local k3d verification loop.

This order keeps each layer testable. The app access endpoint can be verified before any email flow changes, and the invite endpoint can reuse the existing Mailpit checks from Scenarios 39 and 40.

---

## Security Notes

| Risk | Mitigation |
| --- | --- |
| App leaks a private customer org list publicly | Keep raw allowlist off public app context; authenticated app access returns only caller-visible orgs. |
| App admin invites users into the wrong org | Require explicit `org_id`; verify it is allowed by app policy and the caller is admin/owner in that org. |
| App admin escalates invitee to admin/owner | App-scoped endpoint forces `role = member`. |
| Cross-org project branding bypasses org boundaries | Only allow cross-org project branding in the app-scoped endpoint after app policy authorization; keep generic org invite same-org restricted. |
| Unknown-email magic link leaks account existence | Preserve generic success and no email when `self_signup=false`. |
| User belongs to multiple allowed orgs and lands in wrong org context | Store `app_context.org_id`, return invite org context from exchange, and initialize active org from `eve_org_id` redirect param. |
| SDK-only enforcement is bypassed | Enforce policy in Eve API for login/invite and in app backend middleware for app routes. Frontend checks are UX only. |

---

## Open Questions

1. Should project owners/system admins be able to view the complete configured allowlist through an authenticated diagnostic endpoint, or is manifest/source control enough?
2. Should `allowed_orgs` support org names in addition to IDs/slugs? Recommendation: no for v1; names are less stable and can collide by case/user expectation.
3. Should an app-scoped invite resend an existing pending invite by default? Recommendation: no; return `pending` and require explicit `resend: true`.
4. Should existing target-org members get a fresh branded magic-link email when entered in the invite form? Recommendation: return `already_member` in v1 and let the app UI tell the admin the user already has access.

---

## Exit Criteria

- App auth config can declare `org_access` with an org allowlist and invite policy.
- Manifest sync resolves org slugs/IDs and stores canonical allowed org IDs.
- Apps can call one authenticated endpoint to list the caller's allowed/admin orgs.
- App admins can invite email addresses only into allowed orgs where they are admin/owner.
- App-scoped invites always create regular org members.
- Invite and magic-link emails use the same project branding.
- Magic-link login eligibility uses app allowed orgs rather than only project owner org.
- The app SDK can enforce app-org access on backend routes.
- Scenario 41 verifies the full loop against local k3d, existing starter app, GoTrue, SSO, and Mailpit.
- Scenarios 39 and 40 remain green.
