# Eve App Marketplace: Discovery, Private Distribution, and Billing

> Status: Idea
> Last Updated: 2026-02-12
>
> Related:
> - `docs/system/manifest.md` (project bootstrap, manifest conventions)
> - `docs/plans/eve-native-container-registry-plan.md` (registry: eve, token auth)
> - `docs/ideas/platform-resource-plane.md` (usage metering, balances, budgets)
> - `docs/ideas/app-role-permissions-mapping-and-ops.md` (app roles + permission overlays)
> - `docs/plans/agentic-pm-gap-closure-plan.md` (app primitives that benefit from a marketplace)
> - `docs/plans/managed-postgres-dbaas-plan.md` (managed DB for apps with schema migrations)
> - `packages/shared/src/permissions.ts` (canonical permission catalog)
> - `../eve-horizon-showcase` (showcase app: feature catalog reference)

## Brief

Eve needs a first-class way for Eve-compatible apps (for example the PM app) to be
discoverable, installable, upgradable, and optionally monetized.

This doc proposes an Eve-native marketplace model that:
- Works with the existing CLI-first, API-centric architecture.
- Supports public apps, private apps, and unlisted/internal catalogs.
- Enables paid distribution of closed-source apps via images (no source required).
- Enables SaaS pricing models using a usage ledger + entitlements.

## Design Principles

1. **EVE_API_URL is still enough**: discovery and install flows should be served by
   the Eve API (CLI remains a thin wrapper).
2. **Apps are projects**: installing an app results in an Eve project (or a small
   set of projects) that can be deployed like any other.
3. **Multiple distribution modes**: git-based (OSS/private), image-based (closed
   source), and hosted SaaS are all supported under a single listing model.
4. **Least privilege**: apps declare the permissions and secrets they require, and
   org admins can approve/install with a clear diff.
5. **No new platform trust anchors by default**: use standard signatures, SBOMs,
   and registry token scoping instead of bespoke mechanisms.

## Glossary

- **App Listing**: metadata for discovery (name, publisher, docs, categories).
- **App Version**: an immutable release (semver + artifacts + required capabilities).
- **App Artifact**: how the version is obtained (git ref, OCI bundle, SaaS endpoint).
- **Installation**: a binding between an org and an app version (creates/links a project).
- **Entitlement / License**: permission for an org to install and/or pull artifacts.

## What Is An "Eve-Compatible App"?

In v1: an app is a repo that contains `.eve/manifest.yaml` and optionally agent
packs (`x-eve.packs`) and app metadata (`x-eve.app`, proposed below).

Installing an app produces:
- a project (`projects` row) with a repo URL or template-derived repo
- one or more environments (`environments`)
- optionally, org/project access overlays and service principals for the app backend

## App Listing Metadata (Proposed)

Store listing metadata in the marketplace DB (canonical for discovery) and also
allow an app repo to declare optional metadata for indexing.

Proposed manifest extension:

```yaml
x-eve:
  app:
    slug: eve-pm
    display_name: Eve PM
    publisher: example
    summary: Agentic product management running on Eve
    categories: [productivity, pm]
    docs_url: https://docs.example.com/eve-pm
    support:
      email: support@example.com
    # Informational: surfaced during install and in "eve app show"
    requires:
      permissions:
        - projects:read
        - jobs:read
        - jobs:write
        - threads:read
        - threads:write
        - events:read
      secrets:
        - GITHUB_TOKEN
```

Notes:
- `x-eve.requires.secrets` already exists for projects; the marketplace can merge
  these signals but should keep install-time output deterministic.
- Permission names must come from the canonical catalog in
  `packages/shared/src/permissions.ts` (also surfaced via `eve auth permissions`
  and documented in `docs/system/auth.md`).

## Feature Catalog and Tags

Apps declare which Eve platform features they use. This serves two purposes:
agents building new apps can search for examples by feature, and the
marketplace can surface apps that match a user's platform capabilities.

### Canonical Feature Identifiers

Features are concrete, manifest-observable capabilities. Each feature ID
corresponds to something an agent can detect by reading the manifest.

