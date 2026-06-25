# App Object Bucket Credentials & Staging Config Plan

> **Status**: Draft
> **Last Updated**: 2026-05-05
> **Origin**: Eve Horizon gap **0012** (object-store buckets) was implemented and shipped in `release-v0.1.268` (commit `f1c2a4ef`, "fix: align deploy manifest hashes and app buckets"). When PR #7 of the gap-tracking app re-tested against staging, deploy still fails with `"Eve object storage is not configured"`. Root cause: the platform code is in place, but the staging infra repo (`../deployment-instance`) never grew the worker-side `EVE_STORAGE_*` provisioning configuration, and there is no app-bucket credential path that works for app pods (which do not run under IRSA today).
> **Verification source**: `apps/worker/src/deployer/deployer.service.ts:1992-2026`, `apps/worker/src/deployer/bucket-provisioner.ts:25-37`, `packages/shared/src/storage/create-storage-client.ts:73-92`, `../deployment-instance/k8s/overlays/aws-eks/worker-deployment-patch.yaml` (no `EVE_STORAGE_*`), `../deployment-instance/k8s/overlays/aws-eks/api-deployment-patch.yaml:44-51` (api has storage config), `../deployment-instance/k8s/overlays/aws-eks/agent-runtime-deployment-patch.yaml:57-64` (runtime has storage config), `../deployment-instance/terraform/aws/main.tf:382-447` (`api_storage` IAM policy covers `demo-eve-org-*`).

## Problem Statement

`x-eve.object_store.buckets` is accepted by the manifest schema, validated, and the deployer (`resolveObjectStoreBuckets` in `deployer.service.ts`) is wired to create buckets per environment, set policies, and inject env vars into app pods. The code path is exercised on local k3d (with MinIO) and is covered by `deployer-object-store-buckets.spec.ts`.

On staging it fails before doing anything useful, and the first draft of this plan had one dangerous shortcut:

1. **Worker has no storage config.** `worker-deployment-patch.yaml` does not set `EVE_STORAGE_BACKEND`, so `BucketProvisioner.isConfigured` is `false` and `resolveObjectStoreBuckets` throws `Eve object storage is not configured`. API and agent-runtime patches *do* set `EVE_STORAGE_BACKEND`, `EVE_STORAGE_REGION`, `EVE_STORAGE_INTERNAL_BUCKET`, `EVE_STORAGE_ORG_BUCKET_PREFIX`. The worker overlay was never updated when 0012 shipped.
2. **No app-bucket credential path.** Even after fix 1, the deployer requires `EVE_STORAGE_ACCESS_KEY_ID` and `EVE_STORAGE_SECRET_ACCESS_KEY` env vars to inject into the app pod (lines 2013-2026). On staging the platform components rely on **IRSA** (`example-api-irsa`) -- there are no static keys anywhere. The deployer would throw `app storage env injection is incomplete. Missing: EVE_STORAGE_ACCESS_KEY_ID, EVE_STORAGE_SECRET_ACCESS_KEY`. App pods run under the namespace `default` SA with no IAM annotation, so they cannot use IRSA without further platform work.
3. **App credentials must not be mounted as provisioner credentials.** `createStorageClient` uses explicit `EVE_STORAGE_ACCESS_KEY_ID` / `EVE_STORAGE_SECRET_ACCESS_KEY` when present. If the worker mounts app keys under those names, the worker stops using IRSA and starts using the app IAM user for bucket creation, CORS, and public policy updates. Either that app user lacks admin actions and deploy fails, or it gets admin actions and every app receives bucket-admin credentials. The fix must separate worker provisioner config (`EVE_STORAGE_*`) from app-facing credentials (`EVE_APP_STORAGE_*`).
4. **The current app-bucket prefix is too broad for shared app credentials.** `getAppBucketName` currently builds app buckets from `EVE_STORAGE_ORG_BUCKET_PREFIX`, so a policy scoped to `demo-eve-org-*` would also match org filesystem buckets (`demo-eve-org-{orgSlug}`). The staging stopgap needs a distinct app bucket prefix, for example `EVE_STORAGE_APP_BUCKET_PREFIX=demo-eve-app`, before any shared app IAM key is safe enough to ship.

