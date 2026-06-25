# Agentic App Plan A: Identity, Auth & Access Control

> Status: Plan
> Last Updated: 2026-02-11
>
> Inputs:
> - `docs/ideas/agentic-app-platform-primitives-roadmap.md`
> - `docs/ideas/native-agentic-app-primitives-roadmap.md`
> - `docs/ideas/platform-primitives-for-agentic-apps.md` (Primitive 7)
> - `docs/ideas/app-role-permissions-mapping-and-ops.md`
> - `docs/ideas/agentic-pm-native-app-platform-gap-analysis.md`
>
> Parallel Streams:
> - **Plan B**: `docs/plans/agentic-app-context-intelligence-plan.md`
> - **Plan C**: `docs/plans/agentic-app-infra-provisioning-plan.md`

## Brief

This plan covers the identity and authorization primitives that let app backends
authenticate as services, let operators inspect effective permissions, and let
teams define least-privilege custom roles with policy-as-code sync.

Everything here touches the auth middleware, RBAC service, and permission
resolution layer. It has no overlap with Plan B (context/data plane) or Plan C
(infra/deployer), so it runs fully in parallel.

## Why This Stream Exists

Today, authentication is user-scoped (SSH keys, OAuth). App backends use
long-lived user JWTs — a security debt. Roles are fixed to `member/admin/owner`,
pushing teams toward over-privileged accounts. Permission sources are not
inspectable.

These primitives make Eve production-grade for multi-app, multi-team orgs.

---

## Phase 1: Service Principals + Scoped Tokens

### Problem

An app backend needs to call the Eve API as a machine identity, not impersonate
a user. No service account or API key primitive exists.

### What We Build

New `service_principals` table, token minting endpoint, and CLI commands.

**DB schema:**

```sql
CREATE TABLE service_principals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id),
  name          TEXT NOT NULL,
  description   TEXT,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, name)
);

CREATE TABLE service_principal_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    UUID NOT NULL REFERENCES service_principals(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  scopes          TEXT[] NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**API:**

```
POST   /orgs/:id/service-principals              -- create principal
GET    /orgs/:id/service-principals              -- list principals
DELETE /orgs/:id/service-principals/:sp_id       -- revoke principal
POST   /orgs/:id/service-principals/:sp_id/tokens -- mint scoped token
DELETE /orgs/:id/service-principals/:sp_id/tokens/:tok_id -- revoke token
```

**CLI:**

```bash
eve auth create-service-account --name "pm-app-backend" \
  --scopes "jobs:create,jobs:read,projects:read"
eve auth list-service-accounts
eve auth revoke-service-account pm-app-backend
```

### Implementation Notes

- Token format: short-lived JWT (1h default, configurable up to 24h) with
  `sub: sp:<principal_id>`, `scopes: [...]`, `org_id: ...`.
- Auth middleware must recognize `sp:` subject prefix and resolve scopes from
  the token claims (no DB lookup on every request — scopes are in the JWT).
- Existing `requirePermission()` guards work unchanged — the middleware populates
  the same `RequestContext` with the principal's effective permissions.
- Rotation: mint new token, revoke old. No implicit rotation.
- Audit: `last_used_at` updated on token use (debounced, not per-request).

### Exit Criteria

- App backend can authenticate to Eve API using a service principal token.
- Token scopes limit the principal to declared permissions.
- `eve auth create-service-account` works end-to-end.

---

## Phase 2: Access Visibility

### Problem

Operators and agents cannot answer "can user X do Y in project Z?" or "why was
this request denied?" Permission resolution is opaque.

### What We Build

Two new CLI commands that query the existing permission model:

```bash
eve access can --user user_abc --project proj_xxx --permission chat:write
# Output: ALLOWED (source: admin role on project proj_xxx)

eve access explain --user user_abc --project proj_xxx --permission jobs:admin
# Output:
# Permission: jobs:admin
# Result: DENIED
# Grants found:
#   - org membership: member → [jobs:read, jobs:write] (missing jobs:admin)
#   - project membership: member → [jobs:read, jobs:write] (missing jobs:admin)
# Missing: jobs:admin requires admin or owner role
```

**API:**

```
GET /orgs/:id/access/can?principal=user_abc&project=proj_xxx&permission=chat:write
GET /orgs/:id/access/explain?principal=user_abc&project=proj_xxx&permission=jobs:admin
```

### Implementation Notes

- `can` returns boolean + source. `explain` returns full grant chain.
- Both endpoints work for user principals and service principals.
- Read-only queries — no state mutation.
- Build on existing `rbac.service.ts` permission resolution, exposing it as an
  API surface rather than internal-only.

### Exit Criteria

- `eve access can` returns correct allow/deny for any user/project/permission.
- `eve access explain` shows the full grant resolution chain.
- Works for both user and service principal subjects.

---

## Phase 3: Custom Role Overlays + Bindings

### Problem

Roles are fixed to `member/admin/owner`. Apps need roles like `pm_manager`
(broad read, narrow write) or `support_triage` (jobs + threads only).

### What We Build

Custom role definitions and role bindings as additive overlays.

**DB schema:**

```sql
CREATE TABLE access_roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id),
  name          TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('org', 'project')),
  permissions   TEXT[] NOT NULL,
  description   TEXT,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, name)
);

