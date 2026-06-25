# App-Branded Invite Emails (Proposal)

> **Status**: Proposal — not yet scheduled.
> **Driver**: `example-org/example-app` (ACME Portal POC). ExampleCo-facing demo of an ACME Portal-branded portal needs invite emails that read as ACME Portal, not "Eve" or "Supabase".
> **Last updated**: 2026-05-09

---

## Why This Matters

Eve Horizon is a multi-tenant deployment platform: it hosts apps owned by different brands (`acme-portal`, `acme-new-horizon`, internal tools, future tenants). Today, **every invite email and every SSO landing page is hardcoded as "Eve"**, regardless of which app initiated the invite.

For `acme-portal`, the imminent ExampleCo demo and the 1k → 10k unit ACME Tag PO depend on the system reading as a polished ACME Portal product. A retail buyer receiving an email that says *"You've been invited to Eve"* with a button leading to a *"Eve — Set Password"* page will at best ask awkward questions and at worst reject the deployment as unfinished.

This is the first concrete tenant where the gap blocks a sale. It is also a gap that **every future Eve-deployed app will hit** the moment it has external users — i.e., every customer-facing app, ever. We should fix it once, in the platform, and have every app inherit it.

The platform-gaps-first principle (CLAUDE.md): app-level workarounds (custom email-sending in the app, separate auth stack) would defeat the entire point of Eve providing SSO. The fix belongs in eve-horizon.

---

## Current State (Observed)

### Invite trigger and storage

- `POST /orgs/:org_id/invites` (per-org invite, `apps/api/src/orgs/orgs.controller.ts:233`)
- `POST /auth/supabase/invite` (system-admin invite, `apps/api/src/auth/auth.controller.ts:344`)
- Invites persist in `org_invites` (`packages/db/src/queries/org-invites.ts:3`) with:
  - `org_id`, `created_by`, `invite_code` (already a 24-byte url-safe random)
  - `provider_hint`, `identity_hint` (email)
  - `redirect_to` (final app URL after invite redemption)
  - `app_context` (jsonb — currently unused on the email side)
  - `expires_at`, `used_at`

### Email send path

`OrgsService.createOrgInvite` (`apps/api/src/orgs/orgs.service.ts:416`) calls `AuthService.sendSupabaseInvite` (`apps/api/src/auth/auth.service.ts:494`), which delegates to **GoTrue's admin `POST /invite`**:

```ts
await fetch(`${authUrl}/invite`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, ... },
  body: JSON.stringify({ email, data: { invited_via: 'eve-admin' }, redirect_to: ssoRedirect }),
});
```

GoTrue then renders **its own built-in invite email template** (Supabase defaults: "You have been invited"), sends via SMTP (Mailpit locally; see `k8s/base/supabase-auth-deployment.yaml`), and the user clicks a link that hits `${API_EXTERNAL_URL}/verify` → redirects to `${GOTRUE_SITE_URL}` with hash-fragment tokens.

### Landing pages (SSO broker — `apps/sso/src/main.ts`)

After the user clicks the email link, they land in the SSO broker:

- `/` and `/callback` — both render hardcoded `<h1>Eve</h1>` with the strapline "Sign in to your account".
- `/login` — `loginPageHtml` is hardcoded `Eve` with footer "Powered by Eve Horizon" (`main.ts:171`, `main.ts:340`).
- `/set-password` — invite users *always* land here; hardcoded `<h1>Eve</h1>` and tagline (`main.ts:893`).
- Final redirect lands on the app's own UI, which is the only branded surface the user ever sees.

### What's already there

- `org_invites.app_context` (jsonb) — present, untouched, ready to carry brand context.
- `org_invites.invite_code` — already a one-time secret. We do not rely on GoTrue's URL fragment if we don't want to.
- `redirect_to` plumbing — the SSO broker already preserves a target redirect across the GoTrue magic-link round-trip (`apps/sso/src/main.ts:711`, `exchange.invite_redirect_to`).
- `EVE_PROJECT_ID`, `EVE_ORG_ID` are auto-injected into deployed apps — apps already know who they are.

### What's missing

