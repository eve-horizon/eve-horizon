# Scenario 52: App Bucket IAM Isolation

**Time:** ~20-30 minutes
**Parallel Safe:** No
**LLM Required:** No

Validates the per-environment app object bucket credential binding introduced
for `x-eve.object_store.isolation`.

Run this against local k3d first. Local k3d must resolve `auto` to
`minio-static-key`, explicit `shared` must keep static key behavior, and
explicit `irsa` must fail before rolling pods because local k3d has no AWS OIDC
provider. AWS staging adds the cross-app AccessDenied check once the staging
worker IAM/OIDC env is configured.

## Prerequisites

- Scenario 01 and 05 pass on the target cluster.
- `EVE_API_URL` is set.
- `$REPO_DIR` points to a git repo with the manifest change committed.
- The repo-local CLI is built if testing local changes:

```bash
pnpm -C packages/cli build
export EVE="$(pwd)/packages/cli/bin/eve.js"
```

If using an installed CLI instead:

```bash
export EVE=eve
```

## Phase 1: Local k3d Auto Isolation

Create or reuse a small app project with this service:

```yaml
services:
  api:
    image: nginx:alpine
    ports: [80]
    x-eve:
      object_store:
        isolation: auto
        buckets:
          - name: uploads
```

Deploy and inspect diagnostics:

```bash
export PROJ_ID=proj_xxx
export REPO_DIR=/path/to/app
$EVE env deploy test --project "$PROJ_ID" --ref HEAD --repo-dir "$REPO_DIR" --direct
$EVE env diagnose "$PROJ_ID" test --json \
  | jq '.storage_buckets[] | {name, physical_name, isolation_mode, iam_role_arn, service_account}'
```

Expected:

- Deploy succeeds.
- `isolation_mode` is `minio-static-key`.
- `iam_role_arn` and `service_account` are `null`.
- The app pod has `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`,
  `STORAGE_FORCE_PATH_STYLE=true`, and `STORAGE_BUCKET_UPLOADS`.

## Phase 2: Local Explicit IRSA Fails Fast

Change the same manifest to:

```yaml
x-eve:
  object_store:
    isolation: irsa
    buckets:
      - name: uploads
```

Deploy:

```bash
$EVE env deploy test --project "$PROJ_ID" --ref HEAD --repo-dir "$REPO_DIR" --direct
```

Expected:

- Deploy fails before rolling pods.
- The error includes `isolation mode 'irsa' is not available on this cluster`.
- No `ServiceAccount/eve-app` is created in the app namespace.

## Phase 3: Local Explicit Shared Static Keys

Change the manifest to:

```yaml
x-eve:
  object_store:
    isolation: shared
    buckets:
      - name: uploads
```

Deploy and inspect:

```bash
$EVE env deploy test --project "$PROJ_ID" --ref HEAD --repo-dir "$REPO_DIR" --direct
$EVE env diagnose "$PROJ_ID" test --json \
  | jq '.storage_buckets[] | {name, isolation_mode, iam_role_arn, service_account}'
```

Expected:

- Deploy succeeds.
- Local MinIO resolves explicit `shared` to `minio-static-key`.
- Static key env vars are present in the app pod.

## Phase 4: Stale Row Cleanup

Remove all `x-eve.object_store.buckets` entries from the manifest and deploy:

```bash
$EVE env deploy test --project "$PROJ_ID" --ref HEAD --repo-dir "$REPO_DIR" --direct
$EVE env diagnose "$PROJ_ID" test --json | jq '.storage_buckets'
```

Expected:

- Deploy succeeds.
- `storage_buckets` is empty for the env.
- The physical bucket is not deleted.

Delete the environment:

```bash
$EVE env delete test --project "$PROJ_ID" --force
```

Expected:

- The namespace is deleted.
- Storage bucket rows for the env remain empty.

## Phase 5: AWS Staging IRSA Isolation

Run only after staging has `EVE_OIDC_PROVIDER_ARN`,
`EVE_OIDC_PROVIDER_URL`, and the worker IAM permissions for the configured app
role prefix.

Deploy two apps in the same org with `isolation: auto` and different logical
bucket names. For each env:

```bash
$EVE env diagnose "$PROJ_ID" staging --json \
  | jq '.storage_buckets[] | {name, physical_name, isolation_mode, iam_role_arn, iam_role_name, service_account}'
```

Expected:

- `isolation_mode` is `irsa`.
- Each env has a different `iam_role_arn`.
- Pod env includes `STORAGE_AUTH_MODE=irsa` and does not include static storage
  access keys.
- From app A, `PutObject`/`GetObject` succeeds in app A's bucket.
- From app A, `GetObject` or `PutObject` against app B's bucket returns
  `AccessDenied`.
- From app A, bucket-admin actions such as `CreateBucket`, `PutBucketPolicy`,
  and `PutBucketCors` return `AccessDenied`.
