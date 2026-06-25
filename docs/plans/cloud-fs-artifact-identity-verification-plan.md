# Cloud FS Artifact Identity & Exact Verification Plan

> **Status**: Proposed 2026-06-01
> **Scope**: One Eve Horizon implementation PR
> **Source**: Downstream gap report — "Cloud FS manifests need stable artifact identity for exact verification." A workflow publishes generated Markdown/JSON/text artifacts to a mounted cloud filesystem, writes a manifest, and later needs to prove which exact bytes it published without re-searching a mount full of duplicate same-name files.
> **Related**:
> - [`cloud-fs-integration-plan.md`](./cloud-fs-integration-plan.md) — original Cloud FS design (mounts, provider pattern, Google Drive first)
> - Adjacent gap `cloud-fs-idempotent-file-sync.md` (downstream) — the **write** side: safe writes and duplicate prevention. This plan is the **read/verify** side, correct even when duplicates already exist.
> - [`app-object-bucket-credentials-plan.md`](./app-object-bucket-credentials-plan.md) — sibling storage primitive; not affected here.

## Problem

Cloud FS today gives agents path browsing, filename search, per-file metadata/download by provider file ID, and upload by logical path. That is enough for manual inspection. It is **not** enough for deterministic manifest verification on a reused mount.

The concrete failure: a workflow fans out into N steps, each generating an artifact and publishing it to a Drive folder. Retries and re-runs leave multiple same-name files in the same folder. A later verifier holds a manifest (logical path, size, content hash) but has no durable, exact handle back to the published bytes. It must browse or search by name, download every plausible duplicate, hash each one locally, and stop when a hash matches. That is slow, burns API calls, and cannot distinguish "the provider revised this file" from "someone wrote a new duplicate" without downloading content.

Source review (current surface):

- `packages/shared/src/schemas/cloud-fs.ts:66` — `CloudFsEntrySchema` exposes `id`, `name`, `path`, `mime_type`, `size_bytes`, `modified_at`, `web_url`, `is_folder`. **No** provider revision, checksum/content hash, or immutable identity.
- `packages/shared/src/cloud-fs/google-drive-provider.ts:23` — `FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents'`. The Drive API can return `headRevisionId`, `md5Checksum`, `sha256Checksum`, and `version` for free in the same call, but we never request them.
- `apps/api/src/cloud-fs/cloud-fs.service.ts:231` — `uploadFile(...)` returns only `{ file_id, web_view_link }`, narrowing the full `CloudFsEntry` the provider already produced (`google-drive-provider.ts:272` returns `toEntry(file)`). The publisher never learns the revision or checksum of what it just wrote.
- `apps/api/src/cloud-fs/cloud-fs.service.ts:210` and `apps/api/src/cloud-fs/cloud-fs.controller.ts:156` — download requires `file_id` and is unconditional. There is no "download only if this is still the exact byte revision I expect" path.
- `apps/api/src/cloud-fs/cloud-fs.service.ts:167` — `browseMount(...)` lists a folder. On duplicate same-name files a verifier sees multiple candidates and cannot tell which one the manifest meant.
- `apps/api/src/cloud-fs/cloud-fs.service.ts:149` — `search(...)` matches by name then filters ancestry. It is discovery, not exact lookup.
- `packages/cli/src/commands/cloud-fs.ts:208` — CLI documents `list | mount | unmount | show | update | ls | search`. There is no upload command and no verification command, so agents hand-roll a bespoke verifier.

## Goal

Make generated-artifact verification an exact, mostly-download-free lookup:

1. **Publish returns identity.** Upload returns a full, durable artifact reference (file ID + provider revision + content hash + size + mime + url), suitable for writing verbatim into a manifest.
2. **Verify without scanning.** A verifier resolves a manifest entry by file ID and proves byte-identity from metadata alone (revision or provider checksum), downloading content only when the provider cannot expose either.
3. **Fail closed on download.** A caller can ask for the exact bytes and get a `409` if the current content no longer matches the expected identity, instead of silently receiving a different revision or a duplicate.
4. **Provider-neutral.** Providers with native revisions/checksums (Google Drive) expose them; providers without them fall back to an Eve-computed content hash plus file ID and timestamp. The reference format is identical across providers.

This turns minutes of search/download/hash probing into a single metadata call per artifact in the common case, and makes manifests auditable.

## Design

### The artifact reference

One new durable record, the **`CloudFsArtifactRef`** — everything a later agent needs to re-find and re-prove an exact published artifact:

```jsonc
{
  "mount_id": "cfm_01k...",          // which mount
  "provider": "google_drive",
  "file_id": "1AbC...",              // primary, exact locator (no search)
  "path": "/reports/q-summary.md",   // logical path at publish time (advisory; may go stale)
  "revision": "0B5x...",             // provider content-revision id (Drive headRevisionId); null if unsupported
  "content_hash": "sha256:9f86d0...",// canonical, cross-provider byte identity
  "content_hash_source": "provider_sha256", // provider_sha256 | provider_md5 | eve_sha256
  "size_bytes": 1234,
  "mime_type": "text/markdown",
  "modified_at": "2026-06-01T12:00:00Z",
  "web_url": "https://drive.google.com/...",
  "captured_at": "2026-06-01T12:00:01Z"
}
```

Design choices:

- **`content_hash` is canonical and prefixed** (`sha256:<hex>`), matching the existing convention in `packages/shared/src/skills/materializer.ts:359`. This is the cross-provider equality key. A separate optional `content_hash_source` records provenance so callers know whether the hash came from the provider or from Eve.
- **`revision` is the cheap fast path.** Google Drive's `headRevisionId` changes if and only if file content changes. Comparing it proves byte-identity from a single metadata GET with **zero content download**. Providers without revisions set it `null` and fall back to checksum/content-hash comparison.
- **`file_id` is the locator; `path` is advisory.** Verification never depends on path freshness or name uniqueness. `path` is retained only for human readability and as a last-resort recovery mode (below).

### Verification tiers (resolve)

`resolveArtifacts` escalates through tiers, stopping at the first that can decide, and reports which tier it used:

| Tier | Method | Cost | Used when |
| --- | --- | --- | --- |
| 1 | `revision` | 1 metadata call | both expected & current have a `revision` |
| 2 | `provider_checksum` | 1 metadata call | provider exposes `md5Checksum`/`sha256Checksum` in metadata |
| 3 | `content_hash` | 1 metadata + 1 download | neither revision nor provider checksum is comparable (e.g. Google native editor docs) |
| 4 | `path_match` | browse parent + per-candidate tier 2/3 | the ref carries no `file_id` (legacy/recovery) |

Each resolve result is one of:

- `verified` — current bytes are provably the manifest's bytes.
- `changed` — the file still exists at this `file_id` but content differs from the manifest.
- `missing` — `file_id` returns 404 (or path mode finds no candidate).
- `ambiguous` — path mode finds multiple name candidates and the ref carries no `content_hash` to disambiguate. (When a `content_hash` is present, duplicates collapse: a matching hash is `verified`; identical duplicates are still `verified` to the same bytes.)

### Fail-closed download

Extend the existing download route with optional expectations. The controller already buffers the response before sending (`cloud-fs.controller.ts:171-183`), so the service can verify identity **before** any bytes leave:

- `GET .../files/:file_id/download?expected_revision=<r>&expected_hash=sha256:<h>`
- If an expectation is supplied and the resolved identity does not match → `409 Conflict` carrying the current `CloudFsArtifactRef` in the body. No bytes are streamed.
- If it matches, or no expectation is supplied → stream as today.
- For providers that cannot prove identity from metadata, the service hashes the buffered bytes and `409`s on mismatch — fail closed either way.

### Why no DB migration

Artifact refs live in caller-owned manifests, not in Eve. Verification is a pure function of (mount, provider, ref) against live provider state. No server-side artifact table is needed for this gap. A future "platform-maintained artifact index" is explicitly out of scope (see *Keep out*).

## Single PR scope

1. Add manifest-grade identity to the Cloud FS schemas: optional identity fields on `CloudFsEntry`, plus a new `CloudFsArtifactRefSchema` and resolve request/response schemas.
2. Widen Google Drive `FILE_FIELDS` and `toEntry(...)` to populate revision + checksums for free.
3. Return a full `CloudFsArtifactRef` from upload (superset of the current `{ file_id, web_view_link }`), computing an Eve `sha256` fallback from the upload buffer when the provider reports no hash.
4. Add `resolveArtifacts(...)` to the service and a `POST .../artifacts/resolve` endpoint (batch).
5. Make download fail-closed via optional `expected_revision` / `expected_hash` query params.
6. Add CLI: `eve cloud-fs put`, `eve cloud-fs verify-manifest`, `eve cloud-fs download-ref`.
7. Tests, OpenAPI/system docs, and the eve-skillpacks sync obligation.

## Keep out of this PR

