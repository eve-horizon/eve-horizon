# First-Deploy Onboarding DX

> Status: Plan
> Created: 2026-02-16
>
> Dependencies: None — standalone improvements.
>
> References:
> - `packages/shared/src/schemas/manifest.ts` (getBuildableServices, line 351)
> - `apps/api/src/environments/environments.service.ts` (deploy, line 403)
> - `apps/api/src/projects/projects.service.ts` (validateManifest, line 766)
> - `apps/worker/src/builder/image-builder.service.ts` (buildAll, line 36)
> - `apps/api/src/secrets/secrets.service.ts` (validateRequiredSecrets, line 241)

## Problem

A developer's first deploy today requires 6+ failed pipeline runs and multiple manifest tweaks before succeeding. The gap between "I have a working app" and "it's running on Eve" is too wide.

The goal: **one manifest, two commands**.

```bash
eve project sync --dir .
eve env deploy sandbox --ref main
```

Today this fails because:
1. `image` field is required even when registry can derive it
2. A build that produces 0 images silently "succeeds"
3. A deploy-only pipeline gives no guidance about missing build/release steps
4. Environments must be pre-created even when defined in the manifest
5. Secret typos (`GIHUB_TOKEN`) aren't caught with "did you mean?" suggestions

## The Minimal Manifest

This is the canonical starting point for new Eve projects. Every new project should work with just this:

```yaml
schema: eve/compose/v2
project: my-app

registry: "eve"

services:
  app:
    build:
      context: .
    ports: ["3000"]
    x-eve:
      ingress:
        public: true

environments:
  sandbox:
    pipeline: deploy

pipelines:
  deploy:
    steps:
      - name: build
        action: { type: build }
      - name: release
        depends_on: [build]
        action: { type: release }
      - name: deploy
        depends_on: [release]
        action: { type: deploy, env_name: sandbox }
```

**What this declares:**
- One service (`app`), built from the repo root, with a public ingress
- Eve-managed container registry (no GHCR setup, no auth secrets for the registry)
- One environment (`sandbox`) routed through a build→release→deploy pipeline

**What the platform infers:**
- `image: app` — derived from service name since registry is configured
- Environment `sandbox` is auto-created on first deploy
- Ingress hostname: `app.{orgSlug}-my-app-sandbox.{domain}`

**Two commands to deploy:**
```bash
eve project sync --dir .
eve env deploy sandbox --ref main
```

### Growing the manifest

Once the minimal manifest works, developers add complexity incrementally:

```yaml
# Add secrets
x-eve:
  requires:
    secrets: [GITHUB_TOKEN, DATABASE_URL]

# Add a database
services:
  db:
    image: postgres:16
    x-eve:
      role: managed_db
      managed: { class: db.p1 }

# Add staging with approval
environments:
  sandbox:
    pipeline: deploy
  staging:
    pipeline: deploy
    approval: required
```

### Convention: "sandbox" as first environment

All Eve documentation and templates standardize on `sandbox` (not `test`, `staging`, or `dev`) as the first environment a developer deploys to:

- **sandbox** — your personal playground, first deploy target, break-anything space
- **staging** — shared pre-production, may require approval
- **production** — the real thing

---

## Changes

### Phase 1: Shared Library

#### 1A. Auto-derive image names

When a service has `build` but no `image`, and the manifest has a usable registry (`"eve"` or `{ host: ... }`), derive `image` from the service key name.

**`packages/shared/src/schemas/manifest.ts`** — Add after `getBuildableServices` (line 361):

```typescript
/**
 * Returns services with `build` config but no `image` field.
 */
export function getServicesWithBuildButNoImage(manifest: Manifest): Record<string, Service> {
  const services = manifest.services ?? {};
  const result: Record<string, Service> = {};
  for (const [name, service] of Object.entries(services)) {
    if (!service.build || service.image) continue;
    const xEve = service['x-eve'] ?? service.x_eve;
    if (xEve?.external) continue;
    result[name] = service;
  }
  return result;
}

/**
 * Returns true if the manifest has a registry that can receive images.
 */
export function hasUsableRegistry(manifest: Manifest): boolean {
  if (isEveRegistry(manifest)) return true;
  if (isRegistryNone(manifest)) return false;
  return getRegistryConfig(manifest)?.host != null;
}

/**
 * Superset of getBuildableServices that auto-derives image names.
 * Services with `build` but no `image` get `image: <serviceName>`
 * when a usable registry is configured.
 */
export function getBuildableServicesWithDefaults(manifest: Manifest): Record<string, Service> {
  const explicit = getBuildableServices(manifest);
  if (!hasUsableRegistry(manifest)) return explicit;

  const missing = getServicesWithBuildButNoImage(manifest);
  const result = { ...explicit };
  for (const [name, service] of Object.entries(missing)) {
    result[name] = { ...service, image: name };
  }
  return result;
}
```

