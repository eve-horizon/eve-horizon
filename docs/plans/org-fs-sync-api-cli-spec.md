# Org Filesystem Sync API + CLI + Migration Spec

> Status: In Progress (baseline API/CLI/migrations implemented)
> Last Updated: 2026-02-14
> Depends On: `docs/plans/org-fs-sync-battle-hardening-plan.md`

## 1) Goal

Define exact API, CLI, event, and database contracts for org filesystem sync with:

1. Two-way sync.
2. Push-only sync.
3. Pull-only sync.
4. Event-based update visibility in seconds.
5. Markdown-first defaults with diff-friendly behavior.

## 2) Core Terms

1. `Device`: a user machine sync identity.
2. `Link`: binding between one device and one org sync root.
3. `Mode`:
   1. `two_way` (read/write both sides)
   2. `push_only` (local -> org)
   3. `pull_only` (org -> local)
4. `Cursor`: last delivered `org_fs_events.seq`.
5. `Gateway`: in-cluster sync endpoint for org filesystem.

## 3) Permissions

Phase 1 uses existing org permissions:

1. Read/list/status/stream endpoints require `orgs:read`.
2. Create/update/delete links and enroll devices require `orgs:write`.

Optional future split:

1. `orgfs:read`
2. `orgfs:write`
3. `orgfs:admin`

## 4) API Surface

All endpoints are under org scope.

### 4.1 Device Enrollment

`POST /orgs/:org_id/fs/devices/enroll`

Request:

```json
{
  "device_name": "adam-macbook",
  "platform": "macos",
  "client_version": "0.2.0"
}
```

Response:

```json
{
  "device": {
    "id": "fsdev_01...",
    "org_id": "org_xxx",
    "device_name": "adam-macbook",
    "platform": "macos",
    "status": "active",
    "created_at": "2026-02-13T18:12:00Z"
  },
  "enrollment": {
    "token": "efs_enroll_...",
    "expires_at": "2026-02-13T18:22:00Z",
    "gateway_url": "https://api.eve.example.com/orgs/org_xxx/fs/gateway"
  }
}
```

Notes:

1. Token is short-lived, one-time use.
2. CLI stores only local machine key material, not raw enrollment token after setup.

### 4.2 Create Sync Link

`POST /orgs/:org_id/fs/links`

Request:

```json
{
  "device_id": "fsdev_01...",
  "mode": "two_way",
  "local_path": "~/Eve/org-acme",
  "remote_path": "/",
  "includes": ["**/*.md", "**/*.mdx", "**/*.txt", "**/*.yaml", "**/*.yml"],
  "excludes": ["**/.DS_Store", "**/.git/**", "**/node_modules/**"]
}
```

Response:

```json
{
  "link": {
    "id": "fslk_01...",
    "org_id": "org_xxx",
    "device_id": "fsdev_01...",
    "mode": "two_way",
    "status": "active",
    "local_path": "~/Eve/org-acme",
    "remote_path": "/",
    "last_cursor": 0,
    "created_at": "2026-02-13T18:13:00Z",
    "updated_at": "2026-02-13T18:13:00Z"
  },
  "runtime": {
    "sync_engine": "syncthing",
    "profile": "markdown_default"
  }
}
```

Validation:

1. `mode` must be one of `two_way|push_only|pull_only`.
2. `remote_path` must remain within org root.
3. Path policies cannot escape tenant root.

### 4.3 List Links

`GET /orgs/:org_id/fs/links`

Response:

```json
{
  "data": [
    {
      "id": "fslk_01...",
      "device_id": "fsdev_01...",
      "mode": "two_way",
      "status": "active",
      "last_cursor": 1242,
      "lag_ms": 820,
      "updated_at": "2026-02-13T18:20:13Z"
    }
  ]
}
```

### 4.4 Update Link Mode/State

`PATCH /orgs/:org_id/fs/links/:link_id`

Request:

```json
{
  "mode": "pull_only",
  "status": "paused"
}
```

Rules:

1. Allowed `status`: `active|paused|revoked`.
2. Mode changes are applied atomically.

### 4.5 Delete Link

`DELETE /orgs/:org_id/fs/links/:link_id`

Response:

```json
{ "success": true }
```

### 4.6 Sync Status

`GET /orgs/:org_id/fs/status`

Response:

```json
{
  "org_id": "org_xxx",
  "gateway": {
    "status": "healthy",
    "last_heartbeat_at": "2026-02-13T18:20:10Z"
  },
  "links": {
    "active": 3,
    "paused": 1,
    "revoked": 0
  },
  "events": {
    "latest_seq": 1242
  }
}
```

### 4.7 Event Stream (SSE)

`GET /orgs/:org_id/fs/events/stream?after_seq=<n>`

SSE event types:

1. `fs_event`
2. `fs_checkpoint`
3. `error`

`fs_event` payload:

```json
{
  "seq": 1243,
  "event_id": "fsev_01...",
  "org_id": "org_xxx",
  "link_id": "fslk_01...",
  "device_id": "fsdev_01...",
  "event_type": "file.updated",
  "path": "/pm/roadmap.md",
  "content_hash": "sha256:...",
  "size_bytes": 9024,
  "source_side": "local",
  "created_at": "2026-02-13T18:20:15Z"
}
```

