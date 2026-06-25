# App Invite Redirect Allowlist Plan

> **Status**: Proposed — 2026-05-11
> **Scope**: SSO redirect-target validation, SSO session CORS, manifest `auth` config, `/auth/app-context` payload, CLI surface
> **Related**: [`app-magic-link-login-opt-in-plan.md`](./app-magic-link-login-opt-in-plan.md), [`app-branded-invite-emails-phase-1-plan.md`](./app-branded-invite-emails-phase-1-plan.md)
> **Repos touched**: `eve-horizon-2` (platform), `branding/acme-invites` (consumer manifest), `acme-portal` (consumer verification)
> **Trigger incident**: clicking an `org_Acme` magic-link or invite for `sandbox.acme.example` strands the user on the SSO landing page even though the session cookie is set. The "Continue to Sign In" link points at `/login`, which is a dead end for an already-signed-in user.

---

## Goal

Allow Eve-deployed apps to declare which off-cluster origins may participate in app auth after invite redemption / magic-link callback. Specifically: a redeemer who clicks an `ACME Portal` invite or magic link must land on `https://sandbox.acme.example/cameras`, and that app origin must be allowed to call the SSO `/session` endpoint to mint the Eve app token. There should be no intermediate "you can close this tab" page.

Today this is impossible because `apps/sso/src/main.ts:71` hard-codes the redirect allowlist to `EVE_DEFAULT_DOMAIN` (`eve.example.com`) and its subdomains. Every external hostname is silently rewritten to `${EVE_SSO_URL}/?eve_org_id=...`.

---

## Diagnosis

### Symptom

`sso.eve.example.com/callback?...&redirect_to=https%3A%2F%2Fsandbox.acme.example` does NOT redirect to `sandbox.acme.example`. The callback exchanges tokens, sets cross-subdomain refresh-token cookies, then drops the user on `sso.eve.example.com/?eve_org_id=org_Acme`. The page reads "Signed in. You can now close this tab." The "Continue to Sign In" button on that page points at `/login`, which 200s back to the same login form for an already-signed-in user.

### What the platform did correctly

1. `/callback` received `access_token`, `refresh_token`, `redirect_to=https://sandbox.acme.example` (verified in dev-tools network log).
2. `exchangeForEveToken` succeeded — GoTrue access token swapped for Eve RS256, identity link created.
3. `setSessionCookies` wrote the refresh-token cookie on `.eve.example.com`, which makes the session available to the SSO broker itself.
4. Eve apps obtain their app token by calling `${EVE_SSO_URL}/session` with `credentials: 'include'`. For custom domains like `sandbox.acme.example`, the cookie is still sent to the SSO broker host, but the SSO broker must also allow that browser `Origin` in CORS. That CORS allowlist is currently cluster-domain-only, so it must be updated alongside redirect validation.

### Where it actually broke

`apps/sso/src/main.ts:71-83`:

```ts
function isAllowedRedirect(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return (
      host === EVE_DEFAULT_DOMAIN ||
      host.endsWith(`.${EVE_DEFAULT_DOMAIN}`)
    );
  } catch {
    return false;
  }
}
```

`EVE_DEFAULT_DOMAIN` on staging is `eve.example.com`. `sandbox.acme.example` is not a subdomain of that. `isAllowedRedirect` returns `false`. `/callback` falls through to:

```ts
if (!redirectTo || !isAllowedRedirect(redirectTo)) {
  const proto = SECURE_COOKIES ? 'https' : 'http';
  redirectTo = `${proto}://${req.hostname}/`;
}
```

…replacing the legitimate target with the SSO broker's own root. The session is established but the redeemer is stranded.

There is a second platform gap after the redirect is accepted: `applyCorsHeaders` for `/session` and `/logout` uses the same cluster-domain-only check. A custom-domain app cannot reliably complete the standard `@eve-horizon/auth-react` session probe unless the SSO broker validates that request origin against the same project-scoped allowlist.

### What the redeemer's invite path looked like

- Branding-only project `branding/acme-invites` lives in `org_Acme`. It has `x-eve.branding`, `x-eve.auth.login_method=magic_link`, and (per recent commit `22603ff`) `x-eve.auth.org_access.mode=allowlist, allowed_orgs=[org_Acme, org_example]`. It has **no `services`**, so no ingress, no deployed `custom_domain`.
- Real app `acme-portal` lives in `org_example`. It registers `sandbox.acme.example` as a custom domain on its `web` service.
- `eve org invite <email> --org org_Acme --project <branding-only> --redirect-to https://sandbox.acme.example` works because the project and invite org match. `eve org invite ... --org org_Acme --project <acme-portal>` fails because the inviter is trying to use an `org_example` project from an `org_Acme` invite.
- The in-app invite path (`POST /auth/app-invites`, exposed through `useEveAppAccess().inviteMember`) has the same project-context shape and should inherit this fix. There is currently no `eve app` CLI command in this repo.
- The invite redirect target carried in `org_invites.redirect_to` is `https://sandbox.acme.example` — set by the inviting CLI / API call.

