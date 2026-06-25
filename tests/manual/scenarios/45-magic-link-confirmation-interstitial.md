# Scenario 45: Magic-Link Confirmation Interstitial

**Time:** ~15-20 minutes
**Parallel Safe:** No (shared SSO + GoTrue state)
**LLM Required:** No
**Browser Required:** Yes

Validates the wrap-and-redeem flow that protects single-use GoTrue magic-link
and invite OTPs from being consumed by corporate email-security scanners
(Microsoft Defender SafeLinks, Mimecast, Proofpoint, Barracuda). After this
ships, every Eve-rendered action email contains a `https://sso/m/mlw_...` URL
instead of a raw GoTrue verify URL.

Tests:

- The wrap row is written when the API sends a magic-link or invite email.
- `HEAD /m/:wrap` and `GET /m/:wrap` are idempotent and never consume the OTP.
- `POST /m/:wrap` (from the interstitial form) consumes the wrap exactly once
  and 302-redirects to the GoTrue URL.
- Scanner pre-fetch loops do not break the human click.
- Expired and consumed wraps render a friendly "can't be used" page with
  the correct copy (magic-link vs invite).
- `auth.action_link.wrap_redeemed` event is emitted on consume.
- The `/callback` error-code surfacing (Lane 4) redirects to `/login` with a
  friendly error instead of spinning on "Authenticating...".

Builds on:

- Scenario 40 (app magic-link login opt-in)
- Scenario 44 (domain-signup magic link)

## Prerequisites

- Local k3d stack ownership (`./bin/eh status` shows `K8s Owner: true`)
- Scenarios 40 and 44 pass

## Setup

```bash
./bin/eh status
./bin/eh k8s deploy   # picks up the new SSO routes and migration 00098
./bin/eh k8s migrate

export EVE_API_URL=http://api.eve.lvh.me
eve profile use local
eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519

curl -fsS http://api.eve.lvh.me/health | jq .
curl -fsS http://sso.eve.lvh.me/health | jq .
curl -fsS -o /dev/null http://mail.eve.lvh.me/
```

Verify the migration applied:

```bash
kubectl -n eve exec deploy/eve-postgres -- psql -U postgres -d eve \
  -c "\dt magic_link_wraps"
```

**Expected:** `magic_link_wraps` table exists.

Pick or deploy a project that has `x-eve.auth.login_method: magic_link` and
a domain-signup rule for `@example.com` (Scenario 44 leaves one in place).
Export `PROJECT_ID` and `ORG_ID` from that scenario.

```bash
export TEST_EMAIL=tester1@example.com
```

## Phase 1: Happy Path — Email Contains Wrap URL

```bash
# Trigger a magic-link send via the API
curl -fsS -X POST http://api.eve.lvh.me/auth/magic-link \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"$PROJECT_ID\",\"email\":\"$TEST_EMAIL\"}" | jq .
```

**Expected:** `{ "sent": true }`.

Open Mailpit at <http://mail.eve.lvh.me> in a browser and view the latest
message. The "Sign in" button href must be `http://sso.eve.lvh.me/m/mlw_...`,
**not** `http://auth.eve.lvh.me/verify?...`. Copy the URL.

```bash
export WRAP_URL='http://sso.eve.lvh.me/m/mlw_...'   # paste from Mailpit
export WRAP_ID=$(echo "$WRAP_URL" | sed -E 's|.*/(mlw_[a-z0-9]+).*|\1|')

kubectl -n eve exec deploy/eve-postgres -- psql -U postgres -d eve -c \
  "SELECT id, kind, project_id, get_count, consumed_at FROM magic_link_wraps WHERE id = '$WRAP_ID'"
```

**Expected:** a row with `kind = magic_link`, `project_id = <yours>`,
`get_count = 0`, `consumed_at IS NULL`.

## Phase 2: Scanner Simulation — Pre-Fetch Does Not Consume

```bash
for i in {1..5}; do curl -fsSI "$WRAP_URL" > /dev/null; done
for i in {1..5}; do curl -fsS "$WRAP_URL"  > /dev/null; done

kubectl -n eve exec deploy/eve-postgres -- psql -U postgres -d eve -c \
  "SELECT get_count, consumed_at FROM magic_link_wraps WHERE id = '$WRAP_ID'"
```

**Expected:** `get_count >= 10`, `consumed_at IS NULL`. The wrap is still
usable.

## Phase 3: Human Click — POST Consumes Once

Open `$WRAP_URL` in a browser. The interstitial must show:

- The project's app-branded name (or "Eve Horizon" if no branding).
- A "Sign in" button.
- The destination host (`<projectslug>.<orgslug>-<env>.lvh.me`) if the
  project declares the redirect origin; otherwise no destination line.

Click "Sign in". Browser must:

1. POST `/m/<wrap>` (with hidden `csrf` field).
2. Receive `302` to `http://auth.eve.lvh.me/verify?token=...`.
3. GoTrue verifies, redirects to `/callback`, lands the user signed in.

