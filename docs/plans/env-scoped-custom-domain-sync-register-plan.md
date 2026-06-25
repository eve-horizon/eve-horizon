# Env-Scoped Custom Domain Sync and Register CLI

> **Status**: Plan (reviewed against code 2026-05-19)
> **Created**: 2026-05-19
> **Updated**: 2026-05-19
> **Tags**: eve-platform-spec, custom-domains, ingress, cli
> **Related**: [custom-domains-plan.md](./custom-domains-plan.md), [deploy-error-surfacing-plan.md](./deploy-error-surfacing-plan.md)
> **Promotes**: ACME platform gap `006 - Env-scoped custom domain sync + eve domain register CLI`

---

## Purpose

Let an Eve project declare custom domains inside environment overrides, run
`eve project sync`, and have those domains reserved and bound to the intended
environment without a hand-written API call or wrapper script.

This closes the current ACME rebuild gap where `sandbox.acme.example` and
future customer-facing portal domains require a post-sync script that calls the
custom-domain API and then transfers ownership to the environment.

## Current State

Custom domains are implemented, but only for top-level service ingress config.

- `packages/shared/src/schemas/manifest.ts#getManifestCustomDomains()` returns
  `Map<hostname, serviceName>` by walking only `services.*.x-eve.ingress.domains`.
  Duplicate detection is encoded as a symbol-keyed side-channel on the returned
  map and surfaced via `assertUniqueManifestCustomDomains()`.
- `apps/api/src/projects/projects.service.ts#reconcileCustomDomains()` (sync)
  treats that top-level map as the full desired state. It calls
  `customDomainQueries.claimOrUpdate({ id, hostname, project_id, service_name })`
  per host and then `release(hostname, projectId)` (hard `DELETE`) for any
  existing project rows whose hostnames are not in the desired set.
- `packages/db/src/queries/custom-domains.ts#claimOrUpdate()` is already
  owner-aware: on `ON CONFLICT (hostname)` it only updates `service_name` when
  the row belongs to the same project, is not `removed`, and `environment_id IS
  NULL`. For same-project rows owned by another env it returns the existing
  row unchanged so callers cannot silently clobber metadata they do not own.
- `apps/worker/src/deployer/deployer.service.ts#applyServiceOverrides()` merges
  `environments.<env>.overrides.services` into services before rendering. Array
  values (including `domains`) are replaced wholesale by `deepMerge()`'s
  `Array.isArray(value) ? value.slice()` branch — env overrides do not append
  to top-level domain lists, they replace them per service. A registered and
  correctly bound env-scoped domain therefore already produces the expected K8s
  `Ingress`.
- `apps/worker/src/deployer/deployer.service.ts` already calls `claimOrUpdate`
  then `bindToEnvironment` per candidate during deploy, so an env-scoped domain
  whose row exists with the right env binding deploys today.
- `POST /projects/:project_id/domains` exists and accepts only
  `{ hostname, service_name }` (`RegisterDomainSchema` in
  `apps/api/src/custom-domains/custom-domains.controller.ts`), creates an
  unbound row, and has no CLI wrapper.
- `eve domain list|status|verify|transfer|unbind|remove` exist
  (`packages/cli/src/commands/domain.ts`), but `register` does not.

The result is asymmetric behavior: deploy sees env overrides, sync does not.
After a manual registration, the next sync can delete the row because the
hostname is not present in the top-level manifest domain set.

## Goals

1. `eve project sync` must discover
   `environments.<env>.overrides.services.<svc>.x-eve.ingress.domains`.
2. Sync must claim env-scoped hostnames and bind single-env declarations to the
   matching environment.
3. Sync must be idempotent. Re-running sync preserves the existing `cdom_*` row
   and owner environment.
4. Env-scoped and manually registered domain rows must survive later syncs.
5. `eve domain register <host> --project <p> --service <s> --env <e>` must wrap
   the API for imperative use cases.
