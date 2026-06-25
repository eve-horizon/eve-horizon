import { describe, it } from 'vitest';

/**
 * OAuth Token Refresh Tests
 *
 * These tests were designed for the old execution model where jobs
 * auto-executed upon creation. The new job model is queue-based:
 *
 * 1. Jobs are created in 'backlog' phase
 * 2. Jobs must be moved to 'ready' phase
 * 3. An orchestrator claims ready jobs
 * 4. Worker executes the job with the harness
 *
 * OAuth token refresh testing requires the full execution pipeline
 * (orchestrator + worker + harness) which is tested separately.
 *
 * TODO: Re-implement these tests once the execution pipeline has
 * integration tests, or test OAuth refresh at the harness level.
 */
describe.skip('integration oauth token refresh', () => {
  it('successfully refreshes expired oauth token and completes job', async () => {
    // This test requires the full execution pipeline:
    // - Create job with expired OAuth token
    // - Orchestrator claims job
    // - Worker invokes mclaude
    // - mclaude refreshes token and completes
    //
    // For now, OAuth refresh is tested at the mclaude/harness level.
  });

  it('recovers from invalid access token using refresh token', async () => {
    // This test requires the full execution pipeline.
    // See note above.
  });
});
