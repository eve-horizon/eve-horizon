-- 00110_environment_registry_pull_epoch.sql
-- Pull epoch for the Eve-native registry pull credential of each environment.
-- The deployer bumps it whenever it rewrites the environment's eve-registry
-- pull secret, and the registry token endpoint only honours credentials minted
-- for the current (or immediately previous) epoch, so a redeploy retires an
-- earlier credential.

ALTER TABLE environments
  ADD COLUMN IF NOT EXISTS registry_pull_epoch INTEGER NOT NULL DEFAULT 0;
