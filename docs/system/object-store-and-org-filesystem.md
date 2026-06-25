# Object Store & Org Filesystem

> Status: Current
> Last Updated: 2026-06-02

## Purpose

Documents Eve Horizon's unified storage layer: a platform-level **object store** (S3-compatible) that backs both **org filesystem** sync and **app object buckets**, plus the closely related **org docs** versioned document store and **Cloud FS** provider mounts. Together these primitives give orgs, agents, and deployed apps durable file storage, real-time sync, external cloud storage access, and queryable knowledge.

---

## Overview

```
                         ┌─────────────┐
  Local CLI              │   Eve API   │
  eve fs sync  ──URL?──▶ │             │──▶ Postgres (metadata)
               ──PUT──────────────────────▶ MinIO / S3 (presigned upload)
               ◀─GET────────────────────── MinIO / S3 (presigned download)
                         │  /fs/...    │
  Agents (warm pods)     │  /store/... │──▶ MinIO / S3 (app buckets)
  Job workspace  ──▶     │             │
                         └─────────────┘
                                │
                         Postgres (metadata,
                         events, search index)
                         org_documents ◀── async indexer
```

**Storage primitives:**

| Primitive | Scope | Backend | Use Case |
|-----------|-------|---------|----------|
| **Object Store** | Platform | MinIO / S3 / GCS / R2 | Binary file storage, presigned URL transfers |
| **Org Filesystem** | Org | Object store + Postgres event log | Multi-device sync, agent shared workspace |
| **Org Docs** | Org | Postgres (content in rows) | Versioned knowledge base, full-text search |
| **Cloud FS** | Org / Project | External provider APIs + Postgres mounts | Google Drive folders mounted into Eve |

**Relationship:** The object store is the storage engine. The org filesystem is a sync protocol built on top of it. Org docs is a separate Postgres-native document store that receives async indexing from org filesystem text files. Cloud FS is a provider bridge: mounted external folders stay in their provider, while Eve exposes them through provider-neutral APIs and CLI commands.

---

## Current (Implemented)

### Object Store (Storage Service)

The `StorageService` (`apps/api/src/storage/storage.service.ts`) wraps the AWS S3 SDK to provide a provider-agnostic storage layer.

**Supported backends** (all speak S3 protocol):

| Backend | Config Value | Notes |
|---------|-------------|-------|
| MinIO | `minio` | Local k3d dev; `forcePathStyle: true` |
| AWS S3 | `s3` | Cloud-native, virtual-hosted style |
| Google Cloud Storage | `gcs` | S3-compatible XML API via HMAC keys |
| Cloudflare R2 | `r2` | Zero-egress-fee alternative |
| Tigris | `tigris` | S3-compatible |

**Configuration (env vars on the API service):**

```bash
EVE_STORAGE_BACKEND=minio                      # Backend type
EVE_STORAGE_ENDPOINT=http://eve-minio:9000     # Cluster-internal endpoint
EVE_STORAGE_PUBLIC_ENDPOINT=https://storage.example.com  # External/CDN URL for presigned URLs
EVE_STORAGE_REGION=us-east-1
EVE_STORAGE_ACCESS_KEY_ID=<access-key>
EVE_STORAGE_SECRET_ACCESS_KEY=<secret-key>
EVE_STORAGE_ORG_BUCKET_PREFIX=eve-org           # Default: eve-org
EVE_STORAGE_INTERNAL_BUCKET=eve-internal        # Default: eve-internal
```

**Dual S3 clients:** The service initializes two clients — an **internal client** (cluster endpoint, for server-side operations like `getObject`) and a **presign client** (public endpoint, for generating URLs that external clients can reach).

**Core operations:**

| Method | Purpose |
|--------|---------|
| `getPresignedUploadUrl(bucket, key)` | Generate presigned PUT URL (5 min TTL, up to 500 MB) |
| `getPresignedDownloadUrl(bucket, key)` | Generate presigned GET URL (5 min TTL) |
| `getObject(bucket, key)` | Read object content server-side (cluster-internal) |
| `getObjectMetadata(bucket, key)` | HEAD request for content type, size, etag |
| `deleteObject(bucket, key)` | Delete single object |
| `ensureBucket(name)` | Create bucket if not exists (idempotent) |
| `setBucketCors(name, rules)` | Apply CORS configuration |
| `setBucketPublicReadPolicy(name)` | Allow anonymous reads on entire bucket |

