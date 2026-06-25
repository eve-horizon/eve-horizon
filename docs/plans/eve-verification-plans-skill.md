# Plan: `eve-verification-plans` Skill

> **Status**: Draft
> **Location**: `../eve-skillpacks/eve-se/eve-verification-plans/`
> **Pack**: `eve-se` (platform-specific SE — verifying Eve-platform conformance)

## Problem

Eve-compatible apps follow a specific engineering philosophy: thin CLI over REST API with full CLI parity, Eve-managed DB migrations, SSO-integrated UIs testable via Playwright, agent-native design with optimized jobs and pipelines. Many apps also accept uploaded inputs (documents, media, CSVs, screenshots, config bundles) that need deterministic fixture files to verify properly. Verifying an app conforms to all of this requires structured, repeatable test plans.

Today, agents improvise verification from scratch each time. The eve-horizon-2 `tests/manual/` format is battle-tested but platform-internal — there's no transferable skill that teaches agents how to build comprehensive verification plans for arbitrary Eve-compatible apps that assert conformance to the Eve way of engineering.

## What This Skill Teaches

How to author **agentic verification plans** — markdown documents that fully specify the steps required to verify that an Eve-compatible app works correctly AND conforms to Eve platform conventions, actionable by either a human or an agent.

This is platform-specific SE, not generic testing methodology. The skill encodes the Eve verification philosophy:

1. **CLI parity** — every REST API endpoint is exercisable through the CLI; verify both paths
2. **REST-first service layer** — all functionality exposed via API, tested via `curl` + `eve` CLI
3. **Eve-managed infrastructure** — DB migrations, secrets, pipelines work the Eve way
4. **Fixture readiness** — any scenario that uploads or imports files includes deterministic, repo-local fixtures or generator scripts
5. **Agent-native testability** — agents can verify the app completely without human intervention
6. **UI conformance** — frontends are SSO-integrated, dark/light mode compatible, Playwright-testable
7. **Agent/job optimization** — agents reach their goal efficiently; pipelines are lean
8. **Deploy cycle awareness** — verification spans the fix/deploy loop (cloud default, k3d fallback)

## Design Decisions

### Skill location: `eve-se/eve-verification-plans/`

This is platform SE — it verifies that apps conform to Eve conventions, not just that they "work." It belongs alongside `eve-deploy-debugging`, `eve-pipelines-workflows`, and `eve-troubleshooting` — skills that encode how to build and operate on the Eve platform correctly.

### Default file structure: `./e2e-verification/`

Test plans live in the project repo, not in a central location:

```
<project-root>/
  e2e-verification/
    README.md
    00-smoke/
      00-smoke-test-plan.md
    01-auth-flow/
      01-auth-flow-test-plan.md
      fixtures/
        README.md
        test-user.json
    02-document-ingest/
      02-document-ingest-test-plan.md
      fixtures/
        README.md
        source-notes.md
        sample-document.pdf
        sample-import.csv
        scripts/
          make-fixtures.sh
```

**Numbering convention**: `NN-kebab-name/` directories, matching `NN-kebab-name-test-plan.md` inside. Numbering implies execution order (smoke first, complex flows later). Gaps are fine — they allow insertion without renaming.

**Fixture convention**: every scenario that depends on uploaded or imported inputs gets a sibling `fixtures/` directory. `fixtures/README.md` records provenance, generation steps, expected MIME/type characteristics, and any reasons a fixture is synthetic rather than sourced.

### Default target: remote cloud cluster (staging)

Most verification happens against the deployed staging environment, not local k3d. This matches the real user experience. The plan format includes environment-awareness so the same plan works against either target with explicit callouts for differences.

### Six verification dimensions

Every Eve-compatible app has up to six dimensions to verify. The skill teaches agents to cover all applicable ones:

| Dimension | Tool | When | Eve Conformance Check |
|-----------|------|------|-----------------------|
| **Platform conformance** | Eve CLI + manifest inspection | Always | CLI parity, manifest conventions, secrets model |
| **Service layer** | Eve CLI + REST API (`curl`, `eve` commands) | Always | Every endpoint reachable via CLI; no kubectl needed |
| **Input / ingestion surfaces** | Repo fixtures + generators + upload commands | When app accepts files, docs, media, imports, or screenshots | Inputs are deterministic, agent-available, and exercise real parsing/storage flows |
| **Data layer** | Eve CLI + DB migrations | When app has DB | Migrations run via Eve pipeline, not manual SQL |
| **UI / visual** | Playwright or `agent-browser` (via SSO token) | When frontend exists | SSO login works, dark/light mode, agent-testable |
| **Agent behavior** | `eve job follow` + `eve-agent-optimisation` | When app has agents | Agents complete efficiently, pipelines are lean |

