# Magic-Link Email Silent-Drop Fix Plan

> **Status**: Proposed - 2026-05-11
> **Scope**: Platform mailer observability, SES bounce/complaint feedback loop, SPF hardening, immediate unblock for `admin@example.com`
> **Related**: [`app-branded-invite-emails-phase-1-plan.md`](./app-branded-invite-emails-phase-1-plan.md), [`app-magic-link-login-opt-in-plan.md`](./app-magic-link-login-opt-in-plan.md)
> **Repos touched**: `eve-horizon-2` (platform), `deployment-instance-repo` (AWS SES + DNS), operational ops (SES suppression purge)

---

## Goal

Make account-level SES suppression impossible to mistake for a successful Eve-deployed app auth email (invite + magic link). Today, when SES adds a recipient to its account-wide suppression list, `MailerService.send()` returns success, the API logs `Generated GoTrue ... link`, and the SSO UI tells the user "If your email has access, you will receive a sign-in link" — but no mail is delivered, no error is logged, and nothing is observable from the CLI or staging logs.

The first user to hit this was `admin@example.com` testing the ACME Portal magic-link login on staging after the magic-link feature shipped in `release-v0.1.275`.

---

## Diagnosis

### Symptom

In an incognito browser, on `https://sso.eve.example.com/login?project_id=proj_example&redirect_to=...`, submitting `admin@example.com` shows the generic "If your email has access, you will receive a sign-in link" success message. No email arrives.

### What the platform did correctly

1. SSO fetches `GET /auth/app-context?project_id=...` and renders the ACME Portal magic-link-only login page. Verified by:
   ```bash
   curl -fsS https://api.eve.example.com/auth/app-context?project_id=proj_example
   # → {"project_id":"proj_example","org_id":"org_example",
   #     "branding":{"app_name":"ACME Portal",...},
   #     "auth":{"login_method":"magic_link","self_signup":false,
   #             "invite_requires_password":false,
   #             "org_access":{"mode":"allowlist","multi_org":true,"invite_enabled":true}}}
   ```
2. `acme-portal` manifest's `x-eve.auth.org_access.allowed_orgs: [org_example, org_Acme]` resolves correctly — both orgs exist with literal IDs (`AppAuthPolicyService.resolveOrgRef` accepts non-TypeID `org_*` IDs).
3. `admin@example.com` is `owner` of `org_example`, so `sendAppMagicLink` eligibility passes.
4. `generateAuthActionLink('magiclink', email, ssoRedirect)` calls GoTrue `POST /admin/generate_link` and returns an action URL. The API logs:
   ```
   AuthService Generated GoTrue magiclink link for admin@example.com
   ```
5. `MailerService.send()` calls nodemailer's `transport.sendMail()` against `email-smtp.us-west-2.amazonaws.com:587`. The SMTP transaction returns 250 OK. No exception is thrown.
6. `sendAppMagicLink` returns `{ sent: true }`. The controller responds 200.

### Where it actually broke

```bash
aws sesv2 get-suppressed-destination --email-address admin@example.com --region us-west-2
# {
#   "SuppressedDestination": {
#     "EmailAddress": "admin@example.com",
#     "Reason": "BOUNCE",
#     "LastUpdateTime": "2026-05-11T09:28:17.364000+01:00",
#     "Attributes": {
#       "MessageId": "0101019e1626b83d-a438a05e-a597-4883-9dc0-610ff67ee84e-000000",
#       "FeedbackId": "0101019e1626ba31-a9b84aea-1b5c-4027-9a96-c1b12becd525-000000"
#     }
#   }
# }
```

AWS SES added `admin@example.com` to its **account-wide suppression list** earlier today after a bounce. While the address is on this list, every SES send to it from this AWS account silently succeeds at the SMTP layer and is then dropped. Eve has no visibility into this — `nodemailer` never sees an error, the API never logs a failure, and there is no bounce notification anywhere because we have not wired up SNS bounce events.

Related entries in the same suppression list:

- `adam+acme-smoke-1778413063@example.com` (BOUNCE, 2026-05-10 12:37) — a smoke-test alias that doesn't exist; SES hard-bounced it.
- Other historical bounces unrelated to this feature.

### Upstream cause of the original bounce

`example.com` DNS today:

```
SPF:   v=spf1 include:_spf.google.com include:spf.protection.outlook.com include:mailgun.org ~all
DMARC: v=DMARC1; p=none; rua=mailto:postmaster@example.com
DKIM:  3 SES-managed tokens for ses-mail.example.com — SUCCESS
MX:    google.com (Workspace)
```

