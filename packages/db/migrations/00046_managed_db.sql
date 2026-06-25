-- 00046_managed_db.sql
-- Managed Postgres DBaaS: backing instances and per-environment tenant databases.

-- ============================================================================
-- MANAGED DB INSTANCES (Backing host / cluster)
-- ============================================================================
-- Represents a cloud-provider Postgres instance that can host multiple tenant
-- databases. Provisioned by infra automation; Eve schedules tenants onto them.

CREATE TABLE IF NOT EXISTS managed_db_instances (
  id                   TEXT PRIMARY KEY,                   -- mdbi_xxx (TypeID)
  provider             TEXT NOT NULL,                      -- e.g. 'aws-rds', 'gcp-cloudsql'
  provider_instance_id TEXT NOT NULL,                      -- cloud resource identifier
  region               TEXT NOT NULL,
  engine               TEXT NOT NULL DEFAULT 'postgres',
  engine_version       TEXT NOT NULL,
  host                 TEXT NOT NULL,
  port                 INTEGER NOT NULL DEFAULT 5432,
  instance_class       TEXT NOT NULL,                      -- e.g. 'db.t3.medium'
  status               TEXT NOT NULL DEFAULT 'available',  -- available | maintenance | retired
  capacity_json        JSONB,                              -- current load / limits
  last_error_code      TEXT,
  last_error_message   TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(provider, provider_instance_id)
);

-- ============================================================================
-- MANAGED DB TENANTS (Environment-owned database / user)
-- ============================================================================
-- Each row is a logical database carved out of a managed_db_instance for a
-- single environment + service pair. Credentials are stored via secret ref.

CREATE TABLE IF NOT EXISTS managed_db_tenants (
  id                   TEXT PRIMARY KEY,                   -- mdbt_xxx (TypeID)
  org_id               TEXT NOT NULL REFERENCES orgs(id),
  project_id           TEXT NOT NULL REFERENCES projects(id),
  env_id               TEXT NOT NULL REFERENCES environments(id),
  service_name         TEXT NOT NULL,                      -- manifest service name, e.g. 'db'
  instance_id          TEXT NOT NULL REFERENCES managed_db_instances(id),
  provider_tenant_id   TEXT,                               -- provider-specific tenant DB id
  db_name              TEXT NOT NULL,                      -- generated: org-project-env-hash
  db_user              TEXT NOT NULL,                      -- generated: org-project-env-u-hash
  credential_secret_ref TEXT,                              -- encrypted credential reference
  class                TEXT NOT NULL,                      -- e.g. 'db.p1', 'db.p2'
  desired_class        TEXT,                               -- target class for async scale ops
  status               TEXT NOT NULL DEFAULT 'provisioning', -- provisioning | ready | modifying | rotating | deleting | failed
  operation_token      TEXT,                               -- lock token for concurrent mutation prevention
  last_error_code      TEXT,
  last_error_message   TEXT,
  ready_at             TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ,

  UNIQUE(env_id, service_name)
);

-- Partial unique: provider_tenant_id must be unique when set
CREATE UNIQUE INDEX IF NOT EXISTS uq_managed_db_tenants_provider_tid
  ON managed_db_tenants(provider_tenant_id)
  WHERE provider_tenant_id IS NOT NULL;

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_managed_db_tenants_org      ON managed_db_tenants(org_id);
CREATE INDEX IF NOT EXISTS idx_managed_db_tenants_env      ON managed_db_tenants(env_id);
CREATE INDEX IF NOT EXISTS idx_managed_db_tenants_instance ON managed_db_tenants(instance_id);
CREATE INDEX IF NOT EXISTS idx_managed_db_tenants_status   ON managed_db_tenants(status)
  WHERE deleted_at IS NULL;
