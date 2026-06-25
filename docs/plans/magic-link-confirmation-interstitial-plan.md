# Magic-Link Confirmation Interstitial Plan

> **Status**: Proposed — 2026-05-12
> **Scope**: Eve SSO (`apps/sso`), API auth/org invite send paths (`apps/api/src/auth`, `apps/api/src/orgs`), new DB table for short-lived wrap tokens
> **Repos touched**: `eve-horizon-2` only
> **Related**:
> - [`app-magic-link-login-opt-in-plan.md`](./app-magic-link-login-opt-in-plan.md) (shipped — original opt-in)
> - [`app-magic-link-domain-allowlist-plan.md`](./app-magic-link-domain-allowlist-plan.md) (shipped v0.1.279/v0.1.281 — pre-approves email domains; surfaced this bug first)
> - [`magic-link-email-silent-drop-plan.md`](./magic-link-email-silent-drop-plan.md) (shipped — SES suppression visibility)
> - [`app-branded-invite-emails-phase-1-plan.md`](./app-branded-invite-emails-phase-1-plan.md) (shipped — branded auth-action mail)

---

## Goal

Make Eve-rendered app magic-link emails and Eve-rendered invite emails survive being fetched by email-security scanners (Microsoft Defender SafeLinks, Mimecast, Proofpoint, Barracuda, Cisco IronPort) so that the human recipient — not the scanner — is the one who burns the underlying single-use OTP.

After this ships, the worst case for a scanner that follows every URL in one of those emails is "the scanner loads an HTML page and stops". The OTP is only consumed when a human clicks a button on that page, which causes a `POST` from the user's browser back to Eve.

Concrete success criterion: clicking the magic-link email button from an Outlook 365 mailbox protected by Defender for Office 365 SafeLinks lands the user signed in on the first try, not on a `?error_code=otp_expired` page.

---

## Diagnosis

### What broke for the first real user

ACME Portal domain-signup rolled out on `release-v0.1.281`. The first external tester (corporate inbox on `acme.example`) reported the magic-link click landing on `https://sso.eve.example.com/callback?...&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`, with the page hanging on "Authenticating…".

Two stacked failures:

1. **Root cause — single-use OTP consumed before the human clicked**. The email-security gateway sitting in front of the mailbox fetched the URL to scan it. That fetch hit GoTrue's `/verify` endpoint with the magic-link token, which is single-use and was burned on that scanner request. When the human clicked the (now-rewritten / wrapped) link a few seconds later, GoTrue rejected the second redemption attempt with `otp_expired`.
2. **UX bug — Eve never surfaced the error**. `apps/sso/src/main.ts:976` returns the "Authenticating…" extractor HTML whenever `access_token`/`refresh_token` are missing from the callback query, even when `error_code` is present. The extractor's JS only handles tokens in the URL hash. Result: infinite "Authenticating…" with no path forward.

Failure #2 is covered as a small companion fix in this plan (Lane 4) because it's the same investigation. The main scope is failure #1.

### Why GoTrue OTPs are scanner-fragile today

`apps/api/src/auth/auth.service.ts:587 generateAuthActionLink` calls GoTrue `POST /admin/generate_link` with `type=magiclink` or `type=invite`. GoTrue returns an `action_link` of the form:

```
https://supabase-host/verify?token=<otp>&type=magiclink
   &redirect_to=https%3A%2F%2Fsso.eve.example.com%2Fcallback%3F...
```

Today every Eve-rendered action email puts that URL directly into the email template (`renderAuthActionEmail` / `renderInviteEmail` in `apps/api/src/mailer/templates/invite.ts`):

- `AuthService.sendEligibleMagicLink` — app-scoped magic-link login.
- `AuthService.sendProjectInviteEmail` — app-scoped org invite and resend.
- `AuthController.sendSupabaseInvite` — legacy/default-branded system-admin invite.
- `OrgsService.createInvite` when `send_email !== false` — org invite email, optionally project-branded.

Anyone (or anything) that follows that URL via `GET` consumes the OTP. Industry standard for security scanners is to do exactly that — for example, Microsoft Defender for Office 365 Safe Links fetches every URL with no per-recipient deduplication and no concept of "this is a single-use link, don't consume it".

`GoTrue` does not offer a multi-use mode for magic-link tokens and there is no per-User-Agent allowlist on the verify endpoint. The OTP TTL is 1 hour by default; even raising the TTL doesn't help because the failure mode is *consumption*, not *expiry*.

### Why this needs to be fixed in the platform

