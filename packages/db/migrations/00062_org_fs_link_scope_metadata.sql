-- 00062_org_fs_link_scope_metadata.sql
-- Add ownership and scoped ACL metadata to org sync links.

ALTER TABLE org_sync_links
  ADD COLUMN owner_principal_type TEXT,
  ADD COLUMN owner_principal_id TEXT,
  ADD COLUMN scope_json JSONB;

UPDATE org_sync_links
SET
  owner_principal_type = CASE
    WHEN created_by IS NULL THEN 'system'
    ELSE 'user'
  END,
  owner_principal_id = created_by,
  scope_json = jsonb_build_object(
    'allow_prefixes',
    jsonb_build_array(
      CASE
        WHEN remote_path = '/' THEN '/**'
        ELSE remote_path || '/**'
      END
    )
  )
WHERE owner_principal_type IS NULL
   OR scope_json IS NULL;

ALTER TABLE org_sync_links
  ALTER COLUMN owner_principal_type SET NOT NULL,
  ALTER COLUMN scope_json SET NOT NULL,
  ALTER COLUMN scope_json SET DEFAULT '{"allow_prefixes":["/**"]}'::jsonb;

ALTER TABLE org_sync_links
  ADD CONSTRAINT chk_org_sync_links_owner_principal_type
    CHECK (owner_principal_type IN ('user', 'service_principal', 'system')),
  ADD CONSTRAINT chk_org_sync_links_scope_allow_prefixes_array
    CHECK (jsonb_typeof(scope_json -> 'allow_prefixes') = 'array');

CREATE INDEX idx_org_sync_links_owner_principal
  ON org_sync_links(org_id, owner_principal_type, owner_principal_id);
