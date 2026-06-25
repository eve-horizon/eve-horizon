import type { Db } from '../client.js';

export type AppLinkGrantKind = 'api' | 'events';

export interface ProjectAppLinkGrant {
  id: string;
  producer_project_id: string;
  export_kind: AppLinkGrantKind;
  export_name: string;
  consumer_project_id: string;
  api_scopes: string[];
  event_types: string[];
  envs: string[];
  service_name: string | null;
  cli_name: string | null;
  cli_image: string | null;
  cli_bin_path: string | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertAppLinkGrantInput {
  id: string;
  producer_project_id: string;
  export_kind: AppLinkGrantKind;
  export_name: string;
  consumer_project_id: string;
  api_scopes?: string[];
  event_types?: string[];
  envs?: string[];
  service_name?: string | null;
  cli_name?: string | null;
  cli_image?: string | null;
  cli_bin_path?: string | null;
}

export function appLinkGrantQueries(db: Db) {
  return {
    async findById(id: string): Promise<ProjectAppLinkGrant | null> {
      const [row] = await db<ProjectAppLinkGrant[]>`
        SELECT * FROM project_app_link_grants WHERE id = ${id}
      `;
      return row ?? null;
    },

    async findActive(params: {
      producer_project_id: string;
      export_kind: AppLinkGrantKind;
      export_name: string;
      consumer_project_id: string;
    }): Promise<ProjectAppLinkGrant | null> {
      const [row] = await db<ProjectAppLinkGrant[]>`
        SELECT *
        FROM project_app_link_grants
        WHERE producer_project_id = ${params.producer_project_id}
          AND export_kind = ${params.export_kind}
          AND export_name = ${params.export_name}
          AND consumer_project_id = ${params.consumer_project_id}
          AND revoked_at IS NULL
        LIMIT 1
      `;
      return row ?? null;
    },

    async listByProducer(producerProjectId: string, includeRevoked = false): Promise<ProjectAppLinkGrant[]> {
      if (includeRevoked) {
        return db<ProjectAppLinkGrant[]>`
          SELECT *
          FROM project_app_link_grants
          WHERE producer_project_id = ${producerProjectId}
          ORDER BY export_kind ASC, export_name ASC, consumer_project_id ASC
        `;
      }
      return db<ProjectAppLinkGrant[]>`
        SELECT *
        FROM project_app_link_grants
        WHERE producer_project_id = ${producerProjectId}
          AND revoked_at IS NULL
        ORDER BY export_kind ASC, export_name ASC, consumer_project_id ASC
      `;
    },

    async listByConsumer(consumerProjectId: string, includeRevoked = false): Promise<ProjectAppLinkGrant[]> {
      if (includeRevoked) {
        return db<ProjectAppLinkGrant[]>`
          SELECT *
          FROM project_app_link_grants
          WHERE consumer_project_id = ${consumerProjectId}
          ORDER BY producer_project_id ASC, export_kind ASC, export_name ASC
        `;
      }
      return db<ProjectAppLinkGrant[]>`
        SELECT *
        FROM project_app_link_grants
        WHERE consumer_project_id = ${consumerProjectId}
          AND revoked_at IS NULL
        ORDER BY producer_project_id ASC, export_kind ASC, export_name ASC
      `;
    },

    async listForProject(projectId: string): Promise<ProjectAppLinkGrant[]> {
      return db<ProjectAppLinkGrant[]>`
        SELECT *
        FROM project_app_link_grants
        WHERE producer_project_id = ${projectId}
           OR consumer_project_id = ${projectId}
        ORDER BY producer_project_id ASC, export_kind ASC, export_name ASC, consumer_project_id ASC
      `;
    },

    async upsert(input: UpsertAppLinkGrantInput): Promise<ProjectAppLinkGrant> {
      const [row] = await db<ProjectAppLinkGrant[]>`
        INSERT INTO project_app_link_grants (
          id,
          producer_project_id,
          export_kind,
          export_name,
          consumer_project_id,
          api_scopes,
          event_types,
          envs,
          service_name,
          cli_name,
          cli_image,
          cli_bin_path,
          revoked_at
        )
        VALUES (
          ${input.id},
          ${input.producer_project_id},
          ${input.export_kind},
          ${input.export_name},
          ${input.consumer_project_id},
          ${db.json((input.api_scopes ?? []) as never)},
          ${db.json((input.event_types ?? []) as never)},
          ${db.json((input.envs ?? []) as never)},
          ${input.service_name ?? null},
          ${input.cli_name ?? null},
          ${input.cli_image ?? null},
          ${input.cli_bin_path ?? null},
          NULL
        )
        ON CONFLICT (producer_project_id, export_kind, export_name, consumer_project_id)
        DO UPDATE SET
          api_scopes = EXCLUDED.api_scopes,
          event_types = EXCLUDED.event_types,
          envs = EXCLUDED.envs,
          service_name = EXCLUDED.service_name,
          cli_name = EXCLUDED.cli_name,
          cli_image = EXCLUDED.cli_image,
          cli_bin_path = EXCLUDED.cli_bin_path,
          revoked_at = NULL,
          updated_at = NOW()
        RETURNING *
      `;
      return row;
    },

    async revokeMissing(
      producerProjectId: string,
      activeKeys: Set<string>,
    ): Promise<number> {
      const existing = await this.listByProducer(producerProjectId, false);
      let revoked = 0;
      for (const grant of existing) {
        const key = `${grant.export_kind}:${grant.export_name}:${grant.consumer_project_id}`;
        if (!activeKeys.has(key)) {
          const result = await db`
            UPDATE project_app_link_grants
            SET revoked_at = COALESCE(revoked_at, NOW()),
                updated_at = NOW()
            WHERE id = ${grant.id}
              AND revoked_at IS NULL
          `;
          revoked += result.count ?? 0;
        }
      }
      return revoked;
    },

    async markRevoked(id: string): Promise<ProjectAppLinkGrant | null> {
      const [row] = await db<ProjectAppLinkGrant[]>`
        UPDATE project_app_link_grants
        SET revoked_at = COALESCE(revoked_at, NOW()),
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },
  };
}