The branding-only project knows the magic-link should land at `sandbox.acme.example`. The platform has no way for that project to *say* so to SSO.

---

## Why this matters beyond ACME Portal

This is a **platform gap**, not an ACME Portal app problem. The platform currently makes three assumptions that break for any tenant who owns a domain off the cluster:

1. Every Eve-deployed app is reachable as a subdomain of `EVE_DEFAULT_DOMAIN`. False for custom-domain customers.
2. The branding/auth-flow project is the same one as the deployed app. False whenever brand + access live in one tenant org and the real app runs out of another.
3. The set of legitimate redirect targets is closed under cluster-domain subdomain matching. False as soon as anyone wants a vanity URL.

Future tenants that ship their own domain (`*.allmycompany.com`) will hit the exact same wall.

The CLAUDE.md rule "Platform Gaps First — Never Work Around Them" applies. We do not patch this in `acme-portal` or `branding/acme-invites`; we fix it in the platform.

---

## Non-Goals

- Do **not** change cross-org invite gating. The fact that an inviter in `org_Acme` cannot `--project` into an `org_example` project is a separate auth concern. Out of scope here.
- Do **not** rewrite the SSO `/session` cookie refresh flow. The session-portability model still stays centralized in the SSO broker; this plan only teaches redirect and CORS validation about project-scoped external origins.
- Do **not** introduce a per-user redirect allowlist or scoped tokens. The invite already encodes its target in `org_invites.redirect_to`; this plan exposes the *project-level* set of legal targets so the SSO redirect validator can accept it.
- Do **not** ship redirect validation that just trusts the `redirect_to` query param. We still need an allowlist — the change is *where it comes from*.
- Do **not** roll into this the unrelated "set-password step ought to be skipped" path. That already shipped via `invite_requires_password=false`.

---

## Plan

Five implementation lanes. Lanes 1 and the `/session` CORS work are the immediate fix; the remaining lanes reduce manual configuration and polish the fallback UX.

1. **Manifest-declared allowlist** (the immediate fix). A branding-only project can declare `x-eve.auth.allowed_redirect_origins: ["https://sandbox.acme.example"]`. SSO consults this via `/auth/app-context`.
2. **Auto-derive from registered custom domains**. When SSO has a `project_id`, the platform also returns the project's eligible `custom_domains` as allowed targets. App developers get the right behavior without restating the URL.
3. **Cross-project derivation via `org_access.allowed_orgs`**. When the invite flow runs through a branding-only project but redirects to an app in a sibling org, the platform aggregates eligible custom domains from projects in allowed orgs. Closes the loop for the ACME Portal shape exactly.

The first lane alone unblocks the user today. Lanes 2 and 3 reduce future per-app config and ambiguity.

---

### Lane 1: Manifest-declared allowlist

#### 1.1 Schema

**File**: `packages/shared/src/schemas/manifest.ts`

Extend `ProjectAuthConfigSchema`:

```ts
export const ProjectAuthConfigSchema = z.object({
  login_method: z.enum(['password_or_magic_link', 'password', 'magic_link']).default('password_or_magic_link'),
  self_signup: z.boolean().default(false),
  invite_requires_password: z.boolean().default(true),
  org_access: AppOrgAccessConfigSchema,
  /**
   * Explicit allowlist of redirect target origins (scheme://host[:port]) for
   * post-auth navigation. Used by the SSO broker to validate `redirect_to`
   * after callback/invite redemption. Must be HTTPS in production. Entries
   * are origins only and are matched by scheme + host + port; callers still
   * control the path of `redirect_to` after the origin is accepted.
   */
  allowed_redirect_origins: z.array(RedirectOriginSchema).default([]),
}).strict();
```

YAML:

```yaml
x-eve:
  auth:
    login_method: magic_link
    invite_requires_password: false
    org_access:
      mode: allowlist
      allowed_orgs: [org_Acme, org_example]
    allowed_redirect_origins:
      - https://sandbox.acme.example
      - https://acme.example
```

Validation rules:

- Each entry must be a parseable URL with a hostname and protocol.
- `http://` permitted only for local hostnames (`localhost`, loopback IPs, `*.lvh.me`, `*.eve.lvh.me`) so local k3d still works without TLS. Otherwise reject at validate time with a clear error.
- Entries are origins only. Reject non-root paths, query strings, and fragments with a clear message such as `x-eve.auth.allowed_redirect_origins[0] must be an origin like https://app.example.com, not a full redirect URL`.
- Order-independent set semantics; duplicates ignored.
- Normalize stored origins through `new URL(value).origin` so comparisons are consistent for default ports and casing.

#### 1.2 API surface

**File**: `apps/api/src/auth/auth.service.ts` (`getAppAuthContext`)
**File**: `packages/shared/src/schemas/auth.ts` (extend `AppAuthContextResponseSchema`)

Extend `AppAuthContextAuthConfigSchema` (and `AppAuthContextResponseSchema` consumer) to surface the new list:

```ts
export const AppAuthContextAuthConfigSchema = ProjectAuthConfigSchema
  .omit({ org_access: true })
  .extend({
    org_access: AppAuthContextOrgAccessSchema.optional(),
    allowed_redirect_origins: z.array(z.string()).default([]),
  })
  .strict();
```

`/auth/app-context` already runs unauthenticated and is cached client-side; adding a list of public origins does not leak anything sensitive (these are URLs the operator already publishes).

If an SSO callback has no `project_id` query parameter but `/auth/exchange` returns `invite_app_context.project_id`, SSO should use that project ID as a fallback before validating `invite_redirect_to`. The API already returns `invite_app_context`; the SSO local type and `exchangeForEveToken` result shape need to include it.

#### 1.3 SSO validator

**File**: `apps/sso/src/main.ts`

Replace `isAllowedRedirect(url)` with a context-aware validator:

```ts
function isAllowedRedirect(url: string, context: { allowedOrigins: string[] }): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (parsed.protocol !== 'https:' && !isLocalHttpOrigin(parsed)) return false;
    if (host === EVE_DEFAULT_DOMAIN || host.endsWith(`.${EVE_DEFAULT_DOMAIN}`)) {
      return true;
    }
    return new Set(context.allowedOrigins.map(normalizeOrigin)).has(parsed.origin);
  } catch {
    return false;
  }
}
```

In `/callback`, fetch the app context (already done for `invite_requires_password`) and thread the origins through:

```ts
const context = await fetchAppContext(projectId);
const allowedOrigins = context?.auth?.allowed_redirect_origins ?? [];
if (!redirectTo || !isAllowedRedirect(redirectTo, { allowedOrigins })) {
  redirectTo = fallbackRedirect(req);
}
```

Same change in `/login` (when generating fall-back redirects on errors) and `/set-password` if it consults the validator.

If no project ID is available from the callback query or `invite_app_context`, keep the existing cluster-only allowlist behavior — adding a project-scoped allowlist must not weaken the default.

#### 1.4 SSO session CORS and SDK probe

**Files**: `apps/sso/src/main.ts`, `packages/auth-react/src/provider.tsx`

Apply the same project-scoped origin validation to SSO `/session` and `/logout` CORS:

- Extend `ProjectAuthConfig` / `SsoLoginContext` in SSO with `allowed_redirect_origins`.
- Make `applyCorsHeaders` async and context-aware: allow same-origin/no-origin requests; allow existing cluster-domain origins; otherwise require `project_id` and validate `Origin` against `context.auth.allowed_redirect_origins`.
- Keep no-`project_id` requests on the current cluster-domain-only behavior.
- Update `@eve-horizon/auth-react` to call `/session?project_id=<eve_project_id>` and `/logout?project_id=<eve_project_id>` when `eve_project_id` is available from `/auth/config`.

This is part of the immediate fix. Without it, a successful redirect to `sandbox.acme.example` can still fail the standard app-session probe because the SSO CORS layer rejects the custom-domain origin.

#### 1.5 Acceptance

