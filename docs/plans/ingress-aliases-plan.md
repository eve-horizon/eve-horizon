# Ingress Aliases: Vanity URLs for Eve Apps

> Status: Plan
> Created: 2026-02-15
> Updated: 2026-02-16 — reviewed for sync/deploy ordering, cleanup behavior, and CLI/API integration gaps
>
> Dependencies: None — standalone feature. Can proceed in parallel with all other platform work.
>
> References:
> - `apps/worker/src/deployer/deployer.service.ts` (ingress generation, line ~776)
> - `apps/api/src/projects/projects.service.ts` (manifest sync, line ~425)
> - `docs/plans/dns-integration-plan.md` (full custom domain plan — complementary, not overlapping)

## Problem

Eve-deployed apps get mechanical URLs like:

```
http://web.acme-myapp-sandbox.lvh.me
```

These are deterministic and unique but ugly, hard to remember, and impossible to share. Apps need a way to get clean vanity URLs like:

```
http://eve-pm.lvh.me           (local)
https://eve-pm.eve.example.com  (staging)
```

## Solution

A one-line manifest declaration creates a vanity hostname backed by a DB uniqueness constraint.

```yaml
services:
  web:
    ports: ["3000"]
    x-eve:
      ingress:
        public: true
        alias: eve-pm       # <-- vanity name
```

On deploy, the system creates **two** ingress resources per aliased service:

1. **Mechanical** (always): `web.acme-myapp-sandbox.lvh.me` — deterministic, guaranteed unique
2. **Vanity** (when alias bound): `eve-pm.lvh.me` — clean, memorable

No DNS or TLS changes needed — wildcard DNS (`*.lvh.me`, `*.eve.example.com`) and wildcard certs already cover any `{alias}.{domain}` hostname.

---

## Two-Phase Claim Model

Aliases use a two-phase claim to prevent conflicts:

1. **Sync time** (manifest sync) — project **reserves** the alias name globally. If another project already owns it, sync is rejected with a `409 Conflict`.
2. **Deploy time** — alias is **bound** to a specific (environment, service). If the alias is already bound to a different environment within the same project, the deploy succeeds but the vanity ingress is skipped with a warning.

This means `alias` is a **project-level claim** but an **environment-level binding**.

### Switching active environment (manifest-driven)

Warning-on-conflict remains the default behavior. To move the same alias from env A to env B without admin override:

1. Sync manifest with alias removed (releases claim).
2. Deploy env A (or delete env A) so stale alias ingress is removed from source namespace.
3. Sync manifest with alias re-added.
4. Deploy env B (bind succeeds, vanity ingress created in target namespace).

This keeps deploy semantics safe and explicit while still allowing controlled alias moves through manifest changes.

### Lifecycle

```
Manifest sync with alias    →  alias reserved (project-level, env=null)
Deploy to env A             →  alias bound to env A
Deploy to env B (same alias)→  warning: alias already bound to A, vanity skipped
Delete env A                →  alias unbound (back to reserved, env=null)
Deploy to env B             →  alias bound to env B
Manifest sync without alias →  alias released (available for any project)
Project deleted             →  all aliases cascade-deleted
```

---

## Database

### Migration: `00064_ingress_aliases.sql` (or next available number at implementation time)

```sql
CREATE TABLE ingress_aliases (
  id              TEXT PRIMARY KEY,
  alias           TEXT NOT NULL,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id  TEXT REFERENCES environments(id) ON DELETE SET NULL,
  service_name    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ingress_alias_alias_len CHECK (char_length(alias) BETWEEN 3 AND 63),
  CONSTRAINT ingress_alias_alias_format CHECK (alias ~ '^[a-z][a-z0-9-]*[a-z0-9]$')
);

CREATE UNIQUE INDEX ux_ingress_aliases_alias ON ingress_aliases(alias);
CREATE INDEX idx_ingress_aliases_project ON ingress_aliases(project_id);
CREATE INDEX idx_ingress_aliases_env ON ingress_aliases(environment_id);
```

