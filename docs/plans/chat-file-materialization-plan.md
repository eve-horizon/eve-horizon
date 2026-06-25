# Chat File Materialization

> **Status**: Implemented (2026-03-09, commit d4a7c0e)
> **Date**: 2026-03-09
> **Author**: Adam / Claude
> **Scope**: Gateway, API (internal endpoints), Worker, Shared schemas

## Problem

When someone uploads a file in Slack (or any chat provider), agents can't access it. The gateway already parses file metadata from Slack events and carries it through to jobs in `metadata.files`, but:

1. Nobody downloads the files (Slack URLs require bot token auth)
2. Nothing stages files into the agent's workspace
3. Slack URLs expire — files become inaccessible after the fact

The ingest pipeline (`eve ingest`) solves this for CLI-driven workflows, but there's no bridge from chat file uploads to agent workspaces.

## Design Principle

**The provider handles provider-specific auth. Everything downstream is provider-agnostic.**

Each chat provider knows how to download its own files (Slack bot token, Nostr relay fetch, etc.). Once files are in Eve storage, the rest of the pipeline works identically regardless of origin.

## Architecture

```
Slack msg + file attachment
     │
     ▼
┌─ Gateway (async phase) ────────────────────────────┐
│  1. Provider downloads file via bot token           │
│  2. Upload to S3 via API presigned URL              │
│  3. Replace url_private with eve-storage:// ref     │
└────────────────────────────────────────────────────-┘
     │
     ▼  (file refs in metadata.files — provider-agnostic)
┌─ API ── chat/route ── create job ──────────────────┐
│  Presigned URL endpoint for upload (new)            │
│  Files flow through in metadata (existing)          │
└────────────────────────────────────────────────────-┘
     │
     ▼
┌─ Worker (workspace provisioning) ──────────────────┐
│  4. Detect metadata.files with eve-storage:// URLs  │
│  5. Download via API presigned URL → .eve/attach/   │
│  6. Write .eve/attachments/index.json               │
└────────────────────────────────────────────────────-┘
     │
     ▼
┌─ Agent ────────────────────────────────────────────┐
│  Reads .eve/attachments/index.json                 │
│  Files at .eve/attachments/{filename}              │
│  Completely provider-agnostic                      │
└────────────────────────────────────────────────────┘
```

## S3 Storage Layout

Files are organized by org, provider channel, and message — giving natural per-channel filing and historical access.

```
eve-internal/
  chat-attachments/
    {org_id}/
      {provider}:{account_id}/           # e.g. slack:T088AQ3D9FX
        {channel_id}/                    # e.g. C0123ABCDEF
          {message_ts}/                  # e.g. 1741534567.123456
            product-spec-v2.pdf
            wireframes.png
          {message_ts}/
            revised-spec.pdf
        {channel_id}/
          ...
```

### Why channel-scoped?

- **Context continuity** — An agent reviewing a doc can see what other files have been shared in the same channel. "Here's v2" makes sense when you can see v1 was shared earlier.
- **Channel as workspace** — Teams naturally organize around channels. A `#product-reviews` channel becomes a filing cabinet of everything reviewed there.
- **Future: channel file index** — Agents could query "what files have been shared in this channel?" without re-downloading anything.
- **Cleanup** — Archiving a channel can prune its file tree. Per-org-flat-bucket makes this impossible.

### Key format

```
chat-attachments/{org_id}/{provider}:{account_id}/{channel_id}/{message_ts}/{file_id}-{filename}
```

Where:
- `org_id` — Eve org (e.g. `org_example`)
- `provider:account_id` — Provider-scoped (e.g. `slack:T088AQ3D9FX`)
- `channel_id` — Channel where the file was shared (e.g. `C0123ABCDEF`)
- `message_ts` — Message timestamp for per-message grouping (Slack: event `ts`)
- `filename` — Original filename, sanitized
- `file_id` — Provider file ID, stable within a provider

The `file_id` component avoids collisions when a user shares the same filename in the same message or thread.

For thread replies, use the thread root `ts` so all files in a thread are grouped together.