- `eve project auth-context <project>` (new CLI command) shows `allowed_redirect_origins` after a deploy of a manifest that sets it.
- `curl /auth/app-context?project_id=...` returns the list.
- An invite for `branding/acme-invites` with `redirect_to=https://sandbox.acme.example` lands on `sandbox.acme.example` (not on the SSO landing page) when that origin is in the allowlist.
- From `https://sandbox.acme.example`, the SDK's `GET https://sso.eve.example.com/session?project_id=...` succeeds with credentials and returns an Eve token.
- An invite with `redirect_to=https://attacker.example.com` is rejected and falls back to the SSO root.

---

### Lane 2: Auto-derive from registered custom domains

#### 2.1 Where the data lives

`packages/db/src/queries/custom-domains.ts` currently exposes `findByProject(projectId)` and rows carry `hostname`, `status`, `environment_id`, and `service_name`. There is no `verified` status; the current status enum is:

```ts
'pending_dns' | 'dns_verified' | 'cert_provisioning' | 'active' | 'dns_error' | 'cert_error' | 'removed'
```

For this plan, an "eligible custom domain" means:

- `status IN ('dns_verified', 'cert_provisioning', 'active')`
- `environment_id IS NOT NULL`
- the owning project is not soft-deleted

`active` is the ideal end state, but the current deploy/verify flow can leave a genuinely serving domain in `cert_provisioning`; using the three DNS/cert-progress states keeps Lane 2 usable without blocking on a separate custom-domain status-controller fix. Do not include `pending_dns`, `dns_error`, `cert_error`, `removed`, or unbound rows.

#### 2.2 API surface

**File**: `apps/api/src/auth/auth.service.ts` (`getAppAuthContext`)

When building the auth-context response, union the manifest allowlist with eligible custom domains for the project:

```ts
const customDomains = await this.customDomains.findRedirectEligibleByProjectIds([project.id]);
const derivedOrigins = customDomains.map((d) => `https://${d.hostname}`);
const explicitOrigins = authConfig?.allowed_redirect_origins ?? [];
return {
  ...,
  auth: {
    ...,
    allowed_redirect_origins: Array.from(new Set([...explicitOrigins, ...derivedOrigins])),
  },
};
```

If the project owns `sandbox.acme.example` as an eligible custom domain, the manifest no longer needs to repeat it.

#### 2.3 Acceptance

- A project with an eligible custom domain `foo.example.com` and no `allowed_redirect_origins` in the manifest still accepts `redirect_to=https://foo.example.com`.
- A pending/error/removed/unbound custom domain is **not** included.
- The derived list is recomputed on each `/auth/app-context` call (no caching at the API layer; SSO already caches client-side per-page-load).

---

### Lane 3: Cross-project derivation via `org_access.allowed_orgs`

The ACME Portal case: branding/auth-flow project lives in `org_Acme`; the deployed app's custom domain lives on a different project in `org_example`. Lane 2 alone doesn't fix this — the branding project doesn't own the domain.

#### 3.1 Aggregation rule

When `auth.org_access.mode == 'allowlist'`, expand the custom-domain lookup across every project that satisfies:

- `org_id` ∈ `auth.org_access.allowed_orgs`, AND
- The project has at least one eligible custom domain.

Stop at one hop — we do not transitively traverse other projects' `org_access` configs. The aggregation is the union of explicit manifest origins, the project's own custom domains, and the custom domains of any project in `allowed_orgs`.

Rationale: declaring an org as an allowed-orgs target is already an authorization statement ("members of these orgs are accepted to my flow"); allowing redirects into a deployed app owned by those same orgs is a strict subset. This is intentionally one-hop and can be tightened later with explicit `redirect_projects` if an allowed org owns many unrelated app domains.

#### 3.2 Implementation

**File**: `apps/api/src/auth/auth.service.ts` and/or `app-auth-policy.service.ts`

The policy service already resolves `allowed_orgs` to canonical org IDs. Avoid a default-limited `projectQueries.list({ org_id })` fan-out; add a DB helper that joins `custom_domains` to non-deleted projects by org ID and returns only eligible domains:

```ts
async getAllowedRedirectOrigins(projectId: string, project: Project, authConfig: ProjectAuthConfig): Promise<string[]> {
  const explicit = authConfig.allowed_redirect_origins ?? [];
  const ownDomains = await this.customDomains.findRedirectEligibleByProjectIds([project.id]);
  let crossOrgDomains: CustomDomain[] = [];
  if (authConfig.org_access?.mode === 'allowlist' && authConfig.org_access.allowed_orgs?.length) {
    crossOrgDomains = await this.customDomains.findRedirectEligibleByOrgIds(
      authConfig.org_access.allowed_orgs,
    );
  }
  const origins = new Set<string>(explicit);
  for (const d of [...ownDomains, ...crossOrgDomains]) origins.add(`https://${d.hostname}`);
  return Array.from(origins);
}
```

#### 3.3 Acceptance

- `branding/acme-invites` (in `org_Acme`) with `allowed_orgs=[org_Acme, org_example]` and no manifest `allowed_redirect_origins` returns `sandbox.acme.example` in its `app-context` response because `acme-portal` (in `org_example`) has that hostname registered as an eligible custom domain.
- A redirect to `https://sandbox.acme.example` from this invite flow is accepted.
- A redirect to a custom domain owned by an org not in `allowed_orgs` is rejected.

#### 3.4 Privacy footnote

This surfaces the *hostnames* of projects in allowed orgs to anyone who can call `/auth/app-context?project_id=<branding-project>`. Since branding-project IDs are typically embedded in publicly-distributed invite links, the hostnames they ultimately redirect to are already public. We are not surfacing project names, slugs, secrets, or user data — only origins. Documented.

---

### Lane 4: SSO "Continue" UX fix

Even with redirect validation passing, the SSO landing page (`sso.eve.example.com/`) is still reachable for users who deep-linked to `/login` while already signed in. Today's "Continue to Sign In" button points at `/login`, which is a dead end for an already-signed-in user.

#### 4.1 Detect already-signed-in state on `/login` and `/`

**File**: `apps/sso/src/main.ts`

If the request has a valid Eve session cookie, a `project_id` query param, and a `redirect_to` query param that passes the project-scoped validator:

- Redirect immediately to that exact `redirect_to`.
- If there is a project context and exactly one allowed origin but no `redirect_to`, render a "Continue" link to that origin rather than `/login`; do not silently pick the first origin when multiple origins exist.
- If no project context is available, render the SSO landing page with a "Sign out" button rather than "Continue to Sign In".

#### 4.2 Acceptance

- A signed-in user reloading `sso.eve.example.com/?project_id=proj_...&redirect_to=<allowed-app-url>` is redirected to that app URL, not stranded.
- A signed-in user visiting `sso.eve.example.com/?project_id=proj_...` with exactly one allowed origin sees a "Continue" link to that origin, not a link back to `/login`.
- A signed-in user visiting `sso.eve.example.com/` with no project context sees a "You are signed in. Sign out?" page, not a "Continue to Sign In" dead-end.

This lane is small but high-impact for the user-facing experience and is independent of Lanes 1–3; ship it last as a polish PR.

---

### Lane 5: CLI surfacing

#### 5.1 `eve manifest validate`

Reject manifests with malformed `allowed_redirect_origins` entries (non-HTTPS in production, path components, malformed URLs) at validate time with a clear error pointing at the offending entry.

#### 5.2 `eve project auth-context <project>`

Show the resolved allowlist (manifest origins ∪ eligible own custom domains ∪ cross-org derived domains) so an operator can verify what SSO will accept without poking at `curl /auth/app-context`. The CLI calls the existing `/auth/app-context` endpoint; no new platform code required.

---

## File-Level Change List