Event ordering contract:

1. Strictly increasing by `seq` per org.
2. Resume by `after_seq` cursor.

### 4.8 Event History (paged)

`GET /orgs/:org_id/fs/events?after_seq=<n>&limit=<n>`

Response:

```json
{
  "data": [
    {
      "seq": 1243,
      "event_type": "file.updated",
      "path": "/pm/roadmap.md",
      "source_side": "local",
      "created_at": "2026-02-13T18:20:15Z"
    }
  ],
  "pagination": {
    "limit": 100,
    "next_after_seq": 1243
  }
}
```

### 4.9 Conflicts

`GET /orgs/:org_id/fs/conflicts`

`POST /orgs/:org_id/fs/conflicts/:conflict_id/resolve`

Resolve request:

```json
{
  "strategy": "pick_remote"
}
```

Allowed strategies:

1. `pick_local`
2. `pick_remote`
3. `manual` (store merged content)

## 5) Internal Gateway API (Eve Internal Token)

These endpoints are internal-only and used by sync gateway/bridge components.

1. `POST /internal/orgs/:org_id/fs/events` (ingest normalized fs events).
2. `POST /internal/orgs/:org_id/fs/links/:link_id/heartbeat`.
3. `POST /internal/orgs/:org_id/fs/links/:link_id/metrics`.

Event ingest request:

```json
{
  "event_id": "fsev_01...",
  "link_id": "fslk_01...",
  "device_id": "fsdev_01...",
  "event_type": "file.updated",
  "path": "/pm/roadmap.md",
  "content_hash": "sha256:...",
  "size_bytes": 9024,
  "source_side": "local",
  "metadata": {
    "engine": "syncthing",
    "engine_event": "ItemFinished"
  }
}
```

## 6) Event Types

Canonical event types:

1. `file.created`
2. `file.updated`
3. `file.deleted`
4. `file.renamed`
5. `conflict.detected`
6. `conflict.resolved`
7. `link.paused`
8. `link.resumed`
9. `link.revoked`

## 7) CLI Spec

Top-level command group:

1. `eve fs sync ...`

### 7.1 Init

```bash
eve fs sync init --org org_xxx --local ~/Eve/acme --mode two-way
eve fs sync init --org org_xxx --local ~/Eve/acme --mode push-only
eve fs sync init --org org_xxx --local ~/Eve/acme --mode pull-only
```

Flags:

1. `--org <id-or-slug>` required.
2. `--local <path>` required.
3. `--mode <two-way|push-only|pull-only>` default `two-way`.
4. `--include <glob>` repeatable.
5. `--exclude <glob>` repeatable.
6. `--json` optional.

Behavior:

1. Enroll device if missing.
2. Create/update sync link.
3. Start local sync daemon process.

### 7.2 Status

```bash
eve fs sync status --org org_xxx
eve fs sync status --org org_xxx --json
```

Output fields:

1. mode
2. link status
3. connection health
4. lag
5. backlog
6. last event seq

### 7.3 Logs

```bash
eve fs sync logs --org org_xxx --follow
eve fs sync logs --org org_xxx --after 1200 --limit 200
```

### 7.4 Lifecycle Controls

```bash
eve fs sync pause --org org_xxx
eve fs sync resume --org org_xxx
eve fs sync disconnect --org org_xxx
eve fs sync mode --org org_xxx --set pull-only
```

### 7.5 Conflicts and Diagnostics

```bash
eve fs sync conflicts --org org_xxx
eve fs sync resolve --org org_xxx --conflict fscf_01... --strategy pick-remote
eve fs sync doctor --org org_xxx
```

`doctor` checks:

1. auth/token validity
2. link health
3. watcher/engine running
4. disk space/permissions
5. cursor drift and replay path

## 8) Proposed DB Migration

This section defines the first migration draft. File names are proposed; no runtime behavior is implied until implementation is merged.

### 8.1 `00059_org_fs_sync.sql`

