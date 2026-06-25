# MarkItDown File-to-Markdown Ingestion Plan

> **Status**: Plan (ready to build)
> **Date**: 2026-04-10
> **Issue**: `eve-horizon-ggr0`
> **Scope**: Add first-class markdown normalization for document-style file formats in Eve Horizon using MarkItDown, while preserving the existing Eve-native media pipeline for audio/video.

## Goal

Extend Eve's ingestion platform so document-style files can be ingested through the existing Eve spine and produce a deterministic markdown derivative for downstream agents.

The desired end state is:

1. Raw file enters Eve through the current ingest, Slack attachment, org-fs, or cloud-fs path.
2. Eve stores the raw file exactly as it does today.
3. Eve generates and caches a markdown derivative for supported document-style formats.
4. Downstream agents receive both the raw file and the markdown derivative, with a strong default toward the markdown copy.
5. Org-doc indexing paths can use the markdown derivative instead of indexing only small text files.

This plan is explicitly about **markdown normalization**, not about replacing Eve's overall ingest workflow model.

## Supported Formats

### Baseline support to add via MarkItDown

These formats should be treated as platform-supported for markdown normalization in the first implementation:

- `application/pdf` for text PDFs
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (`.docx`)
- `application/vnd.openxmlformats-officedocument.presentationml.presentation` (`.pptx`)
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (`.xlsx`)
- legacy Excel (`.xls`)
- `application/epub+zip` (`.epub`)
- Outlook message files (`.msg`)
- Jupyter notebooks (`.ipynb`)
- ZIP archives (`.zip`)
- `text/html`
- `text/csv`
- `application/json`
- `application/xml`
- `text/plain`
- `text/markdown`

### Keep Eve-native, do not move to MarkItDown

These formats remain on the existing Eve media path:

- audio files
- video files

Rationale:

- Eve already has a local `ffmpeg` + `whisper-cli` toolchain for audio/video.
- MarkItDown's built-in audio path is not the right platform baseline because it relies on Google speech recognition through `speech_recognition.recognize_google(...)`.
- We want the default Eve platform path to stay local and deterministic for media.

### Deferred / optional follow-up

These should not be claimed as baseline platform support in phase 1:

- scanned PDFs
- image-heavy office documents that require OCR
- standalone image files (`.jpg`, `.jpeg`, `.png`)
- old binary Office formats such as `.doc` and `.ppt`

These can be added later behind an explicit OCR or vision-backed mode.

## Non-Goals

- Replace the existing `eve ingest` create/upload/confirm flow
- Proxy large binary uploads through the API
- Introduce MarkItDown MCP as a platform dependency
- Require Azure Document Intelligence, OpenAI-compatible OCR, or any other external API for the baseline path
- Replace app-specific ingest workflows or org-doc output schemas
- Add embeddings, chunking, or semantic indexing in this plan

## Current State

Eve already has a clean raw-file ingestion spine:

- `eve ingest` creates a record, uploads to object storage, and confirms processing.
- Confirm emits `system.doc.ingest`.
- Workflow invocation converts the event payload into an `ingest://` resource reference.
- Worker hydration downloads the raw file into `.eve/resources/`.
- Slack attachments use a parallel path and materialize into `.eve/attachments/`.
- Org-fs and cloud-fs indexing currently only push small text files into org docs.

The missing platform primitive is a shared **file-to-markdown normalizer**.

Today, downstream agents mostly receive:

- the raw file
- the MIME type
- some ingest metadata

But they do **not** receive a platform-generated markdown derivative for Office documents, epub, msg, notebooks, or archives.

## Design Principles

1. Keep raw files authoritative. Markdown is a derived artifact, not the canonical upload.
2. Normalize in the runtime, not in prompts. Agents should consume a stable derivative rather than re-discovering conversion logic in every workflow.
3. Reuse Eve's existing storage, event, workflow, and workspace model.
4. Avoid external APIs in the baseline path.
5. Use toolchain-on-demand rather than bloating the default worker image.
6. Converge the major file-entry paths onto one normalization contract over time.

## Chosen Integration Shape

### Decision 1: normalize in worker/agent-runtime, not in the API

The API should continue to:

- store raw bytes
- emit events
- expose status and download URLs

The conversion should happen where files are already hydrated and tools are already available:

- worker runner pods
- agent-runtime execution pods when needed

This preserves the current zero-copy upload model and avoids introducing a binary-processing API service.

