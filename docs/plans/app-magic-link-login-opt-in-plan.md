# App Magic-Link Login Opt-In Plan

> **Status**: Implemented and locally verified - 2026-05-09
> **Scope**: Platform SSO, API auth, manifest metadata, local k3d verification
> **Depends on**: [`app-branded-invite-emails-phase-1-plan.md`](./app-branded-invite-emails-phase-1-plan.md)

---

## Goal

Allow an Eve-deployed app to opt into passwordless browser login, using email magic links instead of username/password.

For a passwordless app:

- the SSO login page presents magic-link login as the primary and only app-facing login method;
- magic-link emails use the same app branding model as invite emails;
- self sign-up is disabled by default, so an email only receives a link if the user is already known to the app/org or has a pending invite;
- invited users accept the invite and land in the app without being asked to set a password.

This is a follow-on to app-branded invite emails. It should reuse the new `projects.branding`, `ProjectBrandingSchema`, `MailerService`, and GoTrue `generate_link` path instead of creating a second branding or mail system.

---

## Research Notes

### Supabase / GoTrue behavior

- Supabase magic links are passwordless email links. They are one-time use and email-only.
- Supabase documents magic links as the default email behavior of `signInWithOtp`; by default, that flow can create users unless `shouldCreateUser: false` is set.
- Redirect targets are constrained by the auth server's Site URL / redirect allow-list.
- Defaults documented by Supabase: a user can request a magic link once every 60 seconds and links expire after 1 hour.
- GoTrue's admin `generate_link` endpoint can generate links without sending email. Supabase client docs list `magiclink` as a supported type and state that `generateLink()` handles user creation for `signup`, `invite`, and `magiclink`.

Implication for Eve: do not call GoTrue directly from SSO for app-scoped passwordless login. Route through Eve API first so Eve can enforce "no self signup" before asking GoTrue to create/generate anything.

Primary references:

- Supabase passwordless email login guide: https://supabase.com/docs/guides/auth/auth-email-passwordless
- Supabase self-hosted GoTrue `POST /admin/generate_link`: https://supabase.com/docs/reference/self-hosting-auth/generates-an-email-action-link
- Supabase admin `generateLink` docs: https://supabase.com/docs/reference/dart/auth-admin-generatelink

### Current Eve behavior

- `apps/sso/src/main.ts` already has a visible "Send Magic Link" button and a `POST /auth/magiclink` proxy, but it calls GoTrue `/magiclink` directly. That means the email is globally GoTrue-rendered and cannot use project branding.
- The current SSO login page always renders password login, sign-up, and magic-link controls. It does not know which app initiated the login.
- Invite callbacks with `type=invite` always redirect through `/set-password` before the target app.
- App SDK login currently redirects to `/login?redirect_to=<current-url>` and does not pass project context. `eveAuthConfig()` returns org and platform URLs but not `EVE_PROJECT_ID`.
- The branded invite PR adds `projects.branding`, a shared API mailer, and branded invite rendering. That is the right foundation for branded magic-link email.

---

## Product Semantics

### Branding

Use the same branding model as invite emails.

Do not create separate `magic_link_branding`. A project defines:

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
```

The exact email copy can vary by action, but the template shell, logo, color, `From:` display name, reply-to, and support footer are shared:

- invite: "You have been invited to ACME Portal" / "Accept invite"
- magic login: "Sign in to ACME Portal" / "Sign in"

This is simpler than separate templates while avoiding confusing copy.

### Self sign-up

Passwordless app login should not imply open registration.

Default for app-scoped passwordless login:

- If the email belongs to an existing Eve user with access to the org/project, send a branded magic-link email.
- If the email has a pending org invite for that org/project, prefer the invite acceptance flow, not a generic login link.
- If the email is unknown and there is no pending invite, return a generic success response but do not create a GoTrue user and do not send email.

This avoids account enumeration and matches the expected app model: another user registers the new user's email through the invite flow.

### Invite acceptance

For apps that opt into passwordless login, an invite link should establish the session and redirect to the app without forcing `/set-password`.

The user can still set a password later if another app permits password login or if Eve exposes account settings later. Phase 1 does not need a password-management UI.

---

## Proposed Manifest

Add an optional project auth policy under `x-eve.auth`.

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
```

Schema:

```ts
export const ProjectAuthConfigSchema = z.object({
  login_method: z.enum([
    'password_or_magic_link',
    'password',
    'magic_link',
  ]).default('password_or_magic_link'),
  self_signup: z.boolean().default(false),
  invite_requires_password: z.boolean().default(true),
}).strict();

export type ProjectAuthConfig = z.infer<typeof ProjectAuthConfigSchema>;
```