6. `eve domain status <host> --json` must expose stable structured fields:
   `owner_env`, `dns_state`, `cert_state`, and `last_verified_at`.
7. Empty-list, 404, and conflict messages must point to the right next command:
   `eve project sync`, `eve domain register`, `eve domain transfer`, or
   `eve domain verify`.

## Non-Goals

- DNS provider automation.
- Wildcard certificates.
- Cross-org domain transfers.
- Platform-domain subdomains; those remain `x-eve.ingress.alias`.
- Reworking custom-domain deploy rendering. The deployer already renders custom
  domain ingresses from the effective env-specific service config.

## Desired Manifest Behavior

This manifest is valid today but sync ignores the env-scoped hostnames:

```yaml
services:
  api:
    x-eve:
      ingress:
        public: true
        port: 3000

environments:
  sandbox:
    overrides:
      services:
        api:
          x-eve:
            ingress:
              domains: [sandbox.observation.example]
  prod:
    overrides:
      services:
        api:
          x-eve:
            ingress:
              domains: [app.observation.example]
```

After `eve project sync --dir .`:

```bash
eve domain list --project <project>
# HOSTNAME                         SERVICE    ENV         STATUS             VERIFIED
# sandbox.observation.example      api        sandbox     pending_dns        -
# app.observation.example          api        prod        pending_dns        -
```

Repeat sync must return the same rows and IDs. It must not release either row
because the domains live under env overrides instead of top-level services.

## Design

### 1. Add an Env-Aware Manifest Extraction Model

Keep `getManifestCustomDomains(manifest): Map<string, string>` for existing
callers, but introduce a richer helper in `packages/shared/src/schemas/manifest.ts`
or a small shared manifest utility module:

```ts
type ManifestCustomDomainScope = 'project' | 'environment';

interface ManifestCustomDomainDeclaration {
  hostname: string;
  service_name: string;
  scope: ManifestCustomDomainScope;
  env_name: string | null;
  origin_path: string;
}

interface ManifestCustomDomainDesiredState {
  hostname: string;
  service_name: string;
  env_names: string[];
  has_project_scope: boolean;
  origin_paths: string[];
}
```

Extraction rules:

- Top-level `services.*.x-eve.ingress.domains` produce `scope: 'project'` and
  `env_name: null`. The schema is `IngressConfigSchema` in
  `packages/shared/src/schemas/manifest.ts` (declared with `.passthrough()` so
  unknown keys do not break parsing).
- `environments.<env>.overrides.services.*.x-eve.ingress.domains` produce
  `scope: 'environment'` and `env_name: <env>`.
- Env override arrays use the same replacement semantics as deploy rendering:
  `deployer.service.ts#deepMerge()` does `Array.isArray(value) ? value.slice()`,
  so if an env override supplies `domains`, those domains are the env-specific
  declaration for that service and the top-level list is not concatenated.
- Normalize hostnames to lowercase via the same `CustomDomainPattern` validation
  used today by `IngressConfigSchema` (also re-applied in `claimOrUpdate`).
- Reject the same hostname on different services, including when one declaration
  is top-level and another is env-scoped. Reuse the symbol-keyed side-channel
  pattern (`__cd_duplicates`) consumed by `assertUniqueManifestCustomDomains()`
  so the existing sync error path keeps working — extend the assertion (or add
  a parallel `assertUniqueManifestCustomDomainDeclarations()`) to consume the
  richer declaration set.
- Allow the same hostname on the same service in multiple envs, but do not
  silently rebind ownership. If there is exactly one env declaration, sync can
  bind it. If there are multiple env declarations, sync preserves the current
  owner or leaves the row unbound and returns a warning that `eve domain transfer`
  is the explicit move command.
- A hostname declared both at top level and inside one env override for the
  same service is not a conflict — top level acts as the default and the env
  override has no semantic effect for sync. (Per-env arrays already replace,
  not merge with, the top-level list at deploy time.) A hostname declared at
  top level and additionally bound to a *specific* env via an override is
  treated as an env-scoped declaration for that env plus a top-level fallback.

