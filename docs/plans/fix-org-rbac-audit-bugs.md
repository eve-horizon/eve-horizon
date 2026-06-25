# Fix Org-Related Bugs Found During RBAC Audit

> **Created**: 2026-02-23
> **Status**: Ready to implement
> **Priority**: P1 — auth correctness bugs affecting multi-org users
> **Triggered by**: Commit 41b5dba (PermissionGuard org context fix, v0.1.144)

## Context

We just fixed a critical bug where the PermissionGuard silently fell to member-level permissions when org context couldn't be derived from a project (commit 41b5dba, deployed as v0.1.144). An audit of the codebase revealed 4 additional bugs in the same family — code that assumes single-org users, swallows "not found" errors, or reads `user.org_id`/`user.role` which are undefined for multi-org users.

## Bugs to Fix

### 1. CRITICAL: Webhooks controller passes empty org_id for multi-org users

**File:** `apps/api/src/webhooks/webhooks.controller.ts:101`
**Pattern:** `request.user?.org_id ?? ''` — reads undefined org_id, falls to empty string, creates webhook with corrupted org_id.
**Fix:** Inject `RbacService`, call `getProjectOrgId(projectId)` to resolve org from the project_id route param (same pattern the PermissionGuard now uses). Also requires adding `AuthModule` import to `webhooks.module.ts`.

**Files:**
- `apps/api/src/webhooks/webhooks.controller.ts` — inject RbacService, replace `request.user?.org_id ?? ''` with `await this.rbacService.getProjectOrgId(projectId)`
- `apps/api/src/webhooks/webhooks.module.ts` — add `imports: [AuthModule]`

### 2. MEDIUM: Dead code with error-swallowing antipattern in RbacService

**File:** `apps/api/src/auth/rbac.service.ts:26-39`
**Pattern:** `getProjectRole` and `getOrgRole` are dead code (zero callers after our PermissionGuard simplification). `getProjectRole` still has the `.catch(() => null)` antipattern.
**Fix:** Delete both methods.

**Note:** `requireOrgRole` (heavily used, 30+ callers) and `requireProjectRole` (2 callers) are separate methods that do NOT call `getOrgRole`/`getProjectRole` — they do their own membership lookups and throw on failure. They remain untouched.

**File:** `apps/api/src/auth/rbac.service.ts` — delete `getOrgRole` (lines 26-29) and `getProjectRole` (lines 31-39)

### 3. MEDIUM: AccessService resolveProject swallows ALL errors

**File:** `apps/api/src/auth/access.service.ts:1097-1111`
**Pattern:** Broad `try { ... } catch { return null; }` catches DB connection errors, timeouts, etc. — not just "not found". Used in `collectUserGrants` where a swallowed error silently drops project-level permission grants.
**Fix:** Remove the try/catch. The `?? null` return already handles the "not found" case. DB errors should propagate as 500s.

**File:** `apps/api/src/auth/access.service.ts` — remove try/catch wrapper from `resolveProject`, keep `?? null` returns

### 4. MEDIUM: /auth/me shows member permissions for multi-org users

**File:** `apps/api/src/auth/auth.controller.ts:68-71`
**Pattern:** `user.role ?? 'member'` defaults to member for multi-org users (where `user.role` is undefined). The `permissions` array then shows member-level permissions while `memberships` correctly shows owner roles — self-contradictory response.
**Fix:** Compute permissions as the union of all membership role expansions. This gives clients the accurate "maximum capability envelope" across all orgs.

**File:** `apps/api/src/auth/auth.controller.ts` — replace role/permissions computation in `me()` method

### 5. MEDIUM: `RbacService.getEffectivePermissions` swallows project lookup failures

**File:** `apps/api/src/auth/rbac.service.ts:75-87`
**Pattern:** `const project = await this.resolveProject(projectId).catch(() => null);` in permission evaluation path.
**Impact:** DB/runtime failures in `resolveProject` are treated as "no project role" and the request continues with org-level role fallback. This hides backend failures and can turn transient infra errors into confusing, inconsistent auth behavior.
**Fix:** Stop swallowing all errors in this path. Use explicit `NotFound` handling only when the project truly does not exist; rethrow other failures so service errors are visible as 500-level auth failures.

**File:** `apps/api/src/auth/rbac.service.ts` — replace the `catch(() => null)` branch in `getEffectivePermissions` with explicit error handling.

### 6. MEDIUM: Managed DB endpoints can resolve empty org_id after project lookup misses

**File:** `apps/api/src/environments/managed-db.service.ts:34,47,76,103`
**Pattern:** `(await this.projects.findById(projectId))?.org_id ?? ''` across all project-scoped managed DB operations.
**Impact:** If a stale or missing project is encountered, tenant lookup silently runs against `''`, producing a misleading no-match `NotFoundException` instead of surfacing the underlying consistency issue.
**Fix:** Introduce a small internal `resolveProjectOrgId(projectId)` helper that throws `NotFoundException` when the project cannot be loaded, then use it in all tenant lookup paths.

**File:** `apps/api/src/environments/managed-db.service.ts` — add helper + replace four inline fallback expressions.

## Not Fixing (by design, not bugs)

- **System controller** `extractUser` reads `user.role` directly — this gates to `org_admin`/`system_admin` which is intentional for platform admin endpoints. Multi-org users who happen to be org admins in one org can't access system endpoints, but `system:read` is an admin-only permission anyway.
- **Inference `ScopedContext`** — `enforceUsageGates` already resolves org from project when orgId is undefined (line 657). Not a bug.
- **Job token project scope** — job tokens carry explicit permissions; the orchestrator controls what permissions jobs get. Project-level scope restriction is a feature consideration, not a bug in the current model.

## Implementation Order

1. Bug 2 (dead code deletion) — zero risk, cleans up before other changes
2. Bug 5 (effective permissions project-lookup failures) — small change before auth correctness regression checks
3. Bug 3 (access service error swallowing) — small, isolated
4. Bug 1 (webhooks org_id) — requires module wiring
5. Bug 4 (auth/me permissions) — most logic, do last
6. Bug 6 (managed-db org_id fallback) — independent service-path hardening

## Verification

1. `pnpm build` — TypeScript compilation (especially webhooks module import)
2. `pnpm test` — all unit tests pass
3. Manual check: `EVE_API_URL=https://api.eve.example.com eve auth whoami --json` — verify permissions field shows owner-level permissions for multi-org users after deploy
4. Tag `release-v0.1.145` and deploy to staging

## Suggested Test Additions

1. `apps/api/src/auth/auth.controller.spec.ts` — add a multi-org `/auth/me` case where `user.role` is undefined and `user.memberships` has mixed roles, asserting unioned permissions.
2. `apps/api/src/auth/rbac.service.ts` unit tests (new spec) for `getEffectivePermissions` — verify DB errors propagate (instead of silently downgrading) and missing project id returns org-level role.
3. `apps/api/src/environments/managed-db.service.ts` unit tests (new spec) for `resolveProjectOrgId` behavior when the project is missing.
