CREATE TABLE ingress_aliases (
  id             TEXT PRIMARY KEY,
  alias          TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  service_name   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ingress_alias_alias_len CHECK (char_length(alias) BETWEEN 3 AND 63),
  CONSTRAINT ingress_alias_alias_format CHECK (alias ~ '^[a-z][a-z0-9-]*[a-z0-9]$')
);

CREATE UNIQUE INDEX ux_ingress_aliases_alias ON ingress_aliases(alias);
CREATE INDEX idx_ingress_aliases_project ON ingress_aliases(project_id);
CREATE INDEX idx_ingress_aliases_env ON ingress_aliases(environment_id);