CLAUDE.md "Platform Gaps First — Never Work Around Them" applies. Every Eve-deployed app that opts into magic-link or invite-by-email login will hit this whenever the recipient sits behind a corporate mail gateway, which is most B2B customers. Options that don't scale:

- Telling every app to switch to `login_method: password` — defeats the magic-link product.
- Telling every operator to disable scanner protection on their inbox — not their decision to make.
- Pinning each app to OTP-code entry — needs a UI rework per app and breaks the existing send pipeline.

The fix belongs in the shared SSO/API surface.

---

## Why this matters beyond `acme.example`

- ACME Portal is just the first Eve-deployed app using domain-signup; ACME will roll out ExampleCo / SampleCo / ACME Tag next, all of which are corporate inboxes behind enterprise mail security.
- Branded invite emails use the same `generateAuthActionLink('invite', ...)` path. They are equally vulnerable. Any future app that uses Eve invites is exposed.
- Without this fix, the practical advice to operators becomes "expect the first click to fail; click again to send another link." That destroys the perceived reliability of Eve-deployed apps and pushes integrators to bring their own auth.

---

## Non-Goals

- **No GoTrue fork**. We will not patch Supabase Auth to add a multi-use or scanner-aware verify endpoint. The wrap is built on top of GoTrue without changing it.
- **No alternate auth method**. Apps continue to declare `login_method: magic_link`. The user flow ("enter email → check inbox → click → signed in") is unchanged; the only addition is a single confirm button on a page rendered by Eve SSO.
- **No OTP code entry**. We are not adding "type the 6-digit code from your email" as a fallback path in this scope. That's a separate feature (`magic-link-otp-code-plan.md` if/when needed).
- **No third-party email validation services**. No proxy that pre-checks deliverability beyond what `MailerService` already does post `magic-link-email-silent-drop-plan` (SES suppression check).
- **No retroactive change to in-flight emails**. Emails already sent with direct GoTrue URLs continue to work — the existing `/callback` path stays compatible. Only new sends use the wrapped URL.
- **No conversion of projectless GoTrue-hosted SSO magic-link emails**. `apps/sso` still proxies `/auth/magiclink` directly to GoTrue when no `project_id` is present. That path is not used by app-scoped magic-link login and should be handled by a separate platform-login cleanup if needed.

---

## Design

### The wrap-and-redeem pattern

Industry-standard approach used by Slack, Stytch, Auth0, Notion. Two-step:

1. **Wrap on send**. When the API generates a GoTrue `action_link`, it does not put it directly into the email. Instead it stores the GoTrue URL server-side under a fresh opaque token, and the email contains a URL pointing to Eve SSO: `https://sso.eve.example.com/m/<wrap_token>`. The raw GoTrue URL is no longer exposed to email scanners; it only leaves Eve after the human confirmation `POST`.
2. **Redeem on click**.
   - **GET/HEAD** `/m/<wrap_token>` serves a branded confirmation page (or headers only for `HEAD`) with a single `<form method="POST">` button labelled "Sign in to <App>". Idempotent. Scanners that follow or preflight URLs hit this route repeatedly without consuming anything.
   - **POST** `/m/<wrap_token>` marks the wrap consumed, then 302-redirects the browser to the stored GoTrue `action_link`. GoTrue verifies the OTP, lands the user back at `/callback` with tokens, exactly as today.

The OTP is only redeemed when the user's browser does a `POST`. Scanners almost universally do not submit forms.

### Why an HTML interstitial (not alternatives)

| Option | Why not |
| --- | --- |
| **Multi-use GoTrue OTP** | Not supported, and trivially breaks security model (anyone with the email can redeem repeatedly). |
| **Browser-binding cookie on send** | Breaks the very common "request on desktop, click on mobile" flow. |
| **OTP code entry in every app** | Per-app UI work; abandons the magic-link product promise. |
| **CAPTCHA on redeem** | Extra friction without meaningful gain over a form button. |
| **Detect-and-bypass on User-Agent** | Mail scanners actively spoof browser UAs; arms race we lose. |
| **POST form interstitial (chosen)** | Matches Slack / Stytch / Auth0; one extra click, no scanner-distinguishing logic, works regardless of mail provider. |

### Data model

