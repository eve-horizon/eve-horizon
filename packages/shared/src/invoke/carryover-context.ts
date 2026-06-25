/**
 * Declarative context carryover materialisation.
 *
 * Reads `agent_context` from job hints (populated from agents.yaml context
 * blocks during chat/job dispatch) and writes the referenced resources into
 * `.eve/context/` so the harness can access them at runtime.
 *
 * Supports:
 *   - `memory`   — org-doc memory entries for a given agent + categories
 *   - `docs`     — arbitrary org-doc paths (single or recursive)
 *   - `parent_attachments` — named attachments from the parent job
 *   - `threads.coordination` — coordination thread messages
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { HarnessInvocation } from '../types/harness.js';
import type { CarryoverContextDb } from './types.js';
import { readPositiveInt, parseDurationToMs } from './types.js';

/**
 * Materialize declarative context carryover from job hints into `.eve/context/`.
 */
export async function writeCarryoverContext(
  invocation: HarnessInvocation,
  repoPath: string,
  db: CarryoverContextDb,
): Promise<void> {
  try {
    const job = await db.findJobById(invocation.jobId);
    const hints = (job?.hints ?? {}) as Record<string, unknown>;
    const context = hints.agent_context as Record<string, unknown> | undefined;
    if (!context || typeof context !== 'object') return;

    const project = await db.findProjectById(invocation.projectId);
    if (!project) return;
    const orgId = project.org_id;

    const contextRoot = path.join(repoPath, '.eve', 'context');
    await fs.mkdir(contextRoot, { recursive: true });

    // ----- memory -----
    const memory = context.memory as Record<string, unknown> | undefined;
    if (memory && typeof memory === 'object') {
      const agentSlugRaw = typeof memory.agent === 'string'
        ? memory.agent
        : (typeof context.agent_slug === 'string' ? context.agent_slug : null);
      const agentSlug = agentSlugRaw ? agentSlugRaw.trim().toLowerCase() : null;
      const categories = Array.isArray(memory.categories)
        ? memory.categories.map((entry) => String(entry))
        : [];
      const maxItems = readPositiveInt(memory.max_items) ?? 10;
      const maxAgeMs = parseDurationToMs(memory.max_age);

      if (agentSlug && categories.length > 0) {
        const targetDir = path.join(contextRoot, 'memory');
        await fs.mkdir(targetDir, { recursive: true });

        for (const categoryRaw of categories) {
          const category = categoryRaw.trim().toLowerCase();
          if (!category) continue;
          const prefix = `/agents/${agentSlug}/memory/${category}/`;
          const docs = await db.listOrgDocsByPrefix(orgId, prefix, maxItems * 3);
          const filtered = docs
            .filter((doc) => {
              if (!maxAgeMs) return true;
              const ageMs = Date.now() - doc.updated_at.getTime();
              return ageMs <= maxAgeMs;
            })
            .slice(0, maxItems);

          for (const doc of filtered) {
            const base = path.basename(doc.path);
            await fs.writeFile(path.join(targetDir, base), doc.content);
          }
        }
      }
    }

    // ----- docs -----
    const docsConfig = Array.isArray(context.docs) ? context.docs : [];
    if (docsConfig.length > 0) {
      const docsDir = path.join(contextRoot, 'docs');
      await fs.mkdir(docsDir, { recursive: true });

      for (const entry of docsConfig) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const pathRaw = typeof item.path === 'string' ? item.path.trim() : '';
        if (!pathRaw) continue;
        const scopedPath = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;
        const recursive = item.recursive === true;

        if (recursive) {
          const docs = await db.listOrgDocsByPrefix(orgId, scopedPath, 100);
          for (const doc of docs) {
            const relative = doc.path.startsWith('/') ? doc.path.slice(1) : doc.path;
            const targetPath = path.join(docsDir, relative);
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, doc.content);
          }
          continue;
        }

        const doc = await db.findOrgDocByPath(orgId, scopedPath);
        if (!doc) continue;
        const relative = scopedPath.startsWith('/') ? scopedPath.slice(1) : scopedPath;
        const targetPath = path.join(docsDir, relative);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, doc.content);
      }
    }

    // ----- parent_attachments -----
    const parentAttachments = (context.parent_attachments as Record<string, unknown> | undefined)?.names;
    if (Array.isArray(parentAttachments) && invocation.parentJobId) {
      const parentDir = path.join(contextRoot, 'parent');
      await fs.mkdir(parentDir, { recursive: true });
      for (const rawName of parentAttachments) {
        const name = String(rawName).trim();
        if (!name) continue;
        const attachment = await db.findJobAttachment(invocation.parentJobId, name);
        if (!attachment) continue;
        await fs.writeFile(path.join(parentDir, name), attachment.content);
      }
    }

    // ----- threads (coordination) -----
    const threadsCfg = context.threads as Record<string, unknown> | undefined;
    if (threadsCfg?.coordination === true && invocation.parentJobId) {
      const parent = await db.queryJobHints(invocation.parentJobId);
      const coordination = parent?.hints?.coordination as { thread_id?: string } | undefined;
      const threadId = coordination?.thread_id;
      if (threadId) {
        const maxMessages = readPositiveInt(threadsCfg.max_messages) ?? 20;
        const messages = await db.listThreadMessages(threadId, { limit: maxMessages });
        const lines = ['# Coordination Inbox', ''];
        for (const msg of messages) {
          const actor = msg.actor_id ?? msg.actor_type ?? 'unknown';
          lines.push(`- [${msg.created_at.toISOString()}] ${actor}: ${msg.body}`);
        }
        const threadDir = path.join(contextRoot, 'threads');
        await fs.mkdir(threadDir, { recursive: true });
        await fs.writeFile(path.join(threadDir, 'coordination-inbox.md'), lines.join('\n'));
      }
    }
  } catch (err) {
    console.warn(`[context] Failed to materialize carryover context: ${err instanceof Error ? err.message : String(err)}`);
  }
}
