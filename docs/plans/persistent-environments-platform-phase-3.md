# Persistent Environments Platform - Phase 3 Overview

> Status: Draft
> Last Updated: 2026-01-21
> Breaking changes are expected and encouraged. Delete or refactor any code that does not conform to this plan.

Phase 3 splits into two tightly linked streams:

1) **DB + REST API Sources**: Make the environment database first-class and use normal REST patterns
   (OpenAPI, PostgREST, Supabase GraphQL) as the source of app capabilities.
2) **Workflows**: Agent workflows with request/response semantics and explicit outputs.

These are separate plans for clarity, but share a single auth story: a user-initiated workflow/job must
preserve the user context end-to-end (CLI, API, and DB RLS).

**Plan docs**
- `docs/plans/persistent-environments-platform-phase-3-db-api.md`
- `docs/plans/persistent-environments-platform-phase-3-workflows.md`

**Key linking principle**
- Workflows call app APIs using the initiating user context.
- All responses in request/response workflows use `json-result`.

**Why split**
- DB + API is infrastructure (migration, introspection, auth propagation).
- Workflows are execution semantics (agent job model + response contract).
- They can ship independently but must converge on auth and context.