SES is configured with a **custom MAIL FROM** of `ses-mail.example.com`, which has its own SPF and verified status — so SPF on the return-path passes. DKIM signs with `example.com` keys, so DKIM alignment for `From: admin@example.com` should pass. DMARC `p=none` means no DMARC reject.

The exact remote SMTP diagnostic is not available because SES feedback events are not wired yet. All we know from SES is that the address was suppressed for `BOUNCE`. Treat Gmail/content reputation as a possibility, not the diagnosis; hard bounces from invalid smoke-test aliases are the only confirmed reputation signal in the current evidence.

Belt-and-braces SPF fix: add `include:amazonses.com` to the `example.com` SPF record. This is not expected to be the primary fix because the custom MAIL FROM SPF already passes and DKIM should align with `example.com`, but it removes one deliverability ambiguity for stricter receivers and diagnostics tools.

---

## Why this matters beyond `admin@example.com`

This is a **platform observability gap**, not an `admin@example.com` problem:

- Any user whose address hard-bounces, or produces a complaint when account-level complaint suppression is enabled, can be placed on the suppression list **for the entire SES account**, indefinitely, with no surfacing in Eve.
- Every Eve-deployed app that opts into branded invite or magic-link login depends on this mailer. ACME Portal is the first; more will follow.
- The CLAUDE.md rule "Platform Gaps First — Never Work Around Them" applies: do not work around this in `acme-portal` or any other app.

---

## Non-Goals

- Do not replace SES with another provider. SES production access is granted, DKIM/MAIL FROM is configured, the issue is observability and a single suppressed address.
- Do not change the magic-link or invite UX semantics. The "generic success" response in `sendAppMagicLink` for ineligible addresses must remain (account-enumeration defense). What changes is the *server-side* visibility when a send is dropped post-eligibility.
- Do not introduce a new mail abstraction. Keep `MailerService` as the single send path; add behavior to it rather than forking.
- Do not change the SMTP protocol path. SES API send is mentioned as an option in this plan and rejected — SMTP via nodemailer plus a pre-send suppression check gives us the same signal with less surface change.

---

## Plan

The work splits across three lanes:

1. **Operational unblock** (today, manual) — clear `admin@example.com` from SES suppression so testing can resume.
2. **Platform (`eve-horizon-2`)** — make the mailer observable and refuse known SES suppression drops.
3. **Infra (`deployment-instance-repo`)** — wire SES bounce/complaint events into Eve, harden SPF, configure an SES configuration set with feedback enabled.

---

### Lane 1: Operational Unblock (today)

Manual, one-time, no code change. This is operational SES recipient-state cleanup, not infrastructure mutation; keep infrastructure changes in Lane 3 and apply them only through Terraform.

```bash
# Clear the user that's blocked right now.
aws sesv2 delete-suppressed-destination --email-address admin@example.com --region us-west-2

# Clear known stale smoke-test entries so future tests do not hit them again.
aws sesv2 delete-suppressed-destination --email-address 'adam+acme-smoke-1778413063@example.com' --region us-west-2

# Verify cleared.
aws sesv2 list-suppressed-destinations --region us-west-2 \
  --query "SuppressedDestinationSummaries[?contains(EmailAddress, 'example.com')]"
```

Then re-run the magic-link flow from incognito at:

```
https://sso.eve.example.com/login?project_id=proj_example&redirect_to=https%3A%2F%2Fsandbox.acme.example%2F
```

Expected: an email lands in `admin@example.com`'s inbox with subject `Sign in to ACME Portal`, From display `ACME Portal <admin@example.com>`. Open the link → land at `sandbox.acme.example` with a session.

If the bounce repeats, that's a real domain-level problem and Lane 3 (SPF + Configuration Set + bounce feedback) becomes the blocker.

---

### Lane 2: Platform Changes in `eve-horizon-2`

#### 2.1 Mailer logs success and failure structurally

**File**: `apps/api/src/mailer/mailer.service.ts`

Today the mailer has zero log statements. Change to:

```ts
private readonly logger = new Logger(MailerService.name);

async send(args: MailerSendArgs): Promise<void> {
  const fromAddr = process.env.MAILER_FROM_ADDRESS
    ?? process.env.GOTRUE_SMTP_ADMIN_EMAIL
    ?? 'noreply@eve.local';

  try {
    const info = await this.transport.sendMail({ /* ...as today... */ });
    this.logger.log({
      event: 'mailer.sent',
      to: args.to,
      subject: args.subject,
      rfc_message_id: info.messageId,
      ses_message_id: parseSesMessageId(info.response),
      smtp_response: info.response,
    });
  } catch (err) {
    this.logger.error({
      event: 'mailer.smtp_failed',
      to: args.to,
      subject: args.subject,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
```

