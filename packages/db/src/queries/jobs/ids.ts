import crypto from 'crypto';
import type { Db } from '../../client.js';
import type { JobIdGeneration } from './types.js';

// ============================================================================
// Job ID Generation
// ============================================================================

export function jobIdQueries(db: Db) {
  return {
    /**
     * Generate a new job ID
     *
     * Root format: {slug}-{hash8} (8 hex chars from SHA256)
     * Child format: {parentId}.{n} where n is next sequence
     *
     * Max depth: 3 levels (count dots)
     * Handles collisions by retry with new random bytes
     *
     * @param projectSlug - Project slug (human-readable, e.g., 'myproj')
     * @param parentId - Optional parent job ID for creating child jobs
     * @returns Object containing generated job ID and project TypeID
     */
    async generateJobId(projectInput: string, parentId?: string): Promise<JobIdGeneration> {
      // Resolve project to get TypeID and slug
      const { id: projectId, slug } = await this.resolveProjectForJobId(projectInput);

      if (parentId) {
        // Child job: append next sequence number
        const depth = parentId.split('.').length;
        if (depth >= 3) {
          throw new Error('Max hierarchy depth (3) exceeded');
        }
        const nextSeq = await this.getNextChildSequence(parentId);
        return { id: `${parentId}.${nextSeq}`, projectId };
      }

      // Root job: generate hash-based ID using slug (human-readable)
      const input = `${slug}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(input).digest('hex');
      const shortHash = hash.substring(0, 8);

      const id = `${slug}-${shortHash}`;

      // Handle collision (rare)
      if (await this.jobExists(id)) {
        // Retry with new random bytes
        return this.generateJobId(projectInput, parentId);
      }

      return { id, projectId };
    },

    /**
     * Get the next child sequence number for a parent job
     *
     * Finds the maximum child number and returns max + 1
     *
     * @param parentId - Parent job ID
     * @returns Next sequence number (1 if no children exist)
     */
    async getNextChildSequence(parentId: string): Promise<number> {
      const result = await db<{ next_seq: number }[]>`
        SELECT COALESCE(MAX(
          CAST(SPLIT_PART(id, '.', ARRAY_LENGTH(STRING_TO_ARRAY(id, '.'), 1)) AS INT)
        ), 0) + 1 as next_seq
        FROM jobs
        WHERE parent_id = ${parentId}
      `;
      return result[0]?.next_seq ?? 1;
    },

    /**
     * Check if a job ID exists in the database
     *
     * @param id - Job ID to check
     * @returns True if job exists, false otherwise
     */
    async jobExists(id: string): Promise<boolean> {
      const result = await db<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM jobs WHERE id = ${id}) as exists
      `;
      return result[0]?.exists ?? false;
    },

    /**
     * Resolve project slug from slug or TypeID
     *
     * If input starts with 'proj_', lookup by id and return project TypeID
     * Otherwise return the project TypeID for the given slug
     *
     * @param projectInput - Project slug (e.g., 'myproj') or TypeID (e.g., 'proj_xxx')
     * @returns Project TypeID (proj_xxx)
     * @throws Error if project not found
     */
    async resolveProjectSlug(projectInput: string): Promise<string> {
      // If input starts with 'proj_', it's a TypeID - lookup by id
      if (projectInput.startsWith('proj_')) {
        const result = await db<{ id: string }[]>`
          SELECT id FROM projects WHERE id = ${projectInput}
        `;
        if (!result[0]) {
          throw new Error(`Project not found: ${projectInput}`);
        }
        return result[0].id;
      }

      // Otherwise treat as slug - lookup by slug and return the TypeID
      const result = await db<{ id: string }[]>`
        SELECT id FROM projects WHERE slug = ${projectInput}
      `;
      if (!result[0]) {
        throw new Error(`Project not found: ${projectInput}`);
      }
      return result[0].id;
    },

    /**
     * Resolve project input to both TypeID and slug (for job ID generation)
     *
     * @param projectInput - Project slug or TypeID
     * @returns Both project TypeID and slug
     * @throws Error if project not found
     */
    async resolveProjectForJobId(projectInput: string): Promise<{ id: string; slug: string }> {
      if (projectInput.startsWith('proj_')) {
        const result = await db<{ id: string; slug: string }[]>`
          SELECT id, slug FROM projects WHERE id = ${projectInput}
        `;
        if (!result[0]) {
          throw new Error(`Project not found: ${projectInput}`);
        }
        return result[0];
      }

      const result = await db<{ id: string; slug: string }[]>`
        SELECT id, slug FROM projects WHERE slug = ${projectInput}
      `;
      if (!result[0]) {
        throw new Error(`Project not found: ${projectInput}`);
      }
      return result[0];
    },
  };
}
