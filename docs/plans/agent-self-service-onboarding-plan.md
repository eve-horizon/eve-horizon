# Agent Self-Service Onboarding Plan

> Status: Draft
> Last Updated: 2026-02-10
> Purpose: Enable AI agents to self-onboard onto Eve from a fresh host — request access with a pubkey, wait for admin approval, bootstrap project and auth in one flow.

## Problem

Today, onboarding an agent onto Eve requires an admin to pre-provision everything: create user, register identity, create org, add membership. The agent can't do anything until all that's done. This is friction that blocks the simplest possible "install CLI, start building" experience.

## Target UX

```bash
# Human (or agent) on a fresh host:
npm install -g @eve-horizon/cli
mkdir my-project && cd my-project
eve skills install https://github.com/eve-horizon/eve-skillpacks
claude                                # start agent

# Agent runs the bootstrap skill, which:
#   1. Creates profile → staging
#   2. Sends access request (pubkey + desired org name)
#   3. Waits for admin approval
#   4. Auto-logs in once approved
#   5. Sets up project + manifest
#   6. Points to showcase for learning
```

Five steps from zero to a working Eve project. The admin's only action is one `eve admin access-requests approve <id>`.

## Dependencies

- `packages/db/migrations/` — new migration
- `packages/db/src/queries/` — new query module
- `apps/api/src/auth/auth.service.ts` — approval provisioning logic
- `apps/api/src/auth/auth.invites.controller.ts` — existing invite patterns to reuse
- `packages/cli/src/commands/auth.ts` — new `request-access` subcommand
- `packages/cli/src/commands/admin.ts` — new `access-requests` subcommand
- `packages/cli/src/commands/skills.ts` — URL argument support
- `../eve-skillpacks/eve-se/` — new bootstrap skill
- `../eve-horizon-showcase/` — referenced as learning material

## Goals

- **Self-service access**: agents submit an access request with their SSH/nostr pubkey and desired org name, no admin pre-work required.
- **Admin approval gate**: pending requests are reviewed by an admin (or later, an automated approval agent). No auto-approve.
- **Org-admin on approval**: approved agent becomes admin of their own org — full autonomy from there.
- **Single bootstrap skill**: one skill (`eve-bootstrap`) handles the entire flow from profile setup to "you're ready".
- **Direct skills install**: `eve skills install <url>` works without a pre-existing `skills.txt`.
- **Showcase reference**: bootstrap skill points agents to the showcase `/llms` route for platform knowledge.

## Non-Goals