### Decision 2: do not use MarkItDown MCP

MarkItDown MCP is useful for local trusted agents, but it is the wrong platform boundary for Eve:

- it is designed as a local agent integration surface
- it introduces an extra server process
- it is not the existing Eve internal execution pattern

Instead, Eve should call MarkItDown directly through a local wrapper command in job runtimes.

### Decision 3: add a dedicated `docproc` toolchain

Do **not** fold MarkItDown into the generic `python` toolchain.

Add a dedicated toolchain, tentatively named `docproc`, containing:

- Python runtime
- `uv`
- pinned `markitdown` package
- optional local helpers used by Eve's wrapper command

Rationale:

- keeps the generic `python` toolchain small and general-purpose
- gives document normalization its own versioning and rollout path
- makes job requirements explicit
- matches Eve's existing toolchain-on-demand model

## Architecture

### Phase 1 runtime flow

```text
Input channel
  -> raw object stored in Eve
  -> workflow/job created as today
  -> worker hydrates raw file to workspace
  -> worker calls eve-doc-normalize on supported formats
  -> markdown derivative written to workspace
  -> derivative metadata added to resource index
  -> downstream agent reads markdown first, raw file second
```

### Long-term converged flow

```text
Raw file source
  -> raw object store key
  -> shared normalization contract
  -> cached markdown derivative in object store
  -> workspace materialization includes raw + markdown
  -> org-doc indexing and downstream agents consume markdown
```

## Internal Contract

Introduce a small internal normalization contract:

```ts
type NormalizedMarkdownResult = {
  status: 'done' | 'failed' | 'skipped';
  normalizer: 'markitdown';
  normalizer_version: string;
  output_mime_type: 'text/markdown';
  markdown?: string;
  warnings?: string[];
  error_message?: string;
};
```

Expose it through an internal wrapper command, for example:

```bash
eve-doc-normalize \
  --input /workspace/.eve/resources/quarterly-report.docx \
  --mime-type application/vnd.openxmlformats-officedocument.wordprocessingml.document \
  --file-name quarterly-report.docx \
  --json
```

The wrapper should:

- decide whether the MIME type is supported
- invoke MarkItDown locally
- return structured JSON
- never require a network call in the baseline path

## Data Model Changes

### Phase 1: extend `ingest_records`

Add derivative tracking fields to `ingest_records`:

- `normalized_status` — `pending | processing | done | failed | skipped`
- `normalized_storage_key` — object storage key for the markdown derivative
- `normalized_mime_type` — `text/markdown`
- `normalized_content_hash`
- `normalizer_name` — `markitdown`
- `normalizer_version`
- `normalized_error_message`
- `normalized_at`

This is the most pragmatic path because ingest records are the first-class audit record for the existing ingest flow.

### Later: generic normalization table if needed

If Slack attachments and org-fs/cloud-fs need durable shared derivative tracking beyond ingest, introduce a generic table in a later phase rather than over-generalizing phase 1.

## Storage Layout

### Raw objects

Keep current raw object keys unchanged.

Examples:

- `ingest/{ingest_id}/{filename}`
- `chat-attachments/...`
- `fs/{path}`

### Markdown derivatives

For phase 1 ingest records, store derivatives under:

- `ingest/{ingest_id}/derived/markdown.md`

This keeps the derivative co-located with the source object while allowing future additional derivatives under the same prefix.

## Workspace Materialization

### `ingest://` resources

During resource hydration:

1. download the raw file as today
2. if the MIME type is in the supported MarkItDown set, run the normalizer
3. write the markdown derivative to a sibling path in the workspace
4. record both paths in `.eve/resources/index.json`

Add derivative metadata to each resource entry, for example:

```json
{
  "uri": "ingest:/ingest_abc123/report.docx",
  "local_path": ".eve/resources/report.docx",
  "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "derivatives": [
    {
      "kind": "markdown",
      "local_path": ".eve/resources-derived/report.md",
      "mime_type": "text/markdown",
      "normalizer": "markitdown",
      "status": "resolved"
    }
  ]
}
```

This avoids changing the resource URI model in phase 1 while still giving agents a stable markdown target.

### Chat attachments

Apply the same contract to `.eve/attachments/index.json` in phase 2:

- keep the raw staged file
- add `derivatives[]`
- avoid inventing a separate agent-side Slack conversion pattern

## CLI and API Surface

### Existing behavior to preserve

- `eve ingest` remains raw-file-first
- `eve ingest show` remains the status entry point
- download endpoints still return the raw file

