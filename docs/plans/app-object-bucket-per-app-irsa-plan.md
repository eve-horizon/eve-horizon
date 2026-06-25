# App Object Bucket Per-App IRSA Plan (v2)

> **Status**: Eve Horizon core implementation complete; staging Terraform/OIDC rollout pending
> **Last Updated**: 2026-05-18
> **Beads**: `eve-horizon-v9d2`, follow-up `eve-horizon-64uk`
> **Origin**: Closes external gap **004 — Per-app IAM isolation for app object buckets**.
> **Predecessors**:
> - [`app-object-bucket-credentials-plan.md`](./app-object-bucket-credentials-plan.md) — shipped the shared `demo-eve-app` stopgap (Option A). Today's production behavior on staging.
> - [`app-object-bucket-irsa-plan.md`](./app-object-bucket-irsa-plan.md) — 2026-05-05 sketch of the per-app IRSA shape. This plan expands and supersedes it; the stub stays in place as the original notes.
> **Verification source**: `apps/worker/src/deployer/deployer.service.ts:2502-2643`, `apps/worker/src/deployer/bucket-provisioner.ts:1-99`, `packages/shared/src/schemas/environment.ts:210-218`, `packages/shared/src/schemas/manifest.ts:209-225`, `../deployment-instance/terraform/aws/main.tf:359-456`, `../deployment-instance/terraform/aws/app-bucket-credentials.tf:1-71`, `../deployment-instance/k8s/overlays/aws-eks/worker-deployment-patch.yaml:81-106`, `../deployment-instance/k8s/overlays/aws-eks/worker-serviceaccount-patch.yaml:1-7`.

## Problem

Every app deployed by Eve today receives the same shared IAM principal (`demo-app-buckets`) via static `EVE_APP_STORAGE_*` keys mounted on the worker and injected into every app pod that declares `x-eve.object_store.buckets`. The principal is scoped to `arn:aws:s3:::demo-eve-app-*`, which blocks access to the platform-internal bucket, org filesystem buckets (`demo-eve-org-*`), and non-Eve buckets — but it does **not** isolate apps from each other. A compromised pod, or simply an app with the credentials in its env, can list and read every other app's buckets in the same deployment.

For ACME Portal-class POCs this is documented as acceptable. For tenants with contractual obligations on partner archives, report PDFs containing PII, or customer media uploads (the immediate driver is the Eve-native ACME rebuild), it is not.

This plan implements per-environment IAM isolation via IRSA: every environment that declares object buckets runs under a namespace-local ServiceAccount annotated with an IAM role whose policy only references that environment's bucket names. Static `EVE_APP_STORAGE_*` keys are no longer mounted into pods on EKS. The AWS SDK in the app uses the pod's projected service-account token to assume the role automatically.

## Goals

- Two apps deployed in the same Eve org and deployment cannot read or write each other's **private** app buckets. Verified on AWS staging by attempting `aws s3 ls` / `aws s3 cp` cross-app from each pod's identity and observing `AccessDenied`. Public buckets remain publicly readable by design; this plan does not turn `visibility: public` into a private isolation boundary.
- An environment that declares no buckets gets no IAM role and no SA annotation; only envs that opt in pay the cost.
- `eve env diagnose --json` reports the actual `isolation_mode` per environment (`irsa` | `shared` | `minio-static-key`). The reported mode matches what is in cluster.
- Setting `x-eve.object_store.isolation: irsa` against a cluster that cannot satisfy it (local k3d / MinIO, missing OIDC provider, missing worker IAM perms) fails fast with a clear error before any pod is rolled.
- IAM role creation, policy update, and teardown are idempotent — re-deploying the same manifest does not create duplicate roles; removing a bucket from `object_store.buckets[]` removes its slice from the inline policy and prunes the stale `storage_buckets` row on the next deploy; removing all bucket declarations removes the role on the next deploy; `eve env delete` removes both the SA and the IAM role.
- Migration: switching an existing env from `shared` to `irsa` is supported by re-deploy. Presigned URLs minted before the switch remain valid until S3 expires them (documented; not actively rotated).
- Worker keeps using its own IRSA (`example-api-irsa`) for bucket *provisioning* (`CreateBucket`, `PutBucketCors`, `PutBucketPolicy`, `PutBucketPublicAccessBlock`). The worker gains tightly-scoped IAM permissions to create/manage app roles under a name pattern; it does **not** receive blanket IAM admin.

## Non-Goals

- **Cross-tenant isolation inside one app.** That is an in-app RLS / authorization concern, not an IAM concern.
- **Per-bucket distinct IAM roles within one app.** v1 issues one role per `(org, project, env)` covering every bucket the manifest declares for that env.
- **Customer-controlled IAM templates.** Inline policy is platform-generated. Bring-your-own-policy is a separate ask.
- **Replicating per-app isolation for org filesystem buckets.** Those have a separate trust model and remain under `api_irsa`.
- **Re-provisioning historical bucket data.** Buckets created under the shared-key stopgap stay where they are; only the principal that reads/writes them changes.
- **Deleting physical buckets or objects when a manifest declaration is removed.** The DB row and IAM policy entry are pruned, but the physical S3/MinIO bucket and its objects are retained until an explicit retention/deletion feature exists.
- **Decommissioning the shared `demo-app-buckets` user immediately.** It remains as the documented `shared` fallback until every staging env has migrated and the docs explicitly drop support.
- **GCP / Workload Identity, Azure, and ECS variants.** Plan-level abstraction (`AppCredentialProvisioner`) allows them later; v1 implements AWS IRSA plus the existing shared-key and MinIO static-key fallback modes.

---

## Current Code Pointers