Defaults:

- If `x-eve.auth` is absent, preserve current platform behavior.
- If `login_method: magic_link`, render app SSO as passwordless.
- If `self_signup: false`, Eve API must not call GoTrue for unknown emails.
- If `invite_requires_password: false`, SSO skips `/set-password` for invite callbacks in this project context.

Rationale:

- `login_method` controls login UI and allowed request type.
- `self_signup` is separated because a future consumer app may want passwordless open registration.
- `invite_requires_password` is separated because an app might allow magic-link login but still require password setup during first invite, though the ACME Portal-style case sets it to `false`.

---

## Data Model

Add project-level auth config beside project branding:

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auth_config JSONB;
```

Query support:

- Extend `Project` with `auth_config: ProjectAuthConfig | null`.
- Add `projects.updateAuthConfig(projectId, authConfig | null)`.
- Ensure `findById`, list, and service responses can expose safe auth context where needed.

Manifest sync:

- Add `ProjectAuthConfigSchema` and `getManifestAuthConfig(manifest)` in `packages/shared/src/schemas/manifest.ts`.
- In `ProjectsService.syncManifest`, parse and store auth config in both existing-hash and new-manifest paths.
- If `x-eve.auth` is removed, write `NULL`.

Do not store auth config inside `branding`; they are related at render time but separate product concepts.

---

## Public App Auth Context

SSO needs project context before the user is authenticated.

Add an unauthenticated, safe API endpoint, for example:

```http
GET /auth/app-context?project_id=proj_xxx
```

Response:

```json
{
  "project_id": "proj_xxx",
  "org_id": "org_xxx",
  "branding": {
    "app_name": "ACME Portal",
    "primary_color": "#1f6feb",
    "email_from_name": "ACME Portal"
  },
  "auth": {
    "login_method": "magic_link",
    "self_signup": false,
    "invite_requires_password": false
  }
}
```

Only return fields that are intended to be public in login/email surfaces. Do not expose secrets, repo URLs beyond current public surfaces, memberships, or internal manifest blobs.

This endpoint is used by:

- SSO `/login` to render method choices and branding;
- SSO `/auth/magiclink` to validate policy and forward to Eve API;
- SSO `/callback` to decide whether invite callbacks require `/set-password`.

---

## Project Context Propagation

The key implementation detail is preserving `project_id` from app login/invite through SSO and GoTrue redirects.

### App SDK

Update `eveAuthConfig()` in `packages/auth` to include:

```json
{
  "eve_project_id": "proj_xxx"
}
```

Update `packages/auth-react`:

```ts
window.location.href =
  `${ssoUrl}/login?project_id=${encodeURIComponent(projectId)}&redirect_to=${encodeURIComponent(returnUrl)}`;
```

If `project_id` is absent, fall back to current `/login?redirect_to=...`.

### Invite email path

When `OrgsService.createOrgInvite` receives `project_id`, include it in the SSO redirect used for GoTrue `generate_link`:

```ts
const ssoRedirect = `${ssoUrl}/?project_id=${encodeURIComponent(projectId)}&redirect_to=${encodeURIComponent(finalRedirect)}`;
```

The SSO root page already merges hash fragment tokens into query params. Extend it to preserve `project_id` alongside `redirect_to` when forwarding to `/callback`.

### Callback

`/callback` receives:

- `type=invite` or `type=magiclink` from GoTrue;
- `project_id` from the preserved SSO query;
- `redirect_to` either from the incoming query or `invite_redirect_to` from API exchange.

For `authType === 'invite'`:

- if project auth config says `invite_requires_password: false`, redirect straight to `redirect_to`;
- otherwise preserve current behavior and redirect to `/set-password`.

For `authType === 'magiclink'`:

- redirect straight to `redirect_to`.

If project context is missing or invalid, preserve current behavior for safety.

---

## Branded Magic-Link Email Path

Do not continue using SSO's direct GoTrue `/auth/magiclink` proxy for project-scoped magic links. It cannot enforce app membership before GoTrue user creation and cannot brand email.

Add an Eve API endpoint, for example:

```http
POST /auth/magic-link
Content-Type: application/json

