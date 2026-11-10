/**
 * Threads named in job hints.
 *
 * Job hints (`coordination.thread_id`, `thread_id`) are supplied by whoever
 * creates the job, so a thread they name is used only when it belongs to the
 * job's own project.
 */

import type { ThreadProjectReader } from './types.js';

/**
 * The thread id from a hint when that thread belongs to `projectId`;
 * undefined for a missing or malformed id, an org thread, or another
 * project's thread.
 */
export async function projectThreadId(
  db: ThreadProjectReader,
  threadId: unknown,
  projectId: string | null | undefined,
): Promise<string | undefined> {
  if (typeof threadId !== 'string' || !threadId || !projectId) return undefined;
  const owner = await db.findThreadProjectId(threadId);
  if (owner !== projectId) {
    console.warn(`[threads] Ignoring thread ${threadId} from job hints: not in project ${projectId}`);
    return undefined;
  }
  return threadId;
}
