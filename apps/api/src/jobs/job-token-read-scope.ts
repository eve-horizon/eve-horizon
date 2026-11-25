/**
 * Rule jobs.token_read_scope (project, rule set 5): a job token reads only
 * the jobs of its own tree (its root and every job under it, parents and
 * siblings included) and the other steps of its own pipeline run. The
 * permission guard holds `/jobs/:job_id` reads to it; project job lists show
 * a job token only those jobs under `strict`.
 */
export const JOB_TOKEN_READ_SCOPE_RULE = 'jobs.token_read_scope';

/** The root of a job's tree: job ids are hierarchical (`proj-1a2b3c4d.2.1`). */
export function jobTreeRoot(jobId: string): string {
  const dot = jobId.indexOf('.');
  return dot === -1 ? jobId : jobId.slice(0, dot);
}

/** Whether a job token for `readerJobId` (a step of `readerRunId`, if any) reads `job` within its scope. */
export function inReadScope(
  reader: { jobId: string; runId: string | null },
  job: { id: string; run_id?: string | null },
): boolean {
  return jobTreeRoot(job.id) === jobTreeRoot(reader.jobId) || Boolean(reader.runId && job.run_id === reader.runId);
}
