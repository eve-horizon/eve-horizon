# Scenario 40: App Magic-Link Login Opt-In

**Time:** ~20-30 minutes
**Parallel Safe:** No (deploys shared test app/environment)
**LLM Required:** No
**Browser Required:** Yes

Validates app-scoped passwordless login against local k3d: manifest `x-eve.auth`, app-branded SSO, invite acceptance without `/set-password`, branded magic-link email through Mailpit, and no-self-signup behavior.

## Prerequisites

- Local k3d stack ownership (`./bin/eh status` shows `K8s Owner: true`)
- Scenario 21 web-auth prerequisites pass
- Scenario 39 app-branded invite path is available
- Starter repo available at `../eve-horizon-starter` or `STARTER_DIR`

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
- k3d is deployed
- API, GoTrue, SSO, and Mailpit are reachable

## Phase 1: Deploy Existing Starter App

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

curl -fsS "http://api.mlv-mlstrt-sandbox.lvh.me/health" | jq .
```

**Expected:**
- Starter app deploy completes
- App health endpoint is reachable through local ingress

## Phase 2: Sync Branding And Passwordless Auth Policy

```bash
perl -0pi -e 's/^x-eve:\n/x-eve:\n  branding:\n    app_name: "ACME Portal"\n    app_logo_url: "https:\/\/sandbox.acme.example\/assets\/logo.svg"\n    primary_color: "#1f6feb"\n    email_from_name: "ACME Portal"\n    reply_to_email: "support\@acme.example"\n    support_email: "support\@acme.example"\n    support_url: "https:\/\/acme.example\/help"\n  auth:\n    login_method: magic_link\n    self_signup: false\n    invite_requires_password: false\n/m' "$REPO_DIR/.eve/manifest.yaml"
rg -n "branding|auth|ACME Portal|magic_link|invite_requires_password" "$REPO_DIR/.eve/manifest.yaml"

eve project sync --project "$PROJECT_ID" --dir "$REPO_DIR" --json
curl -fsS "$EVE_API_URL/auth/app-context?project_id=$PROJECT_ID" | tee /tmp/magic-link-app-context.json | jq .
```

**Expected:**
- Manifest sync succeeds
- App context returns `branding.app_name == "ACME Portal"`
- App context returns `auth.login_method == "magic_link"` and `auth.invite_requires_password == false`

## Phase 3: Invite Acceptance Skips Password Setup

```bash
INVITE_EMAIL="magic-invite-$(date +%s)@eve.local"
node packages/cli/bin/eve.js org invite "$INVITE_EMAIL" \
  --org "$ORG_ID" \
  --project "$PROJECT_ID" \
  --redirect-to "http://api.mlv-mlstrt-sandbox.lvh.me/health" \
  --json \
  | tee /tmp/magic-link-invite-response.json

jq -e --arg email "$INVITE_EMAIL" '.identity_hint == $email' /tmp/magic-link-invite-response.json
jq -e --arg project "$PROJECT_ID" '.app_context.project_id == $project' /tmp/magic-link-invite-response.json