```bash
kubectl -n eve exec deploy/eve-postgres -- psql -U postgres -d eve -c \
  "SELECT get_count, consumed_at IS NOT NULL AS consumed FROM magic_link_wraps WHERE id = '$WRAP_ID'"
```

**Expected:** `consumed = t`, `get_count >= 10`.

Then verify the `auth.action_link.wrap_redeemed` event landed:

```bash
eve event list --project "$PROJECT_ID" --type auth.action_link.wrap_redeemed --json | jq '.data[0]'
```

**Expected:** one event with `payload_json.kind = "magic_link"`,
`payload_json.get_count >= 10`, `payload_json.latency_ms >= 0`.

## Phase 4: Double-Click — Second POST Renders Expired Page

Re-open `$WRAP_URL` in a second tab and click "Sign in" again. Expected:
"This sign-in link can't be used" page with a "Request a new sign-in link"
button linking back to `/login`. No GoTrue redirect.

```bash
kubectl -n eve exec deploy/eve-postgres -- psql -U postgres -d eve -c \
  "SELECT consumed_at, get_count FROM magic_link_wraps WHERE id = '$WRAP_ID'"
```

**Expected:** `consumed_at` is unchanged (the first POST won the race);
`get_count` is higher (the re-open GET bumped it).

## Phase 5: Expired Wrap Path

```bash
# Trigger a fresh send so we have a clean pending wrap
curl -fsS -X POST http://api.eve.lvh.me/auth/magic-link \
  -H 'Content-Type: application/json' \
  -d "{\"project_id\":\"$PROJECT_ID\",\"email\":\"tester2@example.com\"}" >/dev/null

EXPIRED_ID=$(kubectl -n eve exec deploy/eve-postgres -- psql -U postgres -d eve -tAc \
  "SELECT id FROM magic_link_wraps WHERE consumed_at IS NULL ORDER BY created_at DESC LIMIT 1")

kubectl -n eve exec deploy/eve-postgres -- psql -U postgres -d eve -c \
  "UPDATE magic_link_wraps SET expires_at = now() - interval '5 minutes' WHERE id = '$EXPIRED_ID'"

curl -fsSI "http://sso.eve.lvh.me/m/$EXPIRED_ID"
curl -fsS  "http://sso.eve.lvh.me/m/$EXPIRED_ID"
```

**Expected:**

- HEAD: `HTTP/1.1 410 Gone` + `Cache-Control: no-store`.
- GET: 410 with the "This sign-in link can't be used" HTML page.

## Phase 6: Invite Wrap Copy

Run an invite send (Scenario 41) or:

```bash
curl -fsS -X POST http://api.eve.lvh.me/orgs/$ORG_ID/invites \
  -H "Authorization: Bearer $(eve auth token --json | jq -r .access_token)" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"inviteme@example.com\",\"project_id\":\"$PROJECT_ID\"}" | jq .
```

Open the resulting Mailpit message; the URL is `/m/mlw_...`. Visit it. The
interstitial heading is "Accept invite to <App>"; the button is "Accept
invite". Expire that wrap (Phase 5 recipe) and visit again — the expired
page must say "ask the person who invited you to send a new invite", **not**
offer a magic-link request CTA.

## Phase 7: /callback Error Surfacing (Lane 4)

```bash
curl -fsS -i "http://sso.eve.lvh.me/callback?error_code=otp_expired&redirect_to=http%3A%2F%2Fapi.dsstrt-sandbox.lvh.me&project_id=$PROJECT_ID" | head -5
```

**Expected:** `HTTP/1.1 302` with `Location: /login?...&error_code=otp_expired&...`.
No HTML "Authenticating..." page returned. Open the redirect in a browser to
confirm the friendly error string ("This sign-in link has already been used
or has expired...").

## Phase 8: Pruner (Optional)

If the test session is long, the `pruneExpiredMagicLinkWraps` timer runs every
hour and deletes rows older than 24h. Sanity-check it by inserting a stale
row and forcing a prune via the API container or waiting through one cycle.

## Cleanup

```bash
kubectl -n eve exec deploy/eve-postgres -- psql -U postgres -d eve \
  -c "DELETE FROM magic_link_wraps WHERE email_hash IS NOT NULL"
```

## Pass / Fail Summary

- [ ] Mailpit message URL is `/m/mlw_...`, not GoTrue `/verify`.
- [ ] HEAD/GET on the wrap do not flip `consumed_at`.
- [ ] POST from the interstitial 302s to GoTrue and signs the user in.
- [ ] Double-click renders the friendly expired page.
- [ ] Expired wrap returns 410 on HEAD and renders 410 HTML on GET.
- [ ] Invite expired copy does not offer a magic-link request CTA.
- [ ] `/callback?error_code=otp_expired` redirects to `/login` (no spinner).
- [ ] `auth.action_link.wrap_redeemed` event lands on the spine.
