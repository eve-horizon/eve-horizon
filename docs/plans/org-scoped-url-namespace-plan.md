# Org-Scoped URL and Namespace Plan

> Fix namespace and ingress URL collisions by including the org slug in both patterns.

Status: Shipped (323863d)
Last Updated: 2026-01-30

## Problem

Projects belong to an org (`org_id` is a NOT NULL FK on the projects table), and project slugs are only unique **per org** — not globally:

```sql
CREATE UNIQUE INDEX idx_projects_org_slug ON projects(org_id, slug);
```

The current namespace and URL patterns **do not include the org**:

| Resource | Pattern | Example |
|----------|---------|---------|
| Namespace | `eve-{projectSlug}-{env}` | `eve-myapp-staging` |
| Ingress URL | `{component}.{projectSlug}-{env}.{domain}` | `web.myapp-staging.lvh.me` |

Two different orgs can create a project with the same slug (`myapp`), which produces **identical namespaces and hostnames** — a hard collision on both the K8s namespace and the ingress routing layer.

## Goals

- Eliminate namespace and URL collisions across orgs
- Add a `slug` field to the org entity (it currently has only `id` and `name`)
- Slug is **user-chosen** at org creation time (not auto-generated)
- Update all namespace and URL construction to include the org slug
- Expose `${ORG_SLUG}` in manifest variable interpolation
- Fix the `env-logs.service.ts` namespace bug (uses stripped project ID, not slug)
- Update sister repos (starter, skillpacks) and all docs referencing URL patterns

## Non-goals

- Backwards-compatible URL redirects (pre-deployment, no users)
- Custom domain per org (future feature)
- Changing the project slug constraints
- Auto-generating org slugs from org names

## Current State

### Org entity — no slug

```sql
-- packages/db/migrations/00001_initial_schema.sql
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,              -- org_xxx (TypeID)
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  deleted_at TIMESTAMPTZ
);
```

The org has `id` and `name` only. No slug field. The shared schema (`packages/shared/src/schemas/org.ts`) and the org service/controller reflect this — `CreateOrgRequest` accepts `{ id?, name, owner_user_id? }` and `OrgResponse` returns `{ id, name, deleted, created_at, updated_at }`.

### Namespace construction (5 locations)

All produce `eve-{project.slug}-{environment.name}`:

| File | Line(s) |
|------|---------|
| `apps/worker/src/deployer/deployer.service.ts` | 145, 1452 |
| `apps/api/src/environments/environments.service.ts` | 128, 392 |
| `apps/api/src/environments/env-db.service.ts` | 431 |
| `apps/worker/src/pipeline-runner/pipeline-runner.service.ts` | 615 |

**Bug**: `apps/api/src/environments/env-logs.service.ts:53` uses `normalizeProjectId()` (strips `proj_` prefix from the TypeID) instead of the project slug. This produces a different namespace than the deployer, so log lookups may target the wrong namespace.

### Ingress URL construction (4 locations)

All produce `{component}.{projectSlug}-{envSlug}.{domain}`:

| File | Line(s) |
|------|---------|
| `apps/worker/src/deployer/deployer.service.ts` | 610-612 |
| `apps/api/src/environments/environments.service.ts` | 497 |
| `apps/api/src/environments/api-registration.service.ts` | 135-136 |
| `apps/worker/src/action-executor/action-executor.service.ts` | 898-902 |

### Variable interpolation

`deployer.service.ts:1379-1408` supports `${ENV_NAME}`, `${PROJECT_ID}`, `${ORG_ID}`, `${COMPONENT_NAME}`, and `${secret.KEY_NAME}`. There is no `${ORG_SLUG}`.

## Proposed Solution

### Org slug field

Add a `slug` column to the `orgs` table. Constraints:

```sql
slug VARCHAR(12) NOT NULL,
CONSTRAINT valid_org_slug CHECK (slug ~ '^[a-z][a-z0-9]{1,11}$')
```

