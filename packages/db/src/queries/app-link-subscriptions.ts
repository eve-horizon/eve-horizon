import type { Db } from '../client.js';
import type { AppLinkGrantKind, ProjectAppLinkGrant } from './app-link-grants.js';

export interface ProjectAppLinkSubscription {
  id: string;
  consumer_project_id: string;
  local_alias: string;
  api_grant_id: string | null;
  event_grant_id: string | null;
  requested_scopes: string[];
  event_types: string[];
  environment_strategy: 'same' | 'fixed';
  producer_env_name: string | null;
  inject_into_services: string[];
  inject_into_jobs: boolean;
  last_token_minted_at: Date | null;
  last_token_principal: string | null;
  last_token_audience: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertAppLinkSubscriptionInput {
  id: string;
  consumer_project_id: string;
  local_alias: string;
  api_grant_id?: string | null;
  event_grant_id?: string | null;
  requested_scopes?: string[];
  event_types?: string[];
  environment_strategy: 'same' | 'fixed';
  producer_env_name?: string | null;
  inject_into_services?: string[];
  inject_into_jobs?: boolean;
}

export interface AppLinkSubscriptionWithGrant extends ProjectAppLinkSubscription {
  api_grant: ProjectAppLinkGrant | null;
  event_grant: ProjectAppLinkGrant | null;
}

export interface AppLinkEventSubscriptionRow {
  subscription_id: string;
  consumer_project_id: string;
  local_alias: string;
  event_types: string[];
  producer_project_id: string;
  export_name: string;
  grant_event_types: string[];
  grant_revoked_at: Date | null;
}

type JoinedGrantRow = ProjectAppLinkSubscription & {
  api_id: string | null;
  api_producer_project_id: string | null;
  api_export_kind: AppLinkGrantKind | null;
  api_export_name: string | null;
  api_consumer_project_id: string | null;
  api_api_scopes: string[] | null;
  api_event_types: string[] | null;
  api_envs: string[] | null;
  api_service_name: string | null;
  api_cli_name: string | null;
  api_cli_image: string | null;
  api_cli_bin_path: string | null;
  api_revoked_at: Date | null;
  api_created_at: Date | null;
  api_updated_at: Date | null;
  event_id: string | null;
  event_producer_project_id: string | null;
  event_export_kind: AppLinkGrantKind | null;
  event_export_name: string | null;
  event_consumer_project_id: string | null;
  event_api_scopes: string[] | null;
  event_event_types: string[] | null;
  event_envs: string[] | null;
  event_service_name: string | null;
  event_cli_name: string | null;
  event_cli_image: string | null;
  event_cli_bin_path: string | null;
  event_revoked_at: Date | null;
  event_created_at: Date | null;
  event_updated_at: Date | null;
};

function rowToGrant(row: JoinedGrantRow, prefix: 'api' | 'event'): ProjectAppLinkGrant | null {
  const fields = row as unknown as Record<string, unknown>;
  const id = fields[`${prefix}_id`];
  if (!id) return null;
  return {
    id: id as string,
    producer_project_id: fields[`${prefix}_producer_project_id`] as string,
    export_kind: fields[`${prefix}_export_kind`] as AppLinkGrantKind,
    export_name: fields[`${prefix}_export_name`] as string,
    consumer_project_id: fields[`${prefix}_consumer_project_id`] as string,
    api_scopes: (fields[`${prefix}_api_scopes`] as string[] | null) ?? [],
    event_types: (fields[`${prefix}_event_types`] as string[] | null) ?? [],
    envs: (fields[`${prefix}_envs`] as string[] | null) ?? [],
    service_name: fields[`${prefix}_service_name`] as string | null,
    cli_name: fields[`${prefix}_cli_name`] as string | null,
    cli_image: fields[`${prefix}_cli_image`] as string | null,
    cli_bin_path: fields[`${prefix}_cli_bin_path`] as string | null,
    revoked_at: fields[`${prefix}_revoked_at`] as Date | null,
    created_at: fields[`${prefix}_created_at`] as Date,
    updated_at: fields[`${prefix}_updated_at`] as Date,
  };
}

function rowToSubscriptionWithGrant(row: JoinedGrantRow): AppLinkSubscriptionWithGrant {
  return {
    id: row.id,
    consumer_project_id: row.consumer_project_id,
    local_alias: row.local_alias,
    api_grant_id: row.api_grant_id,
    event_grant_id: row.event_grant_id,
    requested_scopes: row.requested_scopes,
    event_types: row.event_types,
    environment_strategy: row.environment_strategy,
    producer_env_name: row.producer_env_name,
    inject_into_services: row.inject_into_services,
    inject_into_jobs: row.inject_into_jobs,
    last_token_minted_at: row.last_token_minted_at,
    last_token_principal: row.last_token_principal,
    last_token_audience: row.last_token_audience,
    created_at: row.created_at,
    updated_at: row.updated_at,
    api_grant: rowToGrant(row, 'api'),
    event_grant: rowToGrant(row, 'event'),
  };
}

export function appLinkSubscriptionQueries(db: Db) {
  return {
    async findById(id: string): Promise<ProjectAppLinkSubscription | null> {
      const [row] = await db<ProjectAppLinkSubscription[]>`
        SELECT * FROM project_app_link_subscriptions WHERE id = ${id}
      `;
      return row ?? null;
    },

    async findByConsumerAlias(
      consumerProjectId: string,
      localAlias: string,
    ): Promise<ProjectAppLinkSubscription | null> {
      const [row] = await db<ProjectAppLinkSubscription[]>`
        SELECT *
        FROM project_app_link_subscriptions
        WHERE consumer_project_id = ${consumerProjectId}
          AND local_alias = ${localAlias}
        LIMIT 1
      `;
      return row ?? null;
    },

    async findWithGrantsById(id: string): Promise<AppLinkSubscriptionWithGrant | null> {
      const rows = await this.listWithGrants({ subscription_id: id });
      return rows[0] ?? null;
    },

    async findWithGrantsByConsumerAlias(
      consumerProjectId: string,
      localAlias: string,
    ): Promise<AppLinkSubscriptionWithGrant | null> {
      const rows = await this.listWithGrants({
        consumer_project_id: consumerProjectId,
        local_alias: localAlias,
      });
      return rows[0] ?? null;
    },

    async listByConsumer(consumerProjectId: string): Promise<ProjectAppLinkSubscription[]> {
      return db<ProjectAppLinkSubscription[]>`
        SELECT *
        FROM project_app_link_subscriptions
        WHERE consumer_project_id = ${consumerProjectId}
        ORDER BY local_alias ASC
      `;
    },

    async listWithGrants(options: {
      consumer_project_id?: string;
      subscription_id?: string;
      local_alias?: string;
    } = {}): Promise<AppLinkSubscriptionWithGrant[]> {
      const conditions: ReturnType<typeof db>[] = [];
      if (options.consumer_project_id) {
        conditions.push(db`s.consumer_project_id = ${options.consumer_project_id}`);
      }
      if (options.subscription_id) {
        conditions.push(db`s.id = ${options.subscription_id}`);
      }
      if (options.local_alias) {
        conditions.push(db`s.local_alias = ${options.local_alias}`);
      }

      const whereClause = conditions.length === 0
        ? db`TRUE`
        : conditions.reduce((acc, cond, i) => i === 0 ? cond : db`${acc} AND ${cond}`);

      const rows = await db<JoinedGrantRow[]>`
        SELECT
          s.*,
          ag.id AS api_id,
          ag.producer_project_id AS api_producer_project_id,
          ag.export_kind AS api_export_kind,
          ag.export_name AS api_export_name,
          ag.consumer_project_id AS api_consumer_project_id,
          ag.api_scopes AS api_api_scopes,
          ag.event_types AS api_event_types,
          ag.envs AS api_envs,
          ag.service_name AS api_service_name,
          ag.cli_name AS api_cli_name,
          ag.cli_image AS api_cli_image,
          ag.cli_bin_path AS api_cli_bin_path,
          ag.revoked_at AS api_revoked_at,
          ag.created_at AS api_created_at,
          ag.updated_at AS api_updated_at,
          eg.id AS event_id,
          eg.producer_project_id AS event_producer_project_id,
          eg.export_kind AS event_export_kind,
          eg.export_name AS event_export_name,
          eg.consumer_project_id AS event_consumer_project_id,
          eg.api_scopes AS event_api_scopes,
          eg.event_types AS event_event_types,
          eg.envs AS event_envs,
          eg.service_name AS event_service_name,
          eg.cli_name AS event_cli_name,
          eg.cli_image AS event_cli_image,
          eg.cli_bin_path AS event_cli_bin_path,
          eg.revoked_at AS event_revoked_at,
          eg.created_at AS event_created_at,
          eg.updated_at AS event_updated_at
        FROM project_app_link_subscriptions s
        LEFT JOIN project_app_link_grants ag ON ag.id = s.api_grant_id
        LEFT JOIN project_app_link_grants eg ON eg.id = s.event_grant_id
        WHERE ${whereClause}
        ORDER BY s.local_alias ASC
      `;

      return rows.map(rowToSubscriptionWithGrant);
    },

    async listEventSubscriptionsForProducer(producerProjectId: string): Promise<AppLinkEventSubscriptionRow[]> {
      return db<AppLinkEventSubscriptionRow[]>`
        SELECT
          s.id AS subscription_id,
          s.consumer_project_id,
          s.local_alias,
          s.event_types,
          g.producer_project_id,
          g.export_name,
          g.event_types AS grant_event_types,
          g.revoked_at AS grant_revoked_at
        FROM project_app_link_subscriptions s
        JOIN project_app_link_grants g ON g.id = s.event_grant_id
        WHERE g.producer_project_id = ${producerProjectId}
          AND g.export_kind = 'events'
          AND g.revoked_at IS NULL
        ORDER BY s.local_alias ASC
      `;
    },

    async upsert(input: UpsertAppLinkSubscriptionInput): Promise<ProjectAppLinkSubscription> {
      const [row] = await db<ProjectAppLinkSubscription[]>`
        INSERT INTO project_app_link_subscriptions (
          id,
          consumer_project_id,
          local_alias,
          api_grant_id,
          event_grant_id,
          requested_scopes,
          event_types,
          environment_strategy,
          producer_env_name,
          inject_into_services,
          inject_into_jobs
        )
        VALUES (
          ${input.id},
          ${input.consumer_project_id},
          ${input.local_alias},
          ${input.api_grant_id ?? null},
          ${input.event_grant_id ?? null},
          ${db.json((input.requested_scopes ?? []) as never)},
          ${db.json((input.event_types ?? []) as never)},
          ${input.environment_strategy},
          ${input.producer_env_name ?? null},
          ${db.json((input.inject_into_services ?? []) as never)},
          ${input.inject_into_jobs ?? false}
        )
        ON CONFLICT (consumer_project_id, local_alias)
        DO UPDATE SET
          api_grant_id = EXCLUDED.api_grant_id,
          event_grant_id = EXCLUDED.event_grant_id,
          requested_scopes = EXCLUDED.requested_scopes,
          event_types = EXCLUDED.event_types,
          environment_strategy = EXCLUDED.environment_strategy,
          producer_env_name = EXCLUDED.producer_env_name,
          inject_into_services = EXCLUDED.inject_into_services,
          inject_into_jobs = EXCLUDED.inject_into_jobs,
          updated_at = NOW()
        RETURNING *
      `;
      return row;
    },

    async deleteMissingForConsumer(
      consumerProjectId: string,
      aliases: Set<string>,
    ): Promise<number> {
      const existing = await this.listByConsumer(consumerProjectId);
      let deleted = 0;
      for (const subscription of existing) {
        if (!aliases.has(subscription.local_alias)) {
          const result = await db`
            DELETE FROM project_app_link_subscriptions
            WHERE id = ${subscription.id}
          `;
          deleted += result.count ?? 0;
        }
      }
      return deleted;
    },

    async recordTokenMint(input: {
      subscription_id: string;
      principal: string;
      audience: string;
    }): Promise<void> {
      await db`
        UPDATE project_app_link_subscriptions
        SET last_token_minted_at = NOW(),
            last_token_principal = ${input.principal},
            last_token_audience = ${input.audience},
            updated_at = NOW()
        WHERE id = ${input.subscription_id}
      `;
    },
  };
}
