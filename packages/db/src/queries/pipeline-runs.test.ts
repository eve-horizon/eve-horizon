/**
 * Unit tests for pipeline run dedupe behavior
 */

import { describe, it, expect, beforeEach } from 'vitest';
import postgres from 'postgres';
import { pipelineRunQueries, type PipelineRun } from './pipeline-runs.js';
import { generatePipelineRunId } from '@eve/shared';

// Test database connection
// This assumes you have a test database setup
const testDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!testDbUrl) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL environment variable is required for tests');
}

describe('Pipeline Run Deduplication', () => {
  let db: ReturnType<typeof postgres>;
  let runs: ReturnType<typeof pipelineRunQueries>;
  const testProjectId = 'test-project-' + Math.random().toString(36).substring(7);

  beforeEach(async () => {
    db = postgres(testDbUrl);
    runs = pipelineRunQueries(db);

    // Clean up any existing test runs
    await db`DELETE FROM pipeline_runs WHERE project_id = ${testProjectId}`;
  });

  it('should allow creating a run without dedupe_key', async () => {
    const run = await runs.createRun({
      id: generatePipelineRunId(),
      project_id: testProjectId,
      pipeline_name: 'test-pipeline',
      env_name: null,
      git_sha: 'abc123',
      manifest_hash: 'hash1',
      inputs_json: null,
      step_outputs_json: null,
      status: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: null,
      run_mode: null,
      dedupe_key: null,
    });

    expect(run).toBeDefined();
    expect(run.dedupe_key).toBeNull();
  });

  it('should allow creating a run with dedupe_key', async () => {
    const dedupeKey = 'pr:owner/repo:123';
    const run = await runs.createRun({
      id: generatePipelineRunId(),
      project_id: testProjectId,
      pipeline_name: 'test-pipeline',
      env_name: 'pr-123',
      git_sha: 'abc123',
      manifest_hash: 'hash1',
      inputs_json: null,
      step_outputs_json: null,
      status: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: null,
      run_mode: null,
      dedupe_key: dedupeKey,
    });

    expect(run).toBeDefined();
    expect(run.dedupe_key).toBe(dedupeKey);
  });

  it('should prevent duplicate active runs with same dedupe_key', async () => {
    const dedupeKey = 'pr:owner/repo:456';

    // Create first run
    const run1 = await runs.createRun({
      id: generatePipelineRunId(),
      project_id: testProjectId,
      pipeline_name: 'test-pipeline',
      env_name: 'pr-456',
      git_sha: 'abc123',
      manifest_hash: 'hash1',
      inputs_json: null,
      step_outputs_json: null,
      status: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: null,
      run_mode: null,
      dedupe_key: dedupeKey,
    });

    expect(run1).toBeDefined();

    // Attempt to create second run with same dedupe_key should fail
    await expect(
      runs.createRun({
        id: generatePipelineRunId(),
        project_id: testProjectId,
        pipeline_name: 'test-pipeline',
        env_name: 'pr-456',
        git_sha: 'def456',
        manifest_hash: 'hash1',
        inputs_json: null,
        step_outputs_json: null,
        status: 'pending',
        started_at: null,
        completed_at: null,
        error_message: null,
        requested_by: null,
        run_mode: null,
        dedupe_key: dedupeKey,
      }),
    ).rejects.toThrow();
  });

  it('should allow creating new run with same dedupe_key after first completes', async () => {
    const dedupeKey = 'pr:owner/repo:789';

    // Create first run
    const run1 = await runs.createRun({
      id: generatePipelineRunId(),
      project_id: testProjectId,
      pipeline_name: 'test-pipeline',
      env_name: 'pr-789',
      git_sha: 'abc123',
      manifest_hash: 'hash1',
      inputs_json: null,
      step_outputs_json: null,
      status: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: null,
      run_mode: null,
      dedupe_key: dedupeKey,
    });

    // Complete the first run
    await runs.updateRun(run1.id, {
      status: 'succeeded',
      completed_at: new Date(),
    });

    // Should be able to create a new run with the same dedupe_key
    const run2 = await runs.createRun({
      id: generatePipelineRunId(),
      project_id: testProjectId,
      pipeline_name: 'test-pipeline',
      env_name: 'pr-789',
      git_sha: 'def456',
      manifest_hash: 'hash1',
      inputs_json: null,
      step_outputs_json: null,
      status: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: null,
      run_mode: null,
      dedupe_key: dedupeKey,
    });

    expect(run2).toBeDefined();
    expect(run2.id).not.toBe(run1.id);
  });

  it('should find active run by dedupe_key', async () => {
    const dedupeKey = 'pr:owner/repo:999';

    const createdRun = await runs.createRun({
      id: generatePipelineRunId(),
      project_id: testProjectId,
      pipeline_name: 'test-pipeline',
      env_name: 'pr-999',
      git_sha: 'abc123',
      manifest_hash: 'hash1',
      inputs_json: null,
      step_outputs_json: null,
      status: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: null,
      run_mode: null,
      dedupe_key: dedupeKey,
    });

    const foundRun = await runs.findActiveRunByDedupeKey(dedupeKey);

    expect(foundRun).toBeDefined();
    expect(foundRun?.id).toBe(createdRun.id);
    expect(foundRun?.dedupe_key).toBe(dedupeKey);
  });

  it('should not find completed run by dedupe_key', async () => {
    const dedupeKey = 'pr:owner/repo:1000';

    const createdRun = await runs.createRun({
      id: generatePipelineRunId(),
      project_id: testProjectId,
      pipeline_name: 'test-pipeline',
      env_name: 'pr-1000',
      git_sha: 'abc123',
      manifest_hash: 'hash1',
      inputs_json: null,
      step_outputs_json: null,
      status: 'succeeded',
      started_at: new Date(),
      completed_at: new Date(),
      error_message: null,
      requested_by: null,
      run_mode: null,
      dedupe_key: dedupeKey,
    });

    const foundRun = await runs.findActiveRunByDedupeKey(dedupeKey);

    expect(foundRun).toBeNull();
  });
});
