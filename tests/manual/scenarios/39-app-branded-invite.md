# Scenario 39: App-Branded Invite Email

**Time:** ~15-25 minutes
**Parallel Safe:** No (deploys shared test app/environment)
**LLM Required:** No

Validates Phase 1 app-branded invite emails end to end against local k3d: manifest branding sync, org invite API/CLI, Mailpit capture, and the existing GoTrue to SSO invite click-through.

## Prerequisites

- Local k3d stack ownership (`./bin/eh status` shows `K8s Owner: true`)
- Scenario 21 web-auth prerequisites pass
- Starter repo available at `../eve-horizon-starter` or `STARTER_DIR`
- If the deploy flow needs a GitHub token, set `GITHUB_TOKEN` as in Scenario 05

## Setup

```bash
./bin/eh status
./bin/eh k8s start
./bin/eh k8s deploy

export EVE_API_URL=http://api.eve.lvh.me
eve profile use local
eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
pnpm -C packages/cli build

curl -fsS http://auth.eve.lvh.me/health | jq .
curl -fsS -o /dev/null http://mail.eve.lvh.me/
curl -fsS http://sso.eve.lvh.me/health | jq .
curl -fsS "$EVE_API_URL/auth/config" | jq .
```

**Expected:**
- k3d is deployed
- GoTrue, Mailpit, SSO, and API auth config are reachable

## Phase 1: Deploy Existing Starter App

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

**Expected:**
- Existing starter app deploy completes from a clean repo ref
- API app is reachable through local ingress

## Phase 2: Sync Branding Metadata

```bash
perl -0pi -e 's/^x-eve:\n/x-eve:\n  branding:\n    app_name: "ACME Portal"\n    app_logo_url: "https:\/\/sandbox.acme.example\/assets\/logo.svg"\n    primary_color: "#1f6feb"\n    email_from_name: "ACME Portal"\n    reply_to_email: "support\@acme.example"\n    support_email: "support\@acme.example"\n    support_url: "https:\/\/acme.example\/help"\n/m' "$REPO_DIR/.eve/manifest.yaml"
rg -n "branding|ACME Portal|primary_color" "$REPO_DIR/.eve/manifest.yaml"

eve project sync --project "$PROJECT_ID" --dir "$REPO_DIR" --json
```

**Expected:**
- Manifest sync succeeds with `x-eve.branding`
- Project branding metadata is updated after the clean app deploy

## Phase 3: Send Branded Invite

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

**Expected:**
- Invite response contains `identity_hint` matching `$INVITE_EMAIL`
- `app_context.project_id` equals `$PROJECT_ID`

## Phase 4: Assert Branded Email In Mailpit

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
curl -s "http://mail.eve.lvh.me/api/v1/message/$MESSAGE_ID" \
  | tee /tmp/app-branded-invite-mail.json

jq -e '.From.Name == "ACME Portal"' /tmp/app-branded-invite-mail.json
jq -e '.From.Address == "noreply@eve.local" or .From.Address == "noreply@eve.example.com"' /tmp/app-branded-invite-mail.json
jq -e '.Subject | contains("ACME Portal")' /tmp/app-branded-invite-mail.json
jq -e '(.HTML // "") | contains("https://sandbox.acme.example/assets/logo.svg")' /tmp/app-branded-invite-mail.json
jq -e '(.HTML // "") | contains("#1f6feb")' /tmp/app-branded-invite-mail.json
jq -e '(.Text // "") | contains("ACME Portal")' /tmp/app-branded-invite-mail.json
```

**Expected:**
- Mailpit has a message for the invitee
- From display name is `ACME Portal`
- Subject, HTML, and text include ACME Portal branding
- HTML includes the logo URL and primary color

## Phase 5: Click-Through Smoke

```bash
ACTION_LINK=$(jq -r '
  (.Text // "")
  | capture("Accept invite: (?<url>https?://[^[:space:]]+)").url
' /tmp/app-branded-invite-mail.json)

test -n "$ACTION_LINK"
curl -s -o /dev/null -w "%{http_code}" "$ACTION_LINK"
```

**Expected:**
- Action link exists
- Link returns a redirect/HTML response from the existing GoTrue to SSO flow
- The SSO page may still be Eve-branded; Phase 1 only brands the email

## Phase 6: Default Branding Fallback

```bash
DEFAULT_EMAIL="default-invite-$(date +%s)@eve.local"
node packages/cli/bin/eve.js org invite "$DEFAULT_EMAIL" \
  --org "$ORG_ID" \
  --redirect-to "http://api.biv-bstrt-sandbox.lvh.me/health" \
  --json

sleep 1
DEFAULT_MESSAGE_ID=$(curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq -r --arg email "$DEFAULT_EMAIL" '
    .messages[]
    | select((.To[]?.Address // "") == $email)
    | select(.Subject == "You have been invited to Eve Horizon")
    | .ID
  ' | head -1)

test -n "$DEFAULT_MESSAGE_ID"
curl -s "http://mail.eve.lvh.me/api/v1/message/$DEFAULT_MESSAGE_ID" \
  | tee /tmp/default-invite-mail.json

jq -e '.From.Name == "Eve Horizon"' /tmp/default-invite-mail.json
jq -e '.Subject == "You have been invited to Eve Horizon"' /tmp/default-invite-mail.json
jq -e '(.HTML // "") | contains("ACME Portal") | not' /tmp/default-invite-mail.json
jq -e '(.HTML // "") | contains("#1f6feb") | not' /tmp/default-invite-mail.json
```

**Expected:**
- A no-project invite uses Eve Horizon default branding
- ACME Portal logo/color does not appear in the default invite

## Success Criteria

- k3d stack deployed with API SMTP env pointed at Mailpit
- Existing web-auth/Mailpit/SSO checks pass
- Existing starter app deploys as `biv-bstrt-sandbox`
- Branded invite email captured by Mailpit
- Branded email From display name, subject, HTML, text, logo, and button color are correct
- Invite action link is present and reaches the existing GoTrue/SSO flow
- No-project invite falls back to Eve Horizon branding

## Debugging

| Symptom | Diagnostic | Fix |
|---|---|---|
| No Mailpit message | `eve system logs api --tail 100` | Check API has `GOTRUE_SMTP_HOST=mailpit.eve.svc.cluster.local` |
| `generate_link` fails | API logs include GoTrue response body | Verify `SUPABASE_AUTH_SERVICE_KEY` and GoTrue admin endpoint |
| Deploy fails | `eve pipeline show-run deploy-sandbox <run_id> --project "$PROJECT_ID" --json` | Keep branding sync after the clean deploy so deploy drift checks compare the committed starter manifest |
| `project sync` fails with agent slug collision | Scenario is using the wrong app repo | Use `../eve-horizon-starter`; the fullstack example carries agent pack config that can collide in reused local clusters |
| Mailpit detail field names differ | Inspect `/tmp/app-branded-invite-mail.json` | Adjust jq selectors but keep machine assertions |

## Cleanup

```bash
eve env delete sandbox --project "$PROJECT_ID" --force || true
rm -rf "$REPO_DIR"
```
