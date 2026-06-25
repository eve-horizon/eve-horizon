# Object Store + Org Filesystem: Unified Storage Plan

> Status: Draft
> Last Updated: 2026-02-25
>
> Inputs:
> - `docs/ideas/object-store.md` (design exploration)
> - `docs/plans/org-fs-sync-api-cli-spec.md` (existing org fs spec, mostly preserved)
> - `docs/system/manifest.md` (manifest schema)
> - `docs/system/deployment.md` (K8s runtime, namespaces)
> - `docs/system/secrets.md` (secrets injection)
> - `docs/plans/client-deployment-and-infra-extraction-plan.md` (GCP overlay context)

## Brief

Current gaps:

1. Apps deployed on Eve still need a managed object storage path for larger binary
   assets (images, video, PDFs).
2. Org FS already tracks metadata in Postgres (links, devices, events, conflicts),
   but has no platform-side file content store. The CLI currently has control-plane
   commands but does not yet provide an upload/download daemon.

**Proposed solution**: add a platform-level object store and use it for:
1. App buckets (manifest-driven, per-environment, credential-injected)
2. Org filesystem content (augmenting current control-plane sync with presigned URL
   transfers)

The org filesystem control plane (devices, links, events, conflicts, gateway
tokens) stays mostly unchanged; the CLI/API transfer behavior should evolve in a
backwards-compatible way.

---

## Architecture

```
                        ┌─────────────┐
  Local CLI             │   Eve API   │
  eve fs sync  ──URL?──▶│             │──▶ Postgres (metadata)
               ──PUT──────────────────────▶ MinIO (presigned upload)
               ◀─GET─────────────────────── MinIO (presigned download)
                        │  /fs/...    │
  Agents               │  /store/... │──▶ MinIO (app buckets)
  Job workspace ──▶    │             │
                        └─────────────┘
                               │
                        Postgres (metadata,
                        events, search index)
                        org_documents ◀── async indexer
```

**Storage tiers:**

| Tier | Backend | What's here |
|------|---------|-------------|
| Object store | MinIO / S3 / GCS / R2 | Not yet provisioned in repo today; planned platform service |
| Postgres (metadata) | PostgreSQL | `org_fs_events`, `org_sync_devices`, `org_sync_links` currently exist; planned: `org_fs_objects`, `storage_backends`, `storage_buckets`, share/public tables |
| Postgres (search index) | PostgreSQL (`org_documents`) | Text file content, materialized from object store for full-text + vector search |

`org_documents` currently works via direct API writes (`/orgs/{orgId}/docs`). The
planned phase for org-fs content is to add asynchronous org-fs text indexing into
`org_documents`, not to remove existing behavior.

---

## What Changes vs Current State

### Transfer mode and backward compatibility

Current implementation:
```json
{ "sync_engine": "syncthing", "profile": "markdown_default", "gateway": { ... } }
```

Do not replace this to `s3` as a hard cutover until client migration is complete.
A compatibility-safe approach is:
- keep existing `sync_engine: "syncthing"` behavior today
- add presigned-URL path as an additive transfer mode (`sync_engine: "s3"` or similar) behind feature coverage

Suggested new response shape (future):
```json
{ "sync_engine": "s3", "store": { "endpoint": "...", "upload_url_ttl": 300 } }
```

The gateway token mechanism can support this additive flow: the CLI uses its link
gateway token
to call `/orgs/{orgId}/fs/upload-url` and `/orgs/{orgId}/fs/download-url`,
which return short-lived presigned URLs. The API remains the URL authority and
retains internal credentials.

### Preserved: all control plane APIs

Devices, links, events, conflicts, cursors, SSE streams — all unchanged.
`OrgFsEvent` gains one new optional field: `download_url` (presigned GET URL,
included when `event_type = file.created | file.updated`). Clients can use
it to download immediately rather than making a second round-trip.

### New: org_fs_objects table

Tracks the current state of objects in the org filesystem (one row per path,
upserted on every upload). This gives us a queryable snapshot without
walking S3:

```sql
CREATE TABLE org_fs_objects (
  id           TEXT PRIMARY KEY,           -- fsobj_xxx
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  storage_key  TEXT NOT NULL,              -- S3 object key
  content_hash TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
  deleted_at   TIMESTAMPTZ,               -- soft delete
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, path)
);
```

---

## Platform Storage: MinIO Deployment

MinIO runs as a StatefulSet in the `eve` namespace. For local dev (k3d),
the volume is a hostPath PVC. For staging and production, the volume is
a cloud block disk (EBS, persistent disk, etc.) or MinIO is replaced
entirely by the cloud provider's S3-compatible service.