**Bucket layout:**

```
eve-internal/                          # Platform-only
├── build-artifacts/{org}/{project}/{buildId}/
├── job-attachments/{org}/{jobId}/
└── runner-cache/

eve-org-{orgSlug}/                     # Per-org (one bucket per org)
├── fs/                                # Org filesystem objects
│   └── (mirrors org fs path tree)
└── projects/
    └── {projectSlug}/
        └── envs/
            └── {envName}/
                └── {bucketName}/      # App bucket
```

### Database Schema (Storage)

**`storage_backends`** — Tracks platform storage topology (migration `00066`).

```sql
CREATE TABLE storage_backends (
  id              TEXT PRIMARY KEY,        -- sb_xxx (TypeID)
  name            TEXT NOT NULL UNIQUE,    -- 'default', 'regional-eu'
  provider        TEXT NOT NULL,           -- 'minio' | 's3' | 'gcs' | 'r2' | 'tigris'
  endpoint        TEXT NOT NULL,
  public_endpoint TEXT,
  region          TEXT DEFAULT 'us-east-1',
  is_default      BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

Credentials live in env vars (`EVE_STORAGE_*`), not in this table.

**`storage_buckets`** — App-declared buckets from manifest `x-eve.object_store.buckets` (migration `00070`).

```sql
CREATE TABLE storage_buckets (
  id              TEXT PRIMARY KEY,          -- sbkt_xxx
  org_id          TEXT REFERENCES orgs(id),
  project_id      TEXT REFERENCES projects(id),
  env_name        TEXT,
  service_name    TEXT NOT NULL,             -- Component name in manifest
  name            TEXT NOT NULL,             -- Logical name: 'uploads', 'avatars'
  physical_name   TEXT NOT NULL,             -- Actual S3 bucket name
  visibility      TEXT DEFAULT 'private',    -- 'private' | 'public'
  cors_json       JSONB DEFAULT '{}',
  isolation_mode  TEXT,                       -- 'irsa' | 'shared' | 'minio-static-key'
  iam_role_arn    TEXT,                       -- IRSA role ARN when isolation_mode='irsa'
  iam_role_name   TEXT,
  service_account_name TEXT,
  service_account_namespace TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, env_name, service_name, name)
);
```

---

### Org Filesystem

The org filesystem provides **durable, synced shared storage** scoped to an organization. Devices (local machines), agents (warm pods), and the Eve API all share a unified file namespace backed by the object store.

#### Concepts

| Concept | Description | ID Prefix |
|---------|-------------|-----------|
| **Device** | A local machine enrolled for sync | `fsdev_xxx` |
| **Link** | A sync binding between device and org path | `fslk_xxx` |
| **Event** | An immutable log entry (file change, link action) | `fsev_xxx` |
| **Conflict** | Detected when same file modified on both sides | `fscf_xxx` |
| **Object** | Metadata snapshot of a file in the object store | `fsobj_xxx` |
| **Share** | Revocable, time-limited access token for a file | `share_xxx` |
| **Public Path** | Permanently public path prefix (no token needed) | `fspub_xxx` |

#### Sync Protocol

**Write path (local to remote):**

```
1. CLI detects file change (fsevents / inotify)
2. CLI computes SHA-256 hash of file content
3. GET /orgs/{orgId}/fs/upload-url?path=/docs/report.md
   → Presigned PUT URL (5 min TTL, 500 MB max)
4. CLI PUTs file bytes directly to MinIO/S3 (bypasses API)
5. POST /internal/orgs/{orgId}/fs/events
   → Creates org_fs_event + upserts org_fs_objects
   → Text files enqueued for async indexing into org_documents
