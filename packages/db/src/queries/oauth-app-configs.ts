import type { Db } from '../client.js';

export interface OAuthAppConfig {
  id: string;
  org_id: string;
  provider: string;
  client_id: string;
  client_secret: string;
  config_json: Record<string, unknown>;
  label: string | null;
  status: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export function oauthAppConfigQueries(db: Db) {
  return {
    async findByOrgAndProvider(orgId: string, provider: string): Promise<OAuthAppConfig | undefined> {
      const [row] = await db<OAuthAppConfig[]>`
        SELECT * FROM oauth_app_configs
        WHERE org_id = ${orgId} AND provider = ${provider}
        LIMIT 1
      `;
      return row;
    },

    async listByOrg(orgId: string): Promise<OAuthAppConfig[]> {
      return db<OAuthAppConfig[]>`
        SELECT * FROM oauth_app_configs
        WHERE org_id = ${orgId}
        ORDER BY provider
      `;
    },

    async upsert(
      config: Omit<OAuthAppConfig, 'created_at' | 'updated_at'>,
    ): Promise<OAuthAppConfig> {
      const [row] = await db<OAuthAppConfig[]>`
        INSERT INTO oauth_app_configs (
          id, org_id, provider, client_id, client_secret,
          config_json, label, status, created_by
        )
        VALUES (
          ${config.id},
          ${config.org_id},
          ${config.provider},
          ${config.client_id},
          ${config.client_secret},
          ${db.json(config.config_json as never)},
          ${config.label},
          ${config.status},
          ${config.created_by}
        )
        ON CONFLICT (org_id, provider) DO UPDATE SET
          client_id     = EXCLUDED.client_id,
          client_secret = EXCLUDED.client_secret,
          config_json   = EXCLUDED.config_json,
          label         = COALESCE(EXCLUDED.label, oauth_app_configs.label),
          status        = EXCLUDED.status,
          updated_at    = NOW()
        RETURNING *
      `;
      return row;
    },

    async remove(orgId: string, provider: string): Promise<boolean> {
      const result = await db`
        DELETE FROM oauth_app_configs
        WHERE org_id = ${orgId} AND provider = ${provider}
      `;
      return result.count > 0;
    },
  };
}
