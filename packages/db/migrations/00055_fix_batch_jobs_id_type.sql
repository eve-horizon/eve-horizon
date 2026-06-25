-- Fix batch_jobs.id column type: UUID -> TEXT to match TypeID pattern used by generateBatchId()
-- Also fix jobs.batch_id foreign key column type to match.

-- Drop the FK constraint first
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_batch_id_fkey;

-- Change batch_jobs.id from UUID to TEXT
ALTER TABLE batch_jobs
  ALTER COLUMN id DROP DEFAULT,
  ALTER COLUMN id SET DATA TYPE TEXT USING id::text;

-- Change jobs.batch_id from UUID to TEXT
ALTER TABLE jobs
  ALTER COLUMN batch_id SET DATA TYPE TEXT USING batch_id::text;

-- Re-add the FK constraint
ALTER TABLE jobs
  ADD CONSTRAINT jobs_batch_id_fkey
  FOREIGN KEY (batch_id) REFERENCES batch_jobs(id) ON DELETE SET NULL;