### Fixture-first verification discipline

Fixtures are not optional support material. For upload/import scenarios, the fixture set is part of the verification plan itself.

- **Prefer repo-local fixtures** — use small checked-in files under `e2e-verification/<scenario>/fixtures/` whenever possible.
- **Manufacture when needed** — if the repo lacks the right sample files, generate deterministic fixtures with a committed script or documented commands and store the outputs alongside the plan when they are small enough.
- **Record provenance** — every fixture set includes `fixtures/README.md` describing where files came from, how they were generated, which scenario uses them, and any licensing or sensitivity notes.
- **Use synthetic or public-domain content only** — never depend on production customer documents, private data, or copyrighted inputs of unclear provenance.
- **Cover the real acceptance surface** — include at least one valid "happy path" input per accepted file class, plus negative/boundary fixtures when validation behavior matters.
- **Keep fixtures agent-friendly** — file names, formats, and setup must be executable by an agent without web searches or manual preparation.

### Eve conformance checklist (encoded in smoke scenario)

Every verification suite starts by asserting the app follows Eve conventions:

- [ ] `.eve/manifest.yaml` exists and passes `eve project sync --dry-run`
- [ ] Manifest follows current conventions (`name` preferred; legacy `project` tolerated but flagged)
- [ ] All services have health endpoints reachable via Eve ingress
- [ ] CLI can interact with every API endpoint (no "UI-only" functionality)
- [ ] Secrets are managed via `eve secrets`, not hardcoded or env-file-based
- [ ] DB migrations run as pipeline steps, not manual scripts
- [ ] Agents (if any) are defined in `agents.yaml` with harness profiles
- [ ] Pipelines (if any) are defined in manifest and runnable via `eve pipeline run`
- [ ] Frontend (if any) authenticates via Eve SSO, not custom auth
- [ ] Upload/import flows (if any) have deterministic fixtures checked in or generated locally

## Skill Structure

```
eve-verification-plans/
  SKILL.md                           # Main skill (~3500 words)
  references/
    test-plan-format.md              # Detailed format specification
    eve-conformance-checks.md        # The Eve way — what to verify and why
    fixture-patterns.md              # How to source, generate, and document fixtures
    deploy-cycle-patterns.md         # Fix/deploy cycle for cloud vs local
    ui-verification-patterns.md      # Browser automation + SSO auth patterns
    agent-verification-patterns.md   # Agent optimization integration
  templates/
    00-smoke-test-plan.md            # Starter smoke + conformance template
    scenario-test-plan.md            # General scenario template
    upload-ingest-test-plan.md       # Input-heavy scenario template with fixture matrix
```

## SKILL.md Outline

### 1. When to Use
- Building verification for a new Eve-compatible app
- Auditing an existing app for Eve-platform conformance
- After significant feature work that needs structured validation
- Before handoff — proving the app works the Eve way, end to end
- When onboarding a new team to understand what "correctly built on Eve" looks like

### 2. The Verification Plan Format

A test plan is a markdown document with this structure:

```markdown
# Scenario NN: <Name>

**Time:** ~Nm
**Environment:** staging | local | both
**Parallel Safe:** Yes/No
**Requires:** LLM | Browser | None

<one-paragraph description of what this scenario verifies>

## Prerequisites

- What must be true before running
- Required secrets, auth, prior scenarios

## Fixtures

- Fixture file paths used by this scenario
- Provenance or generation command for each fixture
- Why these files are representative

## Setup

```bash
# Environment detection + auth
# Project/org setup
# Fixture validation or generation
```

## Phases

### Phase 1: <Name>

```bash
# Commands to execute
```

**Expected:**
- Bullet list of assertions
- Each assertion is pass/fail verifiable

### Phase 2: ...

## Success Criteria

- [ ] Checkboxes for every pass/fail assertion
- [ ] Grouped by phase

## Debugging

| Symptom | Diagnostic | Fix |
|---------|-----------|-----|
| ... | ... | ... |

## Cleanup

```bash
# Teardown commands
```
```

