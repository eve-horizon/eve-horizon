import type { Db } from '../client.js';
import { jobIdQueries } from './jobs/ids.js';
import { jobCrudQueries } from './jobs/crud.js';
import { jobSchedulingQueries } from './jobs/scheduling.js';
import { jobHierarchyQueries } from './jobs/hierarchy.js';
import { jobClaimQueries } from './jobs/claim.js';
import { jobAttemptQueries } from './jobs/attempts.js';
import { jobReviewQueries } from './jobs/review.js';

// Re-export all job types from their new home so `import { X } from './jobs.js'`
// (and `@eve/db`) consumers are unaffected by the per-concern split.
export * from './jobs/types.js';

// ============================================================================
// Factory Function (composition point)
// ============================================================================

/**
 * Composed job queries facade.
 *
 * Implementation lives in per-concern factories under ./jobs/ (ids, crud,
 * scheduling, hierarchy, claim, attempts, review). Methods that cross-call
 * another cluster do so via `this`, which resolves against this composed
 * object at call time — identical dispatch to the original single factory.
 */
export function jobQueries(db: Db) {
  return {
    ...jobIdQueries(db),
    ...jobCrudQueries(db),
    ...jobSchedulingQueries(db),
    ...jobHierarchyQueries(db),
    ...jobClaimQueries(db),
    ...jobAttemptQueries(db),
    ...jobReviewQueries(db),
  };
}
