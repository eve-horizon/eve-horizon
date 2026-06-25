-- 00047_custom_roles.sql
-- Custom role definitions and role bindings as additive overlays
-- on top of the existing member/admin/owner base roles.

-- ============================================================================
-- ACCESS ROLES
-- ============================================================================

CREATE TABLE access_roles (
  id            TEXT PRIMARY KEY,  -- role_xxx (TypeID format)
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('org', 'project')),
  permissions   TEXT[] NOT NULL,
  description   TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, name)
);

CREATE INDEX idx_access_roles_org ON access_roles(org_id);

-- ============================================================================
-- ACCESS BINDINGS
-- ============================================================================

CREATE TABLE access_bindings (
  id              TEXT PRIMARY KEY,  -- bind_xxx (TypeID format)
  role_id         TEXT NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
  principal_type  TEXT NOT NULL CHECK (principal_type IN ('user', 'service_principal')),
  principal_id    TEXT NOT NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-wide binding
  created_by      TEXT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_access_bindings_unique
  ON access_bindings(role_id, principal_type, principal_id, COALESCE(project_id, ''));

CREATE INDEX idx_access_bindings_role ON access_bindings(role_id);
CREATE INDEX idx_access_bindings_principal ON access_bindings(principal_type, principal_id);
CREATE INDEX idx_access_bindings_project ON access_bindings(project_id) WHERE project_id IS NOT NULL;