| Feature ID | Detected From | Showcase Card |
|-----------|---------------|---------------|
| `build-pipeline` | pipeline step `type: build` | pipelines, builds |
| `release-promotion` | pipeline step `type: release` | pipelines |
| `deploy-pipeline` | pipeline step `type: deploy` | pipelines |
| `managed-db` | `x-eve.role: managed_db` | managed-db |
| `eve-registry` | `registry: eve` | container-registry |
| `agent-packs` | `x-eve.packs` | agent-packs |
| `harness-profiles` | `x-eve.agents.profiles` | harnesses |
| `multi-agent` | teams.yaml or `--parent` jobs | orchestration |
| `chat-routing` | chat.yaml routes | chat |
| `gateway-discovery` | gateway policy in agents.yaml | gateway-discovery |
| `event-triggers` | pipeline `trigger:` block | events |
| `cron-triggers` | trigger `source: cron` | events |
| `github-triggers` | trigger `github:` block | events |
| `secrets-interpolation` | `${secret.X}` in env vars | secrets |
| `managed-models` | `managed/` model prefix | managed-models |
| `git-controls` | `x-eve.defaults.git` | git-controls |
| `ingress` | `x-eve.ingress` | manifest |
| `healthchecks` | `healthcheck:` on services | manifest |
| `api-spec` | `x-eve.api_spec` | manifest |
| `workflows` | `workflows:` block | pipelines |
| `storage` | `x-eve.storage` | manifest |
| `file-mounts` | `x-eve.files` | manifest |
| `skills` | skills.txt or `x-eve.packs` | skills |
| `resource-classes` | `resource_class` on jobs/defaults | resource-management |

The "Showcase Card" column maps to the corresponding card in the Eve Horizon
Showcase app (`../eve-horizon-showcase`), which serves as the canonical
reference for each feature with diagrams, CLI commands, and manifest examples.

### Manifest Declaration

Apps declare features and free-form tags in `x-eve.app`:

```yaml
x-eve:
  app:
    slug: eve-pm
    display_name: Eve PM
    publisher: example
    summary: Agentic product management running on Eve
    categories: [productivity, pm]
    features:
      - build-pipeline
      - deploy-pipeline
      - managed-db
      - agent-packs
      - chat-routing
      - secrets-interpolation
    tags: [react, typescript, postgres, multi-agent, slack]
    # ...
```

Notes:
- `features` use identifiers from the canonical catalog above. Unknown IDs
  are accepted but flagged during `eve app publish` validation.
- `tags` are free-form strings for fine-grained search (languages, frameworks,
  patterns). No controlled vocabulary — convention emerges from usage.
- Both are optional. Apps without explicit features can still be discovered by
  category, publisher, or text search.

### Auto-Detection (Future)

The platform can infer features by parsing the manifest at publish time:
- `registry: eve` in manifest → auto-tag `eve-registry`
- `x-eve.role: managed_db` on any service → auto-tag `managed-db`
- `trigger:` block present → auto-tag `event-triggers`

Auto-detected features supplement (not replace) explicit declarations. This
means even apps that don't declare features are discoverable by what they use.

## Agent Discovery: Finding Examples by Feature

Agents building Eve-compatible apps need to find working examples. The
marketplace doubles as an example index.

### The Agent Workflow

```
Agent needs to implement managed-db in their app
  → eve app search --features managed-db --visibility public
  → Returns: eve-pm (uses managed-db, build-pipeline, agent-packs)
             acme-crm (uses managed-db, deploy-pipeline, ingress)
  → Agent reads the listing: eve app show eve-pm
  → Gets repo_url, sees manifest example, reads the relevant showcase card
  → Implements managed-db following the same pattern
```

### Search API Additions

```
GET /apps?features=managed-db,build-pipeline    # AND: apps using both
GET /apps?features_any=managed-db,eve-registry  # OR: apps using either
GET /apps?tags=postgres,react                   # free-form tag search
GET /apps?q=product+management                  # text search (name, summary)
```

Filters compose: `?features=managed-db&categories=productivity&visibility=public`.

### CLI Additions

```bash
# Search by feature
eve app search --features managed-db
eve app search --features managed-db,agent-packs --visibility public

# Search by tag
eve app search --tags postgres,react

# Combined: "show me public apps using managed-db with a React frontend"
eve app search --features managed-db --tags react --visibility public

# Show feature details for an app
eve app show eve-pm --features
# Features: build-pipeline, deploy-pipeline, managed-db, agent-packs, chat-routing
# Tags: react, typescript, postgres, multi-agent, slack

# Find examples for a specific feature (shorthand)
eve app examples managed-db
# Equivalent to: eve app search --features managed-db --visibility public --json
```

