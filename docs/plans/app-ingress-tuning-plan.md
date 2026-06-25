# App Ingress Tuning Plan (request timeout + max body size)

> **Status**: Implemented and staging-verified on `release-v0.1.287`
> **Last Updated**: 2026-05-18
> **Beads**: `eve-horizon-nque`
> **Origin**: Tenant report — ChivATM `/api/admin/ingest-balances` returns HTTP 504 even though the upstream pod completes the work. The handler downloads ~46 MB CSV from Supabase, runs `COPY` of ~551k rows, dedupe + 3 rollup procs per affected date. Wall time exceeds nginx-ingress's 60s `proxy-read-timeout`. There is no manifest-tenant path to raise it today.
> **Adjacent plans**: [`public-tcp-ingress-plan.md`](./public-tcp-ingress-plan.md) — sibling L4 primitive; this plan is L7-only.

## Implementation review notes

Updated on 2026-05-18 during implementation review:

- Shared validation lives in `packages/shared/src/schemas/ingress-units.ts` and is reused by both manifest fields and platform env vars.
- The worker uses a single `buildIngressAnnotations()` helper to merge cert-manager annotations with nginx timeout/body-size annotations for default-host, alias, and custom-domain Ingresses.
- `eve env diagnose` now includes `.http_ingress[]` rows with requested and effective timeout/body-size values, controller flavour, and whether the request came from the manifest, platform default, unsupported controller, or a missing live Ingress.
- Local verification passed: focused shared ingress tests, focused worker deployer tests, full `@eve/shared` test suite, full `@eve/worker` test suite, and `pnpm build`.
- Staging precheck passed before release: `eve-worker` was running image `public.ecr.aws/w7c4v0w3/eve-horizon/worker:0.1.285`, `EVE_DEFAULT_INGRESS_CLASS=nginx`, and the cluster has `IngressClass/nginx`.
- Staging verification on `release-v0.1.286` surfaced a diagnose RBAC gap: the API service account could not list tenant Ingress resources. The fix adds `networking.k8s.io/ingresses` read access to `eve-api` and lets diagnose infer controller flavour from live Ingress `spec.ingressClassName` when the API runtime itself does not carry `EVE_DEFAULT_INGRESS_CLASS`.
- Staging verification on `release-v0.1.287` passed:
  - publish-images run `26064144380` and infra deploy run `26064292092` succeeded.
  - `https://api.eve.example.com/health` reported version `0.1.287`, git SHA `d33f954`, and both `eve-api` / `eve-worker` were running image tag `0.1.287`.
  - `eve env diagnose proj_example staging --json` no longer emits the Ingress RBAC warning and reports live HTTP ingress values.
  - ChivATM staging was re-rendered by deploying its current release tag (`v0.1.0`) again; the recovery deploy `prun_01krykqj1tf20v9sd2737s00fc` succeeded and `/healthz` returned `{"ok":true}`.
  - The live `staging-web` Ingress now carries `nginx.ingress.kubernetes.io/proxy-read-timeout: "300"`, `nginx.ingress.kubernetes.io/proxy-send-timeout: "300"`, and `nginx.ingress.kubernetes.io/proxy-body-size: "10m"`.
  - Diagnose reports `controller_flavor:"nginx"`, `requested_timeout_seconds:300`, `effective_timeout_seconds:300`, `requested_max_body_size:"10m"`, `effective_max_body_size:"10m"`, and both sources as `platform_default`.
- Verification caveat: the ChivATM admin ingest POST was not run from this platform repo because the required `CHIVATM_ADMIN_TOKEN` and CSV fixture are tenant-app inputs. The platform verification proves the nginx annotations and diagnose behavior; the tenant-specific `timeout: 900s` override and admin endpoint 200 should be validated in the ChivATM repo when applying the tenant manifest change.
- Follow-up found during verification: `eve env reset staging --force` returned ready while namespace deletion was still completing, briefly leaving ChivATM staging without its namespace. Recovery succeeded by redeploying the current release tag. Until the reset race is fixed, use `eve env deploy ... --release-tag <current-tag>` for no-change re-renders in this plan.

## Why

`x-eve.ingress` controls the K8s `Ingress` shape for tenant app services (`apps/worker/src/deployer/deployer.service.ts:1290-1450`). Today the platform sets exactly **one** annotation on those Ingress objects:

