-- Magic-link confirmation wraps. The API stores the raw GoTrue action_link
-- here under a fresh opaque token (mlw_...). The email contains only the
-- wrap URL (https://sso/m/<id>) so corporate email-security scanners that
-- pre-fetch every URL cannot consume the underlying single-use OTP. The
-- human's browser POSTs from the SSO interstitial, which is the only path
-- that calls consume() and reveals gotrue_action_link.

CREATE TABLE magic_link_wraps (
  id                  text PRIMARY KEY,
  gotrue_action_link  text NOT NULL,
  project_id          text,
  org_id              text,
  email_hash          text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('magic_link', 'invite')),
  redirect_to         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  get_count           int NOT NULL DEFAULT 0,
  last_get_at         timestamptz,
  CHECK (kind <> 'magic_link' OR project_id IS NOT NULL)
);

-- Pruner scans pending rows by expiry; partial index keeps the common case fast.
CREATE INDEX magic_link_wraps_pending_expiry_idx
  ON magic_link_wraps (expires_at)
  WHERE consumed_at IS NULL;

-- Support queries ("show me recent wraps for project X") and audit walks.
CREATE INDEX magic_link_wraps_project_created_idx
  ON magic_link_wraps (project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
