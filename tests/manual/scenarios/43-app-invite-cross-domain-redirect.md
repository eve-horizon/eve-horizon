# Scenario 43: App Invite + Magic Link Cross-Domain Redirect

**Time:** ~30 minutes
**Parallel Safe:** No (mutates a specific branding project's manifest)
**LLM Required:** No
**Browser Required:** Yes (network tab + console)
**Environment:** Staging (`eve.example.com`); Lane 1 can also be exercised against local k3d via `*.lvh.me`.

Validates [docs/plans/app-invite-redirect-allowlist-plan.md](../../../docs/plans/app-invite-redirect-allowlist-plan.md):

- The SSO broker accepts `redirect_to` for off-cluster origins declared in the manifest.
- Eligible custom domains owned by the project are auto-derived.
- Custom domains owned by a sibling org listed in `auth.org_access.allowed_orgs` are accepted.
- The SSO landing page no longer dead-ends signed-in users at `/login`.
- `/session` and `/logout` CORS allow validated custom-domain origins when `project_id` is supplied.
- `eve project auth-context <id>` surfaces the resolved allowlist for operators.

## Prerequisites

- Staging is at a release that contains the redirect-allowlist work (Lane 1 minimum).
- You are the **staging owner** (`./bin/eh status` shows `Staging Owner: true`).
- A branding-only project exists in `org_Acme` (e.g. `branding/acme-invites`) with `x-eve.auth.login_method: magic_link` and (for Lane 3) `org_access: { mode: allowlist, allowed_orgs: [org_Acme, org_example] }`.
- `acme-portal` (in `org_example`) has `sandbox.acme.example` registered as a custom domain in `dns_verified`, `cert_provisioning`, or `active` status.
- A test mailbox you can read (the invite email recipient).

```bash
./bin/eh status
eve profile use staging
eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
```

---

## Lane 1: Manifest-declared allowlist

### 1.1 Add explicit `allowed_redirect_origins` to the branding manifest

In `branding/acme-invites/.eve/manifest.yaml`:

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
```

Deploy and verify the resolved list:

```bash
eve manifest sync --project <branding-project-id>
eve project auth-context <branding-project-id>
```

**Expect:** `Allowed redirect origins (1+)` includes `https://sandbox.acme.example`.

### 1.2 Send an invite with `redirect_to` to the custom domain

```bash
eve org invite test@example.com \
  --org org_Acme \
  --project <branding-project-id> \
  --redirect-to https://sandbox.acme.example/cameras
```

Open the invite link from the test mailbox.

**Expect:**
- Browser lands on `https://sandbox.acme.example/cameras` (NOT on `https://sso.eve.example.com/`).
- Eve session cookies are set on `.eve.example.com`.
- DevTools network tab shows `GET https://sso.eve.example.com/session?project_id=<branding-project-id>` returning `200` with `access_token`.
- DevTools shows no CORS error.

### 1.3 Negative: malicious redirect must be rejected

```bash
eve org invite attacker@example.com \
  --org org_Acme \
  --project <branding-project-id> \
  --redirect-to https://attacker.example.com
```

Open the link.

**Expect:**
- Browser stays on `https://sso.eve.example.com/...` (the fallback landing page, not `attacker.example.com`).
- API logs (`kubectl -n eve logs deployment/eve-sso --tail=100`) contain a `[callback] Rejected redirect_to=https://attacker.example.com` warning line.

---

## Lane 2: Auto-derive from project's own custom domain

Pick (or temporarily create) a project that owns a custom domain in its own org and has `x-eve.auth.login_method: magic_link` but no `allowed_redirect_origins` in the manifest. The simplest case is `acme-portal` itself.

```bash
eve project auth-context <acme-portal-project-id>
```

**Expect:** `Allowed redirect origins` includes `https://sandbox.acme.example` even though the manifest does not list it.

If you can, send a `acme-portal` invite or magic link with `redirect_to=https://sandbox.acme.example/`:

**Expect:** redirect succeeds.

---

## Lane 3: Cross-org via `allowed_orgs`

Revert the explicit Lane-1 manifest entry — remove `allowed_redirect_origins` but keep `org_access.allowed_orgs: [org_Acme, org_example]`. Re-sync.

```bash
eve project auth-context <branding-project-id>
```

**Expect:** `Allowed redirect origins` still includes `https://sandbox.acme.example` because `acme-portal` (in `org_example`, a member of `allowed_orgs`) owns that hostname.

Send another invite as in Lane 1.2 and verify redirect succeeds.

---

## Lane 4: Continue UX for signed-in users

Sign in once (Lane 1.2 leaves you signed in). Then in a new tab:

```
https://sso.eve.example.com/login?project_id=<branding-project-id>&redirect_to=https%3A%2F%2Fsandbox.acme.example%2Fcameras
```

**Expect:** Immediate 302 to `https://sandbox.acme.example/cameras`. You should NOT see the login form.

Then visit:

```
https://sso.eve.example.com/
```

**Expect:** Page says "Signed in" and has a **Sign out** button (not a "Continue to Sign In" link back to `/login`).

Clear cookies and reload:

**Expect:** Page falls back to "Authenticating..." with a Continue link to `/login`.

---

## Lane 5: CLI surfacing + manifest validate

```bash
# happy path — already exercised above
eve project auth-context <branding-project-id> --json | jq '.auth.allowed_redirect_origins'

# reject malformed origins at validate time
cat > /tmp/bad-manifest.yaml <<EOF
schema: eve.v1
x-eve:
  auth:
    allowed_redirect_origins:
      - https://app.example.com/dashboard
EOF

eve manifest validate --file /tmp/bad-manifest.yaml
```

**Expect:** Validation fails with a clear error pointing at the path-bearing redirect origin entry.

---

## Cleanup

- Restore the branding manifest to the state your team wants long-term (manifest entry + `allowed_orgs`, or rely on the auto-derived list).
- Drop the negative-test invites (`eve org invites list --org org_Acme` then `eve org invites revoke <id>` if needed).