- Auto-approval without human review (future — out of scope).
- Nostr NIP-98 request signing during the access request (request is unauthenticated).
- Multi-org access requests (one request = one org).
- Changes to existing invite flow (this layers on top, doesn't replace).

---

## Design

### 1. Database: `access_requests` Table

New migration:

```sql
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,                          -- typeid: areq_xxx
  provider TEXT NOT NULL,                       -- 'github_ssh' | 'nostr'
  public_key TEXT NOT NULL,                     -- full public key text
  fingerprint TEXT NOT NULL,                    -- SSH fingerprint or nostr hex pubkey
  email TEXT,                                   -- optional contact email
  desired_org_name TEXT NOT NULL,               -- "Acme Corp"
  desired_org_slug TEXT,                        -- "acme" (auto-derived if omitted)
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | approved | rejected
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  -- populated on approval
  user_id TEXT REFERENCES users(id),
  org_id TEXT REFERENCES orgs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX access_requests_pending_fingerprint
  ON access_requests (fingerprint) WHERE status = 'pending';
```

The partial unique index ensures one pending request per key. Approved/rejected requests are kept for audit.

### 2. API Endpoints

**Unauthenticated (agent-facing):**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/auth/request-access` | Submit access request |
| `GET`  | `/auth/request-access/:id` | Poll request status |

`POST /auth/request-access` body:
```json
{
  "provider": "github_ssh",
  "public_key": "ssh-ed25519 AAAA...",
  "email": "agent@example.com",
  "desired_org_name": "My Company",
  "desired_org_slug": "myco"
}
```

Response: `{ "id": "areq_xxx", "status": "pending" }`

`GET /auth/request-access/:id` response (when approved):
```json
{
  "id": "areq_xxx",
  "status": "approved",
  "org_id": "org_xxx",
  "org_slug": "myco"
}
```

**Admin (authenticated, requires system admin):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/admin/access-requests` | List pending requests |
| `POST` | `/admin/access-requests/:id/approve` | Approve + provision |
| `POST` | `/admin/access-requests/:id/reject` | Reject with notes |

**Approval flow** (inside `approve` handler):
1. Validate request is still pending
2. Create org with desired name/slug
3. Create user (email or generated)
4. Register identity (pubkey → user)
5. Create org membership (role = `admin`)
6. Update access_request record (status=approved, user_id, org_id)

This reuses existing primitives: `orgs.service.ensureOrg()`, user creation from `auth.service`, identity registration from `auth.controller`, membership from `orgs.service.addMember()`.

### 3. CLI: `eve auth request-access`

```bash
# Submit with SSH key (reads pub key file)
eve auth request-access \
  --ssh-key ~/.ssh/id_ed25519.pub \
  --org "My Company" \
  --email agent@example.com

# Submit with nostr pubkey
eve auth request-access \
  --nostr-pubkey <64-hex> \
  --org "My Company"

# Check status
eve auth request-access --status areq_xxx

# Block and poll until approved, then auto-login
eve auth request-access \
  --ssh-key ~/.ssh/id_ed25519.pub \
  --org "My Company" \
  --wait
```

The `--wait` flag:
1. Submits the request
2. Polls `GET /auth/request-access/:id` every 5 seconds
3. Prints "Waiting for admin approval..." with a spinner
4. On approval: triggers SSH challenge/verify login using the same key
5. Stores token in `~/.eve/credentials.json`
6. Prints "Approved! Logged in as <email>, org: <org_slug>"

### 4. CLI: `eve admin access-requests`

```bash
# List pending
eve admin access-requests
eve admin access-requests --json

# Approve
eve admin access-requests approve areq_xxx

# Reject
eve admin access-requests reject areq_xxx --reason "duplicate"
```

### 5. CLI: `eve skills install <url>`

Add optional positional URL argument to `eve skills install`:

```bash
# New: direct URL (creates/updates skills.txt, then installs)
eve skills install https://github.com/eve-horizon/eve-skillpacks

# Existing: reads skills.txt
eve skills install
```

When URL is provided:
1. If `skills.txt` doesn't exist, create it with the URL
2. If `skills.txt` exists but doesn't contain the URL, append it
3. Proceed with normal install from `skills.txt`

### 6. Skill: `eve-bootstrap`

New skill in `eve-skillpacks/eve-se/eve-bootstrap/SKILL.md`.

Flow:

```
Step 1: Verify CLI
        → eve --version
        → If missing: "Run: npm install -g @eve-horizon/cli"

Step 2: Create profile → staging
        → eve profile create staging --api-url https://api.eve.example.com
        → eve profile use staging

Step 3: Check auth
        → eve auth status
        → If authenticated: skip to Step 5
        → If not: interview user:
          - "Do you have an SSH key or nostr key?" (default: ~/.ssh/id_ed25519.pub)
          - "What do you want to call your org?"
          - "What's your email?" (optional)
        → Run: eve auth request-access --ssh-key <key> --org "<name>" --wait
        → Blocks until approved, then agent is logged in

Step 4: Set profile defaults
        → eve profile set --org <org_id> --project <proj_id>

Step 5: Create project (if needed)
        → Interview: project name, slug, repo URL
        → eve project ensure --name "..." --slug "..." --repo-url "..." --branch main

Step 6: Create .eve/manifest.yaml if missing
        → Minimal manifest with schema: eve/compose/v2

Step 7: Reference showcase
        → "Read the Eve platform reference to understand capabilities:"
        → URL: https://web.example-evshow-staging.eve.example.com/llms
        → "This covers all CLI commands, manifest syntax, and platform features."

Step 8: Summary
        → Print: org, project, profile, auth status
        → Next steps: deploy, create jobs, sync agents
```

---

## Implementation Order

| # | Deliverable | Scope |
|---|-------------|-------|
| 1 | DB migration: `access_requests` table | `packages/db/migrations/` |
| 2 | DB queries: access request CRUD | `packages/db/src/queries/` |
| 3 | API: unauthenticated request-access endpoints | `apps/api/src/auth/` |
| 4 | API: admin approval/rejection endpoints | `apps/api/src/auth/` |
| 5 | CLI: `eve auth request-access` | `packages/cli/src/commands/auth.ts` |
| 6 | CLI: `eve admin access-requests` | `packages/cli/src/commands/admin.ts` |
| 7 | CLI: `eve skills install <url>` | `packages/cli/src/commands/skills.ts` |
| 8 | Skill: `eve-bootstrap` | `../eve-skillpacks/eve-se/` |
| 9 | Integration tests | `tests/integration/` |

Steps 1-4 (DB + API) form one unit. Steps 5-6 (CLI) form another. Step 7 is independent. Step 8 depends on all prior steps.

## Verification

1. **Unit**: `pnpm test` passes after all changes
2. **Integration**: `./bin/eh test integration` with new access-request flow
3. **Manual smoke test**:
   - Start local stack (`./bin/eh start local`)
   - Terminal A: `eve auth request-access --ssh-key ~/.ssh/id_ed25519.pub --org "Test Org" --wait`
   - Terminal B: `eve admin access-requests` → shows pending request
   - Terminal B: `eve admin access-requests approve <areq_id>`
   - Terminal A: unblocks, prints "Approved! Logged in..."
   - `eve auth whoami` → shows new user
   - `eve org list` → shows "Test Org" with agent as admin
4. **Skills install**: In a fresh dir, `eve skills install https://github.com/eve-horizon/eve-skillpacks` creates `skills.txt` and installs
5. **Full flow**: Fresh dir → install skills → start Claude → run eve-bootstrap → end with working project
