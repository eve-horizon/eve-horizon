import { Injectable, Inject, Logger } from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  orgDocumentQueries,
  orgQueries,
  eventQueries,
  projectQueries,
  type OrgDocument,
  type OrgDocumentSearchResult,
  type OrgDocumentVersion,
  type OrgDocumentVersionSummary,
} from '@eve/db';
import {
  MAX_ORG_DOCUMENT_SIZE,
  type CreateOrgDocumentRequest,
  type UpdateOrgDocumentRequest,
  type PatchOrgDocumentRequest,
  type OrgDocumentResponse,
  type OrgDocumentDetailResponse,
  type OrgDocumentListResponse,
  type OrgDocumentSearchResult as OrgDocumentSearchResultSchema,
  type OrgDocumentVersionListResponse,
  type OrgDocumentVersionDetail,
  type OrgDocumentQueryRequest,
  type OrgDocumentQueryResponse,
  generateEventId,
  generateMutationId,
} from '@eve/shared';
import { buildApiError } from '../system/api-errors.js';

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class OrgDocumentsService {
  private documents: ReturnType<typeof orgDocumentQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private events: ReturnType<typeof eventQueries>;
  private readonly logger = new Logger(OrgDocumentsService.name);

  constructor(@Inject('DB') private readonly db: Db) {
    this.documents = orgDocumentQueries(db);
    this.orgs = orgQueries(db);
    this.events = eventQueries(db);
  }

  // --------------------------------------------------------------------------
  // Org Resolution
  // --------------------------------------------------------------------------

  private async resolveOrgId(orgIdOrSlug: string): Promise<string> {
    const byId = await this.orgs.findById(orgIdOrSlug);
    if (byId) return byId.id;

    const bySlug = await this.orgs.findBySlug(orgIdOrSlug);
    if (bySlug) return bySlug.id;

    throw buildApiError(404, 'resource_not_found', `Organization ${orgIdOrSlug} not found`);
  }

  private encodeCursor(doc: OrgDocument): string {
    const payload = {
      updated_at: doc.updated_at instanceof Date ? doc.updated_at.toISOString() : String(doc.updated_at),
      id: doc.id,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  }

  private decodeCursor(cursor: string, requestId?: string | null): { updated_at: string; id: string } {
    try {
      const decoded = Buffer.from(cursor, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded) as { updated_at?: string; id?: string };
      if (!parsed?.updated_at || !parsed?.id) {
        throw new Error('cursor missing fields');
      }
      return { updated_at: parsed.updated_at, id: parsed.id };
    } catch (err) {
      throw buildApiError(400, 'doc_query_invalid_filter', 'Invalid cursor value', {
        requestId,
        details: { cursor },
      });
    }
  }

  // --------------------------------------------------------------------------
  // Create
  // --------------------------------------------------------------------------

  async create(
    orgIdOrSlug: string,
    data: CreateOrgDocumentRequest,
    createdBy?: string,
    requestId?: string,
  ): Promise<OrgDocumentDetailResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);

    const contentSize = Buffer.byteLength(data.content, 'utf8');
    if (contentSize > MAX_ORG_DOCUMENT_SIZE) {
      throw buildApiError(
        400,
        'resource_uri_invalid',
        `Document size (${contentSize} bytes) exceeds maximum of ${MAX_ORG_DOCUMENT_SIZE} bytes (10 MB)`,
        { requestId },
      );
    }

    // Check for duplicate path
    const existing = await this.documents.findByOrgAndPath(orgId, data.path);
    if (existing) {
      throw buildApiError(409, 'resource_conflict', `Document already exists at path: ${data.path}`, {
        requestId,
        details: { path: data.path },
      });
    }
    const mutationId = generateMutationId();

    const document = await this.db.begin(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const docs = orgDocumentQueries(tx);
      const events = eventQueries(tx);
      const projects = projectQueries(tx);

      const created = await docs.create({
        org_id: orgId,
        path: data.path,
        content: data.content,
        mime_type: data.mime_type ?? 'text/markdown',
        project_id: data.project_id ?? null,
        created_by: createdBy ?? null,
        metadata: data.metadata,
        review_due: data.review_due ?? null,
        expires_at: data.expires_at ?? null,
        lifecycle_status: data.lifecycle_status ?? 'active',
      });

      const version = await docs.createVersion({
        doc_id: created.id,
        version: 1,
        content: data.content,
        metadata: data.metadata,
        created_by: createdBy ?? null,
        mutation_id: mutationId,
      });

      // Events are project-scoped; fall back to a deterministic project when doc is org-scoped.
      const projectId = created.project_id
        ? created.project_id
        : (await projects.findFirstByOrg(orgId))?.id;
      if (!projectId) {
        this.logger.warn(
          `Skipping doc.created event for ${created.id} (org ${orgId} has no projects)`
        );
      } else {
        await events.create({
          id: generateEventId(),
          project_id: projectId,
          type: 'system.doc.created',
          source: 'system',
          env_name: null,
          ref_sha: null,
          ref_branch: null,
          actor_type: createdBy ? 'user' : 'system',
          actor_id: createdBy ?? null,
          payload_json: {
            org_id: orgId,
            project_id: created.project_id ?? projectId,
            doc_id: created.id,
            doc_version_id: version.id,
            path: created.path,
            version: version.version,
            content_hash: `sha256:${version.content_hash}`,
            actor_id: createdBy ?? null,
            mutation_id: mutationId,
            request_id: requestId ?? null,
            metadata: created.metadata ?? {},
          },
          dedupe_key: `doc:${created.id}:mutation:${mutationId}`,
        });
      }

      return { created, version };
    });

    return this.toDetailResponse(document.created, document.version);
  }

  // --------------------------------------------------------------------------
  // Read
  // --------------------------------------------------------------------------

  async getByPath(
    orgIdOrSlug: string,
    path: string,
    requestId?: string,
  ): Promise<OrgDocumentDetailResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const document = await this.documents.findByOrgAndPath(orgId, path);
    if (!document) {
      throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
        requestId,
        details: { path },
      });
    }
    const versionInfo = await this.documents.getLatestVersionInfo(document.id);
    return this.toDetailResponse(document, versionInfo ?? undefined);
  }

  // --------------------------------------------------------------------------
  // List
  // --------------------------------------------------------------------------

  async listByPrefix(
    orgIdOrSlug: string,
    prefix: string,
    limit?: number,
  ): Promise<OrgDocumentListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const documents = await this.documents.listByOrgAndPrefix(orgId, prefix, limit);
    return {
      documents: documents.map(d => this.toResponse(d)),
    };
  }

  // --------------------------------------------------------------------------
  // Update (full replace)
  // --------------------------------------------------------------------------

  async update(
    orgIdOrSlug: string,
    path: string,
    data: UpdateOrgDocumentRequest,
    actorId?: string,
    requestId?: string,
  ): Promise<OrgDocumentDetailResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);

    const contentSize = Buffer.byteLength(data.content, 'utf8');
    if (contentSize > MAX_ORG_DOCUMENT_SIZE) {
      throw buildApiError(
        400,
        'resource_uri_invalid',
        `Document size (${contentSize} bytes) exceeds maximum of ${MAX_ORG_DOCUMENT_SIZE} bytes (10 MB)`,
        { requestId },
      );
    }

    const existing = await this.documents.findByOrgAndPath(orgId, path);
    if (!existing) {
      throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
        requestId,
        details: { path },
      });
    }
    const mutationId = generateMutationId();

    const updated = await this.db.begin(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const docs = orgDocumentQueries(tx);
      const events = eventQueries(tx);
      const projects = projectQueries(tx);

      const latest = await docs.getLatestVersionInfo(existing.id);
      let nextVersion = (latest?.version ?? 0) + 1;

      if (!latest) {
        await docs.createVersion({
          doc_id: existing.id,
          version: 1,
          content: existing.content,
          metadata: existing.metadata,
          created_by: existing.created_by,
          mutation_id: null,
        });
        nextVersion = 2;
      }

      const next = await docs.update(existing.id, {
        content: data.content,
        mime_type: data.mime_type,
        metadata: data.metadata,
        review_due: data.review_due,
        expires_at: data.expires_at,
        lifecycle_status: data.lifecycle_status,
        embedding_model: data.embedding_model,
        embedding_json: data.embedding_json ?? undefined,
        embedded_at: data.embedded_at,
      });

      if (!next) {
        throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
          requestId,
          details: { path },
        });
      }

      const version = await docs.createVersion({
        doc_id: next.id,
        version: nextVersion,
        content: data.content,
        metadata: data.metadata ?? existing.metadata,
        created_by: actorId ?? existing.created_by,
        mutation_id: mutationId,
      });

      // Events are project-scoped; fall back to a deterministic project when doc is org-scoped.
      const projectId = next.project_id
        ? next.project_id
        : (await projects.findFirstByOrg(orgId))?.id;
      if (!projectId) {
        this.logger.warn(
          `Skipping doc.updated event for ${next.id} (org ${orgId} has no projects)`
        );
      } else {
        await events.create({
          id: generateEventId(),
          project_id: projectId,
          type: 'system.doc.updated',
          source: 'system',
          env_name: null,
          ref_sha: null,
          ref_branch: null,
          actor_type: actorId ? 'user' : 'system',
          actor_id: actorId ?? null,
          payload_json: {
            org_id: orgId,
            project_id: next.project_id ?? projectId,
            doc_id: next.id,
            doc_version_id: version.id,
            path: next.path,
            version: version.version,
            content_hash: `sha256:${version.content_hash}`,
            actor_id: actorId ?? null,
            mutation_id: mutationId,
            request_id: requestId ?? null,
            metadata: next.metadata ?? {},
          },
          dedupe_key: `doc:${next.id}:mutation:${mutationId}`,
        });
      }

      return { next, version };
    });

    return this.toDetailResponse(updated.next, updated.version);
  }

  // --------------------------------------------------------------------------
  // Patch (search/replace edit)
  // --------------------------------------------------------------------------

  async patch(
    orgIdOrSlug: string,
    path: string,
    data: PatchOrgDocumentRequest,
    actorId?: string,
    requestId?: string,
  ): Promise<OrgDocumentDetailResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);

    const existing = await this.documents.findByOrgAndPath(orgId, path);
    if (!existing) {
      throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
        requestId,
        details: { path },
      });
    }

    let content = existing.content;

    for (const op of data.operations) {
      switch (op.op) {
        case 'replace': {
          if (!content.includes(op.search)) {
            throw buildApiError(
              400,
              'resource_uri_invalid',
              `Replace operation failed: could not find search text: "${op.search.slice(0, 100)}${op.search.length > 100 ? '...' : ''}"`,
              { requestId },
            );
          }
          content = content.replace(op.search, op.replace);
          break;
        }
        case 'append': {
          content = content + op.content;
          break;
        }
        case 'insert_after': {
          const anchorIndex = content.indexOf(op.anchor);
          if (anchorIndex === -1) {
            throw buildApiError(
              400,
              'resource_uri_invalid',
              `Insert-after operation failed: could not find anchor text: "${op.anchor.slice(0, 100)}${op.anchor.length > 100 ? '...' : ''}"`,
              { requestId },
            );
          }
          const insertPos = anchorIndex + op.anchor.length;
          content = content.slice(0, insertPos) + op.content + content.slice(insertPos);
          break;
        }
      }
    }

    const contentSize = Buffer.byteLength(content, 'utf8');
    if (contentSize > MAX_ORG_DOCUMENT_SIZE) {
      throw buildApiError(
        400,
        'resource_uri_invalid',
        `Resulting document size (${contentSize} bytes) exceeds maximum of ${MAX_ORG_DOCUMENT_SIZE} bytes (10 MB)`,
        { requestId },
      );
    }
    const mutationId = generateMutationId();

    const updated = await this.db.begin(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const docs = orgDocumentQueries(tx);
      const events = eventQueries(tx);
      const projects = projectQueries(tx);

      const latest = await docs.getLatestVersionInfo(existing.id);
      let nextVersion = (latest?.version ?? 0) + 1;

      if (!latest) {
        await docs.createVersion({
          doc_id: existing.id,
          version: 1,
          content: existing.content,
          metadata: existing.metadata,
          created_by: existing.created_by,
          mutation_id: null,
        });
        nextVersion = 2;
      }

      const next = await docs.update(existing.id, { content });
      if (!next) {
        throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
          requestId,
          details: { path },
        });
      }

      const version = await docs.createVersion({
        doc_id: next.id,
        version: nextVersion,
        content,
        metadata: next.metadata,
        created_by: actorId ?? existing.created_by,
        mutation_id: mutationId,
      });

      // Events are project-scoped; fall back to a deterministic project when doc is org-scoped.
      const projectId = next.project_id
        ? next.project_id
        : (await projects.findFirstByOrg(orgId))?.id;
      if (!projectId) {
        this.logger.warn(
          `Skipping doc.updated event for ${next.id} (org ${orgId} has no projects)`
        );
      } else {
        await events.create({
          id: generateEventId(),
          project_id: projectId,
          type: 'system.doc.updated',
          source: 'system',
          env_name: null,
          ref_sha: null,
          ref_branch: null,
          actor_type: actorId ? 'user' : 'system',
          actor_id: actorId ?? null,
          payload_json: {
            org_id: orgId,
            project_id: next.project_id ?? projectId,
            doc_id: next.id,
            doc_version_id: version.id,
            path: next.path,
            version: version.version,
            content_hash: `sha256:${version.content_hash}`,
            actor_id: actorId ?? null,
            mutation_id: mutationId,
            request_id: requestId ?? null,
            metadata: next.metadata ?? {},
          },
          dedupe_key: `doc:${next.id}:mutation:${mutationId}`,
        });
      }

      return { next, version };
    });

    return this.toDetailResponse(updated.next, updated.version);
  }

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  async delete(
    orgIdOrSlug: string,
    path: string,
    actorId?: string,
    requestId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);

    const existing = await this.documents.findByOrgAndPath(orgId, path);
    if (!existing) {
      throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
        requestId,
        details: { path },
      });
    }
    const latestVersion = await this.documents.getLatestVersionInfo(existing.id);
    const mutationId = generateMutationId();

    await this.db.begin(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const docs = orgDocumentQueries(tx);
      const events = eventQueries(tx);
      const projects = projectQueries(tx);

      const deleted = await docs.delete(existing.id);
      if (!deleted) {
        throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
          requestId,
          details: { path },
        });
      }

      // Events are project-scoped; fall back to a deterministic project when doc is org-scoped.
      const projectId = existing.project_id
        ? existing.project_id
        : (await projects.findFirstByOrg(orgId))?.id;
      if (!projectId) {
        this.logger.warn(
          `Skipping doc.deleted event for ${existing.id} (org ${orgId} has no projects)`
        );
      } else {
        await events.create({
          id: generateEventId(),
          project_id: projectId,
          type: 'system.doc.deleted',
          source: 'system',
          env_name: null,
          ref_sha: null,
          ref_branch: null,
          actor_type: actorId ? 'user' : 'system',
          actor_id: actorId ?? null,
          payload_json: {
            org_id: orgId,
            project_id: existing.project_id ?? projectId,
            doc_id: existing.id,
            doc_version_id: null,
            path: existing.path,
            version: latestVersion?.version ?? null,
            content_hash: latestVersion?.content_hash ? `sha256:${latestVersion.content_hash}` : null,
            actor_id: actorId ?? null,
            mutation_id: mutationId,
            request_id: requestId ?? null,
            metadata: existing.metadata ?? {},
          },
          dedupe_key: `doc:${existing.id}:mutation:${mutationId}`,
        });
      }
    });

    return { success: true, message: `Document deleted: ${path}` };
  }

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  async search(
    orgIdOrSlug: string,
    query: string,
    limit?: number,
    mode: 'text' | 'semantic' | 'hybrid' = 'text',
    pathPrefix?: string,
  ): Promise<OrgDocumentSearchResultSchema> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);

    // Semantic/hybrid currently degrade to text rank when embeddings are absent.
    // The API shape is stable so semantic pipelines can be enabled incrementally.
    void mode;
    const results = pathPrefix
      ? await this.documents.searchWithFilters(orgId, query, { limit, pathPrefix })
      : await this.documents.search(orgId, query, limit);
    return {
      documents: results.map(r => ({
        ...this.toSearchResponse(r),
        rank: r.rank,
        headline: r.headline,
      })),
    };
  }

  async listStale(
    orgIdOrSlug: string,
    options: { overdueBySeconds?: number; prefix?: string; limit?: number } = {},
  ): Promise<OrgDocumentListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const documents = await this.documents.listStale(orgId, {
      overdueBySeconds: options.overdueBySeconds ?? 0,
      prefix: options.prefix,
      limit: options.limit ?? 100,
    });
    return {
      documents: documents.map((doc) => this.toResponse(doc)),
    };
  }

  async reviewDocument(
    orgIdOrSlug: string,
    path: string,
    nextReviewAtIso: string,
    actorId?: string,
    requestId?: string,
  ): Promise<OrgDocumentDetailResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);

    const existing = await this.documents.findByOrgAndPath(orgId, path);
    if (!existing) {
      throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
        requestId,
        details: { path },
      });
    }

    const updated = await this.documents.update(existing.id, {
      content: existing.content,
      review_due: nextReviewAtIso,
      lifecycle_status: 'active',
      metadata: existing.metadata,
      mime_type: existing.mime_type,
    });
    if (!updated) {
      throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
        requestId,
        details: { path },
      });
    }

    const mutationId = generateMutationId();
    const latest = await this.documents.getLatestVersionInfo(existing.id);
    const nextVersion = (latest?.version ?? 0) + 1;
    await this.documents.createVersion({
      doc_id: existing.id,
      version: nextVersion,
      content: existing.content,
      metadata: existing.metadata,
      created_by: actorId ?? existing.created_by,
      mutation_id: mutationId,
    });

    return this.toDetailResponse(updated, {
      version: nextVersion,
      mutation_id: mutationId,
    });
  }

  // --------------------------------------------------------------------------
  // Version history
  // --------------------------------------------------------------------------

  async listVersions(
    orgIdOrSlug: string,
    path: string,
    limit = 20,
    offset = 0,
    requestId?: string,
  ): Promise<OrgDocumentVersionListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const document = await this.documents.findByOrgAndPath(orgId, path);
    if (!document) {
      throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
        requestId,
        details: { path },
      });
    }

    const versions = await this.documents.listVersions(document.id, limit, offset);
    return {
      versions: versions.map((version) => this.toVersionSummary(version)),
    };
  }

  async getVersion(
    orgIdOrSlug: string,
    path: string,
    versionNumber: number,
    requestId?: string,
  ): Promise<OrgDocumentVersionDetail> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const document = await this.documents.findByOrgAndPath(orgId, path);
    if (!document) {
      throw buildApiError(404, 'resource_not_found', `Document not found: ${path}`, {
        requestId,
        details: { path },
      });
    }

    const version = await this.documents.findVersion(document.id, versionNumber);
    if (!version) {
      throw buildApiError(404, 'resource_not_found', `Version ${versionNumber} not found for ${path}`, {
        requestId,
        details: { path, version: versionNumber },
      });
    }

    return this.toVersionDetail(document, version);
  }

  // --------------------------------------------------------------------------
  // Structured metadata query
  // --------------------------------------------------------------------------

  async query(
    orgIdOrSlug: string,
    data: OrgDocumentQueryRequest,
    requestId?: string,
  ): Promise<OrgDocumentQueryResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);

    const sort = data.sort ?? [{ field: 'updated_at', direction: 'desc' }];
    if (sort.length !== 1 || sort[0].field !== 'updated_at' || sort[0].direction !== 'desc') {
      throw buildApiError(400, 'doc_query_invalid_filter', 'Only sort by updated_at:desc is supported', {
        requestId,
      });
    }

    if (data.where) {
      for (const key of Object.keys(data.where)) {
        if (!key.startsWith('metadata.')) {
          throw buildApiError(400, 'doc_query_invalid_filter', `Invalid filter field: ${key}`, {
            requestId,
          });
        }
      }
    }

    const limit = data.limit ?? 50;
    const cursor = data.cursor ? this.decodeCursor(data.cursor, requestId) : null;
    let results: OrgDocument[] = [];
    try {
      results = await this.documents.query(orgId, {
        pathPrefix: data.path_prefix ?? '',
        where: data.where,
        limit: limit + 1,
        cursor,
      });
    } catch (err) {
      throw buildApiError(400, 'doc_query_invalid_filter', 'Invalid query filters', {
        requestId,
      });
    }

    const hasMore = results.length > limit;
    const sliced = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore && sliced.length > 0
      ? this.encodeCursor(sliced[sliced.length - 1])
      : null;

    return {
      documents: sliced.map((doc) => this.toResponse(doc)),
      pagination: {
        limit,
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Response Mappers
  // --------------------------------------------------------------------------

  private toResponse(
    d: OrgDocument,
    versionInfo?: { version: number; mutation_id: string | null },
  ): OrgDocumentResponse {
    return {
      id: d.id,
      org_id: d.org_id,
      project_id: d.project_id,
      path: d.path,
      mime_type: d.mime_type,
      content_hash: d.content_hash,
      current_version: versionInfo?.version,
      latest_mutation_id: versionInfo?.mutation_id ?? null,
      created_by: d.created_by,
      created_at: d.created_at instanceof Date ? d.created_at.toISOString() : String(d.created_at),
      updated_at: d.updated_at instanceof Date ? d.updated_at.toISOString() : String(d.updated_at),
      metadata: d.metadata,
      review_due: d.review_due instanceof Date ? d.review_due.toISOString() : (d.review_due ? String(d.review_due) : null),
      expires_at: d.expires_at instanceof Date ? d.expires_at.toISOString() : (d.expires_at ? String(d.expires_at) : null),
      lifecycle_status: d.lifecycle_status ?? 'active',
      embedding_model: d.embedding_model ?? null,
      embedding_json: d.embedding_json ?? null,
      embedded_at: d.embedded_at instanceof Date ? d.embedded_at.toISOString() : (d.embedded_at ? String(d.embedded_at) : null),
    };
  }

  private toDetailResponse(
    d: OrgDocument,
    versionInfo?: { version: number; mutation_id: string | null },
  ): OrgDocumentDetailResponse {
    return {
      ...this.toResponse(d, versionInfo),
      content: d.content,
    };
  }

  private toSearchResponse(d: OrgDocumentSearchResult): OrgDocumentResponse {
    return {
      id: d.id,
      org_id: d.org_id,
      project_id: d.project_id,
      path: d.path,
      mime_type: d.mime_type,
      content_hash: d.content_hash,
      current_version: undefined,
      latest_mutation_id: null,
      created_by: d.created_by,
      created_at: d.created_at instanceof Date ? d.created_at.toISOString() : String(d.created_at),
      updated_at: d.updated_at instanceof Date ? d.updated_at.toISOString() : String(d.updated_at),
      metadata: d.metadata,
      review_due: d.review_due instanceof Date ? d.review_due.toISOString() : (d.review_due ? String(d.review_due) : null),
      expires_at: d.expires_at instanceof Date ? d.expires_at.toISOString() : (d.expires_at ? String(d.expires_at) : null),
      lifecycle_status: d.lifecycle_status ?? 'active',
      embedding_model: d.embedding_model ?? null,
      embedding_json: d.embedding_json ?? null,
      embedded_at: d.embedded_at instanceof Date ? d.embedded_at.toISOString() : (d.embedded_at ? String(d.embedded_at) : null),
    };
  }

  private toVersionSummary(version: OrgDocumentVersionSummary) {
    return {
      id: version.id,
      doc_id: version.doc_id,
      version: version.version,
      content_hash: version.content_hash,
      created_by: version.created_by,
      created_at: version.created_at.toISOString(),
      metadata: version.metadata,
      mutation_id: version.mutation_id,
    };
  }

  private toVersionDetail(document: OrgDocument, version: OrgDocumentVersion): OrgDocumentVersionDetail {
    return {
      id: version.id,
      doc_id: version.doc_id,
      version: version.version,
      content_hash: version.content_hash,
      created_by: version.created_by,
      created_at: version.created_at.toISOString(),
      metadata: version.metadata,
      mutation_id: version.mutation_id,
      org_id: document.org_id,
      project_id: document.project_id,
      path: document.path,
      mime_type: document.mime_type,
      content: version.content,
    };
  }
}