Why: today the audit trail for a branded auth email ends at `AuthService Generated GoTrue ... link`. That's misleading — it logs the *link generation*, not the *email send*. A reader (or agent) grepping for `admin@example.com` sees what looks like success. The structured log line above closes that gap.

Important correlation detail: for SMTP sends through SES, do not assume Nodemailer's `info.messageId` is the SES event ID. Store/log both:

- `rfc_message_id`: Nodemailer's `info.messageId` / RFC `Message-ID`.
- `ses_message_id`: parsed from `info.response` when the SMTP relay is SES. This is the value SES event publishing exposes as `mail.messageId`.

Acceptance:

- Every successful invite/magic-link send produces one `mailer.sent` log entry with `to`, `subject`, `rfc_message_id`, `ses_message_id` when available, and `smtp_response`.
- Every failure produces one `mailer.smtp_failed` log entry and a 500 from the controller unless a caller intentionally preserves generic auth UX semantics as described below.

#### 2.2 Pre-send SES suppression check (when SMTP host is SES)

**Files**:
- `apps/api/src/mailer/mailer.service.ts` (extended)
- `apps/api/src/mailer/errors.ts` (new)
- `apps/api/package.json` / `pnpm-lock.yaml` (add `@aws-sdk/client-sesv2` as an API runtime dependency)

Add an SES suppression pre-flight when `GOTRUE_SMTP_HOST` matches `*.amazonaws.com`. Use `@aws-sdk/client-sesv2`'s `GetSuppressedDestinationCommand`. If the address is suppressed, do **not** call SMTP — instead log a `mailer.suppressed` warning and throw a structured `EmailSuppressedError`.

