# Testing Strategy

> **What**: Testing pyramid, rules, and patterns for Eve Horizon.
> **Why**: Ensures tests are fast, reliable, and runnable everywhere (including inside Eve jobs).

## Testing Pyramid

```
┌─────────────────────────────────────────────────────────────────────┐
│ Tier 3: Manual Tests (Observable)                                   │
│ Real K8s, real repos, real harnesses. Happy paths only.            │
│ Tests are external clients with real-time observability.           │
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ Tier 2: Integration (API + CLI)                                     │
│ 90% of coverage. Real Postgres, stub harnesses, local stack.       │
│ CLI and HTTP API only - no direct database access.                 │
└─────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ Tier 1: Unit                                                        │
│ Pure logic, no dependencies. Fast and isolated.                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tier 1: Unit Tests

**Purpose**: Test pure logic, validators, state machines, and utilities.

**Location**: `apps/*/test/unit/`, `packages/*/src/**/*.test.ts`

### What to Test
- ID formatting/parsing (jobId, attemptId, projectSlug)
- Phase transition validation
- Configuration resolution
- Utility functions

### Rules

| Allowed | Not Allowed |
|---------|-------------|
| Pure function imports | Database imports (`@eve/db`) |
| In-memory mocks | Network calls |
| Temporary files (if testing file logic) | External services |
| `@eve/shared` utilities | Process spawning |

### Example Pattern
```typescript
import { describe, expect, it } from 'vitest';
import { JobGitSchema } from '@eve/shared';

