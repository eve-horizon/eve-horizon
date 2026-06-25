# P0 Epic: Production Baseline (Multi-Cloud, Auth, Triggers, Observability)

> Status: Draft
> Last Updated: 2026-01-22
> Purpose: Convert the P0 gap analysis into a deliverable epic plan with cloud-ready deployment,
> optional Supabase auth, and GitHub/Slack triggers.

## Inputs

- docs/plans/agentic-paas-gap-analysis-roadmap.md
- docs/plans/event-driven-pipelines-platform-plan.md
- docs/plans/job-execution-observability-v2.md
- docs/system/deployment.md
- docs/system/events.md
- docs/system/manifest.md
- docs/system/secrets.md
- docs/system/cli-tools-and-credentials.md

## Epic Goal

Deliver a production-ready baseline that can be deployed to AWS with minimal friction, keeps the
platform cloud-agnostic for future GCP/Azure expansion, supports GitHub and Slack triggers,
provides a pluggable auth strategy (Supabase optional), and establishes first-class observability
with cloud-friendly exports.

## Non-goals (P0)

- Full SSO/OIDC multi-IdP support.
- Advanced cron scheduling and trigger schema versioning.
- Auto-remediation without human review.

## Definition of Done (P0)

- AWS deployment overlay exists with docs and an agent-led bootstrap workflow.
- Platform abstractions remain cloud-agnostic (AWS-specific settings isolated in overlays).
- Observability includes logs, metrics, and traces with correlation IDs and OTEL export.
- Auth is mandatory: all API access requires a real user/org context, with RBAC enforcement
  and provider interface with internal JWT + Supabase adapter. P0 login uses GitHub SSH keys
  (challenge/response) only.
- Triggers include GitHub and Slack webhooks with signature verification and event normalization.
- Trigger matching creates pipeline/workflow jobs end-to-end.
- Error events can launch a remediation workflow that produces a PR (GitHub) behind a review gate.
- Integration and E2E tests exercise auth propagation end-to-end, including example project
  OpenAPI resources and RLS-backed access patterns.

## Workstreams

### 1) Cloud-ready deployment packaging (AWS-first, agent-led)

Deliverables:
- Kustomize overlay: `k8s/overlays/aws`
- Skill in `eve-skillpacks` that guides AWS provisioning via standard CLIs + human confirmations
- Docs: `docs/deploy/aws.md` (GCP/Azure deferred)

Tasks:
1. Standardize base manifests to support external services (Postgres, ingress, registry auth).
2. Add AWS overlay for:
   - Ingress controller annotations and load balancer settings
   - Storage class and PVC parameters
   - External DB connection overrides (RDS)
3. Add an agent-led provisioning skill (AWS):
   - Uses `aws`, `kubectl`, `helm`, and `k3d`/EKS CLIs as needed
   - Calls out human steps for secrets and account-level setup
   - Records required inputs and confirmations explicitly
4. Document minimal install path and smoke checks using `eve system health`.

### 2) Observability foundation with cloud exports

Deliverables:
- Correlation IDs across API -> Orchestrator -> Worker -> Runner
- Structured JSON logs with `job_id`, `event_id`, `trace_id`
- OTEL instrumentation and exporter config
- Optional OTEL collector manifests per cloud

Tasks:
1. Define a shared correlation header and propagate it through internal calls and job metadata.
2. Implement lifecycle logging from `docs/plans/job-execution-observability-v2.md`.
3. Add OTEL SDK to API/orchestrator/worker:
   - HTTP and DB traces
   - Metrics for queue latency, job duration, error counts
4. Add OTEL exporter config:
   - Default `OTEL_EXPORTER_OTLP_ENDPOINT`
   - Cloud preset for AWS (X-Ray/CloudWatch)
5. Provide AWS-ready collector configs and docs (GCP/Azure later).

### 3) Auth and governance (mandatory auth, Supabase optional)

Deliverables:
- User + org/project membership model
- RBAC enforcement across API
- Auth provider interface with `internal` and `supabase` adapters
- CLI auth flow works with either provider
- Tests and docs for auth propagation across API, jobs, and app resources

Tasks:
1. Add core tables: users, identities, memberships, roles.
2. Implement RBAC middleware and policy checks for API endpoints.
3. Define `AuthProvider` interface:
   - Issue/verify token
   - User lookup
   - Optional refresh
4. Implement `internal` provider:
   - RS256 JWT with key rotation support (public/private key)
   - GitHub SSH key login only (challenge/response)
5. Implement `supabase` adapter:
   - Accept Supabase JWT for auth
   - Keep CLI support for `--supabase-url` and `--supabase-anon-key`
6. Enforce mandatory auth:
   - Reject unauthenticated requests across all API routes (except auth bootstrap)
   - Ensure job execution, event ingestion, and trigger matching preserve auth context
7. Update docs and CLI config to make Supabase optional, not required.
8. Add integration/E2E coverage:
   - Real user/org creation and token issuance in test setup
   - Auth propagation across pipelines/workflows/jobs
   - Example project OpenAPI resources and RLS-backed access checks

#### GitHub SSH Login Flow (P0)

