# Environment Gating

> **Status**: Implemented
> **Last Updated**: 2026-01-20

## Overview

Environment gating prevents concurrent jobs from deploying to the same environment. When a job targets a named environment (via `env_name`), the orchestrator automatically acquires an environment-specific gate to ensure exclusive access during execution.

### When to Use Environment Gating

**This feature is designed for deployment-type jobs** — scenarios where only one job should operate on an environment at a time (e.g., deploying to staging, running database migrations).

**Do NOT use ****`env_name`**** for general parallel work.** Jobs without `env_name` set run freely in parallel with no gating. If you're running compute tasks, builds, or other parallelizable work, simply omit the `env_name` field.

**Alternative use: Mutex enforcement.** You can use `env_name` with special names to enforce mutex behavior for non-deployment scenarios. For example, setting `env_name: "db-backup"` would ensure only one backup job runs at a time, even if it's not a traditional environment.

## How It Works

### Automatic Gate Acquisition

When a job has `env_name` set, the system automatically adds an environment gate:

```
Gate Key Pattern: env:{project_id}:{env_name}

Example: env:proj_abc123:staging
```

This gate is acquired in addition to any explicit gates specified in `job.hints.gates`.

### Gate Lifecycle

1. **Job Claim**: When the orchestrator (or API) claims a job with `env_name` set:
  - Combines explicit gates from `hints.gates` with the implicit environment gate
  - Attempts to acquire all gates atomically
  - If any gate is blocked, the job remains in `ready` phase with `blocked_on_gates` updated
  - If all gates are acquired, the job transitions to `active` phase

2. **Job Execution**: The environment gate is held for the duration of the job execution

3. **Job Completion**: When the job completes (success, failure, or cancellation):
  - All gates (including the environment gate) are released
  - Other jobs waiting for the same environment can now acquire the gate

### TTL and Timeout

- Gate TTL is set to the job's `hints.timeout_seconds` (default: 30 minutes)
- If a job crashes without releasing its gates, the TTL ensures the gate expires
- Expired gates are cleaned up automatically during gate acquisition attempts

## Implementation Details

### Orchestrator Changes

**File**: `~/dev/eve-horizon/eve-horizon/apps/orchestrator/src/loop/loop.service.ts`

The orchestrator combines explicit and environment gates:

```typescript
// Combine explicit gates from hints with implicit environment gate
const explicitGates = job.hints?.gates ?? [];
const envGate = job.env_name ? [`env:${job.project_id}:${job.env_name}`] : [];
const requiredGates = [...explicitGates, ...envGate];
```

Enhanced logging distinguishes environment gates:

```typescript
// Log which gates were acquired, highlighting environment gates
const gatesList = requiredGates.map(g =>
  g.startsWith('env:') ? `${g} (environment lock)` : g
).join(', ');
console.log(`Acquired gates for job ${job.id}: ${gatesList}`);
```

### API Changes

**File**: `~/dev/eve-horizon/eve-horizon/apps/api/src/jobs/jobs.service.ts`

The API's `claim()` method follows the same pattern as the orchestrator:

```typescript
// Combine explicit gates from hints with implicit environment gate
const explicitGates = job.hints?.gates ?? [];
const envGate = job.env_name ? [`env:${job.project_id}:${job.env_name}`] : [];
const requiredGates = [...explicitGates, ...envGate];
```

### Database Schema

**Tables Used**:
- `jobs.env_name` - Target environment name (nullable)
- `jobs.blocked_on_gates` - Array of gate keys blocking the job
- `job_gates` - Active gate locks with TTL

**Migration**: `packages/db/migrations/00006_add_job_gates.sql` (gates), `00011_add_job_env_columns.sql` (env_name)

## Usage Examples

### Creating a Job with Environment Targeting

```bash
# Create job targeting 'staging' environment
eve job create \
  --project proj_abc123 \
  --description "Deploy API to staging" \
  --env-name staging

# The job will automatically acquire gate: env:proj_abc123:staging
```

### Combining Explicit Gates with Environment Gates