```ts
// apps/worker/src/deployer/deployer.service.ts:1330-1333
const annotations: Record<string, string> = {};
if (tlsClusterIssuer) {
  annotations['cert-manager.io/cluster-issuer'] = tlsClusterIssuer;
}
```

Nothing tunes the underlying ingress controller's L7 behaviour. On staging (nginx-ingress), the defaults bite:

- `proxy-read-timeout` / `proxy-send-timeout` = **60 s** → batch/ingest endpoints surface as 504s while the pod actually completes.
- `proxy-body-size` = **1 MB** → any non-trivial JSON or multipart upload is rejected before it reaches the app.

The schema permits no overrides (`packages/shared/src/schemas/manifest.ts:176-189` — `public`, `port`, `alias`, `domains` only). The tenant's only escape hatches are: (a) redesign the endpoint into an Eve job + status poll, or (b) bypass ingress entirely via signed-URL upload to external storage. The current ChivATM workaround uses both, plus client-side "treat 504 as probably-done".

This is a platform gap, not an app bug. Per [[platform-gaps-first]], the fix lives in `eve-horizon`.

## Decision

Add two intent-named, controller-agnostic knobs to `x-eve.ingress`:

1. **`timeout`** — request/response timeout. Single value covers both read and send (asymmetry is rare and can be added later under the same field as an object).
2. **`max_body_size`** — request body size limit.

Both are translated to the ingress controller's native annotations at render time. **Phase 1 ships nginx-ingress only**; Traefik or unknown controller classes are skipped and warned only when a tenant explicitly asks for tuning. Bounds are tight (1s–30m, 1k–1g) so the platform can steer tenants to the right primitive (Eve jobs for batch, signed-URL upload for large payloads) instead of accepting unbounded values.

Two new platform env vars set the default baseline for every tenant Ingress so the cluster-wide default also moves off the painful nginx baseline. Tenant manifest values still win, including lower values inside the allowed range.

### Why intent-named (and not `annotations: { ... }`)

The original ask proposed a passthrough `annotations:` map keyed on raw nginx strings. That was rejected because:

- **Portability**: local k3d runs Traefik; staging runs nginx-ingress. A raw passthrough commits the manifest to one controller.
- **Security**: a tenant-writeable annotation map is an allowlist project forever (every new annotation = a policy decision).
- **Typing**: bounds checks, units, and helpful error messages need real fields.
- **Two knobs solve 95% of cases** — empirically, every reported workaround so far is timeout *or* body size. Asymmetric read/send and keepalive are rare enough to defer.

## Manifest contract

```yaml
services:
  web:
    build: { context: . }
    ports:
      - "3000"
    x-eve:
      ingress:
        public: true
        port: 3000
        timeout: 600s         # request/response timeout. default 300s. range 1s-1800s.
        max_body_size: 100m   # request body limit. default 10m. range 1k-1g.
```

| Field | Type | Default | Range | Notes |
|---|---|---|---|---|
| `timeout` | duration string (`30s` / `5m` / `30m`) | `EVE_DEFAULT_INGRESS_TIMEOUT` (300s) | 1s – 1800s (30 m) | Beyond 30 m → manifest rejected with hint to use Eve jobs. |
| `max_body_size` | byte size string (`100m`, `1g`, `512k`) | `EVE_DEFAULT_INGRESS_MAX_BODY_SIZE` (10m) | 1k – 1g | Beyond 1 g → manifest rejected with hint to use signed-URL upload. |

Units: lowercase only, no spaces. `s|m|h` for durations and `k|m|g` for bytes. The byte validator uses binary thresholds for the bounds and preserves the original unit string for nginx. `h` parses, but the 30m cap means `1h` is rejected with the Eve-jobs hint.

Validation happens during manifest/project validation and deploy render so `eve env deploy` / pipeline steps fail fast with a clear field-path error. `eve env diagnose` is for confirming the live values that landed after a successful deploy, not for surfacing manifest parse failures.

## Platform defaults

Two new env vars in `packages/shared/src/config/schema.ts` (alongside the existing `EVE_DEFAULT_INGRESS_CLASS` at line 78):