- **2-12 lowercase alphanumeric characters**, starting with a letter
- No hyphens — this avoids ambiguity in combined names where `-` is the separator
- Globally unique (not per anything — orgs are top-level)
- K8s-safe by construction (lowercase, no special chars, well under 63-char limit)

The slug is **user-chosen at creation time** — not auto-generated. The user picks their org slug when creating the org, just as they pick a project slug when creating a project. The `ensure` endpoint requires it alongside the name.

**CLI example:**
```bash
eve org ensure "Acme Corp" --slug acme
eve org ensure "Globex Industries" --slug globex
```

### New URL pattern

```
{component}.{orgSlug}-{projectSlug}-{envName}.{domain}
```

Examples:

| Org Slug | Project Slug | Env | Component | URL |
|----------|-------------|-----|-----------|-----|
| `acme` | `myapp` | `test` | `web` | `web.acme-myapp-test.lvh.me` |
| `globex` | `myapp` | `test` | `web` | `web.globex-myapp-test.lvh.me` |
| `example` | `fstack` | `staging` | `api` | `api.example-fstack-staging.lvh.me` |

No collision — even when two orgs use the same project slug.

### New namespace pattern

```
eve-{orgSlug}-{projectSlug}-{envName}
```

Examples: `eve-acme-myapp-test`, `eve-globex-myapp-test`, `eve-example-fstack-staging`.

**Length budget**: `eve-` (4) + org slug (2-12) + `-` (1) + project slug (4-8) + `-` (1) + env name (1-20) = max ~46 characters. Well under K8s 63-char namespace limit.

### Internal service URLs

The cluster-internal URL pattern (used by `api-registration.service.ts` and `env-db.service.ts`) also needs updating:

```
Current:  http://{envName}-{component}.{projectSlug}-{envName}.svc.cluster.local
Proposed: http://{envName}-{component}.eve-{orgSlug}-{projectSlug}-{envName}.svc.cluster.local
```

The namespace portion after the first `.` must match the actual K8s namespace.

### Variable interpolation

Add `${ORG_SLUG}` to the interpolation context alongside `${ORG_ID}`:

```typescript
private interpolateValue(value: string, context: {
  envName: string;
  projectId: string;
  orgId: string;
  orgSlug: string;      // NEW
  componentName: string;
  secrets?: Map<string, string>;
}): string {
  let result = value
    .replace(/\$\{ENV_NAME\}/g, context.envName)
    .replace(/\$\{PROJECT_ID\}/g, context.projectId)
    .replace(/\$\{ORG_ID\}/g, context.orgId)
    .replace(/\$\{ORG_SLUG\}/g, context.orgSlug)   // NEW
    .replace(/\$\{COMPONENT_NAME\}/g, context.componentName);
  // ...
}
```

## Implementation

### Phase 1: Add org slug to data model

**Migration** — New migration file `packages/db/migrations/00009_org_slug.sql` (or next available number):

```sql
ALTER TABLE orgs ADD COLUMN slug VARCHAR(12);

-- Backfill existing orgs: derive slug from name (lowercase, strip non-alphanumeric, truncate to 12)
-- This is a dev-only backfill. Pre-deployment, no real user data exists.
UPDATE orgs SET slug = LEFT(LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', '', 'g')), 12)
WHERE slug IS NULL;

-- Make NOT NULL after backfill
ALTER TABLE orgs ALTER COLUMN slug SET NOT NULL;

-- Add constraints
ALTER TABLE orgs ADD CONSTRAINT valid_org_slug CHECK (slug ~ '^[a-z][a-z0-9]{1,11}$');
CREATE UNIQUE INDEX idx_orgs_slug ON orgs(slug);
```

**DB queries** — `packages/db/src/queries/orgs.ts`:
- Add `slug` to the `Org` interface
- Update `create()` to accept and insert `slug`
- Add `findBySlug()` query
- Update `ensure()` to handle slug

