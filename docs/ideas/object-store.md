# Object Store: Large Asset Storage and Public URL Access

> Status: Superseded by plan
> Last Updated: 2026-02-25
>
> **Implementation plan**: `docs/plans/object-store-and-fs-plan.md`
>
> Related:
> - `docs/plans/org-fs-sync-api-cli-spec.md` (org filesystem sync)
> - `docs/system/deployment.md` (K8s runtime, namespaces)
> - `docs/system/manifest.md` (services, environments, pipelines)
> - `docs/system/secrets.md` (secrets injection, interpolation)
> - `docs/ideas/platform-resource-plane.md` (resource classes, billing)
> - `docs/ideas/agent-memory-platform-features.md` (storage primitives)

## The Problem

Eve Horizon has three tiers of storage today:

| Tier | Primitive | Backed By | Limits |
|------|-----------|-----------|--------|
| Text/docs | Org documents | PostgreSQL | 1MB/doc max |
| Structured data | Managed databases | PostgreSQL | Relational only |
| Binary metadata | Job attachments | PostgreSQL | Reference only |

**What's missing**: binary objects — images, videos, PDFs, build artifacts,
model weights, dataset files. Apps that need to store and serve user-uploaded
content today have two bad options: stuff it in Postgres (wrong tool) or
manage their own cloud bucket (breaks the managed platform contract).

The org filesystem has the same gap: it syncs text beautifully but has no
answer for large binary assets that should be reachable via an HTTPS URL.

---

## Design Goals

1. **S3-compatible everywhere.** Any S3 SDK works against Eve's object store.
   Apps don't learn a new API; they set an endpoint and credentials.
2. **Manifest-driven.** Declare a bucket in `.eve/manifest.yaml`; the platform
   provisions it and injects credentials. Same model as managed databases.
3. **Presigned URLs as the serving primitive.** Private by default. Apps issue
   time-limited presigned URLs server-side; browsers download directly from
   the store — no proxying, no bottleneck.
4. **Public paths when needed.** Buckets or prefixes can be marked
   `public-read` for CDN-served content without per-request signing.
5. **Org filesystem binary backend.** Large files in the org filesystem route
   to object storage; small text files stay in Postgres for search and
   versioning. The split is invisible to CLI users.
6. **Platform-issued share tokens.** For org filesystem paths, the API issues
   opaque short-lived tokens that resolve to presigned URLs — adding
   revocation on top of S3's bearer-token model.

---

## Backend Strategy

Eve uses **MinIO** for self-hosted deployments (k3d, staging). MinIO is
S3-compatible, Kubernetes-native, open source, and supports multi-tenancy
via bucket policies and service accounts.

For cloud deployments, the object store is a configuration swap:

| Deployment | Backend | Why |
|------------|---------|-----|
| Local (k3d) | MinIO (in-cluster) | No external deps, air-gapped |
| Staging | MinIO or AWS S3 | Platform config choice |
| Production | AWS S3 / Cloudflare R2 / Tigris | Scale, global CDN, no egress fees |

The entire platform talks S3 protocol. Swapping backends is a platform config
change — no code changes in apps or Eve services.

**Tigris** is worth noting as the cloud-first choice: globally distributed,
S3-compatible, zero egress fees, and objects are automatically placed close
to users — properties that matter for video and image serving.

---

## Tenancy Model

One MinIO cluster for the platform. Multi-tenancy via namespaced bucket policies:

```
Platform buckets
├── eve-internal/                    # Platform-only (builds, job files)
│   ├── build-artifacts/
│   ├── job-attachments/
│   └── runner-cache/
│
└── eve-org-{orgSlug}/               # Per-org bucket
    ├── fs/                          # Org filesystem binary objects
    │   └── (mirrors org fs tree)
    └── projects/
        └── {projectSlug}/
            └── envs/
                └── {envName}/
                    └── {bucketName}/  # App bucket
```

Each org gets a dedicated bucket with an IAM policy that scopes access to its
prefix. Apps get per-environment service accounts with minimal permissions
(read/write to their bucket prefix only).

---