## Provider Interface

### Extract `ChatFile` type

The file shape is currently inline in `NormalizedInbound.files`. Extract it as a standalone type in `gateway-provider.interface.ts`:

```typescript
/** File attachment from a chat message. */
export interface ChatFile {
  id: string;
  name: string;
  mimetype?: string;
  url?: string;
  size?: number;
  /** Set after resolveFiles: original provider URL */
  source_url?: string;
  /** Set after resolveFiles: provider name */
  source_provider?: string;
  /** Set after resolveFiles: eve-storage key */
  storage_key?: string;
}
```

Then update `NormalizedInbound`:

```typescript
files?: ChatFile[];
```

### Add `resolveFiles` hook

Add an optional `resolveFiles` method to `GatewayProvider`:

```typescript
interface GatewayProvider {
  // ... existing members ...

  /**
   * Download provider-hosted files and upload to Eve storage.
   * Called in the async phase after webhook acknowledgement.
   * Returns files with provider URLs replaced by eve-storage:// refs.
   *
   * Providers that don't support files can omit this method.
   */
  resolveFiles?(
    files: ChatFile[],
    context: FileResolveContext,
  ): Promise<ChatFile[]>;
}

interface FileResolveContext {
  orgId: string;
  channelId: string;
  /** Message ts (top-level) or thread root ts (thread replies) */
  messageTs: string;
  accountId: string;
  provider: string;
  /** Get a presigned S3 upload URL from the API */
  getUploadUrl: (key: string, contentType?: string) => Promise<string>;
}
```

