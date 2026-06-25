-- Fix HTTP 500 when a job attachment's content contains a backslash.
--
-- 00048 defined content_hash as:
--   GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED
-- The content::bytea cast uses PostgreSQL's bytea escape-format input, in which
-- '\' introduces an escape sequence. Any content containing a backslash that is
-- not a valid bytea escape (JSON escape sequences like \" \n \uXXXX, source code,
-- Windows paths, regex, LaTeX) makes the cast throw; because the generated column
-- is computed on INSERT, the whole INSERT fails and POST /jobs/:id/attachments
-- returns an opaque 500.
--
-- convert_to(content, 'UTF8') returns the raw UTF-8 bytes of the text without
-- interpreting backslashes, which is exactly what a content hash should digest.
--
-- A STORED generated column requires an IMMUTABLE generation expression, but
-- convert_to(text, name) is only STABLE, so referencing it directly raised
-- "ERROR: 42P17 generation expression is not immutable" and the migration could
-- never apply. Wrapping the digest in an IMMUTABLE SQL function satisfies the
-- generated-column requirement: the server encoding is fixed for the life of the
-- database, so encoding `content` as UTF-8 and hashing it is deterministic.
--
-- Re-adding the generated column recomputes content_hash for existing rows; all
-- existing rows are backslash-free (any with a backslash could never have been
-- inserted), so the recompute is safe.

CREATE OR REPLACE FUNCTION eve_job_attachment_content_hash(content text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $$
  SELECT encode(sha256(convert_to(content, 'UTF8')), 'hex')
$$;

ALTER TABLE job_attachments DROP COLUMN content_hash;

ALTER TABLE job_attachments
  ADD COLUMN content_hash TEXT
  GENERATED ALWAYS AS (eve_job_attachment_content_hash(content)) STORED;
