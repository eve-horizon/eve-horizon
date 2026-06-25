# App Magic-Link Domain Allowlist Plan

> **Status**: Shipped — v1 in `release-v0.1.279` (2026-05-11), v2 breaking refactor in `release-v0.1.281` (2026-05-12).
> **Scope**: Manifest `x-eve.auth.org_access`, app magic-link send path, SSO callback auto-attach, public app-context payload, CLI surface
> **Builds on**:
> - [`app-magic-link-login-opt-in-plan.md`](./app-magic-link-login-opt-in-plan.md) (shipped)
> - [`app-org-access-and-admin-invites-plan.md`](./app-org-access-and-admin-invites-plan.md) (shipped)
> - [`app-invite-redirect-allowlist-plan.md`](./app-invite-redirect-allowlist-plan.md) (shipped — v0.1.278)
> **Related beads**: `eve-horizon-ju5m` (v1 design), `eve-horizon-c46g` (v2 multi-tenant refactor)
>
> **v2 note (2026-05-12)**: The shape captured in this document is **v1**.
> `domain_signup.domains` shipped as a list-of-strings with one block-level
> `target_org`. v2 (release-v0.1.281, breaking) replaced that with a list of
> `{ domain, target_org, role }` rule objects so a single project can route
> different domains to different orgs. See [`docs/system/auth.md`](../system/auth.md#domain-based-signup)
> for the current schema; this plan is preserved for historical context.

---

## Goal

Allow an Eve-deployed app to declare a set of pre-approved email domains. Anyone whose email matches a pre-approved domain can request a magic-link login on that app, even when they have no prior org/project membership and no pending invite. On first successful login they are auto-provisioned as an Eve user if needed and added to a configured target org as a regular member — without any per-user invite step.

Concrete example (ACME Portal):

```yaml
x-eve:
  auth:
    login_method: magic_link
    invite_requires_password: false
    self_signup: false
    org_access:
      mode: allowlist
      allowed_orgs: [org_Acme]
      invite:
        enabled: true
      domain_signup:
        enabled: true
        domains:
          - acme.example
          - acme.co.uk
        target_org: org_Acme
        role: member
```

A new hire at `someone@acme.example` visits `sandbox.acme.example`, clicks "Sign in", enters their email, receives a branded ACME Portal magic-link email, clicks it, and lands signed-in as a `member` of `org_Acme`. No CLI invite. No admin click.

---

## Diagnosis

### What exists today

- `x-eve.auth.self_signup` (boolean, default `false`) gates whether an unknown email can trigger a magic-link send.
- `apps/api/src/auth/auth.service.ts:707 sendAppMagicLink` already enforces three eligibility paths:
  1. Existing user with membership in an allowed org or the project → send branded magic link.
  2. Pending org invite for the email → generic success, no email (let the invite be the entry point).
  3. Unknown email → if `self_signup=true`, send; if `self_signup=false`, generic success and no email.
- `autoProvisionSupabaseUser` (line 320) creates Eve users on first Supabase callback and calls `autoApplyOrgInviteByEmail` (line 383). If a pending `org_invites` row matches `identity_hint = email`, it auto-upserts the membership. **Important caveat**: the current callback only auto-applies invites for newly auto-provisioned users; existing Eve users that resolve through a Supabase identity link or email match return before `autoApplyOrgInviteByEmail`.
- `AppAuthPolicyService` already resolves `org_access.allowed_orgs` from slugs/IDs and exposes `getAllowedOrgIds`, `isOrgAllowed`, `assertCanInvite`.
- `/auth/app-context` is the unauthenticated read endpoint SSO consults for branding, login method, and (post v0.1.278) `allowed_redirect_origins`.

### The gap

`self_signup=true` is the only switch that lets an unknown email through, and it is **unbounded** — anyone, anywhere can sign up and (if implemented) attach to the project's owning org. That is unsafe for any customer-facing app: it would let `attacker@evil.example` self-onboard into `org_Acme` simply by knowing the project ID.

The platform has no expression of "anyone from `@acme.com` is implicitly trusted, treat them like an invitee." Today that requires either:

- Manually inviting every employee via `eve org invite` / `POST /auth/app-invites` — does not scale to 50+ users and stalls when an admin is offline.
- Setting `self_signup=true` and relying on app-side allowlists — but the platform still has no way to auto-attach those users to an org, and an unscoped GoTrue user is created globally. Apps cannot legitimately gate by email domain at the SSO layer.

The result: customer apps stay in invite-only mode forever, or operators set `self_signup=true` and accept the security debt.

### Why this fits the existing primitives

The on-callback auto-attach primitive already exists (`autoApplyOrgInviteByEmail`). The missing pieces are:

- a server-side step that says "this email matches a pre-approved domain, so write a one-shot `org_invites` row for the matched target org before generating the magic link";
- a small compatibility migration because `org_invites.created_by` is currently `NOT NULL`, but domain-signup invites are system-created before an admin/user actor exists;
- an exchange-path fix so pending Supabase email invites are applied for both new and existing Eve users.

This means domain allowlist is still implementable as a policy layer above `sendAppMagicLink`, not as a parallel membership writer. The membership creation funnel remains `org_invites` + invite claim, which is what makes this safe.

---

## Non-Goals

- **No domain ownership verification** in v1. The operator declares the domains; the platform trusts the manifest. (See [Open Decisions](#open-decisions) for a v2 DNS-TXT proof flow.)
- **No password-login support** in v1. Domain signup is magic-link-only. Apps using `login_method: password` cannot use this feature.
- **No per-domain target org** in v1. A single `target_org` covers most apps; multi-tenant routing (`@acme.com → org_acme`, `@globex.com → org_globex`) is deferred to v2.
- **No invites superseding**. If a pending `org_invites` row already exists for the email, it wins. We do not race-create a second invite for the same email.
- **No automatic project membership**. The user becomes an org `member`, not a project member. Apps that need project-level roles should layer that themselves in their own data model.
- **No role escalation**. The auto-attached role is always `member`. Admin/owner promotion must remain a deliberate, audited step. Schema parses `role` as a forward-compatibility hook but rejects anything other than `member` in v1.
- **No global free-email-provider blocklist**. Operators can declare `gmail.com` if they really want; manifest coherence warns but does not block.

---

## Plan

Five lanes. Lanes 1 and 2 together close the end-to-end user case.

1. **Schema + manifest sync** — express `domain_signup` under `org_access`.
2. **Magic-link send path** — match the email's domain; pre-create a one-shot `org_invites` row; reuse the existing branded-email + auto-attach flow.
3. **CLI + auth-context surfacing** — operators can audit what's actually accepted; the public app-context endpoint keeps the domain list server-side (never exposed via public API).
4. **Observability + safety** — emit a structured audit event for every domain-signup; rate-limit per `(project, domain)`.
5. **Docs + manual scenario** — Scenario 44 covers the happy path, a non-matching domain, and a pending-invite override.

---

### Lane 1: Schema + manifest sync

#### 1.1 Schema

**File**: `packages/shared/src/schemas/manifest.ts`

Add `AppDomainSignupConfigSchema` and extend `AppOrgAccessConfigSchema`:

```ts
import { domainToASCII } from 'node:url';

const EMAIL_DOMAIN_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const EmailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value, ctx) => {
    // Normalize Unicode to ASCII (punycode) for IDNs.
    const wildcard = value.startsWith('*.');
    const normalized = domainToASCII(wildcard ? value.slice(2) : value);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid domain: ${value}` });
      return z.NEVER;
    }
    const final = wildcard ? `*.${normalized}` : normalized;
    if (!EMAIL_DOMAIN_RE.test(final)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid email domain: ${value}` });
      return z.NEVER;
    }
    return final;
  });

export const AppDomainSignupConfigSchema = z.object({
  enabled: z.boolean().default(false),
  domains: z.array(EmailDomainSchema).default([]),
  /** Org ID or slug. Resolved to canonical org_id during manifest sync. */
  target_org: z.string().trim().min(1).optional(),
  /** Forward-compat hook. v1 only accepts 'member'. */
  role: z.literal('member').default('member'),
}).strict().default({})
  .superRefine((value, ctx) => {
    if (value.enabled && value.domains.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['domains'],
        message: 'domain_signup.enabled requires at least one domain',
      });
    }
  });

export type AppDomainSignupConfig = z.infer<typeof AppDomainSignupConfigSchema>;

export const AppOrgAccessConfigSchema = z.object({
  mode: z.enum(['project_org', 'allowlist']).default('project_org'),
  allowed_orgs: z.array(z.string().trim().min(1)).default([]),
  invite: AppInvitePolicySchema,
  domain_signup: AppDomainSignupConfigSchema,
}).strict().default({});
```

Validation rules:

- Each domain is lowercased, punycoded if IDN, and matches `^(?:\*\.)?host(\.host)+$`. No `@`, no scheme, no path, no port.
- Wildcards: a leading `*.` matches any number of subdomain labels (so `*.acme.com` matches `eu.acme.com` and `sub.eu.acme.com` but not bare `acme.com` — declare both if needed).
- Add a `ProjectAuthConfigSchema.superRefine` check: `domain_signup.enabled=true` is invalid when `login_method='password'`. `magic_link` and `password_or_magic_link` are valid because both expose a magic-link send path.
- The matched `target_org` (if provided) must resolve to an org that is also in the project's effective allow list (`mode='project_org'` → `project.org_id`; `mode='allowlist'` → `allowed_orgs`). This is a sync-time check because local manifest parsing cannot resolve org slugs.
- If `target_org` is omitted, derive at sync/resolve time: project owner org when `mode='project_org'`, the single allowed org when `mode='allowlist'` and `allowed_orgs.length === 1`. Reject sync if `mode='allowlist'` and the allowed orgs are ambiguous.
- Free-email providers (`gmail.com`, `yahoo.com`, `outlook.com`, `hotmail.com`, `protonmail.com`, `icloud.com`, etc.) get a coherence warning via `analyzeManifestCoherence`, not a hard reject, when `enabled=true`. Document the trust implications instead of forcing a policy decision into the schema.

#### 1.2 Manifest sync

**File**: `apps/api/src/projects/projects.service.ts` (`syncManifest`)

`AppOrgAccessConfigSchema` already flows through manifest sync today. Add `normalizeProjectAuthConfig` handling for `domain_signup`:

- Resolve `target_org` slug → canonical `org_id` using the same helper as `allowed_orgs`.
- If `target_org` is omitted, fill it with the single effective allowed org. For `project_org`, this is the project owner org because `normalizeProjectAuthConfig` already stores `allowed_orgs: [projectOrgId]`.
- Reject sync if `target_org` is not in the resolved allow list.
- Reject sync if `domain_signup.enabled=true`, `mode='allowlist'`, multiple allowed orgs exist, and `target_org` is omitted.
- Store the canonical ID in `projects.auth_config`.

`projects.auth_config` is already `JSONB`; no project-table migration is required.

#### 1.3 System-created org invites

**Files**:

- `packages/db/migrations/000XX_allow_system_org_invites.sql`
- `packages/db/src/queries/org-invites.ts`

Domain-signup invites are created by policy, not by an authenticated admin. Current `org_invites.created_by` is `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`, and `orgInviteQueries.create` requires `created_by: string`, so the plan cannot use `created_by: null` without a migration.

Add a migration:

```sql
ALTER TABLE org_invites
  ALTER COLUMN created_by DROP NOT NULL;
```

Then update the query type to `created_by: string | null` and keep existing explicit invite callers passing the real actor. This preserves audit semantics: explicit admin invites have an actor; domain-signup policy invites have `created_by = NULL` plus `app_context.source = 'domain_signup'`.

Also tighten `findByIdentityHint` while touching the query: use case-insensitive email matching and filter out expired rows in SQL, matching `findPendingByIdentityHintForOrgs`.

#### 1.4 Acceptance

- Manifest with `domain_signup.enabled=true` and `domains: [acme.com]` validates and syncs.
- Manifest with `domain_signup.enabled=true` and no domains is rejected at validate time.
- Manifest with `login_method: password` and `domain_signup.enabled=true` is rejected at validate time.
- Manifest with `target_org` not in `allowed_orgs` (when `mode='allowlist'`) is rejected at sync time.
- Manifest with `mode='allowlist'`, two allowed orgs, `domain_signup.enabled=true`, and no `target_org` is rejected at sync time with a clear error pointing to the ambiguity.
- `gmail.com` in `domains` produces a warning but parses successfully.

---

### Lane 2: Magic-link send path

#### 2.1 Domain matcher

**New file**: `apps/api/src/auth/email-domain.ts`

```ts
import { domainToASCII } from 'node:url';

export function normalizeEmailDomain(value: string): string | null {
  const normalized = domainToASCII(value.trim().toLowerCase());
  return normalized || null;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeEmailDomain(email.slice(at + 1));
}

export function matchesDomainAllowlist(email: string, allowlist: string[]): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  for (const entry of allowlist) {
    if (entry === domain) return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".acme.com"
      if (domain.endsWith(suffix) && domain.length > suffix.length) return true;
    }
  }
  return false;
}
```

Unit tests cover: lowercasing the email; `+suffix` aliases (`foo+bar@acme.com` → `acme.com`); wildcard `*.acme.com` matching `eu.acme.com` and `sub.eu.acme.com` but **not** `acme.com`; Unicode email-domain normalization (`user@bücher.example` matches stored `xn--bcher-kva.example`).

#### 2.2 `sendAppMagicLink` change

**File**: `apps/api/src/auth/auth.service.ts` (`sendAppMagicLink`, around line 707)

Insert a new branch between the "existing user with allowed-org membership" check and the existing self_signup fallback:

```ts
async sendAppMagicLink(input: MagicLinkRequest): Promise<MagicLinkResponse> {
  const project = await this.projects.findById(input.project_id, { include_deleted: false });
  if (!project) throw new BadRequestException(`Project not found: ${input.project_id}`);

  const authConfig = this.parseProjectAuthConfig(project.auth_config);
  if (!authConfig || authConfig.login_method === 'password') {
    throw new BadRequestException('Project is not configured for magic-link login');
  }

  const branding = this.parseProjectBranding(project.branding);
  const email = input.email.trim().toLowerCase();
  const user = await this.users.findByEmail(email);
  const allowedOrgIds = await this.appAuthPolicy.getAllowedOrgIds(project.id);

  // Path A: known user with allowed-org membership — existing branded send.
  if (user) {
    const [orgMemberships, projectMembership] = await Promise.all([
      Promise.all(allowedOrgIds.map((orgId) => this.memberships.findOrgMembership(user.id, orgId))),
      this.memberships.findProjectMembership(user.id, project.id),
    ]);
    if (orgMemberships.some(Boolean) || projectMembership) {
      await this.sendEligibleMagicLink(email, project.id, input.redirect_to, branding);
      return { sent: true };
    }
  }

  // Path B: pending explicit invite for this email — let the invite be the entry point.
  const pendingInvites = await this.orgInvites.findPendingByIdentityHintForOrgs('supabase', email, allowedOrgIds);
  const explicitPendingInvite = pendingInvites.find(
    (invite) => invite.app_context?.source !== 'domain_signup',
  );
  if (explicitPendingInvite) return { sent: true };

  // Path C (NEW): pre-approved email-domain auto-signup.
  const domainSignup = await this.appAuthPolicy.resolveDomainSignup(project, authConfig);
  if (domainSignup && matchesDomainAllowlist(email, domainSignup.domains)) {
    // Idempotency: a previous magic-link send for the same email already wrote
    // an unused invite for the same project+target_org. Don't write a second.
    const existing = pendingInvites.find(
      (invite) =>
        invite.app_context?.project_id === project.id &&
        invite.app_context?.source === 'domain_signup' &&
        invite.org_id === domainSignup.target_org,
    );
    if (!existing) {
      await this.orgInvites.create({
        org_id: domainSignup.target_org,
        created_by: null,
        invite_code: randomBytes(24).toString('base64url'),
        provider_hint: 'supabase',
        identity_hint: email,
        role: domainSignup.role,
        redirect_to: input.redirect_to ?? null,
        app_context: {
          project_id: project.id,
          org_id: domainSignup.target_org,
          source: 'domain_signup',
          matched_domain: emailDomain(email),
        },
        expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000),
      });
      await this.emitDomainSignupEvent(project.id, 'auth.domain_signup.invite_created', {
        org_id: domainSignup.target_org,
        email_domain: emailDomain(email),
      });
    }
    await this.sendEligibleMagicLink(email, project.id, input.redirect_to, branding);
    return { sent: true };
  }

  // Path D: unscoped self-signup (legacy escape hatch).
  if (authConfig.self_signup) {
    await this.sendEligibleMagicLink(email, project.id, input.redirect_to, branding);
    return { sent: true };
  }

  // Path E: generic success, no email, no GoTrue call.
  return { sent: true };
}
```

Key properties:

- The new `org_invites` row carries `app_context.source = 'domain_signup'` so audit + reporting can distinguish auto-attached members from CLI-invited ones.
- We **don't** call `generate_link` until the invite row exists, so the platform never creates a GoTrue user without a corresponding Eve membership intent.
- We re-use `sendEligibleMagicLink` (already account-enumeration-safe — `EmailSuppressedError` is swallowed and logged).
- The invite is one-shot: `autoApplyOrgInviteByEmail` already calls `markUsed(invite.id)` after upsert.
- Pending explicit org/app invites in any app-allowed org win because Path B checks for non-`domain_signup` pending invites, not only `app_context.project_id === project.id`.
- Existing pending domain-signup invites for the same project/target org are reused for idempotency; they do not suppress a fresh magic-link email.
- Generic success for non-matching domains (Path E) is preserved.

#### 2.3 `AppAuthPolicyService.resolveDomainSignup`

**File**: `apps/api/src/auth/app-auth-policy.service.ts`

```ts
async resolveDomainSignup(
  project: Project,
  auth: ProjectAuthConfig,
): Promise<{ target_org: string; role: 'member'; domains: string[] } | null> {
  const ds = auth.org_access.domain_signup;
  if (!ds.enabled || ds.domains.length === 0) return null;

  let targetOrg = ds.target_org;
  if (!targetOrg) {
    const allowed = await this.getAllowedOrgIds(project.id);
    if (allowed.length === 1) {
      targetOrg = allowed[0];
    } else {
      this.logger.warn(
        `domain_signup enabled but target_org unresolved (project=${project.id}, allowed=${allowed.length})`,
      );
      return null;
    }
  } else {
    // target_org may be stored as a slug if manifest sync did not normalize.
    targetOrg = (await this.resolveOrgRef(targetOrg)).id;
  }

  const allowed = await this.getAllowedOrgIds(project.id);
  if (!allowed.includes(targetOrg)) {
    this.logger.warn(
      `domain_signup.target_org=${targetOrg} is not in allowed orgs for project=${project.id}`,
    );
    return null;
  }

  return { target_org: targetOrg, role: ds.role, domains: ds.domains };
}
```

This intentionally **returns null instead of throwing** when the manifest is in a half-valid state — magic-link send must never reveal misconfiguration to the SSO UI. The logger.warn surfaces the issue for operators.

#### 2.4 Exchange-path auto-attach for existing users

**File**: `apps/api/src/auth/auth.service.ts` (`resolveSupabaseToken`, `autoApplyOrgInviteByEmail`)

The current invite auto-apply path only runs inside `autoProvisionSupabaseUser`. That is not enough for domain signup:

- A known Eve user with no Supabase identity is resolved by email and returns before invite auto-apply.
- A returning user with an existing Supabase identity is resolved by identity fingerprint and returns before invite auto-apply.

Extract the "apply pending Supabase email invite and carry redirect/app context" logic into a helper and call it for every Supabase exchange path when `claims.email` is present, before returning the final `AuthUser`.

Shape:

```ts
private async attachPendingSupabaseInvite(user: User, email: string): Promise<AuthUser> {
  const inviteResult = await this.autoApplyOrgInviteByEmail(user.id, email);
  const authUser = await this.authUserFromUser(user); // refetch memberships after upsert
  if (inviteResult.redirect_to) authUser.invite_redirect_to = inviteResult.redirect_to;
  if (inviteResult.org_id) authUser.invite_org_id = inviteResult.org_id;
  if (inviteResult.app_context !== undefined) authUser.invite_app_context = inviteResult.app_context;
  return authUser;
}
```

Use this helper in all three `resolveSupabaseToken` branches:

1. identity fingerprint hit;
2. email match + new Supabase identity link;
3. new user auto-provision.

This preserves the single membership funnel and makes the "known user with matching domain but no membership" acceptance case real.

#### 2.5 Rate limit

There is no existing `auth-magic-link` limiter in the API today. Add one as part of this feature instead of assuming it exists. The preferred shape is a small DB-backed bucket so it works across API replicas:

- key: `auth_magic_link:domain_signup:${project_id}:${email_domain}`;
- window: 1 hour;
- default limit: 30 sends/hour/domain/project;
- on exceed: return `{ sent: true }` without writing an invite and without sending email.

Without this, an attacker who knows an app's allowed domain can spray inboxes at the partner company. The bucket sits on the **send** path, not the success path, so a slow drip is fine but a burst gets dropped with no user-visible signal.

#### 2.6 Acceptance

- Unknown user `someone@acme.com` requesting a magic link on a project with `domain_signup` matching `acme.com` receives a branded magic-link email; clicking it lands them signed in as `member` of `target_org`.
- Unknown user `attacker@evil.example` on the same project receives `{sent: true}` with no email sent, no `org_invites` row, no GoTrue user.
- Known user `existing@acme.com` with no membership in `target_org` requesting magic link: a one-shot `org_invites` row is written, branded email sent, callback attaches them to `target_org`.
- Known user `existing@acme.com` with membership in `target_org` already: classic happy path, no new invite row.
- Pending invite for `existing@acme.com` overrides domain signup: no second invite row, no email (deferred to the explicit invite redemption).
- Re-requesting magic link from the same unknown email within the 72-hour invite TTL does not write a second invite row.
- Existing Eve user with a linked Supabase identity and no `target_org` membership receives a domain-signup magic link and is attached to `target_org` during exchange.

---

### Lane 3: CLI + auth-context surfacing

#### 3.1 Public `/auth/app-context`

**File**: `apps/api/src/auth/app-auth-policy.service.ts` (`toPublicAuthConfig`)

Do **not** surface `domain_signup.domains` publicly. The endpoint is unauthenticated; exposing the domain list would let any attacker probe to confirm which companies use which apps, and would let them target spear-phishing at known internal-tooling domains.

Add only a safe boolean to the public payload:

```ts
return {
  ...publicAuth,
  org_access: {
    mode: orgAccess.mode,
    multi_org: ...,
    invite_enabled: orgAccess.invite.enabled,
    domain_signup_enabled: orgAccess.domain_signup.enabled,
  },
  allowed_redirect_origins: allowedRedirectOrigins,
};
```

Extend `AppAuthContextOrgAccessSchema` in `packages/shared/src/schemas/auth.ts` accordingly.

The SSO UI can use `domain_signup_enabled` to optionally render a generic hint like "Use your work email to sign in" without revealing which domains are configured — but the flag alone does not leak any domain identity. If the hint is rendered, update `apps/sso/src/main.ts`'s app-context type and login-page copy in the same lane.

#### 3.2 Authenticated reveal

**Files**:

- `apps/api/src/auth/auth.controller.ts`
- `apps/api/src/auth/rbac.service.ts` (already has `requireProjectRole`)

Existing authenticated endpoint `GET /auth/app-access` already returns the caller's usable orgs. Add a sibling that surfaces the full resolved policy for project owners / system admins:

```http
GET /auth/app-context/admin?project_id=proj_xxx
Authorization: Bearer <eve-user-token>
```

Returns the full `org_access` block including `domain_signup.domains` and the resolved `target_org`. Permission: `projects:admin` on the target project (or system admin).

Do not rely on `@RequirePermission('projects:admin')` alone for this query-string route: `PermissionGuard.extractProjectId` resolves path params, not `?project_id=...`. Either:

- perform an explicit in-method check with `request.user.is_admin || rbacService.requireProjectRole(user.user_id, projectId, 'admin')`; or
- put the authenticated reveal under a path-param route such as `GET /projects/:project_id/auth-context` and use `@RequirePermission('projects:admin')`.

The query-string route is acceptable if it performs the explicit check.

#### 3.3 CLI

`eve project auth-context <project_id>` already exists (shipped with the redirect-allowlist plan). Extend its renderer to try `GET /auth/app-context/admin?project_id=...` first; on `401`/`403`, fall back to the public `/auth/app-context` response and render hidden details. For authorized callers, render:

```
Domain signup
  enabled:     true
  domains:     acme.com, *.acme.com
  target_org:  org_Acme
  role:        member
```

If the caller is not authorized for the admin endpoint, render `Domain signup: enabled (details hidden)` from the public payload.

#### 3.4 Acceptance

- `curl /auth/app-context?project_id=...` returns `org_access.domain_signup_enabled: true` but never the raw domain list.
- `curl /auth/app-context/admin?project_id=...` with a project-owner token returns the full domain list and resolved `target_org`.
- `eve project auth-context <project>` renders the domain list for project owners.

---

### Lane 4: Observability + safety

#### 4.1 Audit event

When the magic-link path writes a domain-signup `org_invites` row, emit through the existing event store (`eventQueries.create` or `EventsService.create`), not a Nest in-process event emitter. Use `source: 'auth'`, `actor_type: 'system'`, and put domain/signup details in `payload_json`.

```json
{
  "type": "auth.domain_signup.invite_created",
  "source": "auth",
  "project_id": "proj_xxx",
  "actor_type": "system",
  "payload_json": {
    "org_id": "org_target",
    "email_domain": "acme.com",
    "email_hash": "sha256:12chars"
  }
}
```

When `autoApplyOrgInviteByEmail` consumes a `source: 'domain_signup'` invite, emit:

```json
{
  "type": "auth.domain_signup.member_attached",
  "source": "auth",
  "project_id": "proj_xxx",
  "actor_type": "user",
  "actor_id": "user_xxx",
  "payload_json": {
    "org_id": "org_target",
    "user_id": "user_xxx",
    "email": "someone@acme.com",
    "email_domain": "acme.com"
  }
}
```

Both events flow through the existing event spine and into webhooks. Operators with `webhooks` subscribed to `auth.*` get real-time visibility.

Do **not** log the full email address in stdout at INFO level; log `email_domain` and `email_hash` (sha256 truncated) to limit accidental PII spread. The webhook payload may include the email because it goes only to subscribed operators.

#### 4.2 Pending-invite override metric

Track `auth.domain_signup.pending_invite_blocked` whenever Path B short-circuits a domain-signup-eligible email. This is a healthy signal (explicit invite wins), but a spike could indicate an admin re-issuing invites unnecessarily.

#### 4.3 Acceptance

- Sending one domain-signup magic link emits exactly one `invite_created` event.
- Clicking the link emits exactly one `member_attached` event.
- Re-requesting the magic link within 72 hours emits zero events (idempotent).

---

### Lane 5: Docs + manual scenario

#### 5.1 Internal docs

- `docs/system/auth.md` — new "Domain-based signup" section describing the trust model: operator declares domains, platform trusts them, no DNS proof in v1.
- `docs/system/app-sso-integration.md` — note the magic-link UI rendering when `domain_signup_enabled=true`.

#### 5.2 Public eve-skillpacks docs

Required updates in `../eve-skillpacks/eve-work/eve-read-eve-docs/references/`:

- `manifest.md` — document `x-eve.auth.org_access.domain_signup` shape, defaults, and gotchas (`gmail.com` warning, target_org disambiguation).
- `secrets-auth.md` — explain "anyone at `@acme.com` can sign in without invite" and how to revoke (remove from manifest + delete org memberships).

#### 5.3 Manual scenario 44

New file `tests/manual/scenarios/44-app-domain-signup-magic-link.md`. Mirrors Scenario 40 but exercises domain matching. Tested against local k3d, since GoTrue + Mailpit are available and `lvh.me` covers the redirect path.

Pass conditions:

1. Manifest with `domain_signup: { enabled: true, domains: [domainsignup.test], target_org: <org>, role: member }` syncs.
2. `someone@domainsignup.test` requests magic link → Mailpit shows ACME Portal-branded email → clicking lands signed in.
3. `eve org members --org <org>` lists `someone@domainsignup.test` with role `member`.
4. `attacker@otherdomain.test` requests magic link → SSO returns `{sent: true}` → Mailpit has zero messages for that address.
5. `someone-other@domainsignup.test` with a pre-existing pending `org_invites` row in an app-allowed org requests a domain-signup magic link → SSO returns `{sent:true}` → no new domain-signup invite is written and no magic-link email is sent; the explicit invite remains the entry point.
6. Re-requesting magic link for `someone@domainsignup.test` within the same hour writes no second invite row (check `SELECT count(*) FROM org_invites WHERE identity_hint = ...`).

---

## File-Level Change List

| File | Change | Lane |
| --- | --- | --- |
| `packages/shared/src/schemas/manifest.ts` | Add `EmailDomainSchema`, `AppDomainSignupConfigSchema`; extend `AppOrgAccessConfigSchema`; add password-mode validation + free-provider coherence warnings | 1.1 |
| `packages/shared/src/schemas/auth.ts` | Add `domain_signup_enabled` to `AppAuthContextOrgAccessSchema`; add admin app-context schema | 3.1 |
| `apps/api/src/projects/projects.service.ts` | Normalize `target_org` slug→id during sync; validate it's in allowed orgs | 1.2 |
| `packages/db/migrations/000XX_allow_system_org_invites.sql` | Allow `org_invites.created_by` to be nullable for policy-created invites | 1.3 |
| `apps/api/src/auth/email-domain.ts` | New: `emailDomain`, `matchesDomainAllowlist` + tests | 2.1 |
| `apps/api/src/auth/app-auth-policy.service.ts` | New `resolveDomainSignup`; update `toPublicAuthConfig` to surface only the bool | 2.3, 3.1 |
| `apps/api/src/auth/auth.service.ts` | Insert Path C in `sendAppMagicLink`; apply pending Supabase email invites for existing users; emit audit events | 2.2, 2.4, 4.1 |
| `apps/api/src/auth/auth.controller.ts` | Add `GET /auth/app-context/admin` with explicit project-admin check or move reveal under a project path-param route | 3.2 |
| `packages/db/src/queries/org-invites.ts` | Make `created_by` nullable in types; tighten `findByIdentityHint`; confirm `findPendingByIdentityHintForOrgs` returns domain-signup rows for idempotency check | 1.3, 2.2 |
| `packages/db/migrations/000XX_auth_magic_link_rate_limits.sql` | DB-backed per-`(project, domain)` send bucket if no shared limiter exists | 2.5 |
| `apps/api/src/auth/__tests__/auth.service.domain-signup.spec.ts` (new) | Unit tests for Path C: match/no-match, idempotency, pending-invite override, ambiguous target_org, existing-user auto-attach | 2 |
| `apps/api/src/auth/__tests__/email-domain.spec.ts` (new) | Domain match unit tests including wildcards and `+suffix` aliases | 2.1 |
| `apps/sso/src/main.ts` | Consume `domain_signup_enabled` if rendering a generic work-email hint | 3.1 |
| `packages/cli/src/commands/project.ts` | Render `domain_signup` block in `eve project auth-context` for authorized callers | 3.3 |
| `docs/system/auth.md` | New "Domain-based signup" section | 5.1 |
| `docs/system/app-sso-integration.md` | Note `domain_signup_enabled` rendering hint | 5.1 |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` | Document `x-eve.auth.org_access.domain_signup` | 5.2 |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md` | Document trust model and revocation | 5.2 |
| `tests/manual/scenarios/44-app-domain-signup-magic-link.md` (new) | Full happy-path + negative scenario | 5.3 |
| `tests/manual/README.md` | Add Scenario 44 | 5.3 |

OpenAPI regeneration after `AppAuthContextOrgAccessSchema` change and the new admin endpoint.

---

## Implementation Order

| Day | Lane | Output |
| --- | --- | --- |
| 1 | 1 | Schema + manifest sync + nullable `org_invites.created_by` migration. Unit tests for schema validation. `eve manifest validate` rejects bad shapes. |
| 1 | 2.1 | `email-domain.ts` helper + unit tests. |
| 2 | 2.2–2.4 | `sendAppMagicLink` Path C + `resolveDomainSignup` + exchange-path auto-attach for existing Supabase users. Service unit tests. |
| 2 | 2.5 | Per-`(project, domain)` rate-limit bucket. |
| 3 | 3 | Public app-context boolean + admin reveal endpoint + CLI rendering. |
| 3 | 4 | Audit events + webhook documentation. |
| 4 | 5 | Docs + Scenario 44 against local k3d. |
| 4 | — | Tag `release-v0.1.x` and verify on staging with a real ACME Portal domain. |

Each lane is independently reviewable, but Lanes 1 and 2 should ship together: Lane 1 alone has no user-visible effect, and Lane 2 depends on the `org_invites.created_by` migration plus schema/sync normalization. Lanes 3–5 are operability and safety.

---

## Verification

### Local (k3d)

1. Deploy starter app with `domain_signup` block (see Scenario 44).
2. Curl-driven matrix:
   - `POST /auth/magic-link` for `match@domainsignup.test` → Mailpit gets one branded email.
   - `POST /auth/magic-link` for `nope@otherdomain.test` → Mailpit gets zero emails.
   - Open the magic link from step (a) in a fresh browser → lands on app, then `eve org members --org <org>` lists the new user.
3. Re-run `POST /auth/magic-link` for `match@domainsignup.test` and verify no second `org_invites` row.

### Staging

1. Add a real domain (e.g., `example.com`) to a sandbox app's `domain_signup`. Deploy via tag.
2. Send a magic link to a brand-new `@example.com` address. Verify:
   - Branded email arrives via SES.
   - Click → land in app.
   - Org membership row exists.
   - Webhook listener received `auth.domain_signup.member_attached`.
3. Remove the domain from the manifest, redeploy, repeat — generic-success-no-email behavior restored.

---

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Misconfigured `domains: [gmail.com]` lets anyone in the world join `target_org` | Manifest coherence emits a warning for known free-email providers; docs explain the trust model; operators can revoke by removing the domain and dropping the org memberships. |
| Account enumeration via timing differences (matched vs. unmatched email) | Both paths return `{sent: true}` and write structured logs only (no log line per email at INFO). The `EmailSuppressedError` swallow already exists. Add a small constant-time jitter on Path E if needed (deferred). |
| An attacker spoofs a `@acme.com` magic-link email click | The magic link is a single-use GoTrue token sent to the real `@acme.com` inbox. Attacker can only redeem by compromising the mailbox first — the same trust assumption as every magic-link flow. |
| Rate-limited burst from a hostile origin enumerates valid `@acme.com` inboxes | Per-`(project, domain)` 30/hour bucket + per-IP GoTrue limit. Bucket drops to `{sent: true}` with no email; attacker sees no signal. |
| `target_org` disambiguation surprises users in multi-org allowlist mode | Manifest sync rejects ambiguous configurations. Runtime fallback logs a warning and silently skips Path C rather than auto-attaching to the wrong org. |
| Domain row leaks via `/auth/app-context` | Public endpoint surfaces only `domain_signup_enabled: bool`. Full reveal requires project-admin auth. |
| Auto-attach races with explicit invite for the same email | Path B short-circuits domain signup whenever a pending invite exists in an app-allowed org. The invite lookup filters expired rows and marks the consumed row used inside the shared claim path. |
| `org_invites` table grows from speculative magic-link sends | Idempotency check on `(project_id, email, source='domain_signup')` plus 72-hour TTL plus periodic GC of expired-and-used invite rows. |
| Free email and personal email mixed in real workforce (`@gmail.com` for contractors) | Two-tier policy: declare `@acme.com` in domain_signup; require explicit invite for `@gmail.com`. v1 supports this naturally — domain mismatch falls through to Path E, which means contractors need invites. |
| Customer wants to *remove* a domain after some accounts have already attached | Schema removal stops new signups but does not retroactively delete memberships. Document the runbook: `eve org members remove --org ... --user ...`. |

---

## Open Decisions

1. **DNS-proof of domain ownership** in a future v2? Recommendation: yes, but as a separate plan. Add a `verified_at` column on a new `project_email_domains` table and require a `_eve-domain-verification=<token>` TXT record before the domain becomes effective. Defer the table now; in v1 keep domains in `auth_config` JSONB.
2. **Show the matched domain to the user on the SSO page**? E.g., "We see you're signing in with `@acme.com`. Continue to ACME Portal." Recommendation: no — that turns the SSO page into an enumeration oracle. Just send the magic link.
3. **Per-domain `target_org` routing** (`@acme.com → org_acme`, `@globex.com → org_globex`)? Recommendation: defer to v2. Most apps are single-tenant; the few that aren't can layer on top.
4. **Should `role` ever support `admin`** for domain signup? Recommendation: no. Admin promotion must remain a deliberate audited step; auto-attaching admins from an email domain is an unbounded privilege escalation vector. Keep the schema literal `'member'` in v1.
5. **Should domain signup also work for *invite-style* GoTrue redemption** (i.e., `type=invite` redirects)? Recommendation: no. The platform should treat `org_invites` rows with `source='domain_signup'` identically to explicit invites at *consumption time* (they go through the same `autoApplyOrgInviteByEmail`), but generation is magic-link-only. Apps that want a one-click "invite" UX should call the existing app-scoped invite endpoint.
6. **Should `domain_signup` imply `login_method: magic_link`** if absent? Recommendation: no. Require an explicit non-password send path. Schema-level cross-field validation should reject `domain_signup.enabled=true` with `login_method='password'`; `password_or_magic_link` remains valid because the magic-link path exists.
7. **Quota: cap the number of domains per project**? Recommendation: soft cap at 25 with a coherence warning; a single project legitimately declaring 25 customer domains is unusual but not impossible.

---

## Acceptance

- A project with `org_access.domain_signup.enabled=true, domains=[acme.com], target_org=org_acme` lets any `@acme.com` user sign in via magic link without a per-user invite.
- The first successful login auto-attaches the user as `member` of `org_acme` via the shared pending-invite claim flow, whether the Eve user is new or already exists.
- An unknown email at a non-matching domain receives generic success and no email.
- Public `/auth/app-context` does not reveal the configured domain list.
- `eve project auth-context <project>` shows the resolved domain list to project owners.
- Audit events `auth.domain_signup.invite_created` and `auth.domain_signup.member_attached` are emitted on the event spine and reach subscribed webhooks.
- Scenario 44 passes against local k3d; tag-and-deploy verification passes on staging.
