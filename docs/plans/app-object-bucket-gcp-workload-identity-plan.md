# App Object Bucket GCP Workload Identity Plan

> **Status**: Eve core implemented behind `x-eve.object_store.isolation: workload-identity`; template wiring and live GKE verification pending
> **Last Updated**: 2026-11-05
> **Predecessors**:
> - [`app-object-bucket-credentials-plan.md`](./app-object-bucket-credentials-plan.md) — the shared app key (`shared`).
> - [`app-object-bucket-per-app-irsa-plan.md`](./app-object-bucket-per-app-irsa-plan.md) — per-env isolation on AWS (`irsa`). Its non-goals deferred "GCP / Workload Identity" to a later `AppCredentialProvisioner`; this is it.

## Problem

On GCP an app that declares `x-eve.object_store.buckets` can only use
`shared` mode: one HMAC key, held by one Google service account, injected into
every app on the deployment. The key is scoped to the app bucket prefix, but
any app can read and write every other app's buckets, and the key is
long-lived. AWS has `irsa` for per-env isolation without keys; GCP has nothing
equivalent, so `auto` fails outright on a GKE cluster without
`EVE_APP_STORAGE_*` keys.

Separately, `visibility: public` buckets get an `allUsers` objectViewer grant.
Organisations that enforce domain-restricted sharing
(`iam.allowedPolicyMemberDomains`, part of Google's secure-by-default
organisation policies) or the managed `iam.managed.allowedPolicyMembers`
constraint refuse that grant, and the deploy failed with the bare 4xx of the
IAM call.

## Constraints

1. **S3 API needs HMAC on GCS.** The XML API accepts SigV4 only with an HMAC
   key, and HMAC keys belong to a Google service account (GSA). An app that
   speaks S3 therefore needs a static key; a keyless mode means the app uses
   the GCS JSON API through the Google client libraries with ambient
   credentials. That is an app contract change, unlike `irsa`, where AWS SDKs
   pick up the web identity token unchanged.
2. **The worker's IAM is being narrowed.** The infra template is moving the
   platform storage identity from project-wide `storage.admin` to bucket
   permissions on Eve's own prefixes, with bucket IAM (`getIamPolicy`,
   `setIamPolicy`) only on the app bucket prefix. Creating GSAs needs
   `iam.serviceAccounts.create` on the project, which cannot be narrowed by
   name; minting HMAC keys needs project-level `storage.hmacKeys.create`,
   which works for any GSA in the project.
3. **GSA quota.** Projects default to 100 service accounts. One GSA per
   environment caps a deployment at roughly 100 bucket-using environments
   unless the operator raises the quota, and new GSAs are eventually
   consistent (bindings on a fresh GSA can fail for up to a minute).
4. **Signing.** V4 signed URLs need a signer: an HMAC key, or a GSA calling
   `signBlob` on itself.

## Options

| | Per-env isolation | App contract | New worker permissions | Lifecycle cost | App-side signed URLs |
| --- | --- | --- | --- | --- | --- |
| **A.** Per-env GSA, KSA impersonates it via Workload Identity | yes | GCS client libraries | create/delete GSAs (project), set IAM on those GSAs | GSA per env (quota, propagation delay, teardown) | yes, with `signBlob` on itself |
| **B.** Kubernetes SA as a direct IAM principal (Workload Identity Federation for GKE) | yes | GCS client libraries | none: bucket IAM on app buckets, already needed for public buckets | none: no Google-side object to create | no (resumable upload sessions instead) |
| **C.** Per-env GSA plus per-env HMAC key in a namespace Secret | yes | unchanged (S3 SDK, presigned URLs) | create/delete GSAs and HMAC keys (both project-wide) | GSA and key per env, key only readable at creation, rotation | yes |
| Status quo: one shared HMAC key | no | unchanged | none | one key to rotate | yes |

**Decision: B**, as a new mode `gcp-workload-identity`, selected with
`isolation: workload-identity`.

- It is the only option that adds no worker privilege. The worker already
  needs `storage.buckets.setIamPolicy` on app buckets to publish public ones;
  B uses exactly that, so it fits the narrowed template instead of fighting
  it. A and C both give the worker project-wide identity powers, and C's
  `hmacKeys.create` can mint a key for any GSA in the project.
- It is keyless. Nothing to store, leak or rotate; a removed env leaves no
  credential behind.