| Env var | Default | Purpose |
|---|---|---|
| `EVE_DEFAULT_INGRESS_TIMEOUT` | `300s` | Default for every tenant Ingress when manifest omits `timeout`. |
| `EVE_DEFAULT_INGRESS_MAX_BODY_SIZE` | `10m` | Default for every tenant Ingress when manifest omits `max_body_size`. |

Both values run through the same pure validator as the manifest fields and the same bounds. A misconfigured platform env var fails at API/worker startup with the same error tenants would see. Implement this as defaults in `packages/shared/src/config/schema.ts` (for example `z.string().default('300s')...`) so omission keeps current local/dev manifests simple.

These defaults raise the staging baseline from `60s` / `1m` → `300s` / `10m` immediately on deploy of the platform release tag, provided the worker runtime has `EVE_DEFAULT_INGRESS_CLASS=nginx` or `nginx-ingress`. If staging is missing that env var, add it through Terraform/infra config before relying on the no-manifest-change fix. With that class configured, the platform-default raise fixes the ChivATM-class reports without any manifest change; the new fields let individual services go higher.

## Validation bounds

```ts
// packages/shared/src/schemas/manifest.ts (extend IngressConfigSchema)
const IngressDuration = z.string()
  .regex(/^\d+(s|m|h)$/, 'use a duration like "30s", "5m", or "30m"')
  .refine(s => parseIngressDuration(s) >= 1 && parseIngressDuration(s) <= 1800,
    { message: 'timeout must be between 1s and 30m; for longer work use Eve jobs' });

const IngressByteSize = z.string()
  .regex(/^\d+[kmg]$/, 'use a size like "512k", "10m", or "1g"')
  .refine(s => parseIngressByteSize(s) >= 1024 && parseIngressByteSize(s) <= 1024**3,
    { message: 'max_body_size must be between 1k and 1g; for larger payloads use signed-URL upload to object storage' });

export const IngressConfigSchema = z.object({
  public: z.boolean().optional(),
  port: z.number().optional(),
  alias: z.string().min(3).max(63).regex(IngressAliasPattern).optional(),
  domains: z.array(/* unchanged */).max(10).optional(),
  timeout: IngressDuration.optional(),
  max_body_size: IngressByteSize.optional(),
}).passthrough();
```

`parseIngressDuration` returns seconds. `parseIngressByteSize` returns bytes. Both live in `packages/shared/src/schemas/ingress-units.ts` (new file) and are re-exported.

## Controller dispatch (Phase 1: nginx-ingress only)

Determine the controller flavour from `EVE_DEFAULT_INGRESS_CLASS`. Phase 1 intentionally only applies annotations when the configured class is known to be nginx; if the env var is unset but the cluster default class happens to be nginx, Eve will skip L7 tuning until the class is configured explicitly.

```ts
// apps/worker/src/deployer/deployer.service.ts (new helper near line 2300)
private resolveIngressFlavor(): 'nginx' | 'traefik' | 'unknown' {
  const cls = (config.EVE_DEFAULT_INGRESS_CLASS ?? '').toLowerCase();
  if (cls === 'nginx' || cls === 'nginx-ingress') return 'nginx';
  if (cls === 'traefik') return 'traefik';
  return 'unknown';
}
```

When flavour is `nginx`, resolve `timeout` and `max_body_size` from manifest values or platform defaults, then emit the three annotation pairs onto every tenant Ingress (alias-host, custom-domain, default-host — three call sites listed in Implementation below):

```yaml
metadata:
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"     # seconds, integer
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"     # seconds, integer
    nginx.ingress.kubernetes.io/proxy-body-size: "100m"       # nginx-native units
```

When flavour is `traefik` or `unknown`, emit no L7 annotations. Log a single warn-level message per render only when at least one service explicitly sets `timeout` or `max_body_size` ("ingress tuning requested but controller flavour is X; annotations skipped"). Do not warn merely because platform defaults exist, or local Traefik deploys will become noisy.

## Generated K8s shape (before / after)

**Before** (current, `apps/worker/src/deployer/deployer.service.ts:1337-1370`):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: staging-web
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  rules: [{ host: web.acme-app-staging.eve.example.com, http: { ... } }]
  tls:   [{ hosts: [web.acme-app-staging.eve.example.com], secretName: staging-web-tls }]