```

**Read path (remote to local):**

```
1. CLI connects to SSE: GET /orgs/{orgId}/fs/events/stream?after_seq=N
2. Receives event with download_url (presigned GET)
3. CLI downloads file directly from MinIO/S3
4. CLI verifies SHA-256 against event.content_hash
5. Writes to local path
```

**Transfer modes:**
- Presigned URLs: Large files go direct to/from object store. Zero bandwidth through the API.
- Share tokens: Opaque, revocable tokens that resolve to presigned URLs on access.
- Public paths: Entire path prefixes made permanently accessible without authentication.

#### Event Spine

The sync backbone is a **durable, append-only event log** in PostgreSQL:

```sql
-- org_fs_events (migration 00059)
seq          BIGSERIAL PRIMARY KEY,  -- Monotonic ordering
id           TEXT UNIQUE,            -- fsev_xxx
org_id       TEXT NOT NULL,
link_id      TEXT,                   -- Source link (nullable for system events)
device_id    TEXT,                   -- Source device (nullable)
event_type   TEXT NOT NULL,          -- file.created | file.updated | file.deleted | ...
path         TEXT NOT NULL,
content_hash TEXT,
size_bytes   BIGINT,
source_side  TEXT,                   -- local | remote | system
storage_key  TEXT,                   -- S3 key (for file events)
metadata     JSONB,
created_at   TIMESTAMPTZ
```

A PostgreSQL `NOTIFY` trigger fires on every INSERT, enabling real-time SSE delivery.

**Event types:**

| Type | When | Has storage_key? |
|------|------|-------------------|
| `file.created` | New file uploaded | Yes |
| `file.updated` | Existing file modified | Yes |
| `file.deleted` | File removed | No |
| `link.paused` | Sync link paused | No |
| `link.resumed` | Sync link resumed | No |
| `link.revoked` | Sync link disconnected | No |
| `conflict.detected` | Both sides modified same file | No |

**Delivery:** Cursor-based polling (`GET /fs/events?after_seq=N`) or real-time SSE stream (`GET /fs/events/stream`). The SSE endpoint polls the DB every 1 second, delivering batches of up to 200 events.

#### Conflict Resolution

When both local and remote modify the same file, a conflict is recorded in `org_fs_conflicts`:

```sql
-- org_fs_conflicts (migration 00059)
id           TEXT PRIMARY KEY,    -- fscf_xxx
org_id       TEXT NOT NULL,
link_id      TEXT,
path         TEXT NOT NULL,
local_hash   TEXT,
remote_hash  TEXT,
status       TEXT,                -- open | resolved
resolution   TEXT,                -- pick_local | pick_remote | manual
resolved_by  TEXT,
resolved_at  TIMESTAMPTZ,
created_at   TIMESTAMPTZ
```

Resolution strategies:
- **pick_local**: Keep local version, discard remote
- **pick_remote**: Keep remote version, discard local
- **manual**: User provides merged content

#### Object Metadata

`org_fs_objects` (migration `00067`) is a queryable snapshot of current file state — one row per path, upserted on every upload. This avoids expensive S3 `ListObjects` calls:

```sql
CREATE TABLE org_fs_objects (
  id            TEXT PRIMARY KEY,           -- fsobj_xxx
  org_id        TEXT NOT NULL,
  path          TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  content_hash  TEXT NOT NULL,              -- SHA-256
  size_bytes    BIGINT NOT NULL,
  mime_type     TEXT DEFAULT 'application/octet-stream',
  deleted_at    TIMESTAMPTZ,               -- Soft delete
  updated_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ,
  UNIQUE(org_id, path)
);
```

**Indexes:** org lookup, prefix search (`text_pattern_ops` for `LIKE`), active objects sorted by `updated_at DESC`.

#### Async Text Indexing

When a text file (markdown, plain text, YAML, JSON; under 512 KB) is created or updated, it's enqueued in `org_fs_index_queue` (migration `00069`). The `OrgFsIndexProcessor` (`apps/api/src/org-fs-sync/org-fs-index.processor.ts`) polls every 2 seconds, fetches content from S3 via the internal client, and indexes it into `org_documents` for full-text search.

| Setting | Value |
|---------|-------|
| Poll interval | 2 seconds |
| Batch size | 10 items |
| Lock duration | 30 seconds |
| Max retries | 5 |
| Indexable MIME types | text/markdown, text/plain, text/yaml, application/yaml, application/json |
| Max file size for indexing | 512 KB |

#### Share Tokens & Public Paths

**Share tokens** (`org_fs_shares`, migration `00071`) provide time-limited, revocable access to individual files:

```
POST /orgs/{orgId}/fs/share         → Create share token (optional expiry)
GET  /orgs/{orgId}/fs/shares        → List active shares
DELETE /orgs/{orgId}/fs/shares/{id} → Revoke share
```

**Public paths** (`org_fs_public_paths`, migration `00071`) make entire path prefixes publicly accessible with no authentication:

```
POST   /orgs/{orgId}/fs/public-paths     → Publish prefix
GET    /orgs/{orgId}/fs/public-paths     → List public prefixes
DELETE /orgs/{orgId}/fs/public-paths/{id} → Unpublish
```

**Public resolver** (no auth required):

```
GET /orgs/{orgId}/fs/public/{path}?token={share_token}
→ 302 redirect to presigned GET URL
```

Resolves either by matching a share token or by matching a public path prefix (longest prefix match).

#### Agent Runtime Integration

Agent runtime warm pods mount the org filesystem as a K8s PVC:

| Setting | Value |
|---------|-------|
| PVC name | `eve-org-fs-org-default` |
| Mount point | `/org` |
| Access mode | ReadWriteMany |
| Storage | 5 Gi (configurable) |
| Pod env var | `EVE_ORG_FS_ROOT=/org` |

Agents can read/write files directly at `/org` without API calls. Changes are synced to S3 and indexed into org docs automatically.

K8s manifests: `k8s/base/agent-runtime-pvc.yaml`, `k8s/base/agent-runtime-deployment.yaml`.

---

### Org Docs (Versioned Document Store)

Org docs is a **Postgres-native, versioned, queryable document store** for org-level knowledge. While the org filesystem handles file sync and binary storage, org docs handles structured text with versioning, search, and lifecycle management.

#### API Endpoints

All under `/orgs/:org_id/docs`:

| Operation | Method | Endpoint | Purpose |
|-----------|--------|----------|---------|
| Write | POST | `/docs` | Create document |
| Read | GET | `/docs/by-path?path=<path>` | Get doc with content |
| List | GET | `/docs?path=<prefix>` | List by prefix (metadata only) |
| Search | GET | `/docs/search?q=<query>` | Full-text search with headlines |
| Stale | GET | `/docs/stale?overdue_by=<duration>` | Docs overdue for review |
| Review | POST | `/docs/review?path=<path>` | Mark reviewed, set next review date |
| Update | PUT | `/docs/by-path?path=<path>` | Replace entire document |
| Patch | PATCH | `/docs/by-path?path=<path>` | Search/replace, append, insert |
| Delete | DELETE | `/docs/by-path?path=<path>` | Delete document |
| Query | POST | `/docs/query` | Structured metadata query |
| Versions | GET | `/docs/:path/versions` | Version history |
| Version | GET | `/docs/:path/versions/:version` | Specific version |

#### Database Schema

**`org_documents`** (migration `00050`, lifecycle fields added in `00063`):

```sql
CREATE TABLE org_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  project_id      TEXT REFERENCES projects(id),
  path            TEXT NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT 'text/markdown',
  content         TEXT NOT NULL,
  content_hash    TEXT GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED,
  created_by      TEXT,
  metadata        JSONB DEFAULT '{}',
  search_vector   TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(path, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED,
  -- Lifecycle fields (migration 00063)
  review_due        TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  lifecycle_status  TEXT DEFAULT 'active',  -- active | stale | archived | expired
  embedding_model   TEXT,
  embedding_json    JSONB,
  embedded_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, path)
);
```

**`org_document_versions`** (migration `00052`):

```sql
CREATE TABLE org_document_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id          UUID NOT NULL REFERENCES org_documents(id) ON DELETE CASCADE,
  version         INT NOT NULL,
  content         TEXT NOT NULL,
  content_hash    TEXT GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED,
  metadata        JSONB DEFAULT '{}',
  created_by      TEXT,
  mutation_id     TEXT,                    -- Idempotency key
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(doc_id, version)
);
```

**Key indexes:** GIN on `search_vector` (full-text), GIN on `metadata` (structured queries), composite on `(org_id, path)`.

#### Versioning

Every update creates an immutable version entry:

1. Get latest version number and content hash
2. If no version exists, create version 1 from current content
3. Increment version number
4. Update document row with new content
5. Insert new version row
6. Emit `system.doc.updated` event with version and mutation_id

Versions are never deleted (cascade only when parent doc is deleted). Any historical version can be read by number.

#### Full-Text Search

Uses PostgreSQL native `tsvector` with weighted English configuration:

- **Weight A**: Document path (higher relevance)
- **Weight B**: Document content
- **Ranking**: `ts_rank()` orders by relevance
- **Snippets**: `ts_headline()` extracts 20-50 word context windows

Search modes: `text` (default), `semantic`, `hybrid`. Semantic/hybrid degrade to text when embeddings are absent.

#### Structured Metadata Queries

Six filter operators on JSONB `metadata`:

| Operator | Example | Purpose |
|----------|---------|---------|
| `eq` | `metadata.owner eq alice` | Exact match |
| `in` | `metadata.status in draft,review` | Set membership |
| `gte` | `metadata.priority gte 2` | Numeric >= |
| `lte` | `metadata.priority lte 3` | Numeric <= |
| `exists` | `metadata.reviewed exists true` | Key exists |
| `prefix` | `metadata.owner prefix ali` | String prefix |

Keyset pagination using `(updated_at, id)` cursor. Limit: 1-200 per query.

#### Lifecycle Management

Documents can track review schedules and expiration:

```bash
# Write with lifecycle settings
eve docs write --org <org> --path /pm/spec.md --file spec.md \
  --review-in 30d --expires-in 90d