CREATE TABLE access_bindings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id       UUID NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'service_principal')),
  principal_id  UUID NOT NULL,
  project_id    UUID REFERENCES projects(id),  -- NULL = org-wide binding
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(role_id, principal_type, principal_id, project_id)
);
```

**Permission resolution update:**

```
effective = expand(base_membership_role) UNION all(bound_custom_role_permissions)
```

**CLI:**

```bash
eve access roles create pm_manager --org org_xxx \
  --permissions jobs:read,jobs:write,threads:read,threads:write,chat:write
eve access roles list --org org_xxx
eve access roles show pm_manager --org org_xxx
eve access roles update pm_manager --org org_xxx --add-permission events:read
eve access roles delete pm_manager --org org_xxx

eve access bind --project proj_xxx --user user_abc --role pm_manager
eve access bindings list --project proj_xxx
eve access unbind --project proj_xxx --user user_abc --role pm_manager
```

### Implementation Notes

- Permissions must come from the known permission catalog (`permissions.ts`).
- Non-system-admin users cannot create roles containing `system:*` permissions.
- Callers cannot bind roles with permissions they don't themselves hold.
- `access can` and `access explain` (Phase 2) must be updated to include
  custom role grants in their resolution chain.
- Role changes are auditable via `created_by` and `updated_at`.

### Guardrails

1. Custom roles are additive only — they cannot remove base membership grants.
2. Role names are org-unique (no app namespacing in v1).
3. No explicit deny rules in v1 — only additive grants.
4. Backward compatible: existing orgs work identically without custom roles.

### Exit Criteria

- Custom roles can be created, listed, updated, deleted via CLI.
- Bindings can assign custom roles to users and service principals.
- Permission resolution correctly unions base role + all bound custom roles.
- `access can` and `access explain` reflect custom role grants.

---

## Phase 4: Policy-as-Code Sync

### Problem

Roles managed only in the DB drift across environments and are not reviewable.

### What We Build

`.eve/access.yaml` schema and validate/plan/sync commands.

**Schema:**

```yaml
version: 1
access:
  roles:
    pm_manager:
      scope: org
      permissions:
        - projects:read
        - jobs:read
        - jobs:write
        - threads:read
        - threads:write
        - chat:write
    support_triage:
      scope: project
      permissions:
        - jobs:read
        - jobs:write
        - threads:read
        - events:read

  bindings:
    - scope: org
      org_id: org_xxx
      subject:
        type: user
        id: user_pm123
      roles: [pm_manager]
    - scope: project
      project_id: proj_xxx
      subject:
        type: service_principal
        id: svc_pmapp
      roles: [support_triage]
```

**CLI:**

```bash
eve access validate --file .eve/access.yaml
eve access plan --file .eve/access.yaml --org org_xxx
eve access sync --file .eve/access.yaml --org org_xxx
```

### Implementation Notes

- `validate` checks YAML schema, permission names, and referential integrity.
- `plan` shows a diff: roles/bindings to add, update, or remove.
- `sync` applies the plan (with confirmation prompt unless `--yes`).
- Deterministic merge: file is source of truth for declared roles. Roles not
  in the file but present in DB are left untouched (no destructive sync by
  default; `--prune` flag to remove undeclared roles).
- CI-friendly: `eve access plan --file .eve/access.yaml --org org_xxx --json`
  outputs machine-readable diff for drift detection.

### Exit Criteria

- `.eve/access.yaml` can declare roles and bindings.
- `validate` catches schema errors and unknown permissions.
- `plan` shows accurate add/update/remove diff.
- `sync` applies changes and is idempotent.

---

## Cross-Stream Dependencies

| This Plan Provides | Plans B/C Consume |
|---|---|
| Service principal tokens | Plan B: backend callers for context APIs. Plan C: project bootstrap auth. |
| Custom role bindings | Plan B: permission filtering on org-level queries. |

These are soft dependencies — Plan B can build and test context APIs using user
auth first, then switch to service principal auth when this plan ships Phase 1.

---

## Code Surface

| Area | Key Files |
|---|---|
| Auth middleware | `apps/api/src/auth/` |
| RBAC service | `apps/api/src/auth/rbac.service.ts` |
| Permissions catalog | `apps/api/src/auth/permissions.ts` |
| Auth DB tables | `packages/db/migrations/00018_add_auth_tables.sql` |
| Membership queries | `packages/db/src/queries/memberships.ts` |
| CLI auth commands | `packages/cli/src/commands/auth/` |
| Shared schemas | `packages/shared/src/schemas/org.ts`, `project.ts` |

---

## Delivery Summary

| Phase | Primitive | Cost | Unlocks |
|---|---|---|---|
| 1 | Service principals + tokens | Medium | Machine identity for app backends |
| 2 | Access can/explain | Low | Permission debuggability |
| 3 | Custom roles + bindings | Medium | Least-privilege app personas |
| 4 | Policy-as-code sync | Low | Reviewable, CI-friendly access config |