{
  "email": "user@example.com",
  "project_id": "proj_xxx",
  "redirect_to": "https://app.example.com/"
}
```

Behavior:

1. Validate project exists and load `project.auth_config` plus `project.branding`.
2. If project does not have an auth policy that allows magic links (`magic_link` or `password_or_magic_link`), return 400.
3. Check whether the email is allowed to receive a link:
   - existing Eve user with org/project access: allowed;
   - pending invite matching `provider_hint='supabase'`, `identity_hint=email`, same org/project context: return generic success and let the invite email be the entry point;
   - unknown email and `self_signup=false`: return generic success, no email, no GoTrue call;
   - `self_signup=true`: allowed, but this is not the default.
4. Generate a GoTrue link with `type: 'magiclink'`, email, and SSO redirect containing `project_id` and final `redirect_to`.
5. Render/send the branded magic-link email through the shared mailer.
6. Always return `{ sent: true }` or `{ ok: true }` for non-policy failures that could reveal whether an email exists.

Refactor current invite template into shared action rendering:

```ts
renderAuthActionEmail({
  kind: 'invite' | 'magic_link',
  branding,
  actionLink,
  expiresAt,
})
```

Keep the HTML shell and branding identical. Only subject, intro text, and button label vary.

---

## SSO Login UI

Extend `loginPageHtml` to accept resolved context:

```ts
type SsoLoginContext = {
  projectId?: string;
  branding?: ProjectBranding | null;
  auth?: ProjectAuthConfig | null;
};
```

Rendering:

- `magic_link`: show email field and "Send sign-in link"; hide password field, sign-up tab, and password submit.
- `password`: show password login; hide magic-link button.
- `password_or_magic_link`: preserve current password plus magic-link UI, but route the magic-link request through Eve API when `x-eve.auth` is present so branding and `self_signup` policy are enforced.

For `self_signup=false`, hide the Sign Up tab and any "create account" wording.

Keep token paste in the app SDK, not SSO. The current SSO broker page does not expose token paste and this plan should not add it.

Failure/security behavior:

- `/auth/magiclink` should return a generic success message for unknown emails when self-signup is disabled.
- UI copy should say "If your email has access, you will receive a sign-in link."
- Rate limiting should rely on GoTrue where a GoTrue call occurs, but Eve should add a lightweight per-email/project cooldown before calling GoTrue to protect the no-self-signup path.

---

## File-Level Change List

| File | Change |
|---|---|
| `packages/db/migrations/00094_project_auth_config.sql` | Add `projects.auth_config JSONB` |
| `packages/db/src/queries/projects.ts` | Include `auth_config`; add `updateAuthConfig` |
| `packages/shared/src/schemas/manifest.ts` | Add `ProjectAuthConfigSchema`; extend `ManifestXeveSchema`; add `getManifestAuthConfig` |
| `apps/api/src/projects/projects.service.ts` | Persist `auth_config` during manifest sync, including existing-hash path and clearing |
| `packages/shared/src/schemas/auth.ts` | Add app-context and magic-link request/response schemas |
| `apps/api/src/auth/auth.controller.ts` | Add `GET /auth/app-context` and `POST /auth/magic-link` |
| `apps/api/src/auth/auth.service.ts` | Generalize `generateInviteLink` to `generateAuthActionLink(type, email, redirectTo)` |
| `apps/api/src/mailer/templates/invite.ts` | Refactor to shared auth action template or add sibling `auth-action.ts` |
| `apps/api/src/orgs/orgs.service.ts` | Include `project_id` in SSO redirect and skip-password decision context |
| `apps/sso/src/main.ts` | Resolve app context, render passwordless UI, call Eve API for branded magic links, preserve `project_id`, skip set-password where configured |
| `packages/auth/src/user.ts` | Include `eve_project_id` in `eveAuthConfig()` |
| `packages/auth-react/src/provider.tsx` | Pass `project_id` to SSO login URL |
| `docs/system/app-sso-integration.md` | Document `x-eve.auth` and passwordless app login |
| `docs/system/auth.md` | Document app-scoped magic link behavior and no-self-signup semantics |
| `tests/manual/scenarios/40-app-magic-link-login.md` | New local k3d scenario |
| `tests/manual/README.md` | Add Scenario 40 |
| `bin/eh-commands/k8s.sh` | Restart and wait for `eve-sso` during local k3d deploys so rebuilt SSO changes are actually exercised |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` | Document `x-eve.auth` |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md` | Document app-scoped magic-link auth |

OpenAPI artifacts must be regenerated if the API endpoints/schemas change.

---

## Implementation Order

1. **Schema and DB**
   - Add `ProjectAuthConfigSchema`, `getManifestAuthConfig`, migration, and project query support.
   - Unit-test manifest parsing and defaults.

2. **Manifest Sync**
   - Persist `auth_config` in existing-hash and new-manifest paths.
   - Verify clearing to `NULL` when removed.

3. **Public App Context**
   - Add API endpoint returning safe project branding/auth context.
   - Add service tests for valid/missing/deleted project behavior.

4. **Email Renderer**
   - Refactor invite rendering into shared auth-action template.
   - Add magic-link render tests using the same ACME Portal branding.
   - Keep invite snapshots stable except intentional function naming changes.

5. **Magic Link API Path**
   - Add `POST /auth/magic-link`.
   - Add eligibility checks for existing member, pending invite, unknown email, and self-signup disabled.
   - Use GoTrue `generate_link` with `type: 'magiclink'` only after eligibility passes.

6. **SSO Context and UI**
   - Preserve `project_id` through root/hash/callback.
   - Render magic-link-only login for opted-in apps.
   - Hide signup when `self_signup=false`.
   - Call Eve API for app-scoped magic-link requests.

7. **Invite Skip Password**
   - Include `project_id` in invite SSO redirect.
   - On invite callback, skip `/set-password` when `invite_requires_password=false`.
   - Keep current `/set-password` behavior for default/password apps.

8. **SDK Context Propagation**
   - Include `eve_project_id` in `/auth/config`.
   - Have `auth-react` pass it to SSO login.

9. **Docs, OpenAPI, Manual Scenario**
   - Update internal docs and eve-skillpacks.
   - Add Scenario 40.
   - Regenerate OpenAPI artifacts.

---

## Tests

### Unit / Focused Tests

- `ProjectAuthConfigSchema` accepts the documented block and rejects invalid login methods.
- `getManifestAuthConfig()` reads from both `x-eve.auth` and `x_eve.auth`.
- Manifest sync writes, updates, and clears `projects.auth_config`.
- App context endpoint returns branding plus auth config and only safe fields.
- Magic-link email renderer:
  - default Eve branding;
  - ACME Portal branding;
  - no logo for non-HTTPS logo URLs;
  - correct magic-link subject/button text.
- Magic-link API:
  - existing org/project member gets a branded email;
  - pending invite gets generic success and does not create a separate magic login if invite should be used;
  - unknown email with `self_signup=false` gets generic success, no GoTrue call, no email;
  - `self_signup=true` path calls GoTrue;
  - project not opted into magic link returns 400 for app-scoped request.
- SSO:
  - `/login?project_id=...` hides password/signup for `magic_link`;
  - root hash extraction preserves `project_id`;
  - invite callback skips `/set-password` only when project config says so;
  - default invite callback still goes to `/set-password`.
- `auth-react`:
  - `loginWithSso()` includes `project_id` when config provides it;
  - behavior is unchanged without `eve_project_id`.

### Regression Tests

- Existing Scenario 39 stays green: branded invite with password setup for default config.
- Existing Scenario 21 stays green for default web auth.
- `pnpm build`, OpenAPI diff, and API/auth package tests pass.
- `./bin/eh k8s deploy` restarts `eve-sso` after rebuilding images; otherwise SSO browser checks can accidentally validate a stale pod.

---

## Manual / Agent E2E: Scenario 40

Add `tests/manual/scenarios/40-app-magic-link-login.md`.

The scenario must be runnable by an agent against local k3d and must reuse the existing starter app, Mailpit, GoTrue, and SSO surfaces.

### Setup

```bash
./bin/eh status
./bin/eh k8s start
./bin/eh k8s deploy