# Find stale documents
eve docs stale --org <org> --overdue-by 7d --prefix /agents/

# Mark reviewed
eve docs review --org <org> --path /pm/spec.md --next-review 30d
```

#### Job Resource References

Jobs can reference org docs via `resource_refs`:

```
org_docs:/pm/features/FEAT-123.md@v3
```

Referenced documents are hydrated into the job workspace during provisioning. The `@v3` suffix pins to a specific version.

---

## API Reference

### Org Filesystem Endpoints

**Device & Link Management:**

```
POST   /orgs/{orgId}/fs/devices/enroll           # Enroll device for sync
POST   /orgs/{orgId}/fs/links                     # Create sync link
GET    /orgs/{orgId}/fs/links                     # List links (filtered by ACLs)
PATCH  /orgs/{orgId}/fs/links/{linkId}            # Update mode/status/scope
POST   /orgs/{orgId}/fs/links/{linkId}/token      # Rotate gateway token
DELETE /orgs/{orgId}/fs/links/{linkId}            # Revoke link
```

**Status & Events:**

```
GET    /orgs/{orgId}/fs/status                    # Sync status (links, gateway health)
GET    /orgs/{orgId}/fs/events                    # Paginated events (seq cursor)
GET    /orgs/{orgId}/fs/events/stream             # SSE real-time stream
```

**Conflicts:**

```
GET    /orgs/{orgId}/fs/conflicts                 # List conflicts
POST   /orgs/{orgId}/fs/conflicts/{id}/resolve    # Resolve conflict
```

**File Operations:**

```
GET    /orgs/{orgId}/fs/upload-url?path=<path>    # Presigned PUT URL
GET    /orgs/{orgId}/fs/download-url?path=<path>  # Presigned GET URL
GET    /orgs/{orgId}/fs/objects?prefix=<pfx>      # List stored objects
```

**Sharing:**

```
POST   /orgs/{orgId}/fs/share                     # Create share token
GET    /orgs/{orgId}/fs/shares                    # List active shares
DELETE /orgs/{orgId}/fs/shares/{token}            # Revoke share
POST   /orgs/{orgId}/fs/public-paths              # Publish path prefix
GET    /orgs/{orgId}/fs/public-paths              # List public paths
DELETE /orgs/{orgId}/fs/public-paths/{id}         # Unpublish path
```

**Public (no auth):**

```
GET    /orgs/{orgId}/fs/public/{path}             # 302 redirect to file
```

**Internal (x-eve-internal-token):**

```
POST   /internal/orgs/{orgId}/fs/events           # Ingest file event
POST   /internal/orgs/{orgId}/fs/links/{id}/heartbeat   # Device heartbeat
POST   /internal/orgs/{orgId}/fs/links/{id}/metrics     # Device metrics
```

---

## Access Control

### Permission Model

Three permission levels, enforced at org scope:

| Permission | Allows |
|------------|--------|
| `orgfs:read` | List links, events, objects, shares, public paths; download files |
| `orgfs:write` | Create/update links, enroll devices, resolve conflicts, upload files |
| `orgfs:admin` | Manage share tokens, publish/unpublish public paths |

For org docs:

| Permission | Allows |
|------------|--------|
| `orgdocs:read` | Read documents, search, list |
| `orgdocs:write` | Create, update, patch, delete documents |
| `orgdocs:admin` | Administrative access |

### Path-Scoped ACLs

Links have fine-grained path-scoped access via `scope_json.allow_prefixes`:

```json
{
  "allow_prefixes": ["/**"]              // Full org access (default)
}
// or
{
  "allow_prefixes": ["/docs/**", "/assets/**"]  // Restricted to specific paths
}
```

The gateway token (issued per link) encodes these prefixes. Every file operation validates the requested path against the token's allowed prefixes.

### Token Types

| Token | Scope | Revocation | Format |
|-------|-------|-----------|--------|
| **Gateway token** | Per-link, HS256-signed | Rotate via API | JWT-like (custom) |
| **Share token** | Single file, time-limited | Revoke via API (immediate) | Opaque ID |
| **Public path** | Path prefix, permanent | Delete via API | Path match |
| **Presigned URL** | Single object, 5 min TTL | Cannot revoke (bearer token) | S3 query params |

Gateway token claims:

```json
{
  "v": 1,
  "org_id": "org_xxx",
  "link_id": "fslk_xxx",
  "mode": "two_way",
  "allow_prefixes": ["/docs/**"],
  "iat": 1740000000,
  "exp": 1740086400,
  "jti": "unique-id"
}
```

Secret: `EVE_ORG_FS_LINK_TOKEN_SECRET` (falls back to `EVE_INTERNAL_API_KEY`).

---

## CLI Commands

### Org Filesystem (`eve fs`)

```bash
# Initialize sync
eve fs sync init --org <org> --local <path> \
  [--mode two-way|push-only|pull-only] \
  [--remote-path /] \
  [--include "**/*.md"] [--exclude "**/.git/**"]