The result: object-store buckets are advertised as a shipped feature, accepted by manifest validation, listed under "App Object Buckets" in `docs/system/object-store-and-org-filesystem.md`, but cannot be deployed on staging or in any IRSA-only AWS environment. Local k3d works because the base worker overlay defines MinIO static keys. Staging must keep the worker on IRSA for provisioning, use a distinct app-bucket prefix, and inject a separate app-facing key into deployed app pods.

## Goals

- A user who declares `x-eve.object_store.buckets` in a manifest and runs `eve env deploy` against staging can deploy successfully and the deployed app receives working bucket credentials.
- The worker keeps using IRSA for provisioning (`CreateBucket`, CORS, public bucket policy) and never needs static app credentials for those admin actions.
- The app credential-injection path is honest about its trust model: the staging stopgap uses one shared app IAM principal scoped to a distinct app-bucket namespace (`demo-eve-app-*`), not per-app isolation.
- Local k3d (MinIO) and staging (S3 + EKS) follow the same code path; environment-specific differences are limited to env vars, not branches in code.
- Re-running gap-0012 manual test against staging passes end-to-end using shipped surfaces: bucket created, env vars injected, app pod can `PutObject`/`GetObject`, and `eve env diagnose` lists the buckets.

## Non-Goals

- Building a generic per-app IAM role provisioner that creates and tears down a role per (org, project, env). That is the right long-term shape but not in this plan.
- Adding lifecycle policies, retention rules, replication, or quota enforcement on app buckets.
- Enforcing cross-app or cross-tenant bucket isolation under the shared static-key stopgap. Option A prevents access outside the app-bucket namespace, but any app with the shared key can access any bucket covered by `demo-eve-app-*`.
- Adding planned app-store debug APIs or CLI commands (`store/buckets`, `store/url`, `store/ls`). Verification should use `eve env diagnose`, pod env inspection, and S3 client operations instead.
- Changing manifest schema beyond what is necessary to support an IRSA-friendly mode.
- Backfilling buckets for projects deployed before this lands.

---

## Current Code Pointers

| Concern | File | Lines |
| --- | --- | --- |
| Bucket provisioning entrypoint | `apps/worker/src/deployer/deployer.service.ts` | `resolveObjectStoreBuckets` 1981-2102 |
| Current app env injection | `apps/worker/src/deployer/deployer.service.ts` | 2007-2034 |
| `isConfigured` decision | `apps/worker/src/deployer/bucket-provisioner.ts` | 25-37 |
| Storage client factory | `packages/shared/src/storage/create-storage-client.ts` | 73-92 |
| Worker overlay (staging) | `../deployment-instance/k8s/overlays/aws-eks/worker-deployment-patch.yaml` | full file (no `EVE_STORAGE_*`) |
| API/runtime overlays (reference) | `../deployment-instance/k8s/overlays/aws-eks/api-deployment-patch.yaml` | 44-51 |
| Worker SA + IRSA | `../deployment-instance/k8s/overlays/aws-eks/worker-serviceaccount-patch.yaml` | full file |
| IRSA storage policy | `../deployment-instance/terraform/aws/main.tf` | `api_storage` 382-447 (covers `demo-eve-org-*`) |
| App-bucket name pattern | `apps/worker/src/deployer/bucket-provisioner.ts` | `getAppBucketName` 87-94 |
| Org-bucket name pattern | `apps/worker/src/deployer/bucket-provisioner.ts` | `getOrgBucketName` 77-80 |
| Diagnostics surfacing | `apps/api/src/environments/env-diagnostics.service.ts` | `storage_buckets` 449+ |
| Diagnostics schema | `packages/shared/src/schemas/environment.ts` | `EnvStorageBucketInfoSchema` 210-216 (no status field) |
| Docs | `docs/system/object-store-and-org-filesystem.md` | 722-757 |
| Manual scenario drift | `tests/manual/scenarios/26-object-store.md` | Step 10 claims per-env keys; Step 11 references planned store APIs |