`getManifestCustomDomains()` can be reimplemented as a projection of the richer
helper so existing top-level callers keep working. The validation against the
projects table in `ProjectsService.upsertManifest` (the
`existingDomain.project_id !== projectId` check) must also be extended to walk
env-scoped declarations.

### 2. Preserve Manual Rows and Prune Only Manifest-Managed Rows

Add ownership-source metadata to `custom_domains` so sync can distinguish
manifest-managed rows from imperative rows.

Concrete migration (next slot is `00103_` — latest existing is
`00102_storage_buckets_isolation.sql`):

```sql
-- packages/db/migrations/00103_custom_domain_source.sql
ALTER TABLE custom_domains
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manifest', 'manual'));

CREATE INDEX idx_custom_domains_project_source
  ON custom_domains(project_id, source);
```

Rationale:

- `eve domain register` is explicitly supported for domains that are not in the
  manifest.
- Sync must not delete those manual rows.
- Manifest-declared rows can still be garbage-collected when removed from the
  manifest, preserving the existing declarative behavior.

Query layer changes (`packages/db/src/queries/custom-domains.ts`):

- Extend `ClaimOrUpdateCustomDomainInput` with `source: 'manifest' | 'manual'`.
- `claimOrUpdate`'s `ON CONFLICT` clause must keep its current owner-aware
  guard (only update when same project, not `removed`, and `environment_id IS
  NULL`) and additionally set `source = EXCLUDED.source` so a same-project
  unbound row gets re-tagged when sync re-declares it.
- Add a new helper `releaseManifestManaged(hostname, projectId)` that deletes
  only rows where `source = 'manifest'`. Sync calls this instead of the
  existing `release(hostname, projectId)` so manual rows survive even when the
  caller forgets to filter. Keep `release()` for the imperative
  `eve domain remove` path.
- The existing deployer fallback `claimOrUpdate` call in
  `apps/worker/src/deployer/deployer.service.ts` (the safety net when sync did
  not run) must pass `source: 'manifest'` because the candidate originated
  from manifest rendering.
- The API `register()` path in `custom-domains.service.ts` must pass
  `source: 'manual'`.

For existing rows at migration time, defaulting to `manual` is the conservative
choice: it prevents a sync immediately after upgrade from deleting rows that
may have been created through the API workaround. The next sync that still
declares a hostname will set that row to `manifest` via the `ON CONFLICT
... DO UPDATE` branch above and pruning resumes naturally.

### 3. Reconcile Env-Scoped Domains During Project Sync

Replace `reconcileCustomDomains(projectId, manifest)` with env-aware logic:

1. Extract the desired custom-domain state from top-level services and env
   overrides.
2. Validate project-wide hostname conflicts against other projects, as today
   (currently a `findByHostname` loop before the transaction in
   `upsertManifest`; widen it to walk env-scoped declarations).
3. Validate that every `service_name` in the desired set exists in the merged
   services for its scope: top-level domains must point at a service in
   `manifest.services`; env-scoped domains must point at a service present in
   the env-merged service map (top level merged with the env override).
4. Ensure environment rows exist for env-scoped single-env declarations:
   - If the DB row already exists, use it.
   - If the manifest defines the env but the DB row does not exist, create the
     same persistent standard environment row that `env deploy` auto-creates
     (the helper in `EnvironmentsService.deploy` at
     `apps/api/src/environments/environments.service.ts:534`), including
     `overrides_json` from the manifest env config. Extract this to a shared
     `ensureManifestEnvironment(projectId, envName, manifest)` helper that
     both sync and register can call.
   - If the env is not defined in manifest or DB, reject with a message naming
     the bad env path.
5. For each desired hostname, call `claimOrUpdate({ source: 'manifest', ... })`.
   - This call is already owner-aware: if a same-project row is bound to
     another env, the existing row is returned unchanged. Sync must NOT treat
     that as an error — it is the input to step 6's ownership analysis.
   - If the row belongs to another project, treat as a hard conflict
     (`ConflictException`, same as today).