# Status and monitoring
eve fs sync status --org <org>
eve fs sync logs --org <org> [--after N] [--limit N] [--follow]
eve fs sync doctor --org <org>

# Link management
eve fs sync pause --org <org> [--link <link_id>]
eve fs sync resume --org <org> [--link <link_id>]
eve fs sync disconnect --org <org> [--link <link_id>]
eve fs sync mode --org <org> --set <mode> [--link <link_id>]

# Conflict resolution
eve fs sync conflicts --org <org> [--open-only]
eve fs sync resolve --org <org> --conflict <id> \
  --strategy <pick-remote|pick-local|manual> [--merged-content "..."]

# Share tokens
eve fs share <path> --org <org> [--expires 7d] [--label "description"]
eve fs shares --org <org>
eve fs revoke <token> --org <org>

# Public paths
eve fs publish <path-prefix> --org <org> [--label "description"]
eve fs public-paths --org <org>
```

### Org Docs (`eve docs`)

```bash
# Write and read
eve docs write --org <org> --path <path> --file <file> \
  [--metadata '{"key":"value"}'] [--review-in 30d] [--expires-in 90d]
eve docs read --org <org> --path <path> [--version N] [--json]
eve docs show --org <org> --path <path> [--verbose] [--json]

# List and search
eve docs list --org <org> [--path <prefix>] [--json]
eve docs search --org <org> --query <text> [--limit N] [--mode text|semantic|hybrid] [--json]