```yaml
# k8s/base/minio.yaml (sketch — full manifest TBD in implementation)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: eve-minio
  namespace: eve
spec:
  replicas: 1
  serviceName: eve-minio
  selector:
    matchLabels:
      app: eve-minio
  template:
    spec:
      containers:
        - name: minio
          image: minio/minio:RELEASE.2024-12-18T13-15-44Z  # pin to a specific stable release; check https://github.com/minio/minio/releases
          args: ["server", "/data", "--console-address", ":9001"]
          env:
            - name: MINIO_ROOT_USER
              valueFrom:
                secretKeyRef: { name: minio-credentials, key: access-key }
            - name: MINIO_ROOT_PASSWORD
              valueFrom:
                secretKeyRef: { name: minio-credentials, key: secret-key }
          ports:
            - containerPort: 9000   # S3 API
            - containerPort: 9001   # Console
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 50Gi
```

**Ingress routes:**

| Host | Target | Purpose |
|------|--------|---------|
| `${storage_public_endpoint}` | MinIO :9000 | S3 API (internal + presigned URLs) |
| `${storage_console_endpoint}` | MinIO :9001 | Admin console |

**Platform configuration** — new env vars on the API service:

```bash
EVE_STORAGE_BACKEND=minio          # minio | s3 | gcs | r2
EVE_STORAGE_ENDPOINT=http://eve-minio.eve.svc.cluster.local:9000
EVE_STORAGE_PUBLIC_ENDPOINT=https://storage.internal.local
EVE_STORAGE_REGION=us-east-1
EVE_STORAGE_ACCESS_KEY_ID=<platform key>
EVE_STORAGE_SECRET_ACCESS_KEY=<platform secret>
EVE_STORAGE_ORG_BUCKET_PREFIX=eve-org
EVE_STORAGE_INTERNAL_BUCKET=eve-internal
```

For cloud deployments (staging, production), `EVE_STORAGE_BACKEND=s3`
(or `gcs`, `r2`) and the endpoint points to the cloud provider. No code
change — the S3 client handles all backends via protocol.

**GCS note**: Google Cloud Storage supports the S3-compatible XML API via
HMAC keys. Set `EVE_STORAGE_ENDPOINT=https://storage.googleapis.com` and
`EVE_STORAGE_BACKEND=gcs`. GCS buckets need to be in the same region as
the GKE cluster to avoid egress fees.

---

## Bucket Layout

```
Platform internal bucket: eve-internal
├── build-artifacts/
│   └── {orgSlug}/{projectSlug}/{buildId}/
├── job-attachments/
│   └── {orgSlug}/{jobId}/
└── runner-cache/

Per-org bucket: eve-org-{orgSlug}
├── fs/
│   └── (mirrors org fs path tree)
└── projects/
    └── {projectSlug}/
        └── envs/
            └── {envName}/
                └── {bucketName}/   ← app bucket
```

---

## Part 1: Org Filesystem Content Backend

**Current status**: this is planned work. Today, the CLI has link/event management
commands (`init`, `status`, `pause`, `resume`, `disconnect`, etc.), but no active
sync daemon loop.

### 1.1 Sync Protocol Change

The sync engine transitions from the current Syncthing-oriented management flow to an
additive, object-store-backed transfer mode.

**Write path (local → remote):**

```
1. CLI detects file change (fsevents / inotify)
2. CLI computes SHA-256 hash of the file content (client-side, before upload)
3. GET /orgs/{orgId}/fs/upload-url?path=/docs/report.md
   Headers: x-eve-internal-token: <link gateway token>
   Response: { upload_url: "${EVE_STORAGE_PUBLIC_ENDPOINT}/...", expires_at: "...", storage_key: "..." }
4. CLI PUT <file-bytes> directly to upload_url (presigned MinIO, bypasses API)
5. POST /internal/orgs/{orgId}/fs/events
   Body: { event_type: "file.updated", path: "/docs/report.md", content_hash: "sha256:...", size_bytes: 9024, storage_key: "..." }
   Response: OrgFsEvent with download_url included
```

**Read path (remote → local):**

```
1. CLI connects to SSE stream: GET /orgs/{orgId}/fs/events/stream?after_seq=<n>
2. Receives OrgFsEvent { event_type: "file.updated", path: "...", download_url: "...", ... }
3. CLI GETs download_url directly from MinIO (presigned GET, ~5 min TTL embedded in event)
4. CLI verifies SHA-256 of downloaded bytes against event.content_hash before writing
5. CLI writes content to local path
```

**Conflict resolution** should preserve existing behavior and continue to use hash
comparison plus `eve fs resolve`. If both control modes exist during migration,
prefer explicit mode flags over implicit behavior changes.

### 1.2 New API Endpoints

**Upload URL generation:**

```
GET /orgs/{orgId}/fs/upload-url?path={path}
Authorization: x-eve-internal-token: <link gateway token>
```

Response:
```json
{
  "upload_url": "https://${EVE_STORAGE_PUBLIC_ENDPOINT}/eve-org-acme/fs/docs/report.md?X-Amz-...",
  "storage_key": "fs/docs/report.md",
  "method": "PUT",
  "expires_at": "2026-02-25T12:05:00Z",
  "max_bytes": 524288000
}
```

**Note**: The client computes the SHA-256 hash locally before uploading and
sends it in the subsequent event ingest call. The API does not re-verify the
hash against S3 (best-effort integrity; a future hardening option is to embed
a `x-amz-checksum-sha256` constraint in the presigned URL).

