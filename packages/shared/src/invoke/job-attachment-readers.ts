/**
 * Attachments one job takes in from another.
 *
 * A job can take in another job's attachments: its parent's, through
 * `agent_context.parent_attachments`, or any job's in the org, through a
 * `job_attachments:` resource ref. Whoever can write to that other job can
 * attach files to it, so a job takes in only attachments its own actor
 * created.
 */

import { isSameActor } from '../permissions.js';

/**
 * True when a job running as `readerActorUserId` may take in `attachment`:
 * its creator is the same actor. A job no user started (no actor, or the
 * 'system' actor) takes in only attachments created by work no user started.
 */
export function mayReadJobAttachment(
  readerActorUserId: string | null | undefined,
  attachment: { created_by: string | null },
): boolean {
  return isSameActor(attachment.created_by, readerActorUserId);
}