# Lifecycle
eve docs stale --org <org> [--overdue-by 7d] [--prefix /agents/] [--json]
eve docs review --org <org> --path <path> --next-review 30d [--json]

# Versions
eve docs versions --org <org> --path <path> [--limit 20] [--json]

# Structured queries
eve docs query --org <org> --where 'metadata.owner eq alice' \
  [--path-prefix /pm/] [--sort field:asc] [--limit 50] [--json]

# Delete
eve docs delete --org <org> --path <path> [--json]
```

---

## Events

The org filesystem emits events on the system event spine:

| Event | Trigger |
|-------|---------|
| `file.created` | File uploaded for first time |
| `file.updated` | Existing file modified |
| `file.deleted` | File removed |
| `link.paused` | Sync link paused |
| `link.resumed` | Sync link resumed |
| `link.revoked` | Sync link disconnected |
| `conflict.detected` | Both sides modified same file |

Org docs emits:

| Event | Trigger |
|-------|---------|
| `system.doc.created` | Document created |
| `system.doc.updated` | Document updated/patched/reviewed |
| `system.doc.deleted` | Document deleted |

Doc events include deduplication key (`doc:{doc_id}:mutation:{mutation_id}`) for idempotency.

---

## How They Work Together

```
                ┌──────────────┐
                │  Org Docs    │  Versioned documents
                │  (Postgres)  │  Full-text search
                └──────┬───────┘
                       ▲
            async indexer (text files < 512KB)
                       │