| Concern | File | Lines |
| --- | --- | --- |
| Bucket provisioning entrypoint | `apps/worker/src/deployer/deployer.service.ts` | `resolveObjectStoreBuckets` 2502-2643 |
| Static-key env resolution | `apps/worker/src/deployer/deployer.service.ts` | 2528-2575 |
| Bucket-name helpers | `apps/worker/src/deployer/bucket-provisioner.ts` | `getAppBucketName` 87-98 |
| Storage client factory | `packages/shared/src/storage/create-storage-client.ts` | full |
| Manifest schema (`object_store`) | `packages/shared/src/schemas/manifest.ts` | 209-225 |
| Diagnose response schema | `packages/shared/src/schemas/environment.ts` | 210-218, 254-273 |
| Diagnose service | `apps/api/src/environments/env-diagnostics.service.ts` | 482-502 |
| `storage_buckets` table queries | `packages/db/src/queries/storage-buckets.ts` | 1-90 |
| Env namespace + apply | `apps/worker/src/deployer/deployer.service.ts` | 286-895 |
| Env delete | `apps/worker/src/deployer/deployer.service.ts` | 884-888 |
| K8s service (raw apply) | `apps/worker/src/deployer/k8s.service.ts` | 40-103, 594-643 |
| Worker IRSA role + storage policy | `../deployment-instance/terraform/aws/main.tf` | 359-456 |
| Shared app-bucket user | `../deployment-instance/terraform/aws/app-bucket-credentials.tf` | 1-71 |
| Worker overlay (env vars) | `../deployment-instance/k8s/overlays/aws-eks/worker-deployment-patch.yaml` | 81-106 |
| Worker SA (IRSA annotation) | `../deployment-instance/k8s/overlays/aws-eks/worker-serviceaccount-patch.yaml` | full |
| Local k3d storage (MinIO) | `apps/api/src/.../k8s/base/api-deployment.yaml`, `worker-deployment.yaml`, `minio-statefulset.yaml` | various |
| Manual scenario | `tests/manual/scenarios/26-object-store.md` | full |

App buckets currently follow the pattern `{EVE_STORAGE_APP_BUCKET_PREFIX}-{orgSlug}-{projectSlug}-{envName}-{bucketName}` (e.g. `demo-eve-app-myorg-myapp-test-uploads`). The orgSlug/projectSlug/envName triple is exactly what we want to use as the isolation key for an IAM role.

---

## Design

### Decision: `AppCredentialProvisioner` abstraction

We introduce a single seam in the deployer:

```ts
interface AppCredentialProvisioner {
  // Capabilities advertised at boot, used to resolve 'auto' and to fail fast on 'irsa'.
  readonly mode: 'irsa' | 'shared' | 'minio-static-key';
  readonly available: boolean;

  // Idempotent. Creates/updates the IAM role + inline policy (or no-op for non-IRSA modes).
  // Returns details to record in storage_buckets and reflect in diagnose.
  ensureForEnv(scope: AppEnvScope, bucketPhysicalNames: string[]): Promise<AppCredentialBinding>;

  // Called from deleteEnvironment. Idempotent; safe to invoke if nothing was created.
  removeForEnv(scope: AppEnvScope): Promise<void>;
}

interface AppEnvScope {
  orgId: string;
  projectId: string;
  orgSlug: string;
  projectSlug: string;
  envName: string;
  namespace: string;     // already resolved via toK8sName(...)
}

interface AppCredentialBinding {
  mode: 'irsa' | 'shared' | 'minio-static-key';
  serviceAccount?: {
    name: string;
    namespace: string;
    annotations: Record<string, string>;
  };                                                     // present in irsa mode
  iamRoleArn?: string;                                  // present in irsa mode
  iamRoleName?: string;                                 // present in irsa mode
  bindingHash?: string;                                 // mode + role + bucket set, used to force pod rollout
  envVars: Array<{ name: string; value: string } | { name: string; valueFrom: any }>;
}
```

Three implementations:

1. **`AwsIrsaAppCredentialProvisioner`** — the real per-app isolation. Creates one IAM role per env, scoped to that env's full desired physical bucket set; returns the namespace-local `ServiceAccount` name plus IRSA annotation for the deployer to render; returns no `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` envs (SDK uses the projected token).
2. **`SharedKeyAppCredentialProvisioner`** — today's behaviour. Resolves `EVE_APP_STORAGE_*` from worker env and emits static-key envs. Returns `mode: 'shared'`.
3. **`MinioStaticKeyAppCredentialProvisioner`** — `EVE_STORAGE_*` MinIO keys passed straight through (the existing local k3d path). Returns `mode: 'minio-static-key'`.

Selection precedence per environment:

| Inputs | Selected mode |
| --- | --- |
| `x-eve.object_store.isolation: irsa` + AWS provisioner available | `irsa` |
| `x-eve.object_store.isolation: irsa` + provisioner unavailable | **fail fast** with `isolation mode 'irsa' not available on this cluster: <reason>` |
| `x-eve.object_store.isolation: shared` | `shared` (or `minio-static-key` if backend is MinIO) |
| `x-eve.object_store.isolation: auto` (default) — AWS provisioner available | `irsa` |
| `x-eve.object_store.isolation: auto` — only MinIO available | `minio-static-key` |
| `x-eve.object_store.isolation: auto` — only shared keys configured (no IRSA) | `shared` |

The AWS provisioner advertises `available: true` only when **all** of:
- `EVE_APP_BUCKET_AUTH_MODE` is unset (or `irsa` / `auto`; `shared` forces the shared-key provisioner)
- `EVE_OIDC_PROVIDER_ARN` and `EVE_OIDC_PROVIDER_URL` are set on the worker
- The default AWS credential chain resolves. Do **not** use `iam:ListRoles` as a boot probe: IAM list APIs generally require `Resource="*"` and would force broader worker permissions. IAM permission failures are surfaced by `ensureForEnv` before any app Deployment is applied.

### Naming

| Object | Pattern | Notes |
| --- | --- | --- |
| IAM role | `{name_prefix}-app-{orgSlug}-{projectSlug}-{envName}` | Max 64 chars; if the rendered name would exceed 64 chars we replace the suffix with a deterministic 16-char SHA-256 prefix (`{name_prefix}-app-{16char-hash}`) and store the mapping in `storage_buckets.iam_role_name`. Validate `name_prefix` so the hash form also fits. |
| IAM inline policy | `app-bucket-access` | Single inline policy per role; full-replace on each deploy. |
| ServiceAccount | `eve-app` (in the app namespace) | One SA per env; same name in every namespace. Annotated with `eks.amazonaws.com/role-arn`. |
| Trust policy `sub` | `system:serviceaccount:{namespace}:eve-app` | Matches exactly the SA the deployer renders into the pod. |

