-- 00066_storage_backends.sql
-- Platform storage backend registry. Tracks topology (provider, endpoint, region)
-- for display and multi-backend routing. Credentials are NOT stored here —
-- they live in EVE_STORAGE_* env vars on the API service.

CREATE TABLE storage_backends (
  id            TEXT PRIMARY KEY,            -- sb_xxx
  name          TEXT NOT NULL UNIQUE,        -- 'default', 'regional-eu'
  provider      TEXT NOT NULL,               -- 'minio', 's3', 'gcs', 'r2', 'tigris'
  endpoint      TEXT NOT NULL,
  public_endpoint TEXT,                      -- CDN/public URL base (may differ from API endpoint)
  region        TEXT NOT NULL DEFAULT 'us-east-1',
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: only one default backend allowed
CREATE UNIQUE INDEX idx_storage_backends_default
  ON storage_backends(is_default) WHERE is_default = true;