┌──────────────┐     ┌─┴────────────┐     ┌──────────────┐
│  Object Store│◀────│  Org FS      │────▶│  Event Log   │
│  (MinIO/S3)  │     │  Sync Layer  │     │  (Postgres)  │
│  Binary files│     │  Control API │     │  Cursor + SSE│
└──────────────┘     └──────────────┘     └──────────────┘
       ▲                    ▲                    │
       │                    │                    ▼
  Presigned URLs      Device enrollment    CLI / Agent
  (direct transfer)   Link management      event stream
```

1. **Files stored in object store** — MinIO/S3 holds the actual bytes. No file content flows through the API.
2. **Metadata tracked in Postgres** — `org_fs_objects` provides queryable state, `org_fs_events` provides history.
3. **Text files indexed into org docs** — Markdown, YAML, JSON under 512 KB are automatically extracted and indexed for search.
4. **Agents access both** — Warm pods mount the PVC directly (`/org`); API clients use presigned URLs.
5. **Share tokens bridge public access** — Files can be shared outside the org via revocable tokens or published path prefixes.

---

## App Object Buckets

Manifest-driven object storage for deployed applications:

```yaml
# .eve/manifest.yaml
services:
  api:
    x-eve:
      object_store:
        # Optional: auto (default), irsa, or shared
        isolation: auto
        buckets:
          - name: uploads
            visibility: private
          - name: avatars
            visibility: public
            cors:
              origins: ["*"]
              methods: [GET, PUT, HEAD]
              max_age_seconds: 3600
