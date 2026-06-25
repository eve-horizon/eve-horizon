# Document Ingestion MVP Plan

> **Status**: Plan (ready to build)
> **Date**: 2026-03-04
> **Distilled from**: [document-ingestion-agent-packs.md](../ideas/document-ingestion-agent-packs.md)
> **Scope**: Single-agent, Claude-only, multimodal-first document ingestion

## Goal

Add a composable document ingestion flow to Eve: **file in → event → agent processes → structured output in org docs**. This MVP builds the thinnest possible path using primitives that already exist (presigned uploads, resource hydration, system events, workflows, org docs).
Primary constraints: minimal surface area, strong auditability, and no binary handling in API services.

## Non-Goals (Phase 2+)

- Multi-agent triage / team routing
- Pi harness profiles / capability-adaptive skills
- pdftotext, pandoc, tesseract (Claude handles binary formats natively)
- Separate public agent pack repo (skill defined inline in workflow)
- Embeddings / vector search
- Slack file download (gateway enhancement)
- Org-fs watch-path ingestion (drop-folder trigger)

## Architecture

```
    CLI / REST API
         │
    ┌────▼────┐       ┌──────────────┐
    │ Ingest  │──────►│ Object Store │
    │ Record  │       │ /ingest/{id} │
    │ (audit) │       └──────┬───────┘
    └────┬────┘              │
         │          system.doc.ingest event
         │                   │
    ┌────▼───────────────────▼───┐
    │  Orchestrator               │
    │  (existing event router)    │
    │  triggers ingest workflow   │
    └────────────┬───────────────┘
                 │
    ┌────────────▼───────────────┐
    │  Worker                     │
    │  1. Hydrate ingest:// ref   │
    │  2. Whisper pre-step (if    │
    │     audio/video MIME)       │
    │  3. Invoke mclaude harness  │
    └────────────┬───────────────┘
                 │
    ┌────────────▼───────────────┐
    │  Claude Agent               │
    │  Reads file natively        │
    │  (PDF, image, text)         │
    │  Writes to org docs via     │
    │  eve-agent-cli              │
    └────────────────────────────┘
```

## Detailed Design

### 1. Ingest Records Table

An immutable audit trail. One row per ingestion. Most fields are immutable after creation.

Status updates are allowed only for lifecycle fields (`status`, `event_id`, `job_id`, `completed_at`, `error_message`, `updated_at`).

```sql
CREATE TABLE ingest_records (
  id              TEXT PRIMARY KEY,        -- TypeID: ing_xxx
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  project_id      TEXT NOT NULL REFERENCES projects(id),

  -- File metadata
  file_name       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  storage_key     TEXT NOT NULL,           -- S3 key: ingest/{id}/{file_name}

  -- Audit: who submitted, from where
  actor_type      TEXT NOT NULL,           -- 'user' | 'service_principal' | 'agent'
  actor_id        TEXT,                    -- nullable for anonymous/system
  source_channel  TEXT NOT NULL DEFAULT 'upload',  -- 'upload' | 'cli' | 'slack' | 'api'

  -- User-supplied context (travels with the file to the agent)
  title           TEXT,                    -- display name (defaults to file_name)
  description     TEXT,                    -- what the file is ("Q4 board deck")
  instructions    TEXT,                    -- how to process ("extract action items")
  tags            TEXT[],                  -- initial tags
  callback_url    TEXT,                    -- optional callback target for status updates

  -- Processing state
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  error_message   TEXT,                    -- failure details (if failed)
  event_id        TEXT,                    -- the system.doc.ingest event that was fired
  job_id          TEXT,                    -- the workflow job that processed this

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_ingest_records_org ON ingest_records(org_id);
CREATE INDEX idx_ingest_records_project ON ingest_records(project_id);
CREATE INDEX idx_ingest_records_status ON ingest_records(status);
CREATE INDEX idx_ingest_records_project_status ON ingest_records(project_id, status);
```