> **Note on S3 access**: The gateway has no direct S3 client (and shouldn't — it only talks to the API via HTTP). Instead, the gateway calls a new internal API endpoint to get presigned upload URLs. This keeps S3 credentials centralized in the API's `StorageService`. The `getUploadUrl` callback is injected by `GatewayChatService` so providers don't need to know the API URL.

### Slack implementation

```typescript
async resolveFiles(files: ChatFile[], context: FileResolveContext): Promise<ChatFile[]> {
  const token = this.config.settings.access_token;
  const resolved: ChatFile[] = [];

  for (const file of files) {
    if (!file.url || !file.id) { resolved.push(file); continue; }

    // Enforce size limit before downloading
    if (file.size && file.size > MAX_FILE_SIZE) {
      logger.warn({ event: 'file.too_large', fileId: file.id, size: file.size });
      resolved.push({ ...file, source_url: file.url, source_provider: 'slack' });
      continue;
    }

    // Download from Slack
    const response = await fetch(file.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      logger.warn({ event: 'file.download_failed', fileId: file.id, status: response.status });
      resolved.push({ ...file, source_url: file.url, source_provider: 'slack' });
      continue;
    }
    if (!response.body) {
      logger.warn({ event: 'file.empty_response', fileId: file.id });
      resolved.push({ ...file, source_url: file.url, source_provider: 'slack' });
      continue;
    }

    const safeName = `${file.id}-${sanitizeFilename(file.name || file.id)}`;
    const contentType = file.mimetype || response.headers.get('content-type') || 'application/octet-stream';

    // Upload via presigned URL (no AWS SDK needed in gateway)
    const key = `chat-attachments/${context.orgId}/slack:${context.accountId}/${context.channelId}/${context.messageTs}/${safeName}`;
    const uploadUrl = await context.getUploadUrl(key, contentType);
    const body = await response.arrayBuffer();
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body,
    });

    resolved.push({
      ...file,
      url: `eve-storage://${key}`,
      source_url: file.url,
      source_provider: 'slack',
      storage_key: key,
    });
  }

  return resolved;
}
```

### `sanitizeFilename` utility

Create in `packages/shared/src/lib/sanitize-filename.ts`:

```typescript
/** Strip path separators, control chars, and truncate to 255 chars. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 255);
}
```

### Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max files per message | 10 | Already enforced in `slack.provider.ts` (`.slice(0, 10)`) |
| Max file size | 50 MB | Reasonable for documents, images, small videos |
| Total per message | 100 MB | Prevents abuse via 10 x 50MB files |
| Filename length | 255 chars | Filesystem safety (enforced by `sanitizeFilename`) |

```typescript
const MAX_FILE_SIZE = 50 * 1024 * 1024;       // 50 MB
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;     // 100 MB

// Enforce in resolveFiles before downloading:
// 1. Skip files where file.size > MAX_FILE_SIZE (Slack provides size in metadata)
// 2. Track cumulative size; stop resolving when total exceeds MAX_TOTAL_SIZE
// 3. Files that exceed limits are preserved with source_url for fallback
```

Files exceeding limits are skipped with a warning logged. The original provider URL is preserved as fallback metadata. Note that Slack provides `size` in the file metadata, so we can enforce the limit *before* downloading.

## API Internal Endpoint

Add a presigned URL endpoint to the API for chat attachment uploads and downloads. This keeps S3 credentials centralized in the API (via `StorageService`) and avoids adding AWS SDK to the gateway or worker.

```typescript
// POST /internal/storage/chat-attachments/presign
// Body: { key: string, operation: 'upload' | 'download', content_type?: string }
// Returns: { url: string }
```

The `eve-internal` bucket is used (same bucket as org-fs and other internal storage). The key prefix `chat-attachments/` provides namespace isolation.

The worker can also use this endpoint during workspace provisioning to get download URLs.

## Gateway Chat Service Changes

In `gateway-chat.service.ts`, after identity resolution but before routing, call `resolveFiles` if the provider supports it.

**Key field mapping**: `NormalizedInbound` has no `timestamp` field. The message timestamp must be extracted from the raw Slack payload. For Slack: `event.ts` for top-level messages, `event.thread_ts` for thread replies (groups thread files together). The `threadId` field on `NormalizedInbound` already captures this (`thread_ts ?? ts ?? event_id`).

```typescript
// In resolveAndRoute(), after identity resolution (step 2), before routing (step 3):

// Resolve files (download from provider, upload to Eve storage)
if (inbound.files?.length && provider.resolveFiles) {
  try {
    // Extract message timestamp for S3 key grouping.
    // threadId = thread_ts ?? ts ?? event_id — groups thread files together.
    const messageTs = inbound.threadId || inbound.dedupeKey || 'unknown';

    const getUploadUrl = async (key: string, contentType?: string) => {
      const result = await postJson<{ url: string }>('/internal/storage/chat-attachments/presign', {
        key, operation: 'upload', content_type: contentType,
      });
      return result.url;
    };

    inbound.files = await provider.resolveFiles(inbound.files, {
      orgId: integration.org_id,
      channelId: inbound.channel,
      messageTs,
      accountId: inbound.accountId,       // camelCase on NormalizedInbound
      provider: inbound.provider,
      getUploadUrl,
    });
  } catch (err) {
    logger.warn({ event: 'file.resolve_failed', error: String(err) });
    // Non-fatal: files stay as provider URLs (agents won't be able to access them,
    // but the message text still routes normally)
  }
}
```

### Listener dispatch also needs files

Currently `handleListenerMessage()` does NOT include `files` in its metadata. This means files shared in listener-dispatched messages (plain channel messages without @mention) are lost. Fix:

```typescript
// In handleListenerMessage(), add files to the dispatch metadata:
metadata: {
  dedupe_key: inbound.dedupeKey,
  integration_id: integration.integration_id,
  raw_text: inbound.text,
  files: inbound.files,  // <-- add this
},
```

## Worker Workspace Staging

During workspace provisioning, if `job.metadata.files` contains entries with `eve-storage://` URLs, stage them into `.eve/attachments/`. This follows the same pattern as the existing `hydrateResources()` method in `invoke.service.ts` — add it as a method on the invoke service, not a standalone function.

The worker downloads files via the same API presigned URL endpoint used by the gateway for uploads. No direct S3 access needed.

```typescript
// In InvokeService, called during workspace provisioning:
private async stageAttachments(workspacePath: string, files: ChatFile[]): Promise<void> {
  const eveFiles = files.filter(f => f.url?.startsWith('eve-storage://'));
  if (eveFiles.length === 0) return;

  const attachmentsDir = join(workspacePath, '.eve', 'attachments');
  await mkdir(attachmentsDir, { recursive: true });

  const index: AttachmentIndex = { files: [] };
  const usedNames = new Set<string>();

  for (const file of eveFiles) {
    const key = file.url!.replace('eve-storage://', '');
    const safeName = sanitizeFilename(file.name || file.id || 'attachment');
    let filename = safeName;
    let suffix = 1;
    while (usedNames.has(filename)) {
      const dot = safeName.lastIndexOf('.');
      if (dot > 0) {
        filename = `${safeName.slice(0, dot)}-${suffix}${safeName.slice(dot)}`;
      } else {
        filename = `${safeName}-${suffix}`;
      }
      suffix += 1;
    }
    usedNames.add(filename);

    // Download via presigned URL from API
    const { url: downloadUrl } = await postJson<{ url: string }>(
      '/internal/storage/chat-attachments/presign',
      { key, operation: 'download' },
    );
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      logger.warn({ event: 'attachment.download_failed', key, status: response.status });
      continue;
    }

    const destPath = join(attachmentsDir, filename);
    await writeFile(destPath, Buffer.from(await response.arrayBuffer()));

    index.files.push({
      id: file.id,
      name: file.name || file.id || 'attachment',
      path: `.eve/attachments/${filename}`,
      mimetype: file.mimetype,
      size: file.size,
      source_url: file.source_url,
      source_provider: file.source_provider,
      storage_key: file.storage_key,
    });
  }

  if (index.files.length > 0) {
    await writeFile(
      join(attachmentsDir, 'index.json'),
      JSON.stringify(index, null, 2),
    );
  }
}
```

## Attachment Index Schema

```typescript
// packages/shared/src/schemas/attachment-index.ts

interface AttachmentIndex {
  files: Array<{
    /** Provider attachment ID, when available */
    id?: string;
    /** Original filename */
    name: string;
    /** Relative path from workspace root */
    path: string;
    /** MIME type (e.g. application/pdf) */
    mimetype?: string;
    /** File size in bytes */
    size?: number;
    /** Original provider URL */
    source_url?: string;
    /** Provider that supplied this file */
    source_provider?: string;
    /** Storage key for re-download/debug */
    storage_key?: string;
  }>;
}
```

Written to `.eve/attachments/index.json`. Follows the same pattern as `.eve/resources/index.json` used by the ingest pipeline.

## What the Agent Sees

```json
{
  "files": [
    {
      "id": "F019ABC123",
      "name": "product-spec-v2.pdf",
      "path": ".eve/attachments/F019ABC123-product-spec-v2.pdf",
      "mimetype": "application/pdf",
      "size": 245760,
      "source_url": "https://files.slack.com/files-pri/T088AQ3D9FX-F019ABC123/product-spec-v2.pdf",
      "source_provider": "slack",
      "storage_key": "chat-attachments/org_example/slack:T088AQ3D9FX/C0123ABCDEF/1741534567.123456/F019ABC123-product-spec-v2.pdf"
    },
    {
      "id": "F019ABC124",
      "name": "wireframes.png",
      "path": ".eve/attachments/F019ABC124-wireframes.png",
      "mimetype": "image/png",
      "size": 89400,
      "source_url": "https://files.slack.com/files-pri/T088AQ3D9FX-F019ABC124/wireframes.png",
      "source_provider": "slack",
      "storage_key": "chat-attachments/org_example/slack:T088AQ3D9FX/C0123ABCDEF/1741534567.123456/F019ABC124-wireframes.png"
    }
  ]
}
```

Agent SKILL.md can reference this:

```markdown
## File Attachments