- It has no quota or propagation problem: principal identifiers are
  patterns, not resources, so a grant is valid the moment it is written.
- The cost is the app contract (GCS libraries, no app-side V4 signing). That
  is the same cost A would have, and it is opt-in per service, so no existing
  app changes behaviour.

C remains the right answer if S3-compatible isolation on GCP becomes a hard
requirement; it fits behind the same `AppCredentialProvisioner` seam and the
namespace Secret path that `shared` mode now uses. A is a later extension if
apps need to sign with their own identity.

## Design

### Identity and grants

- Pods of services that declare buckets run as `ServiceAccount/eve-app-<env id>`
  in the env namespace. Eve renders the ServiceAccount without annotations.
- Its principal is
  `principal://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<project-id>.svc.id.goog/subject/ns/<namespace>/sa/eve-app-<env id>`.
  Namespaces are derived from org, project and env names, which can be
  deleted and reused; the environment ID cannot, so a re-created environment
  is a different principal and inherits no grant left behind.
- The per-env boundary also needs each environment to stay out of other
  environments' namespaces. The deployer refuses to deploy into a namespace
  labelled for another environment, and the API keeps user-chosen namespaces
  under the project's own prefix (the namespace-ownership fix this branch
  builds on).
- The worker grants that principal `roles/storage.objectUser` (objects
  get/create/update/delete/list and multipart uploads; no bucket or IAM admin)
  on each of the env's buckets, through the same storage client that creates
  them. Grants are idempotent and leave every other binding untouched.

### Lifecycle

| Event | Action |
| --- | --- |
| Deploy | revoke recorded grants the new binding does not keep, ensure buckets, then add the env principal on each (bucket IAM needs the bucket to exist) |
| All buckets removed | revoke every recorded grant, then drop the rows |
| Env deleted | un-publish public buckets, revoke every recorded grant, drop rows; data stays |
| Switch to another mode, or member changes | the deploy revokes the recorded member from every bucket |

Each `storage_buckets` row records the member granted on its bucket
(`iam_member`). Revocation works from that record, whatever mode the env uses
now and whether or not this mode is still configured, and always runs before
the row is rewritten or dropped. If a revocation fails, the deploy or delete
fails with the rows intact, so the next deploy or delete retries it.

The binding hash (mode, principal, role, bucket set) is stamped on pod
templates as `eve.app_bucket_binding_hash`, so a bucket-set change rolls pods.
`storage_buckets.isolation_mode` records `gcp-workload-identity`; migration
`00109` widens the column's CHECK constraint and adds `iam_member`.

### Selection

| Input | Result |
| --- | --- |
| `isolation: workload-identity`, mode available | `gcp-workload-identity` |
| `isolation: workload-identity`, mode unavailable | deploy fails before any bucket call, with the reason |
| `isolation: auto` | unchanged (`irsa` → `minio-static-key` → `shared`), unless the worker sets `EVE_APP_BUCKET_AUTH_MODE=workload-identity`, which makes `auto` prefer this mode |

Available means: `EVE_GKE_WORKLOAD_IDENTITY_POOL` is set and well formed,
`EVE_APP_BUCKET_AUTH_MODE` is unset, `auto` or `workload-identity`, and the
worker's storage client is native GCS (`EVE_STORAGE_BACKEND=gcs` without
HMAC keys), which is the only client that can manage bucket IAM.

### App contract

Env vars: `STORAGE_ENDPOINT` (default `https://storage.googleapis.com`),
`STORAGE_AUTH_MODE=gcp-workload-identity`, `GOOGLE_CLOUD_PROJECT`,
`STORAGE_REGION` (when configured) and `STORAGE_BUCKET_<NAME>`. No key.

```ts
import { Storage } from '@google-cloud/storage';

const storage = new Storage(); // Application Default Credentials from the GKE metadata server
const bucket = storage.bucket(process.env.STORAGE_BUCKET_UPLOADS!);
await bucket.file('report.pdf').save(pdfBuffer);

// Browser upload without a signer: open a resumable session server-side and
// return the session URI; the browser PUTs the bytes to it.
const [sessionUri] = await bucket.file(key).createResumableUpload({ origin: appOrigin });
```

Apps that need presigned URLs from their own identity, or that only speak
S3, stay on `shared`.

### Worker configuration