| File | Change | Lane |
| --- | --- | --- |
| `packages/shared/src/schemas/manifest.ts` | Add `RedirectOriginSchema` and `allowed_redirect_origins` to `ProjectAuthConfigSchema` + URL/origin validation | 1.1 |
| `packages/shared/src/schemas/auth.ts` | Add `allowed_redirect_origins` to `AppAuthContextAuthConfigSchema` | 1.2 |
| `apps/api/src/auth/auth.service.ts` | `getAppAuthContext` returns resolved origins; new `getAllowedRedirectOrigins` helper | 1.2, 2.2, 3.2 |
| `apps/api/src/auth/app-auth-policy.service.ts` | Aggregate origins across `allowed_orgs` projects' eligible custom domains | 3.2 |
| `packages/db/src/queries/custom-domains.ts` | Add `findRedirectEligibleByProjectIds(projectIds)` and `findRedirectEligibleByOrgIds(orgIds)` helpers | 2.2, 3.2 |
| `apps/sso/src/main.ts` | Replace `isAllowedRedirect` with project-context-aware validator; consume `allowed_redirect_origins` from `/auth/app-context`; use `invite_app_context.project_id` fallback; allow `/session` and `/logout` CORS for validated project origins; redirect signed-in users on `/login` and `/` | 1.3, 1.4, 4.1 |
| `packages/auth-react/src/provider.tsx` | Pass `eve_project_id` to SSO `/session` and `/logout` probes | 1.4 |
| `apps/api/src/auth/__tests__/auth.service.spec.ts` (or extend `auth.service.magic-link.spec.ts`) | Cover origin aggregation: explicit + eligible custom domains + cross-org allow_orgs | 1, 2, 3 |
| `apps/sso/src/auth-origin.ts` + `apps/sso/src/__tests__/auth-origin.spec.ts` (new) | Extract/test redirect and CORS origin validation helpers; add an SSO test script or package-level Vitest config if needed | 1 |
| `apps/api/src/manifest/__tests__/manifest-validate.spec.ts` (or wherever manifest validation lives) | Validate manifest rejects `http://` in production, path components, bad URLs | 5.1 |
| `packages/cli/src/commands/project.ts`, `packages/cli/src/lib/help.ts` | Add `eve project auth-context <project_id>` and render `allowed_redirect_origins` | 5.2 |
| `docs/system/auth.md` | New "Redirect allowlist" section documenting all three sources | docs |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` | Document `x-eve.auth.allowed_redirect_origins` | docs |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md` | Document the post-auth redirect flow and the three derivation sources | docs |
| `tests/manual/scenarios/43-app-invite-cross-domain-redirect.md` (new) | Staging+k3d scenario covering each lane | docs |

OpenAPI regeneration required after `AppAuthContextResponse` shape changes.

---

## Implementation Order