TypeID prefix: `ing_` (add to `packages/shared/src/ids.ts`).

### 2. Ingest API — Two-Phase Upload

Follows the same presigned-URL pattern as `org-fs-sync`. No large binary is proxied through the API.

**Phase 1 — Create ingest record + get upload URL:**

```
POST /orgs/{orgId}/projects/{projectId}/ingest
Content-Type: application/json

{
  "file_name": "quarterly-report.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 2458901,
  "title": "Q4 Board Deck",
  "description": "Quarterly board presentation from CFO",
  "instructions": "Extract key financials and action items",
  "tags": ["finance", "q4"],
  "callback_url": "https://example.internal/ingest-callback"
}

Response (201 Created):
{
  "ingest_id": "ing_abc123",
  "upload_url": "https://s3.../ingest/ing_abc123/quarterly-report.pdf?X-Amz-...",
  "upload_method": "PUT",
  "upload_expires_at": "2026-03-04T14:35:00Z",
  "max_bytes": 524288000,
  "storage_key": "ingest/ing_abc123/quarterly-report.pdf"
}
```

**Phase 2 — Confirm upload + fire event:**

```
POST /orgs/{orgId}/projects/{projectId}/ingest/{ingestId}/confirm

Response (202 Accepted):
{
  "ingest_id": "ing_abc123",
  "status": "processing",
  "event_id": "evt_xyz789",
  "job_id": "myproj-f2a91bc3"   // null if no ingest workflow
}
```

What confirm does:
1. Verify the file exists in object store (HEAD request on storage key)
2. Update ingest record status → `processing`
3. Emit `system.doc.ingest` event (see below)
4. If a matching workflow exists, return the triggered job ID
5. Return current state on replayed confirms (idempotent behavior)

Validation at create/confirm:
- `max_bytes` hard cap for MVP (e.g. 500 MiB)
- MIME allowlist for ingestion + explicit rejection of unsupported/empty values
- `source_channel` restricted to known values (`upload|cli|slack|api`)
- Confirm only allowed when status is `pending` (or return existing processing state on repeat call)

**Why two-phase?** Matches the org-fs-sync presigned URL pattern. The API never proxies binary data. The client uploads directly to S3, then confirms. This is the same flow the CLI's `eve fs sync` uses.

### Access and failure handling

- Endpoint authorization: endpoints should require project write capability (or equivalent service-principal scope).
- Confirm endpoint should require:
  - same org/project context
  - current user can read ingest record
  - ingest record belongs to requested org/project
- Any non-200/4xx from object-store checks should mark `status=failed` and store `error_message` so the job lifecycle remains observable.

### 3. `system.doc.ingest` Event

Emitted on confirm, following the same pattern used by other org-document events:

```typescript
await events.create({
  id: generateEventId(),
  project_id: projectId,
  type: 'system.doc.ingest',
  source: 'system',
  env_name: null,
  ref_sha: null,
  ref_branch: null,
  actor_type: record.actor_type,
  actor_id: record.actor_id,
  payload_json: {
    org_id: orgId,
    project_id: projectId,
    ingest_id: record.id,
    file_name: record.file_name,
    mime_type: record.mime_type,
    size_bytes: record.size_bytes,
    storage_key: record.storage_key,
    title: record.title,
    description: record.description,
    instructions: record.instructions,
    tags: record.tags,
    source_channel: record.source_channel,
    callback_url: record.callback_url,
  },
  dedupe_key: `ingest:${record.id}`,
});
```

**No trigger matcher changes needed.** The existing `matchesSystemTrigger()` already handles this: it strips the `system.` prefix and compares against `systemTrigger.event`. A workflow trigger of `system: { event: doc.ingest }` matches `system.doc.ingest` events.

### 4. `ingest://` URI Scheme

Extends the resource URI system (`packages/shared/src/lib/resource-uris.ts`) with a third scheme.

**URI format:** `ingest:/{ingest_id}/{encoded_file_name}`

