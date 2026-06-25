# Scenario 44: App Domain-Signup Magic-Link Login

**Time:** ~20-30 minutes
**Parallel Safe:** No (deploys shared test app/environment)
**LLM Required:** No
**Browser Required:** Yes

Validates pre-approved email-domain auto-signup against local k3d: manifest
`x-eve.auth.org_access.domain_signup` config, the magic-link send path that
pre-creates a system invite for matching emails, the SSO callback that
auto-attaches the new user as a member of `target_org`, the explicit-invite
override, the idempotency guarantee on re-requests, and the public/admin
app-context payloads.

Builds on:

- Scenario 40 (app magic-link login opt-in)
- Scenario 41 (app org access + admin invites)

## Prerequisites

- Local k3d stack ownership (`./bin/eh status` shows `K8s Owner: true`)
- Scenarios 21, 40, and 41 pass
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

**Expected:** k3d is deployed; API, GoTrue, SSO, Mailpit all reachable.

## Phase 1: Deploy Starter App With Domain Signup Manifest

```bash
export ORG_ID=org_domainsignup
eve org ensure "$ORG_ID" --name "domain-signup" --slug ds --json

export STARTER_DIR=${STARTER_DIR:-../eve-horizon-starter}
export REPO_DIR=$(mktemp -d)/repo
cp -R "$STARTER_DIR" "$REPO_DIR"

PROJECT_JSON=$(eve project ensure \
  --org "$ORG_ID" \
  --name "domain-signup-starter" \
  --slug dsstrt \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter \
  --branch main \
  --force \
  --json)
export PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.id // .data.id')

eve secrets set POSTGRES_PASSWORD eve --project "$PROJECT_ID" --json
eve env create sandbox --type persistent --project "$PROJECT_ID" --json || true
eve env deploy sandbox --ref main --repo-dir "$REPO_DIR" --project "$PROJECT_ID"

curl -fsS "http://api.ds-dsstrt-sandbox.lvh.me/health" | jq .
```

**Expected:** starter app deploys; health endpoint reachable.

## Phase 2: Sync Manifest With v2 domain_signup Config

Write a v2 manifest with two per-domain rules pointing at the *same* target
org (the project owner). The shape exercises the list-of-objects schema and
verifies single-org routing still works under v2:

```bash
cat >> "$REPO_DIR/.eve/manifest.yaml" <<'YAML'
x-eve:
  branding:
    app_name: "DOMAIN-SIGNUP-TEST"
    primary_color: "#0a7f4f"
    email_from_name: "DOMAIN-SIGNUP-TEST"
  auth:
    login_method: magic_link
    self_signup: false
    invite_requires_password: false
    org_access:
      mode: project_org
      domain_signup:
        enabled: true
        domains:
          - domain: domainsignup.test
            target_org: org_manualtestorg
            role: member
          - domain: "*.domainsignup.test"
            target_org: org_manualtestorg
YAML

rg -n "domain_signup|domainsignup" "$REPO_DIR/.eve/manifest.yaml"

eve project sync --project "$PROJECT_ID" --dir "$REPO_DIR" --json
```

**Expected:**

- Manifest sync succeeds.
- Sync rejects v1 shapes if reintroduced (list-of-strings, block-level
  `target_org` or `role`).

### 2a. Public app-context hides the rule list

```bash
curl -fsS "$EVE_API_URL/auth/app-context?project_id=$PROJECT_ID" | tee /tmp/ds-public-context.json | jq .

jq -e '.auth.org_access.domain_signup_enabled == true' /tmp/ds-public-context.json
jq -e '(.auth.org_access | has("domain_signup")) == false' /tmp/ds-public-context.json
jq -e '(. | tostring) | contains("domainsignup.test") == false' /tmp/ds-public-context.json
```

**Expected:** boolean exposed; rule list NEVER surfaces in public payload.

### 2b. Admin reveal returns the full rule list

```bash
TOKEN=$(eve auth token print 2>/dev/null || cat ~/.eve/local-token 2>/dev/null)
test -n "$TOKEN"

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$EVE_API_URL/auth/app-context/admin?project_id=$PROJECT_ID" \
  | tee /tmp/ds-admin-context.json | jq .

jq -e '.auth.org_access.domain_signup.enabled == true' /tmp/ds-admin-context.json
jq -e '.auth.org_access.domain_signup.domains | length == 2' /tmp/ds-admin-context.json
jq -e '.auth.org_access.domain_signup.domains[0] | .domain == "domainsignup.test" and (.target_org | startswith("org_"))' /tmp/ds-admin-context.json
jq -e '.auth.org_access.domain_signup.domains[1] | .domain == "*.domainsignup.test" and (.target_org | startswith("org_"))' /tmp/ds-admin-context.json
```

**Expected:** full rule list with per-rule `target_org` returned.

### 2c. CLI surface