**Download URL generation:**

```
GET /orgs/{orgId}/fs/download-url?path={path}
Authorization: Bearer <user token> | x-eve-internal-token: <link token>
```

Response:
```json
{
  "download_url": "https://${EVE_STORAGE_PUBLIC_ENDPOINT}/eve-org-acme/fs/docs/report.md?X-Amz-...",
  "storage_key": "fs/docs/report.md",
  "content_hash": "sha256:...",
  "size_bytes": 9024,
  "mime_type": "text/markdown",
  "expires_at": "2026-02-25T12:10:00Z"
}
```

`content_hash` and `size_bytes` are read from `org_fs_objects`, not S3.
Download URL TTL is 5 minutes (matching the TTL embedded in SSE events).

**Object list** (new endpoint, currently not exposed in the Syncthing flow):

```
GET /orgs/{orgId}/fs/objects?prefix={prefix}&limit={n}&after={last_path}
```

Response:
```json
{
  "data": [
    { "path": "/docs/report.md", "content_hash": "sha256:...", "size_bytes": 9024, "updated_at": "..." }
  ],
  "pagination": { "limit": 100, "next_after": "/docs/report.md" }
}
```

**`OrgFsEvent` schema change** — add optional fields:

```typescript
// New fields on existing OrgFsEvent (backwards-compatible)
download_url?: string;   // presigned GET URL, included for file.created / file.updated
storage_key?: string;    // S3 object key, for reference
```

### 1.3 Internal Event Ingest Change

The internal event endpoint `POST /internal/orgs/{orgId}/fs/events` gains:

```typescript
storage_key?: string;  // Optional for legacy flow; required for additive S3 mode on file.created/file.updated
// In additive mode, this enables upsert into org_fs_objects and storage_key-based URLs.
```

On ingest, the service:
1. Validates the path is within the link's scope (existing)
2. Upserts `org_fs_objects` with the new storage_key, hash, and size
3. If the file is text (`text/markdown`, `text/plain`, `application/yaml`, etc.),
   enqueues an indexing job → `org_documents` upsert (see §1.4)
4. Records the `org_fs_events` row (existing)
5. Returns the event with a short-lived `download_url` included

### 1.4 Org Documents Index Pipeline

`org_documents` gains org-fs-origin indexing in phase 2.

When a text file is uploaded to org fs:
1. API enqueues a background task: `{ org_id, path, storage_key, content_hash }`
2. Background worker fetches content from S3 (internal GET)
3. Upserts `org_documents` with path + content
4. `search_vector` regenerates automatically (existing GENERATED column)

Text file threshold: mime types in `{ text/markdown, text/plain, text/yaml,
application/yaml, application/json }` and size ≤ 512KB. Larger files and
binary files are indexed by metadata only (path, size, mime_type) — no
content in `org_documents`.

Agents continue using the same search behavior; org-fs text uploads become an
additional source that populates the same index asynchronously.

**Direct `org_documents` API writes still work.** Creating a document via
`POST /orgs/{orgId}/docs` writes to Postgres directly (no S3 involved).
The index pipeline runs only when content arrives via org fs sync.

### 1.5 Agent Access to Org Filesystem Files

Agents (running as jobs) can access org filesystem files without a local
device being online once transfer URLs and index ingestion are in place:

```bash
# In a job's prompt / agent script:
# GET /orgs/{orgId}/fs/download-url?path=/docs/spec.md
# → presigned URL → fetch content

# Or search via org_documents (text files only):
# GET /orgs/{orgId}/docs/search?q=authentication+flow
```

The `eve-agent-cli` can gain a workspace tool (`eve_fs_read(path)`) as a
future enhancement.

---

## Part 2: App Object Stores

**Current status**: no app-level object-store declarations are implemented yet.

### 2.1 Manifest Declaration

```yaml
# .eve/manifest.yaml

services:
  api:
    build: { context: ./apps/api }
    x-eve:
      ingress: { public: true, port: 3000 }
      object_store:
        buckets:
          - name: uploads
            visibility: private
            cors:
              origins: ["https://myapp.com", "http://localhost:3000"]
              methods: [GET, PUT, HEAD, DELETE]  # DELETE needed for multipart upload abort
              max_age_seconds: 3600
            lifecycle:
              abort_incomplete_uploads_days: 7

          - name: avatars
            visibility: public
```

### 2.2 Credential Injection

On `eve env deploy`, the worker reads `x-eve.object_store.buckets`, provisions
each bucket in MinIO (create bucket, apply CORS + lifecycle policy, create
a per-environment service account with scoped policy), and injects env vars:

```bash
# Injected into every service's environment alongside other secrets
STORAGE_ENDPOINT=$EVE_STORAGE_PUBLIC_ENDPOINT
STORAGE_REGION=us-east-1
STORAGE_ACCESS_KEY_ID=<per-env generated key>
STORAGE_SECRET_ACCESS_KEY=<per-env generated secret>

# Per-bucket vars
STORAGE_BUCKET_UPLOADS=eve-org-acme-myapp-test-uploads
STORAGE_BUCKET_AVATARS=eve-org-acme-myapp-test-avatars
STORAGE_FORCE_PATH_STYLE=true   # injected only when EVE_STORAGE_BACKEND=minio; omitted for s3/gcs/r2

# Public bucket direct URL (for visibility: public)
STORAGE_PUBLIC_URL_AVATARS=https://assets.storage.example.internal
```

**Note**: keep this extension as `x-eve.object_store` to avoid collision with
service `x-eve.storage` (currently PVC-focused).

**Note**: `STORAGE_FORCE_PATH_STYLE=true` is required for MinIO but MUST NOT
be injected for S3 (AWS deprecated path-style for new buckets) or GCS/R2.
The worker checks `EVE_STORAGE_BACKEND` at deploy time and conditionally
includes this variable.

Apps use any S3 SDK with these vars — no Eve-specific client.

### 2.3 App Bucket CLI

```bash
# List app buckets for a project environment
eve store buckets --project proj_xxx --env test

# Generate presigned URL (debugging / manual access)
eve store url uploads/user-123/photo.jpg --project proj_xxx --env test --expires 1h

# Browse objects
eve store ls --project proj_xxx --env test
eve store ls uploads/user-123/ --project proj_xxx --env test

# Upload / download for debugging
eve store put ./test.jpg uploads/tests/ --project proj_xxx --env test
eve store get uploads/user-123/photo.jpg ./local/ --project proj_xxx --env test
```

---

## Part 3: Org Filesystem Share Tokens

### 3.1 Share Token API

```
POST /orgs/{orgId}/fs/share
Authorization: Bearer <user token>
```

Request:
```json
{
  "path": "/assets/demo.mp4",
  "expires_in": "7d",
  "label": "Demo video for sales"
}
```

Response:
```json
{
  "token": "share_01Hxxx",
  "url": "https://api.example.internal/orgs/acme/fs/public/assets/demo.mp4?token=share_01Hxxx",
  "path": "/assets/demo.mp4",
  "expires_at": "2026-03-04T12:00:00Z",
  "label": "Demo video for sales"
}
```

**Token resolution** — public, no auth:
```
GET /orgs/{orgId}/fs/public/{path}?token={token}
```
1. Validate token (exists, not expired, not revoked, path matches)
2. Log access
3. Redirect 302 to presigned GET URL (5 min TTL)

**List and revoke:**
```
GET    /orgs/{orgId}/fs/shares          # List active shares
DELETE /orgs/{orgId}/fs/shares/{token}  # Revoke
```

### 3.2 Public Paths (No Token)

For permanently public content (brand assets, public docs):

```
POST /orgs/{orgId}/fs/public-paths
Body: { "path": "/assets/brand/", "label": "Brand assets" }
```

Objects under a public path are served token-free:
```
GET /orgs/{orgId}/fs/public/assets/brand/logo.png
→ 302 to presigned URL
```

### 3.3 CLI

```bash
# Share a file
eve fs share /assets/demo.mp4 --org org_xxx --expires 7d
# → https://api.example.internal/orgs/acme/fs/public/assets/demo.mp4?token=share_01Hxxx

# List active shares
eve fs shares --org org_xxx

# Revoke
eve fs revoke share_01Hxxx --org org_xxx

# Publish a path prefix (no-token public access for all objects under it)
eve fs publish /assets/brand/ --org org_xxx

# List public paths
eve fs public-paths --org org_xxx
```

---

## Database Migrations

### Migration 1: Platform storage backends

```sql
-- {next}_storage_backends.sql

CREATE TABLE storage_backends (
  id            TEXT PRIMARY KEY,            -- sb_xxx
  name          TEXT NOT NULL UNIQUE,        -- 'default', 'regional-eu'
  provider      TEXT NOT NULL,               -- 'minio', 's3', 'gcs', 'r2', 'tigris'
  endpoint      TEXT NOT NULL,
  public_endpoint TEXT,                      -- CDN/public URL base (may differ from API endpoint)
  region        TEXT NOT NULL DEFAULT 'us-east-1',
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_storage_backends_default
  ON storage_backends(is_default) WHERE is_default = true;  -- partial unique index; only one true allowed
```

**Note**: Credentials (`access_key_id`, `secret_access_key`) are NOT stored in
this table — they live in `EVE_STORAGE_*` env vars on the API service. The
table records topology (provider, endpoint, region) for display and multi-backend
routing; the API reads credentials from env at runtime.

### Migration 2: App storage buckets