`file_name` should be URI-encoded so names with spaces or Unicode are preserved safely.

```typescript
// New type
export type ParsedIngestUri = {
  scheme: 'ingest';
  ingestId: string;
  fileName: string;   // decoded value
};

// Updated union
export type ParsedResourceUri = ParsedOrgDocUri | ParsedJobAttachmentUri | ParsedIngestUri;
```

Parser additions:
- `parseResourceUri()` — handle `ingest:/` prefix
- `buildIngestUri(ingestId, fileName)` — construct from parts
- `defaultMountPathForUri()` — returns `ingest/{ingestId}/{fileName}`

### 5. Worker Hydration Extension

The worker's `hydrateResources()` implementation already resolves `org_docs://` and `job_attachments://` URIs into `.eve/resources/`. Add `ingest://` as a third case.

```typescript
if (parsed.scheme === 'ingest') {
  // Download from object store: ingest/{ingestId}/{fileName}
  const storageKey = `ingest/${parsed.ingestId}/${parsed.fileName}`;
  const orgSlug = await this.getOrgSlug(orgId);
  const bucketName = this.storage.getOrgBucketName(orgSlug);
  const fileContent = await this.storage.getObject(bucketName, storageKey);

  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, fileContent);
  // ... populate summary entry
}
```

The `StorageService` (`apps/api/src/storage/storage.service.ts`) already has `getObject()` and `getPresignedDownloadUrl`. The worker can use `getObject()` directly since it runs in-cluster with IAM/IRSA credentials.

**Note:** The worker already has `@eve/shared` which exports `parseResourceUri`. No new package dependencies.

Use `path.basename(parsed.fileName)` (or equivalent) before local path construction to avoid path traversal from malicious file names.

### 6. Worker Audio Pre-Step (Whisper)

After hydrating an `ingest://` resource, detect audio/video MIME types and run whisper to produce a VTT transcript. The transcript is placed alongside the original file so the agent receives both.

**MIME detection:**

```typescript
const AUDIO_VIDEO_MIMES = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/flac',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
]);
```

**Pre-step logic** (runs inside `hydrateResources`, after writing the ingest file):

```typescript
if (parsed.scheme === 'ingest' && AUDIO_VIDEO_MIMES.has(mimeType)) {
  const vttPath = `${localPath}.vtt`;
  await execFileAsync('whisper', [
    localPath,
    '--output_format', 'vtt',
    '--output_dir', path.dirname(localPath),
  ]);
  // Add VTT as a second entry in the resource index
  summary.resources.push({
    uri: `${ref.uri}#transcript`,
    local_path: `${vttPath}`,
    label: `${ref.label ?? parsed.fileName} (transcript)`,
    required: false,
    status: 'resolved',
    generated_by: 'whisper',
  });
  // If whisper command is unavailable, keep ingest file and continue without transcript.
}
```

**Why worker, not agent?** Transcription is mechanical (no intelligence needed), deterministic (same input → same output), and expensive in tokens if done by the LLM. Running it in the worker keeps the agent focused on understanding, not transcription.

### 7. Default Doc Processor Workflow

A default ingest workflow defined in the project manifest. Uses inline prompt (no separate SKILL.md for MVP).

```yaml
# .eve/manifest.yaml
x-eve:
  workflows:
    doc-ingest:
      triggers:
        - system:
            event: doc.ingest
      harness: mclaude
      permission: auto_edit
      resource_refs:
        - uri: "ingest://${event.payload.ingest_id}/${event.payload.file_name}"
          label: "Ingested document"
          required: true
      prompt: |
        You are a document processor for the Eve platform.

        ## Your Task

        A file has been ingested and is available at `.eve/resources/ingest/`.
        Read the file and produce a structured analysis.

        ## Context from submitter

        Title: ${event.payload.title ?? event.payload.file_name}
        Description: ${event.payload.description ?? "None provided"}
        Processing instructions: ${event.payload.instructions ?? "Standard extraction"}