### New fields to expose

Add derivative status to `eve ingest show` and the underlying API:

- `normalized_status`
- `normalized_mime_type`
- `normalized_storage_key`
- `normalized_error_message`
- `normalizer_name`
- `normalizer_version`

Do **not** change the meaning of existing `status`; that field continues to mean overall ingest workflow status.

## Org-FS and Cloud-FS Reuse

### Current limitation

Org-fs indexing only promotes small text-like files into org docs.

### Planned change

For supported document-style formats:

1. detect object create/update
2. run the same normalization wrapper against the raw object
3. write the markdown derivative to org docs
4. store metadata preserving the original source path, original MIME type, raw storage key, and normalizer version

This lets cloud-fs and org-fs gain the same new file-type support without inventing a second indexing pipeline.

## Phased Implementation

### Phase 1: Ingest path end-to-end

1. Add `docs/plans/markitdown-file-ingestion-plan.md` and align on scope.
2. Add `docproc` toolchain image with pinned MarkItDown install.
3. Add internal wrapper command `eve-doc-normalize`.
4. Extend `ingest_records` with derivative metadata fields.
5. Teach worker resource hydration to generate markdown derivatives for supported `ingest://` files.
6. Persist derivative metadata and storage key on the ingest record.
7. Extend `eve ingest show` and the ingest API response to expose derivative state.
8. Update the default ingest skill/agentpack guidance so downstream agents prefer the markdown derivative when present.

### Phase 2: Slack attachment reuse

1. Reuse the same wrapper during attachment staging.
2. Add derivative metadata to `.eve/attachments/index.json`.
3. Optionally persist attachment derivatives in object storage if later workflows need reuse across jobs.

### Phase 3: Org-fs and cloud-fs indexing reuse

1. Expand indexable file handling beyond the current small-text allowlist.
2. Normalize supported document-style files before writing to org docs.
3. Preserve source metadata so doc readers can trace back to the raw file.

### Phase 4: Optional OCR / vision mode

1. Add an opt-in OCR mode using `markitdown-ocr` or another explicit OCR backend.
2. Gate it behind explicit configuration and available credentials.
3. Only then claim support for scanned PDFs and image-only documents.

## Verification Plan

### Fixture corpus

Build a fixture set that covers:

- text PDF
- DOCX
- PPTX
- XLSX
- XLS
- EPUB
- MSG
- IPYNB
- ZIP
- HTML
- CSV
- JSON
- XML
- TXT
- Markdown

### Tests

1. Unit tests for MIME-type support selection and wrapper result parsing
2. Integration test: `eve ingest` of each supported type produces a markdown derivative
3. Integration test: `.eve/resources/index.json` contains derivative metadata
4. Integration test: ingest record derivative status is surfaced via API and CLI
5. Regression test: audio/video still use the existing media path
6. Regression test: unsupported binaries are skipped cleanly, not mis-labeled as supported

### Manual validation

Run at least one end-to-end manual scenario for:

- Office doc uploaded through `eve ingest`
- PDF uploaded through `eve ingest`
- Slack attachment routed to a document-processing agent
- cloud-fs or org-fs file update producing searchable org-doc markdown

## Risks

### Conversion quality risk

MarkItDown is a strong fit for structure-preserving markdown, but quality will vary by format and document complexity. This is acceptable because the goal is agent-oriented markdown, not presentation-grade fidelity.

### Runtime size risk

A dedicated `docproc` toolchain avoids bloating the default worker image, but it still adds another toolchain image to build, publish, and cache.

### Over-claiming support risk

Do not claim full PDF OCR or image understanding until an explicit OCR mode ships. Phase 1 support should be honest and narrow.

## Open Questions

1. Should phase 1 write the markdown derivative to object storage immediately during hydration, or only after a successful workflow run?
2. Should agent-facing indexes use a new `preferred_local_path` field to make markdown-first consumption even simpler?
3. Do we want a future `eve resources` mode for resolving ingest-backed markdown derivatives directly, or is workspace hydration enough for the first iteration?

## Recommended First Slice

Build the smallest useful vertical slice:

1. `docproc` toolchain
2. `eve-doc-normalize` wrapper
3. ingest-record derivative fields
4. worker hydration for supported `ingest://` formats
5. `eve ingest show` derivative visibility

That slice delivers real platform support for the new file types without expanding scope into OCR, media, or generic cross-source normalization too early.
