-- Broader namespace backfill: include ALL active environments, not just deploy_status='deployed'.
-- Many environments have stale deploy_status (unknown, failed, deploying) but active K8s namespaces.
-- The sentinel watchdog needs namespace IS NOT NULL to discover environments to monitor.
UPDATE environments e
SET namespace = 'eve-' || o.slug || '-' || p.slug || '-' || e.name,
    updated_at = NOW()
FROM projects p
JOIN orgs o ON p.org_id = o.id
WHERE e.project_id = p.id
  AND e.namespace IS NULL
  AND e.status = 'active';
