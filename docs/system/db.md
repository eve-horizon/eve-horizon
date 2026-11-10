# Database CLI + Managed DB

> Status: Current
> Last Updated: 2026-11-10
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

### Which database `--env` targets

The API resolves the environment's database in this order:

1. The environment's DB override (`overrides.db.url`, `connection_url` or
   `database_url`, with an optional `schema`).
2. The manifest service named by the environment's `db_ref`, or else the one
   service with `x-eve.role: database` or `x-eve.role: managed_db`. Managed
   databases use the tenant's own credentials; container databases use
   `x-eve.connection_url`, `connection_url`, `url`, `DATABASE_URL`, or the
   `POSTGRES_*` variables and the service's cluster DNS name.

An environment with none of these has no database: every env-db command
(`schema`, `rls`, `extensions`, `sql`, `migrate`, `migrations`, `reset`,
`wipe`) answers `409` and opens no connection. Declare a database service or
set an override first.

Env-db commands never run against Eve's own platform database. A target is
"on the platform server" when its host and port match the platform's
`DATABASE_URL` (hosts match by name, case-insensitive, by resolved address,
or as loopback). On the platform server:

- the platform database itself is refused with `403`, whatever credentials
  the target carries;
- the platform's own role is refused with `403` on any database
  (`postgres`, `template1`, ...);
- after connecting and before running anything, a login that is a superuser
  or holds equivalent admin rights (membership in `cloudsqlsuperuser`,
  `rds_superuser`, `azure_pg_admin` or the `pg_*_server_*` file roles) is
  refused with `403`.

A plain role on another database of that server, such as a managed tenant
database, is allowed. Container databases in the environment's own namespace
are a different server and are not subject to these checks. If the platform
database host cannot be resolved, env-db commands answer `503` rather than
guess.

The env DB routes (`/projects/:id/envs/:name/db/...`) address the project by id.
A job token sent in the optional `eve-job-token` header lends its permissions
(for example `envdb:write`) only when it was minted for that same project; any
other header token is a 403 and nothing runs.

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
        roles:
          - name: app
            grants: readwrite
          - name: reports
            grants: readonly
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
  Fields: `url` (verbatim owner URL), `host`, `port`, `database`, `username`,
  `password`, `extensions`, and `roles.<name>.url|username|password` for declared
  roles.
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

### Roles

The tenant owner login is always provisioned. `x-eve.managed.roles` declares
additional least-privilege logins (`grants: readwrite` or `readonly`) named
`<owner user>-<name>` (hash-truncated to 63 characters). Per role the
reconciler runs, as the instance admin:

```sql
CREATE ROLE "<role>" WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '<random>';
GRANT CONNECT ON DATABASE "<db>" TO "<role>";
-- inside the tenant database:
GRANT USAGE ON SCHEMA "public" TO "<role>";
GRANT SELECT[, INSERT, UPDATE, DELETE] ON ALL TABLES IN SCHEMA "public" TO "<role>";
GRANT SELECT[, USAGE] ON ALL SEQUENCES IN SCHEMA "public" TO "<role>";
ALTER DEFAULT PRIVILEGES FOR ROLE "<owner>" IN SCHEMA "public" GRANT ... ON TABLES TO "<role>";
ALTER DEFAULT PRIVILEGES FOR ROLE "<owner>" IN SCHEMA "public" GRANT ... ON SEQUENCES TO "<role>";
```

- Role credentials are stored per role in `managed_db_tenant_roles` the same
  way the owner credential is stored on the tenant, and are exposed only through
  `${managed.<service>.roles.<name>.url|username|password}`.
- Changing `grants` re-grants in place; removing a role revokes its privileges
  and drops the login on the next deploy. Adding a role does not touch existing
  roles or the owner credential.
- `eve db rotate-credentials` rotates every role password with the owner
  password. `eve db destroy` drops the roles with the database.
- `eve db status --env <name>` lists declared and provisioned roles (names and
  logins only, never passwords).
- Roles are supported on the local provider; cloud providers reject them with
  `provider_unsupported` until provider support lands.

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