1. **Day 1 — Lane 1** (manifest allowlist + SSO session CORS). Ship as one small PR. This unblocks the ACME Portal case: add `allowed_redirect_origins: [https://sandbox.acme.example]` to `branding/acme-invites/.eve/manifest.yaml`, redeploy, click invite, land on the app, and verify `/session?project_id=...` succeeds from that app origin. Tag a `release-v0.1.*` and verify on staging.
2. **Day 2 — Lane 2** (auto-derive from project's own custom domains). Lets `acme-portal` (and any future single-project app) skip the manifest entry entirely.
3. **Day 3 — Lane 3** (cross-org via `allowed_orgs`). The architecturally correct fix for the branding-only + sibling-app split.
4. **Day 4 — Lane 4** (SSO UX polish). Make the dead-end "Continue to Sign In" link disappear for signed-in users.
5. **Day 5 — Lane 5** (CLI surfacing) + docs + manual scenario.

Each step is independently shippable. Lane 1 alone closes the user-visible issue; Lanes 2–4 reduce future friction.

---

## Verification

### Local (k3d)

- Manifest with `allowed_redirect_origins: [http://web.acme-invites-staging.lvh.me]`. Invite redemption lands on that URL and the SDK session probe succeeds with `GET /session?project_id=...`.
- Manifest with `allowed_redirect_origins: [http://attacker.example]` and a malformed URL fails `eve manifest validate`.

### Staging (eve.example.com)

1. **Lane 1**: update `branding/acme-invites` manifest with `allowed_redirect_origins: [https://sandbox.acme.example]`, redeploy. Send an invite. Click the link. **Expect**: arrive on `sandbox.acme.example/cameras` signed in, no intermediate SSO landing page, and the app's `/session?project_id=...` probe succeeds.
2. **Lane 1 negative**: send an invite with `redirect_to=https://attacker.example.com`. **Expect**: redirect falls back to SSO root; the URL `attacker.example.com` is never reached.
3. **Lane 2**: deploy `acme-portal` as the auth-flow project (set its own `auth.login_method=magic_link`) with no `allowed_redirect_origins`. **Expect**: redirect to its eligible custom domain still works (derived from `custom_domains`).
4. **Lane 3**: revert the branding manifest's explicit origin. **Expect**: redirect still works because `acme-portal`'s domain is auto-derived via `allowed_orgs=[org_example]`.
5. **Lane 4**: visit `https://sso.eve.example.com/login?project_id=<branding-project>&redirect_to=https%3A%2F%2Fsandbox.acme.example%2Fcameras` while already signed in. **Expect**: auto-redirect into the app, not the login form. Also visit without `redirect_to` and confirm the page does not link back to `/login`.

### Manual scenario

Add `tests/manual/scenarios/43-app-invite-cross-domain-redirect.md` covering steps 1–5. Staging-only for Lanes 2–3 (custom domains need a real DNS + TLS round-trip), can be exercised against k3d with `lvh.me` aliases for Lane 1.

---

## Acceptance

- No reproducer for "clicking a valid invite or magic link strands the redeemer on the SSO landing page."
- `allowed_redirect_origins` in the manifest is surfaced via `/auth/app-context`.
- Eligible custom domains for the auth-flow project are auto-included.
- Custom domains owned by any `allowed_orgs` project are auto-included when `org_access.mode='allowlist'`.
- A malicious `redirect_to` is rejected and audited (logged at WARN with the offending value, the project_id, and the matched-or-not allowlist).
- `eve project auth-context <project>` shows the resolved allowlist.
- The SSO `/session` and `/logout` CORS paths allow validated custom-domain origins only when the request includes matching `project_id`.
- Manual scenario 43 passes against staging.

---

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Open redirect: a misconfigured manifest allows `https://attacker.example.com` | Manifest validation rejects non-HTTPS in prod; full origin-match (no wildcards); resolved list visible via `eve project auth-context` so operators can audit. |
| Cross-org domain leakage: Lane 3 reveals one org's domain names to another org | The hostnames are already publicly resolvable DNS. The `allowed_orgs` declaration is itself a deliberate authorization statement. No project metadata beyond the hostname is exposed. |
| Stale custom-domain rows trick SSO into accepting an old hostname | Only eligible rows participate (`dns_verified`, `cert_provisioning`, or `active`, with an environment binding). Removed, pending, and error rows are excluded. |
| Backwards compatibility: existing flows that never set `allowed_redirect_origins` | Default value is `[]`; behavior collapses to the current cluster-domain rule. No regressions for the current ACME Portal happy path on `*.eve.example.com`. |
| CORS over-broadening: `/session` starts accepting arbitrary external origins | Require `project_id` for non-cluster origins, validate the request `Origin` by exact origin match against `/auth/app-context`, and keep no-project requests cluster-domain-only. |
| A signed-in user bouncing between Lane 4 auto-redirects (loop) | Auto-redirect only on `/` and `/login` when an explicit validated `redirect_to` is present; otherwise render a link/page instead of guessing a destination. |
| `/auth/app-context` becomes hot path for SSO; adding custom-domain lookups makes it slower | Custom-domain queries are indexed by `project_id` and typically return <5 rows. Lane 3's cross-org expansion is bounded by `allowed_orgs.length × projects-per-org × domains-per-project`, all small. Add a single-flight cache later only if SSO-API RTT becomes a hot spot. |
| The fix is implemented but apps still need to set `EVE_DEFAULT_DOMAIN` correctly | No new env var introduced. Existing `EVE_DEFAULT_DOMAIN` continues to mean "cluster-internal subdomain root"; the new behavior is purely additive. |

---

## Open Decisions

1. Should we accept `http://` for any non-localhost origin? Recommendation: **no**, reject at validate time with a clear error. Production redirects must be HTTPS; local k3d works via `lvh.me` which we already accept on `http://`.
2. Should the cross-org expansion (Lane 3) extend transitively (project A in `allowed_orgs` lists `allowed_orgs=[org_B]` → include `org_B`'s domains too)? Recommendation: **no**. One hop only. Transitive expansion is an authorization-graph traversal that warrants its own design.
3. Should `redirect_to` be locked to the path of `EVE_PUBLIC_API_URL` for the validated origin (i.e., only allow same-origin paths)? Recommendation: **no** — apps may legitimately route to deep links inside the same origin. The origin match is the entire trust boundary; the path is caller-controlled.
4. Should we deprecate `EVE_DEFAULT_DOMAIN`-anchored implicit allowlisting once Lane 2/3 ship and require *all* redirects to be declared? Recommendation: **defer**. The implicit cluster-domain rule is convenient for the bootstrap case (no manifest yet) and presents no security risk because `EVE_DEFAULT_DOMAIN` is operator-controlled.
5. Should we expose a `redirect_to_default` per project for cases where SSO has project context but no explicit target? Recommendation: **defer to a follow-up**. Out of scope here; app-side routing still owns its own default landing path.
6. Should `/session` accept custom-domain origins without `project_id` by deriving a global allowlist from every custom domain? Recommendation: **no**. Keep project-scoped CORS so an origin must declare which app context it belongs to.