```

**After** (with `timeout: 600s, max_body_size: 100m` in manifest, nginx flavour):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: staging-web
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-body-size: "100m"
spec: { ... unchanged ... }
```

## Implementation

| # | File | Lines | Change |
|---|---|---|---|
| 1 | `packages/shared/src/schemas/ingress-units.ts` | new | Export `parseIngressDuration(s) -> seconds`, `parseIngressByteSize(s) -> bytes`. Pure functions, exhaustive tests. |
| 2 | `packages/shared/src/schemas/manifest.ts` | 176-189 | Extend `IngressConfigSchema` with `timeout` + `max_body_size` Zod refinements. Keep `.passthrough()`. |
| 3 | `packages/shared/src/config/schema.ts` | 77-82 | Add `EVE_DEFAULT_INGRESS_TIMEOUT` and `EVE_DEFAULT_INGRESS_MAX_BODY_SIZE` with defaults `300s` / `10m`. Validate via the same pure helpers as (1); helpers must not import config or manifest schemas. |
| 4 | `apps/worker/src/deployer/deployer.service.ts` | 1290-1293 | Read the two new env vars alongside the existing four. |
| 5 | `apps/worker/src/deployer/deployer.service.ts` | new methods near 2300 | Add `resolveIngressFlavor()`, `hasExplicitIngressTuning()`, `buildIngressAnnotations()`, and shared Zod issue formatting. Explicit manifest values override platform defaults; invalid explicit values throw with the service path and offending value. |
| 6 | `apps/worker/src/deployer/deployer.service.ts` | 1330-1343 | Default-host ingress: merge tuning annotations into the `annotations` map when flavour is nginx. |
| 7 | `apps/worker/src/deployer/deployer.service.ts` | 1384-1400 | Custom-domain ingress: same. |
| 8 | `apps/worker/src/deployer/deployer.service.ts` | ~1444-1500 | Alias ingress: same. (Mirror the change.) |
| 9 | `apps/worker/src/deployer/deployer.service.ts` | render entry (~945) | When flavour is not `nginx` and any service explicitly sets a tuning field, log one structured warn per render with `orgId/projectId/envName/flavour`. Platform defaults alone must not warn. |
| 10 | `apps/worker/src/deployer/__tests__/deployer-ingress-tuning.spec.ts` | new | Snapshot tests: nginx flavour + custom timeout/body → annotations present; missing fields → platform defaults applied; traefik flavour → annotations skipped; out-of-range manifest → render throws with helpful message. |
| 11 | `packages/shared/src/schemas/__tests__/ingress-units.spec.ts` | new | Unit table for duration/byte parsers — happy paths, regex rejections (`30S`, `1023b`, `1g+1`), and range edges (`0s`, `1s`, `1800s`, `1801s`; `0k`, `1k`, `1g`, `1025m`). |
| 12 | `k8s/base/worker-deployment.yaml`, `packages/cli/assets/local-k8s/base/worker-deployment.yaml` | env block | Explicitly inject the two new env vars only if we want visible defaults in manifests; config-schema defaults are sufficient. Do not add orchestrator env unless it actually reads these values. |
| 13 | `packages/shared/src/schemas/environment.ts` | env diagnose schema | Add an HTTP ingress diagnostic shape with service, host(s), controller flavour, effective timeout/body-size, and the source (`manifest`, `platform_default`, or `unsupported_controller`). |
| 14 | `apps/api/src/environments/env-diagnostics.service.ts` | diagnose service | Add `NetworkingV1Api`; combine the latest manifest with live Ingress resources/annotations so tenants can see both requested values and what actually landed. Keep TCP ingress diagnostics separate. |
| 15 | `packages/cli/src/commands/env.ts` | `EnvDiagnoseResponse` + formatter | Add an `HTTP Ingress` section/table for the new diagnose response fields. |
| 16 | `docs/system/manifest.md`, `docs/system/deployment.md` | docs | Add `timeout` and `max_body_size` rows, a short example, platform env vars, and the nginx-only caveat. |
| 17 | Skillpacks docs | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` (~ingress table around line 420-446) | Add `timeout` and `max_body_size` rows + a short example. |
| 18 | Skillpacks docs | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/deploy-debug.md` (Ingress TLS section, ~line 234) | New subsection "Ingress timeouts and body size" documenting the manifest fields, platform env vars, and the Traefik caveat. |
| 19 | Platform CLAUDE.md update log | `CLAUDE.md` | One-line entry under Update Log on the release date. |

