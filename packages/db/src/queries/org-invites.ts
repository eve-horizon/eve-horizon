import type { Db } from '../client.js';

export interface OrgInvite {
  id: string;
  org_id: string;
  /**
   * User ID of the admin/actor who created the invite. `null` for
   * system-created invites (e.g. `app_context.source = 'domain_signup'`),
   * which are written by policy without an authenticated user.
   */
  created_by: string | null;
  invite_code: string;
  provider_hint: string | null;
  identity_hint: string | null;
  role: string;
  redirect_to: string | null;
  app_context: Record<string, unknown> | null;
  expires_at: Date | null;
  used_at: Date | null;
  used_by: string | null;
  created_at: Date;
}

type RawOrgInvite = Omit<OrgInvite, 'app_context'> & {
  app_context: Record<string, unknown> | string | null;
};

function normalizeAppContext(value: RawOrgInvite['app_context']): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return Array.isArray(value) ? null : value;
}

function normalizeOrgInvite(row: RawOrgInvite): OrgInvite {
  return {
    ...row,
    app_context: normalizeAppContext(row.app_context),
  };
}

export function orgInviteQueries(db: Db) {
  return {
    async create(invite: {
      org_id: string;
      /** Pass `null` for system-created invites (e.g. domain_signup policy). */
      created_by: string | null;
      invite_code: string;
      provider_hint?: string | null;
      identity_hint?: string | null;
      role?: string;
      redirect_to?: string | null;
      app_context?: Record<string, unknown> | null;
      expires_at?: Date | null;
    }): Promise<OrgInvite> {
      const appCtx = invite.app_context ? JSON.stringify(invite.app_context) : null;
      const [row] = await db<RawOrgInvite[]>`
        INSERT INTO org_invites (org_id, created_by, invite_code, provider_hint, identity_hint, role, redirect_to, app_context, expires_at)
        VALUES (
          ${invite.org_id},
          ${invite.created_by},
          ${invite.invite_code},
          ${invite.provider_hint ?? null},
          ${invite.identity_hint ?? null},
          ${invite.role ?? 'member'},
          ${invite.redirect_to ?? null},
          ${appCtx}::jsonb,
          ${invite.expires_at ?? null}
        )
        RETURNING *
      `;
      return normalizeOrgInvite(row);
    },

    async findByCode(code: string): Promise<OrgInvite | null> {
      const [row] = await db<RawOrgInvite[]>`
        SELECT * FROM org_invites WHERE invite_code = ${code}
      `;
      return row ? normalizeOrgInvite(row) : null;
    },

    async findByIdentityHint(
      provider: string,
      identityHint: string,
    ): Promise<OrgInvite | null> {
      // Case-insensitive on identity hint (emails are stored as lower in the
      // app layer but we don't want stale legacy casings to break lookups).
      // Filters expired rows in SQL to match findPendingByIdentityHintForOrgs.
      const [row] = await db<RawOrgInvite[]>`
        SELECT * FROM org_invites
        WHERE provider_hint = ${provider}
          AND LOWER(identity_hint) = LOWER(${identityHint})
          AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row ? normalizeOrgInvite(row) : null;
    },

    async findPendingByIdentityHintForOrg(
      provider: string,
      identityHint: string,
      orgId: string,
    ): Promise<OrgInvite[]> {
      const rows = await db<RawOrgInvite[]>`
        SELECT * FROM org_invites
        WHERE provider_hint = ${provider}
          AND LOWER(identity_hint) = LOWER(${identityHint})
          AND org_id = ${orgId}
          AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
      `;
      return rows.map(normalizeOrgInvite);
    },

    async findPendingByIdentityHintForOrgs(
      provider: string,
      identityHint: string,
      orgIds: string[],
    ): Promise<OrgInvite[]> {
      if (orgIds.length === 0) return [];
      const rows = await db<RawOrgInvite[]>`
        SELECT * FROM org_invites
        WHERE provider_hint = ${provider}
          AND LOWER(identity_hint) = LOWER(${identityHint})
          AND org_id = ANY(${orgIds})
          AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
      `;
      return rows.map(normalizeOrgInvite);
    },

    async markUsed(id: string, usedBy: string): Promise<void> {
      await db`
        UPDATE org_invites
        SET used_at = NOW(), used_by = ${usedBy}
        WHERE id = ${id}
      `;
    },

    async listByOrg(orgId: string, opts?: { includeUsed?: boolean }): Promise<OrgInvite[]> {
      if (opts?.includeUsed) {
        const rows = await db<RawOrgInvite[]>`
          SELECT * FROM org_invites WHERE org_id = ${orgId} ORDER BY created_at DESC
        `;
        return rows.map(normalizeOrgInvite);
      }
      const rows = await db<RawOrgInvite[]>`
        SELECT * FROM org_invites
        WHERE org_id = ${orgId} AND used_at IS NULL
        ORDER BY created_at DESC
      `;
      return rows.map(normalizeOrgInvite);
    },
  };
}
