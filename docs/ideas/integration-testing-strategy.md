# Integration Testing Strategy for K8s-First Runtime

> **Idea / Draft**: This is a brainstorming document and may not reflect current behavior.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Idea
> Last Updated: 2026-01-17

## Goal

Design an integration testing strategy that gives 90% confidence without requiring a running stack, enabling fast iteration loops for agents working on Eve Horizon itself.

## Context

When Eve Horizon runs on k8s and an agent needs to iterate on code changes:

1. **Stack-mode e2e** tests against a deployed stack — but the agent's changes aren't deployed yet
2. **Compose-mode e2e** requires Docker-in-Docker, which is fragile in k8s
3. **Unit tests alone** don't catch integration bugs

The solution: make integration tests comprehensive enough that stack-mode e2e is just a final sanity check, not the iteration loop.

## The Test Pyramid

```
                    ▲
                   ╱ ╲
                  ╱   ╲        Stack E2E (5%)
                 ╱ 🐢  ╲       - Real harness, real k8s
                ╱───────╲      - "Does it actually work?"
               ╱         ╲
              ╱           ╲    Integration (25%)
             ╱   🐇🐇🐇    ╲   - Real DB, mocked harness
            ╱───────────────╲  - "Do the pieces fit?"
           ╱                 ╲
          ╱                   ╲ Unit (70%)
         ╱     🐇🐇🐇🐇🐇🐇     ╲ - Pure logic, no I/O
        ╱───────────────────────╲ - "Does the code work?"
       ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
```

## Core Principle: Mock at the Expensive Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   Integration Test Boundary                                     │
│   ════════════════════════                                      │
│                                                                 │
│   ┌─────────┐      ┌──────────────┐      ┌──────────┐          │
│   │   API   │ ───▶ │ Orchestrator │ ───▶ │  Worker  │          │
│   └─────────┘      └──────────────┘      └────┬─────┘          │
│        │                  │                    │                │
│        ▼                  ▼                    ▼                │
│   ┌─────────┐      ┌─────────────┐      ┌──────────┐          │
│   │ Real DB │      │   Real DB   │      │  MOCK    │ ◀── Here │
│   │ (test)  │      │   (test)    │      │ Harness  │           │
│   └─────────┘      └─────────────┘      └──────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The harness (Claude, Codex) is the **expensive, slow, non-deterministic** boundary. Mock it.

The database is cheap and deterministic. Use the real thing.

## Implementation

### 1. Harness Mock with Realistic Behavior

```typescript
// packages/worker/src/harness/mock-harness.ts

export class MockHarness implements Harness {
  constructor(private scenario: MockScenario) {}

  async execute(job: Job, workspace: string): Promise<HarnessResult> {
    // Simulate realistic behavior
    await this.emitLogs(this.scenario.logs);
    await sleep(this.scenario.durationMs);

    if (this.scenario.shouldFail) {
      return { success: false, error: this.scenario.error };
    }

    // Simulate file changes if scenario specifies
    if (this.scenario.fileChanges) {
      for (const [path, content] of Object.entries(this.scenario.fileChanges)) {
        await fs.writeFile(join(workspace, path), content);
      }
    }

    return { success: true, output: this.scenario.output };
  }
}
```

### 2. Scenario Library Covering Edge Cases

```typescript
// packages/worker/src/harness/__fixtures__/scenarios.ts

export const scenarios = {
  // Happy paths
  simpleSuccess: { logs: ['Working...', 'Done!'], success: true },
  createsFiles: { fileChanges: { 'output.txt': 'result' }, success: true },

  // Failure modes
  timeout: { durationMs: 60000, shouldFail: true, error: 'timeout' },
  authFailure: { shouldFail: true, error: 'OAuth token expired' },
  rateLimited: { shouldFail: true, error: 'Rate limited', retryAfter: 60 },

  // Complex behaviors
  multiTurnConversation: { turns: 5, logs: [...], success: true },
  partialSuccess: { logs: ['Step 1 done', 'Step 2 failed'], success: false },
  retriableError: { attempts: [{ fail: true }, { fail: true }, { success: true }] },
};
```

### 3. Full Flow Integration Tests

```typescript
// apps/api/test/integration/job-lifecycle.test.ts

describe('Job Lifecycle (integration)', () => {
  let app: INestApplication;
  let db: TestDatabase;

  beforeAll(async () => {
    db = await TestDatabase.create(); // Real postgres, test schema
    app = await createTestApp({
      database: db,
      harness: new MockHarness(scenarios.simpleSuccess),
    });
  });

  it('complete job flow: create → claim → execute → complete', async () => {
    // 1. Create org + project via API
    const org = await api.post('/orgs', { name: 'Test Org' });
    const project = await api.post('/projects', {
      name: 'Test',
      repoUrl: 'https://github.com/test/repo'
    });

    // 2. Create job
    const job = await api.post('/jobs', {
      projectId: project.id,
      description: 'Fix the bug'
    });
    expect(job.phase).toBe('ready');

    // 3. Simulate orchestrator claiming and dispatching
    await orchestrator.tick(); // Process ready jobs
    expect(await api.get(`/jobs/${job.id}`)).toMatchObject({
      phase: 'active'
    });

    // 4. Simulate worker completing
    await worker.processNext();
    expect(await api.get(`/jobs/${job.id}`)).toMatchObject({
      phase: 'completed',
      result: expect.objectContaining({ success: true }),
    });
  });

  it('handles harness failure with retry', async () => {
    const harness = new MockHarness(scenarios.retriableError);
    // ... test retry logic
  });

  it('handles OAuth expiration mid-job', async () => {
    const harness = new MockHarness(scenarios.authFailure);
    // ... test error handling
  });
});
```