### Worker IAM permissions

The worker (via `api_irsa`) needs new IAM permissions, scoped tightly by name pattern so a worker compromise cannot mint arbitrary roles:

```hcl
{
  Sid    = "ManageAppBucketRoles"
  Effect = "Allow"
  Action = [
    "iam:CreateRole",
    "iam:DeleteRole",
    "iam:GetRole",
    "iam:TagRole",
    "iam:UntagRole",
    "iam:UpdateAssumeRolePolicy",
    "iam:PutRolePolicy",
    "iam:DeleteRolePolicy",
    "iam:GetRolePolicy",
    "iam:ListRolePolicies",
  ]
  Resource = "arn:aws:iam::${local.aws_account_id}:role/${var.name_prefix}-app-*"
}
```

The worker does **not** get `iam:PassRole`, `iam:AttachRolePolicy`, or `iam:ListRoles`; only inline policies on roles it owns under the prefix.

### Trust policy

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "<EVE_OIDC_PROVIDER_ARN>" },
    "Action":   "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "<oidcHost>:aud": "sts.amazonaws.com",
        "<oidcHost>:sub": "system:serviceaccount:<namespace>:eve-app"
      }
    }
  }]
}
```

The exact-match `:sub` condition (not `StringLike`) guarantees only the env's own SA can assume the role. `EVE_OIDC_PROVIDER_URL` may include `https://`; strip that prefix when building the IAM condition key.

### Inline policy shape

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListOwnBuckets",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
      "Resource": [
        "arn:aws:s3:::demo-eve-app-<orgSlug>-<projectSlug>-<envName>-<bucket1>",
        "arn:aws:s3:::demo-eve-app-<orgSlug>-<projectSlug>-<envName>-<bucket2>"
      ]
    },
    {
      "Sid": "ReadWriteOwnObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": [
        "arn:aws:s3:::demo-eve-app-<orgSlug>-<projectSlug>-<envName>-<bucket1>/*",
        "arn:aws:s3:::demo-eve-app-<orgSlug>-<projectSlug>-<envName>-<bucket2>/*"
      ]
    }
  ]
}
```

Bucket-admin actions (`CreateBucket`, `PutBucketCors`, `PutBucketPolicy`, `PutBucketPublicAccessBlock`, `DeleteBucket`) are intentionally absent — those stay with the worker's `api_irsa`. For `visibility: public`, the worker may still apply a public-read bucket policy; that deliberately makes object reads public and is outside the private-bucket isolation guarantee.

### Manifest knob

```yaml
services:
  api:
    x-eve:
      object_store:
        buckets:
          - { name: partner-archives, visibility: private }
          - { name: report-pdfs,      visibility: private }
        isolation: irsa            # 'irsa' | 'shared' | 'auto' (default)
```

Schema change in `packages/shared/src/schemas/manifest.ts`:

```ts
export const ObjectStoreConfigSchema = z.object({
  buckets: z.array(ObjectStoreBucketSchema).optional(),
  isolation: z.enum(['irsa', 'shared', 'auto']).optional(),
}).passthrough();
```

Backwards compatibility: no `isolation` key is resolved by deployer helpers as `auto` (do not use a Zod `.default()` that writes `auto` into stored manifests). `auto` resolves to IRSA on AWS, MinIO static keys on k3d, and shared keys only where IRSA is unavailable but the shared fallback is configured. Existing manifests get IRSA automatically once the platform supports it.

### Environment-wide binding resolution

The credential binding is resolved **once per environment render**, not once per service. This is critical because v1 uses one role per `(org, project, env)` and the IAM inline policy is full-replaced on each deploy. Calling `ensureForEnv` from the per-service bucket loop would make the last service that declares buckets overwrite the policy and drop earlier services' buckets.

Before rendering Deployments, the deployer must:

1. Apply env/database overrides to the full service map.
2. Collect desired app bucket declarations from every service that can run in the environment, including `x-eve.role: job` services. Ignore external/connection-only services because no pod runs for them.
3. Compute the physical bucket names without creating buckets.
4. Resolve the requested isolation mode (`object_store.isolation ?? 'auto'`) across the desired services. Treat `auto` as neutral; if one explicit mode is present, use it; if both explicit `irsa` and explicit `shared` are present in the same env, fail fast because one env has one credential binding.
5. If the desired set is empty, call `removeForEnv(scope)` and prune `storage_buckets` rows for the env.
6. Otherwise call `ensureForEnv(scope, allDesiredPhysicalBucketNames)` exactly once, then provision buckets/CORS/public policies and persist one `storage_buckets` row per desired logical bucket.
7. Delete any stale `storage_buckets` rows for `(project_id, env_name)` that are no longer in the desired manifest set. Do not delete the physical bucket.

This planning code should be factored into a helper used by both `renderManifest` and `runJobService`. A job service can declare `x-eve.object_store.buckets` today because `runJobService` calls `resolveServiceEnvEntries`; under IRSA it must reconcile the same env-wide binding before launching the Job pod.

### Pod-spec injection

In `renderManifest`, when the resolved binding is `irsa`:

1. Render a `ServiceAccount` object as the first document in the manifest (one per namespace; the apply path is already idempotent) with `eks.amazonaws.com/role-arn`.
2. Set `spec.template.spec.serviceAccountName: eve-app` on each Deployment for a service whose `x-eve.object_store.buckets` has at least one bucket.
3. Set a pod-template annotation such as `eve.app_bucket_binding_hash=<bindingHash>` so role/policy/mode changes force a Deployment rollout even when `serviceAccountName` stays `eve-app`.
4. Omit `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` envs.
5. Inject `STORAGE_AUTH_MODE=irsa`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, and `AWS_REGION=<region>` so SDK auto-discovery works without any extra config from the app.

`runJobService` needs the same treatment: if an `x-eve.role: job` service declares buckets and the resolved binding is `irsa`, the Job pod spec must use `serviceAccountName: eve-app` and the `eve.app_bucket_binding_hash` annotation before it starts.

When the binding is `shared` or `minio-static-key`, behavior is unchanged from today.

### Diagnostics shape

`EnvStorageBucketInfoSchema` gains:

```ts
isolation_mode: z.enum(['irsa', 'shared', 'minio-static-key']),
iam_role_arn:   z.string().nullable().optional(),
iam_role_name:  z.string().nullable().optional(),
service_account: z.object({ name: z.string(), namespace: z.string() }).nullable().optional(),
```

The same fields are recorded on every row at provision time so `eve env diagnose` reflects what was actually rendered, not what the worker happens to advertise today.

The `storage_buckets` table gets new nullable metadata columns via migration:

```sql
ALTER TABLE storage_buckets
  ADD COLUMN isolation_mode TEXT
    CHECK (isolation_mode IN ('irsa', 'shared', 'minio-static-key')),
  ADD COLUMN iam_role_arn   TEXT,
  ADD COLUMN iam_role_name  TEXT,
  ADD COLUMN service_account_name TEXT,
  ADD COLUMN service_account_namespace TEXT;
