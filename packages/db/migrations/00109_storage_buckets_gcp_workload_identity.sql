-- Migration: storage_buckets_gcp_workload_identity
-- Created: 2026-11-05

-- App buckets can be bound to a GKE Workload Identity principal per
-- environment (isolation_mode 'gcp-workload-identity'). 00102 declared the
-- column CHECK inline, so Postgres named it storage_buckets_isolation_mode_check.

ALTER TABLE storage_buckets
  DROP CONSTRAINT IF EXISTS storage_buckets_isolation_mode_check;

ALTER TABLE storage_buckets
  ADD CONSTRAINT storage_buckets_isolation_mode_check CHECK (
    isolation_mode IN ('irsa', 'shared', 'minio-static-key', 'gcp-workload-identity')
  );