New table `magic_link_wraps` (migration `00098_magic_link_wraps.sql`):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text PRIMARY KEY` | TypeID-style `mlw_<26 base32>`. Used as the URL path segment. |
| `gotrue_action_link` | `text NOT NULL` | The full GoTrue verify URL we'd otherwise put in the email. Stored server-side so it never appears in email, logs, or scanner-visible GET responses. It is returned only from `consume` after the confirmation POST. |
| `project_id` | `text` | Nullable. Present for app-scoped magic links and project-branded invites; used for branding, redirect-origin validation, and project-scoped audit events. |
| `org_id` | `text` | Nullable. Present for org invite emails when the send path has org context. Useful for diagnostics when `project_id` is null. |
| `email_hash` | `text NOT NULL` | `sha256:12chars` lowercased — matches existing PII-redaction in `auth.service.ts:953 hashEmail`. |
| `kind` | `text NOT NULL` | `'magic_link' \| 'invite'` — drives copy on the interstitial. |
| `redirect_to` | `text` | The app's post-login redirect. Only surfaced on the interstitial after the SSO validates the destination host against the project-aware redirect allowlist. |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `expires_at` | `timestamptz NOT NULL` | Set to `created_at + 1 hour`, matching GoTrue's default OTP TTL. After this we refuse redemption even if GoTrue would still accept. |
| `consumed_at` | `timestamptz` | Nullable. Set on first successful `POST /m/:wrap`. |
| `get_count` | `int NOT NULL DEFAULT 0` | Incremented on each `GET`/`HEAD`. Surfaces scanner pre-fetches in telemetry. |
| `last_get_at` | `timestamptz` | Updated on each `GET`/`HEAD`. |

Constraints and indexes: PK on `id`; `CHECK (kind <> 'magic_link' OR project_id IS NOT NULL)`; partial index `(expires_at) WHERE consumed_at IS NULL` for the pruner; optional `(project_id, created_at DESC)` for support queries when `project_id IS NOT NULL`.

The token (`id`) is the credential — anyone who holds it can redeem. Treat it with the same care as the underlying GoTrue URL: HTTPS-only in transit, never logged in full (first 8 chars only), masked in error responses.

### Endpoints

**Internal (API, called by SSO):**

There is no `/issue` internal endpoint in v1. The API already generates the GoTrue action link in-process on every email send path, so issue/write should stay an in-process `AuthService` helper. Exposing issue over HTTP would add surface area without solving a current cross-pod need.

- `POST /internal/auth/magic-link-wrap/inspect`
  - Body: `{ wrap_token }`.
  - Auth: `x-eve-internal-token`.
  - Caller: SSO `GET /m/:wrap` and `HEAD /m/:wrap`. Read-only except for scanner telemetry; increments `get_count` and `last_get_at`. Returns `{ kind, project_id, org_id, redirect_to, expired, consumed, get_count }` so SSO can render the interstitial with the right branding and refuse already-expired links.
- `POST /internal/auth/magic-link-wrap/consume`
  - Body: `{ wrap_token }`.
  - Auth: `x-eve-internal-token`.
  - Caller: SSO `POST /m/:wrap`. Atomic `UPDATE ... SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING gotrue_action_link, project_id, org_id, email_hash, kind, get_count, created_at`. If no row returned, classify with a second `SELECT` (or a CTE) and respond 410 Gone with one of `{expired, already_consumed, unknown}`.

SSO must send the header from `process.env.EVE_INTERNAL_API_KEY`. The k8s SSO deployment already receives `eve-app` via `envFrom`, but the SSO code must fail closed if the key is missing.

**SSO (public):**

- `HEAD /m/:wrap`
  - Calls `inspect`, sets `Cache-Control: no-store`, and returns `200` for pending wraps or `410` for expired/consumed/unknown wraps. Never consumes.
- `GET /m/:wrap`
  - Calls `inspect`. Renders a branded interstitial with project branding when available, otherwise Eve Horizon defaults. It shows the destination host only after redirect validation.
  - If `expired || consumed`, render a "This sign-in link can't be used" page. For `kind='magic_link'`, include a "Request a new link" button to `/login?project_id=...&redirect_to=...`. For `kind='invite'`, do **not** bounce to login as a resend path: `sendAppMagicLink` intentionally does not email when an explicit invite is pending. Instead show "Ask the person who invited you to resend the invite." No PII echoed.
- `POST /m/:wrap`
  - Calls `consume`. On success, `302` to the returned `gotrue_action_link`.
  - On failure, render the same "can't be used" page.

All `/m/:wrap` responses set `Cache-Control: no-store`, `<meta name="referrer" content="no-referrer">`, and `Referrer-Policy: no-referrer`. Validate the path token against the expected `mlw_...` format before hitting the database; malformed tokens render the generic expired/unknown page and are never logged in full.

### State machine

```
                     ┌─────────────────┐
   issue ──────────► │ pending         │
                     │ get_count = 0   │
                     └────────┬────────┘
                              │ GET/HEAD /m/:wrap
                              ▼
                     ┌─────────────────┐
                     │ pending         │
                     │ get_count++     │◄── scanner pre-fetches loop here
                     │ last_get_at = … │    indefinitely without harm
                     └────────┬────────┘
                              │ POST /m/:wrap (human click)
                              ▼
                     ┌─────────────────┐
                     │ consumed        │
                     │ consumed_at=now │
                     └────────┬────────┘
                              │ 302 → GoTrue /verify
                              ▼
                     ┌─────────────────┐
                     │ GoTrue verifies │
                     │ → /callback     │
                     └─────────────────┘

   any state, after expires_at:
                     ┌─────────────────┐
                     │ expired         │  GET and POST both render the "can't be used" page
                     └─────────────────┘