The `eve app examples <feature>` command is the agent-facing entry point.
Agents building a new app can run this to find real repos using a feature,
then inspect the manifest and code for patterns.

### Showcase as Feature Reference

The Eve Horizon Showcase (`../eve-horizon-showcase`) serves as the canonical
reference for each platform feature. Each card in the showcase maps to one or
more feature IDs from the catalog above.

The showcase already provides:
- Mermaid diagrams explaining the feature architecture
- CLI command references
- Manifest examples
- Detailed explanations

The showcase `/llms` route generates a structured reference for LLM
consumption. With the feature catalog formalized, this route can be extended
to include feature IDs alongside each card, making it queryable by agents:

```
# Agent reads the showcase reference for a specific feature
curl https://showcase.eve.example.com/llms.txt | grep -A50 "## Managed Postgres"
```

Or via the marketplace API, which can proxy the showcase reference:

```
GET /apps/features/managed-db/reference   # returns showcase content for the feature
```

### Data Model Additions

Add to `app_listings`:
- `features` (text[]): canonical feature identifiers
- `tags` (text[]): free-form tags

Add to `app_versions`:
- `features_json` (jsonb): version-specific features (may differ from listing)

Index: `CREATE INDEX idx_app_listings_features ON app_listings USING GIN (features);`

## Distribution Modes

### 1) Git Repo (Open Source or Private Repo)

Artifact contains:
- `repo_url`
- default `ref` (tag/branch/SHA)
- optional `template` settings for `project bootstrap`

Install flow (happy path):
1. `POST /projects/bootstrap` with `org_id`, `name`, `repo_url`, `branch`,
   `environments` (aligns with the existing bootstrap API — see manifest.md).
2. `eve project sync` (resolves manifest, packs, secrets requirements).
3. `eve env deploy <env>` (direct or pipeline alias).

This supports private source apps when the repo is private to the org (or shared
via Git provider permissions). No additional platform work required.

### 2) OCI App Bundle (Closed Source, Paid Apps)

Artifact contains:
- an OCI reference to an "Eve App Bundle" (EAB) plus publisher signatures
- image digests for all services
- a manifest snapshot (or a minimal template repo snapshot) pinned to digests

Installation creates a project that deploys from pinned images. The repo created
for the customer can contain:
- only `.eve/manifest.yaml` referencing image digests
- docs/readme for operating the app
- no application source code

This supports proprietary apps without giving customers source access, while
still using standard Eve deploy flows.

### 3) Hosted SaaS (Vendor-Run)

Artifact contains:
- service URL(s)
- auth/bootstrap steps (service principal, integration secret names)
- optional "connector" deployment (thin proxy in the customer org) if needed

This supports traditional SaaS pricing without requiring deployment of vendor
code into the customer org, but still provides a consistent "install" surface
and discoverability.

## Marketplace Scopes

Support multiple catalogs:

1. **System catalog**: curated by the Eve operator (public on managed instances).
2. **Org catalog**: private listings scoped to an org (internal apps).
3. **Unlisted listings**: installable by slug/version if you have an entitlement,
   but not visible in search.

This enables:
- internal platform teams to publish reusable apps privately
- commercial vendors to publish public listings while gating installs via license

## Marketplace Deployment Options

We can keep "marketplace runs in Eve" true in two non-exclusive ways:

1. **Built-in marketplace (API-owned)**: the Eve API hosts `/apps/*` endpoints and
   stores listings in DB tables. This is the simplest model for managed Eve
   instances.
2. **Marketplace as an Eve app (project-owned UI/API)**: a normal Eve project
   (`eve-marketplace`) provides a UI and an API over listing data (for example
   stored as org docs). The core Eve API can remain the control plane for install
   flows, while the marketplace app is just the front-end.

Longer-term (optional): allow multiple marketplace "providers" (feeds) to be
configured and mirrored into the system catalog, similar to how registries or
package indexes can be federated.

## Data Model (Sketch)

```sql
-- app_listings: discoverability metadata
-- app_versions: immutable releases
-- app_artifacts: "how to fetch" for a specific version
-- app_installations: org -> app version bindings
-- app_entitlements: org is allowed to install/pull/upgrade a listing/version
-- app_pricing_plans: how to compute charges (subscription, usage, hybrid)
```