App buckets currently follow the pattern `{EVE_STORAGE_ORG_BUCKET_PREFIX}-{orgSlug}-{projectSlug}-{envName}-{bucketName}`. With staging's `EVE_STORAGE_ORG_BUCKET_PREFIX=demo-eve-org`, this resolves to `demo-eve-org-*`, the same namespace used by org filesystem buckets. That is acceptable for the worker's IRSA admin policy, but too broad for shared app credentials. Phase 1 adds `EVE_STORAGE_APP_BUCKET_PREFIX` so staging can move app buckets to `demo-eve-app-*`; Phase 2 extends the worker IRSA policy to provision that prefix.

---

## Decision: Credentials Strategy

We must pick how the **app pod** authenticates to S3. The deployer currently injects `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` from worker env vars. Three options:

### Option A — Shared app IAM user (static keys), separate `EVE_APP_STORAGE_*`

- One IAM user, one access key pair, scoped via inline policy to `arn:aws:s3:::demo-eve-app-*` (a distinct app bucket prefix, not the org filesystem prefix).
- Keys stored as a K8s Secret; worker mounts them as `EVE_APP_STORAGE_ACCESS_KEY_ID` / `EVE_APP_STORAGE_SECRET_ACCESS_KEY`; deployer injects them into every app that declares buckets.
- Deployer resolves app-facing env vars with this precedence:
  - endpoint: `EVE_APP_STORAGE_PUBLIC_ENDPOINT` or `EVE_APP_STORAGE_ENDPOINT`, falling back to `EVE_STORAGE_PUBLIC_ENDPOINT` or `EVE_STORAGE_ENDPOINT`
  - region: `EVE_APP_STORAGE_REGION`, falling back to `EVE_STORAGE_REGION`
  - credentials: `EVE_APP_STORAGE_ACCESS_KEY_ID` / `EVE_APP_STORAGE_SECRET_ACCESS_KEY`, falling back to `EVE_STORAGE_ACCESS_KEY_ID` / `EVE_STORAGE_SECRET_ACCESS_KEY` for local MinIO compatibility only
- The AWS worker overlay must not mount `EVE_STORAGE_ACCESS_KEY_ID` / `EVE_STORAGE_SECRET_ACCESS_KEY`; leaving them unset lets the S3 SDK use IRSA for provisioning.
- **Pros**: small code change, preserves the worker's IRSA path, app key can omit `CreateBucket`, `PutBucketCors`, and `PutBucketPolicy`.
- **Cons**: blast radius -- every app on the deployment shares one IAM principal that can read/write every other app bucket under `demo-eve-app-*`. A compromised app pod can list/delete bucket contents for any tenant on that deployment. Static keys also live in Terraform state and app pod env.

### Option B — Per-app IRSA (per env)

- During deploy, create (or reuse) a K8s ServiceAccount in the app's namespace, annotated with an IAM role ARN scoped to that app's bucket(s).
- The IAM role is provisioned dynamically (Terraform-managed pool, or platform-owned IAM API call) when the env is first deployed, torn down on `env delete`.
- Deployer is extended with a flag (`EVE_APP_BUCKET_AUTH_MODE=irsa`) that, when set, **skips** the static-key injection and instead annotates the app pod's SA.
- **Pros**: tight scope per app; matches platform-wide IRSA pattern; no static keys.
- **Cons**: significant new code in deployer (pod SA management, role lifecycle, namespace SA creation); needs Terraform module or platform-managed IAM SDK calls; more moving parts to debug.

### Option C — Per-app IAM user (Terraform-managed pool)

- Hybrid: still static keys, but a *unique* IAM user per (org, project, env), scoped to that app's bucket prefix only.
- Same code path as Option A on the deployer side (still injects keys), but provisioning is dynamic.
- **Pros**: per-app isolation without new SA / IRSA plumbing in the deployer.
- **Cons**: dynamic IAM user creation from the worker is awkward (IAM API needs admin perms on the worker), key rotation is harder, IAM has account-wide limits on user count (5000 default).

