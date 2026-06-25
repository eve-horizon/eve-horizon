import type { Db } from '../client.js';

// ============================================================================
// Types
// ============================================================================

export interface OrgDocument {
  id: string;
  org_id: string;
  project_id: string | null;
  path: string;
  mime_type: string;
  content: string;
  content_hash: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
  review_due: Date | null;
  expires_at: Date | null;
  lifecycle_status: 'active' | 'stale' | 'archived' | 'expired';
  embedding_model: string | null;
  embedding_json: Record<string, unknown> | null;
  embedded_at: Date | null;
}

export interface CreateOrgDocumentData {
  org_id: string;
  path: string;
  content: string;
  mime_type?: string;
  project_id?: string | null;
  created_by?: string | null;
  metadata?: Record<string, unknown>;
  review_due?: string | Date | null;
  expires_at?: string | Date | null;
  lifecycle_status?: 'active' | 'stale' | 'archived' | 'expired';
}

export interface UpdateOrgDocumentData {
  content: string;
  mime_type?: string;
  metadata?: Record<string, unknown>;
  review_due?: string | Date | null;
  expires_at?: string | Date | null;
  lifecycle_status?: 'active' | 'stale' | 'archived' | 'expired';
  embedding_model?: string | null;
  embedding_json?: Record<string, unknown> | null;
  embedded_at?: string | Date | null;
}

export interface OrgDocumentSearchResult {
  id: string;
  org_id: string;
  project_id: string | null;
  path: string;
  mime_type: string;
  content_hash: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
  review_due: Date | null;
  expires_at: Date | null;
  lifecycle_status: 'active' | 'stale' | 'archived' | 'expired';
  embedding_model: string | null;
  embedding_json: Record<string, unknown> | null;
  embedded_at: Date | null;
  rank: number;
  headline: string;
}

export interface OrgDocumentVersion {
  id: string;
  doc_id: string;
  version: number;
  content: string;
  content_hash: string;
  metadata: Record<string, unknown>;
  created_by: string | null;
  mutation_id: string | null;
  created_at: Date;
}

export interface OrgDocumentVersionSummary {
  id: string;
  doc_id: string;
  version: number;
  content_hash: string;
  metadata: Record<string, unknown>;
  created_by: string | null;
  mutation_id: string | null;
  created_at: Date;
}

export interface CreateOrgDocumentVersionData {
  doc_id: string;
  version: number;
  content: string;
  metadata?: Record<string, unknown>;
  created_by?: string | null;
  mutation_id?: string | null;
}

export type OrgDocumentSortField = 'updated_at' | 'created_at' | 'path';
export type OrgDocumentSortDirection = 'asc' | 'desc';

export interface OrgDocumentQueryFilter {
  eq?: string | number | boolean;
  in?: Array<string | number | boolean>;
  gte?: number;
  lte?: number;
  exists?: boolean;
  prefix?: string;
}

export interface OrgDocumentQueryOptions {
  pathPrefix?: string;
  where?: Record<string, OrgDocumentQueryFilter>;
  sort?: Array<{ field: OrgDocumentSortField; direction: OrgDocumentSortDirection }>;
  limit?: number;
  cursor?: { updated_at: string; id: string } | null;
}

// ============================================================================
// Factory Function
// ============================================================================