- New providers beyond Google Drive. The interface stays provider-neutral, but only the Drive implementation ships.
- A platform-persisted artifact/manifest index table or any DB migration.
- Object-store semantics (immutability guarantees, server-side versioning, content-addressed storage).
- Server-side manifest authoring/storage. The manifest is a caller-owned JSON file; the CLI reads and writes it, the platform does not store it.
- Idempotent/dedup-on-write behavior — that is the adjacent `cloud-fs-idempotent-file-sync.md` gap. This PR is read/verify only.
- New agent runtime tools. The CLI + REST surface is enough; exposing `verify-manifest` as a first-class harness tool can follow once the API is proven.

## Implementation details

### Schemas — `packages/shared/src/schemas/cloud-fs.ts`

Add optional identity fields to `CloudFsEntrySchema` (populated when cheaply available; absent otherwise, so browse stays lean):

```ts
export const CloudFsEntrySchema = z.object({
  // ...existing fields...
  revision: z.string().nullable().optional(),            // provider content-revision id
  content_hash: z.string().nullable().optional(),        // "sha256:<hex>"
  content_hash_source: z.enum(['provider_sha256', 'provider_md5', 'eve_sha256']).nullable().optional(),
});
```

Add the durable reference and resolve contracts:

```ts
export const CloudFsArtifactRefSchema = z.object({
  mount_id: z.string(),
  provider: z.string(),
  file_id: z.string(),
  path: z.string(),
  revision: z.string().nullable(),
  content_hash: z.string(),
  content_hash_source: z.enum(['provider_sha256', 'provider_md5', 'eve_sha256']),
  size_bytes: z.number().nullable(),
  mime_type: z.string(),
  modified_at: z.string(),
  web_url: z.string(),
  captured_at: z.string(),
});
export type CloudFsArtifactRef = z.infer<typeof CloudFsArtifactRefSchema>;

// Minimal input a verifier sends per artifact (mount comes from the URL).
export const CloudFsArtifactRefInputSchema = z.object({
  file_id: z.string().optional(),
  path: z.string().optional(),
  revision: z.string().nullable().optional(),
  content_hash: z.string().optional(),
  size_bytes: z.number().nullable().optional(),
}).refine(v => v.file_id || v.path, { message: 'file_id or path is required' });

export const CloudFsResolveRequestSchema = z.object({
  refs: z.array(CloudFsArtifactRefInputSchema).min(1).max(500),
});

export const CloudFsResolveResultSchema = z.object({
  status: z.enum(['verified', 'changed', 'missing', 'ambiguous']),
  method: z.enum(['revision', 'provider_checksum', 'content_hash', 'path_match', 'file_id_only']),
  expected: z.object({ file_id: z.string().nullable(), revision: z.string().nullable(), content_hash: z.string().nullable() }),
  current: CloudFsArtifactRefSchema.nullable(),
  candidates: z.array(CloudFsArtifactRefSchema).optional(), // populated only for `ambiguous`
});

export const CloudFsResolveResponseSchema = z.object({
  mount_id: z.string(),
  results: z.array(CloudFsResolveResultSchema),
});
```

The CLI manifest file format (CLI-owned, stable):

```jsonc
{ "version": 1, "mount_id": "cfm_xxx", "artifacts": [ /* CloudFsArtifactRef[] */ ] }
```

### Provider — `packages/shared/src/cloud-fs/google-drive-provider.ts`

- Widen the constant:
  `FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents,headRevisionId,md5Checksum,sha256Checksum,version'`.
- Extend the `DriveFile` interface with `headRevisionId?`, `md5Checksum?`, `sha256Checksum?`, `version?`.
- Map in `toEntry(...)`:
  - `revision = file.headRevisionId ?? null` (Drive native docs have no head revision id → `null`, falls through to content-hash tier).
  - `content_hash`/`content_hash_source` preference: `sha256Checksum` → `('sha256:'+sha256Checksum, 'provider_sha256')`; else `md5Checksum` → `('md5:'+md5Checksum, 'provider_md5')`; else `(null, undefined)`.
  - Note: `md5:`-prefixed hashes are comparable to other `md5:` hashes only. The canonical cross-provider key remains `sha256:`. When the manifest hash and current hash use different algorithms, resolve downloads and recomputes `sha256` (tier 3) rather than reporting a false `changed`.
- No new provider methods are required for tiers 1–3: `getFileMetadata` already returns the entry with revision + checksums, and tier 3 uses the existing `downloadFile`. The `CloudFsProvider` interface in `packages/shared/src/cloud-fs/types.ts` is unchanged except that `CloudFsEntry` now carries optional identity fields.

