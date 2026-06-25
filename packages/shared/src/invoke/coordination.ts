/**
 * Coordination inbox and thread context materialisation.
 *
 * Both agent-runtime and worker call these before launching the harness so that
 * multi-turn conversation history and coordination messages are available in the
 * workspace under `.eve/`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { HarnessInvocation } from '../types/harness.js';
import type { CoordinationDb } from './types.js';

/**
 * Write `.eve/coordination-inbox.md` with recent thread messages so the agent
 * can see coordination traffic from sibling jobs.
 */
export async function writeCoordinationInbox(
  invocation: HarnessInvocation,
  repoPath: string,
  db: CoordinationDb,
): Promise<void> {
  if (!invocation.parentJobId) return;

  try {
    const parent = await db.queryJobHints(invocation.parentJobId);
    const coordination = parent?.hints?.coordination as { thread_id?: string } | undefined;
    const threadId = coordination?.thread_id;
    if (!threadId) return;

    const messages = await db.listThreadMessages(threadId, {
      limit: 50,
    });

    if (messages.length === 0) return;

    const lines = ['# Coordination Inbox', ''];
    for (const msg of messages) {
      const dir = msg.direction === 'outbound' ? '>' : '<';
      const actor = msg.actor_id ?? msg.actor_type ?? 'unknown';
      const time = msg.created_at.toISOString();
      lines.push(`${dir} **${actor}** (${time})`);

      // Try to render coordination JSON nicely
      try {
        const parsed = JSON.parse(msg.body);
        if (parsed.kind && parsed.body) {
          lines.push(`  [${parsed.kind}] ${parsed.body}`);
        } else {
          lines.push(`  ${msg.body}`);
        }
      } catch {
        lines.push(`  ${msg.body}`);
      }
      lines.push('');
    }

    const eveDir = path.join(repoPath, '.eve');
    await fs.mkdir(eveDir, { recursive: true });
    await fs.writeFile(path.join(eveDir, 'coordination-inbox.md'), lines.join('\n'));
    console.log(`[inbox] Wrote ${messages.length} message(s) to .eve/coordination-inbox.md`);
  } catch (err) {
    console.warn(`[inbox] Failed to write coordination inbox: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write `.eve/thread-context.json` with conversation history for multi-turn
 * continuity.
 *
 * If the job's hints contain `thread_context` (set by the chat service for
 * messages routed within an existing thread), write it to the workspace so the
 * agent harness can reference prior conversation turns.
 */
export async function writeThreadContext(
  invocation: HarnessInvocation,
  repoPath: string,
  db: CoordinationDb,
): Promise<void> {
  try {
    const job = await db.findJobById(invocation.jobId);
    const hints = (job?.hints ?? {}) as Record<string, unknown>;
    const threadContext = hints.thread_context;
    if (!Array.isArray(threadContext) || threadContext.length === 0) return;

    const eveDir = path.join(repoPath, '.eve');
    await fs.mkdir(eveDir, { recursive: true });
    await fs.writeFile(
      path.join(eveDir, 'thread-context.json'),
      JSON.stringify(threadContext, null, 2),
    );
    console.log(`[thread] Wrote ${threadContext.length} message(s) to .eve/thread-context.json`);
  } catch (err) {
    console.warn(`[thread] Failed to write thread context: ${err instanceof Error ? err.message : String(err)}`);
  }
}