```

Double-click on the human side: the second `POST` finds `consumed_at IS NOT NULL`, renders the "can't be used" page. The first browser tab has already redirected to GoTrue; the second tab gets a graceful error. Good enough.

Scanner racing the human: scanner does GET (or many), human does POST, POST wins because `consume` is the only mutator. No race.

### Email content

In `apps/api/src/mailer/templates/invite.ts` and every `renderAuthActionEmail` / `renderInviteEmail` callsite the `actionLink` field is the user-visible URL. After this change:

- `actionLink` is replaced with the wrap URL (`https://sso.eve.example.com/m/<wrap>`).
- Button copy stays "Sign in" / "Accept invite" — no scary "we're protecting you from scanners" disclaimer.
- The plaintext fallback line that lists the URL also uses the wrap URL.

Implementation must update all current callsites: `AuthService.sendEligibleMagicLink`, `AuthService.sendProjectInviteEmail`, `AuthController.sendSupabaseInvite`, and `OrgsService.createInvite`. Add tests or a grep-based assertion so a future direct `generateInviteLink(...)` → `renderInviteEmail(...)` path does not reintroduce scanner-fragile mail.

### Branding on the interstitial

When `project_id` is present, the interstitial calls `fetchAppContext(projectId)` (already in `apps/sso/src/main.ts:160`) and uses the project's `branding.app_name`, `branding.app_logo_url`, and the SSO host's CSS conventions. When `project_id` is null, fall back to default "Eve Horizon" branding.

Only display the destination host when `redirect_to` passes the same `isAllowedRedirect` validation used by `/callback` for that project context. If the redirect is missing or invalid, omit the host from the copy; `/callback` remains the authority that accepts or rejects the final redirect after GoTrue verification.

Copy (English, single-string for now — i18n is a separate plan):

```
Confirm sign-in to <App name>
We'll send you to <App name> at <destination host>.
                [ Sign in ]
This link can only be used once. If you didn't request it, you can close this tab.
```

For invites, swap "Confirm sign-in" → "Accept invite to <App name>" and the button label → "Accept invite".

### What does *not* change

- `/callback` URL shape — still `https://sso.eve.example.com/callback?...` with `access_token`, `refresh_token` from GoTrue.
- `exchangeForEveToken` and the SSO ↔ API exchange flow.
- The `org_invites` row written by the domain-signup Path C — still keyed on email + project + source, still applied in `autoApplyOrgInviteByEmail`.
- Any app code. The redirect_to delivered to `/login` callers stays a URL on the app's own host.
- The eligibility "generic success" behaviour of `sendAppMagicLink` (account enumeration defense). The wrap is only issued *after* eligibility is established, so silent-drop semantics are unchanged.
- Pending explicit-invite behaviour. A user-entered magic-link request still does not resend an explicit pending invite; invite resend remains an authenticated/admin action.

---

## Plan

### Lane 1 — DB migration and queries

`packages/db/migrations/00098_magic_link_wraps.sql` (use the next available migration number if another migration lands first):

```sql
CREATE TABLE magic_link_wraps (
  id                  text PRIMARY KEY,
  gotrue_action_link  text NOT NULL,
  project_id          text,
  org_id              text,
  email_hash          text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('magic_link', 'invite')),
  redirect_to         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  get_count           int NOT NULL DEFAULT 0,
  last_get_at         timestamptz,
  CHECK (kind <> 'magic_link' OR project_id IS NOT NULL)
);

CREATE INDEX magic_link_wraps_pending_expiry_idx
  ON magic_link_wraps (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX magic_link_wraps_project_created_idx
  ON magic_link_wraps (project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
```

`packages/db/src/queries/magic-link-wraps.ts`:

