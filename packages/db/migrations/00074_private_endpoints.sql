-- Private Endpoints: Tailscale-connected services accessible from within the K8s cluster.
-- Org-scoped. Each endpoint maps to a K8s ExternalName Service backed by the Tailscale operator.

CREATE TABLE private_endpoints (
  id            TEXT PRIMARY KEY,                              -- ep_xxx (TypeID)
  name          TEXT NOT NULL,                                 -- DNS-safe user-friendly name
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL DEFAULT 'tailscale',             -- tunnel provider
  hostname      TEXT NOT NULL,                                 -- tailnet MagicDNS FQDN
  port          INTEGER NOT NULL,
  protocol      TEXT NOT NULL DEFAULT 'TCP',
  status        TEXT NOT NULL DEFAULT 'pending',               -- pending | ready | error
  status_msg    TEXT,                                          -- diagnostic detail
  k8s_svc_name  TEXT NOT NULL,                                 -- K8s Service name: {orgSlug}-{name}
  k8s_namespace TEXT NOT NULL DEFAULT 'eve-tunnels',
  k8s_dns       TEXT,                                          -- full in-cluster DNS
  health_path   TEXT DEFAULT '/v1/models',                     -- HTTP health check path (NULL to skip)
  metadata      JSONB,                                         -- provider-specific config
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name, org_id)
);

CREATE INDEX idx_private_endpoints_org_id ON private_endpoints(org_id);
CREATE INDEX idx_private_endpoints_status ON private_endpoints(status);