Key format rules:
- **Environment-aware**: Every plan starts with environment detection (`EVE_API_URL` determines cloud vs local, scheme, domain)
- **Self-contained**: No assumed state beyond documented prerequisites
- **Fixture-explicit**: Every uploaded/imported artifact is either checked in or generated from documented commands
- **Phased**: Break into phases that can be run independently (parallel where safe)
- **Assertion-driven**: Every step has explicit `Expected:` with pass/fail criteria
- **Debuggable**: Troubleshooting section with symptom → diagnostic → fix

### 3. Platform Conformance Verification

Before testing functionality, verify the app is built the Eve way:

- **Manifest** — `eve project sync --dry-run` succeeds; services, environments, pipelines declared
- **CLI parity** — every REST endpoint the app exposes has a corresponding CLI command or is testable via `eve` primitives; no "click this button in the UI" only flows
- **Secrets** — all credentials managed via `eve secrets set/import`, not `.env` files or hardcoded values
- **Migrations** — DB schema changes run as pipeline steps via Eve, not manual `psql` or ORM CLI
- **Ingress** — services reachable via Eve-managed ingress (mechanical + vanity aliases if configured)
- **Auth** — app authenticates via Eve SSO; tokens mintable via `eve auth mint`

### 4. Service Layer Verification

Test every API surface the app exposes, CLI-first:

- **CLI-first**: Use `eve` CLI commands where they exist (deploy, env, job, secrets)
- **App CLI**: If the app has its own CLI (per `eve-app-cli` patterns), test via that CLI
- **REST API**: Use `curl` with auth tokens for custom API endpoints
- **Auth**: Mint tokens via `eve auth mint` or `eve auth token --raw`
- **Health checks**: Always start with `/health` endpoint verification
- **CRUD flows**: Create → Read → Update → Delete lifecycle for core entities

Pattern for API testing in plans:
```bash
TOKEN=$(eve auth token --raw)
# Test the app's API (not Eve's API)
curl -sf -H "Authorization: Bearer $TOKEN" \
  "${APP_SCHEME}://api.${APP_DOMAIN}/endpoint" | jq '.field'
```

**CLI parity assertion**: For every `curl` call in a test plan, ask: "Can this also be done via a CLI command?" If not, that's a gap to file as an issue — not something to accept.

### 5. Input / Ingestion Verification

When the app accepts uploaded inputs, imported files, or document bundles, verification must include a fixture plan before any execution steps.

**Fixture selection order:**

1. Reuse existing repo fixtures if they already match the accepted file types and are deterministic
2. Manufacture synthetic fixtures locally with committed scripts or documented commands
3. Source small public-domain fixtures only when local manufacture would materially reduce realism

**Fixture matrix guidance:**

- **Minimal valid** — smallest acceptable file that exercises the happy path
- **Typical real-world** — representative document/media/import file
- **Boundary / invalid** — wrong type, malformed structure, or size edge when validation matters
- **Cross-format** — if the app claims multiple accepted types (for example PDF + Markdown + CSV), verify each declared class, not just one

**What to check:**

- Uploaded file is accepted through the real app surface (`eve ingest`, app CLI, REST endpoint, or browser upload flow)
- MIME/type detection and metadata are correct
- Storage/persistence path is correct (ingest record, object store key, database row, etc.)
- Downstream processing happens with the expected fixture-specific result
- Error handling is explicit for rejected or malformed fixtures

**Fixture provenance rule**: if a plan says "upload a sample PDF" or "import a CSV", the skill requires an actual file path or a generator step. "Find a PDF online" is not an acceptable instruction.

### 6. UI Verification

When the app has a frontend, verify visual quality and interaction flows.

**Auth pattern — SSO token injection:**
```bash
# Mint an SSO token via CLI
SSO_TOKEN=$(eve auth mint --email user@example.com --org $ORG_ID --format sso-jwt)

# Use agent-browser with the token
agent-browser --session verify open "${APP_URL}/auth/callback?token=${SSO_TOKEN}"
agent-browser --session verify wait --url "**/dashboard"
agent-browser --session verify screenshot ./e2e-verification/artifacts/dashboard.png
```

**What to check:**
- Pages render without console errors
- Dark mode and light mode both work (screenshot both)
- Key user flows complete (login → dashboard → action → result)
- Responsive layout at standard breakpoints (desktop, tablet, mobile)
- Forms submit correctly and validation fires

**Tool choice:**
- `agent-browser` (default) — CLI-driven, snapshot-based, good for agents
- Playwright MCP — when you need programmatic assertions, complex interactions, or CI integration