6. If the hostname has exactly one env declaration, call
   `bindToEnvironment(hostname, projectId, envId, serviceName)`.
   - If the row is unbound, this binds it.
   - If the row already belongs to that env, this writes through the
     `service_name` in the same UPDATE (existing semantics).
   - If another env owns it, `bindToEnvironment` returns `null`. Keep the
     current owner and emit a sync warning that names the owner and the exact
     `eve domain transfer <host> --to <env>` command. Do NOT fail sync — this
     is a soft warning so the rest of the manifest still applies.
7. If the hostname has multiple env declarations, do not pick an owner during
   sync unless the current owner is one of the declared envs. Return a warning
   if the row is unbound or owned by an env outside the declaration set.
8. Call `releaseManifestManaged(hostname, projectId)` (new helper from §2) for
   every existing project row whose hostname is not in the desired state.
   Never delete `source = 'manual'` rows during sync. Skip rows whose `status`
   is already `removed`.

This preserves first-bind-wins for ambiguous multi-env hostnames while making
the common one-host-per-env topology fully declarative.

### 4. Extend the Register API

Keep the existing route:

```http
POST /projects/:project_id/domains
```

Extend the body schema compatibly (extend `RegisterDomainSchema` in
`apps/api/src/custom-domains/custom-domains.controller.ts`):

```ts
{
  hostname: string;
  service_name: string;
  environment?: string;      // env name or id; optional
}
```

