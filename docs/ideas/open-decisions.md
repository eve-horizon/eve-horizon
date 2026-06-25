# Open Decisions and Work Needed

This doc captures the outstanding decisions and TODOs discovered during a repo scan.
Each item lists concrete options with pros/cons so we can close decisions quickly.

## API Error Envelope Standardization
- **Decision**: Adopt a standard error envelope for all API errors.
- **Options**:
  - **A: Keep NestJS default error shape**
    - **Pros**: No migration; minimal code changes.
    - **Cons**: Inconsistent error responses; harder client UX; docs drift.
  - **B: Introduce explicit `error` envelope (code, message, details, request_id)**
    - **Pros**: Stable contract; improved CLI/DX; easier observability.
    - **Cons**: Requires migration of controllers/filters; test updates.
- **Recommendation**: Option B.
- **Status**: Open

## Soft-Delete Semantics
- **Decision**: Use boolean `deleted` vs `deleted_at` timestamps.
- **Options**:
  - **A: Keep boolean `deleted`**
    - **Pros**: Simple; no migration.
    - **Cons**: No deletion timeline; harder audits/analytics.
  - **B: Migrate to `deleted_at` timestamp (plus optional `deleted_by`)**
    - **Pros**: Audit-friendly; supports retention policies.
    - **Cons**: Requires migration + query updates.
- **Recommendation**: Option B (with backward-compatible reads if needed).
- **Status**: Open

## Registry-Based Image Deployment
- **Decision**: How to move from `--tag local` to registry-based deploys.
- **Options**:
  - **A: Worker builds and pushes to registry (per job)**
    - **Pros**: Single control plane; consistent behavior.
    - **Cons**: Requires registry auth in workers; longer job times.
  - **B: CI builds and pushes; Eve only deploys digests**
    - **Pros**: Faster deploys; clearer provenance.
    - **Cons**: Requires external CI orchestration; more config.
  - **C: Hybrid (CI for prod, worker for dev)**
    - **Pros**: Best of both; dev speed.
    - **Cons**: More complexity in policy/UX.
- **Recommendation**: Option C (explicit env policy).
- **Status**: Open

## Production Domain Configuration
- **Decision**: How production domains are configured and validated.
- **Options**:
  - **A: Global env var + static template**
    - **Pros**: Simple.
    - **Cons**: Limited multi-tenant flexibility.
  - **B: Org/project-level domain config stored in DB**
    - **Pros**: Flexible; supports custom domains.
    - **Cons**: Requires UI/CLI + validation; more moving parts.
  - **C: Per-environment domain config**
    - **Pros**: Max flexibility for staging/preview domains.
    - **Cons**: More config surface area.
- **Recommendation**: Option B (with fallback to global default).
- **Status**: Open

## Orchestrator Concurrency Tuning
- **Decision**: Rollout plan for multi-job concurrency and auto-tuning.
- **Options**:
  - **A: Fixed concurrency only**
    - **Pros**: Predictable; easier to reason about.
    - **Cons**: Under/over-utilization.
  - **B: Enable tuner by default with conservative bounds**
    - **Pros**: Better throughput; adaptive.
    - **Cons**: More complex behavior; needs observability.
  - **C: Feature-flag per environment**
    - **Pros**: Safe rollout.
    - **Cons**: Adds config paths to maintain.
- **Recommendation**: Option C (limit to internal stacks first).
- **Status**: Open

## Attempt Continue Semantics
- **Decision**: What `POST /jobs/:job_id/attempts/:att_num/continue` should do.
- **Options**:
  - **A: Create a new attempt with appended input**
    - **Pros**: Clear audit trail; consistent with retry semantics.
    - **Cons**: Requires DB/API changes; more orchestration.
  - **B: Update existing attempt input/logs and re-run**
    - **Pros**: Simpler mental model for “continue”.
    - **Cons**: Mutates history; muddier auditability.
  - **C: Deprecate continue; use new job instead**
    - **Pros**: Simplifies model; fewer special cases.
    - **Cons**: Breaks existing clients; needs migration guidance.
- **Recommendation**: Option A.
- **Status**: Open

## Workspace Reuse Strategy
- **Decision**: How to implement workspace reuse safely.
- **Options**:
  - **A: No reuse (current)**
    - **Pros**: Clean isolation.
    - **Cons**: Slow; repeated clones.
  - **B: Reuse per job with TTL + cleanup**
    - **Pros**: Faster; controlled scope.
    - **Cons**: Cache invalidation; disk management.
  - **C: Shared cache across jobs (content-addressed)**
    - **Pros**: Fastest; most efficient.
    - **Cons**: Complexity; risk of cross-job leaks.
- **Recommendation**: Option B (per-job reuse + explicit cleanup policy).
- **Status**: Open (bookkeeping added; still no reuse behavior).

## Deployment Status Accuracy
- **Decision**: Replace placeholder deployment status (`release-stub`).
- **Options**:
  - **A: Use `environment.current_release_id`**
    - **Pros**: Cheap; already stored.
    - **Cons**: May lag k8s state.
  - **B: Query k8s + correlate to release metadata**
    - **Pros**: Accurate; better UX.
    - **Cons**: Needs mapping; more queries.