Total: ~120 LOC of TypeScript + ~150 LOC of tests + docs.

## Verification loop — local (fast, fixture-based)

The bug only reproduces with a live nginx-ingress controller, but the *rendering* of the right K8s YAML can be verified offline. This is the fast inner loop for every code change.

```bash
# From repo root.
pnpm install
pnpm --filter @eve/shared build
pnpm --filter @eve/shared test         # ingress-units parser tests
pnpm --filter @eve/worker test          # deployer snapshot tests
pnpm build                              # full graph type-check
```

The new `deployer-ingress-tuning.spec.ts` asserts, for each ingress type (default host, custom domain, alias) and each flavour (nginx, traefik, unknown):

- Manifest with explicit `timeout: 600s, max_body_size: 100m` and `EVE_DEFAULT_INGRESS_CLASS=nginx` → emits all three `nginx.ingress.kubernetes.io/proxy-*` annotations with exactly the right values.
- Manifest with no tuning fields, `EVE_DEFAULT_INGRESS_TIMEOUT=300s` → annotations show `"300"` / `"10m"`.
- Manifest with `timeout: 3600s` → deploy/render fails with the "max 30m" message before any Ingress is applied.
- `EVE_DEFAULT_INGRESS_CLASS=traefik` + explicit tuning fields present → no nginx annotations emitted; one warn log captured. Traefik with only platform defaults emits no warning.

Loop time: ~10s per `pnpm --filter @eve/worker test` run. Acceptable for TDD on the render shape.

## Verification loop — staging (slow, authoritative)

The actual proof that `proxy-read-timeout` does what we expect requires a real nginx-ingress controller. Staging runs nginx-ingress and already has the failing ChivATM endpoint deployed, which makes it the natural fixture.

### Preconditions

- You are the staging owner: `./bin/eh status` shows `staging_owner: true` (`admin@example.com`).
- Authenticated against staging:
  ```bash
  eve profile use staging
  eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519
  eve system health --json   # must return {"status":"ok"}
  ```
- Latest `release-v*` tag is what's currently deployed:
  ```bash
  STAGING_KUBECONFIG=../deployment-instance/config/kubeconfig.yaml
  STAGING_CONTEXT=<explicit-eks-context>

  git tag --list 'release-v*' --sort=-version:refname | head -1
  kubectl --kubeconfig "$STAGING_KUBECONFIG" --context "$STAGING_CONTEXT" \
      -n eve get deploy eve-worker \
      -o jsonpath='{.spec.template.spec.containers[0].image}'
  kubectl --kubeconfig "$STAGING_KUBECONFIG" --context "$STAGING_CONTEXT" \
      -n eve get deploy eve-worker \
      -o jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="EVE_DEFAULT_INGRESS_CLASS")]}{.value}{end}'
  # Expect nginx or nginx-ingress. If empty, fix through Terraform/infra config first.
  ```
- All staging `kubectl` checks must use that kubeconfig plus the explicit `<explicit-eks-context>` context. Do not use `~/.kube/eve-hosted.yaml` or an implicit current context.

### Step 1 — Establish the failing baseline

```bash
# Baseline: confirm the user-reported 504 still happens with default 60s.
curl -i --max-time 700 -X POST \
  https://web.aderiz-chivatm-staging.eve.example.com/api/admin/ingest-balances \
  -H "Authorization: Bearer $CHIVATM_ADMIN_TOKEN" \
  -F "csv=@/path/to/balances.csv"
# Expect: HTTP/2 504 after ~60s (current state).
```

Also inspect the current Ingress on staging so you have the pre-state to diff against:

```bash
kubectl --kubeconfig "$STAGING_KUBECONFIG" --context "$STAGING_CONTEXT" \
  -n eve-aderiz-chivatm-staging get ingress -o yaml | \
  grep -E 'name:|nginx\.ingress|cluster-issuer'
# Expect: only cert-manager.io/cluster-issuer annotation present.
```

### Step 2 — Cut the platform release tag with the fix