```

Each bucket is provisioned per environment during deploy. Eve reconciles one
credential binding for the whole environment, so app services and job services
that declare buckets share the same binding and policy for that env.

With local k3d/MinIO, or explicit `isolation: shared`, the declaring service
gets:

- `STORAGE_ENDPOINT`
- `STORAGE_REGION`
- `STORAGE_ACCESS_KEY_ID`
- `STORAGE_SECRET_ACCESS_KEY`
- `STORAGE_BUCKET_<NAME>` (for example, `STORAGE_BUCKET_UPLOADS`)
- `STORAGE_FORCE_PATH_STYLE=true` for MinIO

With AWS IRSA, the declaring service gets:

- `STORAGE_ENDPOINT`
- `STORAGE_REGION`
- `STORAGE_AUTH_MODE=irsa`
- `AWS_REGION`
- `STORAGE_BUCKET_<NAME>`

IRSA app pods do not receive `STORAGE_ACCESS_KEY_ID` or
`STORAGE_SECRET_ACCESS_KEY`; AWS SDKs use the pod service account token. Eve
renders a `ServiceAccount/eve-app` annotated with the env role ARN and sets
`serviceAccountName: eve-app` on each app/job pod that declares buckets.

Provisioned buckets are tracked in the `storage_buckets` table and shown by
`eve env diagnose`, including the resolved isolation mode and IRSA metadata
when present. Removing a bucket from the manifest prunes the stale
`storage_buckets` row on the next deploy without deleting the physical bucket.
Removing all bucket declarations removes the env binding and rows.

If the target platform has no configured object storage, if explicit
`isolation: irsa` is requested on a cluster without IRSA configuration, or if
bucket creation/policy setup fails, deploy fails before starting the app. Local
k3d MinIO uses server-wide CORS (`MINIO_API_CORS_ALLOW_ORIGIN=*`) because MinIO
does not reliably support the S3 per-bucket CORS API. Wildcard app bucket CORS
works for browser presigned URL flows; restrictive origins are recorded in
`storage_buckets` but are not enforced per bucket by local MinIO.

### Trust Model

On AWS staging, `auto` resolves to IRSA when the worker has OIDC provider
configuration and IAM permissions. The worker creates or updates one IAM role
per org/project/env, binds it to `ServiceAccount/eve-app`, and fully replaces
the role's `app-bucket-access` inline policy with the env's declared physical
bucket names. The role can read/write only those buckets.

Shared static app-bucket credentials remain available as an explicit fallback
for non-IRSA clusters. Setting `EVE_APP_BUCKET_AUTH_MODE=shared` on the worker
forces that fallback even when IRSA env vars are present. Local k3d resolves
`auto` to `minio-static-key`.

## Cloud FS

Cloud FS mounts external cloud storage into Eve without copying the whole tree into the org filesystem. Google Drive is the first provider. A mount links an org OAuth integration to a provider folder and can be org-scoped or project-scoped.

```bash
eve cloud-fs mount --provider google-drive --folder-id <drive-folder-id> --label "Shared Drive"
eve cloud-fs list --org <org>
eve cloud-fs ls / --mount <mount-id> --page-size 100
eve cloud-fs ls / --mount <mount-id> --page-token <token>
eve cloud-fs ls / --mount <mount-id> --all --json
eve cloud-fs ls / --mount <mount-id> --recursive --json
eve cloud-fs search "budget" --mount <mount-id> --mime-type application/pdf --all --json
```

Browse and search are one provider page by default. Responses may include `next_page_token`; pass it back as `page_token` or use CLI `--all` to auto-page. `--all` is capped by `EVE_CLOUD_FS_MAX_AUTO_PAGES` (default 200) and JSON output reports `complete`, `page_count`, and `next_page_token` when the cap stops iteration.

Browse supports `page_size`, `page_token`, and provider-neutral ordering: `name`, `name_desc`, `modified`, `modified_desc`. The API clamps `page_size` to the provider maximum (1..1000 for Drive). Search accepts the same paging and ordering fields plus `mime_type`, which is passed to the provider as a MIME filter.

Recursive browse (`recursive=true`, CLI `--recursive` or `-r`) is a bounded server-side traversal. It rejects `page_token` and CLI `--all` because the traversal combines many provider pages. The response includes `truncated: true` when server guardrails stop traversal before the tree is exhausted.

## Planned (Not Implemented)

**Planned CLI:**

```bash
eve store buckets --project <proj> --env <env>
eve store ls --project <proj> --env <env> --bucket uploads
eve store url --project <proj> --env <env> --bucket uploads --key file.pdf
eve store put --project <proj> --env <env> --bucket uploads --file ./report.pdf
eve store get --project <proj> --env <env> --bucket uploads --key file.pdf
```

### CLI Sync Daemon

The CLI currently has control-plane commands (init, status, pause, resume) but does not yet run an active file-watch daemon loop. The presigned URL transfer protocol is implemented server-side; the client-side daemon (fsevents/inotify watcher) is pending.

### Semantic Search

Org docs schema includes `embedding_model`, `embedding_json`, and `embedded_at` columns (migration `00063`). Vector similarity search is prepared but not yet connected to an embedding provider.

---

## Key Files

| Component | Path |
|-----------|------|
| Storage service | `apps/api/src/storage/storage.service.ts` |
| Storage module | `apps/api/src/storage/storage.module.ts` |
| Org FS controller | `apps/api/src/org-fs-sync/org-fs-sync.controller.ts` |
| Org FS service | `apps/api/src/org-fs-sync/org-fs-sync.service.ts` |
| Org FS index processor | `apps/api/src/org-fs-sync/org-fs-index.processor.ts` |
| Org docs controller | `apps/api/src/org-documents/org-documents.controller.ts` |
| Org docs service | `apps/api/src/org-documents/org-documents.service.ts` |
| Cloud FS controller | `apps/api/src/cloud-fs/cloud-fs.controller.ts` |
| Cloud FS service | `apps/api/src/cloud-fs/cloud-fs.service.ts` |
| DB queries (objects) | `packages/db/src/queries/org-fs-objects.ts` |
| DB queries (shares) | `packages/db/src/queries/org-fs-shares.ts` |
| DB queries (org docs) | `packages/db/src/queries/org-documents.ts` |
| DB queries (Cloud FS) | `packages/db/src/queries/cloud-fs-mounts.ts` |
| Shared schemas (FS) | `packages/shared/src/schemas/org-fs-sync.ts` |
| Shared schemas (docs) | `packages/shared/src/schemas/org-document.ts` |
| Shared schemas (Cloud FS) | `packages/shared/src/schemas/cloud-fs.ts` |
| CLI (fs) | `packages/cli/src/commands/fs.ts` |
| CLI (docs) | `packages/cli/src/commands/docs.ts` |
| CLI (Cloud FS) | `packages/cli/src/commands/cloud-fs.ts` |
| Migrations | `packages/db/migrations/00059-00071` |
| Manual test | `tests/manual/scenarios/26-object-store.md` |
| Plan doc | `docs/plans/object-store-and-fs-plan.md` |
