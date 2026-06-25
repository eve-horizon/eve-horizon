-- Custom domains for Eve-deployed apps
-- Users can bring their own domain names (e.g. limelee.com) for their deployed services.
-- Each domain gets its own K8s Ingress with cert-manager TLS via HTTP-01.

CREATE TABLE custom_domains (
  id             TEXT PRIMARY KEY,
  hostname       TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  service_name   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending_dns'
    CHECK (status IN (
      'pending_dns',
      'dns_verified',
      'cert_provisioning',
      'active',
      'dns_error',
      'cert_error',
      'removed'
    )),
  ingress_name     TEXT,
  cert_secret_name TEXT,
  verified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hostname)
);

CREATE INDEX idx_custom_domains_project ON custom_domains(project_id);
CREATE INDEX idx_custom_domains_env ON custom_domains(environment_id);
CREATE INDEX idx_custom_domains_status ON custom_domains(status);