```bash
# Compute the next version.
LAST=$(git tag --list 'release-v*' --sort=-version:refname | head -1)
NEXT="release-v$(echo $LAST | sed -E 's/release-v//' | awk -F. '{print $1"."$2"."$3+1}')"
echo "Tagging $NEXT"

git tag "$NEXT"
git push origin "$NEXT"
gh run watch --exit-status              # publish-images.yml
# Then verify the dispatch landed in the infra repo:
gh run list --repo example-org/deployment-instance --workflow deploy.yml --limit 1
gh run watch --repo example-org/deployment-instance --exit-status
```

The platform now has the new env vars wired and the deployer code in place. **Before any manifest change**, baseline-check the new platform defaults:

```bash
# Trigger a no-op redeploy of ChivATM staging to pick up the new defaults.
# Prefer deploy over reset here: reset can race namespace deletion on persistent
# envs and briefly remove the namespace after reporting success.
eve env deploy staging --project <chivatm-project-id> \
  --release-tag <current-release-tag> \
  --skip-preflight \
  --timeout 300
# After rollout:
kubectl --kubeconfig "$STAGING_KUBECONFIG" --context "$STAGING_CONTEXT" \
  -n eve-aderiz-chivatm-staging get ingress -o yaml | \
  grep -E 'proxy-read-timeout|proxy-send-timeout|proxy-body-size'
# Expect:
#   nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
#   nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
#   nginx.ingress.kubernetes.io/proxy-body-size:   "10m"
```

Re-run the curl from Step 1. **Expectation**: the endpoint either succeeds (if the real wall time is <300s) or still 504s but at the new 300s deadline. Either way, the platform-default raise is confirmed.

### Step 3 — Tenant manifest override

Edit ChivATM's `.eve/manifest.yaml`:

```yaml
services:
  web:
    x-eve:
      ingress:
        public: true
        port: 3000
        timeout: 900s         # 15 minutes
        max_body_size: 100m
```

Push + redeploy:

```bash
cd /path/to/chivatm
git add .eve/manifest.yaml
git commit -m "chore: raise ingress timeout for ingest endpoint"
git push
eve env deploy staging --project <chivatm-project-id> --ref <new-commit-sha>
eve env diagnose <chivatm-project-id> staging   # confirm new values surface in diagnose
```

Then:

```bash
kubectl --kubeconfig "$STAGING_KUBECONFIG" --context "$STAGING_CONTEXT" \
  -n eve-aderiz-chivatm-staging get ingress -o yaml | \
  grep -E 'proxy-read-timeout|proxy-body-size'
# Expect:
#   nginx.ingress.kubernetes.io/proxy-read-timeout: "900"
#   nginx.ingress.kubernetes.io/proxy-body-size:   "100m"
```

### Step 4 — Prove the end-to-end fix

```bash
time curl -i --max-time 1000 -X POST \
  https://web.aderiz-chivatm-staging.eve.example.com/api/admin/ingest-balances \
  -H "Authorization: Bearer $CHIVATM_ADMIN_TOKEN" \
  -F "csv=@/path/to/balances.csv"
# Expect: HTTP/2 200 with the real response body and wall time matching the pod's
# completion time (look for the "[admin/ingest-balances] removed N objects" log
# line — that's the last log emitted before res.json()).
```

Cross-check against pod logs:

```bash
eve env logs staging web --project <chivatm-project-id> --since 600 | \
  grep '\[admin/ingest-balances\] removed'
# One log line per successful request. No retries, no 504s upstream.
```

### Step 5 — Negative path: bounds enforced

Push a deliberately-bad manifest to confirm validation rejects it:

```yaml
x-eve:
  ingress:
    timeout: 2h        # > 30m cap
```

```bash
eve env deploy staging --project <chivatm-project-id> --ref <bad-commit-sha>
# Expect deploy job to fail with:
#   x-eve.ingress.timeout: timeout must be between 1s and 30m;
#   for longer work use Eve jobs
eve job diagnose <deploy-job-id>
```

Revert. Same test for `max_body_size: 5g` — expect rejection with the signed-URL hint.

### Step 6 — Rollback rehearsal

```bash
# Set the manifest back to no overrides.
git revert <manifest-override-commit>
git push
eve env deploy staging --project <chivatm-project-id> --ref <revert-commit-sha>
kubectl --kubeconfig "$STAGING_KUBECONFIG" --context "$STAGING_CONTEXT" \
  -n eve-aderiz-chivatm-staging get ingress -o yaml | \
  grep proxy-read-timeout
# Expect: "300" (platform default), not "900".
# Confirms the override is properly removable.
```