- `create({ id, gotrue_action_link, project_id?, org_id?, email_hash, kind, redirect_to?, expires_at })`
- `inspect(id)` — `UPDATE ... SET get_count = get_count + 1, last_get_at = now() WHERE id = $1 RETURNING kind, project_id, org_id, redirect_to, expires_at, consumed_at, get_count`. Atomic read-and-bump.
- `consume(id)` — `UPDATE ... SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING gotrue_action_link, project_id, org_id, email_hash, kind, get_count, created_at`. If the update returns no row, run a classification `SELECT` (or a single CTE) so the caller can distinguish `expired`, `already_consumed`, and `unknown`.
- `pruneExpired(cutoff)` — `DELETE FROM magic_link_wraps WHERE expires_at < $1 OR (consumed_at IS NOT NULL AND consumed_at < $1)`. Use a 24-hour default retention cutoff so operators can still inspect scanner telemetry after expiry without keeping bearer URLs around indefinitely.

ID generation: add `generateMagicLinkWrapId()` to `packages/shared/src/ids.ts` using `typeid('mlw')` and export it through `@eve/shared`. This matches the repo's existing TypeID pattern (`org_*`, `proj_*`, etc.) and avoids ad hoc random-token formatting.

### Lane 2 — API: wrap on send + internal controller

`apps/api/src/auth/auth.service.ts`:

- New private method `wrapActionLink({ gotrueActionLink, projectId, orgId, email, kind, redirectTo })` that:
  1. Generates `mlw_<id>`.
  2. Inserts into `magic_link_wraps` with `expires_at = now() + 1h`.
  3. Returns `${EVE_SSO_URL}/m/${id}`.
- `sendEligibleMagicLink` now wraps before passing into `renderAuthActionEmail({ actionLink: wrappedUrl, ... })`.
- `sendProjectInviteEmail` wraps before passing into `renderInviteEmail({ actionLink: wrappedUrl, ... })`.
- Add a public `generateWrappedInviteLink(email, redirectTo, context)` helper or equivalent so existing invite mail callers outside `AuthService` do not keep calling raw `generateInviteLink`:
  - `AuthController.sendSupabaseInvite` wraps with `{ kind: 'invite', projectId: null, orgId: null }`.
  - `OrgsService.createInvite` wraps with `{ kind: 'invite', projectId: body.project_id ?? null, orgId }`.
- Keep `generateAuthActionLink` as the raw GoTrue helper. If it must remain public for existing tests/backcompat, document in-code that raw links must not be passed to mail templates.

`apps/api/src/auth/auth.internal.controller.ts`:

- Add two handlers under `Controller('internal/auth')`:
  - `POST magic-link-wrap/inspect` — required, called by SSO.
  - `POST magic-link-wrap/consume` — required, called by SSO.
- Both reuse the existing `validateInternalToken` helper.

`packages/db/src/queries/index.ts`: export `magic-link-wraps.ts`. `AuthService` / `AuthInternalController` should construct the query object from the injected `Db`, matching existing query-factory usage; no Nest provider registration is needed.

`apps/api/src/auth/auth.module.ts`: extend the existing replay-store purge timer or add a sibling timer to call `magicLinkWrapQueries(db).pruneExpired(new Date(Date.now() - 24h))`. Clear the timer in `onModuleDestroy`.

Unit tests in `auth.service.magic-link.spec.ts`:

- Wrap row written with correct `kind`, `email_hash`, `project_id`, `expires_at` (assert `~now()+1h`).
- `actionLink` in the rendered email is the wrap URL, not the GoTrue URL.
- Domain-signup Path C still emits `auth.domain_signup.invite_created`.
- App invite resend and org invite email paths wrap invite links.
- Legacy `sendSupabaseInvite` wraps invite links.

### Lane 3 — SSO: interstitial endpoints

`apps/sso/src/main.ts`:

- Add `const EVE_INTERNAL_API_KEY = process.env.EVE_INTERNAL_API_KEY ?? '';` and a small `internalApiPost(path, body)` helper that sends `x-eve-internal-token`. If the key is missing, render a generic unavailable page and log a configuration error; do not call the internal endpoint without auth.
- Three new routes registered before the existing `/callback`:

```ts
app.head('/m/:wrap', async (req, res) => { … })
app.get('/m/:wrap', async (req, res) => { … })
app.post('/m/:wrap', express.urlencoded({ extended: false }), async (req, res) => { … })
```

- `HEAD /m/:wrap` flow:
  1. Validate the wrap token shape.
  2. `inspect` via internal API so scanner HEAD prefetches are visible in `get_count`.
  3. Return `200` for pending wraps, `410` for expired/consumed/unknown, always with `Cache-Control: no-store`.
