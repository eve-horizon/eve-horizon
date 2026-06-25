-- Object-store credential isolation metadata for app bucket diagnostics and cleanup.

ALTER TABLE storage_buckets
  ADD COLUMN IF NOT EXISTS isolation_mode TEXT CHECK (
    isolation_mode IN ('irsa', 'shared', 'minio-static-key')
  ),
  ADD COLUMN IF NOT EXISTS iam_role_arn TEXT,
  ADD COLUMN IF NOT EXISTS iam_role_name TEXT,
  ADD COLUMN IF NOT EXISTS service_account_name TEXT,
  ADD COLUMN IF NOT EXISTS service_account_namespace TEXT;
