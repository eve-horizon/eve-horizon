# OpenAPI (Code-First)

> Status: Current
> Last Updated: 2026-02-12
> Purpose: Describe the code-first OpenAPI pipeline and source-of-truth spec export.

Eve Horizon uses code-first OpenAPI generated from NestJS controllers and Zod schemas.
The spec is the source of truth for requests/responses and is rendered by Swagger UI. It is the contract the CLI and any future UI must follow.

Recent additions captured in the exported spec include:

- Auth web endpoints (`/auth/config`, `/auth/exchange`, `/auth/supabase/invite`, `/auth/token/verify`)
- Providers + model discovery (`/providers`, `/providers/:name/models`, `/models`)
- Pricing + billing admin endpoints (`/admin/pricing/*`, `/admin/orgs/:id/usage`)
- Job attachments and receipts (`/jobs/:id/attachments`, `/jobs/:id/receipt`)
- Org analytics (`/orgs/:org_id/analytics/*`)
- Webhook subscriptions and replays (`/orgs/:org_id/webhooks`, `/projects/:project_id/webhooks`)

## Current (Implemented)

- Runtime Swagger UI + JSON/YAML endpoints.
- Zod schemas as source of truth for validation and OpenAPI generation.
- Exported specs checked into `docs/system/`.
- The CLI is a thin REST client and should align with this contract (see [`packages/cli/README.md`](../../packages/cli/README.md)).

## Planned (Not Implemented)

- Versioned specs and changelog enforcement in CI.
- Contract tests against the exported spec.

## Legacy (Removed)

- Hand-written OpenAPI JSON.

## Where It Lives

- Swagger UI: `http://localhost:4801/docs`
- OpenAPI JSON: `http://localhost:4801/openapi.json`
- OpenAPI YAML: `http://localhost:4801/openapi.yaml`

The setup is in `apps/api/src/main.ts` and uses NestJS Swagger to generate the
spec at runtime.

## How It Stays In Sync

- **Validation** stays in Zod (`ZodValidationPipe`).
- **OpenAPI schemas** are derived from those same Zod schemas via
  `zodSchemaToOpenApi` in `apps/api/src/openapi.ts`.
- **Controllers** add Swagger decorators (`@ApiBody`, `@ApiResponse`, `@ApiParam`).

The result: one schema definition per request/response, used for both validation
and OpenAPI docs.

## Exporting a Source-of-Truth Spec

Generate a checked-in spec file under `docs/system/`:

```bash
pnpm --filter @eve/api build
pnpm --filter @eve/api openapi:export
```

The export script sets `EVE_OPENAPI_EXPORT=1` and `EVE_AUTH_ENABLED=false` by default,
so it can run without a running API service or database connection.

## Notes

- Job endpoints include explicit request/response schemas; exported specs should now be authoritative.

This writes `docs/system/openapi.json` and `docs/system/openapi.yaml`.

## Adding or Updating an Endpoint

1. Define/extend the Zod schema in `packages/shared/src/schemas`.
2. Use `ZodValidationPipe` in the controller to validate the request.
3. Add Swagger decorators that reference the Zod schema with
   `zodSchemaToOpenApi`.

Example:

```ts
@Post()
@HttpCode(HttpStatus.CREATED)
@ApiOperation({ summary: 'Create a job in a project' })
@ApiParam({ name: 'project_id', type: String })
@ApiBody({ schema: zodSchemaToOpenApi(CreateJobRequestSchema, 'CreateJobRequest') })
@ApiCreatedResponse({
  schema: zodSchemaToOpenApi(CreateJobResponseSchema, 'CreateJobResponse'),
})
async create(
  @Param('project_id') projectId: string,
  @Body(new ZodValidationPipe(CreateJobRequestSchema)) body: CreateJobRequest,
): Promise<CreateJobResponse> {
  return this.jobsService.create(projectId, body);
}
```

## Notes

- Avoid hand-written OpenAPI JSON. Controllers + Zod schemas are the source.
- When a response shape changes, update the Zod response schema alongside the
  service change so OpenAPI stays accurate.