## Part 1: App Object Stores

### Manifest Declaration

```yaml
# .eve/manifest.yaml
services:
  api:
    build:
      context: ./apps/api
    x-eve:
      ingress:
        public: true
        port: 3000

x-eve:
  storage:
    buckets:
      - name: uploads
        visibility: private          # private (presigned) | public (direct CDN)
        cors:
          origins: ["https://myapp.com", "http://localhost:3000"]
          methods: ["GET", "PUT", "DELETE", "HEAD"]
          max_age_seconds: 3600
        lifecycle:
          abort_incomplete_uploads_days: 7
          expire_noncurrent_versions_days: 30

      - name: avatars
        visibility: public           # served directly, no signing needed
        cors:
          origins: ["*"]
          methods: ["GET"]
```

### Injected Environment Variables

When a bucket is declared, the platform injects credentials into every service
in the environment:

```bash
# Injected automatically — no secrets.env needed
STORAGE_ENDPOINT=https://store.api.{orgSlug}-{projectSlug}-{env}.lvh.me
STORAGE_REGION=us-east-1
STORAGE_BUCKET_UPLOADS=uploads
STORAGE_BUCKET_AVATARS=avatars
STORAGE_ACCESS_KEY_ID={per-env generated key}
STORAGE_SECRET_ACCESS_KEY={per-env generated secret}

# Public bucket base URL (for visibility: public buckets)
STORAGE_PUBLIC_URL_AVATARS=https://assets.{orgSlug}-{projectSlug}-{env}.lvh.me
```

Apps use any S3 SDK with these variables. No Eve-specific client needed.

### Upload Flow (Private Bucket)

The canonical pattern for user uploads — the app server generates a presigned
PUT URL; the browser uploads directly. Zero bandwidth through the app server.

```typescript
// App server (Node.js / any language)
const s3 = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // required for MinIO
});

// Generate a presigned upload URL (server-side only)
app.post('/api/upload-url', async (req, res) => {
  const key = `user-${req.user.id}/avatar-${Date.now()}.jpg`;
  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: process.env.STORAGE_BUCKET_UPLOADS,
    Key: key,
    ContentType: 'image/jpeg',
    ContentLength: req.body.size,
  }), { expiresIn: 300 }); // 5 minute upload window

  res.json({ upload_url: url, key });
});

// Generate a presigned download URL
app.get('/api/files/:key', async (req, res) => {
  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: process.env.STORAGE_BUCKET_UPLOADS,
    Key: req.params.key,
  }), { expiresIn: 3600 }); // 1 hour access

  res.json({ url });
});
```

### Public Bucket Flow

For `visibility: public` buckets, objects are served directly via ingress.
No presigning needed — the app just constructs the URL:

```typescript
// Direct CDN URL — no signing
const avatarUrl = `${process.env.STORAGE_PUBLIC_URL_AVATARS}/${userId}/avatar.jpg`;
```

### CLI: App Bucket Management

```bash
# List buckets for a project environment
eve store buckets --project proj_xxx --env test

# Inspect a bucket
eve store buckets show uploads --project proj_xxx --env test

# Manually generate a presigned URL (for debugging)
eve store url uploads/user-123/report.pdf \
  --project proj_xxx --env test \
  --expires 1h \
  --json

# List objects
eve store ls --project proj_xxx --env test
eve store ls uploads/user-123/ --project proj_xxx --env test

# Upload a test file
eve store put ./test-image.jpg uploads/test/ --project proj_xxx --env test

# Download a file
eve store get uploads/user-123/report.pdf ./downloads/ --project proj_xxx --env test
```

---

## Part 2: Org Filesystem Binary Backend

Currently, the org filesystem stores file metadata (path, hash, size) in
Postgres and syncs via Syncthing. File *content* for text files is managed
by the sync engine. Large binary files have no home.

### The Split: Text vs Binary

The org filesystem gains a routing rule based on file type and size:

| File | Backend | Rationale |
|------|---------|-----------|
| `.md`, `.yaml`, `.txt` ≤ 1MB | PostgreSQL (`org_documents`) | Searchable, versioned, diff-friendly |
| Binary files (images, video, PDF, zip) | Object store (`fs/` prefix) | Right tool, no size limit |
| Large text ≥ 1MB | Object store | Postgres row limit |

This split is **invisible to CLI users**. `eve fs sync` and `eve store` both
work against the same logical namespace.

### Org Filesystem Object Store Layout

```
eve-org-{orgSlug}/
└── fs/
    ├── docs/
    │   └── report.pdf           # Binary file from org fs
    ├── assets/
    │   ├── logo.png
    │   └── demo.mp4
    └── shared/
        └── brand/
            └── hero.jpg
```

### Org FS Public Access: Platform Share Tokens

For org filesystem paths, the API adds a share endpoint. Rather than exposing
raw presigned S3 URLs (which are bearer tokens with no revocation), the
platform issues opaque tokens that resolve to presigned URLs on the backend.

**Why platform tokens over raw presigned URLs?**
- Revocable: delete the token, access is gone immediately
- Auditable: every resolution is logged
- URL-stable: the share URL doesn't change when the underlying S3 URL expires
- Human-readable: `https://api.eve.example.com/orgs/acme/fs/public/assets/logo.png?token=xxx`

#### Share API

```
POST /orgs/{orgId}/fs/share
```

Request:
```json
{
  "path": "/assets/demo-video.mp4",
  "expires_in": "7d",
  "label": "Demo video for sales team"
}
```

Response:
```json
{
  "token": "share_01Hxxx",
  "url": "https://api.eve.example.com/orgs/acme/fs/public/assets/demo-video.mp4?token=share_01Hxxx",
  "path": "/assets/demo-video.mp4",
  "expires_at": "2026-03-04T12:00:00Z",
  "label": "Demo video for sales team"
}
```

#### Token Resolution

```
GET /orgs/{orgId}/fs/public/{path}?token={token}
```

1. Validate token: exists, not expired, path matches.
2. Log access (path, token, requester IP, timestamp).
3. Resolve to S3 object.
4. **Redirect** to a short-lived presigned S3 URL (e.g., 5 min).

The redirect means browsers/CDNs cache efficiently while the platform retains
revocation control. A revoked token gets 403 before the S3 redirect.

#### List and Revoke Shares

```
GET /orgs/{orgId}/fs/shares            # List active share tokens
DELETE /orgs/{orgId}/fs/shares/{token} # Revoke a token
```

#### Public Paths (No Token)

For truly public content (brand assets, documentation), a path prefix can be
permanently opened:

```
POST /orgs/{orgId}/fs/public-paths
```

Request:
```json
{
  "path": "/assets/brand/",
  "label": "Brand assets — public"
}
```

Objects under a public path are served without a token:

```
GET /orgs/{orgId}/fs/public/assets/brand/logo.png
→ 302 to presigned URL (no token required)
```

### CLI: Org Filesystem Sharing

```bash
# Share a file (generates token URL)
eve fs share /assets/demo.mp4 --org org_xxx --expires 7d
# → https://api.eve.example.com/orgs/acme/fs/public/assets/demo.mp4?token=share_01Hxxx

# List active shares
eve fs shares --org org_xxx

# Revoke a share
eve fs revoke share_01Hxxx --org org_xxx

# Make a path publicly accessible (no token needed)
eve fs publish /assets/brand/ --org org_xxx --public

# List public paths
eve fs public-paths --org org_xxx
```

---

## Part 3: Platform Internal Use

The object store also replaces ad-hoc internal storage:

| Use | Current | With Object Store |
|-----|---------|-------------------|
| Build artifacts | Ephemeral BuildKit cache | `eve-internal/build-artifacts/` |
| Job attachments | PostgreSQL (reference only) | `eve-internal/job-attachments/` |
| Runner workspace cache | None | `eve-internal/runner-cache/` |
| Log archives | Ephemeral | `eve-internal/logs/` |

Job attachment URLs become presigned GET URLs into the internal bucket,
valid for the duration of the job result retention period.

---

## Database Schema