Minimal fields:

- `app_listings`: `id` (typeid `al_xxx`), `slug` (unique), `display_name`,
  `publisher_org_id` (FK `orgs.id`), `visibility` (`public|org|unlisted`),
  `categories` (text[]), `summary`, `icon_url`, `created_at`
- `app_versions`: `id` (typeid `av_xxx`), `listing_id` (FK `app_listings.id`),
  `version` (semver), `released_at`, `compat_json`, `requires_json`
  (permissions + secrets), `changelog`; unique on `(listing_id, version)`
- `app_artifacts`: `id` (typeid `aa_xxx`), `version_id` (FK `app_versions.id`),
  `type` (`git|oci_bundle|saas`), `artifact_json`
- `app_installations`: `id` (typeid `ai_xxx`), `org_id` (FK `orgs.id`),
  `listing_id` (FK `app_listings.id`), `version_id` (FK `app_versions.id`),
  `project_id` (FK `projects.id`, nullable for SaaS), `installed_by`
  (FK `users.id`), `installed_at`, `status` (`active|suspended|uninstalled`)
- `app_entitlements`: `id` (typeid `ae_xxx`), `org_id` (FK `orgs.id`),
  `listing_id` (FK `app_listings.id`), `mode` (`trial|paid|internal`),
  `expires_at`, `limits_json`

Notes:
- FKs use typeid references matching Eve conventions (`org_xxx`, `proj_xxx`).
- `app_installations.project_id` is nullable for SaaS-mode apps that don't
  create a project in the customer org.
- `requires_json` stores `{ permissions: string[], secrets: string[] }` and
  is validated against the canonical permission catalog on publish.

## API (Sketch)

Discovery:

```
GET  /apps                       # search + filters (category, visibility, publisher)
GET  /apps/:slug                 # listing metadata + versions summary
GET  /apps/:slug/versions        # list versions (public to entitled viewers)
GET  /apps/:slug/versions/:ver   # show version + requires + artifact
```

Install and lifecycle:

```
POST /orgs/:org_id/apps/:slug/install
POST /orgs/:org_id/apps/:slug/upgrade
POST /orgs/:org_id/apps/:slug/uninstall
GET  /orgs/:org_id/apps/installed
GET  /orgs/:org_id/apps/installed/:installation_id
```

Publisher ops (managed instances):

```
POST /apps/:slug/publish
POST /apps/:slug/versions/:ver/yank
POST /apps/:slug/entitlements/grant
```

## CLI (Sketch)

```bash
eve app search [--category pm] [--publisher example]
eve app show eve-pm [--version 1.2.3]
eve app install eve-pm --org org_acme --name pm --envs staging,prod
eve app upgrade eve-pm --org org_acme --to 1.3.0
eve app installed --org org_acme
```

The CLI should always surface:
- required secrets and permissions (and whether they are currently satisfied)
- the project/environment names it will create or mutate
- whether the install will deploy immediately or only bootstrap/sync

On upgrade, the CLI should diff requirements between the installed version and
the target version, and fail-fast if new secrets are missing:

```bash
eve app upgrade eve-pm --org org_acme --to 1.3.0
# ✗ Version 1.3.0 requires secret OPENAI_API_KEY (not set on org_acme)
# Run: eve secrets set OPENAI_API_KEY --org org_acme
```

## System Events

Marketplace lifecycle actions emit events on the event spine so triggers,
audit logs, and platform agents can react:

| Event | Emitted When |
|-------|-------------|
| `system.app.published` | New version published to a catalog |
| `system.app.installed` | App installed into an org |
| `system.app.upgraded` | App upgraded to a new version |
| `system.app.uninstalled` | App removed from an org |
| `system.app.entitlement.granted` | Entitlement created or renewed |
| `system.app.entitlement.expired` | Entitlement expired (periodic check) |

Events carry `{ listing_id, version_id?, org_id, installation_id? }` as
payload. This enables workflows like "notify Slack on install" or "run
post-install smoke tests" via standard trigger config.

## Security, Trust, and Guardrails

1. **Explicit requirements**: app versions declare required permissions and
   required secrets up front, and installs fail-fast if requirements are unmet.
2. **Signatures**: for bundle-based distribution, require publisher signatures
   (for example via cosign). Store and verify signature metadata during publish.