Tags: ${event.payload.tags ?? []}

        ## Output Requirements

        1. Write a structured document to org docs using `eve docs write`
        2. Include: summary, key facts, extracted entities, action items (if any)
        3. Preserve provenance: reference page numbers, sections, or timestamps
        4. Apply tags from the submitter plus any you identify
        5. If the file includes a .vtt transcript, use it for timecoded references

Output path: /ingest/${event.payload.ingest_id}/analysis.md
```

**Event variable interpolation** (`${event.payload.xxx}`) follows the same pattern as existing workflow triggers. The orchestrator already resolves event payloads into workflow job metadata.
Output paths should be derived from `event.payload.ingest_id` to avoid collisions across same file names from different uploads.

### 8. CLI Commands

Three new commands under `eve ingest`:

```bash
# Upload and process a file
eve ingest <file> [--title "..."] [--description "..."] [--instructions "..."] [--tags t1,t2]

# List ingest records for a project
eve ingest list [--status pending|processing|done|failed] [--json]

# Show details of a specific ingest record
eve ingest show <ingest_id> [--json]
```

**`eve ingest <file>` flow:**
1. Read file, determine MIME type (prefer library-based detection; keep extension fallback)
2. `POST /orgs/{org}/projects/{proj}/ingest` with metadata → get `upload_url`
3. `PUT` file to presigned URL
4. `POST /orgs/{org}/projects/{proj}/ingest/{id}/confirm` → get `job_id`
5. If `--follow` flag, tail the job logs
6. If `--wait`, block until terminal record status is reached

### 9. Whisper in Worker Dockerfile

Add OpenAI Whisper to the `full` and `production` stages of `apps/worker/Dockerfile`. Whisper requires Python (already in `full` stage) plus the `openai-whisper` pip package and `ffmpeg`.

```dockerfile
# In the full stage, after Python is installed:
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages openai-whisper
```

**Image size impact:** ~1.5 GB (whisper model downloads on first run; pin package version and consider pre-downloading the `base` model in the Docker build for deterministic cold starts).

**Base stage not affected.** Whisper is only in `full`/`production` stages that already have Python.

## Implementation Phases

### Phase 1: Foundation (DB + API)

1. Add `generateIngestId()` to `packages/shared/src/ids.ts`
2. Create DB migration: `ingest_records` table
3. Add `ingestRecordQueries` to `packages/db/src/queries/`
4. Add table migration constraints (`status` check, `updated_at` default/trigger) and indexes
5. Add `IngestModule` to API: controller + service
6. Implement two-phase upload (create → presigned URL → confirm → event)
7. Add `ingest://` URI scheme to `packages/shared/src/lib/resource-uris.ts`
8. Make confirm endpoint idempotent and error-safe
9. Unit tests for URI parsing, query layer, API endpoints (including duplicate confirm paths)

### Phase 2: Worker Hydration

1. Extend `hydrateResources()` in `invoke.service.ts` to handle `ingest://` scheme
2. Wire worker's storage access to use `StorageService.getObject()` for ingest files
3. Add whisper to Dockerfile `full`/`production` stages
4. Implement audio pre-step (MIME detection → whisper → VTT placement)
5. Integration test: ingest file → hydrate → verify `.eve/resources/` contents and whisper fallback behavior

### Phase 3: Workflow + CLI

1. Document the default `doc-ingest` workflow manifest snippet
2. Add `eve ingest` CLI commands (upload, list, show)
3. Wire `--follow` to `eve job follow` for real-time processing visibility
4. Manual test scenario `30-document-ingestion-mvp.md`: looped local-k3d verification of create/confirm + output path

### Phase 4: Status Callbacks

1. On workflow job completion, update ingest record `status` → `done`/`failed`
2. Set `completed_at` timestamp and `job_id` reference
3. Persist `error_message` on failed runs
4. Optional: webhook callback to `callback_url` if provided on ingest

## Files to Create / Modify