### 4. CLI Integration Tests (Mock API)

```typescript
// packages/cli/test/integration/cli-commands.test.ts

describe('CLI Commands (integration)', () => {
  let mockApi: MockApiServer;

  beforeAll(async () => {
    mockApi = await MockApiServer.start(); // Records/replays HTTP
  });

  it('eve job create', async () => {
    mockApi.expect('POST', '/jobs').respondWith({ id: 'job_123', phase: 'ready' });

    const result = await runCli(['job', 'create', '--description', 'Test job']);

    expect(result.stdout).toContain('Created job: job_123');
    expect(result.exitCode).toBe(0);
  });

  it('eve job logs --follow', async () => {
    mockApi.expect('GET', '/jobs/job_123/logs').respondWithStream([
      { ts: 1, message: 'Starting...' },
      { ts: 2, message: 'Done!' },
    ]);

    const result = await runCli(['job', 'logs', 'job_123', '--follow']);

    expect(result.stdout).toContain('Starting...');
    expect(result.stdout).toContain('Done!');
  });
});
```

## Coverage Targets by Area

| Area | Integration Coverage | What's left for E2E |
|------|---------------------|---------------------|
| **Job CRUD** | 100% | - |
| **Job lifecycle** | 95% | Real timing, real retries |
| **Orchestrator dispatch** | 90% | Multi-worker coordination |
| **Worker workspace** | 95% | Real git clone |
| **Harness invocation** | 80% (mock) | Real Claude/Codex behavior |
| **Log streaming** | 90% | Real websocket under load |
| **Auth flows** | 95% | Real OAuth token refresh |
| **CLI commands** | 100% | - |

## The 10% That Needs Real E2E

Stack-mode e2e tests should cover only what integration tests cannot:

| Test | Why it needs real e2e |
|------|----------------------|
| Real harness invocation | Mock can't predict Claude's actual behavior |
| End-to-end latency | Integration tests don't catch perf regressions |
| Multi-service coordination under load | Race conditions only appear at scale |
| Real OAuth token lifecycle | Token refresh timing is hard to simulate |
| Nested stack validation | The recursion is the point |

## Performance Targets

```
Integration test run:
├── Parallel test files (vitest --pool=threads)
├── Shared DB per worker (test schema isolation)
├── Mock harness (instant responses)
└── Total time: ~30 seconds

Stack E2E run:
├── Sequential (shared infra)
├── Real harness calls (~30s each)
├── Real deploys
└── Total time: ~10 minutes
```

## E2E Modes (K8s-First)

Split E2E tests into two modes:

1. **compose**: fast local/CI-friendly tests that spin infra locally.
2. **stack**: k8s-first E2E tests that run against an existing Eve stack.

### Mode: compose (local/CI)

- Starts local docker compose stack.
- Uses test database (`eve_test`).
- Suitable for CI and fast dev verification.

### Mode: stack (k8s-first E2E)

- Assumes an existing Eve Horizon stack is running (k8s).
- Does NOT start infra.
- Targets the stack via `EVE_API_URL`.
- Uses real harnesses and behaves like a real user.

### Runtime Contract (Repo-Side)

Legacy note: `/.eve/runtime.yaml` is deprecated; use `.eve/manifest.yaml`.

```yaml
tasks:
  e2e_compose: "./bin/eh test e2e --env docker"
  e2e_stack: "./bin/eh test e2e --env stack"
```

### Environment Variables

- `EVE_API_URL`: required for stack mode
- Harness credentials: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` as needed

## Agent Iteration Loop

With this strategy, an agent working on Eve Horizon iterates like this:

```
1. Make code changes
2. pnpm test:unit              # ~5 seconds
3. pnpm test:integration       # ~30 seconds
4. Iterate steps 1-3 until green
5. Push → staging deploy → stack e2e (final gate)
```

The slow feedback loop (deploy + stack e2e) only runs once at the end, not on every iteration.

## Implementation Checklist

- [ ] Create `MockHarness` class with scenario support
- [ ] Build scenario library covering all error paths
- [ ] Add integration test infrastructure (test DB, app factory)
- [ ] Write job lifecycle integration tests
- [ ] Write CLI integration tests with mock API
- [ ] Add `pnpm test:integration` script
- [ ] Update CI to run integration tests
- [ ] Document the testing strategy in AGENTS.md

## See Also

- [Runtime Core Design](./runtime-core-design.md) - K8s-first runtime design