### Service — `apps/api/src/cloud-fs/cloud-fs.service.ts`

- **`uploadFile(...)`** returns `CloudFsArtifactRef` (superset; keep `file_id` and `web_view_link` keys for back-compat). After the provider upload, if the returned entry has no `content_hash`, compute `eve_sha256` from the in-hand `content` buffer (`createHash('sha256')`, prefix `sha256:`). Build the ref from the entry + mount + `captured_at`.
- **`resolveArtifacts(orgId, mountId, refs)`** implements the tier ladder above. For each ref:
  - `file_id` present: `getFileMetadata(file_id)` → 404 ⇒ `missing`; else build current ref and compare by tier 1 → 2 → 3. If the ref carries no comparable identity at all, return `verified` with `method: 'file_id_only'` (existence only — honest, weakest result).
  - `file_id` absent (path mode): resolve the parent path, list it, collect name matches; 0 ⇒ `missing`; with `content_hash`, match per-candidate (tier 2/3) ⇒ `verified`/`changed`; without `content_hash` and >1 candidate ⇒ `ambiguous` with `candidates` populated.
  - Tier 3 downloads via `downloadFile`, buffers, hashes `sha256`, compares.
- **`downloadFile(...)`** gains optional `expected: { revision?, hash? }`. When present, resolve identity first; on mismatch throw `ConflictException` with the current ref. For metadata-unverifiable providers, hash the buffered bytes before returning and `409` on mismatch.
- Reuse `resolveMount` / `getProviderAndToken` / `handleProviderError` unchanged.

### Controller — `apps/api/src/cloud-fs/cloud-fs.controller.ts`

- `POST orgs/:org_id/cloud-fs/mounts/:mount_id/artifacts/resolve` — `@RequirePermission('cloud_fs:read')`, body `CloudFsResolveRequest`, returns `CloudFsResolveResponse`. Same `assertMountAccess(..., 'read')` guard as browse.
- Extend `GET .../files/:file_id/download` with optional `@Query('expected_revision')` and `@Query('expected_hash')`, passed through to the service. A `409` surfaces the current ref so the caller can decide.
- `POST .../upload` response type becomes `CloudFsArtifactRef` (still includes `file_id`, `web_view_link`).

### CLI — `packages/cli/src/commands/cloud-fs.ts`

Add three subcommands and update the usage/`default` help block:

- **`eve cloud-fs put <local_path> --mount <id> --to <remote_path> [--mime <type>] [--json]`** — reads the local file, `POST`s to `.../upload` with the `X-Cloud-FS-Path` header, prints the returned `CloudFsArtifactRef`. With `--json` it prints exactly the ref so a script can append it to a manifest. (Closes the publish side; today there is no upload CLI at all.)
- **`eve cloud-fs verify-manifest <manifest.json> [--mount <id>] [--json]`** — reads the manifest, `POST`s its `artifacts` to `.../artifacts/resolve`, prints a status table (`verified` / `changed` / `missing` / `ambiguous`, with method), and exits non-zero if any entry is not `verified`. `--mount` overrides the manifest's `mount_id`.
- **`eve cloud-fs download-ref <ref.json> [--out <path>] [--json]`** — fail-closed download: `GET .../files/:file_id/download?expected_revision=...&expected_hash=...`; on `409`, print the conflict (expected vs current) and exit non-zero; on success, write to `--out` (or stdout).

Reuse `requestJson` / `getStringFlag` / `getOrgOrThrow`; add a small streaming/binary fetch helper if `requestJson` cannot return raw bytes for `download-ref`.

## Tests

- **Shared (`packages/shared`)**:
  - `toEntry` maps `headRevisionId` → `revision` and prefers `sha256Checksum` → `content_hash` with the right `content_hash_source`; native-doc entry (no head revision / no checksum) yields `revision: null`, `content_hash: null`.
  - Schema round-trips for `CloudFsArtifactRef`, resolve request/response, and the input `refine` (rejects a ref with neither `file_id` nor `path`).