export EVE_API_URL=http://api.eve.lvh.me
eve profile use local
eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
pnpm -C packages/cli build

curl -fsS http://api.eve.lvh.me/health | jq
curl -fsS http://auth.eve.lvh.me/health | jq
curl -fsS http://sso.eve.lvh.me/health | jq
curl -fsS http://mail.eve.lvh.me/api/v1/messages | jq '.messages | length'
```

### Deploy starter app

Use `../eve-horizon-starter`, matching Scenario 39:

```bash
export ORG_ID=org_magiclinkverify
eve org ensure "$ORG_ID" --name "magic-link-verify" --slug mlv --json

export STARTER_DIR=${STARTER_DIR:-../eve-horizon-starter}
export REPO_DIR=$(mktemp -d)/repo
cp -R "$STARTER_DIR" "$REPO_DIR"

PROJECT_JSON=$(eve project ensure \
  --org "$ORG_ID" \
  --name "magic-link-starter" \
  --slug mlstrt \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter \
  --branch main \
  --force \
  --json)
export PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.id // .data.id')

eve secrets set POSTGRES_PASSWORD eve --project "$PROJECT_ID" --json
eve env create sandbox --type persistent --project "$PROJECT_ID" --json || true
eve env deploy sandbox --ref main --repo-dir "$REPO_DIR" --project "$PROJECT_ID"
curl -fsS "http://api.mlv-mlstrt-sandbox.lvh.me/health" | jq
```

### Sync branding and auth config

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
```

