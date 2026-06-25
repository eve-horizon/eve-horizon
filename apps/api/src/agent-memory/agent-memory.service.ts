import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  agentKvQueries,
  eventQueries,
  orgDocumentQueries,
  orgQueries,
  projectQueries,
  threadMessageQueries,
  threadQueries,
} from '@eve/db';
import { generateEventId } from '@eve/shared';
import { OrgDocumentsService } from '../org-documents/org-documents.service.js';
import { buildApiError } from '../system/api-errors.js';

const MAX_SEARCH_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const MAX_KV_LIST_LIMIT = 500;

const VALID_KV_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

type MemoryCategory = 'learnings' | 'decisions' | 'runbooks' | 'context' | 'conventions' | 'user';

type MemorySetInput = {
  category: MemoryCategory;
  key: string;
  content: string;
  mime_type?: string;
  confidence?: number;
  tags?: string[];
  supersedes?: string;
  metadata?: Record<string, unknown>;
  review_due?: string;
  expires_at?: string;
  lifecycle_status?: 'active' | 'stale' | 'archived' | 'expired';
};

type DistillInput = {
  to_path?: string;
  agent?: string;
  category?: MemoryCategory;
  key?: string;
  prompt?: string;
  auto?: boolean;
  threshold?: number;
  interval?: string;
};