3. **SBOM and scanning**: treat SBOMs as first-class artifacts and optionally
   enforce minimum vulnerability policy on install/upgrade. The existing builds
   primitive can generate SBOMs during `type: build` pipeline steps.
4. **Access overlays**: if an app needs custom roles, integrate with the custom
   role overlay model in `docs/ideas/app-role-permissions-mapping-and-ops.md`.
5. **Runtime isolation**: app workloads still run in normal per-environment
   namespaces; network policies and resource quotas apply as usual (see
   `docs/ideas/platform-resource-plane.md` §1.4 for quota enforcement).

## Licensing and Paid App Distribution

Paid apps require entitlements that gate:
- visibility (who can discover the listing)
- installation (who can install)
- artifact access (who can pull images or fetch bundles)

### Using the Eve-Native Registry for Paid Apps

If distribution is image-based, the cleanest model is to require `registry: eve`
and issue short-lived pull tokens scoped by entitlements:

- Publisher pushes images under their namespace.
- Customer org receives entitlement for `app_slug`.
- Eve API issues a registry pull token with scopes like:
  `repository:<publisher_org>/<app_slug>/<service>:pull`

This avoids long-lived registry credentials and makes "license = pull access"
enforceable at the platform boundary.

## SaaS Billing Models (Sketch)

Billing can be layered in without changing app install flows:

1. **Subscription**: fixed monthly charge per installation.
2. **Usage-based**: charge based on resource usage attributed to the installation.
3. **Hybrid**: base subscription + usage overage.

The platform-resource-plane ledger provides the substrate:
- emit `usage_records` for job attempts, deployments, and managed resources
- attach attribution fields (for example `app_installation_id` and `app_slug`)
- periodically aggregate and produce `balance_transactions` charges
- credit publisher balances (revenue share) or invoice externally

This keeps app monetization aligned with the same metering that powers platform
budgets and hard caps.

## Rollout Plan

Each phase is independently shippable. Later phases depend on earlier ones.

1. **Phase 0 (MVP)**: curated system catalog of git-based apps, install = project
   bootstrap + sync. No billing. Prerequisite: none (uses existing bootstrap API).
2. **Phase 1**: org-scoped private catalogs and unlisted listings.
   Prerequisite: Phase 0 + `app_listings.visibility` enforcement.
3. **Phase 2**: entitlements and license gating for installs (manual grant).
   Prerequisite: Phase 1 + `app_entitlements` table.
4. **Phase 3**: paid bundle distribution via `registry: eve` + scoped pull tokens.
   Prerequisite: Phase 2 + Eve-native container registry
   (`docs/plans/eve-native-container-registry-plan.md`), cosign for signatures.
5. **Phase 4**: usage attribution + automated billing using the resource ledger.
   Prerequisite: Phase 3 + platform-resource-plane usage metering
   (`docs/ideas/platform-resource-plane.md` Phase 0-2).

## Open Questions

1. **Install vs link**: Should app install always create a new project, or also
   support linking an existing project to a listing (treating it as "managed by
   marketplace")? Linking would enable adopt-then-upgrade paths for existing
   deployments.
2. **Compatibility declaration**: How should app versions declare compatibility?
   Options: minimum manifest schema version, required platform features as a
   string set (e.g. `["managed_db", "pipelines_v2"]`), or an opaque
   `compat_json` blob validated by the API. Schema migrations are a sub-problem
   — see Q4.
3. **Private repo auth for vendors**: Eve already supports SSH challenge-response
   auth for Git. The simplest v1 path may be "bundle-only for paid apps" (OCI
   mode), with private-repo Git auth deferred until the platform has deploy-key
   provisioning or GitHub App integration.
4. **App upgrades with schema migrations**: Apps that use `x-eve.role: managed_db`
   (see `docs/plans/managed-postgres-dbaas-plan.md`) need a safe upgrade story.
   Candidate: app versions declare a `migration_service` (e.g. Flyway container)
   and the upgrade flow runs it as a pipeline `type: job` step with automatic
   rollback on failure. Needs design for customer-data backup before migration.
5. **Publisher revenue share**: For paid apps on managed instances, how does
   revenue flow back to the publisher? Options: direct payout via the
   `PaymentProvider` interface, or ledger credits redeemable externally.
   Deferred until Phase 4.