Agent-safe insertion should escape `@` in Perl replacements, same as Scenario 39.

```bash
eve project sync --project "$PROJECT_ID" --dir "$REPO_DIR" --json
```

### Verify invite acceptance skips password setup

```bash
INVITE_EMAIL="magic-invite-$(date +%s)@eve.local"
node packages/cli/bin/eve.js org invite "$INVITE_EMAIL" \
  --org "$ORG_ID" \
  --project "$PROJECT_ID" \
  --redirect-to "http://api.mlv-mlstrt-sandbox.lvh.me/health" \
  --json
```

Assert Mailpit invite email:

- subject includes `ACME Portal`;
- From display name is `ACME Portal`;
- HTML includes logo URL and `#1f6feb`.

Then open the action link with Playwright or `./bin/eh browser`:

```bash
ACTION_LINK=$(jq -r '(.Text // "") | capture("Accept invite: (?<url>https?://[^[:space:]]+)").url' /tmp/magic-invite-mail.json)
./bin/eh browser open "$ACTION_LINK"
```

Pass condition:

- final URL is the app redirect or app health URL;
- browser never lands on `/set-password`;
- app receives a valid Eve user session.

Do not rely only on `curl` for this step. GoTrue returns hash-fragment tokens that require browser-side forwarding.

### Verify app-scoped magic-link login

After invite acceptance has created the user/session, clear browser session or use a fresh context.

Open:

```bash
http://sso.eve.lvh.me/login?project_id=$PROJECT_ID&redirect_to=http%3A%2F%2Fapi.mlv-mlstrt-sandbox.lvh.me%2Fhealth
```

Pass conditions:

- page is branded as ACME Portal;
- no password field is visible;
- no sign-up tab is visible;
- magic-link email submission says a generic "check your email" message.

Submit the invited user's email. Assert Mailpit:

- subject is `Sign in to ACME Portal`;
- From display name is `ACME Portal`;
- same logo/color/footer branding;
- action link exists.

Open the magic-link action link in browser and assert final app redirect.

### Verify no self signup

Submit a never-invited email:

```bash
UNKNOWN_EMAIL="unknown-$(date +%s)@eve.local"
```

Pass conditions:

- SSO/API returns generic success;
- Mailpit has no message to `$UNKNOWN_EMAIL`;
- API logs do not show a GoTrue `generate_link` call for that address;
- no Eve user/membership is created for `$UNKNOWN_EMAIL`.

### Verify default app behavior

Run a default app or remove `x-eve.auth` and sync:

- `/login?project_id=...` preserves current password + magic-link page;
- invite acceptance still routes to `/set-password`;
- Scenario 39 remains green.

---

## Rollout

- Local k3d ships with the PR and Scenario 40 validates the full loop.
- Staging should reuse the API SMTP env added for branded invites. If new SSO env is needed, make it in `../deployment-instance`; do not mutate live Kubernetes or AWS infra out of band.
- Feature is opt-in per project. Projects without `x-eve.auth` keep current behavior.
- No GoTrue global signup setting change in this phase. Eve enforces app-scoped no-self-signup before calling GoTrue.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Unknown-email login leaks account existence. | Return generic success for all app-scoped magic-link requests; do not call GoTrue when `self_signup=false` and email is not eligible. |
| GoTrue `generate_link` creates users for `magiclink`. | Only call `generate_link` after Eve eligibility checks pass. |
| Project context is lost in hash-fragment redirects. | Preserve `project_id` in root hash extraction and callback query params; test in browser. |
| Invite flows accidentally skip password for default apps. | Default `invite_requires_password=true`; add SSO regression tests and Scenario 39. |
| Magic-link email diverges from invite branding. | Use one shared auth-action renderer and `ProjectBrandingSchema`. |
| Existing apps rely on SSO signup tab. | No behavior change unless `x-eve.auth` is present. |
| Branded app login reveals unsafe project metadata. | Public app-context endpoint returns only safe auth/branding fields. |

---

## Open Decisions

1. Should `login_method: magic_link` imply `invite_requires_password: false`, or should the manifest require both fields? Recommendation: require both explicit fields in the first PR to avoid surprising password behavior.
2. Should pending-invite users requesting magic login receive a fresh invite email or no email? Recommendation: no generic magic login; show generic success and rely on explicit invite emails for first access.
3. Should org-level branding/auth defaults be added now? Recommendation: not in this PR. Use project config first, then add org fallback once there is a concrete multi-project org need.
4. Should self-signup ever be allowed for app-scoped magic links? Recommendation: support the flag in schema but keep default false and defer open-registration UX to a later plan.
