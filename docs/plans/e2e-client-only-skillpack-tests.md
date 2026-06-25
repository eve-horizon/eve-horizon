# E2E Client-Only Test Plan (Skills + Harnesses)

Date: 2026-01-21
Owner: Eve Horizon
Status: Shipped (d56a48a)

## Goal

Create a client-only E2E test suite that can target any remote stack (default: local k3d) and validates core happy paths, all harnesses, and official skillpacks. The suite must be fast, parallelizable via client-side test slots, human-readable, and self-documenting.

## Key Requirements

- Client-only: use public CLI + API only (no DB or kubectl).
- Default stack: local k3d via `EVE_API_URL=http://api.eve.lvh.me`.
- Standard project: use the fullstack example repo and keep it stable.
- Harness coverage: default harness is `mclaude`; missing `mclaude` auth fails the suite. Other harness auth is reported but non-fatal.
- Skills: validate skillpacks flow (`skills.txt` -> on-clone -> `.agents/skills/<skill>`). Use `https://github.com/eve-horizon/eve-skillpacks` and `eve-orchestration` as the concrete test.
- Parallelism: run tests quickly with client-side test slots; internal workspace pooling is handled by the runtime.
- Self-documenting: clear suite layout and README with “how to add tests”.

## Proposed Test Layout

```
tests/e2e/
  README.md
  vitest.e2e.config.ts
  setup.ts
  helpers/
    cli.ts
    slot-pool.ts
    assertions.ts
    timeouts.ts
    stack-detection.ts
  suites/
    01-connectivity.e2e.test.ts
    02-harness-auth.e2e.test.ts
    03-job-happy-path.e2e.test.ts
    04-job-logs.e2e.test.ts
    05-harness-matrix.e2e.test.ts
    06-skillpacks-orchestration.e2e.test.ts
```

## Standard Project Strategy

- Org: `e2e-org`
- Project: `e2e-example`
- Repo: `https://github.com/eve-horizon/eve-horizon-fullstack-example`
- Branch: `main`
- Ensure project exists in `setup.ts` via `eve org ensure` + `eve project ensure`.
- Example repo `skills.txt` should include `https://github.com/eve-horizon/eve-skillpacks`.

## Skills Validation (Skillpacks)

### What we test

1. Example project adds official skillpack repo to `skills.txt`:
   - `https://github.com/eve-horizon/eve-skillpacks`
2. On clone, skills are installed into `.agents/skills/`.
3. A job explicitly invokes `eve-orchestration` in the description.
4. Logs show skill activation and orchestration behavior (sub-job creation).

### Concrete assertions

- Job logs include skill invocation markers for `eve-orchestration`.
- Child job IDs exist in job metadata or CLI output.

## Harness Coverage

- Run a minimal job with each harness (mclaude, zai, etc.).
- Treat `mclaude` auth as required (fail if missing).
- Collect auth status for other harnesses via CLI (report only; do not fail).
- Assert each harness completes a small happy-path job.

## Client Slot Pool (Parallelism)

- Slot count from env: `EVE_E2E_POOL` (default: 5 local).
- Each test file acquires a slot ID (`e2e-01`, `e2e-02`, ...).
- Slot ID scopes org/project/job names to avoid collisions.
- Internal workspace pooling is handled by the worker/runtime.

## Test Suites (What Each Covers)

1. **Connectivity**
   - API reachable
   - CLI works with `EVE_API_URL`
   - Project exists

2. **Harness Auth (mclaude Required)**
   - `eve harness list --json`
   - Fail if `mclaude` auth is missing
   - Record other harness auth status for visibility

3. **Happy Path Job**
   - Create job against standard project
   - Wait for completion
   - Validate result status

4. **Job Logs**
   - Fetch JSONL logs
   - Parse + assert key steps

5. **Harness Matrix**
   - One minimal job per harness
   - Ensure each completes

6. **Skillpacks Orchestration**
   - Skills installed from `skills.txt`
   - Job invokes `eve-orchestration`
   - Validate sub-job creation

## Human-Readable, Self-Documenting Expectations

`tests/e2e/README.md` should include:

- How to target a remote stack (`EVE_API_URL`)
- What each suite does
- How to add a new suite
- How to validate skills (skillpacks flow)
- How to increase/decrease parallelism

## Execution

- Add `./bin/eh test e2e` entrypoint (or extend existing test runner).
- Example:
  - Local: `./bin/eh test e2e`
  - Remote: `EVE_API_URL=https://api.staging.example.com ./bin/eh test e2e`

## Success Criteria

- Suite runs against local k3d with default URL.
- Suite runs against a remote stack with only `EVE_API_URL` set.
- Skills from `skills.txt` are installed + invoked in logs.
- `mclaude` auth is required; missing auth fails the suite.
- Other harness auth is visible but does not fail tests.
- Each test completes in 1-2 minutes (max).
- Full suite completes in <10 minutes (target <5).

## Risks / Mitigations

- Skillpack changes could break tests: pin the example repo to `main` and keep skillpack stable.
- `mclaude` auth availability varies by environment: tests will fail without credentials.
- Parallel jobs can saturate stack: bound pool size per environment.

## Next Steps

1. Update the fullstack example repo `skills.txt` to include `https://github.com/eve-horizon/eve-skillpacks`.
2. Add the `tests/e2e` suite + helpers.
3. Document the workflow in `tests/e2e/README.md`.
4. Add `./bin/eh test e2e` runner.