```

Existing rows stay nullable until the next deploy updates them. Do not backfill every old row to `shared`: local k3d rows were created with MinIO static keys, while staging rows were created with the shared IAM user.

---

## Phased Plan

### Phase 1 — Manifest + schema + DB (eve-horizon)

**Where**: `packages/shared/src/schemas/manifest.ts`, `packages/shared/src/schemas/environment.ts`, `packages/db/src/queries/storage-buckets.ts`, new migration file.

1. Add optional `isolation: 'irsa' | 'shared' | 'auto'` to `ObjectStoreConfigSchema`. Add a helper such as `getServiceObjectStoreIsolation(service): 'irsa' | 'shared' | 'auto'` that resolves missing values to `auto`; do not add a Zod default that mutates stored manifests.
2. Add `isolation_mode`, `iam_role_arn`, `iam_role_name`, and `service_account` to `EnvStorageBucketInfoSchema` (all optional/nullable for back-compat with old DB rows).
3. New migration adds nullable `isolation_mode`, `iam_role_arn`, `iam_role_name`, `service_account_name`, and `service_account_namespace` columns to `storage_buckets`. Do not backfill all old rows to `shared`; old local rows may be MinIO.
4. Extend `UpsertStorageBucketInput` and the `upsert` query to accept and persist the new columns.
5. Add storage-bucket cleanup queries: `deleteMissingForEnv(projectId, envName, desiredKeys)` for manifest bucket removal and `deleteByEnv(projectId, envName)` for `eve env delete` / zero-bucket redeploys.

Acceptance: manifest validates against existing and new manifests; round-trip through DB preserves new fields; `EnvDiagnoseResponse` parser is unchanged for envs with no buckets; removing a bucket from the manifest prunes its DB row without deleting the physical bucket.

### Phase 2 — `AppCredentialProvisioner` abstraction + Shared/MinIO impls (eve-horizon)

**Where**: `apps/worker/src/deployer/app-credential-provisioner/` (new directory: `types.ts`, `shared-key.ts`, `minio-static-key.ts`, `factory.ts`, `__tests__/`), `apps/worker/src/deployer/deployer.service.ts`, `apps/worker/src/deployer/deployer.module.ts`.

1. Define the `AppCredentialProvisioner` interface and the three concrete-impl files. The AWS impl in this phase is a stub (`available: false`, throws on `ensureForEnv`).
2. `factory.ts` exports `createAppCredentialProvisioners()` that returns the available impls based on worker env (`EVE_STORAGE_BACKEND`, `EVE_APP_STORAGE_*`, `EVE_OIDC_PROVIDER_ARN`).
3. Add an env-wide object-store planning helper, separate from per-service env-var rendering and reusable by `renderManifest` and `runJobService`:
   - Collect all desired bucket declarations after overrides and before `filterDeployableServices` drops job services.
   - Resolve one binding mode for the env via the precedence table.
   - Call `ensureForEnv` exactly once with the full desired physical bucket list.
   - Provision each bucket/CORS/public policy after binding resolution.
   - Persist `isolation_mode`, `iam_role_arn`, `iam_role_name`, `service_account_name`, and `service_account_namespace` into each `storage_buckets` row.
   - Delete stale rows not present in the desired set.
4. Per-service env-var injection becomes a thin consumer of the env plan: merge `binding.envVars` with that service's `STORAGE_BUCKET_*` vars and `STORAGE_FORCE_PATH_STYLE`.
5. If the desired bucket set is empty, the deployer calls `removeForEnv(scope)` and `deleteByEnv(projectId, envName)` so an env can migrate from bucketed to unbucketed without leaving access behind.
6. `deleteEnvironment` is extended to call `removeForEnv` on every available provisioner before deleting the namespace and to remove `storage_buckets` rows for the env (safe because `removeForEnv` is idempotent and noop for envs that never opted in).
7. Unit tests cover:
   - Default `auto` on k3d → `minio-static-key`.
   - Default `auto` with `EVE_APP_STORAGE_*` set (no OIDC) → `shared`.
   - Explicit `isolation: irsa` with AWS provisioner unavailable → `Error: isolation mode 'irsa' not available on this cluster: <reason>`.
   - Explicit `isolation: shared` keeps today's static-key envs.
   - `storage_buckets` row records the resolved mode.
   - Two services with buckets produce one env binding containing both physical bucket names.
   - Removing one bucket prunes its DB row and removes it from the next binding.
   - Services with conflicting `isolation` values fail fast before bucket creation.

Acceptance: existing scenarios 26 (`object-store`) and 05 (`deploy-flow`) still pass on local k3d unchanged. No behavior change on AWS yet (AWS provisioner is stubbed).

### Phase 3 — `AwsIrsaAppCredentialProvisioner` implementation (eve-horizon)

**Where**: `apps/worker/src/deployer/app-credential-provisioner/aws-irsa.ts`, `apps/worker/src/deployer/app-credential-provisioner/iam-client.ts` (new), `apps/worker/src/deployer/k8s.service.ts`, `apps/worker/src/deployer/__tests__/`.

1. Add `@aws-sdk/client-iam` as a new dependency in `apps/worker/package.json` (IAM is a separate SDK package). Build a small worker-local `IamClient` wrapper with the ops we need: `getRole`, `createRole`, `updateAssumeRolePolicy`, `putRolePolicy`, `getRolePolicy`, `deleteRolePolicy`, `listRolePolicies`, `deleteRole`, `tagRole`. Tag every role with `eve:org`, `eve:project`, `eve:env`, `eve:managed-by=eve-worker`.
2. `AwsIrsaAppCredentialProvisioner.ensureForEnv`:
   - Compute role name from `(name_prefix, orgSlug, projectSlug, envName)`; hash-truncate with the 16-char hash form if the full name would exceed 64 chars.
   - Render the trust policy (using `EVE_OIDC_PROVIDER_ARN` + `EVE_OIDC_PROVIDER_URL`, with the condition host stripped of `https://`).
   - `getRole`: if 404, `createRole` with trust policy + tags. If 200, `updateAssumeRolePolicy` (idempotent diff via JSON normalization).
   - `putRolePolicy('app-bucket-access', ...)` with the bucket resource list. Full replace.
   - Return `mode: 'irsa'`, `iamRoleArn`, `iamRoleName`, `serviceAccount` (including annotations), `bindingHash`, and the env vars `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_AUTH_MODE=irsa`, `AWS_REGION`.