export function orgDocumentQueries(db: Db) {
  return {
    /**
     * Create a new org document.
     */
    async create(data: CreateOrgDocumentData): Promise<OrgDocument> {
      const [row] = await db<OrgDocument[]>`
        INSERT INTO org_documents (
          org_id,
          path,
          content,
          mime_type,
          project_id,
          created_by,
          metadata,
          review_due,
          expires_at,
          lifecycle_status
        )
        VALUES (
          ${data.org_id},
          ${data.path},
          ${data.content},
          ${data.mime_type ?? 'text/markdown'},
          ${data.project_id ?? null},
          ${data.created_by ?? null},
          ${data.metadata ? db.json(data.metadata as never) : db.json({} as never)},
          ${data.review_due ?? null},
          ${data.expires_at ?? null},
          ${data.lifecycle_status ?? 'active'}
        )
        RETURNING *
      `;
      return row;
    },

    /**
     * Find a document by UUID.
     */
    async findById(id: string): Promise<OrgDocument | null> {
      const [row] = await db<OrgDocument[]>`
        SELECT * FROM org_documents WHERE id = ${id}::uuid
      `;
      return row ?? null;
    },

    /**
     * Find a document by org ID and path.
     */
    async findByOrgAndPath(orgId: string, path: string): Promise<OrgDocument | null> {
      const [row] = await db<OrgDocument[]>`
        SELECT * FROM org_documents
        WHERE org_id = ${orgId} AND path = ${path}
      `;
      return row ?? null;
    },

    /**
     * List documents by org ID and path prefix (metadata only, excludes content).
     */
    async listByOrgAndPrefix(orgId: string, prefix: string, limit = 100): Promise<OrgDocument[]> {
      return db<OrgDocument[]>`
        SELECT id, org_id, project_id, path, mime_type, content_hash,
               created_by, created_at, updated_at, metadata,
               review_due, expires_at, lifecycle_status, embedding_model, embedding_json, embedded_at
        FROM org_documents
        WHERE org_id = ${orgId}
          AND path LIKE ${prefix + '%'}
        ORDER BY path ASC
        LIMIT ${limit}
      `;
    },

    /**
     * List documents by org ID and path prefix (includes content, for hydration).
     */
    async listByOrgAndPrefixWithContent(orgId: string, prefix: string, limit = 100): Promise<OrgDocument[]> {
      return db<OrgDocument[]>`
        SELECT *
        FROM org_documents
        WHERE org_id = ${orgId}
          AND path LIKE ${prefix + '%'}
        ORDER BY path ASC
        LIMIT ${limit}
      `;
    },

    /**
     * Full replace of document content and optional fields.
     */
    async update(id: string, data: UpdateOrgDocumentData): Promise<OrgDocument | null> {
      const sets: ReturnType<typeof db>[] = [
        db`content = ${data.content}`,
        db`updated_at = now()`,
      ];

      if (data.mime_type !== undefined) {
        sets.push(db`mime_type = ${data.mime_type}`);
      }
      if (data.metadata !== undefined) {
        sets.push(db`metadata = ${db.json(data.metadata as never)}`);
      }
      if (data.review_due !== undefined) {
        sets.push(db`review_due = ${data.review_due}`);
      }
      if (data.expires_at !== undefined) {
        sets.push(db`expires_at = ${data.expires_at}`);
      }
      if (data.lifecycle_status !== undefined) {
        sets.push(db`lifecycle_status = ${data.lifecycle_status}`);
      }
      if (data.embedding_model !== undefined) {
        sets.push(db`embedding_model = ${data.embedding_model}`);
      }
      if (data.embedding_json !== undefined) {
        sets.push(db`embedding_json = ${data.embedding_json ? db.json(data.embedding_json as never) : null}`);
      }
      if (data.embedded_at !== undefined) {
        sets.push(db`embedded_at = ${data.embedded_at}`);
      }

      const setClause = sets.reduce((acc, s, i) =>
        i === 0 ? s : db`${acc}, ${s}`,
      );

      const [row] = await db<OrgDocument[]>`
        UPDATE org_documents
        SET ${setClause}
        WHERE id = ${id}::uuid
        RETURNING *
      `;
      return row ?? null;
    },

    /**
     * Create a new document version.
     */
    async createVersion(data: CreateOrgDocumentVersionData): Promise<OrgDocumentVersion> {
      const [row] = await db<OrgDocumentVersion[]>`
        INSERT INTO org_document_versions (
          doc_id,
          version,
          content,
          metadata,
          created_by,
          mutation_id
        )
        VALUES (
          ${data.doc_id}::uuid,
          ${data.version},
          ${data.content},
          ${data.metadata ? db.json(data.metadata as never) : db.json({} as never)},
          ${data.created_by ?? null},
          ${data.mutation_id ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    /**
     * List versions for a document (metadata only).
     */
    async listVersions(docId: string, limit = 20, offset = 0): Promise<OrgDocumentVersionSummary[]> {
      return db<OrgDocumentVersionSummary[]>`
        SELECT id, doc_id, version, content_hash, metadata, created_by, mutation_id, created_at
        FROM org_document_versions
        WHERE doc_id = ${docId}::uuid
        ORDER BY version DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    /**
     * Get a specific version for a document (includes content).
     */
    async findVersion(docId: string, version: number): Promise<OrgDocumentVersion | null> {
      const [row] = await db<OrgDocumentVersion[]>`
        SELECT * FROM org_document_versions
        WHERE doc_id = ${docId}::uuid AND version = ${version}
      `;
      return row ?? null;
    },

    /**
     * Get the latest version info for a document.
     */
    async getLatestVersionInfo(docId: string): Promise<{ version: number; mutation_id: string | null; content_hash: string } | null> {
      const [row] = await db<{ version: number; mutation_id: string | null; content_hash: string }[]>`
        SELECT version, mutation_id, content_hash
        FROM org_document_versions
        WHERE doc_id = ${docId}::uuid
        ORDER BY version DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    /**
     * Delete a document by UUID.
     */
    async delete(id: string): Promise<boolean> {
      const result = await db<{ id: string }[]>`
        DELETE FROM org_documents WHERE id = ${id}::uuid
        RETURNING id
      `;
      return result.length > 0;
    },

    /**
     * Full-text search across org documents.
     */
    async search(orgId: string, query: string, limit = 20): Promise<OrgDocumentSearchResult[]> {
      return db<OrgDocumentSearchResult[]>`
        SELECT
          id, org_id, project_id, path, mime_type, content_hash,
          created_by, created_at, updated_at, metadata,
          review_due, expires_at, lifecycle_status,
          embedding_model, embedding_json, embedded_at,
          ts_rank(search_vector, plainto_tsquery('english', ${query})) AS rank,
          ts_headline('english', content, plainto_tsquery('english', ${query}),
            'MaxWords=50,MinWords=20') AS headline
        FROM org_documents
        WHERE org_id = ${orgId}
          AND search_vector @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
      `;
    },

    async searchWithFilters(
      orgId: string,
      query: string,
      options: {
        limit?: number;
        pathPrefix?: string;
      } = {},
    ): Promise<OrgDocumentSearchResult[]> {
      const limit = options.limit ?? 20;
      const prefix = options.pathPrefix ?? null;

      if (prefix) {
        return db<OrgDocumentSearchResult[]>`
          SELECT
            id, org_id, project_id, path, mime_type, content_hash,
            created_by, created_at, updated_at, metadata,
            review_due, expires_at, lifecycle_status,
            embedding_model, embedding_json, embedded_at,
            ts_rank(search_vector, plainto_tsquery('english', ${query})) AS rank,
            ts_headline('english', content, plainto_tsquery('english', ${query}),
              'MaxWords=50,MinWords=20') AS headline
          FROM org_documents
          WHERE org_id = ${orgId}
            AND path LIKE ${prefix + '%'}
            AND search_vector @@ plainto_tsquery('english', ${query})
          ORDER BY rank DESC, updated_at DESC
          LIMIT ${limit}
        `;
      }

      return this.search(orgId, query, limit);
    },

    async listStale(
      orgId: string,
      options: {
        prefix?: string;
        overdueBySeconds?: number;
        limit?: number;
      } = {},
    ): Promise<OrgDocument[]> {
      const limit = options.limit ?? 100;
      const prefix = options.prefix ?? null;
      const overdue = options.overdueBySeconds ?? 0;

      if (prefix) {
        return db<OrgDocument[]>`
          SELECT *
          FROM org_documents
          WHERE org_id = ${orgId}
            AND path LIKE ${prefix + '%'}
            AND review_due IS NOT NULL
            AND review_due < NOW() - make_interval(secs => ${overdue})
          ORDER BY review_due ASC
          LIMIT ${limit}
        `;
      }

      return db<OrgDocument[]>`
        SELECT *
        FROM org_documents
        WHERE org_id = ${orgId}
          AND review_due IS NOT NULL
          AND review_due < NOW() - make_interval(secs => ${overdue})
        ORDER BY review_due ASC
        LIMIT ${limit}
      `;
    },

    async updateLifecycleByPath(
      orgId: string,
      path: string,
      update: {
        review_due?: string | Date | null;
        expires_at?: string | Date | null;
        lifecycle_status?: 'active' | 'stale' | 'archived' | 'expired';
      },
    ): Promise<OrgDocument | null> {
      const sets: ReturnType<typeof db>[] = [db`updated_at = NOW()`];

      if (update.review_due !== undefined) {
        sets.push(db`review_due = ${update.review_due}`);
      }
      if (update.expires_at !== undefined) {
        sets.push(db`expires_at = ${update.expires_at}`);
      }
      if (update.lifecycle_status !== undefined) {
        sets.push(db`lifecycle_status = ${update.lifecycle_status}`);
      }

      const setClause = sets.reduce((acc, s, i) => (i === 0 ? s : db`${acc}, ${s}`));

      const [row] = await db<OrgDocument[]>`
        UPDATE org_documents
        SET ${setClause}
        WHERE org_id = ${orgId}
          AND path = ${path}
        RETURNING *
      `;
      return row ?? null;
    },

    /**
     * Structured metadata query for org documents.
     */
    async query(orgId: string, options: OrgDocumentQueryOptions): Promise<OrgDocument[]> {
      const limit = options.limit ?? 50;
      const conditions = [db`org_id = ${orgId}`];

      if (options.pathPrefix) {
        conditions.push(db`path LIKE ${options.pathPrefix + '%'}`);
      }

      if (options.where) {
        for (const [rawField, filter] of Object.entries(options.where)) {
          if (!rawField.startsWith('metadata.')) {
            throw new Error(`Invalid filter field: ${rawField}`);
          }
          const key = rawField.slice('metadata.'.length);

          if (filter.exists !== undefined) {
            conditions.push(filter.exists
              ? db`metadata ? ${key}`
              : db`NOT (metadata ? ${key})`
            );
          }
          if (filter.eq !== undefined) {
            conditions.push(db`metadata @> ${db.json({ [key]: filter.eq } as never)}`);
          }
          if (filter.in && filter.in.length > 0) {
            const values = filter.in.map((entry) => String(entry));
            conditions.push(db`(metadata->>${key}) = ANY(${values})`);
          }
          if (filter.gte !== undefined) {
            conditions.push(db`(metadata->>${key})::numeric >= ${filter.gte}`);
          }
          if (filter.lte !== undefined) {
            conditions.push(db`(metadata->>${key})::numeric <= ${filter.lte}`);
          }
          if (filter.prefix !== undefined) {
            conditions.push(db`(metadata->>${key}) LIKE ${filter.prefix + '%'}`);
          }
        }
      }

      if (options.cursor) {
        conditions.push(db`(updated_at, id) < (${options.cursor.updated_at}::timestamptz, ${options.cursor.id}::uuid)`);
      }

      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`,
      );

      return db<OrgDocument[]>`
        SELECT id, org_id, project_id, path, mime_type, content_hash,
               created_by, created_at, updated_at, metadata,
               review_due, expires_at, lifecycle_status, embedding_model, embedding_json, embedded_at
        FROM org_documents
        WHERE ${whereClause}
        ORDER BY updated_at DESC, id DESC
        LIMIT ${limit}
      `;
    },
  };
}