```bash
node packages/cli/bin/eve.js project auth-context "$PROJECT_ID" | tee /tmp/ds-cli-context.txt
grep -F "Domain signup:" /tmp/ds-cli-context.txt
grep -F "domainsignup.test" /tmp/ds-cli-context.txt
grep -F "->" /tmp/ds-cli-context.txt
```

**Expected:** CLI shows the `Domain signup:` block with one line per rule in
the form `<domain> -> <target_org> (<role>)`.

## Phase 3: Matching Domain Gets A Branded Magic Link

```bash
MATCH_EMAIL="user-$(date +%s)@domainsignup.test"

curl -fsS -X POST "$EVE_API_URL/auth/magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$MATCH_EMAIL\",\"project_id\":\"$PROJECT_ID\"}" \
  | tee /tmp/ds-match-response.json

jq -e '.sent == true' /tmp/ds-match-response.json

sleep 1
MATCH_MESSAGE_ID=$(curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq -r --arg email "$MATCH_EMAIL" '
    .messages[]
    | select((.To[]?.Address // "") == $email)
    | select(.Subject | contains("DOMAIN-SIGNUP-TEST"))
    | .ID
  ' | head -1)

test -n "$MATCH_MESSAGE_ID"
curl -s "http://mail.eve.lvh.me/api/v1/message/$MATCH_MESSAGE_ID" \
  | tee /tmp/ds-match-mail.json

jq -e '.From.Name == "DOMAIN-SIGNUP-TEST"' /tmp/ds-match-mail.json
jq -e '.Subject | test("Sign in to DOMAIN-SIGNUP-TEST")' /tmp/ds-match-mail.json
```

Open the magic-link action URL:

```bash
MATCH_ACTION_LINK=$(jq -r '(.Text // "") | capture("Sign in: (?<url>https?://[^[:space:]]+)").url' /tmp/ds-match-mail.json)
test -n "$MATCH_ACTION_LINK"
./bin/eh browser open "$MATCH_ACTION_LINK"
```

**Expected:** browser completes GoTrue→SSO→app callback, lands signed in.

### 3a. Membership is upserted to the matched rule's target_org

```bash
# Pull the target_org from the FIRST rule in the resolved admin payload —
# the matching email "user-...@domainsignup.test" hits the apex rule first.
TARGET_ORG=$(jq -r '.auth.org_access.domain_signup.domains[0].target_org' /tmp/ds-admin-context.json)

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$EVE_API_URL/orgs/$TARGET_ORG/members" \
  | jq --arg email "$MATCH_EMAIL" '.data[] | select(.email == $email)'
```

**Expected:** the new user appears as a `member` of the matched-rule
target org.

### 3b. Audit events on the event spine carry matched_rule

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$EVE_API_URL/projects/$PROJECT_ID/events?type=auth.domain_signup.invite_created&limit=5" \
  | tee /tmp/ds-events-created.json | jq '.data[0].payload_json'

jq -e '.data[0].payload_json.matched_rule == "domainsignup.test"' /tmp/ds-events-created.json

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$EVE_API_URL/projects/$PROJECT_ID/events?type=auth.domain_signup.member_attached&limit=5" \
  | jq '.data | length > 0'
```

**Expected:** the `invite_created` event's `payload_json` carries
`org_id` (the matched rule's `target_org`), `email_domain`, `email_hash`,
and `matched_rule` (the rule pattern that fired). `member_attached`
follows on consumption.

### 3c. Wildcard rule fires its own matched_rule

```bash
WILD_EMAIL="user-$(date +%s)@sub.domainsignup.test"
curl -fsS -X POST "$EVE_API_URL/auth/magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$WILD_EMAIL\",\"project_id\":\"$PROJECT_ID\"}" \
  | jq .

sleep 1
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$EVE_API_URL/orgs/$TARGET_ORG/invites" \
  | jq --arg e "$WILD_EMAIL" '.data[] | select(.identity_hint == $e) | .app_context'
```

**Expected:** `app_context.matched_rule == "*.domainsignup.test"` and
`app_context.matched_domain == "sub.domainsignup.test"`. The invite still
attaches to the same `target_org` because both rules in this scenario
point at it; in multi-tenant configs each rule routes to its own org.

## Phase 4: Non-Matching Domain Sees Generic Success, No Email

```bash
UNRELATED_EMAIL="unrelated-$(date +%s)@otherdomain.test"

curl -fsS -X POST "$EVE_API_URL/auth/magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$UNRELATED_EMAIL\",\"project_id\":\"$PROJECT_ID\"}" \
  | tee /tmp/ds-unrelated-response.json

jq -e '.sent == true' /tmp/ds-unrelated-response.json

