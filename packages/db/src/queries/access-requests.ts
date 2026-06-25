import type { Db } from '../client.js';

export interface AccessRequest {
  id: string;
  provider: string;
  public_key: string;
  fingerprint: string;
  email: string | null;
  desired_org_name: string;
  desired_org_slug: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  user_id: string | null;
  org_id: string | null;
  created_at: Date;
}

export function accessRequestQueries(db: Db) {
  return {
    async create(req: {
      id: string;
      provider: string;
      public_key: string;
      fingerprint: string;
      email?: string | null;
      desired_org_name: string;
      desired_org_slug?: string | null;
    }): Promise<AccessRequest> {
      const [row] = await db<AccessRequest[]>`
        INSERT INTO access_requests (id, provider, public_key, fingerprint, email, desired_org_name, desired_org_slug)
        VALUES (
          ${req.id},
          ${req.provider},
          ${req.public_key},
          ${req.fingerprint},
          ${req.email ?? null},
          ${req.desired_org_name},
          ${req.desired_org_slug ?? null}
        )
        RETURNING *
      `;
      return row;
    },

    async findById(id: string): Promise<AccessRequest | null> {
      const [row] = await db<AccessRequest[]>`
        SELECT * FROM access_requests WHERE id = ${id}
      `;
      return row ?? null;
    },

    async findPendingByFingerprint(fingerprint: string): Promise<AccessRequest | null> {
      const [row] = await db<AccessRequest[]>`
        SELECT * FROM access_requests
        WHERE fingerprint = ${fingerprint} AND status = 'pending'
      `;
      return row ?? null;
    },

    async listPending(): Promise<AccessRequest[]> {
      return db<AccessRequest[]>`
        SELECT * FROM access_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC
      `;
    },

    async approve(
      id: string,
      reviewedBy: string,
      userId: string,
      orgId: string,
      notes?: string | null,
    ): Promise<AccessRequest | null> {
      const [row] = await db<AccessRequest[]>`
        UPDATE access_requests
        SET status = 'approved',
            reviewed_by = ${reviewedBy},
            reviewed_at = NOW(),
            review_notes = ${notes ?? null},
            user_id = ${userId},
            org_id = ${orgId}
        WHERE id = ${id} AND status = 'pending'
        RETURNING *
      `;
      return row ?? null;
    },

    async reject(
      id: string,
      reviewedBy: string,
      notes?: string | null,
    ): Promise<AccessRequest | null> {
      const [row] = await db<AccessRequest[]>`
        UPDATE access_requests
        SET status = 'rejected',
            reviewed_by = ${reviewedBy},
            reviewed_at = NOW(),
            review_notes = ${notes ?? null}
        WHERE id = ${id} AND status = 'pending'
        RETURNING *
      `;
      return row ?? null;
    },
  };
}