### 7. Agent Verification

When the app includes Eve agents, verification extends to agent behavior quality.

**Integration with `eve-agent-optimisation`:**

After verifying that agents produce correct results, run an optimization pass:

1. Create a job that exercises the agent's primary workflow
2. Follow execution: `eve job follow <job-id>`
3. Check receipt: `eve job receipt <job-id>` (tokens, cost, duration)
4. Apply the `eve-agent-optimisation` diagnostic workflow
5. Record baseline metrics in the test plan for regression detection

**What to check:**
- Agent completes its task (correct output)
- Token usage is within acceptable bounds
- No unnecessary tool calls or blind alleys
- Agent handles error cases gracefully (bad input, missing secrets)
- Multi-agent coordination works (if applicable — jobs complete in dependency order)

### 8. Deploy Cycle Patterns

The skill teaches the fix/deploy loop since verification often reveals issues that need fixing:

**Cloud (staging) — default:**
```
discover bug → fix code → commit → tag release-v* → push tag →
  wait for CI (publish-images → infra dispatch → deploy) →
  re-run failed scenario
```

**Local (k3d):**
```
discover bug → fix code → pnpm build →
  ./bin/eh k8s-image push → ./bin/eh k8s deploy →
  re-run failed scenario
```

The test plan format includes a `## Fix/Deploy Cycle` section when iterative verification is expected, with explicit steps for both environments.

### 9. Scenario Discovery Heuristic

Teach agents how to identify what scenarios to create for a given app:

1. **Read the manifest** — every service is a verification target
2. **Read the agents config** — every agent needs a behavioral test
3. **Read the API spec** — every endpoint group is a potential scenario
4. **Check upload/import surfaces** — every accepted file class needs deterministic fixtures and at least one execution path
5. **Check pipelines** — build/deploy/workflow pipelines need end-to-end verification
6. **Check the UI** — every page/route needs visual verification
7. **Check integrations** — webhooks, chat gateways, external APIs

Minimum set for any Eve app:
- `00-smoke` — health, auth, connectivity + Eve conformance checklist
- `01-deploy` — build, release, deploy via pipeline, verify endpoints
- `02-core-flow` — primary user journey end-to-end (CLI + API)
- `03-ui-visual` — screenshot verification of key pages (light + dark mode, SSO login)

If the app accepts uploads/imports/docs, add:
- `04-input-ingestion` — upload/import representative fixtures, verify parsing/storage/metadata, assert error handling on at least one invalid fixture

If the app has a database, add:
- `05-data-layer` — migrations run via pipeline, schema correct, data integrity

If agents exist, add:
- `06-agent-execution` — agents complete primary tasks correctly
- `07-agent-optimization` — baseline metrics + optimization pass via `eve-agent-optimisation`

If pipelines/workflows exist, add:
- `08-pipeline-flows` — each pipeline runs end-to-end, steps succeed in order

## References Detail

### `references/test-plan-format.md`
Full format specification with annotated examples. Covers:
- Frontmatter fields and their meaning
- Environment detection boilerplate
- Assertion writing guidelines
- Required `## Fixtures` section
- Artifact output conventions (screenshots, logs, JSON dumps go to `./e2e-verification/artifacts/`)

### `references/fixture-patterns.md`
Fixture sourcing and manufacture guidance. Covers:
- How to decide between reusing, generating, or sourcing fixtures
- Provenance rules and `fixtures/README.md` format
- Suggested fixture sets for Markdown, PDF, CSV, JSON, images, audio, and video
- Boundary fixtures (invalid MIME, malformed data, oversize files) when negative testing matters
- How to keep fixtures deterministic, small, and safe to commit

### `references/eve-conformance-checks.md`
The Eve way — what makes an app correctly built on Eve. Covers:
- Manifest structure and required fields
- CLI parity requirements (no UI-only functionality)
- Secrets management via `eve secrets` (not env files)
- DB migration patterns (pipeline steps, not manual SQL)
- Auth via Eve SSO (token minting, callback flow)
- Agent definition conventions (`agents.yaml`, harness profiles)
- Pipeline/workflow declaration in manifest
- Ingress conventions (mechanical + vanity aliases)
- How to detect and file conformance gaps vs bugs

### `references/deploy-cycle-patterns.md`
The fix/deploy loop for both environments. Covers:
- Tag-based deployment to staging (two-repo model)
- Local k3d rebuild workflow
- How to detect which environment you're targeting
- Waiting for deploys to complete before re-testing
- When to use `eve pipeline logs --follow` vs polling