If the user attached files to their message, they are available at `.eve/attachments/`.
Check `.eve/attachments/index.json` for the file manifest before processing.
```

## Future Extensions

### Channel file history

Since files are keyed by channel, a future `eve chat files --channel <id>` command or agent API could list all files ever shared in a channel:

```bash
eve chat files --org org_example --channel C0123ABCDEF
```

This gives agents memory across conversations: "The v1 spec was shared 3 days ago in this channel."

### Cross-provider parity

| Provider | Download mechanism | Auth |
|----------|-------------------|------|
| Slack | `GET url_private` | `Bearer` bot token |
| WebChat | File already uploaded via WebSocket | Already in Eve storage (no additional auth required) |
| Nostr | NIP-94 file metadata → fetch URL | Relay auth / signed event rules may apply |
| GitHub | API file content endpoint | Installation token |

Each provider implements `resolveFiles()` with its own auth. The rest of the pipeline stays identical.

### Auto-ingest bridge

For workflows that want both chat routing AND ingest events, add an optional flag to the chat route:

```yaml
# agents.yaml
pm-coordinator:
  gateway:
    policy: routable
    auto_ingest: true  # files also trigger doc.ingest events
```

This creates ingest records alongside the chat job — the pm-review workflow fires from ingest, while the coordinator still gets the chat message with files attached.

## Implementation Order

| Phase | What | Unblocks |
|-------|------|----------|
| 1 | Extract `ChatFile` type + `sanitizeFilename` utility | Shared types for all phases |
| 2 | API presigned URL endpoint (`/internal/storage/chat-attachments/presign`) | Gateway upload + worker download |
| 3 | `resolveFiles` interface + Slack implementation | Files download + stored |
| 4 | Gateway chat service wiring (both command + listener paths) | Files resolved before routing |
| 5 | Worker staging + index.json (method on InvokeService) | Agents can read files |
| 6 | Channel file history API | Future: cross-conversation memory |

Phases 1-5 are the MVP. Phase 6 is a future enhancement.

### Cleanup / TTL

Chat attachments accumulate in S3 indefinitely. For MVP this is acceptable — file volume is low during pre-launch. Future options:

- S3 lifecycle rule on the `chat-attachments/` prefix (e.g., 90-day expiry)
- Channel-archive-triggered cleanup (prune when a channel is archived)
- Per-org storage quotas

## `eve-storage://` Scheme

