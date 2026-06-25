-- Add redirect_to and app_context to org_invites for app-initiated onboarding.
-- redirect_to: URL where the user lands after completing onboarding.
-- app_context: opaque JSON the originating app attaches (not interpreted by the platform).
ALTER TABLE org_invites
    ADD COLUMN IF NOT EXISTS redirect_to TEXT,
    ADD COLUMN IF NOT EXISTS app_context JSONB;
