import type { Db } from '../client.js';

export interface ServicePrincipal {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ServicePrincipalToken {
  id: string;
  principal_id: string;
  token_hash: string;
  scopes: string[];
  expires_at: Date;
  last_used_at: Date | null;
  created_at: Date;
}

export function servicePrincipalQueries(db: Db) {
  return {
    // ── CRUD ──────────────────────────────────────────────────────────────

    async createServicePrincipal(
      id: string,
      orgId: string,
      name: string,
      description: string | null,
      createdBy: string | null,
    ): Promise<ServicePrincipal> {
      const [row] = await db<ServicePrincipal[]>`
        INSERT INTO service_principals (id, org_id, name, description, created_by)
        VALUES (${id}, ${orgId}, ${name}, ${description}, ${createdBy})
        RETURNING *
      `;
      return row;
    },

    async listServicePrincipals(orgId: string): Promise<ServicePrincipal[]> {
      return db<ServicePrincipal[]>`
        SELECT * FROM service_principals
        WHERE org_id = ${orgId}
        ORDER BY created_at ASC
      `;
    },

    async getServicePrincipal(orgId: string, id: string): Promise<ServicePrincipal | null> {
      const [row] = await db<ServicePrincipal[]>`
        SELECT * FROM service_principals
        WHERE org_id = ${orgId} AND id = ${id}
      `;
      return row ?? null;
    },

    async getServicePrincipalByName(orgId: string, name: string): Promise<ServicePrincipal | null> {
      const [row] = await db<ServicePrincipal[]>`
        SELECT * FROM service_principals
        WHERE org_id = ${orgId} AND name = ${name}
      `;
      return row ?? null;
    },

    async deleteServicePrincipal(orgId: string, id: string): Promise<boolean> {
      const rows = await db`
        DELETE FROM service_principals
        WHERE org_id = ${orgId} AND id = ${id}
        RETURNING id
      `;
      return rows.length > 0;
    },

    // ── Token management ─────────────────────────────────────────────────

    async createToken(
      id: string,
      principalId: string,
      tokenHash: string,
      scopes: string[],
      expiresAt: Date,
    ): Promise<ServicePrincipalToken> {
      const [row] = await db<ServicePrincipalToken[]>`
        INSERT INTO service_principal_tokens (id, principal_id, token_hash, scopes, expires_at)
        VALUES (${id}, ${principalId}, ${tokenHash}, ${scopes}, ${expiresAt})
        RETURNING *
      `;
      return row;
    },

    async listTokens(principalId: string): Promise<Omit<ServicePrincipalToken, 'token_hash'>[]> {
      return db<Omit<ServicePrincipalToken, 'token_hash'>[]>`
        SELECT id, principal_id, scopes, expires_at, last_used_at, created_at
        FROM service_principal_tokens
        WHERE principal_id = ${principalId}
        ORDER BY created_at ASC
      `;
    },

    async revokeToken(principalId: string, tokenId: string): Promise<boolean> {
      const rows = await db`
        DELETE FROM service_principal_tokens
        WHERE principal_id = ${principalId} AND id = ${tokenId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async findByTokenHash(tokenHash: string): Promise<{ principal: ServicePrincipal; token: ServicePrincipalToken } | null> {
      const [row] = await db<(ServicePrincipalToken & { sp_id: string; sp_org_id: string; sp_name: string; sp_description: string | null; sp_created_by: string | null; sp_created_at: Date; sp_updated_at: Date })[]>`
        SELECT
          t.*,
          sp.id AS sp_id,
          sp.org_id AS sp_org_id,
          sp.name AS sp_name,
          sp.description AS sp_description,
          sp.created_by AS sp_created_by,
          sp.created_at AS sp_created_at,
          sp.updated_at AS sp_updated_at
        FROM service_principal_tokens t
        JOIN service_principals sp ON sp.id = t.principal_id
        WHERE t.token_hash = ${tokenHash}
          AND t.expires_at > NOW()
      `;
      if (!row) return null;

      return {
        principal: {
          id: row.sp_id,
          org_id: row.sp_org_id,
          name: row.sp_name,
          description: row.sp_description,
          created_by: row.sp_created_by,
          created_at: row.sp_created_at,
          updated_at: row.sp_updated_at,
        },
        token: {
          id: row.id,
          principal_id: row.principal_id,
          token_hash: row.token_hash,
          scopes: row.scopes,
          expires_at: row.expires_at,
          last_used_at: row.last_used_at,
          created_at: row.created_at,
        },
      };
    },

    async updateLastUsed(tokenId: string): Promise<void> {
      await db`
        UPDATE service_principal_tokens
        SET last_used_at = NOW()
        WHERE id = ${tokenId}
      `;
    },
  };
}