```ts
import { SESv2Client, GetSuppressedDestinationCommand } from '@aws-sdk/client-sesv2';

class EmailSuppressedError extends Error {
  constructor(public to: string, public reason: string, public lastUpdate: string) {
    super(`Recipient ${to} is on SES suppression list (reason=${reason}, since=${lastUpdate})`);
  }
}

// In MailerService:
private readonly ses?: SESv2Client = this.shouldCheckSesSuppression()
  ? new SESv2Client({ region: this.resolveSesRegion() })
  : undefined;

private async assertNotSuppressed(to: string): Promise<void> {
  if (!this.ses) return;
  const email = normalizeMailerRecipient(to);
  try {
    const res = await this.ses.send(new GetSuppressedDestinationCommand({ EmailAddress: email }));
    if (res.SuppressedDestination) {
      this.logger.warn({
        event: 'mailer.suppressed',
        to: email,
        reason: res.SuppressedDestination.Reason ?? 'UNKNOWN',
        last_update: res.SuppressedDestination.LastUpdateTime?.toISOString() ?? 'unknown',
      });
      throw new EmailSuppressedError(
        email,
        res.SuppressedDestination.Reason ?? 'UNKNOWN',
        res.SuppressedDestination.LastUpdateTime?.toISOString() ?? 'unknown',
      );
    }
  } catch (err) {
    // NotFoundException is the success case — address not suppressed.
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'NotFoundException') return;
    if (err instanceof EmailSuppressedError) throw err;
    this.logger.warn({
      event: 'mailer.suppression_check_failed',
      to: email,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

Then in `send()`:

```ts
async send(args: MailerSendArgs): Promise<void> {
  await this.assertNotSuppressed(args.to);
  // ...existing send + log path from 2.1...
}
```

How callers should handle `EmailSuppressedError`:

- **`AuthService.sendAppMagicLink`**: catch and treat as a no-op for the user-facing response (still return `{ sent: true }` to preserve enumeration defense), but log `WARN mail.suppressed_drop kind=magic_link to=...`. This is the one place we deliberately keep "generic success" semantics — the security trade-off is documented in `app-magic-link-login-opt-in-plan.md`.
- **`AuthService.createAppInvite` / `sendProjectInviteEmail`**: re-throw and surface to the inviter (admin user). It is correct for an admin who tries to invite a permanently-bounced address to see an error, not silent success.
- **`AuthController.sendSupabaseInvite`**: re-throw — system admins should always see the error.

IAM: the API pod's IRSA role needs `ses:GetSuppressedDestination` on `*`. This is added in Lane 3 (terraform).

Configuration:

- `EVE_MAILER_CHECK_SUPPRESSION` env var, default `auto` (= enabled when host matches SES). Allow explicit `true`/`false` to force the check on/off so local dev (Mailpit) skips it.
- `EVE_MAILER_SES_REGION`, default parsed from `GOTRUE_SMTP_HOST` (e.g. `email-smtp.us-west-2.amazonaws.com` → `us-west-2`).
- `EVE_SES_CONFIGURATION_SET`, optional. When set, pass `X-SES-CONFIGURATION-SET` in `transport.sendMail({ headers: ... })` so outbound SMTP traffic is attached to the SES event destination from Lane 3.

Case-sensitivity footnote: SES suppression-list management APIs require the exact address casing stored in the suppression list, while email delivery treats address case as equivalent. Normalize all Eve-generated auth-email recipients to lower-case before calling `sendMail()` so future suppression entries are queryable. The first implementation should also document that any pre-existing mixed-case suppression entries need a one-time ops audit via `list-suppressed-destinations`.

Why pre-send rather than post-send: a single API call adds ~30ms and tells us synchronously what would otherwise be a fire-and-forget drop. `@aws-sdk/client-sesv2` is not currently in `apps/api/package.json`; add it explicitly to the API package instead of relying on other AWS SDK clients or shared dev dependencies.

#### 2.3 Bounce/complaint webhook endpoint

**Files**:
- `apps/api/src/webhooks/ses-feedback.controller.ts` (new)
- `apps/api/src/webhooks/ses-feedback.service.ts` (new)
- `apps/api/src/webhooks/webhooks.module.ts` (existing, extended)
- `apps/api/src/mailer/email-delivery.service.ts` (new shared query/service layer for webhook, admin, and env diagnostics)
- `packages/db/migrations/00095_email_delivery_events.sql` (new)
- `packages/db/src/queries/email-delivery-events.ts` (new; export from `packages/db/src/queries/index.ts`)
- `packages/shared/src/schemas/environment.ts` (extend env diagnose response)

New table:

```sql
CREATE TABLE IF NOT EXISTS email_delivery_events (
  id              TEXT PRIMARY KEY,
  recipient       TEXT NOT NULL,
  ses_message_id  TEXT,                       -- SES mail.messageId; matches mailer log ses_message_id
  rfc_message_id  TEXT,                       -- original Message-ID header when present
  event_type      TEXT NOT NULL,              -- Bounce | Complaint | Delivery | Reject | Send | DeliveryDelay
  bounce_type     TEXT,                       -- Permanent | Transient (Bounce only)
  bounce_subtype  TEXT,                       -- General | NoEmail | MailboxFull | Suppressed | etc.
  diagnostic      TEXT,                       -- raw SMTP/feedback diagnostic from SES
  raw_payload     JSONB NOT NULL,             -- full SES event payload for forensics
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_delivery_events_recipient_idx ON email_delivery_events (recipient, received_at DESC);
CREATE INDEX email_delivery_events_ses_message_id_idx ON email_delivery_events (ses_message_id);
```

Use an idempotent `id` derived from the SNS `MessageId`, SES `eventType`, and recipient address, or add a unique constraint over those fields, so SNS retries do not duplicate rows. If SES sends one event with multiple affected recipients, insert one row per recipient.

Endpoint:

```
POST /webhooks/ses-feedback
```

Public, no auth — annotate the controller with `@Public()` because the global auth and permission guards apply by default. Body must verify SNS message signature against AWS's SNS signing certificate before any side effect. Prefer a small in-repo verifier based on AWS's documented SNS signature algorithm over adding an unmaintained validation package. Use the existing Fastify `req.rawBody` support in `apps/api/src/main.ts` and reject:

- non-HTTPS `SigningCertURL`
- certificates not issued for the expected SNS host/region pattern
- unexpected `TopicArn`
- unsupported `SignatureVersion`

Handle:

- `SubscriptionConfirmation` — fetch `SubscribeURL` to confirm.
- `Notification` — parse the `Message` JSON (SES feedback payload) and insert a row per event.

Acceptance: SES bounce within a few seconds of a failed send becomes a row in `email_delivery_events` with `ses_message_id` matching the mailer log's `ses_message_id`.

CLI surfacing (Phase 1 — light touch):

- Extend `apps/api/src/environments/env-diagnostics.service.ts`, `packages/shared/src/schemas/environment.ts`, and `packages/cli/src/commands/env.ts` so `eve env diagnose <project> <env>` includes the last 20 `email_delivery_events` rows for recipients that belong to a member of an org/project in scope. This makes bounces observable from the same place app developers already debug deploys.
- Extend the existing flat `packages/cli/src/commands/admin.ts` handler with `eve admin email bounces list` (system admin only). Back it with a new API route such as `GET /admin/email-bounces` implemented in a feature-owned controller, not a nonexistent central `apps/api/src/admin/admin.controller.ts`.

#### 2.4 Tests

- `apps/api/src/mailer/__tests__/mailer.suppression.spec.ts` (new, or extend existing `invite.spec.ts` if keeping mailer tests together):
  - mocks `@aws-sdk/client-sesv2`. Suppressed address → `EmailSuppressedError`, no SMTP call.
  - Unsuppressed address (NotFoundException from SDK) → SMTP transport called once.
  - Non-SES host → suppression check skipped entirely.
  - Configuration set enabled → `X-SES-CONFIGURATION-SET` header is passed to Nodemailer.
- `apps/api/src/auth/auth.service.magic-link.spec.ts` (existing): extend with a case where the mailer throws `EmailSuppressedError`. Expect `sendAppMagicLink` to return `{ sent: true }` (UX-preserving) and to log a structured warning.
- `apps/api/src/webhooks/__tests__/ses-feedback.spec.ts` (new):
  - Subscription confirmation flow.
  - Bounce notification → row in `email_delivery_events`.
  - Bad SNS signature → 401.
  - Unexpected `TopicArn` → 401.

#### 2.5 Docs

- `docs/system/auth.md` — append a "Mail delivery and SES suppression" subsection: pre-send check, bounce feedback table, ops command to clear suppression.
- `docs/system/deployment.md` — note the new env vars (`EVE_MAILER_CHECK_SUPPRESSION`, `EVE_MAILER_SES_REGION`, `EVE_SES_CONFIGURATION_SET`, `EVE_SES_FEEDBACK_TOPIC_ARN` if used for SNS topic allow-listing).
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md` — document that app branded auth emails go through SMTP + suppression check, and that platform admins can inspect bounces via `eve admin email bounces list`.

#### 2.6 File-level change list

| File | Change |
|---|---|
| `apps/api/src/mailer/mailer.service.ts` | Log success/failure; add SES suppression pre-flight |
| `apps/api/src/mailer/errors.ts` | New `EmailSuppressedError` |
| `apps/api/src/mailer/email-delivery.service.ts` | Shared query/service layer for delivery events |
| `apps/api/src/mailer/mailer.module.ts` | Register/export email delivery service and admin controller |
| `apps/api/package.json`, `pnpm-lock.yaml` | Add `@aws-sdk/client-sesv2` runtime dependency |
| `apps/api/src/auth/auth.service.ts` | Catch `EmailSuppressedError` in `sendAppMagicLink`, rethrow elsewhere |
| `apps/api/src/webhooks/ses-feedback.controller.ts` | New SNS endpoint |
| `apps/api/src/webhooks/ses-feedback.service.ts` | SNS signature verify + persist events |
| `apps/api/src/webhooks/webhooks.module.ts` | Register new controller/service; import `MailerModule` if the shared email delivery service lives there |
| `apps/api/src/environments/env-diagnostics.service.ts` | New diagnose output: recent email delivery events |
| `apps/api/src/mailer/email-delivery-admin.controller.ts` | New `GET /admin/email-bounces` route |
| `packages/cli/src/commands/admin.ts` | Add `eve admin email bounces list` command to existing admin handler |
| `packages/cli/src/commands/env.ts` | Surface recent bounce events for env members |
| `packages/db/migrations/00095_email_delivery_events.sql` | New table |
| `packages/db/src/queries/email-delivery-events.ts` | New queries, exported from `queries/index.ts` |
| `packages/shared/src/config/schema.ts` | `EVE_MAILER_CHECK_SUPPRESSION`, `EVE_MAILER_SES_REGION`, `EVE_SES_CONFIGURATION_SET`, optional `EVE_SES_FEEDBACK_TOPIC_ARN` |
| `packages/shared/src/schemas/environment.ts` | Add email-delivery diagnostics schema fields |
| `apps/api/src/mailer/__tests__/mailer.suppression.spec.ts` | New or extend existing mailer tests |
| `apps/api/src/auth/auth.service.magic-link.spec.ts` | Extend |
| `apps/api/src/webhooks/__tests__/ses-feedback.spec.ts` | New |
| `tests/manual/scenarios/42-mailer-suppression.md` | New scenario (`41-app-org-access-admin-invites.md` already exists) |
| `docs/system/auth.md` | Mail delivery subsection |
| `docs/system/deployment.md` | New env vars |
| `../eve-skillpacks/eve-work/eve-read-eve-docs/references/secrets-auth.md` | Suppression + bounces |

Regenerate OpenAPI for the new admin + webhook endpoints after the API builds.

---

### Lane 3: Infra Changes in `deployment-instance-repo`

All AWS infrastructure resources go through Terraform in `../deployment-instance/terraform/aws/`. No console mutations and no ad-hoc AWS CLI infrastructure changes. Lane 1 is limited to SES recipient-state cleanup and must not be used as a pattern for IAM, SNS, SES configuration sets, DNS, EKS, security groups, or any other infrastructure.

#### 3.1 SES configuration set with event publishing

New file: `terraform/aws/modules/ses-feedback/main.tf`

Resources:

- `aws_sesv2_configuration_set "eve_default"` — the default config set Eve API will pass on `X-SES-CONFIGURATION-SET` (set this header on outbound SMTP via a per-send mailer option). Suppression options enabled, reputation tracking on.
- `aws_sns_topic "ses_feedback"` — receives `Bounce`, `Complaint`, optionally `Delivery`.
- `aws_sesv2_configuration_set_event_destination "sns_feedback"` — bind config set → SNS topic with `MatchingEventTypes = ["BOUNCE","COMPLAINT","DELIVERY","REJECT"]`; add `SEND` only if we decide the extra event volume is worth having for correlation.
- `aws_sns_topic_subscription "eve_api"` — HTTPS subscription to `https://api.eve.example.com/webhooks/ses-feedback`. Subscription confirmation handled by Lane 2.3.
- `aws_iam_role_policy` or existing API IRSA policy update in `terraform/aws/main.tf` adding only `ses:GetSuppressedDestination` to the API pod's IRSA role (`${var.name_prefix}-api-irsa`). Do not grant `ses:DeleteSuppressedDestination` to the API unless a separate, audited "clear suppression" endpoint is explicitly added. `eve admin email bounces list` should read Eve's `email_delivery_events` table, not mutate SES.

Variables (root):

- `ses_feedback_endpoint` — the webhook URL (per-environment).
- `ses_configuration_set_name` — defaults to `eve-default`.

Outputs:

- `ses_configuration_set_name` and `ses_feedback_topic_arn` — fed back into the API deployment manifest as env vars. The topic ARN should also be used by the webhook verifier to reject spoofed SNS messages from unexpected topics.

K8s changes in the same repo:

- `k8s/overlays/aws-eks/api-deployment-patch.yaml` — add `EVE_SES_CONFIGURATION_SET=eve-default`, `EVE_SES_FEEDBACK_TOPIC_ARN=<topic arn>`, `EVE_MAILER_CHECK_SUPPRESSION=auto`, and `EVE_MAILER_SES_REGION=us-west-2` (the SES SMTP region from `GOTRUE_SMTP_HOST`, not the EKS cluster region). Eve API will pass `X-SES-CONFIGURATION-SET: eve-default` on every outbound SMTP send (header support is built into Nodemailer via `headers: { 'X-SES-CONFIGURATION-SET': ... }`).

#### 3.2 SPF hardening for `example.com`

Coordinate with the DNS owner (Adam) to update the apex `example.com` TXT SPF record:

```
v=spf1 include:_spf.google.com include:spf.protection.outlook.com include:mailgun.org include:amazonses.com ~all
```

The `include:amazonses.com` covers visible-From-domain SPF checks by stricter receivers, even though Eve already uses the custom MAIL FROM domain `ses-mail.example.com` for the return-path.

DNS is not in Terraform today (registered at name.com). Either:

- Add it to Terraform under a new `terraform/dns/example_com.tf` (preferred long-term).
- Or apply manually with a `terraform/dns/README.md` note documenting the exact zone/record values (acceptable short-term).

Validate after propagation:

```bash
dig +short TXT example.com
# must include amazonses.com
```

Also validate the final SPF lookup count stays within the SPF 10-DNS-lookup limit; the existing Google, Microsoft, Mailgun, and SES includes can otherwise create a new deliverability failure while trying to fix this one.

#### 3.3 Smoke-test domain hygiene

Stop polluting the production sender domain with throwaway recipients.

- Manual test scenarios (`tests/manual/scenarios/40-app-magic-link-login.md`, future ones) must use one of:
  - `success@simulator.amazonses.com` — SES "always delivers" mailbox.
  - `bounce@simulator.amazonses.com` — SES "always bounces" mailbox, does **not** add to suppression list.
  - `suppressionlist@simulator.amazonses.com` — SES simulates a suppressed-recipient hard bounce; useful for feedback-loop testing, but it does **not** test the pre-send account-level `GetSuppressedDestination` path.
  - A real verified test mailbox in a dedicated test domain.
- Forbid `adam+acme-smoke-*@example.com` and similar pattern recipients in any agent-driven scenario. Add a `bin/eh test` lint to grep for these patterns in scenario files and fail loudly.

#### 3.4 File-level change list (infra)

| File | Change |
|---|---|
| `terraform/aws/modules/ses-feedback/main.tf` | New module (config set, SNS topic, IAM) |
| `terraform/aws/modules/ses-feedback/outputs.tf` | Config set name, topic ARN |
| `terraform/aws/main.tf` | Wire module in, pass webhook URL var |
| `terraform/aws/variables.tf` | `ses_feedback_endpoint`, `ses_configuration_set_name` |
| `terraform/aws/main.tf` API IRSA block | Add least-privilege `ses:GetSuppressedDestination` |
| `k8s/overlays/aws-eks/api-deployment-patch.yaml` | `EVE_SES_CONFIGURATION_SET`, `EVE_SES_FEEDBACK_TOPIC_ARN`, `EVE_MAILER_CHECK_SUPPRESSION`, `EVE_MAILER_SES_REGION` |
| `terraform/dns/example_com.tf` (new, optional) | SPF record with `amazonses.com` |
| `docs/runbooks/ses-suppression.md` (new) | How to inspect/clear SES suppression entries from the CLI |
| `tests/scenario-lint/forbid-fake-recipients.sh` (new) | Grep guard for `+smoke-` / fake recipient patterns |

---

## Implementation Order

1. **Day 0 (today)** — Lane 1 manual unblock. User can resume testing immediately.
2. **Day 1** — Lane 2.1 + 2.2 (mailer logging + SES suppression pre-flight). Ship as a single small PR. This alone closes the silent-drop class bug for *future* suppressed addresses — the mailer will throw a structured error instead of looking successful. Cut a `release-v0.1.*` and deploy to staging.
3. **Day 2** — Lane 3.1 (SES configuration set + SNS topic + IRSA policy) in `deployment-instance-repo`. Apply via `terraform apply`. No code consuming the SNS feed yet.
4. **Day 3** — Lane 2.3 (bounce webhook endpoint + `email_delivery_events` table + CLI surfacing). Wire SNS subscription URL to the new endpoint. Ship in a single release.
5. **Day 4** — Lane 3.2 (SPF) and Lane 3.3 (smoke-test hygiene). DNS change behind change control.
6. **Day 5** — Verification (below). Close the feedback loop by using SES simulator recipients for bounce/SNS coverage and a deliberately seeded account-level suppressed test address for pre-flight coverage.

Each step is independently shippable. Lanes 1 + 2.1 + 2.2 close the immediate visibility gap; lanes 2.3 + 3.1 close the long-term observability loop; lanes 3.2 + 3.3 reduce future bounce volume.

---

## Verification

### Local (k3d, Mailpit)

- Suppression check is auto-disabled because `GOTRUE_SMTP_HOST` is `mailpit`. Confirm Scenario 40 (`tests/manual/scenarios/40-app-magic-link-login.md`) still passes — invite + magic-link emails arrive in Mailpit with branded subjects and the new mailer log line is present.
- Set `EVE_MAILER_CHECK_SUPPRESSION=false` is not needed; the auto path covers it. Test the explicit-false override separately.

### Staging (eve.example.com)

1. Unblock `admin@example.com` (Lane 1).
2. Send a magic-link from incognito → email arrives, mailer log line present, link works end-to-end.
3. Bounce simulation: POST a magic-link for `bounce@simulator.amazonses.com`. Expect:
   - SMTP send succeeds; mailer logs `mailer.sent` with `ses_message_id`.
   - Within ~10s, SES SNS bounce arrives at `/webhooks/ses-feedback`.
   - Row appears in `email_delivery_events` (`event_type='Bounce'`, `bounce_type='Permanent'`, `ses_message_id` matches the mailer log).
   - `bounce@simulator.amazonses.com` is **not** added to the account-level suppression list; AWS documents this simulator behavior.
4. Suppression-event simulation: POST a magic-link for `suppressionlist@simulator.amazonses.com`. Expect a bounce event with a suppressed-recipient subtype in `email_delivery_events`. This validates SNS feedback for suppressed-recipient events, but not Eve's pre-send account-level lookup.
5. Pre-flight suppression test: with operator credentials, add a dedicated lower-case test address to the SES account-level suppression list using `aws sesv2 put-suppressed-destination --email-address <dedicated-test-address> --reason BOUNCE --region us-west-2`. Then POST a magic-link for that address:
   - Mailer pre-flight detects suppression.
   - Controller returns `{ sent: true }` (UX preserved).
   - API logs `WARN mail.suppressed_drop kind=magic_link to=<dedicated-test-address> reason=BOUNCE since=...`.
   - No new mailer SMTP attempt is made.
6. Clear the dedicated test address with `aws sesv2 delete-suppressed-destination --email-address <dedicated-test-address> --region us-west-2`. Repeat step 5 → email is sent again, normal log line.
7. Send an invite from `eve admin invite --web` (system-admin path, backed by `POST /auth/supabase/invite`) to the suppressed dedicated test address before clearing it. Expect a 5xx response with `EmailSuppressedError` propagated, not silent success.

### Manual scenario

Add `tests/manual/scenarios/42-mailer-suppression.md` covering steps 3–7 above against staging (k3d cannot exercise SES, so this scenario is staging-only and gated on staging owner).

---

## Acceptance

- No reproducer for "magic-link API returns `{sent:true}` while SES account-level suppression prevents delivery" without a corresponding `mail.suppressed_drop` warning log.
- Every successful auth email send produces one `mailer.sent` log entry with `ses_message_id` when sent through SES SMTP.
- Every bounce produces one row in `email_delivery_events` within 30 seconds of the SES feedback event.
- `eve env diagnose <project> <env>` surfaces recent bounce events for env members.
- `eve admin email bounces list` works for system admins.
- `tests/manual/scenarios/42-mailer-suppression.md` passes against staging.
- Scenario 40 still passes against local k3d unchanged.
- `example.com` SPF resolves with `include:amazonses.com`.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `GetSuppressedDestination` IRSA permission denied → pre-flight fails open | Pre-flight catches non-`NotFoundException` errors as warnings, not blockers, so mailer still attempts SMTP. This preserves delivery while making the IRSA/config problem visible. |
| Existing mixed-case suppression entries are missed by exact-case SES API lookup | Normalize Eve-generated recipient addresses to lower-case before sending and run a one-time ops audit with `list-suppressed-destinations` for historical entries. |
| SNS subscription confirmation lost on API redeploy | The endpoint confirms idempotently after signature and topic validation. If confirmation is missed, re-apply the Terraform subscription or request a new confirmation from SNS. |
| Adding `include:amazonses.com` to SPF before clearing reputation issues just keeps emails landing in spam | SPF hardening is one input among many. Lane 1 + 2 ship visibility first, so we'll know within a single test cycle if reputation is still the dominant factor. |
| Future apps want to use a domain other than `example.com` | Out of scope. Eve's mailer accepts the From address from `MAILER_FROM_ADDRESS` env var; per-app from-domains are a follow-on, not part of this fix. |
| SES SDK adds startup cost | Use only `@aws-sdk/client-sesv2` in `apps/api`; lazy-init at first `send()` call; do not import it from `@eve/shared` or add it to shared barrel exports. |
| The pre-send check leaks recipient-existence info (an attacker could probe suppression) | The mailer is only called by trusted server code paths after eligibility passes. The pre-flight is not exposed via any user-facing endpoint. |
| SES suppression entries we want to keep (true permanent bounces) get cleared by clean-up code | The mailer never calls `DeleteSuppressedDestination`. Clearing is ops-only via `aws sesv2 delete-suppressed-destination` documented in `docs/runbooks/ses-suppression.md`. |

---

## Open Decisions

1. Should `sendAppMagicLink` log `WARN mail.suppressed_drop` *or* additionally surface a server-side metric the platform team can alert on? Recommendation: both — log line for traceability, counter metric for alerting. Define the metric in a follow-up if Eve doesn't already have a metrics surface for the mailer.
2. Should we extend the suppression pre-check to *all* outbound app email (Eve Horizon's own notifications endpoint, `notifications:send`), or only to auth emails? Recommendation: all. Same `MailerService.send`, same logic.
3. Should `eve env diagnose` show bounces only for org members, or for any recipient any service in the env has emailed? Recommendation: org/project members only, to keep the output scoped and avoid surfacing unrelated cross-tenant bounces.
4. Should bounce events on a recipient automatically pause future Eve-side sends to that address (independent of SES suppression)? Recommendation: not in this PR. Let SES be the source of truth and only revisit if we ever migrate off SES.
5. Should the `MAILER_FROM_ADDRESS` change away from `admin@example.com` to reduce spam-classification risk? Recommendation: as a follow-up. Keep the change to *one* lever per PR; once Lane 3.2 SPF lands we can measure whether From-address still matters.
