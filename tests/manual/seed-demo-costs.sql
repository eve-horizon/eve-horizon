-- Demo cost data for local k3d dashboard testing.
-- Mirrors exactly what the production collectors write:
--   * cloud_cost_snapshots  <- AwsCostExplorerProvider (cluster scope, by_service breakdown)
--   * environment_cost_snapshots <- OpenCostSource (per-namespace allocations + shared overhead)
--
-- Usage:
--   kubectl -n eve exec -i postgres-0 -- psql -U eve -d eve < tests/manual/seed-demo-costs.sql
--
-- Idempotent: rows use fixed ids and are upserted.

BEGIN;

-- ---------------------------------------------------------------------------
-- Bill-backed AWS Cost Explorer snapshot (cluster scope)
-- ---------------------------------------------------------------------------
INSERT INTO cloud_cost_snapshots (
  id, provider, source, account_id, scope_type, scope_key, scope_label,
  window_start, window_end, mtd_through, amount, projected_amount, currency,
  confidence, coverage, filter_json, breakdown_json, observed_at
) VALUES (
  'ccs_demo_aws_cluster_month',
  'aws', 'aws_cost_explorer', '000000000000',
  'cluster', 'eve-cluster', 'Eve cluster (demo)',
  date_trunc('month', now() at time zone 'utc'),
  now() - interval '5 hours',
  (now() at time zone 'utc')::date - 1,
  402.37, 818.60, 'USD',
  'estimate', 'complete',
  '{"tags": {"Project": "eve-horizon", "Environment": "staging"}}',
  '{
    "metric": "UnblendedCost",
    "days_elapsed": 12,
    "days_in_month": 30,
    "by_service": [
      {"service": "Amazon Elastic Compute Cloud - Compute", "amount": 168.42, "currency": "USD"},
      {"service": "Amazon Relational Database Service", "amount": 84.15, "currency": "USD"},
      {"service": "Amazon Elastic Kubernetes Service", "amount": 43.20, "currency": "USD"},
      {"service": "Amazon Simple Storage Service", "amount": 28.91, "currency": "USD"},
      {"service": "Amazon EC2 - Other", "amount": 26.34, "currency": "USD"},
      {"service": "Elastic Load Balancing", "amount": 21.60, "currency": "USD"},
      {"service": "AmazonCloudWatch", "amount": 14.75, "currency": "USD"},
      {"service": "Amazon Route 53", "amount": 8.40, "currency": "USD"},
      {"service": "AWS Key Management Service", "amount": 6.60, "currency": "USD"}
    ],
    "provider_metadata": {"ce_end_exclusive": "demo"}
  }',
  now() - interval '5 hours'
)
ON CONFLICT (id) DO UPDATE SET
  window_start = EXCLUDED.window_start,
  window_end = EXCLUDED.window_end,
  mtd_through = EXCLUDED.mtd_through,
  amount = EXCLUDED.amount,
  projected_amount = EXCLUDED.projected_amount,
  breakdown_json = EXCLUDED.breakdown_json,
  observed_at = EXCLUDED.observed_at;

-- ---------------------------------------------------------------------------
-- OpenCost per-environment estimates (current month)
-- amounts are monthly-to-date USD estimates per namespace
-- ---------------------------------------------------------------------------
WITH env_costs(env_id, amount) AS (
  VALUES
    ('env_01ks2adbdsecytexw8vw1wpbdd', 58.20),  -- mto/prod local
    ('env_01ks2addj8ecytexxdeg2d4d2r', 24.75),  -- mto/cons local
    ('env_01krkde19qe4erdv6xzbvebr45', 12.30),  -- mto/tcpedge test
    ('env_01ks2am2y8ecytey14wzacb7mg',  8.40),  -- mto/ccli local
    ('env_01ks2am0tyecytey063rf8yq42',  6.10),  -- mto/pcli local
    ('env_01kt1mjdkdf6e9569spbgrvg59', 42.18),  -- demo/obssim local
    ('env_01kt1m6xygf6e9565ardpthpve', 31.06),  -- demo/obscore local
    ('env_01ks0d158pexxtz468afxkny38', 18.90),  -- domaink3d/domk3d1 sandbox
    ('env_01ks0da7nwexxtz49mxek1rtdc',  9.65)   -- domaink3d/dmk3d2 sandbox
)
INSERT INTO environment_cost_snapshots (
  id, aggregation_key, environment_id, org_id, project_id, environment_slug,
  scope, source, window_start, window_end, amount_usd, confidence,
  breakdown_json, observed_at
)
SELECT
  'ecs_demo_' || ec.env_id,
  'env:' || ec.env_id,
  e.id, p.org_id, p.id,
  p.slug || ' / ' || e.name,
  'environment', 'opencost',
  date_trunc('month', now() at time zone 'utc'),
  now() - interval '2 hours',
  ec.amount, 'estimate',
  jsonb_build_object('allocations', jsonb_build_array(
    jsonb_build_object('totalCost', ec.amount, 'properties', jsonb_build_object('namespace', e.namespace))
  )),
  now() - interval '2 hours'
FROM env_costs ec
JOIN environments e ON e.id = ec.env_id
JOIN projects p ON p.id = e.project_id
ON CONFLICT (aggregation_key, source, window_start) DO UPDATE SET
  id = EXCLUDED.id,
  window_end = EXCLUDED.window_end,
  amount_usd = EXCLUDED.amount_usd,
  observed_at = EXCLUDED.observed_at;

-- Shared platform overhead (control plane, ingress, monitoring namespaces)
INSERT INTO environment_cost_snapshots (
  id, aggregation_key, environment_id, org_id, project_id, environment_slug,
  scope, source, window_start, window_end, amount_usd, confidence,
  breakdown_json, observed_at
) VALUES (
  'ecs_demo_shared_platform',
  'shared:platform', NULL, NULL, NULL, NULL,
  'shared_overhead', 'opencost',
  date_trunc('month', now() at time zone 'utc'),
  now() - interval '2 hours',
  96.40, 'estimate',
  '{"allocations": [{"totalCost": 96.40}]}',
  now() - interval '2 hours'
)
ON CONFLICT (aggregation_key, source, window_start) DO UPDATE SET
  id = EXCLUDED.id,
  window_end = EXCLUDED.window_end,
  amount_usd = EXCLUDED.amount_usd,
  observed_at = EXCLUDED.observed_at;

COMMIT;