### Recommendation

**Option B (per-app IRSA)** is the right destination but is too much for closing 0012. **Ship Option A first with separate `EVE_APP_STORAGE_*` inputs and a distinct app-bucket prefix** (a single platform-wide app-bucket IAM user, scoped only to `demo-eve-app-*`), document its trust model honestly, and keep Option B as the next plan. Justification:

- Option A is one small deployer change, one Terraform resource set, and one secret mount on the worker. It unblocks the gap test today.
- Tenant blast-radius concern is real and must be documented as a staging stopgap. Option A is not a production-grade multi-tenant isolation boundary.
- Separating `EVE_STORAGE_*` and `EVE_APP_STORAGE_*` avoids the main foot-gun: app credentials must not override the worker's IRSA credentials.
- Option B becomes a follow-up plan once the user-facing flow is unblocked and we have telemetry about real bucket usage.

---

## Phased Plan

### Phase 1 — Separate app credentials and app bucket prefix (eve-horizon-2)

**Where**: `apps/worker/src/deployer/deployer.service.ts`, `apps/worker/src/deployer/bucket-provisioner.ts`, `apps/worker/src/deployer/__tests__/deployer-object-store-buckets.spec.ts`, optionally `packages/shared/src/config/schema.ts`

Add an app-storage env resolver inside `resolveObjectStoreBuckets` so the worker can keep `EVE_STORAGE_*` for provisioner config while injecting app credentials from `EVE_APP_STORAGE_*`.

Expected resolution:

```ts
const publicEndpoint =
  process.env.EVE_APP_STORAGE_PUBLIC_ENDPOINT ??
  process.env.EVE_APP_STORAGE_ENDPOINT ??
  process.env.EVE_STORAGE_PUBLIC_ENDPOINT ??
  process.env.EVE_STORAGE_ENDPOINT ??
  '';
const region =
  process.env.EVE_APP_STORAGE_REGION ??
  process.env.EVE_STORAGE_REGION ??
  'us-east-1';
const accessKeyId =
  process.env.EVE_APP_STORAGE_ACCESS_KEY_ID ??
  process.env.EVE_STORAGE_ACCESS_KEY_ID ??
  '';
const secretAccessKey =
  process.env.EVE_APP_STORAGE_SECRET_ACCESS_KEY ??
  process.env.EVE_STORAGE_SECRET_ACCESS_KEY ??
  '';
```

Keep `BucketProvisioner`'s client construction unchanged: it should continue to construct its storage client from `EVE_STORAGE_*`. For S3 staging, that means no explicit access key is supplied and the AWS SDK uses IRSA. For local MinIO, the fallback keeps the current static `EVE_STORAGE_*` behavior working.

Change only the app bucket *name* prefix in `BucketProvisioner.getAppBucketName`:

```ts
const appPrefix =
  process.env.EVE_STORAGE_APP_BUCKET_PREFIX ??
  process.env.EVE_STORAGE_ORG_BUCKET_PREFIX ??
  'eve-org';
return `${appPrefix}-${orgSlug}-${projectSlug}-${envName}-${bucketName}`;
```

Keep `getOrgBucketName` on `EVE_STORAGE_ORG_BUCKET_PREFIX`; org filesystem buckets must not move. Local k3d can omit `EVE_STORAGE_APP_BUCKET_PREFIX` and preserve the existing `eve-org-...` app bucket names until local manifests are intentionally changed.

Update the incomplete-injection error to name both accepted credential families, for example:

> Missing app storage credentials: set `EVE_APP_STORAGE_ACCESS_KEY_ID` / `EVE_APP_STORAGE_SECRET_ACCESS_KEY` on the worker (or `EVE_STORAGE_*` for local MinIO).

Acceptance:

- Unit test covers local fallback: only `EVE_STORAGE_ACCESS_KEY_ID` / `EVE_STORAGE_SECRET_ACCESS_KEY` set, app receives `STORAGE_*`.
- Unit test covers AWS shape: `EVE_STORAGE_BACKEND=s3`, no `EVE_STORAGE_ACCESS_KEY_ID`, `EVE_APP_STORAGE_ACCESS_KEY_ID` set; app receives `STORAGE_*` and provisioner config remains IRSA-compatible.
- Unit test covers `EVE_STORAGE_APP_BUCKET_PREFIX=demo-eve-app` and verifies physical app bucket names no longer use `EVE_STORAGE_ORG_BUCKET_PREFIX`.
- Unit test covers missing app credentials and asserts the error points at `EVE_APP_STORAGE_*`.

### Phase 2 — Worker storage env + app-prefix IRSA policy (infra)

**Where**: `../deployment-instance/k8s/overlays/aws-eks/worker-deployment-patch.yaml`, `../deployment-instance/terraform/aws/main.tf`

Mirror the API patch's storage block on the worker, add a distinct app bucket prefix, and add a public endpoint for app env injection. After this, `BucketProvisioner.isConfigured` is true on staging and bucket creation/CORS/policy setup works through the worker's existing `example-api-irsa` SA.

```yaml
- name: EVE_STORAGE_BACKEND
  value: "s3"
- name: EVE_STORAGE_REGION
  value: "eu-west-1"
- name: EVE_STORAGE_ORG_BUCKET_PREFIX
  value: "demo-eve-org"
- name: EVE_STORAGE_APP_BUCKET_PREFIX
  value: "demo-eve-app"
- name: EVE_STORAGE_INTERNAL_BUCKET
  value: "demo-eve-internal"
- name: EVE_STORAGE_PUBLIC_ENDPOINT
  value: "https://s3.eu-west-1.amazonaws.com"
```

In Terraform, add `local.storage_app_bucket_prefix = "${var.name_prefix}-eve-app"` and extend the worker/API IRSA storage policy with the same bucket-admin actions currently granted to `OrgBuckets`, but scoped to `${local.storage_app_bucket_prefix}-*`. Keep org filesystem access on `${local.storage_org_bucket_prefix}-*`.

Do not set `EVE_STORAGE_ACCESS_KEY_ID` or `EVE_STORAGE_SECRET_ACCESS_KEY` in the AWS worker overlay.

Acceptance: `kubectl -n eve set env deploy/eve-worker --list | grep EVE_STORAGE_` shows the six non-secret storage vars and no static `EVE_STORAGE_*` credentials; `aws iam simulate-principal-policy` for `example-api-irsa` allows `s3:CreateBucket`, `s3:PutBucketCors`, and `s3:PutBucketPolicy` on `demo-eve-app-*`; an app deploy that declares one private bucket gets past the `not configured` error and now fails with the next error (`missing EVE_APP_STORAGE_ACCESS_KEY_ID` / `EVE_APP_STORAGE_SECRET_ACCESS_KEY`) until Phase 4 lands.

### Phase 3 — App-bucket IAM user + secret (Terraform)

**Where**: `../deployment-instance/terraform/aws/main.tf` (or new file `app-bucket-credentials.tf`)