```sql
-- {next+1}_storage_buckets.sql

CREATE TABLE storage_buckets (
  id              TEXT PRIMARY KEY,               -- sbkt_xxx
  backend_id      TEXT NOT NULL REFERENCES storage_backends(id),
  org_id          TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  env_name        TEXT,
  name            TEXT NOT NULL,                  -- logical: 'uploads', 'avatars'
  physical_name   TEXT NOT NULL,                  -- actual bucket name in MinIO/S3
  key_prefix      TEXT NOT NULL DEFAULT '',       -- prefix within physical bucket
  visibility      TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'public')),
  cors_json       JSONB NOT NULL DEFAULT '{}',
  lifecycle_json  JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, env_name, name)
);

CREATE INDEX idx_storage_buckets_org ON storage_buckets(org_id);
CREATE INDEX idx_storage_buckets_project_env ON storage_buckets(project_id, env_name);
```

### Migration 3: Org filesystem objects

```sql
-- {next+2}_org_fs_objects.sql

-- Tracks current content state of org fs paths (one row per path)
CREATE TABLE org_fs_objects (
  id            TEXT PRIMARY KEY,               -- fsobj_xxx
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  storage_key   TEXT NOT NULL,                  -- S3 object key
  content_hash  TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  deleted_at    TIMESTAMPTZ,                    -- soft delete
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, path)
);

CREATE INDEX idx_org_fs_objects_org ON org_fs_objects(org_id);
CREATE INDEX idx_org_fs_objects_org_prefix ON org_fs_objects(org_id, path text_pattern_ops);
CREATE INDEX idx_org_fs_objects_active ON org_fs_objects(org_id, updated_at DESC)
  WHERE deleted_at IS NULL;
```

### Migration 4: Org fs events — add storage_key

```sql
-- {next+3}_org_fs_events_storage_key.sql

ALTER TABLE org_fs_events
  ADD COLUMN storage_key TEXT;   -- S3 key, present for file.created / file.updated
```

### Migration 5: Share tokens and public paths

```sql
-- {next+4}_org_fs_shares.sql

CREATE TABLE org_fs_shares (
  id            TEXT PRIMARY KEY,               -- share_xxx
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  label         TEXT,
  created_by    TEXT NOT NULL,
  expires_at    TIMESTAMPTZ,                    -- NULL = never
  accessed_at   TIMESTAMPTZ,
  access_count  INT NOT NULL DEFAULT 0,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_fs_shares_org ON org_fs_shares(org_id);
CREATE INDEX idx_org_fs_shares_active ON org_fs_shares(org_id, expires_at)
  WHERE revoked_at IS NULL;  -- lookup active shares for an org; skip revoked

CREATE TABLE org_fs_public_paths (
  id            TEXT PRIMARY KEY,               -- fspub_xxx
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path_prefix   TEXT NOT NULL,                  -- '/assets/brand/'
  label         TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, path_prefix)
);

CREATE INDEX idx_org_fs_public_paths_org ON org_fs_public_paths(org_id);
```

---

## Service Architecture

### New: StorageService (apps/api/src/storage/)

Two cooperating classes, exposed as a single NestJS module:

```typescript
// StorageModule at apps/api/src/storage/storage.module.ts
// @Module({ providers: [StorageService, StorageAdminService], exports: [StorageService, StorageAdminService] })

@Injectable()
export class StorageService {
  private client: S3Client;  // @aws-sdk/client-s3; endpoint overridden for MinIO/GCS/R2

  // Object operations (S3 protocol — works for all backends)
  async getPresignedUploadUrl(bucket: string, key: string, opts: UploadUrlOpts): Promise<string>
  async getPresignedDownloadUrl(bucket: string, key: string, ttlSeconds: number): Promise<string>
  async getObjectMetadata(bucket: string, key: string): Promise<ObjectMetadata | null>
  async deleteObject(bucket: string, key: string): Promise<void>

  // Bucket management (S3 protocol — works for all backends)
  async ensureBucket(name: string, opts: BucketOpts): Promise<void>
  async setBucketCors(name: string, rules: CorsRule[]): Promise<void>
  async setBucketLifecycle(name: string, rules: LifecycleRule[]): Promise<void>
  async setBucketPublicReadPolicy(name: string): Promise<void>  // sets anonymous GET bucket policy
}

@Injectable()
export class StorageAdminService {
  // Service account / credential management — backend-specific:
  // - MinIO: uses MinIO Admin REST API (POST /minio/admin/v3/add-user, add-canned-policy, etc.)
  //   Client: minio-js Admin or raw HTTP calls to the admin API
  // - AWS S3: creates IAM user + access key, attaches inline policy
  // - GCS: creates HMAC key for an existing service account
  // - R2: uses Cloudflare API to create R2 API tokens
  // All return the same ServiceAccountCredentials shape regardless of backend.
  async createServiceAccount(name: string, policyScope: string): Promise<ServiceAccountCredentials>
  async rotateServiceAccount(name: string): Promise<ServiceAccountCredentials>
  async deleteServiceAccount(name: string): Promise<void>
}
```

`StorageService` is configured at startup from `EVE_STORAGE_*` env vars.
`forcePathStyle: true` is set on the S3 client only when
`EVE_STORAGE_BACKEND=minio`. `StorageAdminService` reads the same env vars to
determine which admin API to call.

### Modified: OrgFsSyncService

