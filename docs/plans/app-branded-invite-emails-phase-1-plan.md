# App-Branded Invite Emails — Phase 1 Plan

> **Status**: Reviewed / updated — 2026-05-09
> **Scope**: Platform (eve-horizon)
> **Source idea**: [`docs/ideas/app-branded-invite-emails.md`](../ideas/app-branded-invite-emails.md)
> **Driver**: `example-org/example-app` (ACME Portal ExampleCo demo)

---

## Goal

Ship the smallest change that makes invite emails read as the inviting app. Specifically:

> When `acme-portal` invites a user, the email body, subject, and `From:` display name say **"ACME Portal"**, with the ACME Portal logo and primary colour. Other apps fall back to the existing "Eve Horizon" defaults.

That is the entire Phase 1 deliverable. SSO landing pages, verified `From:` domains, recovery / magic-link emails, and a self-serve UI are all explicitly **out of scope** (Phases 2–4 in the source idea).

---

## Non-Goals

- **No SSO broker page changes.** `/login`, `/callback`, `/set-password` remain "Eve". Branded landing pages are Phase 2.
- **No verified per-tenant `From:` address.** All mail goes out from the platform default `From:` address; only the display name varies. Domain verification is Phase 3.
- **No new password-recovery / magic-link / email-change templates.** GoTrue continues to send those with its defaults. Branding those is Phase 3.
- **No new admin or dashboard UI.** Branding is authored in `.eve/manifest.yaml` only.
- **No `orgs.branding` column.** Project-level branding only. Orgs fallback can come later if a multi-project org demands it.

---

## Design

Three moving parts: a `branding` field on projects, a tiny mailer service, and a swap in the invite path.

### 1. Branding on projects

One jsonb column on `projects`, populated by manifest sync. No org-level fallback yet — if absent, use platform defaults.

```sql
-- packages/db/migrations/00093_project_branding.sql
-- Use the next free migration number if this changes before implementation.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS branding JSONB;
```

Schema (in `packages/shared/src/schemas/manifest.ts`):

```ts
export const ProjectBrandingSchema = z.object({
  app_name:        z.string().min(1).max(60),
  app_logo_url:    z.string().url().optional(), // Phase 1 renderer only emits https:// image URLs
  primary_color:   z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  email_from_name: z.string().max(60).optional(),
  reply_to_email:  z.string().email().optional(),
  support_email:   z.string().email().optional(),
  support_url:     z.string().url().optional(),
}).strict();

export type ProjectBranding = z.infer<typeof ProjectBrandingSchema>;
```

Add `branding: ProjectBrandingSchema.optional()` to `ManifestXeveSchema` (line 254 of `manifest.ts`). Add a small helper `getManifestBranding(manifest)` that reads `manifest['x-eve'].branding ?? manifest.x_eve.branding`.

Implementation notes:
- Trim string fields before storing; reject CR/LF in any email header-adjacent field (`app_name`, `email_from_name`, `reply_to_email`) to prevent header injection.
- For Phase 1, only render `app_logo_url` in HTML if it is `https://...`; silently omit non-HTTPS logos rather than sending broken or mixed-content email.
- Store the validated, normalized object in `projects.branding`; do not store the raw manifest fragment.

Manifest authoring (what ACME Portal adds to `acme-portal/.eve/manifest.yaml`):

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

### 2. Manifest sync persists branding

In `ProjectsService.syncManifest` (`apps/api/src/projects/projects.service.ts:487`), after the existing `parsedAgents = getManifestAgents(...)` block, call the new `getManifestBranding(...)` and write it to `projects.branding` via a new `projectsQueries.updateBranding(projectId, branding ?? null)`.

This keeps branding next to the project, refreshed every manifest sync, and trivially read at invite time.

Do the write on both manifest paths:
- Existing manifest hash path: update `projects.branding` before returning the touched/updated manifest response. This lets a post-migration resync backfill branding even when the manifest content has not changed.
- New manifest path: update `projects.branding` after the manifest row is created and before returning.