## Acceptance criteria

- `pnpm test` green across `@eve/shared` and `@eve/worker`, including new snapshot tests.
- Manifest with valid `timeout` + `max_body_size` deploys to staging and the rendered Ingress carries all three nginx annotations with exact values.
- ChivATM ingest endpoint returns 200 with `timeout: 900s` (Step 4).
- Out-of-range manifest is rejected at `eve env deploy` time with the hint message (Step 5).
- Platform default (300s) applied to every tenant Ingress on staging after the release tag, with no manifest changes.
- Traefik clusters: no annotations emitted, one warn log per render only when tuning is explicitly requested. Local k3d `./bin/eh k8s deploy` of a fixture project confirms no regression in the existing alias/custom-domain/default-host Ingress shapes.
- `docs/system/manifest.md`, `docs/system/deployment.md`, skillpacks `manifest.md`, and skillpacks `deploy-debug.md` updated; `CLAUDE.md` update-log entry added on the release date.

## Non-goals

- **Traefik / non-nginx controllers.** Phase 1 explicitly skips. Adding Traefik support means a Middleware CRD + annotation reference; defer until there's a real non-nginx production cluster.
- **Asymmetric read/send.** `timeout` sets both. If anyone actually needs independent read vs send (vanishingly rare), promote `timeout` to `timeout: { read, send }` later — Zod can accept both shapes via `z.union`.
- **WebSocket / SSE-specific knobs.** `proxy-read-timeout` covers SSE in practice. `nginx.ingress.kubernetes.io/proxy-http-version` and keepalive tuning are not in this plan.
- **Per-domain overrides.** All three Ingress objects for a service (alias, custom-domain, default-host) share the same tuning. Custom domains can split later if needed.
- **Raising platform defaults beyond 300s / 10m.** Tenants should opt in for higher; the default stays sane.
- **Allowing an arbitrary annotation map.** Explicitly rejected in Decision.

## Risks and follow-ups

- **Worker saturation.** Long timeouts × many concurrent requests → nginx-ingress worker connections exhausted. Mitigation: 30m cap, tight default, log all overrides for cost/ops visibility (`structured.warn` at deploy with `orgId/projectId/envName/timeout`).
- **Default raise from 60s → 300s.** Apps that today rely on the early 504 as a client-side "give up" signal will see longer hangs. Mitigation: documented in skillpacks; tenants can pin `timeout: 60s` explicitly. No known dependencies on the 60s behaviour internally.
- **Drift between k3d (Traefik) and staging (nginx-ingress).** This plan does not fix it. Follow-up issue: either swap k3d to nginx-ingress in `bin/eh-commands/k8s.sh:182-196` or add Traefik translation in Phase 2. Track as `eve-horizon` issue once this lands.
- **Validation message quality.** Error must include the actual offending value, the field path, and the suggested alternative primitive. Zod's default messages are terse; the `.refine` messages in this plan are bespoke for this reason.
- **Pipeline step backward compat.** Manifest with new fields parsed by an older worker → fields ignored (passthrough). Old manifest parsed by new worker → defaults applied. Both directions safe.

## Docs to update

- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/manifest.md` (ingress field table, ~line 420-446). Two new rows + a one-block example.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/deploy-debug.md` (~line 234, after the TLS subsection). New subsection: "Ingress timeouts and body size" — manifest fields, platform env vars, controller caveat.
- `docs/system/manifest.md` (Eve extensions ingress row + example). Mirror the same manifest contract in repo docs.
- `docs/system/deployment.md` (Ingress routing/TLS area). Document platform defaults, nginx-only Phase 1, and diagnose confirmation.
- `CLAUDE.md` (Update Log entry on the release date).

## See also

- `apps/worker/src/deployer/deployer.service.ts:1290-1450` — ingress render
- `packages/shared/src/schemas/manifest.ts:176-189` — current IngressConfigSchema
- `packages/shared/src/config/schema.ts:77-82` — existing ingress env vars
- `bin/eh-commands/k8s.sh:182-196` — k3d cluster create (Traefik default; not modified by this plan)
- nginx-ingress annotation reference: https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/