Additions:
- `getUploadUrl(orgId, path, linkToken)` → presigned PUT URL
- `getDownloadUrl(orgId, path, actor)` → presigned GET URL
- `listObjects(orgId, prefix, pagination)` → from `org_fs_objects`
- `upsertObject(orgId, path, storageKey, hash, size, mimeType)` → internal
- `createShare(orgId, path, opts, actorId)` → `org_fs_shares` insert
- `resolveShare(token)` → validate + redirect to presigned URL
- `listShares(orgId)` → list active shares
- `revokeShare(orgId, token, actorId)` → set revoked_at
- `createPublicPath(orgId, prefix, label, actorId)` → insert
- `listPublicPaths(orgId)` → list
- `deletePublicPath(orgId, id)` → delete
- `resolvePublicPath(orgId, path)` → check if path is under any public prefix

Existing methods and their signatures are unchanged.

### Modified: Worker (app bucket provisioning)

The worker's deployer (`apps/worker/src/deployer/deployer.service.ts`) is extended
to read `x-eve.object_store.buckets` and:

1. For each declared bucket, call `StorageService.ensureBucket(physicalName, opts)`
2. Apply CORS and lifecycle policies
3. Create or rotate a per-environment service account
4. Store credentials in Eve secrets for the project + env scope
5. The existing secrets interpolation then injects them as env vars

This follows the same pattern as managed Postgres credential injection.

---

## API Surface Summary

### New endpoints on `/orgs/{orgId}/fs/`

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `fs/upload-url` | link gateway token | Presigned PUT URL for a path |
| `GET` | `fs/download-url` | user or link token | Presigned GET URL for a path |
| `GET` | `fs/objects` | `orgfs:read` | List objects with pagination |
| `GET` | `fs/objects/{path}` | `orgfs:read` | Get object metadata |
| `POST` | `fs/share` | `orgfs:read` | Issue share token |
| `GET` | `fs/shares` | `orgfs:admin` | List active shares |
| `DELETE` | `fs/shares/{token}` | `orgfs:admin` | Revoke share token |
| `POST` | `fs/public-paths` | `orgfs:admin` | Publish a path prefix |
| `GET` | `fs/public-paths` | `orgfs:read` | List public paths |
| `DELETE` | `fs/public-paths/{id}` | `orgfs:admin` | Unpublish |
| `GET` | `fs/public/{path}` | none (public) | Resolve share token or public path → 302 |

### New endpoints on `/orgs/{orgId}/store/` (app buckets)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `store/buckets` | `projects:read` | List app buckets for org |

