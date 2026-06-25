# Cloud FS Browse Pagination Plan

> **Status**: Reviewed 2026-06-02
> **Scope**: One Eve Horizon implementation PR
> **Tracking**: `eve-horizon-rb3j`
> **Source**: Downstream gap report — "Cloud FS browse should expose pagination for large directories." A workflow step copies an entire mounted cloud-filesystem directory into its workspace before running deterministic validation, but `eve cloud-fs ls` returns only the first provider page (~100 entries). Files past that page exist (name-search still finds them) but cannot be enumerated.
> **Related**:
> - [`cloud-fs-integration-plan.md`](./cloud-fs-integration-plan.md) — original Cloud FS design (mounts, provider pattern, Google Drive first).
> - [`cloud-fs-artifact-identity-verification-plan.md`](./cloud-fs-artifact-identity-verification-plan.md) — the **verify** side (exact bytes by `file_id` + revision + hash). Orthogonal: identity proves *which bytes*; this plan guarantees you can *see every entry* to verify in the first place.
> - Adjacent gap `cloud-fs-idempotent-file-sync.md` (downstream) — the **write** side (prevent duplicate same-name files). This plan is the **read/enumerate** side, and must stay correct even when duplicates already exist.

## Problem

The provider layer already models pagination end to end. The public Cloud FS browse API and the CLI throw it away.

Source review (current surface):

- `packages/shared/src/cloud-fs/types.ts:33` — `ListOptions` already carries `page_size`, `page_token`, `order_by`, `mime_type_filter`.
- `packages/shared/src/cloud-fs/types.ts:44` — `CloudFsProvider.listFiles(...)` already returns `{ entries, next_page_token? }`.
- `packages/shared/src/cloud-fs/google-drive-provider.ts:135` — `GoogleDriveProvider.listFiles(...)` already honors `page_token`/`page_size`/`order_by`, requests `nextPageToken` from Drive, and returns `next_page_token`. **It is fully paginated; nobody upstream uses it.**
- `apps/api/src/cloud-fs/cloud-fs.service.ts:119` — `browse(...)` calls `provider.listFiles(accessToken, folderId)` with **no options** and returns only `{ mount_id, path, entries }`, silently discarding `next_page_token`.
- `apps/api/src/cloud-fs/cloud-fs.service.ts:167` — `browseMount(...)` does the same.
- `apps/api/src/cloud-fs/cloud-fs.service.ts:149` — `search(...)` does the same (drops `next_page_token` too).
- `packages/shared/src/schemas/cloud-fs.ts:83` — `CloudFsBrowseResponseSchema` exposes only `{ mount_id, path, entries }`. No `next_page_token`.
- `packages/shared/src/schemas/cloud-fs.ts:95` — `CloudFsBrowseRequestSchema` exposes `{ mount_id, path, recursive }`. No `page_token`, `page_size`, or `order_by`.
- `apps/api/src/cloud-fs/cloud-fs.controller.ts:104` / `:123` — `browse` / `browseMount` read only `mount_id`/`folder_id`/`path` as individual `@Query` params (the Zod request schema above is **not** wired into request parsing — it's documentation/client contract only).
- `apps/api/src/cloud-fs/cloud-fs.controller.ts:234` — `search` reads `q` and `mount_id` only. The CLI already sends `mime_type`, but the controller/service never forward it to `ListOptions.mime_type_filter`.
- `packages/cli/src/commands/cloud-fs.ts:354` — `ls`/`browse` builds `?path=&mount_id=` only; it has no `--all`, `--page-token`, `--page-size`, or `--order-by`. Its local `CloudFsBrowseResponse` type (`:46`) has no `next_page_token` field.
- `packages/cli/src/lib/help.ts:2704` / `:2715` — generated CLI help also describes only the one-page browse/search surface, so updating the command handler alone would leave stale help.

**Second defect, same trap — `recursive` is dead.** `recursive` is declared in `CloudFsBrowseRequestSchema` (`:98`) but **no controller or service code reads it**. A caller who passes `recursive=true` to "get the whole tree" silently receives one un-paged page of one directory and believes traversal was complete. That is the same false-confidence failure as the pagination gap, so it is fixed here, not deferred.

Observed behavior: a directory with more than ~100 files returns only the first 100 entries from `eve cloud-fs ls`. The bytes exist; the browse surface cannot enumerate them.

## Goal

Make the browse/search surface **completely enumerable** and make `recursive` mean what it says:

1. **Single-directory pagination is exposed.** Browse returns `next_page_token`; callers pass `page_token`/`page_size` to walk every page. (Pure plumbing — the provider already does the work.)
2. **The CLI can materialize a whole directory.** `eve cloud-fs ls --all` auto-pages until the directory is exhausted; `--page-token` / `--page-size` allow manual paging.
3. **`recursive` stops lying.** A recursive browse performs a bounded, fully-auto-paged server-side subtree walk and reports `truncated` so the caller knows whether traversal was complete. (Fallback if descoped: reject `recursive=true` with a clear `400` — the silent one-page lie must die either way.)
4. **Search is paginated for symmetry.** `search` drops the same token and also drops the existing CLI `--mime-type` filter; both get fixed so name-search (the current workaround) is itself complete.
5. **Provider-neutral.** Tokens stay opaque pass-through; ordering is a small neutral enum mapped per-provider. No Google-Drive specifics leak into the public schema.

## Design

### Two pagination models, each correct for its shape

A cloud provider's directory listing is a forward cursor (Drive's `nextPageToken`); a subtree has no single cursor. So:

- **Non-recursive browse → cursor pagination.** Pass `page_token` straight through to the provider; return its `next_page_token`. The CLI's `--all` is a client-side loop over those tokens. The API stays stateless.
- **Recursive browse → bounded server-side walk.** The server walks the subtree, auto-paging *each* directory internally via the provider's `next_page_token`, accumulating flattened entries with full relative paths up to a `max_entries` cap, and returns `{ entries, truncated }`. No opaque resume token for recursive — it is all-or-capped, and `truncated: true` is the honest "you didn't get everything" signal. A client can't walk a tree it can't see, so this has to be server-side.

Both models are additive on one response shape:

```jsonc
{
  "mount_id": "cfm_01k...",
  "path": "/reports",
  "entries": [ /* CloudFsEntry[] */ ],
  "next_page_token": "abc...",   // present ⇒ more pages in THIS directory (non-recursive only)
  "truncated": false             // present in recursive mode ⇒ walk hit the cap, tree incomplete
}
```

Contract: in non-recursive mode `truncated` is absent and completeness = "`next_page_token` is null"; in recursive mode `next_page_token` is absent and completeness = "`truncated` is false".

### Page size, ordering, tokens

- **`page_token`** — opaque string, passed verbatim to the provider. Provider-neutral by construction (the abstraction already speaks `next_page_token`).
- **`page_size`** — parsed as an integer and clamped at the API to `[1, 1000]` (Drive's max). Omitted ⇒ no `page_size` sent ⇒ provider default (`listFiles` 100, `searchFiles` 50). Clamping happens in the service so a hostile value can't 400 the provider. Non-numeric values still produce a clear API `400`.
- **`order_by`** — a small **neutral enum** mapped per-provider, so the public API never leaks Drive's raw `orderBy` syntax: `name` | `name_desc` | `modified` | `modified_desc`. Omitted ⇒ provider default (`folder,name` for browse, `modifiedTime desc` for search). This is the lowest-priority part of the PR; if cut, omit the field entirely rather than passing raw provider strings through.
- **`recursive` + `page_token`** — invalid together. Recursive browse is a bounded full walk, not a resumable tree cursor. Reject the API combination with `400`; the CLI should reject `--recursive --page-token` and `--recursive --all` before making a request.
- **Boolean query parsing** — do not use `z.coerce.boolean()` for `recursive`; the string `"false"` coerces to `true`. Use an explicit parser/schema that accepts `true`, `false`, `1`, `0`, `yes`, `no`, and boolean values.
- **`mime_type` search filter** — preserve the existing CLI flag and route it to `ListOptions.mime_type_filter`; pagination should not regress filtering.

### `searchFiles` pagination caveat (must handle in `--all`)

`GoogleDriveProvider.searchFiles(...)` (`google-drive-provider.ts:354`) post-filters each Drive page down to descendants of the mount root when `rootId !== 'root'` (Drive has no recursive `in parents`). So a fetched page of 50 can return **0-50** entries while `next_page_token` is still non-null. Any search auto-paging loop (`eve cloud-fs search --all`) must continue while a token is present **even when a page yields zero entries**, and must not treat an empty page as end-of-results.

## Single PR scope

1. Add `next_page_token` and `truncated` to `CloudFsBrowseResponseSchema`; add `page_token`, `page_size`, `order_by` to `CloudFsBrowseRequestSchema` (and keep `recursive` with explicit boolean parsing).
2. Add Cloud FS search request/response schemas for `q`, `mount_id`, `mime_type`, `page_token`, `page_size`, `order_by`, and `next_page_token`.
3. Thread `page_token`/`page_size`/`order_by` through `CloudFsService.browse(...)`, `browseMount(...)`, and `search(...)` into provider `listFiles`/`searchFiles`; thread `mime_type` through `search(...)`; surface `next_page_token`. Clamp `page_size`; map `order_by` per provider.
4. Implement `recursive` as a bounded, auto-paging server-side subtree walk returning `truncated` (or, if descoped, reject `recursive=true` with `400`).
5. Wire the shared query schemas into the `browse` / `browseMount` / `search` controller routes instead of duplicating ad hoc `@Query` parsing.
6. CLI: `eve cloud-fs ls` gains `--all`, `--page-token`, `--page-size`, `--recursive`, (optional `--order-by`); `eve cloud-fs search` gains `--all` / `--page-token` / `--page-size` / `--order-by` while preserving `--mime-type`. Add `next_page_token` to the CLI response types. `--all` loops with a safety cap and **warns** (never silently truncates) if the cap is hit.
7. Tests (shared schema, service plumbing + walk, controller coercion, CLI loop), OpenAPI regen, system docs, and the eve-skillpacks sync obligation.

## Keep out of this PR

- New providers beyond Google Drive. The walk and token plumbing stay provider-neutral, but only the Drive path ships.
- Server-side cursor pagination across a recursive tree (opaque resume token encoding a traversal stack). Recursive is bounded full-walk + `truncated`; resumable tree cursors are not worth the complexity for this gap.
- Caching, prefetch, or background indexing of directory contents.
- Changing `auto_index` / org-docs sync behavior (a separate ingestion path).
- Artifact identity / exact-byte verification (the sibling plan) and idempotent writes (the adjacent gap). This PR makes enumeration complete; it does not add identity or dedup.

## Implementation details

### Schemas — `packages/shared/src/schemas/cloud-fs.ts`

```ts
export const CloudFsOrderBySchema = z.enum(['name', 'name_desc', 'modified', 'modified_desc']);
export type CloudFsOrderBy = z.infer<typeof CloudFsOrderBySchema>;

export const CloudFsQueryBooleanSchema = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return value;
}, z.boolean());

// Parse only. The service clamps numeric page sizes to the provider-safe range.
export const CloudFsPageSizeSchema = z.coerce.number().int().optional();

// Browse response (:83) — additive, both optional
export const CloudFsBrowseResponseSchema = z.object({
  mount_id: z.string(),
  path: z.string(),
  entries: z.array(CloudFsEntrySchema),
  next_page_token: z.string().optional(), // non-recursive: more pages remain in this directory
  truncated: z.boolean().optional(),      // recursive: walk hit the entry cap
});

// Browse request (:95) — additive
export const CloudFsBrowseRequestSchema = z.object({
  mount_id: z.string().optional(),
  path: z.string().default('/'),
  recursive: CloudFsQueryBooleanSchema.default(false),
  page_token: z.string().optional(),
  page_size: CloudFsPageSizeSchema,
  order_by: CloudFsOrderBySchema.optional(),
}).refine(v => !v.recursive || !v.page_token, {
  message: 'page_token cannot be used with recursive=true',
});

export const CloudFsSearchRequestSchema = z.object({
  mount_id: z.string().optional(),
  q: z.string().min(1),
  mime_type: z.string().optional(),
  page_token: z.string().optional(),
  page_size: CloudFsPageSizeSchema,
  order_by: CloudFsOrderBySchema.optional(),
});

export const CloudFsSearchResponseSchema = z.object({
  mount_id: z.string(),
  entries: z.array(CloudFsEntrySchema),
  next_page_token: z.string().optional(),
});
```

Keep the public enum in shared, but keep provider-specific strings out of shared. Add a service-local mapper (or provider helper when a second provider arrives):

```ts
function mapOrderBy(providerName: string, orderBy: CloudFsOrderBy | undefined): string | undefined {
  if (!orderBy) return undefined; // provider default
  if (providerName !== 'google_drive') {
    throw new BadRequestException(`order_by is not supported for provider ${providerName}`);
  }
  return {
    name: 'folder,name',
    name_desc: 'folder,name desc',
    modified: 'modifiedTime',
    modified_desc: 'modifiedTime desc',
  }[orderBy];
}
```

This preserves a provider-neutral public contract while acknowledging that `ListOptions.order_by` is currently provider-specific below the abstraction.

### Service — `apps/api/src/cloud-fs/cloud-fs.service.ts`

- **`browse(orgId, mountId, path, opts)`** and **`browseMount(orgId, mountId, folderId, path, opts)`** take `opts: { pageToken?; pageSize?; orderBy?; recursive? }`.
  - Non-recursive: pass `{ page_token, page_size: clampPageSize(pageSize), order_by: mapOrderBy(provider.providerName, orderBy) }` into `provider.listFiles(...)`; return `next_page_token` from the result. (Single-line change at `:136` and `:186`.)
  - Recursive: reject `pageToken`; call the new private `walkSubtree(...)`; return `{ entries, truncated }`.
  - `clampPageSize(undefined)` returns `undefined`; `clampPageSize(0)` returns `1`; `clampPageSize(5000)` returns `1000`.
  - `browseMount` with `folder_id` and no `path` should derive `basePath` with `provider.buildPath(accessToken, targetFolderId, mount.root_folder_id)` before rewriting child paths. Otherwise a recursive walk of an arbitrary folder reports everything as rooted at `/`.
- **New private `walkSubtree(provider, accessToken, rootFolderId, basePath, opts)`** — BFS, auto-pages every directory, flattens with full relative paths, bounded by `maxEntries` (default `EVE_CLOUD_FS_MAX_RECURSIVE_ENTRIES`, e.g. `5000`) and optional `maxDepth`:

  ```ts
  const results: CloudFsEntry[] = [];
  let truncated = false;
  const queue = [{ folderId: rootFolderId, path: basePath, depth: 0 }];
  const seenFolders = new Set<string>([rootFolderId]);
  while (queue.length && results.length < maxEntries) {
    const { folderId, path, depth } = queue.shift()!;
    let pageToken: string | undefined;
    do {
      const page = await provider.listFiles(accessToken, folderId, {
        page_token: pageToken, page_size: pageSize, order_by: orderByStr,
      });
      for (const e of page.entries) {
        if (results.length >= maxEntries) { truncated = true; break; }
        const full = path === '/' ? `/${e.name}` : `${path}/${e.name}`;
        results.push({ ...e, path: full });
        if (e.is_folder && (maxDepth == null || depth < maxDepth) && !seenFolders.has(e.id)) {
          seenFolders.add(e.id);
          queue.push({ folderId: e.id, path: full, depth: depth + 1 });
        }
      }
      pageToken = page.next_page_token;
      if (results.length >= maxEntries && pageToken) truncated = true;
    } while (pageToken && results.length < maxEntries);
    if (results.length >= maxEntries && queue.length) truncated = true;
  }
  return { entries: results, truncated };
  ```

- **`search(orgId, mountId, query, opts)`** — same `opts` shape (no `recursive`) plus `mimeType?`; pass through `page_token`/`page_size`/`order_by`/`mime_type_filter`; return `next_page_token`. Default `order_by` stays provider default (`modifiedTime desc` for Drive).
- Reuse `resolveMount` / `getProviderAndToken` / `handleProviderError` unchanged. Provider errors during a walk propagate (fail-fast, per CLAUDE.md rule 4) — a partial walk must not be reported as complete.

### Controller — `apps/api/src/cloud-fs/cloud-fs.controller.ts`

Add `@Query` params + `@ApiQuery` docs to all three routes, but parse with the shared schemas instead of manual ad hoc coercion:

- `GET .../cloud-fs/browse` (`:104`): add `page_token`, `page_size`, `order_by`, `recursive`.
- `GET .../cloud-fs/mounts/:mount_id/browse` (`:123`): same four, plus existing `folder_id`.
- `GET .../cloud-fs/search` (`:234`): add `page_token`, `page_size`, `order_by`, and wire the existing `mime_type`.

Controller pattern:

```ts
const query = CloudFsBrowseRequestSchema.parse(rawQuery);
const resolvedMountId = await this.resolveReadableMountId(orgId, query.mount_id, request.user);
return this.cloudFsService.browse(orgId, resolvedMountId, query.path, toServiceOpts(query));
```

Wrap Zod failures as `BadRequestException` with the schema message. Do not use `z.coerce.boolean()` or `ParseBoolPipe` for this route until it is verified to handle `"false"` correctly.

### Provider — `packages/shared/src/cloud-fs/google-drive-provider.ts`

**No changes required.** `listFiles` (`:135`) and `searchFiles` (`:354`) already accept `ListOptions` and return `next_page_token`. The plan deliberately adds zero provider code — the gap is entirely above this layer.

### CLI — `packages/cli/src/commands/cloud-fs.ts`

- Add `next_page_token?: string` and `truncated?: boolean` to the local `CloudFsBrowseResponse` type (`:46`); add `next_page_token?: string` to `CloudFsSearchResponse`.
- **`ls` / `browse` (`:354`)** new flags: `--all`, `--page-token <tok>`, `--page-size <n>`, `--recursive` (alias `-r`), `--order-by <name|name_desc|modified|modified_desc>`.
  - Default: one page; if `next_page_token` is returned, print a footer hint: `More results — use --all to fetch everything, or --page-token <tok>`.
  - `--page-token`: fetch exactly that page.
  - `--all` (non-recursive): client loop — fetch, accumulate, repeat with `page_token` while `next_page_token` is set; stop at a hard page cap (`EVE_CLOUD_FS_MAX_AUTO_PAGES`, default 200 pages) and warn `[warning] stopped at N pages / M entries (cap hit); some entries may be missing` if the cap is reached with a token still pending. Render the combined set once via `formatEntriesTable`.
  - `--recursive`: send `recursive=true`; render flattened entries (full paths already set server-side); if `truncated`, print `[warning] traversal truncated at N entries; narrow the path or raise EVE_CLOUD_FS_MAX_RECURSIVE_ENTRIES`. `--recursive` rejects `--page-token`/`--all` locally (server-driven).
  - `--json`: emit the raw response for one-page and recursive calls. For `--all`, emit a single merged object `{ mount_id, path, entries, complete, page_count, next_page_token? }`; `next_page_token` is present only when `complete: false` so scripts can resume manually.
- **`search` (`:374`)** gains `--all` / `--page-token` / `--page-size` / `--order-by` with the same loop + cap + warning semantics, and keeps `--mime-type`.
  - Search `--all` must continue on an empty page when `next_page_token` is present.
  - `--json --all` emits `{ mount_id, entries, complete, page_count, next_page_token? }`.
- Update both help surfaces: the `default` usage block in `packages/cli/src/commands/cloud-fs.ts` (`:404`) and the registry in `packages/cli/src/lib/help.ts` (`:2704`, `:2715`).

## Tests

- **Shared (`packages/shared`)**: `CloudFsBrowseResponseSchema` round-trips with/without `next_page_token` and `truncated`; `CloudFsSearchResponseSchema` round-trips with/without `next_page_token`; `CloudFsBrowseRequestSchema` parses `recursive=false` as `false`, rejects invalid booleans, rejects `recursive=true&page_token=...`, accepts out-of-range numeric `page_size` for service clamping, and rejects unknown `order_by`; `CloudFsSearchRequestSchema` parses `mime_type`, token, size, and order fields.
- **API service (mock provider)** — co-located with `apps/api/src/cloud-fs/cloud-fs.controller.spec.ts`:
  - `browse` passes `page_token`/`page_size`/`order_by` into `listFiles` and surfaces the provider's `next_page_token`.
  - `browse` with no token still returns `next_page_token` when the provider reports more pages.
  - `page_size` clamps: `0`/`5000` → `1`/`1000` reaching the provider.
  - **recursive walk**: mock provider with a 3-level tree across multiple pages per dir ⇒ flattened entries with correct full paths, `truncated: false`; with a tiny `maxEntries` and either pending page token or queued folder ⇒ `truncated: true` and entry count == cap.
  - **recursive safety**: duplicate folder IDs are not traversed twice; `recursive=true&page_token=...` returns `400`.
  - `browseMount` with `folder_id` and no path derives the display/base path before flattening child entries.
  - **empty-page continuation**: mock `searchFiles` returning an empty page with a non-null token followed by a populated final page ⇒ the CLI `search --all` loop yields the later entries (regression guard for the search post-filter caveat).
  - provider error mid-walk propagates (no partial "complete" result).
  - `search` threads token, page size, order, and `mime_type_filter`, and returns `next_page_token`.
- **Controller**: query parsing uses the shared schemas; `recursive=false` remains false; invalid booleans produce `400`; explicit and scoped mount access behavior from the existing tests remains unchanged.
- **CLI**: `--all` issues N requests and renders the union once; search continues across an empty page with a token; stops + warns at the page cap; `--page-token` issues exactly one request with the token; `--recursive` rejects incompatible flags and prints the truncation warning when `truncated` is true; `--json --all` emits one merged `{ ..., complete, page_count, next_page_token? }` object.
- **Integration** (behind the existing Cloud FS integration gating — needs a live provider/integration): create a folder with >100 files; assert default `ls` returns the first page + a `next_page_token`, `ls --all` returns every file, and `ls --recursive` over a nested fixture enumerates the whole subtree with `truncated: false`.

## Docs in the PR

- `docs/system/openapi.yaml` / `openapi.json` — regenerate so the new browse/search query params (`page_token`, `page_size`, `order_by`, `recursive`, `mime_type`) and the response fields (`next_page_token`, `truncated`) appear (current routes at `openapi.yaml:11043` browse, `:11215` search).
- Cloud FS section of the system docs (`docs/system/object-store-and-org-filesystem.md`) and integration docs (`docs/system/integrations.md`) — document the two pagination models, the `--all` loop, recursive `truncated` semantics, search `mime_type`, and `page_size` clamping.
- CLI help docs in `packages/cli/src/lib/help.ts` — document the new flags in the machine-readable help registry.
- `CLAUDE.md` Update Log entry summarizing browse/search pagination + the recursive fix.

Per the **eve-skillpacks sync obligation** in `CLAUDE.md`, update the public references in `../eve-skillpacks/eve-work/eve-read-eve-docs/references/` when this ships (do **not** edit them for this planning-only doc):

- `cli.md` — extend the `eve cloud-fs ls` / `search` lines (~`:120`, `:122`) with `--all`, `--page-token`, `--page-size`, `--recursive`, `--order-by`.
- `object-store-filesystem.md` — document complete enumeration: cursor pagination, `--all`, and bounded recursive walk with `truncated`.
- `integrations.md` — keep Google Drive browse/search examples aligned with the CLI reference if they mention pagination or `mime_type`.

## Acceptance criteria

- `GET .../cloud-fs/browse` and `.../mounts/:id/browse` return `next_page_token` when the underlying directory has more pages; passing it back returns the next page.
- `eve cloud-fs ls --all` on a directory with >100 files returns **every** file; default `ls` returns the first page and signals that more exist.
- `page_size` is honored and clamped to `[1, 1000]`; a numeric out-of-range value never reaches/400s the provider, while a non-numeric value returns a clear API `400`.
- `recursive=true` performs a real subtree walk: nested files are enumerated with correct full paths, and `truncated` is `true` iff the entry cap was hit. (Or, if recursive is descoped, `recursive=true` returns a clear `400` and never a silent single page.)
- `recursive=false` stays false at the schema/controller boundary; `recursive=true&page_token=...` is rejected instead of silently ignoring the token.
- `eve cloud-fs search --all` returns all matches across provider pages, including when intermediate pages are emptied by the descendant post-filter; `--mime-type` still filters results.
- `--all` never silently truncates: hitting the page cap prints a warning and (in `--json`) sets `complete: false` with a resumable `next_page_token`.
- Existing callers of `browse` / `browseMount` / `search` that read only `entries` keep working (response is a superset; new fields optional).
- `eve cloud-fs --help`, `eve cloud-fs ls --help`, and `eve cloud-fs search --help` describe the shipped flags.
- `pnpm build` and `pnpm test` pass; OpenAPI is regenerated.

## References

| File | Why |
| --- | --- |
| `packages/shared/src/schemas/cloud-fs.ts:83` | `CloudFsBrowseResponseSchema` (+ `next_page_token`, `truncated`) |
| `packages/shared/src/schemas/cloud-fs.ts:95` | `CloudFsBrowseRequestSchema` (+ `page_token`, `page_size`, `order_by`); add explicit query boolean parsing and search request/response schemas |
| `packages/shared/src/cloud-fs/types.ts:33` | `ListOptions` — already complete, no change |
| `packages/shared/src/cloud-fs/google-drive-provider.ts:135` | `listFiles` already paginated — no change |
| `packages/shared/src/cloud-fs/google-drive-provider.ts:354` | `searchFiles` descendant post-filter → empty-page-with-token caveat |
| `apps/api/src/cloud-fs/cloud-fs.service.ts:119` | `browse` — thread options, surface token |
| `apps/api/src/cloud-fs/cloud-fs.service.ts:167` | `browseMount` — thread options, surface token |
| `apps/api/src/cloud-fs/cloud-fs.service.ts:149` | `search` — thread options, MIME filter, surface token |
| `apps/api/src/cloud-fs/cloud-fs.service.ts` | new `walkSubtree(...)` for recursive |
| `apps/api/src/cloud-fs/cloud-fs.controller.ts:104` | `browse` route — new query params |
| `apps/api/src/cloud-fs/cloud-fs.controller.ts:123` | `browseMount` route — new query params |
| `apps/api/src/cloud-fs/cloud-fs.controller.ts:234` | `search` route — new query params and `mime_type` wiring |
| `apps/api/src/cloud-fs/cloud-fs.controller.spec.ts` | extend service/controller tests |
| `packages/cli/src/commands/cloud-fs.ts:46` | CLI `CloudFsBrowseResponse` type (+ `next_page_token`, `truncated`) |
| `packages/cli/src/commands/cloud-fs.ts:354` | `ls`/`browse` — `--all`/`--page-token`/`--page-size`/`--recursive`/`--order-by` |
| `packages/cli/src/commands/cloud-fs.ts:374` | `search` — `--all`/`--page-token`/`--page-size`/`--order-by`; keep `--mime-type` |
| `packages/cli/src/lib/help.ts:2704` | `cloud-fs ls` help registry update |
| `packages/cli/src/lib/help.ts:2715` | `cloud-fs search` help registry update |
| `docs/system/openapi.yaml:11043` | Cloud FS browse route to regenerate |
| `docs/system/object-store-and-org-filesystem.md` | Cloud FS system docs update |
| `docs/system/integrations.md` | Google Drive browse/search docs update |
| `docs/plans/cloud-fs-artifact-identity-verification-plan.md` | Sibling read/verify plan; cross-link |