| Variable | Purpose |
| --- | --- |
| `EVE_GKE_WORKLOAD_IDENTITY_POOL` | `projects/<number>/locations/global/workloadIdentityPools/<project-id>.svc.id.goog`; Terraform: `google_container_cluster.workload_identity_config.workload_pool` plus the project number |
| `EVE_APP_BUCKET_AUTH_MODE=workload-identity` | optional: `auto` prefers this mode |
| `EVE_STORAGE_BACKEND=gcs` | native client (no `EVE_STORAGE_ACCESS_KEY_ID`) |

The platform storage identity needs `storage.buckets.getIamPolicy` and
`storage.buckets.setIamPolicy` on the app bucket prefix, the permission public
buckets already need. Node pools must run the GKE metadata server
(`workload_metadata_config.mode = GKE_METADATA`), which Workload Identity
already requires.

## Public assets without `allUsers`

Eve cannot create load balancers, so the platform change is a clear failure,
plus documented paths:

- **Implemented:** when Google refuses the `allUsers` grant (domain-restricted
  sharing or the managed constraint), or S3 Block Public Access refuses a
  public policy, the deploy error names the policy and the alternatives
  instead of passing on the 4xx.
- **Keep the bucket private and serve through the app.** Works in every mode.
- **Presigned GET URLs** from apps in `shared` mode (HMAC signs SigV4 against
  the GCS XML API).
- **Allow `allUsers` for app buckets only.** An organisation administrator can
  exempt the app buckets (Google documents this with organisation-level tags
  and a conditional or custom constraint; the managed constraint does not
  accept `allUsers` directly), which keeps domain-restricted sharing
  everywhere else.
- **CDN backend bucket** (to verify on a live project): a global external
  Application Load Balancer with Cloud CDN in front of the bucket, with the
  Cloud CDN fill service account granted object read and signed requests
  where needed. This belongs in the infra template, not the platform.

## Rollout

- **Land the bucket ownership check first.** Without it `ensureBucket`
  adopts any existing bucket on a GCS 409, so a pre-created bucket in another
  project would be adopted and the env principal granted on it. This branch
  does not contain that fix.
- No behaviour change for existing deployments: `auto` resolves as before and
  no manifest uses the new value yet. Migration `00109` only widens a CHECK
  constraint and adds a nullable column.
- Template: set `EVE_GKE_WORKLOAD_IDENTITY_POOL` on the worker for GKE
  installs and keep bucket IAM on the app prefix in the storage role split.
- Docs: `docs/system/object-store-and-org-filesystem.md`; the public agent
  reference (`eve-skillpacks` manifest and object-store references) needs the
  new `isolation` value and the app contract above.

## Verification

Unit tests (offline, done): provisioner availability and reasons, binding
shape, idempotent grants and revocations, selection (`auto` stays put unless
opted in, explicit request fails fast), grant ordering after bucket creation,
revocation by recorded member (dropped bucket, mode switch, changed member,
all buckets removed, env deletion, failure keeps the rows), the env-scoped
principal, the ServiceAccount render,
GCS bucket IAM member edits, and the public-grant refusal messages.

Live, on a GKE cluster with Workload Identity (not done):

- [ ] Deploy two envs with `isolation: workload-identity`; each pod can write
      and read its own bucket with `@google-cloud/storage`.
- [ ] From env A, reading or writing env B's bucket returns 403.
- [ ] A pod in the same namespace under the `default` KSA gets 403.
- [ ] Removing a bucket from the manifest removes the principal from its IAM
      policy; deleting the env removes it from all.
- [ ] Confirm the organisation's domain-restricted sharing accepts
      `principal://` members (expected, but unverified); if not, document the
      managed-constraint allowance.
- [ ] Measure IAM propagation: a pod started right after the first grant may
      see 403 briefly; if so, add a readiness hint to the docs.
- [ ] Resumable upload session from a browser works against the private bucket.
- [ ] The refusal message appears for a `public` bucket under
      domain-restricted sharing.

## Open questions

1. Should `auto` eventually prefer this mode on GKE by default? Only once the
   reference apps and SDK helpers speak GCS natively.
2. Is an Eve-side signer worth adding (the API minting V4 URLs for app buckets
   with the platform identity, gated by the app's service token)? It would
   give keyless apps presigned downloads without option A's GSAs.
