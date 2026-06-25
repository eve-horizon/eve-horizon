# App Roles and Permission Mapping for Eve-Compatible Apps

> Status: Idea  
> Last Updated: 2026-02-11  
>
> Inputs:
> - `apps/api/src/auth/permissions.ts`
> - `apps/api/src/auth/rbac.service.ts`
> - `packages/db/migrations/00018_add_auth_tables.sql`
> - `packages/db/src/queries/memberships.ts`
> - `packages/shared/src/schemas/org.ts`
> - `packages/shared/src/schemas/project.ts`
> - `docs/system/auth.md`

## Brief

Eve-compatible apps need app-specific roles (for example `pm_manager`, `support_triage`, `qa_reviewer`) with precise permission bundles. Today, role handling is fixed to `member/admin/owner`, which pushes teams toward over-privileged accounts.

This doc proposes a CLI-first, agent-friendly access model that keeps ownership semantics intact while enabling custom role-to-permission mapping safely.

---

## Current Friction

1. Membership roles are fixed (`owner/admin/member`) in DB constraints and schemas.
2. Permission mapping is hard-coded in API code.
3. Some authorization paths still rely on role-rank checks instead of permission checks.
4. App developers can inspect permissions, but cannot define reusable role profiles for their app domain.

Result: teams often grant `admin` when they only need a narrow subset (`chat:write`, `jobs:write`, `threads:read`, etc.).

---

## Why This Helps

This directly improves Eve-compatible app development:

- Faster onboarding for app teams.
- Least-privilege by default (less token and blast-radius risk).
- Better automation for agents (plan/apply/explain flows).
- Less custom auth logic in each app backend.

For PM-style apps specifically, this enables a "product operator" role with broad read access and narrowly scoped write capabilities, without granting full admin.

---

## Design Principles

1. **Backward compatible**: existing `member/admin/owner` behavior remains valid.
2. **Additive overlays**: custom roles add permissions; they do not replace ownership semantics.
3. **CLI-first operations**: everything manageable via deterministic commands and JSON output.
4. **Policy-as-code option**: role definitions should be syncable from repo config.
5. **Safe by default**: no accidental escalation to system-level permissions.

---

## Proposed Model

### 1) Keep Base Membership Roles

Keep org/project membership rows as `owner/admin/member` for hierarchy and ownership guardrails.

### 2) Add Custom Role Definitions

Introduce role definitions at org/project scope:

- `name` (for example `pm_manager`)
- `scope` (`org` or `project`)
- `permissions[]` (subset of known permission catalog)
- `metadata` (description, tags)

### 3) Add Role Bindings

Bind principals to one or more custom roles:

- principal types: `user` and `service_principal` (future-ready for app backends)
- scope: org or project

### 4) Effective Permission Resolution

For user/service tokens:

`effective_permissions = expand(base_membership_role) UNION all(bound_custom_role_permissions)`

For job tokens:

- keep explicit `permissions[]` model (unchanged)

For system admins:

- bypass unchanged

---

## CLI and Agent-Friendly Ops

## Access Role Commands

```bash
eve access roles list --org org_xxx
eve access roles show pm_manager --org org_xxx
eve access roles create pm_manager --org org_xxx \
  --permissions jobs:read,jobs:write,threads:read,threads:write,chat:write
eve access roles update pm_manager --org org_xxx --add-permission events:read
eve access roles delete pm_manager --org org_xxx
```

## Access Binding Commands

```bash
eve access bindings list --project proj_xxx
eve access bind --project proj_xxx --user user_abc --role pm_manager
eve access unbind --project proj_xxx --user user_abc --role pm_manager
```

## Explainability Commands

```bash
eve access can --user user_abc --project proj_xxx --permission chat:write
eve access explain --user user_abc --project proj_xxx --permission jobs:admin
```

`explain` should return:
- allowed/denied
- source grants (base role vs custom roles)
- missing permission (if denied)

## Policy-as-Code Commands

```bash
eve access validate --file .eve/access.yaml
eve access plan --file .eve/access.yaml --org org_xxx
eve access sync --file .eve/access.yaml --org org_xxx
```

This makes role setup scriptable by agents and repeatable in CI.

---

## Policy-as-Code Shape (Sketch)

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

---

## Guardrails

1. Custom role permissions must come from known permission catalog.
2. Non-system-admin users cannot grant `system:*`.
3. Callers cannot bind roles containing permissions they do not control.
4. Role changes are auditable (who changed what and when).
5. `plan` mode must show adds/removes before `sync`.

---

## Compatibility Strategy

1. No change required for existing orgs/projects.
2. Existing members continue to resolve via `member/admin/owner`.
3. Custom roles are optional overlays.
4. Existing `eve org members` and `eve project members` commands remain.
5. `eve auth permissions` remains source of permission catalog truth.

---

## Implementation Options

### Option A: API-Only Runtime Roles

Store roles and bindings only in DB and manage via CLI.

**Pros**
- Fastest path
- Minimal schema surface in manifest/config

**Cons**
- Harder to version with app code
- Drift risk across environments

### Option B: Repo-Only Roles

Define roles only in repo config and sync at deploy/sync time.

**Pros**
- Versioned and reviewable
- Great for agent automation

**Cons**
- Harder for org-level shared roles across many repos

### Option C: Hybrid (Recommended)

Allow both DB-managed and repo-managed with deterministic merge/precedence rules.

**Pros**
- Supports org platform teams and app teams
- Enables shared org roles + per-project overlays

**Cons**
- Slightly more complex merge semantics

---

## Phased Rollout

### Phase 0: Visibility

- Add `eve access can` and `eve access explain` over current model.
- Improve permission introspection without changing auth semantics.

### Phase 1: Custom Roles (API + CLI)

- Add `access_roles` and `access_bindings`.
- Add CLI CRUD + bind/unbind commands.
- Update permission resolution to union overlays.

### Phase 2: Policy-as-Code

- Add `.eve/access.yaml` schema + validate/plan/sync commands.
- Add CI-friendly drift detection.

### Phase 3: Service Principals Integration

- Bind custom roles to service principals.
- Make app backends use short-lived scoped tokens instead of long-lived user tokens.

---

## Open Questions

1. Should org-level role names be globally unique per org, or namespace by app?
2. Should project bindings inherit org bindings by default (with allow/deny overrides)?
3. Do we need explicit deny rules, or only additive grants in v1?
4. Should role definitions be exportable/importable between orgs?
5. Should role policies live in `.eve/access.yaml`, manifest `x-eve.access`, or both?

---

## Bottom Line

Yes, this helps materially. A CLI-first custom role overlay model gives app developers and agents an easy path to least-privilege access without breaking Eve's current ownership and RBAC foundations.
