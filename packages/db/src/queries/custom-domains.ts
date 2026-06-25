import type { Db } from '../client.js';

export interface CustomDomain {
  id: string;
  hostname: string;
  project_id: string;
  environment_id: string | null;
  service_name: string;
  source: CustomDomainSource;
  status: string;
  ingress_name: string | null;
  cert_secret_name: string | null;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type CustomDomainStatus =
  | 'pending_dns'
  | 'dns_verified'
  | 'cert_provisioning'
  | 'active'
  | 'dns_error'
  | 'cert_error'
  | 'removed';

export type CustomDomainSource = 'manifest' | 'manual';

export interface ClaimOrUpdateCustomDomainInput {
  id: string;
  hostname: string;
  project_id: string;
  service_name: string;
  source: CustomDomainSource;
}

export interface UpdateStatusOptions {
  ingress_name?: string;
  cert_secret_name?: string;
  verified_at?: Date;
}

export function customDomainQueries(db: Db) {
  return {
    async findByHostname(hostname: string): Promise<CustomDomain | null> {
      const normalized = hostname.trim().toLowerCase();
      const [row] = await db<CustomDomain[]>`
        SELECT * FROM custom_domains WHERE hostname = ${normalized}
      `;
      return row ?? null;
    },

    async findByProject(projectId: string): Promise<CustomDomain[]> {
      return db<CustomDomain[]>`
        SELECT * FROM custom_domains
        WHERE project_id = ${projectId} AND status != 'removed'
        ORDER BY hostname ASC
      `;
    },

    async findByEnvironment(environmentId: string): Promise<CustomDomain[]> {
      return db<CustomDomain[]>`
        SELECT * FROM custom_domains
        WHERE environment_id = ${environmentId} AND status != 'removed'
        ORDER BY hostname ASC
      `;
    },

    async countByProject(projectId: string): Promise<number> {
      const [row] = await db<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM custom_domains
        WHERE project_id = ${projectId} AND status != 'removed'
      `;
      return parseInt(row?.count ?? '0', 10);
    },

    /**
     * Claim a new domain or update service_name for same-project claim.
     * Returns null if:
     * - Domain is claimed by a different project, OR
     * - Domain is already owned by a different environment in the same project
     *   (owner-aware: we never mutate metadata for a domain bound to another env
     *   until bindToEnvironment proves ownership for this caller).
     *
     * Unbound same-project rows are safe to update.
     */
    async claimOrUpdate(input: ClaimOrUpdateCustomDomainInput): Promise<CustomDomain | null> {
      const normalized = input.hostname.trim().toLowerCase();
      const [row] = await db<CustomDomain[]>`
        INSERT INTO custom_domains (id, hostname, project_id, service_name, source)
        VALUES (${input.id}, ${normalized}, ${input.project_id}, ${input.service_name}, ${input.source})
        ON CONFLICT (hostname) DO UPDATE
        SET
          service_name = EXCLUDED.service_name,
          source = EXCLUDED.source,
          updated_at = NOW()
        WHERE custom_domains.project_id = EXCLUDED.project_id
          AND custom_domains.status != 'removed'
          AND custom_domains.environment_id IS NULL
        RETURNING *
      `;
      if (row) return row;

      // Return existing same-project row even if we skipped the update — callers
      // need to see it (and in the owner-aware deploy path, `bindToEnvironment`
      // is the next call and will update service_name atomically when the caller
      // already owns it).
      const [existing] = await db<CustomDomain[]>`
        SELECT * FROM custom_domains
        WHERE hostname = ${normalized}
          AND project_id = ${input.project_id}
          AND status != 'removed'
      `;
      return existing ?? null;
    },

    /**
     * Bind domain to environment during deploy, using first-bind-wins semantics.
     *
     * Returns the row if the caller's env already owns it, or if it is unowned
     * (and binds it to the caller). Returns null if another env in the same
     * project owns the hostname — the caller is expected to skip rendering the
     * ingress and log the owning env via findByHostname.
     *
     * The same UPDATE also writes service_name so owner-aware metadata changes
     * happen in one atomic step with proven ownership.
     */
    async bindToEnvironment(
      hostname: string,
      projectId: string,
      environmentId: string,
      serviceName: string,
      source?: CustomDomainSource,
    ): Promise<CustomDomain | null> {
      const normalized = hostname.trim().toLowerCase();
      const [row] = await db<CustomDomain[]>`
        UPDATE custom_domains
        SET
          environment_id = ${environmentId},
          service_name = ${serviceName},
          source = COALESCE(${source ?? null}, source),
          updated_at = NOW()
        WHERE hostname = ${normalized}
          AND project_id = ${projectId}
          AND status != 'removed'
          AND (environment_id IS NULL OR environment_id = ${environmentId})
        RETURNING *
      `;
      return row ?? null;
    },

    /**
     * Transfer ownership of a hostname from its current env to a target env in
     * the same project. Called by the CLI `eve domain transfer` flow.
     *
     * Only mutates DB state — ingress cleanup in the losing env happens on the
     * next deploy of that env (it will no longer include the hostname in its
     * desiredDomains and the deployer will GC the local ingress).
     */
    async transferToEnvironment(
      hostname: string,
      projectId: string,
      targetEnvironmentId: string,
      targetServiceName?: string,
    ): Promise<CustomDomain | null> {
      const normalized = hostname.trim().toLowerCase();
      const [row] = await db<CustomDomain[]>`
        UPDATE custom_domains
        SET
          environment_id = ${targetEnvironmentId},
          service_name = COALESCE(${targetServiceName ?? null}, service_name),
          updated_at = NOW()
        WHERE hostname = ${normalized}
          AND project_id = ${projectId}
          AND status != 'removed'
        RETURNING *
      `;
      return row ?? null;
    },

    /**
     * Clear environment binding for a single hostname. Keeps the row so a later
     * deploy can claim it.
     */
    async unbindHostname(hostname: string, projectId: string): Promise<CustomDomain | null> {
      const normalized = hostname.trim().toLowerCase();
      const [row] = await db<CustomDomain[]>`
        UPDATE custom_domains
        SET
          environment_id = NULL,
          updated_at = NOW()
        WHERE hostname = ${normalized}
          AND project_id = ${projectId}
          AND status != 'removed'
        RETURNING *
      `;
      return row ?? null;
    },

    async updateStatus(
      hostname: string,
      status: CustomDomainStatus,
      opts?: UpdateStatusOptions,
    ): Promise<CustomDomain | null> {
      const normalized = hostname.trim().toLowerCase();
      const verifiedAt = status === 'active' ? (opts?.verified_at ?? new Date()) : undefined;

      const [row] = await db<CustomDomain[]>`
        UPDATE custom_domains
        SET
          status = ${status},
          ingress_name = COALESCE(${opts?.ingress_name ?? null}, ingress_name),
          cert_secret_name = COALESCE(${opts?.cert_secret_name ?? null}, cert_secret_name),
          verified_at = COALESCE(${verifiedAt ?? null}, verified_at),
          updated_at = NOW()
        WHERE hostname = ${normalized}
        RETURNING *
      `;
      return row ?? null;
    },

    async unbindDomainsForEnvironment(environmentId: string, hostnames: string[]): Promise<number> {
      if (hostnames.length === 0) return 0;
      const normalized = hostnames.map((h) => h.trim().toLowerCase());
      const result = await db`
        UPDATE custom_domains
        SET
          environment_id = NULL,
          updated_at = NOW()
        WHERE environment_id = ${environmentId}
          AND hostname = ANY(${normalized})
      `;
      return result.count;
    },

    async release(hostname: string, projectId: string): Promise<boolean> {
      const normalized = hostname.trim().toLowerCase();
      const result = await db`
        DELETE FROM custom_domains
        WHERE hostname = ${normalized} AND project_id = ${projectId}
      `;
      return result.count > 0;
    },

    async releaseManifestManaged(hostname: string, projectId: string): Promise<boolean> {
      const normalized = hostname.trim().toLowerCase();
      const result = await db`
        DELETE FROM custom_domains
        WHERE hostname = ${normalized}
          AND project_id = ${projectId}
          AND source = 'manifest'
      `;
      return result.count > 0;
    },

    async findByProjectAndEnvironment(projectId: string, environmentId: string): Promise<CustomDomain[]> {
      return db<CustomDomain[]>`
        SELECT * FROM custom_domains
        WHERE project_id = ${projectId}
          AND environment_id = ${environmentId}
          AND status != 'removed'
        ORDER BY hostname ASC
      `;
    },

    /**
     * Find custom domains eligible to participate in the SSO redirect allowlist
     * for the given project IDs. "Eligible" means: bound to an environment, in
     * a status that indicates the hostname is or is becoming live, and on a
     * non-deleted project.
     *
     * Excludes pending_dns / dns_error / cert_error / removed and unbound rows.
     */
    async findRedirectEligibleByProjectIds(projectIds: string[]): Promise<CustomDomain[]> {
      if (projectIds.length === 0) return [];
      return db<CustomDomain[]>`
        SELECT cd.*
        FROM custom_domains cd
        INNER JOIN projects p ON p.id = cd.project_id
        WHERE cd.project_id = ANY(${projectIds})
          AND cd.environment_id IS NOT NULL
          AND cd.status IN ('dns_verified', 'cert_provisioning', 'active')
          AND p.deleted_at IS NULL
        ORDER BY cd.hostname ASC
      `;
    },

    /**
     * Like findRedirectEligibleByProjectIds, but scoped to all non-deleted
     * projects in the given org IDs. Used to expand the redirect allowlist
     * across `org_access.allowed_orgs` for branding-only / cross-org apps.
     */
    async findRedirectEligibleByOrgIds(orgIds: string[]): Promise<CustomDomain[]> {
      if (orgIds.length === 0) return [];
      return db<CustomDomain[]>`
        SELECT cd.*
        FROM custom_domains cd
        INNER JOIN projects p ON p.id = cd.project_id
        WHERE p.org_id = ANY(${orgIds})
          AND p.deleted_at IS NULL
          AND cd.environment_id IS NOT NULL
          AND cd.status IN ('dns_verified', 'cert_provisioning', 'active')
        ORDER BY cd.hostname ASC
      `;
    },
  };
}
