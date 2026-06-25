# Scenario 41: App Org Access And Admin Invites

**Time:** ~25-35 minutes
**Parallel Safe:** No (deploys shared test app/environment)
**LLM Required:** No
**Browser Required:** Yes for final invite click-through

Validates app org allowlists and in-app admin invites against local k3d using
the existing starter app, local SSO, and Mailpit. This scenario extends
Scenarios 39 and 40: the app is owned by one project org, is explicitly allowed
for a customer org, and an admin in that customer org invites a new regular
member into the app through `POST /auth/app-invites`.

## Prerequisites

- Local k3d stack ownership (`./bin/eh status` shows `K8s Owner: true`)
- Scenario 21 web-auth prerequisites pass
- Starter repo available at `../eve-horizon-starter` or `STARTER_DIR`
- `jq`, `curl`, and repo-local CLI build available

## Setup

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
curl -fsS -o /dev/null http://mail.eve.lvh.me/
```

**Expected:**
- k3d is deployed with API, GoTrue, SSO, and Mailpit reachable
- CLI is authenticated against the local profile

## Phase 1: Deploy Existing Starter App

```bash
export PROJECT_OWNER_ORG_ID=org_appaccessownerverify
export CUSTOMER_ORG_ID=org_appaccesscustomerverify

eve org ensure "$PROJECT_OWNER_ORG_ID" --name "app-access-owner-verify" --slug aaov --json
eve org ensure "$CUSTOMER_ORG_ID" --name "app-access-customer-verify" --slug aacv --json

export STARTER_DIR=${STARTER_DIR:-../eve-horizon-starter}
export REPO_DIR=$(mktemp -d)/repo
cp -R "$STARTER_DIR" "$REPO_DIR"

PROJECT_JSON=$(eve project ensure \
  --org "$PROJECT_OWNER_ORG_ID" \
  --name "app-access-starter" \
  --slug aastart \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter \
  --branch main \
  --force \
  --json)
export PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.id // .data.id')

eve secrets set POSTGRES_PASSWORD eve --project "$PROJECT_ID" --json
eve env create sandbox --type persistent --project "$PROJECT_ID" --json || true
eve env deploy sandbox --ref main --repo-dir "$REPO_DIR" --project "$PROJECT_ID"

curl -fsS "http://api.aaov-aastart-sandbox.lvh.me/health" | jq .
```

**Expected:**
- Starter app deploy completes
- App health endpoint is reachable through local ingress

## Phase 2: Sync Branding, Magic Link, Org Allowlist, And Invite Policy

```bash
perl -0pi -e 's/^x-eve:\n/x-eve:\n  branding:\n    app_name: "ACME Portal"\n    app_logo_url: "https:\/\/sandbox.acme.example\/assets\/logo.svg"\n    primary_color: "#1f6feb"\n    email_from_name: "ACME Portal"\n    reply_to_email: "support\@acme.example"\n    support_email: "support\@acme.example"\n    support_url: "https:\/\/acme.example\/help"\n  auth:\n    login_method: magic_link\n    self_signup: false\n    invite_requires_password: false\n    org_access:\n      mode: allowlist\n      allowed_orgs:\n        - org_appaccesscustomerverify\n      invite:\n        enabled: true\n        admin_roles: [admin, owner]\n        invited_role: member\n/m' "$REPO_DIR/.eve/manifest.yaml"
rg -n "branding|auth|org_access|allowed_orgs|invite|ACME Portal|magic_link" "$REPO_DIR/.eve/manifest.yaml"

eve project sync --project "$PROJECT_ID" --dir "$REPO_DIR" --json
curl -fsS "$EVE_API_URL/auth/app-context?project_id=$PROJECT_ID" \
  | tee /tmp/app-org-access-context.json \
  | jq .

jq -e '.auth.org_access.mode == "allowlist"' /tmp/app-org-access-context.json
jq -e '.auth.org_access.multi_org == true' /tmp/app-org-access-context.json
jq -e '.auth.org_access.invite_enabled == true' /tmp/app-org-access-context.json
jq -e '.auth.login_method == "magic_link"' /tmp/app-org-access-context.json
```

**Expected:**
- Manifest sync succeeds
- Public app context exposes only a safe org-access summary
- Raw `allowed_orgs` are not present in public app context

## Phase 3: Current User Can Enter And Invite For The Allowed Customer Org

```bash
TOKEN=$(node packages/cli/bin/eve.js auth token)

