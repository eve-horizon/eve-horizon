-- Add slug to orgs table
ALTER TABLE orgs ADD COLUMN slug VARCHAR(12);

-- Backfill existing orgs: derive slug from name (lowercase, strip non-alphanumeric, truncate to 12)
-- Pre-deployment backfill only. No real user data.
UPDATE orgs SET slug = LEFT(LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', '', 'g')), 12)
WHERE slug IS NULL;

-- Make NOT NULL after backfill
ALTER TABLE orgs ALTER COLUMN slug SET NOT NULL;

-- Add constraints
ALTER TABLE orgs ADD CONSTRAINT valid_org_slug CHECK (slug ~ '^[a-z][a-z0-9]{1,11}$');
CREATE UNIQUE INDEX idx_orgs_slug ON orgs(slug);
