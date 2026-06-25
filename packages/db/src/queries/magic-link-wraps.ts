import type { Db } from '../client.js';

export type MagicLinkWrapKind = 'magic_link' | 'invite';

export interface MagicLinkWrap {
  id: string;
  gotrue_action_link: string;
  project_id: string | null;
  org_id: string | null;
  email_hash: string;
  kind: MagicLinkWrapKind;
  redirect_to: string | null;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  get_count: number;
  last_get_at: Date | null;
}

export type MagicLinkWrapInspect = {
  found: true;
  kind: MagicLinkWrapKind;
  project_id: string | null;
  org_id: string | null;
  redirect_to: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  get_count: number;
  expired: boolean;
  consumed: boolean;
} | {
  found: false;
};

export type MagicLinkWrapConsumeResult =
  | {
      status: 'ok';
      gotrue_action_link: string;
      project_id: string | null;
      org_id: string | null;
      email_hash: string;
      kind: MagicLinkWrapKind;
      get_count: number;
      created_at: Date;
    }
  | { status: 'expired' }
  | { status: 'already_consumed' }
  | { status: 'unknown' };

export function magicLinkWrapQueries(db: Db) {
  return {
    async create(params: {
      id: string;
      gotrue_action_link: string;
      project_id?: string | null;
      org_id?: string | null;
      email_hash: string;
      kind: MagicLinkWrapKind;
      redirect_to?: string | null;
      expires_at: Date;
    }): Promise<MagicLinkWrap> {
      const [row] = await db<MagicLinkWrap[]>`
        INSERT INTO magic_link_wraps (
          id, gotrue_action_link, project_id, org_id, email_hash, kind,
          redirect_to, expires_at
        )
        VALUES (
          ${params.id},
          ${params.gotrue_action_link},
          ${params.project_id ?? null},
          ${params.org_id ?? null},
          ${params.email_hash},
          ${params.kind},
          ${params.redirect_to ?? null},
          ${params.expires_at}
        )
        RETURNING *
      `;
      return row;
    },

    /**
     * Inspect a wrap. Increments get_count and updates last_get_at so scanner
     * pre-fetches are visible in telemetry. Never mutates consumed_at.
     */
    async inspect(id: string): Promise<MagicLinkWrapInspect> {
      const rows = await db<Array<{
        kind: MagicLinkWrapKind;
        project_id: string | null;
        org_id: string | null;
        redirect_to: string | null;
        expires_at: Date;
        consumed_at: Date | null;
        get_count: number;
      }>>`
        UPDATE magic_link_wraps
        SET get_count = get_count + 1, last_get_at = now()
        WHERE id = ${id}
        RETURNING kind, project_id, org_id, redirect_to, expires_at, consumed_at, get_count
      `;
      const row = rows[0];
      if (!row) return { found: false };
      const now = Date.now();
      return {
        found: true,
        kind: row.kind,
        project_id: row.project_id,
        org_id: row.org_id,
        redirect_to: row.redirect_to,
        expires_at: row.expires_at,
        consumed_at: row.consumed_at,
        get_count: row.get_count,
        expired: row.expires_at.getTime() <= now,
        consumed: row.consumed_at !== null,
      };
    },

    /**
     * Atomically consume a pending, non-expired wrap. On success returns the
     * stored GoTrue action_link. On failure returns the reason so callers can
     * distinguish expired / already_consumed / unknown.
     */
    async consume(id: string): Promise<MagicLinkWrapConsumeResult> {
      const updated = await db<Array<{
        gotrue_action_link: string;
        project_id: string | null;
        org_id: string | null;
        email_hash: string;
        kind: MagicLinkWrapKind;
        get_count: number;
        created_at: Date;
      }>>`
        UPDATE magic_link_wraps
        SET consumed_at = now()
        WHERE id = ${id}
          AND consumed_at IS NULL
          AND expires_at > now()
        RETURNING gotrue_action_link, project_id, org_id, email_hash, kind, get_count, created_at
      `;
      const row = updated[0];
      if (row) {
        return {
          status: 'ok',
          gotrue_action_link: row.gotrue_action_link,
          project_id: row.project_id,
          org_id: row.org_id,
          email_hash: row.email_hash,
          kind: row.kind,
          get_count: row.get_count,
          created_at: row.created_at,
        };
      }

      const classify = await db<Array<{ expired: boolean; consumed: boolean }>>`
        SELECT
          expires_at <= now() AS expired,
          consumed_at IS NOT NULL AS consumed
        FROM magic_link_wraps
        WHERE id = ${id}
      `;
      const probe = classify[0];
      if (!probe) return { status: 'unknown' };
      if (probe.consumed) return { status: 'already_consumed' };
      if (probe.expired) return { status: 'expired' };
      return { status: 'unknown' };
    },

    /**
     * Delete expired or consumed-and-old wraps. The 24h retention window
     * (cutoff = now-24h) keeps recent scanner telemetry queryable while
     * preventing pending wraps from accruing forever.
     */
    async pruneExpired(cutoff: Date): Promise<number> {
      const result = await db`
        DELETE FROM magic_link_wraps
        WHERE expires_at < ${cutoff}
           OR (consumed_at IS NOT NULL AND consumed_at < ${cutoff})
      `;
      return result.count;
    },

    async findById(id: string): Promise<MagicLinkWrap | null> {
      const [row] = await db<MagicLinkWrap[]>`
        SELECT * FROM magic_link_wraps WHERE id = ${id}
      `;
      return row ?? null;
    },
  };
}