sleep 1
curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq -e --arg email "$UNRELATED_EMAIL" '
    [.messages[] | select((.To[]?.Address // "") == $email)] | length == 0
  '
```

**Expected:** `{sent: true}`, no Mailpit message, no `org_invites` row written.

## Phase 5: Explicit Invite Wins Over Domain Signup

```bash
EXPLICIT_EMAIL="explicit-$(date +%s)@domainsignup.test"

node packages/cli/bin/eve.js org invite "$EXPLICIT_EMAIL" \
  --org "$TARGET_ORG" \
  --project "$PROJECT_ID" \
  --json \
  | tee /tmp/ds-explicit-invite.json

curl -fsS -X POST "$EVE_API_URL/auth/magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EXPLICIT_EMAIL\",\"project_id\":\"$PROJECT_ID\"}" \
  | tee /tmp/ds-explicit-response.json

jq -e '.sent == true' /tmp/ds-explicit-response.json

# Domain-signup re-request must NOT send a new email and must NOT write a
# parallel domain_signup invite (the explicit invite remains the entry point).
sleep 1
curl -s "http://mail.eve.lvh.me/api/v1/messages" \
  | jq --arg email "$EXPLICIT_EMAIL" '
    [.messages[] | select((.To[]?.Address // "") == $email)] | length
  '
```

**Expected:** exactly the original explicit-invite email exists for that
recipient; the second magic-link request adds nothing.

## Phase 6: Re-Request Idempotency

```bash
curl -fsS -X POST "$EVE_API_URL/auth/magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"another-$(date +%s)@domainsignup.test\",\"project_id\":\"$PROJECT_ID\"}" \
  | jq .

# Re-request for the same matching email a second time.
RPT_EMAIL="repeat-$(date +%s)@domainsignup.test"
curl -fsS -X POST "$EVE_API_URL/auth/magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$RPT_EMAIL\",\"project_id\":\"$PROJECT_ID\"}" \
  | jq .
sleep 1
curl -fsS -X POST "$EVE_API_URL/auth/magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$RPT_EMAIL\",\"project_id\":\"$PROJECT_ID\"}" \
  | jq .

# Both sends should land — but exactly one domain_signup invite row should exist.
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$EVE_API_URL/orgs/$TARGET_ORG/invites?include_used=false" \
  | jq --arg email "$RPT_EMAIL" '
    [.data[] | select(.identity_hint == $email and (.app_context.source // "") == "domain_signup")] | length
  '
```

**Expected:** exactly 1 row even after two send attempts within the 72-hour
TTL.

## Success Criteria

- Manifest sync accepts the **v2 list-of-objects** `domain_signup.domains`
  and resolves each rule's `target_org` to a canonical org id.
- Sync rejects the legacy v1 shape (list-of-strings, or block-level
  `target_org`/`role`).
- Public `/auth/app-context` reports `domain_signup_enabled: true` and never
  the raw rule list.
- `GET /auth/app-context/admin` returns each rule with its `domain`,
  `target_org`, and `role` for project admins.
- `eve project auth-context <project>` renders the rule list one line per
  rule (`<domain> -> <target_org> (<role>)`) for admins.
- A magic-link request from a matching domain emits a branded email, writes
  one `org_invites` row tagged `source: domain_signup` with
  `app_context.org_id = matched rule.target_org` and
  `app_context.matched_rule = <pattern>`, and the SSO callback attaches the
  user as `member` of the matched org.
- Wildcard rules match subdomains; the apex still needs its own rule.
  First-match precedence respects declaration order.
- A magic-link request from a non-matching domain returns `{sent: true}`,
  writes no row, and produces no email.
- An explicit pending invite for an otherwise-matching email overrides
  domain signup (no second invite row, no second email).
- A repeat magic-link request for the same matching email within 72 hours
  does not write a second invite row.
- Audit events `auth.domain_signup.invite_created` (with `matched_rule`)
  and `auth.domain_signup.member_attached` land on the event spine.

## Debugging

| Symptom | Diagnostic | Fix |
|---|---|---|
| `eve project sync` rejects `domain_signup` | API logs | Confirm `login_method` is not `password`; remove free-email-warning duplicates if blocking |
| `target_org` unresolved in admin reveal | `eve project auth-context` admin output | Set `target_org` explicitly when `mode: allowlist` has more than one allowed_org |
| Magic-link returns `{sent: true}` but no email arrives | `eve system logs api --tail 100` | Confirm domain matches; check `email_hash` in audit events to verify Path C executed |
| Membership not attached after callback | `eve system logs api -tail 100` for `Auto-applied org invite` | Verify the callback hit `attachPendingSupabaseInvite`; check `org_invites.app_context.source = 'domain_signup'` |
| Public app-context leaks domains | `curl /auth/app-context?...` | This is a bug — file an issue immediately; `toPublicAuthConfig` must emit only the bool |

## Cleanup

```bash
eve env delete sandbox --project "$PROJECT_ID" --force || true
rm -rf "$REPO_DIR"
```
