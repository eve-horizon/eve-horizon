-- Drop inference tables (inference simplification: remove platform-managed inference)
-- Tables created by migrations 00057, 00058, 00065 — all empty in production.
-- Drop FK-referencing tables first, then base tables.

DROP TABLE IF EXISTS inference_route_policies;
DROP TABLE IF EXISTS inference_installs;
DROP TABLE IF EXISTS inference_quotas;
DROP TABLE IF EXISTS inference_aliases;
DROP TABLE IF EXISTS inference_models;
DROP TABLE IF EXISTS inference_targets;

-- Clean up system settings
DELETE FROM system_settings WHERE key = 'managed_model_availability';