1. New `aws_iam_user "app_buckets"` (e.g. `demo-app-buckets`), guarded with the same EKS count/condition used by the IRSA resources.
2. Inline policy scoped to `arn:aws:s3:::${local.storage_app_bucket_prefix}-*` and `arn:aws:s3:::${local.storage_app_bucket_prefix}-*/*`, split by bucket-level and object-level actions:
   - bucket-level: `s3:ListBucket`, `s3:GetBucketLocation`, `s3:ListBucketMultipartUploads`
   - object-level: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts`
   - intentionally not allowed: `s3:CreateBucket`, `s3:PutBucketCors`, `s3:PutBucketPolicy`, `s3:DeleteBucket`
3. `aws_iam_access_key "app_buckets"`.
4. `kubernetes_secret "eve_app_storage"` in namespace `eve` with `EVE_APP_STORAGE_ACCESS_KEY_ID` and `EVE_APP_STORAGE_SECRET_ACCESS_KEY`.
5. Outputs: non-sensitive access key ID and a hash/fingerprint only; never output the secret access key.

Acceptance: secret exists in cluster; `aws iam simulate-principal-policy` confirms the user can do `s3:PutObject` on `arn:aws:s3:::demo-eve-app-foo/probe.txt`, can `s3:ListBucket` on `arn:aws:s3:::demo-eve-app-foo`, cannot touch `demo-eve-internal` or org filesystem buckets under `demo-eve-org-*`, and cannot run bucket-admin actions (`CreateBucket`, `PutBucketCors`, `PutBucketPolicy`). It is expected that the user can access any bucket matching `demo-eve-app-*`; that is the documented Option A trade-off.

### Phase 4 — Worker mounts app-facing credentials (infra)

**Where**: `../deployment-instance/k8s/overlays/aws-eks/worker-deployment-patch.yaml`

```yaml
- name: EVE_APP_STORAGE_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: eve-app-storage
      key: EVE_APP_STORAGE_ACCESS_KEY_ID
- name: EVE_APP_STORAGE_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: eve-app-storage
      key: EVE_APP_STORAGE_SECRET_ACCESS_KEY
- name: EVE_APP_STORAGE_PUBLIC_ENDPOINT
  value: "https://s3.eu-west-1.amazonaws.com"
- name: EVE_APP_STORAGE_REGION
  value: "eu-west-1"