```sql
-- 00059_org_fs_sync.sql
-- Org filesystem sync control-plane and durable event log.

CREATE TABLE org_sync_devices (
  id              TEXT PRIMARY KEY,                     -- fsdev_xxx
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_name     TEXT NOT NULL,
  platform        TEXT,
  client_version  TEXT,
  public_key      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_seen_at    TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, public_key)
);

CREATE INDEX idx_org_sync_devices_org ON org_sync_devices(org_id);
CREATE INDEX idx_org_sync_devices_org_status ON org_sync_devices(org_id, status);

CREATE TABLE org_sync_links (
  id              TEXT PRIMARY KEY,                     -- fslk_xxx
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL REFERENCES org_sync_devices(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('two_way', 'push_only', 'pull_only')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  local_path      TEXT NOT NULL,
  remote_path     TEXT NOT NULL DEFAULT '/',
  includes_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
  excludes_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_cursor     BIGINT NOT NULL DEFAULT 0,
  last_synced_at  TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, device_id, remote_path)
);

CREATE INDEX idx_org_sync_links_org ON org_sync_links(org_id);
CREATE INDEX idx_org_sync_links_org_status ON org_sync_links(org_id, status);
CREATE INDEX idx_org_sync_links_device ON org_sync_links(device_id);

CREATE TABLE org_fs_events (
  seq             BIGSERIAL PRIMARY KEY,
  id              TEXT NOT NULL UNIQUE,                 -- fsev_xxx
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  link_id         TEXT REFERENCES org_sync_links(id) ON DELETE SET NULL,
  device_id       TEXT REFERENCES org_sync_devices(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  path            TEXT NOT NULL,
  content_hash    TEXT,
  size_bytes      BIGINT,
  source_side     TEXT NOT NULL CHECK (source_side IN ('local', 'remote', 'system')),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_fs_events_org_seq ON org_fs_events(org_id, seq DESC);
CREATE INDEX idx_org_fs_events_org_path ON org_fs_events(org_id, path);
CREATE INDEX idx_org_fs_events_org_created ON org_fs_events(org_id, created_at DESC);
CREATE INDEX idx_org_fs_events_type ON org_fs_events(event_type);

CREATE TABLE org_fs_conflicts (
  id                TEXT PRIMARY KEY,                   -- fscf_xxx
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  link_id           TEXT REFERENCES org_sync_links(id) ON DELETE SET NULL,
  path              TEXT NOT NULL,
  local_hash        TEXT,
  remote_hash       TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution        TEXT CHECK (resolution IN ('pick_local', 'pick_remote', 'manual')),
  resolved_by       TEXT,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_fs_conflicts_org_status ON org_fs_conflicts(org_id, status);
CREATE INDEX idx_org_fs_conflicts_org_path ON org_fs_conflicts(org_id, path);
```

### 8.2 `00060_org_fs_events_notify.sql`

```sql
-- 00060_org_fs_events_notify.sql
-- Realtime fanout via PostgreSQL NOTIFY when org_fs_events rows are inserted.

CREATE OR REPLACE FUNCTION notify_org_fs_event() RETURNS trigger AS $$
DECLARE
  payload TEXT;
BEGIN
  payload := json_build_object(
    'seq', NEW.seq,
    'id', NEW.id,
    'org_id', NEW.org_id,
    'event_type', NEW.event_type,
    'path', NEW.path,
    'created_at', NEW.created_at
  )::text;

  PERFORM pg_notify('org_fs_events', payload);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_org_fs_event ON org_fs_events;

CREATE TRIGGER trg_notify_org_fs_event
AFTER INSERT ON org_fs_events
FOR EACH ROW
EXECUTE FUNCTION notify_org_fs_event();
```

## 9) Error Codes (Proposed)

1. `fs_device_not_found`
2. `fs_link_not_found`
3. `fs_link_mode_invalid`
4. `fs_path_invalid`
5. `fs_path_out_of_scope`
6. `fs_enrollment_expired`
7. `fs_conflict_not_found`
8. `fs_conflict_resolution_invalid`
9. `fs_cursor_invalid`

## 10) Markdown Optimization Defaults

Default include set:

1. `**/*.md`
2. `**/*.mdx`
3. `**/*.txt`
4. `**/*.yaml`
5. `**/*.yml`

Default excludes:

1. `**/.git/**`
2. `**/node_modules/**`
3. `**/.DS_Store`
4. `**/*.png`
5. `**/*.jpg`
6. `**/*.zip`

Notes:

1. Syncthing handles block-level transfer.
2. API event payloads include checksums and sizes for verification/diagnostics.
3. Conflict resolver prioritizes markdown-safe merges before manual fallback.

## 11) Compatibility

1. Existing `eve docs` commands remain unchanged.
2. Existing org-documents API remains source for search/version views.
3. New sync plane is additive and can be feature-flagged per org.

## 12) Implementation Checklist (Spec Compliance)

1. Add shared schemas + OpenAPI for all new endpoints.
2. Add API controllers/services and internal endpoint auth guards.
3. Add DB query modules and migrations.
4. Add CLI command group with JSON and human outputs.
5. Add integration tests:
   1. enroll/create/update/delete link
   2. mode transitions
   3. SSE cursor resume
   4. conflict lifecycle
6. Add manual scenario for two Macs simulation in local stack.

## 13) Implementation Notes (2026-02-14)

1. Baseline delivered:
   1. API org endpoints (`/orgs/:org_id/fs/*`) for enroll, links, status, events (list + stream), conflicts.
   2. Internal endpoints for event ingest, heartbeat, and metrics updates.
   3. CLI group `eve fs sync ...` with `init|status|logs|pause|resume|disconnect|mode|conflicts|resolve|doctor`.
   4. Migrations `00059_org_fs_sync.sql` + `00060_org_fs_events_notify.sql`.
2. Enrollment request additionally supports optional `public_key` for deterministic device identity on re-init.
3. CLI parser currently accepts one `--include`/`--exclude` value (comma-separated for multiple globs).