Project-scoped:
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/projects/{projectId}/envs/{envName}/store/buckets` | `projects:read` | List env buckets |
| `GET` | `/projects/{projectId}/envs/{envName}/store/url/{bucket}/{key}` | `projects:write` | Generate presigned URL for debugging |
| `GET` | `/projects/{projectId}/envs/{envName}/store/ls` | `projects:read` | List objects in bucket |

### Internal endpoint changes

`POST /internal/orgs/{orgId}/fs/events` gains `storage_key` field (optional
for backwards compat, required for `file.created` and `file.updated`).

---

## Implementation Phases

### Phase 0: Platform MinIO + Internal Use

**Goal**: Stand up MinIO in k3d as internal storage backing; no app-facing
object API yet.

**Work:**
- K8s manifests: MinIO StatefulSet, Service, Ingress (`$EVE_STORAGE_PUBLIC_ENDPOINT`)
- System secrets: `minio-credentials` secret in `eve` namespace
- `eh k8s secrets` updated to provision MinIO credentials
- `StorageService` NestJS module, injected into API
- `storage_backends` migration + seed the default backend record
- Job attachments: write to MinIO instead of Postgres blob (if applicable)
- Build artifacts: BuildKit configured to push layer cache to MinIO

**Acceptance**: `./bin/eh k8s deploy` brings up MinIO; `curl ${EVE_STORAGE_PUBLIC_ENDPOINT}/minio/health/live` returns 200.

---

### Phase 1: Org Filesystem Content Backend

**Goal**: Add presigned URL transport for org fs content while preserving existing
control-plane behavior and client compatibility.

**Work:**

*Migrations:*
- `org_fs_objects` table
- `org_fs_events.storage_key` column

*API (apps/api/src/org-fs-sync/):*
- `GET /orgs/{orgId}/fs/upload-url` endpoint + service method
- `GET /orgs/{orgId}/fs/download-url` endpoint + service method
- `GET /orgs/{orgId}/fs/objects` endpoint + service method
- Update internal event ingest: accept `storage_key`, upsert `org_fs_objects`
- Update `OrgFsEvent` type: add `download_url?` and `storage_key?` fields
- Update `OrgFsCreateLinkResponse.runtime`: expose a compat-safe signal for
  presigned transfer mode without removing existing `syncthing` default

*CLI (packages/cli/src/commands/fs.ts):*
- Implement a native watcher (for example, `chokidar`) for file change detection in
  the new transfer mode
- Implement upload flow: `get upload URL` → `PUT` → ingest event
- Implement download flow: SSE stream → download URL → write file
- `eve fs sync` daemon loop adopts the new transfer mode
- All existing `eve fs sync init|status|pause|resume|disconnect|mode|conflicts|resolve|doctor` commands unchanged in interface

*Shared types (packages/shared/):*
- `OrgFsUploadUrlRequest` / `OrgFsUploadUrlResponse` schemas
- `OrgFsDownloadUrlResponse` schema
- `OrgFsObjectListResponse` schema
- Update `OrgFsEvent` schema (add optional fields)
- Update `OrgFsCreateLinkResponse` schema

**Acceptance criteria:**
- `eve fs sync init --org ... --local ~/test-dir --mode two-way` works
- Upload a .md file locally → appears in org fs via `GET /fs/objects`
- Another CLI instance (pull-only mode) receives the event and downloads the file
- `eve job create` with an agent prompt that calls `eve_fs_read /path/to/file.md` returns the content

---

### Phase 2: Org Documents Index Pipeline

**Goal**: Text files uploaded to org fs are automatically indexed in
`org_documents` for agent search.

**Work:**

*Migration:*
- `org_fs_index_queue` table: `(id, org_id, path, storage_key, content_hash, created_at, locked_until, attempts)`
  — insert on ingest, delete on success. A periodic sweep retries failed items.
  No external queue dependency; DB polling is sufficient at current scale.

*API / background worker:*
- On `ingestInternalEvent` for `file.created` or `file.updated`:
  - If `mime_type` is in the text set and `size_bytes ≤ 524288`:
    - INSERT into `org_fs_index_queue` (idempotent upsert on `org_id + path`)
- NestJS `@Interval` processor (runs every 2s):
  - Claims rows from `org_fs_index_queue` (SELECT ... FOR UPDATE SKIP LOCKED, limit 10)
  - Fetches content from S3 via internal `GetObject` (no presigning — same cluster)
  - Upserts `org_documents` with `{ org_id, path, content, mime_type, source: 'orgfs' }`
  - Deletes processed rows; increments `attempts` and backs off on failure
- `org_documents` gains an optional `source` field: `'api' | 'orgfs'`

*Test:*
- Upload `report.md` via org fs sync
- `GET /orgs/{orgId}/docs/search?q=some+phrase+from+the+file` returns the document

**Acceptance criteria:**
- Text file uploaded via `eve fs sync` is searchable via `eve docs search` within ~5s
- Binary file (PNG) uploaded via `eve fs sync` does NOT appear in `eve docs`

---

### Phase 3: App Object Stores

**Goal**: Apps can declare buckets in the manifest and use S3 directly.

**Work:**

*Migrations:*
- `storage_buckets` table

*Worker (manifest processing):*
- Parse `x-eve.object_store.buckets` from manifest
- `StorageService.ensureBucket` for each declared bucket
- Create per-env service account, store credentials as Eve secrets
- Inject `STORAGE_*` env vars (same path as DB secrets injection)

*API:*
- `GET /projects/{projectId}/envs/{envName}/store/buckets`
- `GET /projects/{projectId}/envs/{envName}/store/url/{bucket}/{key}` (debug)
- `GET /projects/{projectId}/envs/{envName}/store/ls` (debug)

*Shared / manifest schema:*
- Add `x-eve.object_store.buckets` to manifest Zod schema + validation
- Type: `Array<{ name, visibility, cors?, lifecycle? }>`

*CLI:*
- `eve store buckets --project ... --env ...`
- `eve store url {bucket}/{key} --project ... --env ... --expires ...`
- `eve store ls --project ... --env ...`
- `eve store put {local} {bucket}/{key} --project ... --env ...`
- `eve store get {bucket}/{key} {local} --project ... --env ...`

**Acceptance criteria:**
- Deploy an app with `x-eve.object_store.buckets: [{ name: uploads, visibility: private }]`
- Service has `STORAGE_BUCKET_UPLOADS`, `STORAGE_ACCESS_KEY_ID`, etc. in its env
- App server generates a presigned PUT URL using those credentials → browser upload works
- `eve store ls --project ... --env ...` lists uploaded objects

---

### Phase 4: Share Tokens and Public Paths

**Goal**: Org filesystem files can be shared via HTTPS without platform auth.

**Work:**

*Migrations:*
- `org_fs_shares`, `org_fs_public_paths` tables

*API:*
- All endpoints in §3.1 and §3.2
- Public resolver: `GET /orgs/{orgId}/fs/public/{path}` — no auth guard,
  resolves share token or public path match, redirects to presigned URL

*CLI:*
- `eve fs share`, `eve fs shares`, `eve fs revoke`
- `eve fs publish`, `eve fs public-paths`

**Acceptance criteria:**
- `eve fs share /assets/demo.mp4 --expires 24h` returns a URL
- Accessing the URL in a browser downloads the file without auth
- `eve fs revoke <token>` makes the URL return 403 immediately
- `eve fs publish /assets/brand/` makes `logo.png` accessible at the public URL without a token

---

### Phase 5: Production Backend Swap

**Goal**: Staging uses S3 or GCS instead of MinIO. Configuration only.

**Work:**
- Document GCS HMAC key setup for GKE Workload Identity → `STORAGE_*` env vars
- Document AWS S3 backend config for staging
- `EVE_STORAGE_BACKEND=gcs` or `s3` → all code paths unchanged
- Add `storage_backends` record seeding to staging `system-secrets.env.local` equivalents
- Verify presigned URL generation works with GCS (slightly different signing params)

---

## Integration Tests

Add to `tests/integration/`:

- `org-fs-upload.test.ts`: upload file via presigned URL, ingest event, retrieve via download URL
- `org-fs-sync-daemon.test.ts`: full sync round-trip (upload on one side, receive on another)
- `org-fs-share.test.ts`: create share, access URL, revoke, verify 403
- `org-fs-index.test.ts`: upload .md file, wait for indexing, verify searchable in org_documents
- `app-buckets.test.ts`: deploy manifest with storage bucket, verify STORAGE_* vars injected,
  verify presigned upload/download round-trip

---

## Manual Test Scenario

**File:** `tests/manual/scenarios/26-object-store.md`

The scenario is structured in five phases that mirror the implementation
phases. Each phase is independently re-runnable — run only the failing
phase after a fix.

| Phase | Scenario Steps | What It Validates |
|-------|---------------|-------------------|
| 0 | Steps 1–2 | MinIO pod health, API storage config |
| 1 | Steps 3–8 | Upload URL → presigned PUT → event ingest → download URL → hash verify |
| 2 | Step 9 | Text file indexed in `org_documents` within 10s |
| 3 | Steps 10–11 | Manifest bucket → STORAGE_* injection → app presigned round-trip |
| 4 | Steps 12–14 | Share token, revoke enforcement, public path |

## Verification and Fix Loop

Iterate on the local k3d stack one phase at a time:

```bash
# 0. Ensure stack is up
./bin/eh k8s deploy

