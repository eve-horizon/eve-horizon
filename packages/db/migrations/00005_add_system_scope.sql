-- 00005_add_system_scope.sql
-- Add 'system' scope to secrets

ALTER TABLE secrets DROP CONSTRAINT IF EXISTS valid_scope_type;
ALTER TABLE secrets ADD CONSTRAINT valid_scope_type CHECK (scope_type IN ('user', 'org', 'project', 'system'));