`getBuildableServices()` is unchanged — backward compatible. Callers opt into the new behavior.

**Tests** (`packages/shared/src/schemas/__tests__/manifest-build-helpers.spec.ts`):
- `build` + no `image` + `registry: "eve"` → included with `image: serviceName`
- `build` + no `image` + `registry: { host: "ghcr.io" }` → included
- `build` + no `image` + `registry: "none"` → excluded
- `build` + no `image` + no registry → excluded
- Explicit `image` → preserved unchanged
- `x-eve.external: true` → still excluded

#### 1B. Levenshtein fuzzy matching

**`packages/shared/src/lib/levenshtein.ts`** (new file):

```typescript
export function levenshteinDistance(a: string, b: string): number { ... }

export function findClosestMatches(
  target: string,
  candidates: Iterable<string>,
  maxDistance = 2,
): string[] { ... }
```

Case-insensitive comparison. Max distance 2 catches `GIHUB_TOKEN` → `GITHUB_TOKEN` (distance 2).

**`packages/shared/src/schemas/secret.ts`** — Add optional `suggestion` to missing item:

```typescript
// existing: { key: string; hints: string[] }
// add:      suggestion?: string  // "Did you mean GITHUB_TOKEN?"
```

**Tests** (`packages/shared/src/lib/__tests__/levenshtein.spec.ts`):
- `GIHUB_TOKEN` vs `GITHUB_TOKEN` → distance 2, matched
- `ANTHROPIC_AP_KEY` vs `ANTHROPIC_API_KEY` → distance 1, matched
- `TOTALLY_DIFFERENT` vs `GITHUB_TOKEN` → distance > 2, not matched

---

### Phase 2: Consumers

#### 2A. Use derived image names in builder

**`apps/worker/src/builder/image-builder.service.ts`**:
- Line 52: `getBuildableServices` → `getBuildableServicesWithDefaults`
- Lines 55–58: When 0 buildable services but services with `build` exist, throw:

```
No buildable services found, but 2 service(s) have `build` config without `image`: app, worker.
Add an `image` field to each service, or configure a `registry` in your manifest.
```

This is a safety net — after 1A, this only fires when registry is absent.

**`apps/worker/src/action-executor/action-executor.service.ts`**:
- Line 263: `getBuildableServices` → `getBuildableServicesWithDefaults`

#### 2B. Pipeline coherence warnings in `manifest validate`

**`packages/shared/src/schemas/manifest.ts`** — Add:

```typescript
export interface ManifestCoherenceWarning {
  code: string;
  message: string;
  severity: 'warning' | 'error';
}

export function analyzeManifestCoherence(manifest: Manifest): ManifestCoherenceWarning[] {
  // 1. Service has `build` but no `image` and no registry → error
  // 2. Pipeline has deploy step with no upstream build/release → warning
  // 3. Environment references nonexistent pipeline → error
}
```

**`apps/api/src/projects/projects.service.ts`** (line ~806):
- Call `analyzeManifestCoherence()` after schema validation
- Merge errors/warnings into response

**Tests** (`packages/shared/src/schemas/__tests__/manifest-coherence.spec.ts`):
- Deploy-only pipeline with buildable services → warning
- Deploy-only pipeline with no buildable services → no warning (pre-built images)
- Service `build` + no `image` + no registry → error
- Environment referencing missing pipeline → error
- Complete build→release→deploy pipeline → clean

#### 2C. Wire fuzzy matching into secret validation

**`apps/api/src/secrets/secrets.service.ts`** — In `validateRequiredSecrets()`:

```typescript
const closest = findClosestMatches(key, availableKeys, 2);
const suggestion = closest.length > 0 ? `Did you mean "${closest[0]}"?` : undefined;
return { key, hints: hints(key), suggestion };
```

**`apps/api/src/projects/projects.service.ts`** (line ~821) — Include suggestion in warning:

```
Missing secret GIHUB_TOKEN. (Did you mean "GITHUB_TOKEN?") eve secrets set GIHUB_TOKEN <value> --project proj_xxx
```

---

### Phase 3: Auto-create environments

**`apps/api/src/environments/environments.service.ts`** — Refactor `deploy()`:

```typescript
async deploy(projectId: string, envName: string, data: DeployRequest) {
  const project = await this.projects.findById(projectId);
  if (!project) throw new NotFoundException(...);

  // Load manifest early — needed for auto-creation and pipeline routing
  const manifestRecord = await this.manifests.findLatestByProject(projectId);
  if (!manifestRecord) throw new NotFoundException('No manifest synced...');
  const manifest: Manifest = yaml.parse(manifestRecord.manifest_yaml);

  // Find or auto-create environment
  let environment = await this.environments.findByProjectAndName(projectId, envName);
  if (!environment) {
    if (manifest.environments?.[envName]) {
      environment = await this.environments.create({
        id: generateEnvironmentId(),
        project_id: projectId,
        name: envName,
        type: 'persistent',
        kind: 'standard',
        namespace: null, db_ref: null,
        overrides_json: manifest.environments[envName].overrides ?? null,
        labels_json: null,
        current_release_id: null,
        last_failed_release_id: null,
      });
      this.logger.log(`Auto-created environment "${envName}" from manifest`);
    } else {
      const defined = Object.keys(manifest.environments ?? {}).join(', ') || 'none';
      throw new NotFoundException(
        `Environment "${envName}" not found. Defined in manifest: ${defined}. ` +
        `Create it with: eve env create ${envName} --project ${projectId}`
      );
    }
  }

  // ... rest of deploy unchanged (suspension check, pipeline routing, etc.)
}
```

This mirrors the `env-ensure` pipeline action but scoped to environments explicitly in the manifest.

---

### Phase 4: Documentation

#### This repo

- Update `examples/fullstack-example/.eve/manifest.yaml` to v2 with `sandbox` environment
- Update `CLAUDE.md` quickstart to use `sandbox` and the minimal manifest
- Update any reference to "test" as the default first environment → `sandbox`

#### eve-skillpacks (`../eve-skillpacks/eve-work/eve-read-eve-docs/references/`)

| File | Changes |
|------|---------|
| `manifest.md` | Replace minimal example with the one above. Document `image` is optional with `build` + registry. Standardize `sandbox`. |
| `builds-releases.md` | Document image auto-derivation. Note 0-artifact builds now fail with guidance. |
| `cli.md` | Document `eve env deploy` auto-creates manifest-defined environments. |
| `deploy-debug.md` | Add first-deploy quickstart section. Update troubleshooting for new error messages. |
| `overview.md` | Update quickstart to use `sandbox` convention. |

#### eve-horizon-starter (`../eve-horizon-starter/.eve/manifest.yaml`)

- Change default environments from `test`/`staging` to `sandbox`/`staging`
- Change registry from GHCR to `registry: "eve"` as default
- Remove explicit `image` fields (let platform derive them)

---

## Verification

1. **Build**: `pnpm install && pnpm build` passes
2. **Unit tests**: `pnpm test` passes — all new tests for levenshtein, manifest helpers, coherence
3. **Scenario: Minimal manifest deploy**
   - Create project with the minimal manifest above
   - `eve project sync --dir .` → succeeds
   - `eve manifest validate --project proj_xxx` → clean (no warnings)
   - `eve env deploy sandbox --ref main` → auto-creates sandbox, triggers pipeline, builds with derived image name
4. **Scenario: Missing image without registry**
   - Manifest with `build` but no `image` and no `registry`
   - `eve manifest validate` → error: "Service 'app' has `build` but no `image` and no registry"
5. **Scenario: Deploy-only pipeline**
   - Pipeline with just a deploy step, services have build config
   - `eve manifest validate` → warning about missing build/release steps
6. **Scenario: Secret typo**
   - `GIHUB_TOKEN` imported, `GITHUB_TOKEN` required
   - `eve manifest validate --strict` → "Missing GITHUB_TOKEN. (Did you mean GIHUB_TOKEN?)"
7. **Scenario: Unknown environment**
   - `eve env deploy staging` when manifest only defines `sandbox`
   - 404: "Environment 'staging' not found. Defined in manifest: sandbox."

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Image auto-derive | Low | `getBuildableServices()` unchanged; new function is opt-in by callers |
| 0-artifact build failure | Low | Only fires when services have `build` but no buildable output |
| Coherence warnings | Low | Additive to validation; only `build_no_image` without registry is an error |
| Env auto-create | Medium | Only creates when manifest explicitly defines the env name; typos still 404 |
| Fuzzy matching | Low | Optional `suggestion` field; max distance 2 avoids false positives |
| `sandbox` convention | Low | Documentation change; no code enforces environment names |