3. `removeForEnv`: list inline policies for the role, delete `app-bucket-access` and any other inline policies left on the Eve-managed role, then `deleteRole`. Suppress NoSuchEntity. Leave the SA alone (namespace delete removes it).
4. `renderManifest` change: when binding mode is `irsa`, emit a `ServiceAccount` doc before any Deployment doc, add `serviceAccountName: eve-app` and `eve.app_bucket_binding_hash` to every Deployment whose service declares buckets, and apply the same service account / annotation to Job pods in `runJobService`.
5. **Provisioning order**: compute physical bucket names → ensure env credential binding/role/policy → create/update buckets and CORS/public policies → render/apply pods. This makes the first pod start with both an existing role and existing buckets.
6. Unit tests with a mocked IAM client cover: first deploy creates role; redeploy is idempotent (`getRole` then policy replace); multiple services are aggregated into one policy; bucket added → policy is re-put; bucket removed → policy is re-put without it; all buckets removed → role is deleted; env delete tears down role and policy; long slug → hashed role name; missing OIDC env → provisioner reports `available: false`.

Acceptance: integration test against `localstack` (or, if too heavy, a fully-mocked SDK harness) covers the full lifecycle. AWS staging deploy with `isolation: auto` produces a new role and SA; pod env shows no `STORAGE_ACCESS_KEY_ID`.

### Phase 4 — Infra: cluster OIDC env vars + worker IAM perms (infra)

**Where**: `../deployment-instance/terraform/aws/main.tf`, `../deployment-instance/terraform/aws/outputs.tf`, `../deployment-instance/k8s/overlays/aws-eks/worker-deployment-patch.yaml`.

All infra changes in this phase must go through Terraform in `../deployment-instance`; do not make direct AWS IAM/OIDC changes with the AWS CLI.

1. Add a `ManageAppBucketRoles` statement to `aws_iam_role_policy.api_storage` scoped to `arn:aws:iam::<account>:role/${var.name_prefix}-app-*` and the IAM actions in the **Worker IAM permissions** section above.
2. Add OIDC env vars to the worker deployment patch:
   ```yaml
   - name: EVE_OIDC_PROVIDER_ARN
     value: "arn:aws:iam::<aws-account-id>:oidc-provider/oidc.eks.eu-west-1.amazonaws.com/id/<id>"
   - name: EVE_OIDC_PROVIDER_URL
     value: "https://oidc.eks.eu-west-1.amazonaws.com/id/<id>"
   ```
   Sourced from `module.eks[0].oidc_provider_arn` / `oidc_provider_url` — add root Terraform outputs if needed, then wire through the existing kustomize patch generation path.
3. Do **not** remove `EVE_APP_STORAGE_*` envs from the worker; they remain the `shared` fallback path while we migrate envs one by one.

Acceptance: `aws iam simulate-principal-policy` for `example-api-irsa` allows `iam:CreateRole` on `arn:aws:iam::*:role/demo-app-*` and denies on `arn:aws:iam::*:role/example-api-irsa`. Worker pod env shows both OIDC vars.

### Phase 5 — Local k3d verification loop (eve-horizon)

**Where**: `tests/manual/scenarios/52-app-bucket-iam-isolation.md` (new), `tests/manual/README.md`.

The local stack runs MinIO, not AWS IAM. The k3d loop therefore verifies the **contract surface** (manifest knob, fail-fast, diagnose reporting, regression) rather than the AWS-only `AccessDenied` outcome. Cross-app deny is verified against staging in Phase 6.