describe('job git defaults', () => {
  it('fills defaults for ref_policy/commit/push', () => {
    const parsed = JobGitSchema.parse({ ref: 'main' });
    expect(parsed.ref_policy).toBe('auto');
    expect(parsed.commit).toBe('manual');
    expect(parsed.push).toBe('never');
  });
});
```

### Run Command
```bash
pnpm test               # All unit tests
pnpm --filter @eve/api test -- test/unit
```

---

## Tier 2: Integration Tests

**Purpose**: Test API endpoints, job workflows, and service interactions with real Postgres.

**Location**: `apps/api/test/integration/`

**Coverage Target**: 90% of system behavior.

### What to Test
- Full CRUD flows (org → project → job → attempt → completion)
- Job lifecycle (claim, submit, review, approve/reject, cancel)
- Dependency relationships (blocks, waits_for)
- Secrets management
- Log streaming
- Pagination and filtering

### Rules

| Allowed | Not Allowed |
|---------|-------------|
| CLI execution (`eve` commands) | Direct database imports (`@eve/db`, `createDb()`) |
| HTTP fetch to API endpoints | Raw SQL queries |
| Internal API endpoints (`/internal/*`) | `jobQueries()`, `executionLogQueries()` directly |
| `@eve/shared` utilities | Modifying DB state outside API |
| Stub harnesses (default) | Real harnesses (unless `--real` flag) |
| Real Postgres (`eve_test`) | Mocking the database |

### Why No Direct DB Access?

Integration tests must work in **all environments**:
1. Local dev (`pnpm dev`)
2. Docker Compose stack
3. K8s stack

In K8s environments, tests only have API access - no direct database connection.
By using CLI/API exclusively, tests are portable across all environments.

### Internal API Pattern

For simulating worker behavior (logs, attempt updates, requeue), use internal APIs:

```typescript
const internalToken = process.env.EVE_INTERNAL_API_KEY || 'test-internal-key';

async function internalRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-eve-internal-token': internalToken,
      ...(init?.headers || {}),
    },
  });
  return response.json() as Promise<T>;
}

// Append logs
await internalRequest(`/internal/attempts/${attemptId}/logs`, {
  method: 'POST',
  body: JSON.stringify({ log_type: 'status', content: { message: 'hello' } }),
});

// Update attempt
await internalRequest(`/internal/attempts/${attemptId}`, {
  method: 'PATCH',
  body: JSON.stringify({ status: 'succeeded', result_json: { eve: { status: 'waiting' } } }),
});

// Requeue job
await internalRequest(`/internal/jobs/${jobId}/requeue`, {
  method: 'POST',
  body: JSON.stringify({ agent_id: 'test-agent', reason: 'waiting on children' }),
});
```

### Example Pattern
```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');
const apiUrl = process.env.EVE_API_URL || 'http://localhost:4801';

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    env: { ...process.env, EVE_API_URL: apiUrl },
  });
  return stdout.trim();
}

describe('integration job flow', () => {
  it('creates org, project, and job', async () => {
    // Use CLI - not direct DB
    const orgRaw = await runEve(['org', 'ensure', 'TestOrg', '--json']);
    const org = JSON.parse(orgRaw);

    const projectRaw = await runEve([
      'project', 'ensure',
      '--org', org.id,
      '--name', 'TestProject',
      '--repo-url', 'file:///path/to/fixture',
      '--json',
    ]);
    const project = JSON.parse(projectRaw);

    const jobRaw = await runEve([
      'job', 'create',
      '--project', project.id,
      '--description', 'Test job',
      '--json',
    ]);
    const job = JSON.parse(jobRaw);

    expect(job.id).toBeDefined();
    expect(job.phase).toBe('ready');
  });
});
```

### Run Commands
```bash
./bin/eh test integration              # Default (dev stack)
./bin/eh test integration --env docker # Docker Compose
./bin/eh test integration --env stack  # K8s (k3d)
./bin/eh test integration --real       # Use real harnesses
```

---

## Tier 3: Manual Tests (Observable)

**Purpose**: Validate happy paths with real jobs, real repos, and real harnesses on a real K8s cluster.

**Location**: `tests/manual/`

### Key Principle: Observable Testing

Manual tests act as **external clients** with real-time observability:
- Only use the public CLI
- Watch job progress with `eve job follow`
- Secrets set on org/project (not system-level)
- No kubectl except for infrastructure issues

This ensures tests validate the actual user experience with full visibility.

### What to Test
- Core happy paths: create project → create job → job completes successfully
- Real harness execution (zai, etc.)
- Real git repos (GitHub/GitLab)
- Workspace provisioning
- Deploy flows

### What NOT to Test Here
- Error handling (covered in Tier 2)
- Edge cases (covered in Tier 2)
- Internal implementation details
- Worker internals

### Rules

| Allowed | Not Allowed |
|---------|-------------|
| CLI commands (`eve`) | Internal APIs (`/internal/*`) |
| Public API endpoints | Direct database access |
| Real K8s stack | Mocked services |
| Real harnesses | Stub harnesses |
| Real git repos | kubectl exec into pods |
| `eve job follow` for observability | kubectl for job debugging |

### Running Manual Tests

```bash
# 1. Set up test org and secrets
eve org ensure "manual-test-org" --json
eve secrets import --org org_manualtestorg --file manual-tests.secrets

# 2. Run scenarios (see tests/manual/scenarios/)
# Ask Claude: "Run manual test scenarios 01-04 in parallel"

# 3. Watch jobs in real-time
eve job follow <job-id>
```

See `tests/manual/README.md` for full documentation.

---

## Test Fixtures

### Stub Harnesses
Location: `tests/fixtures/bin/`

Lightweight shell scripts that mimic harness behavior for fast Tier 2 testing:
- `mclaude`, `claude`, `code`, `zai`, `gemini`, etc.

### Test Repository
Location: `tests/fixtures/repos/e2e-project/`

Minimal Eve project with `.eve/` configuration for deterministic testing.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EVE_API_URL` | API endpoint | `http://localhost:4801` |
| `EVE_API_PORT` | API port (alternative) | `4801` |
| `EVE_INTEGRATION_ENV` | Stack type: `dev`, `docker`, `stack` | `dev` |
| `EVE_INTERNAL_API_KEY` | Internal API auth token | `test-internal-key` |
| `EVE_INTEGRATION_USE_REAL_MCLAUDE` | Use real harnesses | `false` |

---

## Quick Reference

| Tier | What | Access | DB | Harness | Speed |
|------|------|--------|-----|---------|-------|
| 1 - Unit | Pure logic | None | None | None | <5ms |
| 2 - Integration | API/CLI flows | CLI, HTTP, Internal API | Real (via API) | Stub | <1s |
| 3 - Manual | Happy paths | CLI, Public API only | Real (via API) | Real | ~minutes |

---

## Adding New Tests

### Choosing the Right Tier

```
Is it testing pure logic with no external dependencies?
  → Tier 1 (Unit)

Does it need database/API but tests implementation details?
  → Tier 2 (Integration)

Does it test user-facing happy paths on real infrastructure?
  → Tier 3 (Manual) - see tests/manual/
```

### Before Writing an Integration Test

1. Check if the API/CLI endpoint exists for what you need
2. If simulating worker behavior, use internal APIs
3. If an API doesn't exist, **add it first** - don't use direct DB
4. Use `@eve/shared` for utilities, never `@eve/db`

---

## See Also

- [AGENTS.md](../../AGENTS.md) - Testing section and quick start
- [k8s-local-stack.md](./k8s-local-stack.md) - K8s test environment
- [deployment.md](./deployment.md) - Deployment and runtime info