**Shared schemas** — `packages/shared/src/schemas/org.ts`:
- Add `slug` to `CreateOrgRequestSchema` (required, validated with regex `^[a-z][a-z0-9]{1,11}$`)
- Add `slug` to `OrgResponseSchema`
- No slug in `UpdateOrgRequestSchema` — org slug is immutable once set (it's part of deployed URLs)

**Org service** — `apps/api/src/orgs/orgs.service.ts`:
- Accept `slug` in `create()` and `ensure()`
- Include `slug` in `toResponse()`
- Validate slug uniqueness in `ensure()` flow
- Reject slug changes on update (immutable)

**Org controller** — `apps/api/src/orgs/orgs.controller.ts`:
- No structural changes needed (slug flows through the existing request/response types)

### Phase 2: Update namespace construction

Update all 6 locations to use `eve-{orgSlug}-{projectSlug}-{envName}`:

1. **`apps/worker/src/deployer/deployer.service.ts:145`** — `deploy()` method
   - Need to load org to get slug (currently only has `project.org_id`)
   - Add org lookup or pass org slug through the deploy params

2. **`apps/worker/src/deployer/deployer.service.ts:1452`** — `resolveEnvironmentScope()`
   - Same: needs org slug from project's org

3. **`apps/api/src/environments/environments.service.ts:128`** — `getNamespace()`
   - Join to org table to get slug, or accept org slug as parameter

4. **`apps/api/src/environments/environments.service.ts:392`** — API registration namespace
   - Same pattern

5. **`apps/api/src/environments/env-db.service.ts:431`** — `resolveK8sServiceHost()`
   - Accept org slug parameter

6. **`apps/worker/src/pipeline-runner/pipeline-runner.service.ts:615`** — namespace resolution
   - Load org to get slug

7. **`apps/api/src/environments/env-logs.service.ts:53`** — **Fix bug**
   - Replace `normalizeProjectId()` approach with proper project slug + org slug lookup
   - This location currently constructs a wrong namespace

**Helper pattern**: Rather than scattering org lookups, consider a shared utility:

```typescript
function buildNamespace(orgSlug: string, projectSlug: string, envName: string): string {
  return toK8sName(`eve-${orgSlug}-${projectSlug}-${envName}`, 'namespace');
}
```

Each service would need to ensure the org slug is available — either by loading the org or by passing it through from the caller.

### Phase 3: Update ingress URL construction

Update all 4 locations to use `{component}.{orgSlug}-{projectSlug}-{envName}.{domain}`:

1. **`apps/worker/src/deployer/deployer.service.ts:610-612`** — Main ingress host construction
   - Add `orgSlug` to the render params (it already receives `orgId`)
   - Build host: `` `${componentSlug}.${orgSlug}-${projectSlug}-${envSlug}.${domain}` ``

2. **`apps/api/src/environments/environments.service.ts:497`** — `resolveComponentUrl()`
   - Add `orgSlug` to params
   - Update URL template

3. **`apps/api/src/environments/api-registration.service.ts:135-136`** — `resolveBaseUrls()`
   - Add `orgSlug` parameter
   - Update both internal and external URL templates

4. **`apps/worker/src/action-executor/action-executor.service.ts:898-902`** — `resolveDeployUrl()`
   - Load org or pass org slug
   - Update host construction

### Phase 4: Update interpolation and docs

1. **Interpolation** — `apps/worker/src/deployer/deployer.service.ts:1379-1408`
   - Add `orgSlug` to context interface
   - Add `${ORG_SLUG}` replacement

2. **Eve Horizon docs** — `docs/system/deployment.md:70-96`
   - Update URL pattern and examples
   - Add `${ORG_SLUG}` to variable interpolation table

3. **AGENTS.md** — Update the environment access table and any URL examples

### Phase 5: Update starter repo (`../eve-horizon-starter`)

The starter is the getting started template for new Eve projects. Org creation instructions need the `--slug` parameter, and URL examples need updating.

| File | Change |
|------|--------|
| `README.md` | Update `eve org ensure` examples to include `--slug`, update any URL pattern references |
| `AGENTS.md` | Update environment URL references |
| `docs/GETTING-STARTED.md` | Update org creation flow (add `--slug`), update `eve org ensure` examples, update URL pattern docs |
| `.eve/manifest.yaml` | No change needed (manifest doesn't reference URLs directly) |
| `docs/plans/starter-repo-cicd-self-healing.md` | Update if it references URL patterns |

**Key change**: The getting started guide must make it clear that org slug is a user choice at creation time:
```bash
# Before (no slug)
eve org ensure "My Company"

# After (slug required)
eve org ensure "My Company" --slug myco
```

### Phase 6: Update skillpacks repo (`../eve-skillpacks`)

Skills provide agent guidance. All skills referencing URL patterns, `eve org ensure`, or namespace patterns need updating.

**URL pattern references** (update `{component}.{project}-{env}.{domain}` → `{component}.{orgSlug}-{projectSlug}-{env}.{domain}`):

| File | Change |
|------|--------|
| `eve-work/eve-read-eve-docs/references/deploy-debug.md` | URL pattern, lvh.me examples |
| `eve-se/eve-deploy-debugging/SKILL.md` | URL pattern docs |
| `eve-se/eve-project-bootstrap/SKILL.md` | URL pattern, org ensure examples |
| `eve-se/eve-troubleshooting/SKILL.md` | URL pattern docs |

**Org creation references** (add `--slug` to `eve org ensure` examples):

| File | Change |
|------|--------|
| `eve-se/eve-cli-primitives/SKILL.md` | `eve org ensure` example |
| `eve-se/eve-project-bootstrap/SKILL.md` | Bootstrap org creation flow |
| `eve-se/eve-new-project-setup/SKILL.md` | New project setup flow |
| `eve-work/eve-read-eve-docs/references/cli.md` | CLI reference |

**Ingress / domain / manifest references**:

| File | Change |
|------|--------|
| `eve-se/eve-manifest-authoring/SKILL.md` | Ingress config, add `${ORG_SLUG}` variable |
| `eve-se/eve-local-dev-loop/SKILL.md` | Ingress references |
| `eve-se/eve-repo-upkeep/SKILL.md` | Ingress definitions guidance |
| `eve-work/eve-read-eve-docs/references/manifest.md` | Variable interpolation table, add `${ORG_SLUG}` |

## Files to Modify (Complete Inventory)

### Database & Data Model (`eve-horizon-2`)
| File | Change |
|------|--------|
| `packages/db/migrations/00009_org_slug.sql` (new) | Add slug column, backfill, constraints |
| `packages/db/src/queries/orgs.ts` | Add slug to interface, create, findBySlug |
| `packages/shared/src/schemas/org.ts` | Add slug to request/response schemas |

### API Layer (`eve-horizon-2`)
| File | Change |
|------|--------|
| `apps/api/src/orgs/orgs.service.ts` | Accept/return slug, validate uniqueness, reject slug mutation |
| `apps/api/src/environments/environments.service.ts` | Namespace + URL construction (lines 128, 392, 497) |
| `apps/api/src/environments/env-db.service.ts` | Namespace construction (line 431) |
| `apps/api/src/environments/env-logs.service.ts` | Fix bug + add org slug (line 53) |
| `apps/api/src/environments/api-registration.service.ts` | URL construction (lines 135-136) |

### Worker Layer (`eve-horizon-2`)
| File | Change |
|------|--------|
| `apps/worker/src/deployer/deployer.service.ts` | Namespace (145, 1452), URL (610-612), interpolation (1379-1408) |
| `apps/worker/src/pipeline-runner/pipeline-runner.service.ts` | Namespace construction (line 615) |
| `apps/worker/src/action-executor/action-executor.service.ts` | URL construction (lines 898-902) |

### Eve Horizon Docs (`eve-horizon-2`)
| File | Change |
|------|--------|
| `docs/system/deployment.md` | URL pattern, interpolation table, add `${ORG_SLUG}` |
| `AGENTS.md` | URL examples, conventions, env access table |

### Starter Repo (`eve-horizon-starter`)
| File | Change |
|------|--------|
| `README.md` | `eve org ensure` examples → add `--slug` |
| `AGENTS.md` | Environment URL references |
| `docs/GETTING-STARTED.md` | Org creation flow, URL patterns, all `eve org ensure` examples |
| `docs/plans/starter-repo-cicd-self-healing.md` | URL pattern references if any |

### Skillpacks Repo (`eve-skillpacks`)
| File | Change |
|------|--------|
| `eve-se/eve-cli-primitives/SKILL.md` | `eve org ensure` example → add `--slug` |
| `eve-se/eve-project-bootstrap/SKILL.md` | Org creation flow, URL pattern |
| `eve-se/eve-new-project-setup/SKILL.md` | Setup flow, org creation |
| `eve-se/eve-deploy-debugging/SKILL.md` | URL pattern |
| `eve-se/eve-manifest-authoring/SKILL.md` | Ingress, add `${ORG_SLUG}` variable |
| `eve-se/eve-local-dev-loop/SKILL.md` | Ingress references |
| `eve-se/eve-troubleshooting/SKILL.md` | URL pattern |
| `eve-se/eve-repo-upkeep/SKILL.md` | Ingress definitions |
| `eve-work/eve-read-eve-docs/references/cli.md` | CLI reference, `eve org ensure` |
| `eve-work/eve-read-eve-docs/references/deploy-debug.md` | URL pattern, lvh.me examples |
| `eve-work/eve-read-eve-docs/references/manifest.md` | Variable interpolation table, add `${ORG_SLUG}` |

### Tests (`eve-horizon-2`)
| File | Change |
|------|--------|
| Integration tests | Verify new URL/namespace patterns with org slug |
| Deployer tests | Assert namespace includes org slug |

## Exit Criteria

- [ ] Org entity has a `slug` field (required, unique, 2-12 lowercase alphanumeric)
- [ ] Slug is user-chosen at org creation time (not auto-generated)
- [ ] Org slug is immutable after creation
- [ ] `eve org ensure` CLI accepts `--slug` parameter
- [ ] All namespaces follow `eve-{orgSlug}-{projectSlug}-{envName}`
- [ ] All ingress URLs follow `{component}.{orgSlug}-{projectSlug}-{envName}.{domain}`
- [ ] `${ORG_SLUG}` available in manifest variable interpolation
- [ ] `env-logs.service.ts` namespace bug fixed
- [ ] Existing integration tests pass
- [ ] Build passes (`pnpm build && pnpm test`)
- [ ] `docs/system/deployment.md` updated with new patterns
- [ ] Starter repo getting started guide updated
- [ ] Skillpacks updated (all org ensure examples, URL patterns, interpolation tables)

## Notes

- **Pre-deployment**: No backwards compatibility needed. No users, no existing namespaces to migrate.
- **User-chosen slug**: The slug is not derived from the org name. The user explicitly picks it, like a GitHub username or npm scope. This keeps it short, intentional, and URL-friendly.
- **Immutable slug**: Once set, the org slug cannot change — it's baked into deployed namespaces, ingress hostnames, and potentially external DNS. Renaming would orphan all deployed resources.
- **Env-logs bug**: `env-logs.service.ts:95-98` uses `normalizeProjectId()` which strips `proj_` from the TypeID instead of using the project slug. This produces a namespace like `eve-01kfew...-test` instead of `eve-fstack-test`. This should be fixed as part of Phase 2.
- **K8s labels**: The deployer already writes `eve.org_id` as a label on namespaces and ingress resources (`deployer.service.ts:148,616`). Consider adding `eve.org_slug` as well for easier debugging.
- **Environment namespace override**: When `environment.namespace` is explicitly set (not null), it takes precedence over the computed pattern. This override behavior should remain unchanged.