Loop body (runs on `./bin/eh k8s deploy`'d local stack):

```bash
# 0. Prereqs
./bin/eh status                                  # stack running
eve system health --json                         # ok
eve org ensure manual-test-org --slug manual-test-org --json
eve secrets import --org org_manualtestorg --file manual-tests.secrets

# 1. Regression: existing object-store scenario still passes
./bin/eh test scenario 26                        # or follow scenarios/26-object-store.md manually

# 2. AUTO degrades to minio-static-key on k3d
#    Project A with two buckets, no `isolation` key.
PROJ_A=$(eve project ensure --name irsa-a --repo-url <repo> --branch main --json | jq -r '.id')
# manifest has services.api.x-eve.object_store.buckets = [{name: uploads}, {name: media}]
eve env deploy test --project "$PROJ_A" --ref HEAD --repo-dir <repo>
eve env diagnose "$PROJ_A" test --json \
  | jq '.storage_buckets[0] | {isolation_mode, iam_role_arn}'
# Expect: isolation_mode="minio-static-key", iam_role_arn=null

# 3. EXPLICIT irsa fails fast
#    Same project, edit manifest to add `isolation: irsa`.
eve env deploy test --project "$PROJ_A" --ref HEAD --repo-dir <repo>
# Expect: exit non-zero with message
#   "Service 'api' declares object_store.isolation='irsa' but isolation mode
#    'irsa' is not available on this cluster: EVE_OIDC_PROVIDER_ARN unset."
# Also: no pod is rolled, no IAM call is attempted (provisioner unavailable).

# 4. EXPLICIT shared still works (regression of stopgap path)
#    Set isolation: shared, deploy, verify STORAGE_ACCESS_KEY_ID is still injected.
eve env deploy test --project "$PROJ_A" --ref HEAD --repo-dir <repo>
APP_NS=$(eve env diagnose "$PROJ_A" test --json | jq -r '.namespace')
APP_DEPLOY=$(kubectl -n "$APP_NS" get deploy -l eve.component=api -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$APP_NS" exec "deploy/$APP_DEPLOY" -- printenv \
  | grep -E '^STORAGE_(ACCESS_KEY_ID|ENDPOINT|BUCKET_)'

# 5. Env delete is safe under all three modes (no IAM call, no orphan resources)
eve env delete test --project "$PROJ_A" --force
kubectl get ns "$APP_NS" || echo "namespace gone (expected)"
```

The scenario file documents each step with assertions written as `assert` blocks so an agent can run it end-to-end and report PASS/FAIL per step. Add scenario 52 to the `tests/manual/README.md` table under "Phase 0-2".

Acceptance: scenario 52 passes on a freshly rebuilt local stack (`./bin/eh k8s deploy`). The agent-runnable form fits the existing scenarios/01-04 parallel-safe pattern (it can run alongside others, since it operates only on its own project namespace).

### Phase 6 — Staging verification (eve-horizon + infra)

**Where**: `tests/manual/scenarios/52-app-bucket-iam-isolation.md` (staging section), `docs/system/object-store-and-org-filesystem.md`, `docs/deploy/staging.md`.

Once Phase 4 infra is applied to staging:

1. Deploy two unrelated apps in two projects under the same org, each declaring one **private** bucket, both with `isolation: auto` (so they pick IRSA):
   ```bash
   eve env deploy test --project "$PROJ_A" --ref HEAD --repo-dir <repo-a>    # bucket: demo-eve-app-<org>-irsa-a-test-uploads
   eve env deploy test --project "$PROJ_B" --ref HEAD --repo-dir <repo-b>    # bucket: demo-eve-app-<org>-irsa-b-test-uploads
   ```
2. `eve env diagnose --json` for each shows `isolation_mode: "irsa"`, the role ARN, and the SA name.
3. Verify the AWS-side state:
   ```bash
   aws iam get-role --role-name demo-app-<org>-irsa-a-test
   aws iam get-role-policy --role-name demo-app-<org>-irsa-a-test --policy-name app-bucket-access
   ```
   Inline policy resources only reference `demo-eve-app-<org>-irsa-a-test-*`.
4. From inside the A pod (using the SDK and the projected token), `PutObject` and `GetObject` to A's bucket succeed.
5. From inside the A pod, attempting `s3:ListBucket` or `s3:GetObject` against B's bucket returns `AccessDenied`. From B's pod against A's bucket: same.
6. From A pod: `s3:PutObject` to `demo-eve-internal` and `demo-eve-org-*` returns `AccessDenied`. `s3:CreateBucket` / `s3:PutBucketPolicy` / `s3:PutBucketCors` return `AccessDenied`.
7. `eve env delete test --project "$PROJ_A" --force` followed by `aws iam get-role --role-name demo-app-<org>-irsa-a-test` returns `NoSuchEntity`. The B env is unaffected.
8. Migration check: change project B's manifest to `isolation: shared`, redeploy, observe `isolation_mode: "shared"` in diagnose and a fresh `STORAGE_ACCESS_KEY_ID` env in the pod. Roll back to `isolation: auto`, redeploy, observe `irsa` again. Pre-existing data in B's bucket is untouched. Note: any presigned URLs minted before the switch remain valid until they expire (documented in `docs/system/object-store-and-org-filesystem.md`).

Acceptance: every step above passes on staging; the `AccessDenied` evidence becomes part of the gap-004 close-out.

### Phase 7 — Documentation + skillpack sync (eve-horizon + eve-skillpacks)

**Where**: `docs/system/object-store-and-org-filesystem.md`, `eve-skillpacks/.../references/object-store-filesystem.md`, `eve-skillpacks/.../references/manifest.md`, `eve-skillpacks/.../references/deploy-debug.md`.

1. Replace the "Trust model" paragraph in `object-store-and-org-filesystem.md` with: "Each app environment with declared buckets receives its own IAM role via IRSA (`eks.amazonaws.com/role-arn` on a per-namespace `eve-app` ServiceAccount). The role's inline policy references only that environment's physical bucket names. The shared `demo-app-buckets` user remains as the documented `shared` fallback for older envs and for `isolation: shared` opt-out."
2. Document the manifest knob in `references/manifest.md` under "App Object Store Buckets".
3. Add `references/deploy-debug.md` entry: "deploy fails with `isolation mode 'irsa' not available on this cluster: <reason>`" → checks (EVE_OIDC_PROVIDER_*, worker IAM perms, EVE_STORAGE_BACKEND=s3).
4. Update `tests/manual/scenarios/26-object-store.md` to add `isolation_mode` to the diagnose check expectations (any of the three values is acceptable in scenario 26; scenario 52 is the dedicated isolation test).
5. Drop the "per-app IRSA is on the roadmap" line from `eve-skillpacks/.../references/object-store-filesystem.md:188-190`; replace with the shipped trust model.

Acceptance: skillpack PR merged; cross-link to this plan from the system doc; staging operations runbook references scenario 52 for routine validation.

### Phase 8 — Migration follow-up + retirement of the shared user (later)

Not in scope for this plan; tracked as a separate bead. Once every staging env has migrated and the `shared` fallback has been unused for >30 days:

1. Delete `aws_iam_user.app_buckets` and `aws_iam_access_key.app_buckets` in Terraform.
2. Remove `EVE_APP_STORAGE_*` envs from the worker overlay.
3. Remove `SharedKeyAppCredentialProvisioner` and the `EVE_APP_STORAGE_*` resolution path from the deployer (keep `MinioStaticKeyAppCredentialProvisioner` for local k3d).
4. `isolation: shared` becomes a manifest-validation error: "shared-mode app bucket isolation is retired; remove the `isolation` key or set it to `auto` / `irsa`."

---

## Code Touch Points

**eve-horizon (this plan):**

- `packages/shared/src/schemas/manifest.ts` — add `isolation` to `ObjectStoreConfigSchema`.
- `packages/shared/src/schemas/environment.ts` — add `isolation_mode`, `iam_role_arn`, `iam_role_name`, `service_account` to `EnvStorageBucketInfoSchema`.
- `packages/db/migrations/00102_storage_buckets_isolation.sql` — new columns (next free number; current head is `00101_managed_db_extensions.sql`).
- `packages/db/src/queries/storage-buckets.ts` — extend `UpsertStorageBucketInput`, `upsert`, stale-row pruning, and env delete cleanup.
- `apps/worker/src/deployer/app-credential-provisioner/{types,factory,shared-key,minio-static-key,aws-irsa,iam-client}.ts` — new module.
- `apps/worker/src/deployer/app-credential-provisioner/__tests__/*` — unit coverage.
- `apps/worker/src/deployer/deployer.service.ts` — add env-wide bucket planning/binding; rewrite per-service bucket env injection to consume the plan; add `serviceAccountName` and binding-hash rendering for Deployments and Job pods; wire teardown in `deleteEnvironment`.
- `apps/worker/src/deployer/deployer.module.ts` — provide the factory.
- `apps/worker/src/deployer/__tests__/deployer-object-store-buckets.spec.ts` — extend with isolation-mode coverage.
- `apps/api/src/environments/env-diagnostics.service.ts` — surface new fields.
- `tests/manual/scenarios/52-app-bucket-iam-isolation.md` — new scenario.
- `tests/manual/scenarios/26-object-store.md` — relax diagnose expectations to include `isolation_mode`.
- `tests/manual/README.md` — register scenario 52.
- `docs/system/object-store-and-org-filesystem.md` — trust-model update.

**deployment-instance-repo:**

- `terraform/aws/main.tf` — extend `api_storage` policy with `ManageAppBucketRoles`.
- `terraform/aws/outputs.tf` — output `oidc_provider_arn` / `oidc_provider_url` if the overlay generation path needs them.
- `k8s/overlays/aws-eks/worker-deployment-patch.yaml` — add `EVE_OIDC_PROVIDER_ARN` / `EVE_OIDC_PROVIDER_URL`.

**eve-skillpacks:**

- `eve-work/eve-read-eve-docs/references/object-store-filesystem.md` — shipped trust model.
- `eve-work/eve-read-eve-docs/references/manifest.md` — document `isolation` knob.
- `eve-work/eve-read-eve-docs/references/deploy-debug.md` — fail-fast troubleshooting entry.

---

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Worker IAM blast radius. New `iam:CreateRole`/`PutRolePolicy` perms widen the worker's surface. | Scope by `Resource: arn:aws:iam::*:role/${var.name_prefix}-app-*` exactly. No `iam:PassRole`. No managed-policy attach. Validated via `aws iam simulate-principal-policy` in Phase 4 acceptance. |
| Public buckets look like an isolation failure because any app can read public objects. | Scenario 52's cross-app deny check uses `visibility: private`. Docs explicitly state `visibility: public` permits anonymous `GetObject`; IRSA still blocks list/write/admin access. |
| Role name length collisions. AWS IAM role names are capped at 64 chars; long slugs overflow. | Deterministic 16-char hash fallback, recorded as `iam_role_name` in `storage_buckets` so diagnose / cleanup remain unambiguous. If a collision ever happens, the second deploy fails closed (`CreateRole` returns `EntityAlreadyExists` and trust policy `:sub` mismatch). |
| OIDC race on cluster recreate. If the EKS OIDC provider is replaced, every existing role's trust policy now references a dead provider ARN. | The provisioner's `ensureForEnv` always calls `updateAssumeRolePolicy` on existing roles, so the next deploy heals. A short staging runbook entry covers "after cluster rebuild, redeploy all envs with object buckets." |
| SA annotation changes without a pod rollout. Existing pods do not get new IRSA env/token projection if only the ServiceAccount annotation changes. | Add `eve.app_bucket_binding_hash` to the pod template. Any role ARN/mode/bucket-set change changes the Deployment template and forces a rollout. |
| SA-before-pod ordering. If the pod starts before the SA has the role annotation applied, the SDK falls back to no creds and `PutObject` 403s. | Emit the ServiceAccount document before Deployment documents in `manifestToApply`; `K8sService.applyManifest` applies documents sequentially. The K8s admission controller injects the projected token at pod-start time. |
| Stale roles after env delete failure. Worker crashes between `delete namespace` and `delete role`. | `removeForEnv` is idempotent and called before namespace delete; zero-bucket redeploy also removes the role. A reconciler bead (out of scope) can periodically GC `demo-app-*` roles whose tag `eve:env` no longer matches any live env. |
| Operator manually edits the role outside Terraform. Inline policy drift. | The provisioner always full-replaces the inline policy on every deploy. Manual edits survive only until the next deploy, which is the desired behavior. |
| Manifest pins `isolation: irsa` and an operator runs the same manifest in a non-EKS env (or one missing OIDC env). | Fail fast with structured message; no partial roll, no rollback needed. Documented in `references/deploy-debug.md`. |
| Existing presigned URLs survive a mode switch. URL minted under shared key remains valid until S3 expiry. | Documented; not actively rotated. Apps that need hard cutover can shorten presign expiry before flipping the manifest. |
| Worker boot fails because IAM probing needs broader list permissions. | Do not probe with `iam:ListRoles`. Boot availability is config-based; IAM `AccessDenied` is raised from `ensureForEnv` before any app Deployment is applied, and the error names the missing permission/action. |
| Audit needs name → role traceability. | `storage_buckets.iam_role_arn` and IAM tags (`eve:org`, `eve:project`, `eve:env`) make AWS CloudTrail queries trivially filterable. |

## Rollback

Each phase rolls back independently:

- Phase 1 (schema/DB): reverting the migration drops only isolation metadata columns; physical bucket records and bucket data remain. Re-apply the migration before deploying IRSA code again.
- Phase 2 (abstraction + shared/minio impls): a behavior-preserving refactor. Reverting restores the inline implementation.
- Phase 3 (AWS IRSA impl): reverting disables `irsa` mode. Envs with `isolation: auto` can fall back to `shared` (or `minio-static-key`) on next deploy if the fallback is configured; envs pinned to `isolation: irsa` fail fast until the manifest is changed. App pods previously running with no static creds will fail on next pod restart; the rollback runbook must include `eve env deploy` for every IRSA-mode env.
- Phase 4 (infra): reverting the `ManageAppBucketRoles` statement breaks role creation for new envs; existing roles continue working until their next reconcile. Reverting the OIDC env vars flips the provisioner to `available: false` immediately.
- Phase 5 (k3d scenario): docs only.
- Phase 6 (staging verification): docs only.
- Phase 7 (docs/skillpacks): docs only.

## Verification Checklist

- [ ] Phase 1 schema + migration merged; `storage_buckets` table has `isolation_mode`, `iam_role_arn`, `iam_role_name`, `service_account_name`, and `service_account_namespace`.
- [ ] Phase 2 abstraction merged; existing scenario 26 still passes on local k3d unchanged.
- [ ] Phase 2 multi-service aggregation test proves one env policy includes all desired buckets and stale bucket rows are pruned.
- [ ] Phase 3 AWS IRSA impl merged; mocked-IAM unit tests cover ensure/remove/redeploy/long-slug-hash and binding-hash rollout annotation.
- [ ] Phase 4 worker IAM policy extended; `simulate-principal-policy` returns `Allowed` for `iam:CreateRole` on the app-role prefix only.
- [ ] Phase 4 worker pod has `EVE_OIDC_PROVIDER_ARN` and `EVE_OIDC_PROVIDER_URL` set.
- [ ] Phase 5 scenario 52 passes on local k3d:
  - [ ] `isolation: auto` (no key) on k3d → `minio-static-key`, no IAM call.
  - [ ] `isolation: irsa` on k3d → fail-fast with structured error, no pod rolled.
  - [ ] `isolation: shared` on k3d → unchanged static-key behaviour.
  - [ ] `eve env delete` is clean under every mode.
- [ ] Phase 6 staging verification:
  - [ ] Two apps with `isolation: auto` get distinct roles; SAs annotated with role ARN.
  - [ ] Cross-app `s3 ls` / `s3 cp` against private buckets returns `AccessDenied` in both directions.
  - [ ] App role cannot touch `demo-eve-internal`, `demo-eve-org-*`, and cannot run bucket-admin actions.
  - [ ] `eve env delete` removes the IAM role; the other env is unaffected.
  - [ ] Migration `shared` → `auto` (IRSA) and back works without data loss.
- [ ] Phase 7 docs and skillpacks updated; "trust model" paragraph reflects per-app IRSA as the default.
- [ ] External spec 004 status flipped from `requested` to `shipped` with a link to this plan and to scenario 52 evidence.

---

## Open Questions

1. **OIDC provider sourcing.** Read from Terraform output and bake into the worker overlay as static env vars (current approach), or expose via a ConfigMap so cluster recreate doesn't need an overlay edit? Recommendation: ConfigMap with a Terraform-generated value; defer to Phase 4 PR review.
2. **IAM role tag schema.** Standardize on `eve:org`, `eve:project`, `eve:env`, `eve:managed-by` — but should we also tag with `eve:created-at` for GC? Recommendation: yes; cheap.
3. **Localstack vs mocked-SDK for integration tests.** Localstack gives real round-tripping but adds CI cost. Recommendation: mocked-SDK for unit tests; defer real round-trip coverage to the staging Phase-6 evidence.
4. **Behavior when bucket list is empty but `isolation: irsa` is set.** Provision a role with an empty policy, or skip entirely? Recommendation: skip (no buckets ⇒ no role); if a previous deploy had buckets, remove the old role and prune storage rows. `eve env diagnose` shows no `storage_buckets` entries for that env.
5. **Per-service vs per-env role scoping.** v1 issues one role per env covering all services in that env. If a tenant needs per-service isolation later (e.g., a worker service vs a public-facing api in the same env), v2 can hash service name into the role name. Out of scope here.
6. **`STORAGE_AUTH_MODE` env var name.** App teams may already have `AWS_*` envs in their containers. Should we manually inject `AWS_ROLE_ARN` / `AWS_WEB_IDENTITY_TOKEN_FILE`, or rely on EKS IRSA projection? Recommendation: inject only `AWS_REGION` plus `STORAGE_AUTH_MODE=irsa`; EKS injects role/token envs from the annotated ServiceAccount and manual duplication risks drift.
7. **Reconciliation cadence.** Should the worker periodically reconcile every IRSA role against the live `storage_buckets` table, or only at deploy time? Recommendation: deploy-time only for v1; a separate "IRSA reconciler" bead can add periodic sweep if drift becomes a problem.