- `UNIQUE` on `alias` — global uniqueness, one claim per name.
- `ON DELETE CASCADE` on `project_id` — project deletion releases all aliases.
- `ON DELETE SET NULL` on `environment_id` — env deletion unbinds but preserves the project's reservation.
- No `status` column — `environment_id IS NULL` means reserved; `IS NOT NULL` means bound.

### Query Module: `packages/db/src/queries/ingress-aliases.ts`

| Method | Purpose |
|--------|---------|
| `findByAlias(alias)` | Single lookup by alias name |
| `findByProject(projectId)` | All claims for a project |
| `findByEnvironment(envId)` | All bindings for an environment |
| `claimOrUpdate({ id, alias, projectId, serviceName })` | INSERT new claim or update `service_name` for same-project claim |
| `bindToEnvironment(alias, projectId, envId, serviceName)` | Atomic UPDATE when alias is unbound or already bound to same env |
| `unbindEnvironment(envId)` | SET `environment_id = NULL` for all aliases bound to env |
| `unbindAliasesForEnvironment(envId, aliases[])` | Targeted rollback cleanup for aliases newly bound in a failed deploy |
| `findByProjectAndEnvironment(projectId, envId)` | Alias bindings for one environment (for API responses / CLI) |
| `release(alias, projectId)` | DELETE where alias and project match |
| `releaseByProject(projectId)` | DELETE all for project |

---

## Manifest Schema

### Typed Ingress Config

Replace the current `z.record(z.unknown())` on `ServiceXeveSchema.ingress` (line 121 of `packages/shared/src/schemas/manifest.ts`) with a typed schema:

```typescript
export const IngressConfigSchema = z.object({
  public: z.boolean().optional(),
  port: z.number().optional(),
  alias: z.string()
    .min(3).max(63)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/)
    .optional(),
}).passthrough();
```

Backward-compatible — `.passthrough()` preserves any extra fields, all fields optional.

### Helpers

```typescript
/** Extract alias → serviceName map from a manifest */
getManifestIngressAliases(manifest: Manifest): Map<string, string>

/** Validate duplicate alias usage inside one manifest (same alias on 2 services) */
assertUniqueManifestIngressAliases(aliases: Map<string, string>): void

/** Platform-reserved names that can't be used as aliases */
const RESERVED_ALIASES = new Set(['api', 'eve', 'www', 'status', 'admin', 'health', 'sso', 'registry']);
isReservedAlias(alias: string): boolean
```

---

## Sync-Time Validation

**File**: `apps/api/src/projects/projects.service.ts` — `syncManifest()` (line 425)

Run alias reconciliation only after all sync validations have passed and the manifest row has been persisted.

1. Extract aliases via `getManifestIngressAliases(validated.data)`.
2. For each alias:
   - Reject duplicate alias usage in one manifest (`web.alias = eve-pm` and `api.alias = eve-pm`) → `BadRequestException`
   - Reject reserved names → `BadRequestException`
   - Check `findByAlias(alias)` — if owned by different project → `ConflictException("Ingress alias 'X' is already claimed by another project")`
3. Finish secret validation (strict mode can still reject sync).
4. Persist manifest (`existing hash` and `new manifest` paths both continue to alias reconciliation).
5. Reconcile aliases in one DB transaction:
   - Upsert claims: INSERT new aliases, update `service_name` on existing claims by this project
   - Release stale aliases no longer present in manifest
   - Map unique violations (`23505`) to `ConflictException`

This ordering prevents side effects on failed sync (for example, strict secret validation failure must not claim aliases).

---

## Deploy-Time Ingress Creation

**File**: `apps/worker/src/deployer/deployer.service.ts` — ingress loop (line 776)

The ingress creation loop iterates over deployable services at line 776. Each service's primary ingress is built (lines 818-851) and pushed to `documents` at line 853. The vanity alias ingress is created immediately after the primary ingress push (after line 853, before the loop's closing `}`).

After creating the primary ingress for a service:

1. Read `alias` from the service's `x-eve.ingress` config (already parsed as `ingressConfig` at line 777).
2. Call `bindToEnvironment(alias, projectId, envId, serviceName)` and inspect whether binding succeeded.
3. **If bind succeeds**: create a second Ingress resource:
   - `host: ${alias}.${domain}`
   - Same backend service and port
   - Resource name: run through `toK8sName(...)` (avoid 63-char overflow from `${resourceName}-alias`)
   - Labels: `eve.alias: ${alias}`, `eve.ingress_alias: "true"`
   - Same TLS config (wildcard cert covers `{alias}.{domain}`)
4. **If bind fails** (alias already bound to different env): log a warning, skip vanity ingress. Deploy succeeds with mechanical URL only.

The deployer already has direct DB access via query modules (e.g., `managedDbQueries`). Adding `ingressAliasQueries` follows the same pattern.

### Deploy failure and stale-resource handling

- Track aliases that were newly bound during this deploy attempt. If deploy/apply fails, unbind only those aliases (`unbindAliasesForEnvironment(envId, aliases[])`) so failed deploys do not pin alias ownership.
- Garbage-collect stale alias ingresses in the environment namespace: list ingress resources labeled `eve.ingress_alias=true` and delete ones whose alias is no longer in the desired alias set for this release. This prevents ghost vanity hosts after alias removal/rename.

---

## Cleanup

| Trigger | Action | Result |
|---------|--------|--------|
| Manifest synced without alias | `release(alias, projectId)` | Alias fully released, available to any project |
| Environment deleted | `ON DELETE SET NULL` cascade | Alias unbound, project keeps reservation |
| Project deleted | `ON DELETE CASCADE` | All aliases released |
| Service removed from manifest | Release check during sync step 5 | Alias released |
| Alias removed/renamed then redeployed | Alias ingress GC in deployer | Old vanity host removed from cluster |

---

## Admin Reclaim (MVP)

Global uniqueness requires a first-class admin reclaim path from day one.

### Admin API

Add admin endpoints under `apps/api/src/...` with `@RequirePermission('system:admin')`:

- `GET /admin/ingress-aliases` — list claims with filters (`alias`, `project_id`, `environment_id`)
- `POST /admin/ingress-aliases/:alias/reclaim` — force-release alias claim (requires `reason`)

Behavior:
- Reclaim writes an audit event with actor + reason.
- Reclaim to unclaimed state allows another project to claim on next manifest sync.

---

## CLI Display

### `eve project status`

```
sandbox  active  persistent
  revision: 8250b521  v0.1.0  deployed 2h ago
  web      1/1  ready      http://web.acme-myapp-sandbox.lvh.me
                            http://eve-pm.lvh.me
  api      1/1  ready      http://api.acme-myapp-sandbox.lvh.me
```

### `eve env show`

Include `ingress_aliases` in the `EnvironmentResponseSchema` (line 46 of `packages/shared/src/schemas/environment.ts`):

```typescript
ingress_aliases: z.array(z.object({
  alias: z.string(),
  service_name: z.string(),
})).optional(),
```

And populate it in `apps/api/src/environments/environments.service.ts`.

Implementation note: alias data must be present on both:
- `GET /projects/:id/envs`
- `GET /projects/:id/envs/:name`

`eve project status` uses the list endpoint, while `eve env show` uses the single-environment endpoint. To avoid N+1 queries on list, load aliases in batch for all listed environment IDs and group in-memory before building response objects.

---

## Implementation Order