```sql
-- Platform-level storage configuration
CREATE TABLE storage_backends (
  id          TEXT PRIMARY KEY,               -- sb_xxx
  name        TEXT NOT NULL UNIQUE,           -- 'default', 'regional-eu'
  provider    TEXT NOT NULL,                  -- 'minio', 's3', 'r2', 'tigris'
  endpoint    TEXT NOT NULL,
  region      TEXT NOT NULL DEFAULT 'us-east-1',
  bucket_prefix TEXT NOT NULL DEFAULT 'eve', -- prefix for all platform buckets
  is_default  BOOLEAN NOT NULL DEFAULT false,
  config_json JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Provisioned buckets (platform + app buckets)
CREATE TABLE storage_buckets (
  id              TEXT PRIMARY KEY,             -- sbkt_xxx
  backend_id      TEXT NOT NULL REFERENCES storage_backends(id),
  org_id          TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  env_name        TEXT,
  name            TEXT NOT NULL,                -- logical name: 'uploads', 'avatars'
  physical_bucket TEXT NOT NULL,               -- actual S3 bucket name
  key_prefix      TEXT NOT NULL,               -- prefix within bucket
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  cors_json       JSONB NOT NULL DEFAULT '{}',
  lifecycle_json  JSONB NOT NULL DEFAULT '{}',
  access_key_id   TEXT,                        -- per-bucket service account key
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, env_name, name)
);

CREATE INDEX idx_storage_buckets_org ON storage_buckets(org_id);
CREATE INDEX idx_storage_buckets_project_env ON storage_buckets(project_id, env_name);

-- Org filesystem share tokens
CREATE TABLE org_fs_shares (
  id          TEXT PRIMARY KEY,               -- share_xxx
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  label       TEXT,
  created_by  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,                    -- NULL = never
  accessed_at TIMESTAMPTZ,
  access_count INT NOT NULL DEFAULT 0,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_fs_shares_org ON org_fs_shares(org_id);
CREATE INDEX idx_org_fs_shares_expires ON org_fs_shares(expires_at) WHERE revoked_at IS NULL;

-- Public path prefixes (no-token access)
CREATE TABLE org_fs_public_paths (
  id          TEXT PRIMARY KEY,               -- fspub_xxx
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  path_prefix TEXT NOT NULL,                  -- '/assets/brand/'
  label       TEXT,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, path_prefix)
);

CREATE INDEX idx_org_fs_public_paths_org ON org_fs_public_paths(org_id);
```

---

## Platform Deployment (MinIO in K8s)

MinIO runs as a StatefulSet in the `eve` namespace:

```yaml
# k8s/base/minio.yaml (sketch)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: eve-minio
  namespace: eve
spec:
  replicas: 1  # single-node for dev; scale to distributed for prod
  template:
    spec:
      containers:
        - name: minio
          image: minio/minio:latest
          args: ["server", "/data", "--console-address", ":9001"]
          env:
            - name: MINIO_ROOT_USER
              valueFrom:
                secretKeyRef:
                  name: minio-credentials
                  key: access-key
            - name: MINIO_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: minio-credentials
                  key: secret-key
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 50Gi
```

Ingress exposes MinIO at:
- `https://store.eve.lvh.me` — S3 API endpoint
- `https://store-console.eve.lvh.me` — MinIO console (admin only)

App buckets get per-environment subdomains:
- `https://assets.{orgSlug}-{projectSlug}-{env}.lvh.me` — public bucket CDN endpoint

For **cloud deployments**, MinIO is replaced by platform config pointing at
S3/R2/Tigris. The ingress routes remain identical from the app's perspective.

---

## Implementation Phases

### Phase 0: Platform MinIO (Internal)

- Deploy MinIO to the `eve` namespace via k8s manifest.
- Route job attachments to MinIO (attachment URLs become presigned GETs).
- Route build artifacts to MinIO (replace ephemeral BuildKit cache).
- No app-facing API yet.

### Phase 1: App Object Stores