```

Acceptance: worker pod restart picks up `EVE_APP_STORAGE_ACCESS_KEY_ID`; `EVE_STORAGE_ACCESS_KEY_ID` remains unset in the AWS worker pod so the provisioner still uses IRSA.

### Phase 5 — Re-run gap-0012 verification

**Where**: PR #7's gap-tracking app on staging

1. Ship the Phase 1 code change in a new Eve release and apply the Phase 2-4 infra changes through Terraform/infra deploy.
2. Re-run the manifest from the gap evidence: a service that declares one `private` bucket and one `public` bucket with CORS.
3. Verify with the platform CLI:
   - `eve env diagnose <project> <env> --json | jq .storage_buckets` shows both buckets with `service_name`, `name`, `physical_name`, `visibility`, and `cors_json`. Do not expect a `status` field; the current schema does not have one.
   - `aws s3api list-buckets | grep demo-eve-app-<orgSlug>-<projectSlug>-<envName>-` shows both physical names.
   - `kubectl -n eve-<orgSlug>-<projectSlug>-<envName> exec deploy/<service> -- env | grep -E 'STORAGE_(ENDPOINT|REGION|ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET_)'` shows the injected vars. `STORAGE_FORCE_PATH_STYLE` should be absent on S3.
   - From inside the app pod, or from a debug image given the same `STORAGE_*` values: `PutObject`/`GetObject` to the app bucket succeeds.
   - Negative checks: `PutObject` to `demo-eve-internal` and an `demo-eve-org-*` org filesystem bucket fails, and `CreateBucket`/`PutBucketPolicy`/`PutBucketCors` fail with the app credentials.
   - Do not assert that another app/env bucket under `demo-eve-app-*` is inaccessible. Under Option A it is accessible by design and must be documented.
4. Update PR #7 description: gap is now closed end-to-end on staging.

Acceptance: gap-0012 evidence flips from "deploy refuses" to "deploy succeeds, bucket created, app can read/write". PR #7 closes its 0012 thread.

### Phase 6 — Documentation honesty

**Where**: `eve-horizon-2/docs/system/object-store-and-org-filesystem.md` and `eve-skillpacks` references.

- Add a "Trust model" subsection under "App Object Buckets" calling out: "On AWS staging, apps currently share one app-bucket IAM principal scoped to the deployment's app-bucket prefix (`demo-eve-app-*`). This prevents access to the platform internal bucket, org filesystem buckets (`demo-eve-org-*`), and non-Eve buckets, but it does not isolate app buckets from each other. Per-app IAM isolation (IRSA) is on the roadmap."
- Add a `references/deploy-debug.md` pointer in `eve-skillpacks` for "deploy fails with `Eve object storage is not configured`" → check the worker overlay for `EVE_STORAGE_*`.
- Update `eve-skillpacks` `references/object-store-filesystem.md` and `references/manifest.md` to include the same trust model after the change ships.
- Update `tests/manual/scenarios/26-object-store.md`: remove "per-env generated key" wording, remove planned `store/buckets`, `store/url`, and `store/ls` commands from active verification, and add shipped checks for `eve env diagnose`, app pod env vars, and S3 read/write.

Acceptance: `eve-skillpacks` PR merged; cross-link to this plan from the system doc.

### Phase 7 — File the Option B follow-up

Open a fresh plan `app-object-bucket-irsa-plan.md` covering per-app IRSA: deployer namespace SA management, IAM role pool, env-delete teardown, env-var injection mode flag. Do not block this plan on it.

---

## Code Touch Points (eve-horizon-2)

This plan requires one small Eve code change before the infra can safely land:

- `apps/worker/src/deployer/deployer.service.ts` — resolve app-injected storage env from `EVE_APP_STORAGE_*` first, with `EVE_STORAGE_*` fallback for local MinIO.
- `apps/worker/src/deployer/bucket-provisioner.ts` — add `EVE_STORAGE_APP_BUCKET_PREFIX` for app physical bucket names, defaulting to `EVE_STORAGE_ORG_BUCKET_PREFIX` for local/backward compatibility.
- `apps/worker/src/deployer/__tests__/deployer-object-store-buckets.spec.ts` — add coverage for the `EVE_APP_STORAGE_*` path and missing app credentials.
- `packages/shared/src/config/schema.ts` — optional but recommended: declare the new `EVE_APP_STORAGE_*` and `EVE_STORAGE_APP_BUCKET_PREFIX` vars so config docs/validation do not treat them as ad hoc.
- `docs/system/object-store-and-org-filesystem.md` — trust model paragraph + plan link.
- `tests/manual/scenarios/26-object-store.md` — replace planned store API checks with shipped diagnostics/env/S3 checks.

Infra touch points remain in `../deployment-instance` and must be changed only through Terraform and the infra repo's Kustomize overlays.

## Risks & Mitigations

- **Shared blast radius (Option A trade-off)**: documented in Phase 6; acceptable for staging today; followed by Option B plan.
- **Org filesystem exposure**: using `demo-eve-org-*` for app credentials would expose org filesystem buckets. Mitigate with `EVE_STORAGE_APP_BUCKET_PREFIX=demo-eve-app` and app IAM policy scoped only to `${local.storage_app_bucket_prefix}-*`.
- **Provisioner/app credential collision**: app credentials mounted as `EVE_STORAGE_*` would override IRSA and either break bucket provisioning or leak bucket-admin permissions to app pods. Mitigate by using only `EVE_APP_STORAGE_*` for the app key in the AWS worker overlay and by adding unit coverage for this separation.
- **Key rotation**: app pods receive credentials as env vars at deploy time. Rotation needs a two-key overlap runbook: create a second access key, update the worker secret, redeploy apps that declare buckets, then deactivate/delete the old key. `terraform apply -replace=aws_iam_access_key.app_buckets` is acceptable for staging only if app downtime is acceptable.
- **Terraform state exposure**: `aws_iam_access_key.secret` is stored in Terraform state even if outputs are sensitive. Restrict state access and avoid printing secrets in plans/logs.
- **K8s env exposure**: injected app credentials are visible to users who can read app pod specs or exec into pods. This is inherent to the static-key stopgap; document it and replace with per-app IRSA later.
- **Drift**: someone could re-deploy the worker without `EVE_STORAGE_*` from a stale branch. Mitigate by adding a `bd doctor`-style assertion in `eve env diagnose` that flags `storage_buckets.declared > 0 && worker_storage_configured == false`. Optional, not in this plan.
- **CORS unsupported**: deployer already warns and continues for MinIO; on S3 staging, CORS works — no special handling needed.

## Rollback

- Phase 1: revert the deployer code; local MinIO continues to work as today, but staging app-bucket deploys cannot use `EVE_APP_STORAGE_*`.
- Phase 2: revert worker overlay and app-prefix IRSA policy; deploys without buckets continue working; deploys *with* buckets fall back to "not configured" error (current behavior).
- Phase 3: remove the Terraform-managed IAM user/access key/secret.
- Phase 4: revert the `EVE_APP_STORAGE_*` secret mount on the worker; app-bucket deploys fail with missing app credential error.

Each phase rolls back independently. Phases 2 and 4 are k8s overlay changes (fast). Phase 3 is Terraform. Existing app pods that already received static env vars keep them until the app deployment is rolled.

## Verification Checklist

- [ ] Phase 1 code merged; tests cover `EVE_APP_STORAGE_*`, `EVE_STORAGE_APP_BUCKET_PREFIX`, local `EVE_STORAGE_*` fallback, and missing app credential errors.
- [ ] Phase 2 applied; worker pod has `EVE_STORAGE_BACKEND=s3`, `EVE_STORAGE_REGION`, `EVE_STORAGE_INTERNAL_BUCKET`, `EVE_STORAGE_ORG_BUCKET_PREFIX`, `EVE_STORAGE_APP_BUCKET_PREFIX=demo-eve-app`, `EVE_STORAGE_PUBLIC_ENDPOINT`.
- [ ] Worker/API IRSA policy can provision `demo-eve-app-*` buckets.
- [ ] Worker pod does **not** have `EVE_STORAGE_ACCESS_KEY_ID` or `EVE_STORAGE_SECRET_ACCESS_KEY` in AWS staging.
- [ ] Phase 3 applied; IAM user exists with scoped non-admin policy; access key is stored in `eve-app-storage` secret under `EVE_APP_STORAGE_*` keys.
- [ ] Phase 4 applied; worker pod has `EVE_APP_STORAGE_ACCESS_KEY_ID` available for injection.
- [ ] App deploy with `x-eve.object_store.buckets` succeeds on staging.
- [ ] App pod env shows `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET_<NAME>`.
- [ ] App pod can `s3:PutObject` / `s3:GetObject` to its declared bucket.
- [ ] App credentials cannot touch `demo-eve-internal` or `demo-eve-org-*`, and cannot run bucket-admin actions.
- [ ] `eve env diagnose` shows both entries in `storage_buckets` for the deployed env (no `status` field expected).
- [ ] Manual scenario 26 no longer depends on planned `store/*` APIs.
- [ ] PR #7 0012 evidence updated to "closed on staging".
- [ ] Docs trust-model paragraph merged.
- [ ] Option B plan filed.

---

## Open Questions

1. **Secret name**: `eve-app-storage` is suggested. Confirm with naming convention used by existing platform secrets (`eve-app`, `eve-hosted-db`, `eve-internal`).
2. **App bucket prefix**: `demo-eve-app` is suggested. Confirm the prefix before any staging buckets are created; renaming later requires bucket migration.
3. **Region default**: hardcode `eu-west-1` in worker overlay (matches API/runtime), or read from a shared `region` var? Today the API/runtime hardcode it, so consistency wins until we have a multi-region story.
4. **Public endpoint**: Should apps receive `STORAGE_ENDPOINT=https://s3.eu-west-1.amazonaws.com`, or should S3 apps omit `STORAGE_ENDPOINT` and rely on SDK defaults? Current deployer requires a non-empty endpoint, so Phase 1 keeps one, but app compatibility should be verified.
5. **Credential rotation runbook**: Do we accept one-step staging rotation, or implement the two-key overlap process immediately?
6. **Manifest validation hint**: should `eve manifest validate` warn if `x-eve.object_store.buckets` is declared but the target environment is known not to support it? Out of scope, but worth a follow-up bead.