curl -fsS "$EVE_API_URL/auth/app-access?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  | tee /tmp/app-org-access.json \
  | jq .

jq -e --arg org "$CUSTOMER_ORG_ID" '.orgs[] | select(.id == $org and .capabilities.enter_app == true)' /tmp/app-org-access.json
jq -e --arg org "$CUSTOMER_ORG_ID" '.admin_orgs[] | select(.id == $org)' /tmp/app-org-access.json
jq -e --arg owner "$PROJECT_OWNER_ORG_ID" '[.orgs[] | select(.id == $owner)] | length == 0' /tmp/app-org-access.json
```

**Expected:**
- Response includes the customer org because the current user owns/admins it
- Response does not include the project owner org unless it is also in the allowlist
- `admin_orgs` includes the customer org and marks invite capability

## Phase 4: In-App Admin Invite Sends Project-Branded Email

```bash
APP_INVITE_EMAIL="app-org-invite-$(date +%s)@eve.local"

curl -fsS -X POST "$EVE_API_URL/auth/app-invites" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"org_id\":\"$CUSTOMER_ORG_ID\",\"email\":\"$APP_INVITE_EMAIL\",\"redirect_to\":\"http://api.aaov-aastart-sandbox.lvh.me/health\"}" \
  | tee /tmp/app-org-invite-response.json \
  | jq .

jq -e '.status == "invited"' /tmp/app-org-invite-response.json
jq -e --arg org "$CUSTOMER_ORG_ID" '.org_id == $org' /tmp/app-org-invite-response.json
jq -e '.role == "member"' /tmp/app-org-invite-response.json