1. **No per-app branding model.** Orgs and projects have no `branding` field, no logo, no support email, no display name distinct from internal slug.
2. **GoTrue is the email renderer.** Its template is single-tenant (one config, one look). It cannot read per-invite branding.
3. **SSO broker pages are hardcoded.** No mechanism to vary copy, logo, or colour by the inviting app.
4. **`From:` and `Reply-To` are global.** GoTrue env (`GOTRUE_SMTP_ADMIN_EMAIL`) sets one sender for everything (`noreply@eve.local` locally). A retail brand can't appear as `noreply@acme.example`.

---

## Design Goals

1. **Per-app branding** — name, logo, primary colour, support email/URL, sender-name configurable per project.
2. **Manifest-authored** — same model as the rest of Eve: branding lives in `.eve/manifest.yaml` under `x-eve.branding`, syncs to DB on deploy. No new admin UI required.
3. **Inherits sensibly** — project → org → platform default ("Eve").
4. **End-to-end coverage** — the email itself, the `/set-password` page, the `/login` page if entered through an app, and the post-set-password redirect.
5. **Don't fight GoTrue.** Keep using it for credential storage, JWT issuance, magic-link mechanics. Replace only the parts where multi-tenancy needs custom behaviour: email rendering and the visible HTML pages.
6. **Phaseable.** Phase 1 must be small enough to ship in days for the ACME Portal demo. Later phases harden the model.

---

## Options Considered

### Option A — Configure GoTrue templates per app

Use `GOTRUE_MAILER_TEMPLATES_INVITE` (URL pointing to remote HTML) and `GOTRUE_MAILER_SUBJECTS_INVITE`.

- **Pros**: Minimal new code; GoTrue does the SMTP work.
- **Cons**: GoTrue config is **process-wide**, not per-request. We'd need one GoTrue deployment per app — multi-tenancy goes out the window. Sender domain still global. Doesn't help with `/set-password` page branding.
- **Verdict**: Reject. Single-tenant by design.

### Option B — Per-org branding column + GoTrue invite + branded SSO pages

Add `branding` jsonb to `orgs`. SSO broker reads org-id from invite session, renders branded `/set-password`. Email body still GoTrue-default.

- **Pros**: Smallest schema change.
- **Cons**: Email is the most visible touchpoint and stays "Eve". Doesn't satisfy the ACME Portal ask.
- **Verdict**: Insufficient on its own.

### Option C — Eve sends invite emails directly; GoTrue used only for credential lifecycle