`source` is server-controlled. This route always writes `source = 'manual'`;
accepting `source` from the client would let an API caller create a row that
sync would later delete, which is a footgun. The only writer of
`source = 'manifest'` is `ProjectsService.reconcileCustomDomains` (and the
deployer fallback that mirrors sync's intent).

Behavior:

- Without `environment`, create or update an unbound manual row.
- With `environment`, resolve an existing env row by name or id.
- If the env is defined in the latest manifest but not materialized in the DB,
  create the environment row using the same `ensureManifestEnvironment` helper
  from sync (see §3 step 4).
- If the env is unknown, return:

  ```text
  Environment "sandbox" does not exist for this project. Add it to
  environments.sandbox in the manifest and run eve project sync, or create it
  with eve env create sandbox --project <project>.
  ```

- If the domain already exists for the same project and is already bound to the
  requested env, return the existing row with `unchanged: true`.
- If the domain exists for the same project but a different env owns it, return
  a conflict that names the owner and suggests `eve domain transfer`.
- If another project owns the hostname, preserve the existing conflict behavior.

### 5. Add `eve domain register`

Update `packages/cli/src/commands/domain.ts` and CLI help:

```bash
eve domain register <hostname> --project <id> --service <service> [--env <env>] [--json]
```

CLI behavior:

- Sends `POST /projects/:project_id/domains`.
- Uses body keys `{ hostname, service_name, environment }`.
- Prints the resulting hostname, service, owner env, status, and DNS next step.
- In JSON mode, returns the API response unchanged.
- If `--service` is missing, fail locally with usage.
- If `--env` is omitted, print that the row is unbound and the next deploy that
  declares the hostname can claim it.

Do not remove or rename existing commands. `remove` remains the destructive
unregister operation; `unbind` remains the DB-only env ownership reset.

### 6. Stabilize Status Output

Keep existing fields for compatibility, but add a stable status envelope from
`CustomDomainsService.serializeWithEnv()`:

```ts
{
  id: string;
  hostname: string;
  project_id: string;
  service_name: string;
  status: string;
  owner_env: { id: string; name: string } | null;
  dns_state: 'pending' | 'verified' | 'error' | 'unknown';
  cert_state: 'not_requested' | 'provisioning' | 'active' | 'error' | 'unknown';
  last_verified_at: string | null;

  // Existing compatibility fields:
  environment_id: string | null;
  environment_name: string | null;
  verified_at: string | null;
}
```

Derive `dns_state` and `cert_state` from the existing `status` column for v1:

| `status` | `dns_state` | `cert_state` |
| --- | --- | --- |
| `pending_dns` | `pending` | `not_requested` |
| `dns_verified` | `verified` | `not_requested` |
| `cert_provisioning` | `verified` | `provisioning` |
| `active` | `verified` | `active` |
| `dns_error` | `error` | `unknown` |
| `cert_error` | `verified` | `error` |

`eve domain status <host>` should render `Owner env`, `DNS`, `Cert`, and
`Last verified` explicitly. This gives wrapper scripts a stable machine shape
and makes human output explain the activation state.

### 7. Improve Operator Hints

Update CLI/API messages for the common failure modes:

- Empty `eve domain list`:
  - Current message says only to declare top-level `x-eve.ingress.domains`.
  - New message should mention env overrides and imperative registration.
- `eve domain status <host>` returns 404:
  - Suggest `eve project sync --dir .` if the host is declared in manifest.
  - Suggest `eve domain register <host> --service <svc> --env <env>` for
    imperative cases.
- Sync sees an env-scoped hostname already owned by another env:
  - Return a warning with current owner and exact transfer command.
- Register sees an owner conflict:
  - Return a conflict with current owner and exact transfer command.

Avoid vague "manifest drift" or "Origin not allowed" guidance for this class
of failure. Domain ownership problems should name the domain subsystem.

## Implementation Phases

### Phase 1 - Shared Extraction and Validation

Files:

- `packages/shared/src/schemas/manifest.ts`
- `packages/shared/src/schemas/__tests__/manifest-custom-domains.spec.ts` or
  equivalent existing manifest test file

Work:

- Add env-aware domain declaration extraction.
- Preserve the current map helper for compatibility.
- Add validation for cross-service duplicate hostnames across top-level and env
  override declarations.
- Add tests for:
  - top-level-only domains
  - env-override-only domains
  - top-level plus env-scoped domains
  - duplicate hostname on different services
  - same hostname on same service in multiple envs

### Phase 2 - DB and Sync Reconciliation

Files:

- `packages/db/migrations/00103_custom_domain_source.sql` (next free slot)
- `packages/db/src/queries/custom-domains.ts`
- `apps/api/src/projects/projects.service.ts`
- `apps/api/src/environments/environments.service.ts` (extract reusable
  `ensureManifestEnvironment` helper used by both sync and register)
- `apps/api/test/integration/manifest.integration.test.ts`

Work:

- Add `custom_domains.source` plus index.
- Extend `claimOrUpdate` to accept and write `source`; add new
  `releaseManifestManaged(hostname, projectId)` helper.
- Move env auto-creation logic out of `EnvironmentsService.deploy` into a
  shared helper so sync and register can materialize manifest-defined envs
  without duplicating defaults.
- Replace `desiredHostnames` with env-aware desired state and validate
  `service_name` against the env-merged service map (see §3 step 3).
- Bind single-env declarations during sync.
- Release only stale manifest-managed rows. Manual rows survive sync.
- Return warnings (non-fatal) for ambiguous or conflicting env ownership.

### Phase 3 - Register API

Files:

- `apps/api/src/custom-domains/custom-domains.controller.ts`
- `apps/api/src/custom-domains/custom-domains.service.ts`
- `apps/api/test/integration/custom-domains.integration.test.ts`
- `docs/system/openapi.yaml`
- `docs/system/openapi.json`

Work:

- Extend register request schema with optional environment.
- Resolve or materialize target env.
- Make register idempotent for same host/project/service/env.
- Return `unchanged` and `next_steps` fields when useful.
- Preserve existing request compatibility for `{ hostname, service_name }`.

### Phase 4 - CLI Register and Status Shape

Files:

- `packages/cli/src/commands/domain.ts`
- `packages/cli/src/lib/help.ts`
- relevant CLI tests if present

Work:

- Add `register` subcommand.
- Update usage text.
- Add stable JSON typings for `owner_env`, `dns_state`, `cert_state`, and
  `last_verified_at`.
- Improve empty list and 404 guidance.
- Keep `list`, `status`, `verify`, `transfer`, `unbind`, and `remove`
  compatible.

### Phase 5 - Deploy Path Regression Coverage

Files:

- `apps/worker/src/deployer/__tests__/deployer-custom-domain-ownership.spec.ts`
  (file already exists — extend, do not recreate)
- `tests/manual/scenarios/` if a manual scenario is warranted

Work:

- Confirm no deployer behavior change is required for env override domains
  (the deployer's existing `applyServiceOverrides` + per-candidate
  `claimOrUpdate`/`bindToEnvironment` flow already supports this once the row
  is registered with the right env).
- Update the deployer's safety-net `claimOrUpdate` call to pass
  `source: 'manifest'` so domains discovered first by deploy match sync's
  tagging.
- Extend the existing ownership spec with a case proving that a registered
  env-bound domain declared only in `environments.<env>.overrides.services`
  renders an Ingress on deploy.
- Confirm another env does not render the same hostname unless ownership is
  transferred.

### Phase 6 - Docs and Public Agent References

Files:

- `docs/system/deployment.md`
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli.md`
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md`
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/deploy-debug.md`

Work after implementation lands:

- Document env-scoped `x-eve.ingress.domains`.
- Add `eve domain register`.
- Document status fields and ownership transfer.
- Remove guidance that implies only top-level `x-eve.ingress.domains` are
  sync-managed.

## Acceptance Criteria

- A manifest with
  `environments.<env>.overrides.services.<svc>.x-eve.ingress.domains: [<host>]`
  followed by `eve project sync` creates a custom-domain row bound to `<env>`.
- Repeating `eve project sync` preserves the same `cdom_*` ID and owner env.
- `eve domain register <host> --project <p> --service <s> --env <e>` creates
  or reuses a row for a project that has not declared that hostname in manifest.
- Manual rows created by `eve domain register` survive subsequent
  `eve project sync` calls.
- Env-scoped manifest rows survive subsequent `eve project sync` calls.
- Deploying the bound env renders the K8s `Ingress` for the registered host.
- `eve domain status <host> --json` includes `owner_env`, `dns_state`,
  `cert_state`, and `last_verified_at`.
- Existing domain CLI commands remain compatible.

## Risks and Decisions

| Risk | Decision |
| --- | --- |
| Sync begins creating environment rows unexpectedly | Only materialize envs needed for env-scoped domain bindings, using the same defaults as deploy auto-create. Do not broaden this into full environment reconciliation in this plan. |
| Same hostname appears in multiple env overrides | Preserve first-bind-wins. Sync does not guess; it warns and points at `eve domain transfer`. |
| Manual rows are accidentally deleted by declarative sync | Add `source`, release only stale `source = 'manifest'` rows via a dedicated `releaseManifestManaged()` helper, and keep `source` out of the public register-API request body so callers cannot self-tag as manifest-managed. |
| `status` cannot express separate DNS/cert state | Derive stable fields from the existing status column in v1; split DB state later only if cert-manager reconciliation needs it. |
| Register and sync race on the same hostname | Use existing hostname uniqueness plus transaction-scoped claim/bind queries. Idempotent same-project requests return the existing row. |

## Open Questions

- Should `eve domain register --env <env>` create an env row when the env is not
  in the manifest, or should it require `eve env create` first? This plan
  allows creation only when the latest manifest defines the env, matching
  `EnvironmentsService.deploy`'s auto-create rule.
- Should `eve domain unregister` be added as an alias for `eve domain remove`?
  The current surface already has `remove` and `unbind`, so this plan keeps
  `remove` canonical.
- Should manifest-managed row deletion be automatic long-term, or should all
  custom-domain removal become explicit via `eve domain remove`? This plan keeps
  declarative pruning only for rows known to be manifest-managed.

