# API Response Standardization and Compliance Plan

> Status: In Progress  
> Last Updated: 2026-02-14  
> Owners: API Platform Team, CLI Platform Team  
> Scope: `apps/api`, `packages/shared`, `packages/cli`, `tests/manual`

## Problem

API response shapes are not consistent today:

- Some endpoints return wrapped list payloads with metadata.
- Some endpoints still return raw arrays.
- Multiple wrapper shapes (`data`, `documents`, `threads`, etc.) coexist across modules.

This creates avoidable ambiguity for API consumers, CLI consumers, docs, and manual test scripts.

## Objective

Standardize all API responses used for collection/list endpoints to a single envelope shape, with a documented migration plan and enforcement workflow for future API work.

## Target Contract (Phase 1)

For **all list endpoints**, responses must be one object with:

```ts
{
  data: T[],
  pagination?: {
    total: number;
    limit: number;
    offset: number;
    has_more?: boolean;
    next_offset?: number | null;
  };
}
```

For **single-resource endpoints**, prefer:

```ts
{
  data: T;
}
```

No new endpoint should return bare arrays.

## Success Criteria

- No collection endpoint returns `Promise<...[]>` in API controller/service signatures.
- Shared schema coverage includes a canonical list wrapper in `packages/shared`.
- Every migrated endpoint includes OpenAPI `ApiOkResponse` that documents the envelope.
- CLI and integrations handle the envelope uniformly and do not deserialize arrays directly from collection endpoints.
- Manual/API docs are updated to show the canonical wrapper format.

## Migration Scope

- `apps/api/src/resources/resources.controller.ts`
- `apps/api/src/auth/auth.service-principals.controller.ts`
- `apps/api/src/auth/auth.access-requests.controller.ts`
- `apps/api/src/auth/auth.access-roles.controller.ts`
- `apps/api/src/webhooks/webhooks.controller.ts`
- Any additional collection endpoint returning arrays in controllers and service layers.

## Implementation Status (2026-02-14)

| Area | Status | Notes |
| --- | --- | --- |
| Phase 0 – Inventory | Done | Identified raw-array list responses in auth/resources/webhooks (+ auth invites). |
| Phase 1 – Shared contract layer | Done | Added canonical list/single helpers + pagination shape in `packages/shared/src/schemas/common.ts`. |
| Phase 2 – API module migrations | Done (initial scope) | Migrated list endpoints in resources, auth service-principals, auth access-requests, auth access-roles, auth invites, webhooks. |
| Phase 3 – Contract propagation | Done (initial scope) | Updated CLI list decoding helpers and docs/manual references for affected endpoints. |
| Phase 4 – Enforcement | Done (controller gate) | Added CI contract check to block raw-array list responses in API controllers. |

## Migration Phases

### Phase 0 – Inventory and Baseline

1. Build a complete endpoint inventory and classify:
   - Wrapped vs raw arrays.
   - Pagination behavior currently present.
   - Consumer surface (CLI/manual tests/skill workflows affected).
2. Add a short status section in this plan with per-module completion tracking.

### Phase 1 – Shared Contract Layer

1. Add canonical shared schemas in `packages/shared/src/schemas`:
   - `ApiListResponseSchema<T>`
   - `ApiSingleResponseSchema<T>`
   - Common pagination schema used by all list responses.
2. Export types in the shared package index.
3. Update skillpack/API reference docs where response contracts are referenced.

### Phase 2 – API Module Migrations

For each affected endpoint:

1. Introduce canonical response object in DTO/schema.
2. Update service method return types to envelope form.
3. Update controller method return types and `@ApiOkResponse(...)`.
4. Update or add tests to validate:
   - envelope shape is always present,
   - wrapper has stable property names,
   - pagination fields match query input/output.
5. Add a temporary compatibility shim only for CLI/manual scripts if required for the rollout window.

### Phase 3 – Contract Propagation

1. Update API docs for every migrated endpoint (`docs/system`, `docs/plans` references).
2. Update `tests/manual/README.md` and manual scenario files that assert response shape.
3. Update CLI command decoding paths that call list endpoints.
4. Add/refresh smoke checks to cover one wrapped list response per major domain.

### Phase 4 – Enforcement

1. Add static checks in CI to flag `Promise<...[]>` return signatures in API controllers/services.
2. Add review checklist (below) as mandatory for every API change PR.
3. Set deprecation/removal date for compatibility shims.

## Compatibility Strategy

Because this is a contract migration, use a two-step rollout:

- Step A: new canonical envelope responses are introduced while accepting old shape for read paths where strictly necessary.
- Step B: consumers migrate to envelope parsing.
- Step C: remove temporary acceptance once manual/CLI/testware coverage confirms full adoption.

The migration date and shim deprecation dates are owned by the PRDs for each domain, with the API Platform lead providing the final cutoff.

## Rollback Strategy

If migration breaks critical flows:

1. Pause rollout after current phase.
2. Keep shim enabled for affected endpoint groups only.
3. Patch impacted CLI/manual consumers first, then re-enable next endpoint group.
4. Document the issue and update migration sequence before continuing.

## Governance

All future API changes must follow the guideline below before merge:

- `docs/plans/api-response-guideline.md` (new)
- Shared schema type is defined before implementation changes.
- Response contract change is reflected in API docs and manual/CLI references.

## Open Questions

- Should `pagination` use cursor-based fields (`cursor`, `next_cursor`) instead of limit/offset for new endpoints?
- Which compatibility period is acceptable for raw-array transitional support in production clients?
- Should single-resource responses also switch to `{ data: T }` by default in Phase 2?