Eve API renders a templated invite email per project, sends via the same SMTP relay GoTrue uses (Mailpit / SES), and the email link uses our existing `org_invites.invite_code` (not GoTrue's `confirmation_token`). The SSO broker exposes `/invite/redeem?code=<invite_code>` which:

1. Looks up the invite.
2. Calls GoTrue admin to ensure-or-create the user (idempotent).
3. Issues a one-time GoTrue session via `generate_link` admin API (or signs in the user via service-key).
4. Marks the invite as used.
5. Redirects to `/set-password?app=<project_id>&redirect_to=<...>`.

The `/set-password`, `/login`, and `/callback` pages take an `app` query param (or read it from the session cookie set during redeem) and load branding from the API.

- **Pros**: Full per-tenant control of email content + From: address + landing pages. Reuses existing `invite_code` column. Standard pattern (Auth0, Clerk, WorkOS all do this). Decouples from GoTrue's template limitations forever.
- **Cons**: New email-rendering code in the API; need an SMTP/SES integration; need to confirm GoTrue admin "issue session for user" path (it has one — `POST /admin/generate_link` returns a one-time token we can redeem server-side).
- **Verdict**: **Recommended.**

### Option D — Build a separate per-tenant mailer service

A dedicated `eve-mailer` microservice with template registry, per-tenant SMTP config, etc.

- **Pros**: Clean boundary.
- **Cons**: Massive overkill for the present scale. Not 6th service worth of complexity. Would slow ACME Portal delivery.
- **Verdict**: Reject for now; could extract later if mail volume warrants it.

---

## Recommended Approach (Option C, phased)

### Data model

Add a `branding` jsonb column on **`projects`** and a fallback on **`orgs`**:

```sql
ALTER TABLE orgs     ADD COLUMN branding jsonb;
ALTER TABLE projects ADD COLUMN branding jsonb;
```

Resolution order at email send time: `project.branding` → `org.branding` → platform defaults.

Shape (validated by zod in `packages/shared`):

```ts
const BrandingSchema = z.object({
  app_name:          z.string().max(60),         // "ACME Portal"
  app_logo_url:      z.string().url().optional(),// https://...svg or png
  primary_color:     z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  email_from_name:   z.string().max(60).optional(),// "ACME Portal"
  email_from_address:z.string().email().optional(),// must be in verified-domain list
  reply_to_email:    z.string().email().optional(),
  support_email:     z.string().email().optional(),
  support_url:       z.string().url().optional(),
  login_tagline:     z.string().max(120).optional(),
  footer_text:       z.string().max(120).optional(),
});
```

### Manifest authoring

```yaml
# .eve/manifest.yaml (acme-portal)
x-eve:
  branding:
    app_name: "ACME Portal"
    app_logo_url: "https://sandbox.acme.example/assets/logo.svg"
    primary_color: "#1f6feb"
    email_from_name: "ACME Portal"
    email_from_address: "noreply@acme.example"
    reply_to_email: "support@acme.example"
    support_email: "support@acme.example"
    support_url: "https://acme.example/help"
    login_tagline: "Loss-prevention insights for retail"
    footer_text: "ACME Portal · Operated by the platform operator on Eve Horizon"
```

`eve env deploy` parses this and writes `projects.branding`. Existing manifest-sync infrastructure already handles equivalent `x-eve.*` blocks (`x-eve.permissions`, `x-eve.packs`).

### Invite request gains `project_id`

```ts
// packages/shared/src/schemas/auth.ts (OrgScopedInviteRequestSchema)
project_id: z.string().optional(),  // resolves which branding to apply
```

When set, `OrgsService.createOrgInvite` resolves branding via `project_id || org_id || default`.

### Email send path

Replace the call to GoTrue `/invite` with:

1. **Ensure-user**: GoTrue admin `POST /admin/users` (idempotent — return existing user on conflict).
2. **Render email** from a per-tenant template (server-side, e.g. `mjml` or plain handlebars; one HTML + one text template, parameterised by `BrandingSchema` + `{invite_url, expires_at}`).
3. **Send** via a single shared mailer abstraction (`MailerService`) backed by SMTP (Mailpit locally, SES staging/prod). The mailer takes a `from` and a `reply_to` from branding, falling back to platform defaults.
4. **`invite_url`** points to the SSO broker: `${SSO_URL}/invite/redeem?code=${invite_code}` — uses our own one-time code, not GoTrue's URL fragments.

### SSO broker — new route

Add `GET /invite/redeem?code=...` to `apps/sso/src/main.ts`:

1. Call Eve API `POST /auth/invites/redeem` with the code (server-to-server with service token).
2. The API:
   - Looks up the invite, marks it `used_at = NOW()`.
   - Calls GoTrue admin to mint a magic-link session for that email.
   - Returns `{ refresh_token, redirect_to, project_id }`.
3. SSO broker sets the session cookies (`eve_sso_rt`, `eve_sso`) and redirects to `/set-password?app=<project_id>&redirect_to=<...>`.

### SSO broker — branded pages

`/set-password`, `/login`, `/callback`, and the holding page at `/` accept `?app=<project_id>` (or read it from the active session cookie) and call **`GET /auth/branding/:project_id`** on the API to fetch the resolved profile. The HTML templating already exists as functions in `main.ts` — we replace the hardcoded "Eve" with `{branding.app_name}` and inject `{branding.app_logo_url}`, `{branding.primary_color}`, etc. Footer reads "Secured by Eve" only when no branding is set (or via an opt-out flag).

The branding endpoint is **public** (no auth) — it returns only fields safe for unauthenticated rendering and is cached aggressively.

### `From:` address — verified domains

Allow `email_from_address` only when the apex domain has been verified for the project (manifest `x-eve.branding.email_from_address` rejected at deploy time otherwise). Store verified domains in a new `project_email_domains` table; verification via DNS TXT record or SES sandbox-out-of-the-box. Until verified, fall back to `noreply@<sso-host>` and use `Reply-To:` for the brand.

For Phase 1, ACME Portal can use the platform's default `From:` and a branded display name only ("ACME Portal <noreply@eve.example.com>"). Domain verification ships in Phase 3.

---

## Phasing

| Phase | Scope | Unblocks | Rough size |
|---|---|---|---|
| **1** | `branding` column on projects/orgs; manifest sync; `project_id` on invite request; **email body templated and branded** (using platform `From:`, branded display-name); MailerService abstraction with SMTP backend already wired into GoTrue. | ACME Portal demo email looks like ACME Portal | ~3 days, single PR |
| **2** | `/invite/redeem` SSO route using `invite_code`; branded `/set-password` page; `GET /auth/branding/:project_id` public endpoint. | ACME Portal landing page also branded; we drop GoTrue's URL-fragment dance for invites. | ~3-4 days |
| **3** | Per-project verified `From:` domains (SES + DNS verification); branded `/login` and `/callback`; magic-link and recovery emails branded too. | Production-grade tenancy; emails appear from the brand's own domain. | ~1-2 weeks |
| **4** (later) | Self-service branding UI in the dashboard; theme presets; localisation. | Self-serve onboarding for external tenants. | Whenever |

Phase 1 alone unblocks the immediate ACME Portal ask. Phases 2-3 raise the bar for any future external-user app.

---

## Risk / Trade-offs

- **Bypassing GoTrue's invite URL** means we own the security of the redemption link. Mitigation: re-use the existing `invite_code` (24 random bytes, base64url, already a CSPRNG), enforce `expires_at`, mark `used_at`, single-use.
- **Manifest-driven branding** is convenient but means a deploy is required to change the logo. Acceptable for now; a UI is a Phase 4 nicety.
- **Email rendering in the API** adds a small dependency (a templating lib + an SMTP/SES client). Both are tiny and well-understood.
- **`From:` domain verification** is a non-trivial sub-feature; deferring it to Phase 3 is the right call. Phase 1's "branded display name on platform domain" is enough for an internal demo and most B2B contexts.
- **Multiple Eve-deployed apps in one browser session.** A user invited into ACME Portal who is also a member of another Eve app should still see ACME Portal branding *during the invite flow*. The `?app=` query param plus the invite-bound session cookie disambiguate; the existing root-domain `eve_sso_rt` cookie is unaffected (it carries credentials, not branding).

---

## Out of Scope

- Per-app **email templates** (custom HTML beyond the branded shell). Could come in Phase 4.
- Localisation / i18n.
- Branded **error pages** in the SSO broker (404, 500). Trivial extension once `/set-password` is branded.
- Branding the password-recovery and email-change flows. Same mechanism applies; deferred to keep Phase 1 small.

---

## Open Questions

1. **Project-level vs org-level branding default.** ACME Portal has one project; multi-project orgs may want a single brand. Recommendation: project overrides org; org overrides platform. Both columns nullable.
2. **Who is allowed to set `email_from_address`?** Recommendation: org admins only, gated on a verified-domain check.
3. **Should the platform footer ("Secured by Eve") be removable for paying tenants?** Commercial decision; not a technical one. Plumbing should support both.
4. **SES vs Mailpit vs sendgrid for production.** Eve already has AWS infra (`deployment-instance-repo`); SES is the natural fit. Phase 1 can ship using whatever GoTrue's SMTP relay points at; no production decision needed yet.
5. **Existing GoTrue templates (recovery, magic-link, email-change).** Phase 3 should refactor these too, otherwise users get branded invites but Eve-branded password resets. Tracked as part of Phase 3 scope.

---

## Summary

The platform has all the moving parts (`org_invites.app_context`, `redirect_to`, `invite_code`, the SSO broker, the project-deploy auto-injection of `EVE_PROJECT_ID`); it just doesn't have a branding model and routes invite emails through GoTrue's single-tenant template. Adding a `branding` jsonb on projects, replacing the email-send path with a templated mailer, and serving the SSO broker pages from the same branding model gives every Eve-deployed app — starting with ACME Portal — invite emails that read as their own product, with no app-side workaround.