- `storage_backends` + `storage_buckets` migrations.
- Worker reads `x-eve.storage.buckets` from manifest.
- Per-environment bucket provisioning on deploy (create bucket, apply policy, create service account).
- Secrets injection: `STORAGE_*` env vars injected alongside other secrets.
- `eve store` CLI: `ls`, `put`, `get`, `url`, `buckets`.
- Integration tests: bucket creation, credential injection, presigned URL round-trip.

### Phase 2: Org Filesystem Binary Backend

- Org fs file routing: binary files → MinIO, text files → Postgres.
- `org_fs_shares` migration.
- `POST /orgs/{orgId}/fs/share` — issue share token.
- `GET /orgs/{orgId}/fs/public/{path}?token={token}` — resolve and redirect.
- `GET/DELETE /orgs/{orgId}/fs/shares` — list and revoke.
- `eve fs share`, `eve fs shares`, `eve fs revoke` CLI commands.
- Integration tests: share token lifecycle, revocation, expiry.

### Phase 3: Public Paths

- `org_fs_public_paths` migration.
- `POST/GET/DELETE /orgs/{orgId}/fs/public-paths` API.
- Public path resolution in the share resolver (no token required).
- Per-org public CDN endpoint via ingress.
- `eve fs publish`, `eve fs public-paths` CLI commands.
- Access logging (every public path hit logged to event spine).

### Phase 4: CDN and Production Hardening

- Cloudflare / nginx caching layer in front of public buckets.
- Lifecycle management: automatic expiry of incomplete uploads.
- Usage metering: `storage.gb_hours` usage records (feeds platform billing).
- Quota enforcement: max storage per org (from `org_budget_limits`).
- Multi-region object replication for Tigris/R2 deployments.

---

## Security Model

**Default deny.** Storage follows the platform's existing access model:

- App buckets: credentials are scoped to the project environment. A service account in `proj-a/env-test` cannot read `proj-b/env-prod`.
- Org filesystem: read/write gated by `orgs:read` / `orgs:write` as today.
- Share tokens: any org member can create a share; only `orgs:admin` can revoke another member's shares.
- Public paths: only `orgs:admin` can publish or unpublish paths.
- Internal bucket: only platform services (worker, API) can read/write. No tenant access.

**Presigned URL security:**
- Short expiry for upload URLs (≤ 15 min).
- Longer expiry for download URLs (≤ 7 days), app-configurable.
- Platform share tokens add a revocation layer on top.
- IP pinning is not used — impractical for mobile/CDN scenarios.

---

## Open Questions

- **Binary threshold for org fs split.** 512KB? 1MB? Consider making it
  configurable per org or per sync link.

- **Single vs multi-bucket tenancy.** One bucket per org (with prefix
  namespacing) vs one bucket per project-environment. Single bucket is simpler
  to manage; per-environment bucket gives stricter IAM isolation and easier
  environment teardown (delete bucket = delete all env objects). Recommend
  per-environment bucket for isolation, with org-level bucket for org filesystem.

- **Presigned URL expiry on redirect.** When a share token resolves,
  how long should the redirect target (presigned URL) be valid? Short
  (5 min) for security; longer for better CDN cacheability. Recommend
  5 min for security; CDN can cache via signed cookies if needed.

- **Versioning.** MinIO supports S3-style versioning. Enable by default?
  Useful for accidental delete recovery but increases storage cost.
  Recommend: off by default, opt-in per bucket via manifest.

- **Tigris as default cloud backend.** Tigris's zero-egress-fee model is
  compelling for media-heavy workloads. Worth making it the recommended
  cloud backend over S3 in docs.

---

## The Elegant Invariant

The object store is not a new subsystem. It's the natural extension of two
existing platform primitives:

- **Managed databases** → **Managed buckets**: same manifest pattern, same
  credential injection, same lifecycle.
- **Org documents** → **Org filesystem objects**: same path namespace, same
  sync model, same CLI. Text stays in Postgres; binaries go to S3. The
  platform decides; apps and agents don't care.

The presigned URL pattern means the app server only handles metadata (generate
URL, record key in DB); browsers talk directly to the store. This is the
correct architecture: the bottleneck (large binary transfer) bypasses the app
server entirely.