The `eve-storage://` prefix is internal plumbing between gateway and worker — it's intentionally NOT added to the existing `resource-uris.ts` scheme system (`org_docs://`, `job_attachments://`, `ingest://`). Those schemes represent user-facing resource references that can be composed in `resource_refs`. Chat attachments flow through `metadata.files` and are resolved by the worker directly, without going through the resource ref pipeline.

If chat attachments later need to be referenced as resource refs (e.g., `auto_ingest` bridge), we'd add `chat_attachment://` as a proper scheme at that point.

## Alternatives Considered

### Direct S3 from gateway

Have the gateway upload directly to S3 using AWS SDK. Rejected because:
- Gateway currently has zero AWS SDK dependency (by design — it only talks to API via HTTP)
- Adding `@aws-sdk/client-s3` to gateway risks the same barrel-export hazard we hit with `@eve/shared`
- Presigned URL approach achieves the same result with a single extra HTTP call (to get the URL)
- S3 credentials stay centralized in one service (API)

### Auto-ingest at gateway

Fire `doc.ingest` events for every file attachment. Rejected because:
- Creates a *separate* job from the chat message — the expert panel loses the "review this" context
- Every casual file share triggers document processing
- Double job creation (chat route + ingest event)

### Worker-level download via proxy

Have the worker call an API proxy that downloads using the integration's token. Rejected because:
- Breaks provider isolation (API needs provider-specific download logic)
- Adds latency at job execution time
- More complex error handling (download fails after job started)

### Base64 in job metadata

Embed file contents directly in the job record. Rejected because:
- Database bloat for large files
- 50MB PDFs don't belong in a JSONB column
- Doesn't scale

### Flat per-org bucket

Store all files under `chat-attachments/{org_id}/{uuid}/{filename}`. Rejected because:
- No channel context — can't build per-channel file history
- No natural grouping — "what was shared in #product-reviews?" requires scanning everything
- Harder to prune — can't archive by channel