@Injectable()
export class AgentMemoryService {
  private readonly docs;
  private readonly orgs;
  private readonly kv;
  private readonly threads;
  private readonly threadMessages;
  private readonly projects;
  private readonly events;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly orgDocuments: OrgDocumentsService,
  ) {
    this.docs = orgDocumentQueries(db);
    this.orgs = orgQueries(db);
    this.kv = agentKvQueries(db);
    this.threads = threadQueries(db);
    this.threadMessages = threadMessageQueries(db);
    this.projects = projectQueries(db);
    this.events = eventQueries(db);
  }

  private async resolveOrgId(orgIdOrSlug: string): Promise<string> {
    const byId = await this.orgs.findById(orgIdOrSlug);
    if (byId) return byId.id;
    const bySlug = await this.orgs.findBySlug(orgIdOrSlug);
    if (bySlug) return bySlug.id;
    throw buildApiError(404, 'resource_not_found', `Organization ${orgIdOrSlug} not found`);
  }

  private normalizeKey(key: string): string {
    const trimmed = key.trim();
    if (!trimmed) {
      throw buildApiError(400, 'resource_uri_invalid', 'memory key is required');
    }
    return trimmed.replace(/\.md$/i, '');
  }

  private normalizeCategory(category: string): MemoryCategory {
    const normalized = category.trim().toLowerCase();
    if (!['learnings', 'decisions', 'runbooks', 'context', 'conventions', 'user'].includes(normalized)) {
      throw buildApiError(400, 'resource_uri_invalid', `Unsupported memory category: ${category}`);
    }
    return normalized as MemoryCategory;
  }

  private normalizeAgentSlug(agentSlug: string): string {
    const trimmed = agentSlug.trim().toLowerCase();
    if (!trimmed || !/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
      throw buildApiError(400, 'resource_uri_invalid', `Invalid agent slug: ${agentSlug}`);
    }
    return trimmed;
  }

  private validateKvName(value: string, label: string): string {
    const trimmed = value.trim();
    if (!VALID_KV_NAME.test(trimmed)) {
      throw buildApiError(400, 'resource_uri_invalid', `Invalid KV ${label}: must be 1-128 alphanumeric chars (._- allowed)`);
    }
    return trimmed;
  }

  private requireQuery(query: string | undefined | null): string {
    const trimmed = (query ?? '').trim();
    if (!trimmed) {
      throw buildApiError(400, 'resource_uri_invalid', 'Search query (q) is required and cannot be empty');
    }
    return trimmed;
  }

  private capLimit(value: number, max: number): number {
    return Math.max(1, Math.min(value, max));
  }

  memoryPath(agentSlug: string, category: string, key: string): string {
    const slug = this.normalizeAgentSlug(agentSlug);
    const safeCategory = this.normalizeCategory(category);
    const safeKey = this.normalizeKey(key);
    return `/agents/${slug}/memory/${safeCategory}/${safeKey}.md`;
  }

  async setMemory(
    orgIdOrSlug: string,
    agentSlug: string,
    input: MemorySetInput,
    actorId?: string,
    requestId?: string,
  ) {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const slug = this.normalizeAgentSlug(agentSlug);
    const category = this.normalizeCategory(input.category);
    const key = this.normalizeKey(input.key);
    const path = this.memoryPath(slug, category, key);

    const existing = await this.docs.findByOrgAndPath(orgId, path);
    const metadataBase = existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
    const metadata = {
      ...metadataBase,
      ...(input.metadata ?? {}),
      memory: {
        owner_type: slug === 'shared' ? 'shared' : 'agent',
        owner_slug: slug,
        category,
        confidence: input.confidence ?? null,
        tags: Array.isArray(input.tags) ? input.tags : [],
        supersedes: input.supersedes ?? null,
      },
    };

    if (existing) {
      const updateData: Record<string, unknown> = {
        content: input.content,
        mime_type: input.mime_type,
        metadata,
      };
      if (input.review_due !== undefined) updateData.review_due = input.review_due ?? null;
      if (input.expires_at !== undefined) updateData.expires_at = input.expires_at ?? null;
      if (input.lifecycle_status !== undefined) updateData.lifecycle_status = input.lifecycle_status;

      return this.orgDocuments.update(
        orgId,
        path,
        updateData as Parameters<typeof this.orgDocuments.update>[2],
        actorId,
        requestId,
      );
    }

    return this.orgDocuments.create(
      orgId,
      {
        path,
        content: input.content,
        mime_type: input.mime_type ?? 'text/markdown',
        metadata,
        review_due: input.review_due,
        expires_at: input.expires_at,
        lifecycle_status: input.lifecycle_status ?? 'active',
      },
      actorId,
      requestId,
    );
  }

  async getMemory(orgIdOrSlug: string, agentSlug: string, key: string, category?: string) {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const slug = this.normalizeAgentSlug(agentSlug);
    const safeKey = this.normalizeKey(key);

    if (category) {
      return this.orgDocuments.getByPath(orgId, this.memoryPath(slug, category, safeKey));
    }

    const prefix = `/agents/${slug}/memory/`;
    const docs = await this.docs.listByOrgAndPrefix(orgId, prefix, 200);
    const match = docs.find((doc) => doc.path.endsWith(`/${safeKey}.md`));
    if (!match) {
      throw buildApiError(404, 'resource_not_found', `Memory entry not found: ${safeKey}`);
    }
    return this.orgDocuments.getByPath(orgId, match.path);
  }

  async listMemory(
    orgIdOrSlug: string,
    agentSlug: string,
    options: { category?: string; tags?: string[]; limit?: number } = {},
  ) {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const slug = this.normalizeAgentSlug(agentSlug);
    const prefix = options.category
      ? `/agents/${slug}/memory/${this.normalizeCategory(options.category)}/`
      : `/agents/${slug}/memory/`;
    const rows = await this.docs.listByOrgAndPrefix(orgId, prefix, this.capLimit(options.limit ?? 100, MAX_LIST_LIMIT));

    const tags = (options.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    const filtered = tags.length === 0
      ? rows
      : rows.filter((row) => {
          const memory = row.metadata?.memory as Record<string, unknown> | undefined;
          const rowTags = Array.isArray(memory?.tags) ? memory?.tags.map((tag) => String(tag).toLowerCase()) : [];
          return tags.every((tag) => rowTags.includes(tag));
        });

    return {
      documents: filtered.map((row) => ({
        id: row.id,
        path: row.path,
        mime_type: row.mime_type,
        content_hash: row.content_hash,
        metadata: row.metadata,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
        lifecycle_status: row.lifecycle_status,
        review_due: row.review_due ? row.review_due.toISOString() : null,
        expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      })),
    };
  }

  async searchMemory(
    orgIdOrSlug: string,
    query: string,
    options: { agent?: string; limit?: number } = {},
  ) {
    const q = this.requireQuery(query);
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const prefix = options.agent
      ? `/agents/${this.normalizeAgentSlug(options.agent)}/memory/`
      : '/agents/';
    const docs = await this.docs.searchWithFilters(orgId, q, {
      pathPrefix: prefix,
      limit: this.capLimit(options.limit ?? 20, MAX_SEARCH_LIMIT),
    });
    return {
      data: docs.map((doc) => ({
        source: 'memory',
        path: doc.path,
        score: doc.rank,
        snippet: doc.headline,
        updated_at: doc.updated_at.toISOString(),
      })),
    };
  }

  async deleteMemory(
    orgIdOrSlug: string,
    agentSlug: string,
    category: string,
    key: string,
    actorId?: string,
    requestId?: string,
  ) {
    const path = this.memoryPath(agentSlug, category, key);
    return this.orgDocuments.delete(orgIdOrSlug, path, actorId, requestId);
  }

  async kvPut(
    orgIdOrSlug: string,
    agentSlug: string,
    namespace: string,
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ) {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const ns = this.validateKvName(namespace || 'default', 'namespace');
    const k = this.validateKvName(key, 'key');
    const row = await this.kv.put({
      org_id: orgId,
      agent_slug: this.normalizeAgentSlug(agentSlug),
      namespace: ns,
      key: k,
      value,
      ttl_seconds: ttlSeconds,
    });
    return this.toKvResponse(row);
  }

  async kvGet(orgIdOrSlug: string, agentSlug: string, namespace: string, key: string) {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const ns = this.validateKvName(namespace || 'default', 'namespace');
    const k = this.validateKvName(key, 'key');
    const row = await this.kv.get(orgId, this.normalizeAgentSlug(agentSlug), ns, k);
    if (!row) {
      throw buildApiError(404, 'resource_not_found', `KV entry not found: ${ns}/${k}`);
    }
    return this.toKvResponse(row);
  }

  async kvList(orgIdOrSlug: string, agentSlug: string, namespace: string, limit?: number) {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const ns = this.validateKvName(namespace || 'default', 'namespace');
    const rows = await this.kv.list(orgId, this.normalizeAgentSlug(agentSlug), ns, this.capLimit(limit ?? 100, MAX_KV_LIST_LIMIT));
    return { entries: rows.map((row) => this.toKvResponse(row)) };
  }

  async kvMget(orgIdOrSlug: string, agentSlug: string, namespace: string, keys: string[]) {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const ns = this.validateKvName(namespace || 'default', 'namespace');
    if (keys.length > MAX_KV_LIST_LIMIT) {
      throw buildApiError(400, 'resource_uri_invalid', `Too many keys: max ${MAX_KV_LIST_LIMIT}`);
    }
    const rows = await this.kv.mget(orgId, this.normalizeAgentSlug(agentSlug), ns, keys);
    return { entries: rows.map((row) => this.toKvResponse(row)) };
  }

  async kvDelete(orgIdOrSlug: string, agentSlug: string, namespace: string, key: string) {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const ns = this.validateKvName(namespace || 'default', 'namespace');
    const k = this.validateKvName(key, 'key');
    const deleted = await this.kv.delete(orgId, this.normalizeAgentSlug(agentSlug), ns, k);
    return { success: deleted };
  }

  async unifiedSearch(
    orgIdOrSlug: string,
    query: string,
    options: { sources?: string[]; limit?: number; agent?: string } = {},
  ) {
    const q = this.requireQuery(query);
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const sources = new Set((options.sources ?? ['memory', 'docs', 'threads', 'attachments', 'events']).map((s) => s.trim()));
    const limit = this.capLimit(options.limit ?? 20, MAX_SEARCH_LIMIT);
    const rows: Array<Record<string, unknown>> = [];

    if (sources.has('memory') || sources.has('docs')) {
      const docs = await this.docs.searchWithFilters(orgId, q, {
        limit: Math.min(limit * 2, MAX_SEARCH_LIMIT),
      });
      for (const doc of docs) {
        const isMemory = doc.path.includes('/memory/');
        if (isMemory && !sources.has('memory')) continue;
        if (!isMemory && !sources.has('docs')) continue;
        if (options.agent && (!isMemory || !doc.path.startsWith(`/agents/${this.normalizeAgentSlug(options.agent)}/`))) continue;
        rows.push({
          source: isMemory ? 'memory' : 'docs',
          path: doc.path,
          snippet: doc.headline,
          score: Number(doc.rank ?? 0),
          updated_at: doc.updated_at.toISOString(),
        });
      }
    }

    if (sources.has('threads')) {
      const threadRows = await this.db<Array<{
        thread_id: string;
        message_id: string;
        body: string;
        created_at: Date;
        rank: number;
      }>>`
        SELECT
          tm.thread_id,
          tm.id AS message_id,
          tm.body,
          tm.created_at,
          ts_rank(tm.search_vector, plainto_tsquery('english', ${q})) AS rank
        FROM thread_messages tm
        JOIN threads t ON t.id = tm.thread_id
        WHERE t.org_id = ${orgId}
          AND tm.search_vector @@ plainto_tsquery('english', ${q})
        ORDER BY rank DESC, tm.created_at DESC
        LIMIT ${Math.min(limit * 2, MAX_SEARCH_LIMIT)}
      `;
      for (const row of threadRows) {
        rows.push({
          source: 'threads',
          thread_id: row.thread_id,
          message_id: row.message_id,
          snippet: row.body.slice(0, 240),
          score: Number(row.rank ?? 0),
          created_at: row.created_at.toISOString(),
        });
      }
    }

    if (sources.has('attachments')) {
      const attRows = await this.db<Array<{
        id: string;
        job_id: string;
        name: string;
        content: string;
        created_at: Date;
        rank: number;
      }>>`
        SELECT
          a.id,
          a.job_id,
          a.name,
          a.content,
          a.created_at,
          ts_rank(a.search_vector, plainto_tsquery('english', ${q})) AS rank
        FROM job_attachments a
        JOIN jobs j ON j.id = a.job_id
        JOIN projects p ON p.id = j.project_id
        WHERE p.org_id = ${orgId}
          AND a.search_vector @@ plainto_tsquery('english', ${q})
        ORDER BY rank DESC, a.created_at DESC
        LIMIT ${Math.min(limit * 2, MAX_SEARCH_LIMIT)}
      `;
      for (const row of attRows) {
        rows.push({
          source: 'attachments',
          attachment_id: row.id,
          job_id: row.job_id,
          name: row.name,
          snippet: row.content.slice(0, 240),
          score: Number(row.rank ?? 0),
          created_at: row.created_at.toISOString(),
        });
      }
    }

    if (sources.has('events')) {
      const escapedQ = escapeLikePattern(q);
      const eventRows = await this.db<Array<{
        id: string;
        type: string;
        project_id: string;
        payload_json: Record<string, unknown> | null;
        created_at: Date;
      }>>`
        SELECT e.id, e.type, e.project_id, e.payload_json, e.created_at
        FROM events e
        JOIN projects p ON p.id = e.project_id
        WHERE p.org_id = ${orgId}
          AND (
            e.type ILIKE ${`%${escapedQ}%`}
            OR COALESCE(e.payload_json::text, '') ILIKE ${`%${escapedQ}%`}
          )
        ORDER BY e.created_at DESC
        LIMIT ${Math.min(limit * 2, MAX_SEARCH_LIMIT)}
      `;
      for (const row of eventRows) {
        rows.push({
          source: 'events',
          event_id: row.id,
          type: row.type,
          project_id: row.project_id,
          snippet: JSON.stringify(row.payload_json ?? {}).slice(0, 240),
          score: 0.2,
          created_at: row.created_at.toISOString(),
        });
      }
    }

    const ranked = rows
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
      .slice(0, limit);

    return { data: ranked };
  }

  async distillThread(
    orgIdOrSlug: string,
    threadId: string,
    input: DistillInput,
    actorId?: string,
    requestId?: string,
  ) {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const thread = await this.threads.findById(threadId);
    if (!thread) {
      throw buildApiError(404, 'resource_not_found', `Thread ${threadId} not found`, { requestId });
    }

    if (thread.org_id !== orgId) {
      if (!thread.project_id) {
        throw buildApiError(404, 'resource_not_found', `Thread ${threadId} not found`, { requestId });
      }
      const project = await this.projects.findById(thread.project_id);
      if (!project || project.org_id !== orgId) {
        throw buildApiError(404, 'resource_not_found', `Thread ${threadId} not found`, { requestId });
      }
    }

    const messages = await this.threadMessages.listByThread(threadId, { limit: 300 });
    const threshold = typeof input.threshold === 'number' ? input.threshold : 0;
    if (input.auto && threshold > 0 && messages.length < threshold) {
      return {
        status: 'skipped',
        reason: 'below_threshold',
        thread_id: threadId,
        message_count: messages.length,
      };
    }

    const prompt = input.prompt ?? 'Extract key decisions, rationale, and durable learnings.';
    const topLines = messages
      .slice(-40)
      .map((msg) => `- [${msg.created_at.toISOString()}] ${msg.actor_id ?? msg.actor_type ?? 'unknown'}: ${msg.body.replace(/\s+/g, ' ').slice(0, 220)}`);
    const distilled = [
      '# Thread Distillation',
      '',
      `Thread: ${threadId}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Distillation Prompt',
      prompt,
      '',
      '## Message Digest',
      ...topLines,
      '',
      '## Durable Decisions',
      '- Review digest and promote concrete decisions into project runbooks/decision docs.',
    ].join('\n');

    const targetPath = input.to_path
      ? (input.to_path.startsWith('/') ? input.to_path : `/${input.to_path}`)
      : this.memoryPath(
          input.agent ? this.normalizeAgentSlug(input.agent) : 'shared',
          input.category ?? 'decisions',
          input.key ?? `thread-${threadId}`,
        );

    const existing = await this.docs.findByOrgAndPath(orgId, targetPath);
    const metadata = {
      thread_distillation: {
        thread_id: threadId,
        prompt,
        message_count: messages.length,
        generated_at: new Date().toISOString(),
        interval: input.interval ?? null,
      },
    };

    const document = existing
      ? await this.orgDocuments.update(
          orgId,
          targetPath,
          { content: distilled, metadata, mime_type: 'text/markdown' },
          actorId,
          requestId,
        )
      : await this.orgDocuments.create(
          orgId,
          {
            path: targetPath,
            content: distilled,
            mime_type: 'text/markdown',
            metadata,
          },
          actorId,
          requestId,
        );

    await this.threads.setSummary(threadId, `Distilled ${messages.length} messages to ${targetPath}`);

    const eventProjectId = thread.project_id ?? (await this.projects.findFirstByOrg(orgId))?.id ?? null;
    if (eventProjectId) {
      await this.events.create({
        id: generateEventId(),
        project_id: eventProjectId,
        type: 'system.thread.distilled',
        source: 'system',
        env_name: null,
        ref_sha: null,
        ref_branch: null,
        actor_type: actorId ? 'user' : 'system',
        actor_id: actorId ?? null,
        payload_json: {
          org_id: orgId,
          thread_id: threadId,
          path: targetPath,
          doc_id: document.id,
          message_count: messages.length,
        },
        dedupe_key: `thread:${threadId}:distill:${document.id}`,
      });
    }

    return {
      status: 'ok',
      thread_id: threadId,
      path: targetPath,
      doc_id: document.id,
      message_count: messages.length,
      summary: `Distilled ${messages.length} message(s)`,
    };
  }

  private toKvResponse(row: {
    id: string;
    org_id: string;
    agent_slug: string;
    namespace: string;
    key: string;
    value: unknown;
    ttl_seconds: number | null;
    expires_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }) {
    return {
      id: row.id,
      org_id: row.org_id,
      agent_slug: row.agent_slug,
      namespace: row.namespace,
      key: row.key,
      value: row.value,
      ttl_seconds: row.ttl_seconds,
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}