| File | Action | Purpose |
| --- | --- | --- |
| `packages/db/migrations/NNNN_create_ingest_records.ts` | Create | DB migration |
| `packages/db/src/queries/ingest-record.queries.ts` | Create | Query layer |
| `packages/shared/src/ids.ts` | Modify | Add `generateIngestId` |
| `packages/shared/src/lib/resource-uris.ts` | Modify | Add `ingest://` scheme |
| `apps/api/src/ingest/ingest.module.ts` | Create | NestJS module |
| `apps/api/src/ingest/ingest.controller.ts` | Create | REST endpoints |
| `apps/api/src/ingest/ingest.service.ts` | Create | Business logic |
| `apps/worker/src/invoke/invoke.service.ts` | Modify | Hydrate `ingest://` + whisper pre-step |
| `apps/worker/Dockerfile` | Modify | Add ffmpeg + whisper |
| `packages/cli/src/commands/ingest.ts` | Create | CLI commands |

## Key Invariants

1. **Ingest records are mostly immutable** — once created, only `status`, `event_id`, `job_id`, `error_message`, `completed_at`, and `updated_at` are updated
2. **API never proxies binary data** — all file transfer goes through presigned URLs
3. **No new event types in trigger matcher** — `system.doc.ingest` works with existing `matchesSystemTrigger()` logic
4. **Whisper is optional** — if not installed (base image), audio files are passed to the agent without transcription
5. **Agent writes output via existing primitives** — `eve docs write` (org docs) is the output channel; no new storage API
6. **Single harness** — mclaude only for MVP; Claude handles PDFs, images, and text natively without conversion tools
7. **Deterministic confirms** — repeated `confirm` calls return current processing state and never create duplicate jobs

## Testing Strategy

| Test | Type | Validates |
| --- | --- | --- |
| URI parsing for `ingest://` | Unit | `parseResourceUri`, `buildIngestUri` |
| Ingest record CRUD | Unit | Query layer |
| Confirm idempotency | Unit/Integration | duplicate confirm requests and invalid state transitions |
| Two-phase upload flow | Integration | API → S3 → confirm → event |
| Resource hydration | Integration | Worker downloads ingest file to `.eve/resources/` |
| Whisper pre-step | Manual | Audio → VTT generation (requires whisper in image) |
| End-to-end: PDF ingest | Manual | CLI → upload → workflow → org docs output |
| Local k3d verification loop (Scenario 30) | Manual | start/deploy loop + repeatable ingestion runs + final doc output |

## Local k3d Verification Loop

Use the local stack as the repeatable acceptance baseline while implementing:

1. `./bin/eh status` (verify current environment)
2. `./bin/eh k8s start && ./bin/eh k8s deploy`
3. Set `EVE_API_URL=http://api.eve.lvh.me`
4. Run scenario `tests/manual/scenarios/30-document-ingestion-mvp.md`
5. Iterate the scenario with `VERIFICATION_LOOPS=3` for deterministic replayability
6. Validate stack reset and replay safety using scenario optional "stress variant" with `./bin/eh k8s stop`, `start`, `deploy` between iterations

Acceptance condition for loop:
- No confirm-path regressions (idempotent status on replayed confirms)
- No broken ingest lifecycle transitions during repeated runs
- Workflow output doc path `/ingest/<ingest_id>/analysis.md` materializes in org docs for at least one successful ingest run

## Relationship to Full Design

This MVP covers the **ingest spine** from the [full design doc](../ideas/document-ingestion-agent-packs.md) — specifically the REST/CLI input channels, ingest records, object store, event emission, and single-agent processing. The full design's triage team, multi-harness routing, Slack file download, org-fs watch paths, and embedding pipeline are explicitly deferred.

The MVP's data model (ingest records), API shape (two-phase upload), and event contract (`system.doc.ingest`) are designed to be forward-compatible with the full design. Adding triage routing later means adding a team definition in the manifest and changing the workflow's harness — no schema changes needed.