- `GET /m/:wrap` flow:
  1. `inspect` via internal API.
  2. If `expired || consumed`, render the "can't be used" page. Only magic-link wraps get a "Request a new link" CTA back to `/login?project_id=...&redirect_to=...`; invite wraps tell the user to ask the inviter/admin to resend.
  3. Otherwise fetch app context for branding when `project_id` is present. Validate `redirect_to` against the project allowed origins before displaying a destination host.
  4. Render the interstitial with a `<form method="POST" action="/m/<escaped-wrap>">` containing a CSRF nonce (`hidden` field bound to `wrap_token`, signed HMAC-SHA256 with `EVE_INTERNAL_API_KEY` — stateless, no extra storage).
- `POST /m/:wrap` flow:
  1. Verify CSRF nonce against the HMAC. On mismatch, render the same "can't be used" page (this path is reached only if a scanner or attacker fakes a POST without the page's hidden field).
  2. `consume` via internal API.
  3. On success, `res.redirect(302, gotrue_action_link)`.
  4. On failure (`expired` / `already_consumed` / `unknown`), render the same "can't be used" page.

Helper: `renderInterstitialHtml({ context, kind, redirectTo, wrapToken, csrfNonce })` — mirrors the styling of `landingPageHtml` so it doesn't need a new design system.

Testing requires a small SSO refactor. `apps/sso/src/main.ts` currently starts listening at module import time, which makes direct unit tests awkward. Extract either:

- `createApp(deps)` from `main.ts` and leave `app.listen(...)` in a tiny bootstrap, or
- the wrap route helpers into `apps/sso/src/magic-link-wrap.ts` and test them without importing the live server.

Prefer `createApp(deps)` if the diff stays small; it makes future SSO route tests straightforward.

Logging:

- On GET: `[wrap.get] mlw=<first8>… project=<id> get_count=<n> consumed=<bool> expired=<bool>`.
- On HEAD: `[wrap.head] mlw=<first8>… project=<id> get_count=<n> consumed=<bool> expired=<bool>`.
- On POST success: `[wrap.consume] mlw=<first8>… project=<id> get_count=<n>`.
- On POST failure: `[wrap.consume_failed] mlw=<first8>… reason=<expired|already_consumed|unknown>`.

### Lane 4 — Companion fix: surface `otp_expired` in `/callback`

Smallest change to close the "Authenticating…" hang the original screenshot showed. Even with the interstitial in place, GoTrue can still return errors (e.g. user really did wait >1h, or pressed the back button after consume). The callback must show them rather than spin.

`apps/sso/src/main.ts:966 app.get('/callback', ...)` — before the `if (!accessToken || !refreshToken)` branch:

```ts
const errorCode = (req.query.error_code as string) || (req.query.error as string);
if (errorCode) {
  const friendly = errorCode === 'otp_expired'
    ? 'This sign-in link has already been used or has expired. Please request a new sign-in link or ask for a new invite.'
    : 'Authentication failed. Please try again.';
  const loginUrl = `/login${buildQuery({
    error: friendly,
    error_code: errorCode,
    redirect_to: redirectTo,
    project_id: projectId,
  })}`;
  return res.redirect(302, loginUrl);
}
```

And in `callbackExtractorHtml()`, mirror the same check in JS so that if GoTrue puts the error in the URL hash (implicit flow), we also surface it instead of infinite-spinning:

```js
const hashParams = new URLSearchParams(hash.substring(1));
const errorCode = hashParams.get('error_code') || hashParams.get('error');
if (errorCode) {
  const queryParams = new URLSearchParams(search);
  queryParams.set('error_code', errorCode);
  const description = hashParams.get('error_description');
  if (description) queryParams.set('error_description', description);
  window.location.replace('/callback?' + queryParams.toString());
}
```

This lane ships independently of Lanes 1-3 and is the minimum we owe even if the interstitial slips.

### Lane 5 — Tests, docs, and an audit-event

**Tests:**

- Unit: `magic-link-wraps` query happy/expired/double-consume paths.
- Unit: `auth.service.magic-link.spec.ts` updated to assert wrap URL in email and DB row written for magic-link and project-invite sends.
- Unit: controller/service coverage for `AuthController.sendSupabaseInvite` and `OrgsService.createInvite` so all invite email send paths wrap.
- Unit: SSO endpoint handlers — covered with a small `apps/sso/test/wrap.spec.ts`. SSO has no test suite yet; add `vitest` and a `test` script to `apps/sso/package.json`, and use the SSO refactor from Lane 3 so tests do not import a module that immediately calls `listen`.
- Manual: `tests/manual/scenarios/45-magic-link-confirmation-interstitial.md` — covers happy path, scanner pre-fetch simulation (`HEAD` and `GET` before clicking), expired wrap, double-click, and invite-expired copy.

**Docs:**

- `docs/system/auth.md` — new subsection "Magic-link confirmation interstitial" under the existing magic-link section, explaining the wrap-and-redeem flow and that ops should expect `magic_link_wraps` rows with `get_count > 1` for users on protected mailboxes.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md` — add a one-paragraph note that emails now include a confirmation step; app developers don't need to do anything.
- `packages/shared/src/schemas/event.ts`, `docs/system/events.md`, and `../eve-skillpacks/eve-work/eve-read-eve-docs/references/events.md` — add `auth` as an official event source if `auth.action_link.wrap_redeemed` uses `source: 'auth'`. This also formalizes the existing `auth.domain_signup.*` events, which currently cast around the schema.

**Audit event:**

- `auth.action_link.wrap_redeemed` — emitted from `consume` when `project_id` is present with `{ project_id, org_id, email_hash, kind, get_count, latency_ms }`. Useful to spot scanner-heavy domains in aggregate without touching PII. For projectless legacy/org-only invites, log the consume event but skip event-spine emission because the event model is project-scoped.

---

## Implementation Order

1. Lane 4 first (small, independent, ships the visible-error fix immediately as a hotfix in the next `release-v*`).
2. Lane 1 (migration + queries).
3. Lane 2 (wrap on send).
4. Lane 3 (SSO endpoints).
5. Lane 5 (tests + docs + audit event) interleaved with 1-3.
6. Tag `release-v0.1.282` or whatever's next; verify on staging.

---

## Verification

### Local (k3d, Mailpit)

```bash
./bin/eh status
./bin/eh k8s deploy
eve secrets import --org org_manualtestorg --file manual-tests.secrets

# Hit the new flow
eve auth magic-link --project proj_<id> --email someone@allowed-domain.test
# Check Mailpit for the email; verify URL is https://sso.eve.lvh.me/m/mlw_…
# curl the URL — should render interstitial or headers, NOT consume
curl -fsSI http://sso.eve.lvh.me/m/mlw_…  # 200, get_count++
curl -fsS http://sso.eve.lvh.me/m/mlw_…   # 200 HTML, get_count++
# Click "Sign in" in browser → POST → 302 to GoTrue → /callback → signed in
```

Scanner simulation:

```bash
# Pre-fetch the wrap URL N times (mimics SafeLinks)
for i in {1..10}; do curl -fsSI http://sso.eve.lvh.me/m/mlw_…; done
# Then click in browser — must still succeed.
# Check DB:
psql -c "SELECT id, get_count, consumed_at FROM magic_link_wraps WHERE id = 'mlw_…'"
# Expect get_count >= 11, consumed_at = <click time>
```

### Staging (`eve.example.com`)

1. Tag `release-v*`, wait for deploy.
2. From a real `@acme.example` mailbox (the one that failed first time): request a magic-link, click, expect to land signed in.
3. From a `@example.com` mailbox: same.
4. `kubectl -n eve exec deploy/eve-api -- psql … -c "SELECT kind, get_count, consumed_at IS NOT NULL AS done FROM magic_link_wraps ORDER BY created_at DESC LIMIT 20"` — confirm rows exist and `get_count > 0` on scanner-heavy recipients.

### Manual scenario

`tests/manual/scenarios/45-magic-link-confirmation-interstitial.md`:

1. Happy path: request → email → click → signed in. Assert wrap row consumed.
2. Scanner pre-fetch path: pre-curl `HEAD` and `GET` 10x → click → still signed in. Assert `get_count >= 11`.
3. Expired path: insert wrap with `expires_at = now() - 1m` → GET shows "can't be used" page; POST returns the same.
4. Double-click: open email link in two tabs, click both. First succeeds, second shows "can't be used" without breaking the first.
5. Companion fix (Lane 4): hit `/callback?error_code=otp_expired&...` directly — must land on `/login?error=...` not the spinner.
6. Invite expired path: expired invite wrap shows "ask the person who invited you to resend" and does not point to the generic magic-link form as if it would resend an explicit invite.

---

## Acceptance

The plan is complete when:

- Magic-link clicks from a Microsoft 365 mailbox protected by Defender SafeLinks succeed on the first human click (verified by sending to an explicit test mailbox; assert `magic_link_wraps.get_count >= 1` *before* `consumed_at`).
- `magic-link-confirmation-interstitial-plan.md` is marked **Shipped** with the release tag and a one-line entry in `CLAUDE.md`'s Update Log.
- The `/callback` no longer hangs on "Authenticating…" when GoTrue returns an error — verified by Scenario 45 step 5 and by re-running the original failure URL.
- `auth.action_link.wrap_redeemed` events appear in the event spine for staging traffic.
- All Eve-rendered action emails use `/m/mlw_...` links: app magic links, app invites/resends, legacy Supabase invites, and org invite emails.
- `apps/sso` has at least one unit test (the wrap interstitial). Bootstrapping the test suite is in-scope.

---

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| **Wrap token leaks via Referer header to the app or logo CDN**. If the interstitial links to an external CSS/JS/image asset, the wrap token could leak via Referer. | Inline all CSS/JS in the interstitial HTML (matches `landingPageHtml` style today). Set `Referrer-Policy: no-referrer`, `<meta name="referrer" content="no-referrer">`, and `referrerpolicy="no-referrer"` on any optional logo image. |
| **POST endpoint vulnerable to CSRF**. Without protection an attacker who knows the wrap_token could trigger redemption from a forged page. | The wrap_token itself is the credential — knowing it already lets the holder redeem. CSRF nonce (HMAC of `wrap_token`) prevents accidental cross-origin form submissions but doesn't add against a token-holder attacker. Document this explicitly in `auth.md`. |
| **Scanners that submit forms**. Rare but possible with deep inspection. | The design assumes scanners fetch URLs but do not submit confirmation forms. If we observe this empirically (`get_count == 1` and `consumed_at` near `last_get_at` for a single recipient), add a stronger human-presence gate such as a short dwell timer or CAPTCHA in a follow-up — out of scope for v1. Do not claim the HTML form itself proves a real click. |
| **Increased latency for legit clicks**. Two-hop redirect (interstitial → GoTrue → `/callback`). | Single extra page load, no extra network on the API side beyond one DB write per send and one read-bump per GET. Industry-standard pattern; not user-perceived. |
| **In-flight emails (already sent before deploy) keep using direct GoTrue URLs**. | Both paths still work — `/callback` is unchanged. Mention in the release note that the first ~1h of mail post-deploy is mixed. |
| **`gotrue_action_link` stored in plaintext in Postgres**. Anyone with DB read can redeem any pending magic link. | Same trust boundary as today's `org_invites.invite_code` and `auth_challenges` tables. Keep TTL short and prune expired/consumed rows after a 24h support window. Optionally encrypt at rest in a follow-up. |
| **Interstitial displays an attacker-controlled destination host**. Public magic-link requests include `redirect_to`; showing an unvalidated host could make a bad redirect look trusted even though `/callback` would later reject it. | Only display the destination host after validating `redirect_to` against the same project-aware allowlist as `/callback`; otherwise omit destination-host copy. |
| **Expired invite wraps can't self-resend**. The magic-link form intentionally suppresses sends when an explicit invite is pending, so a "request new link" CTA would lie for invite wraps. | Invite expired/consumed pages tell the user to ask the inviter/admin to resend. A future self-service invite-resend endpoint can be designed separately with enumeration-safe behavior. |
| **Lane 4's "Email link is invalid or has expired" copy leaks info**. | The friendly string is generic. We do not echo the user's email or any token. `error_code=otp_expired` is the only state-leak and matches GoTrue's own output. |

---

## Open Decisions

Resolved by this review:

- **Issue endpoint**: no `/issue` internal endpoint in v1. Issue wraps in-process; expose only `inspect` and `consume` for SSO.
- **Wrap token format**: add `generateMagicLinkWrapId()` using `typeid('mlw')`.
- **Invite coverage**: wrap all Eve-rendered invite emails, including project invites, legacy Supabase invites, and org invite emails.

Still open:

1. **i18n / per-app interstitial copy**. Punted to a separate plan. v1 ships English only.
2. **Wrap TTL ≠ GoTrue OTP TTL**. If we raise GoTrue's OTP TTL above 1h to be defensive, do we keep the wrap at 1h? **Recommend**: wrap TTL = GoTrue OTP TTL (config-shared), so we don't render a working button for a link GoTrue would then reject.
3. **Inline branding image vs `<img src>` to project logo**. `<img>` triggers a fetch on render, which exposes the wrap URL via Referer to the logo host unless policy is correct. **Recommend**: allow the project's configured HTTPS logo only with `referrerpolicy="no-referrer"` and page-level `Referrer-Policy: no-referrer`; otherwise omit the logo.
