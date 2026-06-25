# App Object Bucket Per-App IRSA Plan

> **Status**: Draft
> **Last Updated**: 2026-05-05
> **Origin**: Follow-up to `docs/plans/app-object-bucket-credentials-plan.md`

## Problem

The staging app-bucket credential stopgap uses one shared IAM user scoped to the
deployment app-bucket prefix (`demo-eve-app-*`). That prevents access to platform
internal buckets and org filesystem buckets, but it does not isolate app buckets
from each other.

Production-grade object-store buckets need app-specific AWS credentials without
static keys in pod env vars.

## Goal

Each deployed environment that declares `x-eve.object_store.buckets` should run
under a Kubernetes ServiceAccount annotated with an IAM role scoped only to that
environment's physical app bucket names.

## Proposed Shape

1. Add `EVE_APP_BUCKET_AUTH_MODE=static|irsa`.
2. Keep `static` as the local/staging compatibility path.
3. For `irsa`, have the deployer create or reconcile a namespace-local
   ServiceAccount for the service before rendering the Deployment.
4. Provision or assign an IAM role whose S3 policy covers only the physical
   bucket names for `(org, project, env, service)`.
5. Annotate the ServiceAccount with the IAM role ARN.
6. Skip `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` injection in
   IRSA mode; inject endpoint, region, and bucket name vars only.
7. On env delete, remove app ServiceAccounts and retire unused IAM role bindings.

## Design Work

- Decide whether IAM roles are created dynamically by the platform or allocated
  from a Terraform-managed pool.
- Define naming and quota limits for roles, policies, and ServiceAccounts.
- Define teardown behavior for renamed buckets, deleted services, and env delete.
- Add diagnostics that report auth mode and ServiceAccount/role binding state.
- Add a migration path from shared static credentials to per-app IRSA without
  breaking existing app deployments.

## Verification

- App pod can `PutObject`/`GetObject` only in its declared bucket.
- App pod cannot access another app/env bucket under the same deployment prefix.
- App pod cannot run bucket-admin actions (`CreateBucket`, `PutBucketPolicy`,
  `PutBucketCors`, `DeleteBucket`).
- Worker still provisions buckets through its platform IRSA role.
- Env delete removes Kubernetes resources and leaves IAM in the expected state.
