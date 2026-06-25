# API Response Guideline for Agents

> Status: Required  
> Last Updated: 2026-02-14  
> Applies to: API handlers, CLI integrations, docs authors, and manual test authors

This document is the mandatory contract for API response changes.

## 1) Core Rule

All **collection/list** API responses must be wrapped.

Do not return raw arrays from new or modified API endpoints.

### Canonical list envelope

```ts
{
  data: T[],
  pagination?: {
    total: number;
    limit: number;
    offset: number;
    has_more?: boolean;
    next_offset?: number | null;
  }
}
```

`data` is required for all list responses.

## 2) Single-Resource and Action Endpoints

For non-collection endpoints, use unwrapped single objects when existing behavior already uses this shape.

For new endpoints, prefer:

```ts
{
  data: T;
}
```

but this is optional in phase transitions. Any migration to this convention must be done only as part of a tracked compatibility plan.

## 3) Shared Schema Discipline

1. Every response contract must be defined in `packages/shared/src/schemas`.
2. Use shared schema types in API DTOs/service return contracts.
3. Reuse a shared pagination schema; do not invent one-off pagination keys.
4. Do not add endpoint-specific wrapper keys like `documents`, `versions`, `threads` for list responses.
5. Use `createApiListResponseSchema(...)` / `createApiSingleResponseSchema(...)` from `packages/shared/src/schemas/common.ts`.

## 4) OpenAPI and Documentation Rule

1. Add explicit `@ApiOkResponse(...)` on every endpoint you change.
2. Include the envelope schema in the OpenAPI metadata.
3. Update docs under `docs/system` and impacted manual test scenario docs for any response-shape change.
4. Add example payloads that show `data` and `pagination`.

## 5) CLI and Tooling Rule

1. CLI commands that consume list endpoints must read `data`.
2. Never decode collection responses into arrays without going through a shared unwrapping helper.
3. Add/refresh CLI tests that assert wrapped list decoding.

## 6) Migration/Compatibility Rule

If a change alters response shape:

1. Announce old/new shape and migration rationale in PR description.
2. Keep transitional support only when required and bounded by a deprecation date.
3. Track removal date in this plan and in relevant release notes.
4. Ensure one manual scenario demonstrates the new shape before removing old behavior.

## 7) Required PR Checklist for Agents

Before merge, every API change PR must include:

1. Endpoint inventory with `before/after` response contract.
2. Shared schema file(s) updated.
3. API controller/service signature and return type updated to envelope where applicable.
4. OpenAPI response schema updated.
5. At least one test updated or added for wrapped response contract.
6. Docs or manual scenario update if shape changed.
7. Reference to the deprecation/removal plan when compatibility behavior is kept.

## 8) Anti-Patterns (do not do)

- Returning `Promise<T[]>` for controller/service list responses.
- Using endpoint-specific array keys without `data`.
- Adding pagination with endpoint-specific keys.
- Updating API code without updating API docs and CLI expectations.
- Relying on implicit schema inference for list endpoints.
- Skipping the CI gate: `pnpm check:api-list-responses`.

## 9) Examples

### ✅ Correct list response

```json
{
  "data": [
    { "id": "org_abc", "slug": "acme" }
  ],
  "pagination": {
    "total": 12,
    "limit": 25,
    "offset": 0,
    "has_more": false,
    "next_offset": null
  }
}
```

### ❌ Incorrect list response

```json
[
  { "id": "org_abc", "slug": "acme" }
]
```
