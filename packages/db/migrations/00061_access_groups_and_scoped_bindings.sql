-- 00061_access_groups_and_scoped_bindings.sql
-- Add first-class access groups and scoped binding constraints.

-- ============================================================================
-- ACCESS GROUPS
-- ============================================================================

CREATE TABLE access_groups (
  id            TEXT PRIMARY KEY, -- grp_xxx (TypeID format)
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  description   TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, name),
  UNIQUE(org_id, slug)
);

CREATE INDEX idx_access_groups_org ON access_groups(org_id);
CREATE INDEX idx_access_groups_org_slug ON access_groups(org_id, slug);

CREATE TABLE access_group_members (
  group_id         TEXT NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
  principal_type   TEXT NOT NULL CHECK (principal_type IN ('user', 'service_principal')),
  principal_id     TEXT NOT NULL,
  added_by         TEXT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, principal_type, principal_id)
);

CREATE INDEX idx_access_group_members_principal
  ON access_group_members(principal_type, principal_id);
CREATE INDEX idx_access_group_members_group
  ON access_group_members(group_id);

-- ============================================================================
-- ACCESS BINDINGS
-- ============================================================================

ALTER TABLE access_bindings
  ADD COLUMN scope_json JSONB;

ALTER TABLE access_bindings
  DROP CONSTRAINT IF EXISTS access_bindings_principal_type_check;

ALTER TABLE access_bindings
  ADD CONSTRAINT access_bindings_principal_type_check
  CHECK (principal_type IN ('user', 'service_principal', 'group'));

