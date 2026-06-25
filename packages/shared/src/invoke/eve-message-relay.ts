/**
 * EveMessageRelay — detects ```eve-message fenced blocks in streaming output
 * and relays them to coordination threads + chat channels.
 *
 * Extracted from agent-runtime's invoke.service.ts (the superset version with
 * both coordination relay and chat delivery).
 */

import { randomUUID } from 'crypto';
import { loadConfig } from '../config/schema.js';
import type { ChatDeliveryContext, RelayDb } from './types.js';

/**
 * Post a provisioning-phase error back to the coordination thread (for team
 * jobs) and/or the originating chat thread (for direct chat jobs) before the
 * harness has started. Used when `missing_secret_override` aborts a
 * chat-triggered job — without this, the user sees silence while the job
 * attempt fails.
 *
 * docs/plans/per-job-harness-override-plan.md Phase 3 R2.3. Never contains
 * resolved secret values, only the missing keys.
 */
export async function deliverProvisioningError(
  db: RelayDb,
  params: {
    jobId: string;
    parentJobId: string | null;
    assignee: string | null;
    errorCode: string;
    message: string;
  },
): Promise<void> {
  const body = `⚠️  ${params.errorCode}: ${params.message}`;

  // Coordination thread (team dispatch).
  if (params.parentJobId) {
    try {
      const parent = await db.queryJobHints(params.parentJobId);
      const coordination = parent?.hints?.coordination as { thread_id?: string } | undefined;
      const threadId = coordination?.thread_id;
      if (threadId) {
        await db.createThreadMessage({
          id: randomUUID(),
          thread_id: threadId,
          direction: 'outbound',
          actor_type: 'system',
          actor_id: params.assignee ?? params.jobId,
          body,
          job_id: params.jobId,
        });
      }
    } catch (err) {
      console.error(`[eve-message] Coordination error delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Primary chat thread for direct chat jobs — use job.hints.thread_id.
  try {
    const self = await db.queryJobHints(params.jobId);
    const threadId = typeof self?.hints?.thread_id === 'string' ? (self.hints.thread_id as string) : null;
    if (threadId && threadId !== undefined) {
      await db.createThreadMessage({
        id: randomUUID(),
        thread_id: threadId,
        direction: 'outbound',
        actor_type: 'system',
        actor_id: params.assignee ?? params.jobId,
        body,
        job_id: params.jobId,
      });
    }
  } catch (err) {
    console.error(`[eve-message] Chat error delivery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Rate limit / size constants
// ---------------------------------------------------------------------------

export const EVE_MESSAGE_COORD_RATE_LIMIT_MS = 5000;
export const EVE_MESSAGE_CHAT_RATE_LIMIT_MS = 30_000;
export const EVE_MESSAGE_CHAT_MAX_PER_JOB = 10;
export const EVE_MESSAGE_MAX_SIZE = 4096;

// ---------------------------------------------------------------------------
// EveMessageRelay
// ---------------------------------------------------------------------------

export class EveMessageRelay {
  private buffer: string[] | null = null;
  private lastCoordRelayTime = 0;
  private lastChatDeliveryTime = 0;
  private chatDeliveryCount = 0;

  constructor(
    private db: RelayDb,
    private jobId: string,
    private parentJobId: string | null,
    private assignee: string | null,
    private chatContext: ChatDeliveryContext | null = null,
  ) {}

  /** Feed a raw text line (from harness stdout or extracted text content). */
  async processLine(line: string): Promise<void> {
    const trimmed = line.trim();

    if (trimmed === '```eve-message' || trimmed.startsWith('```eve-message ')) {
      this.buffer = [];
      return;
    }

    if (this.buffer !== null && trimmed === '```') {
      const body = this.buffer.join('\n');
      this.buffer = null;
      await this.relay(body);
      return;
    }

    if (this.buffer !== null) {
      this.buffer.push(line);
    }
  }

  /** Scan a parsed JSON streaming event for text content and process it. */
  async processEvent(parsed: Record<string, unknown>): Promise<void> {
    const raw = parsed?.raw as Record<string, unknown> | undefined;
    if (!raw) return;

    if (raw.type !== 'assistant') return;
    const message = raw.message as Record<string, unknown> | undefined;
    const contentItems = message?.content;
    if (!Array.isArray(contentItems)) return;

    for (const item of contentItems) {
      const c = item as Record<string, unknown>;
      if (c?.type === 'text' && typeof c.text === 'string') {
        for (const line of (c.text as string).split('\n')) {
          await this.processLine(line);
        }
      }
    }
  }

  private async relay(body: string): Promise<void> {
    if (!body.trim()) return;

    // Size limit
    if (body.length > EVE_MESSAGE_MAX_SIZE) {
      body = body.slice(0, EVE_MESSAGE_MAX_SIZE);
    }

    // Path 1: Coordination thread relay (team dispatch)
    if (this.parentJobId) {
      await this.relayToCoordinationThread(body);
    }

    // Path 2: Chat channel delivery (progress updates to Slack/etc.)
    if (this.chatContext) {
      await this.deliverToChat(body);
    }
  }

  private async relayToCoordinationThread(body: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastCoordRelayTime < EVE_MESSAGE_COORD_RATE_LIMIT_MS) {
      console.log(`[eve-message] Coordination relay rate-limited for job ${this.jobId}`);
      return;
    }
    this.lastCoordRelayTime = now;

    try {
      const parent = await this.db.queryJobHints(this.parentJobId!);
      const coordination = parent?.hints?.coordination as { thread_id?: string } | undefined;
      const threadId = coordination?.thread_id;
      if (!threadId) return;

      await this.db.createThreadMessage({
        id: randomUUID(),
        thread_id: threadId,
        direction: 'outbound',
        actor_type: 'agent',
        actor_id: this.assignee ?? this.jobId,
        body,
        job_id: this.jobId,
      });

      console.log(`[eve-message] Relayed to coordination thread ${threadId} from job ${this.jobId}`);
    } catch (err) {
      console.error(`[eve-message] Coordination relay failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async deliverToChat(body: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastChatDeliveryTime < EVE_MESSAGE_CHAT_RATE_LIMIT_MS) {
      return; // silently rate-limit
    }
    if (this.chatDeliveryCount >= EVE_MESSAGE_CHAT_MAX_PER_JOB) {
      return; // cap reached
    }

    // Extract body from JSON if structured ({"kind":"progress","body":"..."})
    let displayText = body;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.body === 'string') {
        displayText = parsed.body;
      }
    } catch { /* not JSON, use raw text */ }

    // Truncate for chat (keep progress messages concise)
    if (displayText.length > 500) {
      displayText = displayText.slice(0, 500) + '...';
    }

    this.lastChatDeliveryTime = now;
    this.chatDeliveryCount++;

    try {
      const config = loadConfig();
      const apiUrl = config.EVE_API_URL ?? process.env.EVE_API_URL;
      if (!apiUrl) return;

      const url = `${apiUrl}/internal/projects/${this.chatContext!.projectId}/chat/deliver`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-internal-token': config.EVE_INTERNAL_API_KEY ?? process.env.EVE_INTERNAL_API_KEY ?? '',
        },
        body: JSON.stringify({
          job_id: this.jobId,
          thread_id: this.chatContext!.threadId,
          text: displayText,
          agent_id: this.assignee ?? undefined,
          progress: true,
        }),
      });

      if (!response.ok) {
        const respBody = await response.text();
        console.error(`[eve-message] Chat delivery failed for job ${this.jobId}: HTTP ${response.status} — ${respBody}`);
        return;
      }

      console.log(`[eve-message] Delivered progress to chat for job ${this.jobId} (${this.chatDeliveryCount}/${EVE_MESSAGE_CHAT_MAX_PER_JOB})`);
    } catch (err) {
      console.error(`[eve-message] Chat delivery error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
