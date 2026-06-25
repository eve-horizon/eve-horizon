-- Backfill namespace for deployed environments so the sentinel watchdog can discover them.
-- The namespace was computed at deploy time but never persisted to the database.
UPDATE environments e
SET namespace = 'eve-' || o.slug || '-' || p.slug || '-' || e.name,
    updated_at = NOW()
FROM projects p
JOIN orgs o ON p.org_id = o.id
WHERE e.project_id = p.id
  AND e.namespace IS NULL
  AND e.deploy_status = 'deployed';