- **API service (mock provider)**:
  - upload returns a full ref; when the provider reports no hash, an `eve_sha256` hash is computed from the buffer and `content_hash_source: 'eve_sha256'`.
  - resolve tier 1: matching/mismatching `revision` ⇒ `verified`/`changed` with `method: 'revision'`, no download call.
  - resolve tier 2: revision absent, provider `sha256Checksum` matches/differs ⇒ `verified`/`changed` (`provider_checksum`), no download.
  - resolve tier 3: revision + provider checksum absent ⇒ download is called once, `sha256` compared ⇒ `verified`/`changed` (`content_hash`).
  - resolve `missing` on 404; path-mode `ambiguous` with two same-name candidates and no `content_hash`; path-mode `verified` when `content_hash` disambiguates duplicates.
  - download fail-closed: matching expectation streams; mismatching `expected_hash`/`expected_revision` throws `409` carrying the current ref; no expectation streams as before.
- **CLI**: `verify-manifest` table + non-zero exit when any entry is not `verified`; `put --json` emits a parseable ref; `download-ref` exits non-zero and prints the conflict on `409`.
- **Integration** (`apps/api/test/integration`, behind the existing Cloud FS integration gating since it needs a live provider/integration): publish two same-name artifacts to one folder, then resolve the manifest and confirm each entry resolves to its exact `file_id` with `status: verified` and zero filename search.

## Docs in the PR

Update only docs describing shipped behavior, in the same PR:

- `docs/system/openapi.yaml` / `openapi.json` — regenerate so the new `artifacts/resolve` route, the widened upload response, and the download `expected_*` params appear (the current cloud-fs entries are at `openapi.yaml:11071+`).
- A Cloud FS verification section in the system docs (extend the Cloud FS coverage in `docs/system/manifest.md` or add a focused note under `docs/system/`), documenting the artifact ref, the resolve tiers, fail-closed download, and the CLI manifest format.
- `CLAUDE.md` Update Log entry summarizing the new artifact-identity surface.

Per the **eve-skillpacks sync obligation** in `CLAUDE.md`, update the public references in `../eve-skillpacks/eve-work/eve-read-eve-docs/references/` when this ships (do **not** edit them for this planning-only doc):

- `cli.md` — add `eve cloud-fs put | verify-manifest | download-ref` to the Cloud FS command list (currently lines ~109-122).
- `object-store-filesystem.md` — document artifact refs, exact verification, and the manifest format under the Cloud FS section.
- `overview.md` — note that Cloud FS uploads now return a durable artifact reference.

## Acceptance criteria

- `eve cloud-fs put` returns a `CloudFsArtifactRef` containing `file_id`, `revision` (or `null`), `content_hash` (`sha256:`), and `content_hash_source`.
- `POST .../artifacts/resolve` proves byte-identity for an unchanged Drive file using metadata only (`method: 'revision'`), with no content download.
- A folder containing multiple same-name duplicates resolves each manifest entry to its exact published bytes by `file_id`, with **zero** filename search.
- A file whose content changed since publish resolves to `status: 'changed'`, distinguishable from a `missing` (404) file and from a new duplicate.
- `download-ref` against changed content fails closed with `409` and surfaces the current ref; against unchanged content it returns the exact bytes.
- Google native editor docs (no `headRevisionId`, no checksum) still verify correctly via the tier-3 content-hash fallback.
- `eve cloud-fs verify-manifest` exits non-zero when any entry is not `verified` and prints a clear per-entry status/method table.
- Existing callers of `POST .../upload` that read `file_id` / `web_view_link` keep working (response is a superset).
- `pnpm build` and `pnpm test` pass; OpenAPI is regenerated.

## References

| File | Why |
| --- | --- |
| `packages/shared/src/schemas/cloud-fs.ts` | `CloudFsEntrySchema` + new artifact ref / resolve schemas |
| `packages/shared/src/cloud-fs/types.ts` | `CloudFsProvider` interface; `CloudFsEntry` import surface |
| `packages/shared/src/cloud-fs/google-drive-provider.ts` | `FILE_FIELDS`, `DriveFile`, `toEntry`, `getFileMetadata`, `downloadFile`, `uploadFile` |
| `apps/api/src/cloud-fs/cloud-fs.service.ts` | `uploadFile` narrowing to fix, new `resolveArtifacts`, fail-closed `downloadFile` |
| `apps/api/src/cloud-fs/cloud-fs.controller.ts` | New `artifacts/resolve` route, download `expected_*` params, upload response type |
| `packages/cli/src/commands/cloud-fs.ts` | New `put` / `verify-manifest` / `download-ref` subcommands + help |
| `packages/shared/src/skills/materializer.ts:359` | Existing `sha256:<hex>` hashing convention to match |
| `docs/system/openapi.yaml:11071` | Current Cloud FS route definitions to regenerate |
| `docs/plans/cloud-fs-integration-plan.md` | Provider pattern, mount model, agent-native framing |