# 1. Run the phase you're implementing (e.g. Phase 0)
# Ask Claude: "Run scenario 26 Phase 0 (Steps 1-2)"

# 2. On failure — fix code, rebuild, redeploy
pnpm build
./bin/eh k8s-image push api   # or: worker, orchestrator
./bin/eh k8s deploy

# 3. Re-run the same phase
# Ask Claude: "Re-run scenario 26 Phase 0"

# 4. Once a phase is green, move to the next
```

**Phase 0** is the first gate — nothing else works without MinIO running
and `StorageService` initialized. Implement the k8s manifests and
`StorageModule` first, confirm Phase 0 green, then move to Phase 1.

**Phase sequence for implementation:**

```
Phase 0 → pnpm build + k8s deploy → run Steps 1-2
    ↓ green
Phase 1 → API endpoints + migrations + StorageService → run Steps 3-8
    ↓ green
Phase 2 → org_fs_index_queue + @Interval processor → run Step 9
    ↓ green
Phase 3 → Worker manifest parser + StorageAdminService → run Steps 10-11
    ↓ green
Phase 4 → Share tables + resolver endpoint → run Steps 12-14
    ↓ green → all phases pass → implementation complete
```

After all phases pass, run the full scenario in one shot as a regression:

```bash
# Ask Claude: "Run scenario 26 all phases"
```

---

## Open Questions

**Transfer mode migration**: `OrgFsCreateLinkResponse.runtime.sync_engine`
currently advertises `"syncthing"`. Moving to a presigned-URL mode should be
additive and backward compatible. Decision: add an explicit optional field
`transfer_mode: "syncthing" | "s3"` to the link response; keep the existing
field unchanged. The CLI switches behavior only when `transfer_mode: "s3"` is
present.

**Content indexing latency**: Best-effort within 10s for the integration test;
no hard production SLA (agents retry on search miss). Decision: DB-polled
`org_fs_index_queue` table (see Phase 2) — no new external queue dependency.

**MinIO single vs distributed mode**: Single-node MinIO for development;
cloud-managed S3/GCS for staging and production. MinIO distributed mode only
for on-premises deployments without cloud storage.

**Service account granularity**: Decision: one service account per environment
(not per bucket), with an IAM policy scoped to the environment prefix
(`eve-org-{orgSlug}/projects/{projectSlug}/envs/{envName}/*`). Reduces MinIO
IAM complexity while still providing deployment-level isolation.

**Share URL host strategy**: Use `EVE_API_URL` as the base for share token
URLs (e.g. `${EVE_API_URL}/orgs/{orgSlug}/fs/public/...`). The `orgSlug`
(not `orgId`) is used in public URLs for human readability. Ensure the
public resolver endpoint accepts both slug and ID for forward compatibility.

**Org storage quotas**: Not addressed in this plan. Future work: add a
`storage_quota_bytes` field to `orgs` and enforce it on upload URL generation
(reject if org total `size_bytes` in `org_fs_objects` would exceed quota).
