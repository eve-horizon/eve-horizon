import type { Db } from '../client.js';

export interface Release {
  id: string;
  project_id: string;
  git_sha: string;
  manifest_hash: string;
  image_digests_json: Record<string, string> | null;
  build_id: string | null;
  version: string | null;
  tag: string | null;
  created_by: string | null;
  created_at: Date;
}

export interface ListReleasesOptions {
  project_id?: string;
  git_sha?: string;
  limit?: number;
  offset?: number;
}

export function releaseQueries(db: Db) {
  return {
    async findById(id: string): Promise<Release | null> {
      const [row] = await db<Release[]>`SELECT * FROM releases WHERE id = ${id}`;
      return row ?? null;
    },

    async findByProjectAndSha(
      projectId: string,
      gitSha: string,
    ): Promise<Release | null> {
      const [row] = await db<Release[]>`
        SELECT * FROM releases
        WHERE project_id = ${projectId} AND git_sha = ${gitSha}
      `;
      return row ?? null;
    },

    async findByProjectAndTag(
      projectId: string,
      tag: string,
    ): Promise<Release | null> {
      const [row] = await db<Release[]>`
        SELECT * FROM releases
        WHERE project_id = ${projectId} AND tag = ${tag}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    async findLatestByProject(projectId: string): Promise<Release | null> {
      const [row] = await db<Release[]>`
        SELECT * FROM releases
        WHERE project_id = ${projectId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },

    async create(release: Omit<Release, 'created_at'>): Promise<Release> {
      const imageDigestsJson = release.image_digests_json
        ? db.json(release.image_digests_json as never)
        : null;

      const [row] = await db<Release[]>`
        INSERT INTO releases (
          id,
          project_id,
          git_sha,
          manifest_hash,
          image_digests_json,
          build_id,
          version,
          tag,
          created_by
        )
        VALUES (
          ${release.id},
          ${release.project_id},
          ${release.git_sha},
          ${release.manifest_hash},
          ${imageDigestsJson},
          ${release.build_id},
          ${release.version},
          ${release.tag},
          ${release.created_by}
        )
        RETURNING *
      `;
      return row;
    },

    async list(options: ListReleasesOptions = {}): Promise<Release[]> {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      const projectId = options.project_id;
      const gitSha = options.git_sha;

      if (projectId && gitSha) {
        return db<Release[]>`
          SELECT * FROM releases
          WHERE project_id = ${projectId} AND git_sha = ${gitSha}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (projectId) {
        return db<Release[]>`
          SELECT * FROM releases
          WHERE project_id = ${projectId}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      if (gitSha) {
        return db<Release[]>`
          SELECT * FROM releases
          WHERE git_sha = ${gitSha}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return db<Release[]>`
        SELECT * FROM releases
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    async delete(id: string): Promise<boolean> {
      const result = await db`DELETE FROM releases WHERE id = ${id}`;
      return result.count > 0;
    },

    async deleteByProjectOlderThan(projectId: string, keepCount: number): Promise<number> {
      const result = await db`
        DELETE FROM releases
        WHERE id IN (
          SELECT id FROM releases
          WHERE project_id = ${projectId}
          ORDER BY created_at DESC
          OFFSET ${keepCount}
        )
      `;
      return result.count;
    },
  };
}
