# Database CLI + Managed DB

> Status: Current
> Last Updated: 2026-05-18
> Purpose: Document environment DB tooling and managed database provisioning.

## Environment DB CLI (Current)

Use `eve db` to inspect and operate on environment-scoped databases:

```bash
eve db schema --env staging [--project <id>]
eve db rls --env staging
eve db extensions list --env staging
eve db sql --env staging --sql "SELECT 1"
eve db sql --env staging --sql "UPDATE ..." --write
eve db sql --env staging --file ./query.sql
eve db migrate --env staging [--path db/migrations]
eve db migrations --env staging
eve db new create_users [--path db/migrations]
```

Migration files use `YYYYMMDDHHmmss_description.sql` under `db/migrations/` by default.

## Managed DB (Current)

Managed databases are declared in the manifest as services with `x-eve.role: managed_db`:

```yaml
services:
  db:
    x-eve:
      role: managed_db
      managed:
        class: db.p1
        engine: postgres
        engine_version: "16"
        extensions: [postgis, pgvector, pg_trgm]
```

Provisioning occurs when an environment is deployed; managed DB services are not
rendered into Kubernetes manifests.

Managed DB CLI commands:

```bash
eve db status --env staging
eve db extensions list --env staging
eve db rotate-credentials --env staging
eve db scale --env staging --class db.p2
eve db destroy --env staging --force
```

Notes:
- Managed DB availability depends on platform configuration (ask an admin if provisioning is disabled).
- Use `eve db status` to confirm tenant readiness before relying on managed values.
- Managed values can be referenced in env vars via `${managed.<service>.<field>}`.
- Plain declarable extensions are `postgis`, `pgvector`, `pg_trgm`, `btree_gist`, `hstore`, and `citext`.
- Provider-gated preload extensions are rejected unless the platform enables them with `EVE_MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS`. `pg_cron` is the first gated extension; it requires `shared_preload_libraries=pg_cron` on the backing Postgres instance before deploy.
- `pgvector` is declared as `pgvector` in the manifest but appears as `vector` in `pg_extension`.
- `pg_cron` follows the AWS RDS model: Eve installs it in the instance admin database (`postgres`) and grants tenant roles `USAGE` on the `cron` schema. Scheduling jobs for tenant databases remains a platform-admin operation.
- Extension removal is sticky in v1: removing a name from the manifest stops requesting it, but Eve does not run `DROP EXTENSION`.
- `timescaledb` is still not declarable on AWS RDS; Eve treats it as a preload candidate without a supported provider model.
- Missing preload configuration fails the tenant with `preload_missing`; unavailable provider packages fail with `extension_unavailable`.
- Local managed DB URLs default to `sslmode=disable`. Supported cloud providers default to `sslmode=verify-full`.
- The worker owns TLS trust distribution for managed DB clients. For cloud tenants it creates `ConfigMap/eve-db-trust`, mounts `/etc/eve/trust/ca-bundle.pem`, and injects `NODE_EXTRA_CA_CERTS` plus `PGSSLROOTCERT` into Deployments and `x-eve.role: job` pods.
- App code should use the plain connection string from `DATABASE_URL`. Do not set `ssl: { rejectUnauthorized: false }` in Node `pg`.

## Admin APIs (Managed DB Instances)

Managed DB instances are registered via admin endpoints:

```
GET  /admin/managed-db/instances
POST /admin/managed-db/instances
GET  /admin/managed-db/instances/:id
```

Project/env tenant endpoints:

```
GET    /projects/:project_id/envs/:env_name/db/managed
POST   /projects/:project_id/envs/:env_name/db/managed/rotate
POST   /projects/:project_id/envs/:env_name/db/managed/scale
DELETE /projects/:project_id/envs/:env_name/db/managed
```
