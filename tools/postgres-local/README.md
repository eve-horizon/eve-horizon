# Local Postgres Image

This image is used only by the local k3d overlay. It keeps the platform's local
managed-DB tests close to the supported Phase 1 managed extensions:

- `postgis`
- `pgvector` (Postgres extension name: `vector`)
- `pg_trgm`
- `btree_gist`
- `hstore`
- `citext`
- `pg_cron` (preloaded with `cron.database_name=postgres`)

Build and import it with:

```bash
./bin/eh k8s-image push-postgres
```

`./bin/eh k8s start` and `./bin/eh k8s deploy` also call this helper before
applying the local overlay, because the local Postgres StatefulSet references
`eve-postgres-local:16`.

The local k3d overlay also sets `shared_preload_libraries=pg_cron` on the
Postgres container and enables `EVE_MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS=pg_cron`
on the API, worker, and orchestrator. `timescaledb` remains out of the manifest
allowlist until a Timescale-capable provider model exists.