If a manifest removes `x-eve.branding`, write `NULL` so stale branding does not persist forever.

### 3. MailerService

A small service. SMTP only; reuses GoTrue's existing SMTP settings (`GOTRUE_SMTP_HOST`, `GOTRUE_SMTP_PORT`, `GOTRUE_SMTP_USER`, `GOTRUE_SMTP_PASS`, `GOTRUE_SMTP_ADMIN_EMAIL`) and adds only an optional `MAILER_FROM_ADDRESS` override. Mailpit is already deployed in local/k3d and exposed at `http://mail.eve.lvh.me`; GoTrue points at `mailpit.eve.svc.cluster.local:1025` today.

Important deployment detail: the API deployment does **not** currently receive `GOTRUE_SMTP_*`. Phase 1 must add the SMTP env to both:
- `k8s/base/api-deployment.yaml`
- `packages/cli/assets/local-k8s/base/api-deployment.yaml`

Staging/prod env wiring belongs in `../deployment-instance`; do not patch live AWS resources directly.

```
apps/api/src/mailer/
├── mailer.module.ts          (NestJS module)
├── mailer.service.ts         (~50 lines: nodemailer transport + sendMail)
└── templates/
    └── invite.ts             (renderInviteEmail({branding, action_link, expires_at}))
```

`mailer.service.ts` skeleton:

```ts
@Injectable()
export class MailerService {
  private readonly transport = nodemailer.createTransport({
    host: process.env.GOTRUE_SMTP_HOST,
    port: Number(process.env.GOTRUE_SMTP_PORT ?? 587),
    auth: process.env.GOTRUE_SMTP_USER
      ? { user: process.env.GOTRUE_SMTP_USER, pass: process.env.GOTRUE_SMTP_PASS! }
      : undefined,
  });

  async send(args: {
    to: string;
    fromName: string;     // "ACME Portal" (display name only in Phase 1)
    replyTo?: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<void> {
    const fromAddr =
      process.env.MAILER_FROM_ADDRESS ??
      process.env.GOTRUE_SMTP_ADMIN_EMAIL ??
      'noreply@eve.local';
    await this.transport.sendMail({
      from:    { name: args.fromName, address: fromAddr },
      replyTo: args.replyTo,
      to:      args.to,
      subject: args.subject,
      html:    args.html,
      text:    args.text,
    });
  }
}
```

`templates/invite.ts` exports a single function `renderInviteEmail({ branding, actionLink, expiresAt })` that returns `{ subject, html, text }`. One HTML template, one text template, no helpers. The HTML uses table-based layout (gmail-safe), escapes all interpolated text, inlines `branding.primary_color` for the button, and `<img src="branding.app_logo_url">` if set and HTTPS. Footer reads "Sent by {app_name} via Eve Horizon".

Defaults when `branding` is null: `app_name = "Eve Horizon"`, no logo, primary colour `#0a0a0a`.

### 4. Invite path swap

In `apps/api/src/orgs/orgs.service.ts:416` (`OrgsService.createOrgInvite`), accept an optional `project_id` (added to `OrgScopedInviteRequestSchema` — see below) and resolve branding via `projectsQueries.findById(project_id)?.branding ?? null`.

Required guardrail: if `project_id` is supplied, the project must exist and `project.org_id === orgId`. Otherwise return a 4xx and do not send an email. Branding is visible-only, but allowing one org to borrow another app's display name/logo is still a phishing footgun.

When `project_id` is supplied, also merge it into the persisted invite context for auditability and Phase 2 reuse:

```ts
app_context: {
  ...(body.app_context ?? {}),
  project_id: body.project_id,
}
```

Do not read branding back out of `app_context`; use the project row as the source of truth.

Replace `await this.authService.sendSupabaseInvite(body.email, ssoRedirect)` (one line today) with:

```ts
const link = await this.authService.generateInviteLink(body.email, ssoRedirect);
await this.mailer.send(renderInviteEmail({
  branding,
  actionLink: link,
  expiresAt:  invite.expires_at!,
  to:         body.email,
}));
```

In `apps/api/src/auth/auth.service.ts`, replace `sendSupabaseInvite` with `generateInviteLink`. The new method calls GoTrue's **admin generate-link** endpoint instead of `/invite`:

```ts
async generateInviteLink(email: string, redirectTo?: string): Promise<string> {
  const config = loadConfig();
  const res = await fetch(`${config.SUPABASE_AUTH_URL}/admin/generate_link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
               Authorization: `Bearer ${config.SUPABASE_AUTH_SERVICE_KEY}`,
               apikey: config.SUPABASE_AUTH_SERVICE_KEY },
    body: JSON.stringify({ type: 'invite', email, redirect_to: redirectTo }),
  });
  if (!res.ok) throw new BadRequestException(`generate_link failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    action_link?: string;
    properties?: { action_link?: string };
  };
  const actionLink = data.action_link ?? data.properties?.action_link;
  if (!actionLink) throw new BadRequestException('generate_link did not return action_link');
  return actionLink;
}
```

Why `generate_link` and not `/invite`: `/invite` sends an email *and* returns. `generate_link` returns the same magic link without sending — we send the email ourselves with our own branded body. The user-facing GoTrue redirection mechanics are identical (same `/verify` → `${SITE_URL}` flow), so no SSO broker changes are needed in Phase 1.

### 5. Invite request schema

`packages/shared/src/schemas/auth.ts`, `OrgScopedInviteRequestSchema` (line 180):

```ts
export const OrgScopedInviteRequestSchema = z.object({
  email:        z.string().email(),
  role:         z.enum(['owner', 'admin', 'member']).default('member'),
  send_email:   z.boolean().default(true),
  redirect_to:  z.string().optional(),
  app_context:  z.record(z.unknown()).optional(),
  project_id:   z.string().min(1).optional(),   // NEW: resolves branding for the email
});
```

CLI support follows in the same PR:

```bash
eve org invite <email> --org <org_id> [--project <project_id>] [--role member] [--redirect-to <url>] [--no-email] [--json]
```

There is no `eve org invite` command today, so this is a new subcommand in `packages/cli/src/commands/org.ts` plus help text in `packages/cli/src/lib/help.ts`.

No new permissions — `orgs:invite` already gates the endpoint. `project_id` resolves branding and is stored for audit context; it does not grant project membership.

---

## File-Level Change List

| File | Change | Approx. LOC |
|---|---|---|
| `packages/db/migrations/00093_project_branding.sql` | New: 1-line migration | 2 |
| `packages/db/src/queries/projects.ts` | Add `updateBranding(id, branding)`; include `branding` in select | ~10 |
| `packages/shared/src/schemas/manifest.ts` | Add `ProjectBrandingSchema`; extend `ManifestXeveSchema`; add `getManifestBranding()` helper | ~25 |
| `packages/shared/src/schemas/auth.ts` | Add `project_id` to `OrgScopedInviteRequestSchema` | 1 |
| `apps/api/src/projects/projects.service.ts` | Persist branding in `syncManifest` | ~5 |
| `apps/api/package.json`, `pnpm-lock.yaml` | Add `nodemailer` and `@types/nodemailer` if needed | ~5 |
| `apps/api/src/mailer/mailer.module.ts` | New module | ~10 |
| `apps/api/src/mailer/mailer.service.ts` | New service | ~50 |
| `apps/api/src/mailer/templates/invite.ts` | New template renderer | ~80 |
| `apps/api/src/mailer/__tests__/invite.spec.ts` | Snapshot test for branded vs default render | ~40 |
| `apps/api/src/auth/auth.service.ts` | Replace `sendSupabaseInvite` with `generateInviteLink` | net ≈ 0 |
| `apps/api/src/orgs/orgs.service.ts` | Resolve branding by `project_id`; call mailer | ~15 |
| `apps/api/src/orgs/orgs.module.ts` | Import `MailerModule` | 1 |
| `apps/api/src/auth/auth.controller.ts` | Keep `/auth/supabase/invite` as a compatibility wrapper using `generateInviteLink` + default branding | ~10 |
| `apps/api/src/auth/auth.controller.spec.ts` | Update invite endpoint assertions for the new compatibility wrapper | ~10 |
| `k8s/base/api-deployment.yaml` | Inject API SMTP env (`GOTRUE_SMTP_*`, optional `MAILER_FROM_ADDRESS`) | ~8 |
| `packages/cli/assets/local-k8s/base/api-deployment.yaml` | Mirror local k3d API SMTP env for Mailpit | ~8 |
| `packages/cli/src/commands/org.ts` | Add new `invite` subcommand and `--project` flag | ~35 |
| `packages/cli/src/commands/admin.ts` | Keep `admin invite --web` green by calling the compatibility endpoint or migrate it explicitly | ~5 |
| `packages/cli/src/lib/help.ts` | Document `eve org invite` and any changed admin invite behavior | ~20 |
| `tests/manual/scenarios/39-app-branded-invite.md` | New manual scenario; reuses Scenario 21 Mailpit checks and the existing starter app | ~120 |
| `tests/manual/README.md` | Add Scenario 39 to the manual suite index | ~3 |
| `tests/manual/scenarios/21-web-auth.md` | Update default invite expectations if the subject/body changes from GoTrue's built-in template | ~10 |
| `eve-skillpacks/.../references/secrets-auth.md` | Document `x-eve.branding` block | ~30 |
| `docs/system/app-sso-integration.md` | Note branding block at the bottom | ~15 |

**Total**: ~450 LoC, one PR.

New runtime dependency: `nodemailer` (~50 KB, already transitively present via Supabase SDK in some projects but adding it explicitly to `apps/api/package.json`).

New env vars on the API service:
- `GOTRUE_SMTP_HOST`, `GOTRUE_SMTP_PORT`, `GOTRUE_SMTP_USER`, `GOTRUE_SMTP_PASS`, `GOTRUE_SMTP_ADMIN_EMAIL` (same values already used by GoTrue; local k3d points at Mailpit).
- `MAILER_FROM_ADDRESS` (optional; fallback order is `MAILER_FROM_ADDRESS` → `GOTRUE_SMTP_ADMIN_EMAIL` → `noreply@eve.local`). Set to `noreply@eve.example.com` in staging if GoTrue's admin email is not already correct.

---

## Branding Resolution Order (Phase 1)

```
project.branding          ← if present and project_id supplied on invite
  ↓ otherwise
platform defaults          ← { app_name: "Eve Horizon", primary_color: "#0a0a0a", no logo }
```

A future `orgs.branding` slot is reserved between these layers but not implemented in Phase 1.

---

## Implementation Order

Each step is independently mergeable but the PR ships them together:

1. **Migration + project query method.** `00093_project_branding.sql` (or next free number) and the queries change. Include `branding` in the `Project` interface and `findById` result.
2. **Schemas.** `ProjectBrandingSchema`, manifest `getManifestBranding`, `OrgScopedInviteRequestSchema.project_id`. Unit tests for schema validation.
3. **Manifest sync.** Persist branding in `syncManifest`, including the existing-hash path and `NULL` clearing. Add a focused unit test that round-trips a branding block.
4. **API SMTP env.** Add Mailpit SMTP env to local k3d API manifests and document the staging infra overlay requirement.
5. **MailerService + invite template.** With a snapshot test (`invite.spec.ts`) covering default and ACME Portal branded renders. No network in tests — mock the transport.
6. **Auth service: `generateInviteLink`.** Replace the GoTrue `/invite` call internally; keep `/auth/supabase/invite` as a compatibility wrapper that uses the same renderer with default branding.
7. **OrgsService: resolve and send.** Wire org-scoped project lookup, org ownership guardrail, branding lookup, invite context merge, and mailer send.
8. **CLI + manual scenario.** Add `eve org invite <email> --project <id>`; keep `eve admin invite --web` passing; add Scenario 39.

Order matters: 1 → 2 → 3 unblock 7; 4 → 5 → 6 unblock real Mailpit verification; 8 is the agent-facing validation surface.

---

## Testing

### Unit

- `ProjectBrandingSchema` accepts the documented manifest block; rejects bad colour codes and bad URLs.
- `getManifestBranding()` reads from both `x-eve.branding` and `x_eve.branding` (existing convention).
- `renderInviteEmail()` snapshot tests:
  - default branding (no project) → `Eve Horizon` in subject, no logo `<img>`, default colour.
  - ACME Portal branding → `ACME Portal` in subject, logo `<img>`, primary colour applied to the button.
- `MailerService.send` calls the mocked transport with the right `from` and `replyTo`.
- `MailerService.send` uses structured `from: { name, address }`, rejects/strips header CR/LF, and falls back to `GOTRUE_SMTP_ADMIN_EMAIL` when `MAILER_FROM_ADDRESS` is unset.

### Integration

- There is not currently an obvious `apps/api/test/orgs.invites.spec.ts`; implementation should add the smallest focused service/controller test near `apps/api/src/orgs/` if no integration harness exists. Create a project with branding, post `/orgs/:org_id/invites` with `project_id`, assert `mailer.send` was called with the branded subject/body fragments.
- One test that omits `project_id` and asserts the default branding path is taken.
- One test that supplies a project from another org and asserts 4xx with no email sent.
- Update `apps/api/src/auth/auth.controller.spec.ts` so `/auth/supabase/invite` still sends a default-branded email through the shared path.

### Manual / Agent E2E

A new scenario `tests/manual/scenarios/39-app-branded-invite.md` must be executable by an agent against the local k3d stack. It should reuse the existing local web-auth/Mailpit surface from Scenario 21 and deploy the existing `../eve-horizon-starter` app, not invent a throwaway app. The starter app is deliberately used instead of `../eve-horizon-fullstack-example` because the fullstack example carries agent pack config that can collide in reused local clusters and trigger manifest-drift checks unrelated to invite email branding.

Scenario outline:

1. **Environment detection and baseline auth.**
   ```bash
   ./bin/eh status
   ./bin/eh k8s start
   ./bin/eh k8s deploy
   export EVE_API_URL=http://api.eve.lvh.me
   eve profile use local
   eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
   pnpm -C packages/cli build
   ```
   Then run or inline the relevant Scenario 21 checks: GoTrue health, Mailpit UI/API, SSO health, auth config, and default invite email capture. Scenario 21 already verifies Mailpit at `http://mail.eve.lvh.me` and message listing via `GET /api/v1/messages`.

2. **Deploy the existing starter app from a clean ref.**
   ```bash
   export ORG_ID=org_brandedinviteverify
   eve org ensure "$ORG_ID" --name "branded-invite-verify" --slug biv --json

   export STARTER_DIR=${STARTER_DIR:-../eve-horizon-starter}
   export REPO_DIR=$(mktemp -d)/repo
   cp -R "$STARTER_DIR" "$REPO_DIR"

   PROJECT_JSON=$(eve project ensure \
     --org "$ORG_ID" \
     --name "branded-invite-starter" \
     --slug bstrt \
     --repo-url https://github.com/eve-horizon/eve-horizon-starter \
     --branch main \
     --force \
     --json)
   export PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.id // .data.id')

   eve secrets set POSTGRES_PASSWORD eve --project "$PROJECT_ID" --json
   eve env create sandbox --type persistent --project "$PROJECT_ID" --json || true
   eve env deploy sandbox --ref main --repo-dir "$REPO_DIR" --project "$PROJECT_ID"
   curl -fsS "http://api.biv-bstrt-sandbox.lvh.me/health" | jq
   ```

3. **Sync branding metadata after the clean app deploy.**

   Inject this block into `$REPO_DIR/.eve/manifest.yaml` under the existing `x-eve:`:
   ```yaml
     branding:
       app_name: "ACME Portal"
       app_logo_url: "https://sandbox.acme.example/assets/logo.svg"
       primary_color: "#1f6feb"
       email_from_name: "ACME Portal"
       reply_to_email: "support@acme.example"
       support_email: "support@acme.example"
       support_url: "https://acme.example/help"
   ```

   Agent-executable injection example:
   ```bash
   perl -0pi -e 's/^x-eve:\n/x-eve:\n  branding:\n    app_name: "ACME Portal"\n    app_logo_url: "https:\/\/sandbox.acme.example\/assets\/logo.svg"\n    primary_color: "#1f6feb"\n    email_from_name: "ACME Portal"\n    reply_to_email: "support\@acme.example"\n    support_email: "support\@acme.example"\n    support_url: "https:\/\/acme.example\/help"\n/m' "$REPO_DIR/.eve/manifest.yaml"
   rg -n "branding|ACME Portal|primary_color" "$REPO_DIR/.eve/manifest.yaml"
   ```

   Then sync the branded manifest. This updates `projects.branding`; do not redeploy after the dirty branding injection, because deploy drift checks must compare the committed starter manifest.
   ```bash
   eve project sync --project "$PROJECT_ID" --dir "$REPO_DIR" --json
   ```

4. **Send an app-branded org invite through the new CLI.**
   ```bash
   INVITE_EMAIL="acme-invite-$(date +%s)@eve.local"
   node packages/cli/bin/eve.js org invite "$INVITE_EMAIL" \
     --org "$ORG_ID" \
     --project "$PROJECT_ID" \
     --redirect-to "http://api.biv-bstrt-sandbox.lvh.me/health" \
     --json \
     | tee /tmp/app-branded-invite-response.json

   jq -e --arg email "$INVITE_EMAIL" '.identity_hint == $email' /tmp/app-branded-invite-response.json
   jq -e --arg project "$PROJECT_ID" '.app_context.project_id == $project' /tmp/app-branded-invite-response.json
   ```

5. **Assert the email through Mailpit API, not just by eye.**
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
   curl -s "http://mail.eve.lvh.me/api/v1/message/$MESSAGE_ID" | tee /tmp/app-branded-invite-mail.json

   jq -e '.From.Name == "ACME Portal"' /tmp/app-branded-invite-mail.json
   jq -e '.From.Address == "noreply@eve.local" or .From.Address == "noreply@eve.example.com"' /tmp/app-branded-invite-mail.json
   jq -e '.Subject | contains("ACME Portal")' /tmp/app-branded-invite-mail.json
   jq -e '(.HTML // "") | contains("https://sandbox.acme.example/assets/logo.svg")' /tmp/app-branded-invite-mail.json
   jq -e '(.HTML // "") | contains("#1f6feb")' /tmp/app-branded-invite-mail.json
   jq -e '(.Text // "") | contains("ACME Portal")' /tmp/app-branded-invite-mail.json
   ```

   If Mailpit's detail response field names differ in the deployed image, adjust the scenario after observing the actual JSON once; keep the assertions machine-checkable.

6. **Click-through / SSO smoke.**
   Extract the invite action link from the Mailpit text body, not the HTML `href`, because HTML correctly entity-escapes query strings. Open it with `./bin/eh browser open "$ACTION_LINK"` or Playwright, and confirm the existing GoTrue → SSO `/set-password` flow still renders and can complete. The page is still Eve-branded in Phase 1; the pass condition is that the branded email did not break invite redemption or final redirect to `http://api.biv-bstrt-sandbox.lvh.me/health`.

7. **Default fallback pass.**
   Send a second invite without `--project`; assert the subject/body/from-name use the Eve Horizon defaults and no ACME Portal logo/color appears.

Scenario 21 should remain green after this change. Its default invite expectation may need to change from GoTrue's built-in subject (`"You have been invited"`) to the new default Eve-rendered subject, but the behavior it verifies is the same: GoTrue, SSO, Mailpit, token exchange, and admin invite compatibility.

---

## Rollout

- **Local (k3d)**: ships with the PR; Scenario 39 validates the full loop against Mailpit and `../eve-horizon-starter`.
- **Staging (`eve.example.com`)**: tag a `release-v*` after merge; staging deploy will need the API service to receive the same SMTP env as GoTrue. Make that change in the infra repo (`../deployment-instance`), via Terraform/Kustomize as appropriate. Do not mutate AWS infrastructure or live Kubernetes manifests out of band.
- **Backwards compatibility**: `POST /orgs/:org_id/invites` is unchanged except for optional `project_id`. Keep `/auth/supabase/invite` in Phase 1 as a compatibility wrapper because `packages/cli/src/commands/admin.ts` and Scenario 21 currently call it. Remove it only in a later PR after CLI/docs/scenarios are migrated.
- **Feature flag**: none. Branding is opt-in by manifest block; a project that doesn't set it gets the same email it gets today (Eve-branded) — modulo the swap from GoTrue's built-in template to our own. Snapshot tests guard the default-render text against accidental drift.

---

## Risk

| Risk | Mitigation |
|---|---|
| **GoTrue `generate_link` URL semantics differ from `/invite`** and break the existing SSO-broker hash-fragment redirect handling. | Manual scenario step 4 explicitly verifies post-click flow. The endpoints share the same underlying token and redirect logic — risk is low but worth confirming in a real run. |
| **HTML email rendering across clients** (Outlook, Gmail, mobile). | Use a known-safe table-based template with inline styles. Add a Litmus / Email-on-Acid pass before the ACME Portal demo if appearance matters; otherwise rely on Gmail and Outlook web preview. |
| **API is not given SMTP env** → local branded invites fail even though GoTrue emails work. | Add `GOTRUE_SMTP_*` to both API deployment manifests and validate with Scenario 39 against Mailpit. |
| **`MAILER_FROM_ADDRESS` not configured in staging** → wrong sender or spammy email. | Fall back to `GOTRUE_SMTP_ADMIN_EMAIL`; set/verify the value in the infra repo before release. |
| **`nodemailer` adds 50KB to the API image.** | Acceptable; trivial. |
| **An attacker passes a `project_id` they don't own to influence branding.** | Require `project.org_id === invite org_id`; otherwise 4xx and do not send. |
| **Header injection through display name / reply-to fields.** | Reject CR/LF in branding fields and pass structured `from` objects to nodemailer. |

---

## What This Unblocks

- ACME Portal ExampleCo demo: the invite email reads as ACME Portal with their colour and logo.
- Every future Eve-deployed app with external users: just add `x-eve.branding` to their manifest.
- Phase 2 (branded SSO landing pages) reuses `projects.branding`, `getManifestBranding`, the schema, and the resolution helper — no rework.

---

## Verification Notes

- Local k3d verified: GoTrue `/admin/generate_link` returns a usable invite action link; branded invite click-through returned HTTP 303 from `auth.eve.lvh.me/verify`.
- Mailpit detail JSON uses `From`, `ReplyTo`, `Subject`, `HTML`, and `Text`; Scenario 39 assertions now target those fields.
- Focused org invite coverage lives in `apps/api/src/orgs/orgs.service.spec.ts`; no broad integration harness was needed for Phase 1.
- Remaining before staging release: pick/verify the staging sender value in `../deployment-instance` before tagging `release-v*`.