```bash
# Job with both environment gate and custom gate
eve job create \
  --project proj_abc123 \
  --description "Deploy database migration to production" \
  --env-name production \
  --hints '{"gates": ["db-migration"]}'

# This job will acquire TWO gates:
# 1. env:proj_abc123:production (automatic)
# 2. db-migration (explicit)
```

### Checking Blocked Jobs

```bash
# List jobs blocked on gates
eve job list --project proj_abc123 --json | jq '.jobs[] | select(.blocked_on_gates | length > 0)'
```

## Testing

### Integration Tests

**File**: `~/dev/eve-horizon/eve-horizon/apps/api/test/integration/job-env-gates.integration.test.ts`

The test suite covers:

1. **Concurrent Prevention**: Two jobs targeting the same environment
  - First job claims successfully
  - Second job gets 409 Conflict with `blocked_on_gates`
  - After first job releases, second job can claim

2. **Multi-Environment Concurrency**: Jobs targeting different environments
  - Both jobs can claim simultaneously
  - Each holds a different environment gate

### Running Tests

```bash
# Run integration tests
./bin/eh test integration

# Run specific environment gating tests
./bin/eh test integration --target job-env-gates
```

## Monitoring and Debugging

### Orchestrator Logs

When a job is blocked on an environment gate:

```
Job staging-deploy-a3f2dd12 blocked on environment gate (another job is deploying to staging): env:proj_abc123:staging
```

When gates are acquired:

```
Acquired gates for job staging-deploy-a3f2dd12: env:proj_abc123:staging (environment lock), db-migration
```

### API Responses

When claiming a blocked job:

```json
{
  "statusCode": 409,
  "message": "Job blocked on gates",
  "blocked_on_gates": ["env:proj_abc123:staging"],
  "jobId": "staging-deploy-a3f2dd12"
}
```

### Database Queries

Check active environment gates:

```sql
SELECT gate_key, job_id, acquired_at, ttl_expires_at
FROM job_gates
WHERE gate_key LIKE 'env:%'
ORDER BY acquired_at DESC;
```

Check jobs blocked on environment gates:

```sql
SELECT id, env_name, blocked_on_gates, phase
FROM jobs
WHERE 'env:' = ANY(blocked_on_gates)
ORDER BY updated_at DESC;
```

## Design Rationale

### Why Automatic Gates?

1. **Safety by Default**: Developers don't need to remember to add environment gates
2. **Consistency**: All environment-targeted jobs follow the same pattern
3. **Simplicity**: No need to manually specify `env:{project}:{env}` in hints

### Why Combine Explicit and Environment Gates?

Some jobs may need additional concurrency control beyond environment isolation:
- Database migrations (gate: `db-migration`)
- External API rate limits (gate: `api:third-party`)
- Shared infrastructure (gate: `infra:cdn-purge`)

The system combines both types of gates to support complex coordination scenarios.

### Why Project-Scoped Gates?

Environment gates include the `project_id` to ensure isolation:
- Different projects can deploy to environments with the same name
- Example: `proj_abc.staging` and `proj_xyz.staging` are independent

## Future Enhancements

### Planned (Phase 1)

- **Gate Monitoring**: CLI command to list active gates (`eve gate list`)
- **Manual Gate Release**: Admin command to force-release stuck gates (`eve gate release <key>`)
- **Gate Analytics**: Track gate wait times and contention

### Considered (Phase 2+)

- **Priority-Based Gate Acquisition**: Higher priority jobs can preempt lower priority jobs
- **Gate Quotas**: Limit concurrent jobs per environment across all projects
- **Cross-Project Gates**: Share gates between related projects (e.g., monorepo services)

## Related Documentation

- [runtime-core-design.md](./../ideas/runtime-core-design.md) - Original gate design
- [persistent-environments-platform-plan.md](./../plans/persistent-environments-platform-plan.md) - Overall environment strategy
- [job-api.md](./job-api.md) - Job lifecycle and phases
- [Database Schema](../../packages/db/migrations/) - Gate and job tables