sleep 1
INVITE_MESSAGE_ID=$(curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq -r --arg email "$INVITE_EMAIL" '
    .messages[]
    | select((.To[]?.Address // "") == $email)
    | select(.Subject | contains("ACME Portal"))
    | .ID
  ' | head -1)

test -n "$INVITE_MESSAGE_ID"
curl -s "http://mail.eve.lvh.me/api/v1/message/$INVITE_MESSAGE_ID" \
  | tee /tmp/magic-link-invite-mail.json

jq -e '.From.Name == "ACME Portal"' /tmp/magic-link-invite-mail.json
jq -e '.Subject | contains("ACME Portal")' /tmp/magic-link-invite-mail.json
jq -e '(.HTML // "") | contains("https://sandbox.acme.example/assets/logo.svg")' /tmp/magic-link-invite-mail.json
jq -e '(.HTML // "") | contains("#1f6feb")' /tmp/magic-link-invite-mail.json
```

Open the invite action link in a browser session:

```bash
ACTION_LINK=$(jq -r '
  (.Text // "")
  | capture("Accept invite: (?<url>https?://[^[:space:]]+)").url
' /tmp/magic-link-invite-mail.json)

test -n "$ACTION_LINK"
./bin/eh browser open "$ACTION_LINK"
```

**Expected:**
- Browser completes GoTrue to SSO callback handling
- Browser never lands on `/set-password`
- Final URL is `http://api.mlv-mlstrt-sandbox.lvh.me/health` or the app redirect

## Phase 4: App-Scoped Magic-Link Login

Use a fresh browser context or clear the browser session, then open:

```bash
MAGIC_LOGIN_URL="http://sso.eve.lvh.me/login?project_id=$PROJECT_ID&redirect_to=http%3A%2F%2Fapi.mlv-mlstrt-sandbox.lvh.me%2Fhealth"
./bin/eh browser open "$MAGIC_LOGIN_URL"
```

**Expected UI:**
- Page is branded as `ACME Portal`
- No password field is visible
- No sign-up tab is visible
- The primary action sends a sign-in link

Submit `$INVITE_EMAIL` in the browser. Then assert Mailpit:

```bash
sleep 1
MAGIC_MESSAGE_ID=$(curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq -r --arg email "$INVITE_EMAIL" '
    .messages[]
    | select((.To[]?.Address // "") == $email)
    | select(.Subject == "Sign in to ACME Portal")
    | .ID
  ' | head -1)

test -n "$MAGIC_MESSAGE_ID"
curl -s "http://mail.eve.lvh.me/api/v1/message/$MAGIC_MESSAGE_ID" \
  | tee /tmp/magic-link-login-mail.json

jq -e '.From.Name == "ACME Portal"' /tmp/magic-link-login-mail.json
jq -e '.Subject == "Sign in to ACME Portal"' /tmp/magic-link-login-mail.json
jq -e '(.HTML // "") | contains("https://sandbox.acme.example/assets/logo.svg")' /tmp/magic-link-login-mail.json
jq -e '(.HTML // "") | contains("#1f6feb")' /tmp/magic-link-login-mail.json
jq -e '(.Text // "") | contains("Sign in:")' /tmp/magic-link-login-mail.json
```

Open the magic-link action URL:

```bash
MAGIC_ACTION_LINK=$(jq -r '
  (.Text // "")
  | capture("Sign in: (?<url>https?://[^[:space:]]+)").url
' /tmp/magic-link-login-mail.json)

test -n "$MAGIC_ACTION_LINK"
./bin/eh browser open "$MAGIC_ACTION_LINK"
```

**Expected:**
- Final URL is `http://api.mlv-mlstrt-sandbox.lvh.me/health` or the app redirect
- Browser does not visit `/set-password`

## Phase 5: No Self Signup

```bash
UNKNOWN_EMAIL="unknown-$(date +%s)@eve.local"

curl -fsS -X POST http://sso.eve.lvh.me/auth/magiclink \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$UNKNOWN_EMAIL\",\"project_id\":\"$PROJECT_ID\",\"redirect_to\":\"http://api.mlv-mlstrt-sandbox.lvh.me/health\"}" \
  | tee /tmp/unknown-magic-link-response.json

jq -e '.sent == true' /tmp/unknown-magic-link-response.json

sleep 1
curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq -e --arg email "$UNKNOWN_EMAIL" '
    [.messages[] | select((.To[]?.Address // "") == $email)] | length == 0
  '
```

**Expected:**
- SSO/API returns generic success
- Mailpit has no message to `$UNKNOWN_EMAIL`
- API logs do not show a GoTrue `generate_link` call for `$UNKNOWN_EMAIL`

## Phase 6: Default App Regression

Remove the `auth:` block or use Scenario 39's no-auth project, then sync:

```bash
perl -0pi -e 's/\n  auth:\n    login_method: magic_link\n    self_signup: false\n    invite_requires_password: false\n//' "$REPO_DIR/.eve/manifest.yaml"
eve project sync --project "$PROJECT_ID" --dir "$REPO_DIR" --json
curl -fsS "$EVE_API_URL/auth/app-context?project_id=$PROJECT_ID" | jq '.auth == null'
```

**Expected:**
- `/login?project_id=...` preserves the default password plus magic-link page
- Invite acceptance routes through `/set-password`
- Scenario 39 remains green

## Success Criteria

- `x-eve.auth` is synced and visible through app context
- SSO login page is project-branded and magic-link-only
- Invite email remains project-branded
- Invite acceptance skips `/set-password` only for `invite_requires_password: false`
- Magic-link email is project-branded and uses `Sign in to ACME Portal`
- Unknown email receives generic success with no Mailpit message
- Default app behavior remains unchanged when `x-eve.auth` is removed

## Debugging

| Symptom | Diagnostic | Fix |
|---|---|---|
| SSO page is not branded | `curl "$EVE_API_URL/auth/app-context?project_id=$PROJECT_ID"` | Re-run `eve project sync`; verify `x-eve.branding` and `x-eve.auth` |
| Password field still appears | Check `.auth.login_method` in app context | Ensure `login_method: magic_link` is under top-level `x-eve.auth` |
| Magic email missing for invited user | `eve system logs api --tail 100` | Confirm invite was accepted and user has org/project access |
| Unknown email receives an email | API logs and Mailpit detail | Check `self_signup: false` in stored app context |
| Browser stays on SSO root | Use `./bin/eh browser` or Playwright, not curl | GoTrue tokens are in URL hash fragments and require browser-side forwarding |

## Cleanup

```bash
eve env delete sandbox --project "$PROJECT_ID" --force || true
rm -rf "$REPO_DIR"
```
