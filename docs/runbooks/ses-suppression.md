# Runbook: SES Account-Level Suppression

> **When to use**: A user reports a missing branded auth email (invite or magic-link login) from an Eve-deployed app, and the API logs show `mail.suppressed_drop` or `mailer.suppressed` for their address. Or you need to audit / clean up the account-wide SES suppression list.
>
> **Scope**: Operational SES recipient-state. Not infrastructure. Infrastructure changes (SNS topic, IAM, configuration set, IRSA) live in the deployment instance repo's Terraform.
>
> **Related**: [docs/system/auth.md → Mail Delivery and SES Suppression](../system/auth.md#mail-delivery-and-ses-suppression), [docs/plans/magic-link-email-silent-drop-plan.md](../plans/magic-link-email-silent-drop-plan.md), [AWS SES suppression docs](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html).

## Background

Amazon SES maintains an **account-wide** suppression list. While an address is on the list:

- Every SES send to it from this AWS account is silently dropped after the SMTP `250 Ok`.
- `nodemailer` sees no error.
- Without Eve's pre-send check, the API would log "link generated" and return success to the SSO UI while no email ever arrives.

Eve's mailer now checks this list before every SMTP send when `GOTRUE_SMTP_HOST` is `*.amazonaws.com`. If the address is suppressed:

- The mailer throws `EmailSuppressedError`.
- Magic-link path swallows it (UX-preserving) and logs `mail.suppressed_drop`.
- Invite paths re-throw so admins see the failure.

This runbook is for clearing the entry once the underlying cause is understood and resolved.

## Quick Reference

```bash
# Default region for staging SES is us-west-2. Adjust as needed.
export SES_REGION=us-west-2

# 1. Audit: list all suppressed addresses on the account
aws sesv2 list-suppressed-destinations --region "$SES_REGION"

# 2. Filter by domain
aws sesv2 list-suppressed-destinations --region "$SES_REGION" \
  --query "SuppressedDestinationSummaries[?contains(EmailAddress, 'example.com')]"

# 3. Inspect a single entry (reason, last update, originating SES message ID)
aws sesv2 get-suppressed-destination \
  --email-address user@example.com \
  --region "$SES_REGION"

# 4. Clear a single entry
aws sesv2 delete-suppressed-destination \
  --email-address user@example.com \
  --region "$SES_REGION"

# 5. (Test-only) seed an entry to exercise the pre-flight check
aws sesv2 put-suppressed-destination \
  --email-address pre-flight-test@example.com \
  --reason BOUNCE \
  --region "$SES_REGION"
```

## Diagnosis

```bash
# Did Eve see the suppression?
kubectl -n eve logs deployment/eve-api --tail=500 | grep -E 'mailer\.suppressed|mail\.suppressed_drop'

# Cross-reference recent bounces stored from SES feedback
eve admin email bounces list --recipient user@example.com --limit 50
# Or scoped to an env's org members:
eve env diagnose <project> <env>     # check "Recent Email Delivery Events (org members)"

# Direct AWS view
aws sesv2 get-suppressed-destination --email-address user@example.com --region "$SES_REGION"
```

What you're trying to determine:

| Signal | Interpretation |
| --- | --- |
| `mail.suppressed_drop` log entry for the address | Eve correctly detected SES suppression at pre-send. No email was attempted. |
| `mailer.sent` log entry but no row in `email_delivery_events` | SES accepted the SMTP message and either delivered it or hasn't reported back yet. Not a suppression problem — chase mailbox / spam / DNS. |
| `event_type=Bounce`, `bounce_type=Permanent` row in `email_delivery_events` | SES added the address to suppression (assuming account-level complaint/bounce suppression is enabled). Future sends to this address will be dropped until cleared. |
| `event_type=Bounce`, `bounce_type=Transient` | Temporary failure (mailbox full, greylisting). Not a suppression entry. Do not clear anything; let SES retry. |
| `event_type=Complaint` | Recipient marked Eve mail as spam. Investigate before clearing — clearing without fixing reputation just re-suppresses on the next send. |

## When (Not) to Clear

| Situation | Action |
| --- | --- |
| Confirmed typo or now-fixed address (e.g. user has a new mailbox) | Clear. |
| Test alias that should never have existed (`user+smoke-...@example.com`) | Clear. Then also update the test scenario to use SES simulator addresses (`success@simulator.amazonses.com`, etc.) so this doesn't repeat. |
| Real user whose mailbox bounced once but is now valid | Clear after confirming with the user. |
| Real user with a `Complaint` (spam button) entry | **Do not** auto-clear. Investigate why they complained. Re-suppressing on the next send hurts the account's reputation further. |
| Repeated permanent bounce on the same address | **Do not** clear. The address is genuinely undeliverable. |
| Sub-domain bounces in bulk | Pause sends, investigate domain-level deliverability (DMARC/DKIM/SPF), only then consider clearing. |

## Verification After Clearing

```bash
# 1. Confirm it's gone from SES
aws sesv2 get-suppressed-destination --email-address user@example.com --region "$SES_REGION"
# Expected: NotFoundException

# 2. Trigger the original auth flow (e.g. visit the SSO magic-link page for the user's project)
#    or, for an invite, re-send via the app admin UI / `eve admin invite --web`.

# 3. Check API logs for the new send
kubectl -n eve logs deployment/eve-api --tail=200 | grep -E 'mailer\.sent.*user@example\.com'
# Expected: one mailer.sent line with rfc_message_id and ses_message_id.

# 4. Within ~30s of a real delivery, SES → SNS persists a Delivery event
eve admin email bounces list --recipient user@example.com --limit 5
```

## Common Patterns

### "I cleared the entry but the user still didn't get the email"

Look for these in order:

1. New row in `email_delivery_events` with `event_type=Bounce` → the underlying deliverability problem is still there; clearing only un-suppresses, it doesn't fix DNS/reputation.
2. `mailer.suppression_check_failed` warnings → SES SDK is misconfigured (likely IRSA). The mailer fails open in this state, so the send did go to SMTP — check the user's spam folder and SES `Delivery` event.
3. No `mailer.sent` for the recipient → the email was never attempted. Re-check the trigger path (which controller, which user input).

### "I want to bulk-clear a domain"

```bash
aws sesv2 list-suppressed-destinations --region "$SES_REGION" \
  --query "SuppressedDestinationSummaries[?contains(EmailAddress, 'example.com')].EmailAddress" \
  --output text | tr '\t' '\n' | while read addr; do
    aws sesv2 delete-suppressed-destination --email-address "$addr" --region "$SES_REGION"
  done
```

Use sparingly. Each clear is a discrete deliverability decision.

### "The mailer keeps logging `mailer.suppression_check_failed`"

The SES SDK call failed for a non-`NotFoundException` reason. Most likely:

- API pod's IRSA role is missing `ses:GetSuppressedDestination` → fix the deployment instance Terraform, run `terraform apply`, recycle the API deployment.
- Wrong `EVE_MAILER_SES_REGION` → confirm it matches the region of `GOTRUE_SMTP_HOST`.
- Network egress blocked → confirm the pod can reach SES API endpoints.

The mailer keeps delivering email while this is broken; the warning is the only signal. Fix promptly.

## Cross-References

- [docs/system/auth.md](../system/auth.md#mail-delivery-and-ses-suppression) — full description of the mailer, log events, and feedback table.
- [docs/system/deployment.md](../system/deployment.md#runtime-environment-variables-key) — env vars (`EVE_MAILER_CHECK_SUPPRESSION`, `EVE_MAILER_SES_REGION`, `EVE_SES_CONFIGURATION_SET`, `EVE_SES_FEEDBACK_TOPIC_ARN`).
- [docs/plans/magic-link-email-silent-drop-plan.md](../plans/magic-link-email-silent-drop-plan.md) — fix plan, including the SES simulator addresses for non-destructive bounce testing.
- AWS docs: [Account-level suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html), [SES mailbox simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html#send-email-simulator).
