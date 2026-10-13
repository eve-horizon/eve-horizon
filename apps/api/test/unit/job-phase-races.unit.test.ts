import { describe, expect, it, vi } from 'vitest';
import { jobQueries } from '@eve/db';

describe('job phase transition races', () => {
  it('rejects completion when the job changes while the phase transition is being validated', async () => {
    // A successful validation read does not guarantee the conditional write still matches.
    const db = vi.fn((strings: TemplateStringsArray) => {
      const query = strings.join('?').trimStart();
      if (query.startsWith('SELECT')) return Promise.resolve([{ id: 'job_1', phase: 'active', review_required: 'none' }]);
      if (query.startsWith('UPDATE')) return Promise.resolve([]);
      return { fragment: query }; // NOW()/ready_at SQL fragments are synchronous.
    });
    const jobs = jobQueries(db as never);
    const result = await jobs.updatePhase('job_1', 'done');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/changed/i);
  });
});