1. CLI requests a challenge: `POST /auth/challenge` with email or user id.
2. API returns `challenge_id` + nonce.
3. CLI signs the nonce with the user's GitHub SSH key:
   - `ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n eve-auth <nonce>`
4. CLI posts signature: `POST /auth/verify` with `challenge_id` + signature.
5. API verifies against stored public keys and issues RS256 JWT.

#### Admin Bootstrap + Org Setup (P0)

- **Admin bootstrap:** API is started with a one-time `EVE_BOOTSTRAP_TOKEN`. The first admin
  is created via `POST /auth/bootstrap` (token + public key + email). After success, bootstrap
  is disabled.
- **Org setup:** the admin creates the first org and becomes owner. Org owners can create
  projects and invite members with roles (owner/admin/member).
- **Org creation + ownership:** `POST /orgs` creates the org and inserts an owner membership
  for the caller in the same transaction. Admins can pass `owner_user_id` to create orgs
  for other users. Additional owners are added via `POST /orgs/:id/members` with `role=owner`.
- **No default org:** all usage requires explicit org creation and membership assignment.
- **Local dev automation:** provide a no-friction bootstrap path for developers (single command)
  that creates the admin user, issues a token, and creates a default org/project for the caller.

## Auth Propagation Test Plan (Concrete Cases)

Integration tests (API + local runtime):
1. **Auth required**: unauthenticated requests to protected endpoints return 401.
2. **User/org bootstrap**: create user + org + membership; token issued and accepted.
3. **RBAC enforcement**: role-limited user cannot access another org/project.
4. **Event ingestion**: `POST /projects/:id/events` stores actor context and rejects missing auth.
5. **Trigger → job**: event creates run/jobs with actor/user metadata preserved.
6. **OpenAPI access**: example project OpenAPI resource requires auth and respects org scoping.
7. **RLS-backed resource**: access to PostgREST/Supabase-style endpoint is limited to org/user context.

E2E tests (stack/runtime):
1. **CLI login + context**: authenticate via GitHub SSH key challenge, set org/project,
   and verify `eve system health` requires auth.
2. **Deploy example project**: create org/project and deploy with authenticated token.
3. **OpenAPI + RLS smoke**: call example OpenAPI endpoint with token and verify RLS scoping.
4. **Webhook event**: GitHub/Slack event triggers run with preserved actor metadata.
5. **Job logs**: verify job/attempt metadata includes actor info for traceability.

Docs:
- Document the auth propagation flow with diagrams and example CLI/API calls.
- Document the RLS expectation and example queries for the sample project.

### 4) Triggers and automation (GitHub + Slack)

Deliverables:
- GitHub webhook verification and event normalization
- Slack webhook endpoint and verification
- Event router creates pipeline/workflow jobs
- Manifest triggers support Slack events

Tasks:
1. Implement GitHub webhook signature verification (`X-Hub-Signature-256`).
2. Add Slack integration controller:
   - URL verification handshake
   - Signature verification (`X-Slack-Signature`, `X-Slack-Request-Timestamp`)
   - Map events to `slack.*` types
3. Extend event schema/manifest trigger spec for Slack events (Events API only).
4. Update orchestrator router to create pipeline/workflow jobs from matched triggers.
5. Ensure event payload, ref, and actor metadata propagate into job input.
6. Add integration tests for GitHub and Slack events + trigger matches.

### 5) Agentic remediation baseline (PR-producing)

Deliverables:
- Error taxonomy and event emission for job/pipeline failures
- Remediation workflow template that creates a PR
- Review gate for PR output

Tasks:
1. Emit `system.job.failed` and `system.pipeline.failed` events with error codes.
2. Add `create-pr` action for GitHub PR creation (token or app auth).
3. Provide a sample remediation workflow in docs and tests.
4. Ensure remediation runs are gated for human review.

## Milestones (Suggested)

1. Decisions: auth provider interface, internal auth choice, OTEL exporter strategy, cloud overlay format.
2. Foundations: membership model, RBAC enforcement, mandatory auth gates, correlation IDs, event router job creation.
3. Integrations: GitHub verification, Slack triggers, PR action.
4. Cloud packaging: AWS overlay, AWS collector configs, deploy docs, agent skill.
5. Validation: auth propagation integration/E2E tests, OpenAPI/RLS checks, cloud smoke tests.

## Risks and Mitigations

- Cloud vendor differences: keep core manifests generic; isolate in overlays.
- Auth scope creep: limit P0 to provider interface + two adapters.
- Observability overhead: make OTEL optional and non-blocking when not configured.
- Webhook security: strict signature verification and replay protection.
- Agent-led provisioning drift: define a skill-driven checklist with explicit confirmations.
- Auth-required tests instability: define a shared test bootstrap for user/org creation and tokens.

## Decisions (Locked for P0)

1. Auth uses RS256 JWT (public/private key) and GitHub SSH key login only.
2. Slack triggers use Events API only (no slash commands in P0).
3. Packaging is Kustomize-only (Helm deferred).
4. AWS target is single-node VPS (k3s), with EKS compatibility kept in overlays and docs.

## Suggested Beads Breakdown

- Epic: P0 production baseline
- Tasks per workstream aligned to API/orchestrator/worker/shared/infra/docs ownership.