- **Recommendation**: Option B.
- **Status**: In progress (now uses `current_release_id` + k8s readiness; still missing release metadata correlation).

## OAuth Refresh Testing Strategy
- **Decision**: Where to test OAuth token refresh in the new job model.
- **Options**:
  - **A: Full integration test (orchestrator + worker + harness)**
    - **Pros**: End-to-end confidence.
    - **Cons**: Slow; more infra complexity.
  - **B: Harness-level tests only**
    - **Pros**: Faster; narrower scope.
    - **Cons**: Less coverage of API/orchestrator integration.
  - **C: Hybrid (unit/harness + one smoke integration)**
    - **Pros**: Balanced signal/cost.
    - **Cons**: Still requires some infra.
- **Recommendation**: Option C.
- **Status**: Open (suite skipped pending full pipeline tests).

## Release Attribution (`created_by`)
- **Decision**: How to populate `release.created_by` and similar audit fields.
- **Options**:
  - **A: Leave null until auth context exists**
    - **Pros**: No changes now.
    - **Cons**: Permanent audit gaps for early data.
  - **B: Populate from request auth context when available**
    - **Pros**: Accurate attribution; consistent auditing.
    - **Cons**: Requires plumbing user/org context through services.
  - **C: Backfill with system actor for non-auth paths**
    - **Pros**: Clear audit trail even for automation.
    - **Cons**: Requires defining system actor semantics.
- **Recommendation**: Option B + C (use real user when available, fallback to system actor).
- **Status**: Open

## OpenAPI Export DB Stub (Intentional)
- **Decision**: Keep a stub DB client when `EVE_OPENAPI_EXPORT=1` to avoid accidental DB access during schema export.
- **Rationale**: Prevents side effects and makes OpenAPI generation safe in CI and docs tooling.
- **Status**: Decided (intentional; no further action).

## Internal API Auth Strategy
- **Decision**: How internal service-to-service API calls are authenticated.
- **Options**:
  - **A: Shared `EVE_INTERNAL_API_KEY` (current)**
    - **Pros**: Simple; low overhead.
    - **Cons**: Hard to rotate; broad blast radius if leaked.
  - **B: Per-service tokens (rotated)**
    - **Pros**: Smaller blast radius; clearer ownership.
    - **Cons**: More config/ops overhead.
  - **C: JWT-based service identities**
    - **Pros**: Strongest auditability; short-lived tokens.
    - **Cons**: Requires signing infra and key rotation.
- **Recommendation**: Option B (short term), Option C (long term).
- **Status**: Open

## User/System Secrets Access Control
- **Decision**: Enforce ownership + admin-only access for sensitive secret scopes.
- **Options**:
  - **A: Add ownership checks for user secrets; admin-only system secrets**
    - **Pros**: Secure by default; minimal API surface change.
    - **Cons**: Requires RBAC plumbing in controllers.
  - **B: Remove user-scope secret APIs until proper auth is ready**
    - **Pros**: Eliminates risk; reduces complexity.
    - **Cons**: Breaks potential workflows relying on user-scoped secrets.
  - **C: Allow any authenticated user (current)**
    - **Pros**: Zero work now.
    - **Cons**: Security gap; not production-safe.
- **Recommendation**: Option A (or B if auth context is incomplete).
- **Status**: Open

## Rate Limiting Strategy
- **Decision**: Where and how to apply rate limits.
- **Options**:
  - **A: API-level middleware (NestJS global rate limit)**
    - **Pros**: Fine-grained; code-defined; testable.
    - **Cons**: Adds overhead per request.
  - **B: Ingress/proxy-only limits**
    - **Pros**: Centralized; no app code changes.
    - **Cons**: Harder per-route tuning; opaque in dev.
  - **C: Hybrid (proxy baseline + API hot routes)**
    - **Pros**: Best coverage.
    - **Cons**: More moving parts.
- **Recommendation**: Option C.
- **Status**: Open

## CORS Policy
- **Decision**: Explicit CORS behavior per environment.
- **Options**:
  - **A: Explicit allowlist per environment**
    - **Pros**: Secure; predictable.
    - **Cons**: Config overhead.
  - **B: Wildcard in dev, allowlist in prod**
    - **Pros**: Dev-friendly; production-safe.
    - **Cons**: Requires env-aware config.
  - **C: Ingress-managed only**
    - **Pros**: Central control.
    - **Cons**: Less visibility at app layer.
- **Recommendation**: Option B.
- **Status**: Open

## Job Timeout Strategy
- **Decision**: Use hard timeouts only or activity-based detection.
- **Options**:
  - **A: Hard timeout only (current)**
    - **Pros**: Simple and predictable.
    - **Cons**: Kills long but active jobs.
  - **B: Activity-based timeout + max duration**
    - **Pros**: Better for long-running active jobs.
    - **Cons**: More complex; needs activity signal.
  - **C: Hybrid defaults per job type**
    - **Pros**: More tailored behavior.
    - **Cons**: More config surface.
- **Recommendation**: Option B or C (depending on activity signal availability).
- **Status**: Open