### `references/ui-verification-patterns.md`
Browser automation patterns for Eve apps. Covers:
- SSO token minting and injection for auth bypass
- `agent-browser` session management
- Dark mode / light mode toggle and screenshot comparison
- Responsive breakpoint testing
- Console error capture
- Form interaction patterns
- Integration with Playwright MCP as alternative

### `references/agent-verification-patterns.md`
Agent behavior testing and optimization. Covers:
- Creating test jobs with known inputs
- Following execution in real-time
- Extracting efficiency metrics (receipts, token counts)
- Connecting to `eve-agent-optimisation` for deeper analysis
- Recording baselines for regression detection
- Multi-agent coordination verification

## Templates Detail

### `templates/00-smoke-test-plan.md`
Ready-to-use smoke test that verifies:
- API health
- CLI connectivity
- Auth (SSO token mint)
- Secrets presence
- Frontend loads (if applicable)

Agents copy this template into `./e2e-verification/00-smoke/` and customize the app-specific endpoints.

### `templates/scenario-test-plan.md`
Skeleton for a general scenario. Pre-filled with:
- Environment detection boilerplate
- Fixtures section
- Auth setup
- Phase structure with `Expected:` blocks
- Success criteria checklist
- Debugging table
- Cleanup section

### `templates/upload-ingest-test-plan.md`
Specialized template for input-heavy scenarios. Pre-filled with:
- Fixture matrix (valid / representative / invalid)
- Fixture provenance table
- Upload/import setup commands
- Assertions for MIME/type detection, storage, metadata, and downstream processing
- Cleanup guidance for uploaded objects or ingest records

## Related Skills

| Skill | Pack | Relationship |
|-------|------|-------------|
| `eve-agent-optimisation` | eve-work | Called from agent verification scenarios |
| `eve-web-ui-testing-agent-browser` | eve-se | UI verification tool (agent-browser + Playwright patterns) |
| `eve-deploy-debugging` | eve-se | Deploy cycle troubleshooting when verification reveals deploy issues |
| `eve-cli-primitives` | eve-se | CLI commands used in service-layer and conformance tests |
| `eve-manifest-authoring` | eve-se | Manifest conventions that conformance checks validate |
| `eve-app-cli` | eve-se | App CLI patterns — verification asserts CLI parity |
| `eve-pipelines-workflows` | eve-se | Pipeline conventions that pipeline verification scenarios test |
| `eve-auth-and-secrets` | eve-se | Auth + secrets model that conformance checks validate |
| `eve-troubleshooting` | eve-se | General debugging runbooks for when verification fails |
| `eve-read-eve-docs` | eve-work | Reference source for current CLI, manifest, auth, ingest, and skills behavior |
| `eve-agent-native-design` | eve-design | Design principles that conformance checks encode |

## Implementation Steps

1. Create `../eve-skillpacks/eve-se/eve-verification-plans/SKILL.md`
2. Create `references/test-plan-format.md`
3. Create `references/eve-conformance-checks.md`
4. Create `references/fixture-patterns.md`
5. Create `references/deploy-cycle-patterns.md`
6. Create `references/ui-verification-patterns.md`
7. Create `references/agent-verification-patterns.md`
8. Create `templates/00-smoke-test-plan.md`
9. Create `templates/scenario-test-plan.md`
10. Create `templates/upload-ingest-test-plan.md`
11. Update `../eve-skillpacks/eve-se/README.md` to include the new skill
12. Update `../eve-skillpacks/ARCHITECTURE.md` to list the new skill under eve-se
13. Commit and push

## Open Questions

1. **Should there be a CLI command?** e.g., `eve verify init` that scaffolds `./e2e-verification/` with the smoke template. Not for v1 — keep it as a skill-only pattern and see if the need emerges.

2. **Should the index file be a README or a manifest?** A `./e2e-verification/README.md` listing all scenarios is probably sufficient. A machine-readable manifest (YAML) could enable automated orchestration but adds complexity. Start with README.

3. **Naming: "verification" vs "validation" vs "testing"?** "Verification" is precise — it means "confirm this works as specified." "Testing" is broader and could imply unit/integration tests. "Validation" is about requirements, not implementation. Going with "verification."

4. **Should the skill teach how to run plans, or just how to write them?** Both. Writing is the primary concern, but the skill should include a "Running a verification plan" section that covers parallel execution patterns and CI integration hooks.