sleep 1
APP_INVITE_MESSAGE_ID=$(curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq -r --arg email "$APP_INVITE_EMAIL" '
    .messages[]
    | select((.To[]?.Address // "") == $email)
    | select(.Subject | contains("ACME Portal"))
    | .ID
  ' | head -1)

test -n "$APP_INVITE_MESSAGE_ID"
curl -s "http://mail.eve.lvh.me/api/v1/message/$APP_INVITE_MESSAGE_ID" \
  | tee /tmp/app-org-invite-mail.json

jq -e '.From.Name == "ACME Portal"' /tmp/app-org-invite-mail.json
jq -e '.Subject | contains("ACME Portal")' /tmp/app-org-invite-mail.json
jq -e '(.HTML // "") | contains("https://sandbox.acme.example/assets/logo.svg")' /tmp/app-org-invite-mail.json
jq -e '(.HTML // "") | contains("#1f6feb")' /tmp/app-org-invite-mail.json
jq -e '(.Text // "") | contains("Accept invite:")' /tmp/app-org-invite-mail.json
```

**Expected:**
- App invite endpoint returns `status: "invited"` and role `member`
- Mailpit captures a project-branded invite email
- The email uses the same app branding as the magic-link flow

## Phase 5: Duplicate Invite Is Pending, Resend Is Explicit

```bash
curl -fsS -X POST "$EVE_API_URL/auth/app-invites" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"org_id\":\"$CUSTOMER_ORG_ID\",\"email\":\"$APP_INVITE_EMAIL\",\"redirect_to\":\"http://api.aaov-aastart-sandbox.lvh.me/health\"}" \
  | tee /tmp/app-org-invite-pending.json \
  | jq .

jq -e '.status == "pending"' /tmp/app-org-invite-pending.json
jq -e '.role == "member"' /tmp/app-org-invite-pending.json
```

**Expected:**
- Duplicate invite returns `pending`
- No elevated role can be requested or returned

## Phase 6: Unlisted Org Is Rejected

```bash
export UNLISTED_ORG_ID=org_appaccessunlistedverify
eve org ensure "$UNLISTED_ORG_ID" --name "app-access-unlisted-verify" --slug aauv --json

UNLISTED_STATUS=$(curl -s -o /tmp/app-org-unlisted-response.json -w "%{http_code}" \
  -X POST "$EVE_API_URL/auth/app-invites" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"org_id\":\"$UNLISTED_ORG_ID\",\"email\":\"blocked-$(date +%s)@eve.local\"}")

test "$UNLISTED_STATUS" = "403"
cat /tmp/app-org-unlisted-response.json | jq .
```

**Expected:**
- User cannot invite into an org that is not allowed by `x-eve.auth.org_access`

## Phase 7: Invite Click-Through Carries Target Org

```bash
ACTION_LINK=$(jq -r '
  (.Text // "")
  | capture("Accept invite: (?<url>https?://[^[:space:]]+)").url
' /tmp/app-org-invite-mail.json)

test -n "$ACTION_LINK"
./bin/eh browser open "$ACTION_LINK"
```

**Expected:**
- Browser completes GoTrue to SSO callback handling
- Browser does not land on `/set-password` because `invite_requires_password: false`
- Final redirect is the app URL and includes `eve_org_id=org_appaccesscustomerverify`
- After reloading the app, `@eve-horizon/auth-react` initializes active org from `eve_org_id`

## Phase 8: Magic Link Uses Same Policy And Branding

Submit `$APP_INVITE_EMAIL` from the app SSO magic-link page:

```bash
MAGIC_LOGIN_URL="http://sso.eve.lvh.me/login?project_id=$PROJECT_ID&redirect_to=http%3A%2F%2Fapi.aaov-aastart-sandbox.lvh.me%2Fhealth"
./bin/eh browser open "$MAGIC_LOGIN_URL"
```

Then assert Mailpit:

```bash
sleep 1
MAGIC_MESSAGE_ID=$(curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq -r --arg email "$APP_INVITE_EMAIL" '
    .messages[]
    | select((.To[]?.Address // "") == $email)
    | select(.Subject == "Sign in to ACME Portal")
    | .ID
  ' | head -1)

test -n "$MAGIC_MESSAGE_ID"
curl -s "http://mail.eve.lvh.me/api/v1/message/$MAGIC_MESSAGE_ID" \
  | tee /tmp/app-org-magic-link-mail.json

jq -e '.From.Name == "ACME Portal"' /tmp/app-org-magic-link-mail.json
jq -e '.Subject == "Sign in to ACME Portal"' /tmp/app-org-magic-link-mail.json
jq -e '(.HTML // "") | contains("https://sandbox.acme.example/assets/logo.svg")' /tmp/app-org-magic-link-mail.json
jq -e '(.HTML // "") | contains("#1f6feb")' /tmp/app-org-magic-link-mail.json
```

**Expected:**
- Existing user in the allowed customer org receives a project-branded magic-link email
- Branding matches the invite email; only the copy differs

## Success Criteria

- k3d stack deployed with API SMTP pointed at Mailpit
- Existing starter app deploys as `aaov-aastart-sandbox`
- Manifest `x-eve.auth.org_access` syncs and resolves the customer org allowlist
- Public app context does not expose raw `allowed_orgs`
- `GET /auth/app-access` returns only app-allowed user orgs
- Allowed org admin/owner can create an app invite
- App invite email is captured by Mailpit with project branding
- Duplicate app invite returns `pending`
- Unlisted org invite attempt returns `403`
- Invite click-through carries `eve_org_id` and skips password setup
- Magic-link email uses the same app branding and allowlist policy

## Debugging

| Symptom | Diagnostic | Fix |
|---|---|---|
| App access empty | `curl "$EVE_API_URL/auth/app-context?project_id=$PROJECT_ID"` and inspect stored auth config | Re-run `eve project sync`; verify `allowed_orgs` resolves to the customer org ID |
| App invite returns 403 | Inspect `/tmp/app-org-access.json` | Ensure caller is `admin` or `owner` in the target org and invite policy is enabled |
| No Mailpit message | `eve system logs api --tail 100` | Check API SMTP env and GoTrue admin credentials |
| Invite redirects without `eve_org_id` | Inspect `/auth/exchange` response and SSO logs | Verify invite `app_context.org_id` was stored and returned during exchange |
| Magic email missing after invite | Refresh token/session and retry SSO | The user must complete invite acceptance so Eve creates org membership |

## Cleanup

```bash
eve env delete sandbox --project "$PROJECT_ID" --force || true
rm -rf "$REPO_DIR"
```