| Step | What | Files |
|------|------|-------|
| 1 | Migration | `packages/db/migrations/NNNN_ingress_aliases.sql` (next available migration number) |
| 2 | TypeID | `packages/shared/src/ids.ts` — add `generateIngressAliasId()` (prefix chosen per existing ID conventions) |
| 3 | Schema + helpers | `packages/shared/src/schemas/manifest.ts` — replace `ingress: z.record(z.unknown())` at line 121 |
| 4 | Query module | `packages/db/src/queries/ingress-aliases.ts` (new), `packages/db/src/queries/index.ts` (export) |
| 5 | Sync validation | `apps/api/src/projects/projects.service.ts` — reconcile aliases after validations + manifest persistence |
| 6 | Env response | `packages/shared/src/schemas/environment.ts` (add field), `apps/api/src/environments/environments.service.ts` (populate in `toEnvironmentResponse` at line 1011) |
| 7 | Deploy-time | `apps/worker/src/deployer/deployer.service.ts` — insert after line 853 in ingress loop |
| 8 | Alias ingress GC + rollback safety | `apps/worker/src/deployer/deployer.service.ts`, `apps/worker/src/deployer/k8s.service.ts` |
| 9 | Admin reclaim API | `apps/api/src/**` (admin ingress-alias controller/service), `packages/db/src/queries/ingress-aliases.ts` |
| 10 | CLI display + admin CLI | `packages/cli/src/commands/project.ts`, `packages/cli/src/commands/env.ts`, `packages/cli/src/commands/admin.ts` |

Steps 1-4 are foundation. Steps 5-6 are API-side. Steps 7-8 are deploy-side. Step 9 adds admin controls. Step 10 is presentation/ops UX.

---

## Verification

**Unit tests** (`pnpm test`):
- `getManifestIngressAliases()` extracts aliases from various manifest shapes
- `isReservedAlias()` blocks platform names
- `IngressConfigSchema` validates alias format (rejects uppercase, too short, leading hyphens)

**Integration tests** (`./bin/eh test integration`):
- Sync manifest with `alias: test-app` → verify `ingress_aliases` row created
- Sync same alias from different project → verify 409 Conflict
- Sync same alias on two services in one manifest → verify 400 Bad Request
- Sync updated manifest without alias → verify claim released
- Sync reserved alias (`api`) → verify rejection
- Sync with `strict=true` and missing secrets → verify sync fails and **no alias claim is created**
- Deploy to env A → verify alias bound (`environment_id` set)
- Delete env A → verify alias unbound but still claimed by project
- Failed deploy after bind attempt → verify alias does not remain pinned to failed env
- `GET /projects/:id/envs` returns `ingress_aliases` for each env
- `GET /projects/:id/envs/:name` returns `ingress_aliases`
- Admin reclaim (system admin) releases alias; different project can claim on next sync
- Admin reclaim without `system:admin` permission is rejected

**K8s manual test**:
- Deploy fullstack example with `alias: test-vanity` on web service
- Verify `http://test-vanity.lvh.me` resolves correctly
- Verify `eve project status` shows both URLs
- Delete env, redeploy to different env → verify alias rebinds
- Remove alias from manifest, redeploy same env → verify old alias ingress is deleted (host stops routing)
- Execute manifest-driven move (remove alias -> deploy source -> re-add alias -> deploy target) and verify alias host resolves only to target env

---

## Relationship to DNS Integration Plan

The [DNS Integration Plan](./dns-integration-plan.md) covers the full custom domain story — user-owned domains like `app.mycompany.com` with DNS validation, cert provisioning, and lifecycle management.

Ingress aliases are a **lightweight complement**:

| | Alias | Custom Domain |
|---|---|---|
| Scope | Platform domain only | Any domain |
| Config | One field in manifest | API + DNS setup |
| DNS | Wildcard (zero-config) | User manages CNAME |
| TLS | Wildcard cert | Per-domain cert (HTTP-01) |
| DB | `ingress_aliases` table | `domains` table |
| Complexity | ~200 lines of code | Full feature with validation flow |

Both can coexist. Aliases ship fast and cover the common case. Custom domains come later for production vanity.

---

## Security

- **Alias names are validated** — lowercase DNS labels only, no injection risk.
- **Reserved names blocked** — platform services (`api`, `eve`, `sso`, `registry`, etc.) can't be claimed.
- **DB uniqueness** — `UNIQUE` constraint prevents race conditions in alias claims.
- **No user-controlled DNS** — aliases only work under the platform's wildcard domain.
- **Alias squatting mitigation (day one)** — system admins can reclaim aliases via admin API.
