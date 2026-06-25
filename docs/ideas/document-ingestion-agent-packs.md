# Document Ingestion via Agent Packs

> **Status**: Idea (draft, updated 2026-03-04)
> **Date**: 2026-03-03
> **Context**: Eve-compatible apps (eve-pm, knowledge bases, compliance tools) commonly need to ingest arbitrary documents — PDFs, images, audio, video — extract content, tag, summarize, and structure the output with full provenance. Today each app builds this bespoke. This design makes it a composable platform pattern.
> **See also**: [pi-mono-integration.md](./pi-mono-integration.md) — pi as a harness for multi-provider/private model support
> **Prerequisite update**: Pi harness Phase 1 is **complete** (all provider paths work today). See earlier sections for details.

## The Insight

Eve already has every storage and execution primitive needed for document ingestion:

| Primitive | Role in Ingestion |
| --- | --- |
| **Object Store** | Binary storage for uploaded files (presigned URLs, zero-copy) |
| **Org Filesystem** | Drop-folder ingestion, synced file events, agent workspace mount |
| **Org Docs** | Versioned, searchable, metadata-rich output store |
| **Jobs + Workflows** | Processing execution with full lifecycle |
| **Agent Packs** | Customizable processing behavior per app |
| **Slack Gateway** | Chat-based ingestion with file attachments |
| **Teams (agent dispatch)** | Triage agent routes to specialized sub-agents by file type |
| **Ingest Records** | Immutable audit trail — who, when, what, from where, with what instructions |

What's missing is a thin **ingest spine** that composes these primitives into a single flow: **file in → triage → agent processes → structured output with provenance**.

## Design Philosophy

1. **Agent-driven, not code-driven** — The agent does the intelligent work (extraction, tagging, summarizing). The platform just moves bytes and fires events.
2. **Harness-agnostic** — Works with Claude (native multi-modal), pi (20+ providers including private models), or any future harness. The skill adapts to model capabilities.
3. **Customizable via pack** — Each app defines *how* to process documents through agent instructions, not platform configuration.
4. **Multi-channel input** — Same processing regardless of whether the file came from REST upload, Slack, org-fs drop, or CLI.
5. **Searchable output** — Results land in org docs (full-text search + metadata queries) for free.
6. **Audio is first-class** — Audio/video transcription is a core capability, not an afterthought. Whisper (or equivalent) runs in the worker image; transcripts are treated as documents with timecoded provenance.
7. **Full provenance** — Every extracted fact, summary, or tag links back to the source file (and offset/page/timestamp within it). A web UI can deep-link to the exact passage, highlight relevant text, or play from the right timestamp.
8. **Audit trail** — Every ingestion records who submitted it, when, from which channel, and with what instructions. The ingest record is immutable.
9. **User instructions travel with the file** — Submitters can attach description, context, or processing instructions ("focus on action items", "extract only the financials"). The agent receives these as part of the job context.
10. **Smart routing by file type** — A triage agent (or routing rules) can dispatch files to the optimal harness/model combination based on MIME type, file size, or user hints. OCR-heavy images go to a vision model; audio goes to a transcription pipeline; text goes to the cheapest capable model.

## Architecture

```
                          Input Channels
    ┌─────────────┬──────────────┬──────────────┬─────────────┐
    │  REST API   │  Slack Bot   │  Org-FS Drop │    CLI      │
    │  /ingest    │  @eve + file │  /inbox/     │  eve ingest │
    │  + desc/    │  + message   │              │  --desc     │
    │  instruct.  │  context     │              │  --tags     │
    └──────┬──────┴──────┬───────┴──────┬───────┴──────┬──────┘
           │             │              │              │
           └─────────────┴──────┬───────┴──────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   Ingest Record       │
                    │   (immutable audit)   │
                    │   who, when, channel, │
                    │   instructions, file  │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │   Object Store        │
                    │   /ingest/{id}/{name} │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │   Triage Agent        │
                    │   (or routing rules)  │
                    │                       │
                    │   Inspects: MIME type, │
                    │   size, user hints    │
                    │   Routes to best      │
                    │   harness/model combo │
                    └──────┬────┬────┬──────┘
                           │    │    │
              ┌────────────┘    │    └────────────┐
              ▼                 ▼                  ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │  Document    │  │  Audio/Video │  │  OCR/Vision  │
    │  Agent       │  │  Agent       │  │  Agent       │
    │  (Claude/pi) │  │  (whisper +  │  │  (vision     │
    │              │  │   summarize) │  │   model)     │
    └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
           │                 │                  │
           └─────────┬───────┴──────────────────┘
                     │
         ┌───────────▼───────────┐
         │   Org Docs            │
         │   /docs/{type}/{slug} │
         │   versioned + search  │
         │   + provenance spans  │
         │   + source deep links │
         └───────────────────────┘
```

## Platform Additions (Three Thin Layers)

### 1. Ingest Endpoint

A convenience endpoint that handles multipart upload → object store → event in one call.

```
POST /projects/{projectId}/ingest
Content-Type: multipart/form-data

Fields:
  file:          Binary file (required)
  title:         Display name (optional, defaults to filename)
  description:   User-supplied context for the file (optional, free text)
  instructions:  Processing instructions for the agent (optional, e.g. "focus on action items")
  tags:          Comma-separated initial tags (optional)
  metadata:      JSON object with app-specific context (optional)
  source:        Origin hint: "upload" | "slack" | "email" | "drop" (default: "upload")
  callback_url:  Webhook URL for completion notification (optional)

Response (202 Accepted):
{
  "ingest_id": "ing_abc123",
  "file": {
    "storage_key": "ingest/ing_abc123/quarterly-report.pdf",
    "name": "quarterly-report.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 2458901
  },
  "submitted_by": {
    "actor_type": "user",
    "actor_id": "usr_abc123",
    "email": "alice@example.com"
  },
  "submitted_at": "2026-03-04T14:30:00Z",
  "event_id": "evt_xyz789",
  "job_id": "myproj-f2a91bc3"   // null if no ingest workflow configured
}
```

**What happens internally:**
1. Validate file (size limit, MIME allowlist from manifest)
2. Create immutable **ingest record** — captures actor identity, timestamp, channel, description, instructions, and file metadata. This is the audit trail entry and is never modified after creation.
3. Store in object store: `eve-org-{orgSlug}/ingest/{ingest_id}/{filename}`
4. Create `doc.ingest` event with file metadata + user context (description, instructions, tags)
5. If project has an `ingest` workflow with matching trigger, a job is created immediately
6. Return references for tracking

**Size limits**: Configurable per-project via manifest (default 50 MB, max 500 MB).

**User instructions**: The `description` and `instructions` fields travel with the file through the entire pipeline. The description is context about what the file is ("Q4 board deck from CFO"). The instructions tell the agent how to process it ("Extract only the revenue tables and action items"). Both are passed to the agent as job metadata. From Slack, the message text accompanying the file serves as both description and instructions.

### 2. Slack File Download

Enhance the gateway to download Slack file attachments to the object store before routing to agents.

**Current behavior**: Files are metadata-only (id, name, mimetype, url_private, size). Agents must fetch them using the Slack integration token, which is fragile and couples agent logic to Slack.

**New behavior**: When a Slack message includes file attachments and routes to an agent:

1. Gateway downloads each file from Slack using the integration's bot token
2. Stores each in object store: `eve-org-{orgSlug}/ingest/{ingest_id}/{filename}`
3. Replaces `url_private` with a presigned download URL (or resource ref)
4. Passes `resource_refs` to the created job so the agent accesses files uniformly

```typescript
// In gateway chat routing, after identity resolution:
if (normalized.files?.length) {
  const stored = await Promise.all(
    normalized.files.map(f => downloadAndStore(integration, f, orgId))
  );
  // Convert to resource_refs for the job
  jobInput.resource_refs = stored.map(s => ({
    uri: `org-store://${s.storage_key}`,
    label: s.name,
  }));
}
```

**Result**: Agents receive files the same way regardless of input channel. No Slack-specific logic in agent packs.

### 3. Org-FS Watch Paths

Files dropped into designated org-fs paths automatically trigger ingestion.

**Mechanism**: The existing org-fs event flow already emits `file.created` events. We add a thin check in the event router:

```yaml
# In manifest:
workflows:
  ingest:
    trigger:
      - source: system
        type: doc.ingest
      - source: system
        type: org_fs.file.created
        filter:
          path_prefix: /inbox/
```

When a file lands in `/inbox/` via org-fs sync, the event router matches the trigger and invokes the ingest workflow. The agent receives the file path as a resource ref.

**Convention**: `/inbox/` is the well-known drop path. Apps can configure additional watch paths in their manifest triggers.

**Post-processing**: After successful ingestion, the agent moves the original from `/inbox/` to `/inbox/processed/` (or deletes it, depending on pack configuration).

## The Ingest Event

```typescript
interface DocIngestEvent {
  type: 'doc.ingest';
  source: 'system';
  payload: {
    ingest_id: string;              // ing_xxx
    file: {
      storage_key: string;          // Object store path
      name: string;                 // Original filename
      mime_type: string;
      size_bytes: number;
    };
    origin: {                       // Where did this come from? (immutable audit)
      channel: 'api' | 'slack' | 'org_fs' | 'cli';
      actor_type?: string;          // user, service_principal
      actor_id?: string;
      actor_email?: string;         // Human-readable identity for audit display
      submitted_at: string;         // ISO timestamp
      integration_id?: string;      // For Slack: the integration record
      slack_channel?: string;       // For Slack: channel ID
      slack_thread_ts?: string;     // For Slack: thread timestamp
      org_fs_path?: string;         // For org-fs: original path
    };
    user_context: {                 // User-supplied description + processing instructions
      title?: string;
      description?: string;         // What is this file? Free-text context from submitter
      instructions?: string;        // How should the agent process it? E.g. "extract action items only"
      tags?: string[];
      metadata?: Record<string, unknown>;
      callback_url?: string;
    };
  };
}
```

The event carries everything the agent needs to process the file and respond to the right channel. The `origin` block is the immutable audit record. The `user_context` block carries the submitter's intent — the agent should honor `instructions` when deciding what to extract and how to structure the output.

## Multi-Harness Support: Claude, pi, and Private Models

The design must work across a capability spectrum:

| Harness | Multi-modal? | Native PDF/Image? | Provider coverage | Cost | Available? |
| --- | --- | --- | --- | --- | --- |
| `mclaude` | Yes | Yes (PDFs, images, code) | Anthropic only | $$ | Yes |
| `pi` + Claude | Yes | Yes (via Anthropic provider) | 20+ providers | $$ | **Yes (BYOK)** |
| `pi` + GPT-4o/Gemini | Yes | Yes (vision APIs) | OpenAI/Google | $ | **Yes (BYOK)** |
| `pi` + Groq/Mistral/xAI | Varies | Varies | Cloud providers | $ | **Yes (BYOK)** |
| `pi` + Qwen-VL (Ollama) | Partial | Images yes, PDFs variable | Self-hosted | $ | **Yes** (via `PI_MODELS_JSON_B64`) |
| `pi` + Llama/Mistral (Ollama) | No | No | Self-hosted | $ | **Yes** (via `PI_MODELS_JSON_B64`) |
| `pi` + any OpenAI-compatible | Varies | Varies | Private endpoints | $ | **Yes** (via `PI_MODELS_JSON_B64`) |

### The Problem

Claude reads PDFs and images natively — the agent *is* the parser. But private models behind pi (Llama 3, Mistral, DeepSeek, etc.) often can't. If we only support multi-modal models, orgs that need data sovereignty or cost control are locked out.

### The Solution: Capability-Adaptive Skills

Rather than building separate pipelines for multi-modal vs text-only models, the skill instructions **adapt to the model's capabilities**. The agent detects what it can do and falls back to workspace tools when needed.

**For multi-modal models** (Claude, GPT-4o, Gemini, Qwen-VL):
```
Agent reads the file directly → processes in one step
```

**For text-only models** (Llama, Mistral, DeepSeek via pi):
```
Agent uses workspace extraction tools → processes the extracted text
```

The worker image ships with standard extraction utilities:

| Tool | Handles | Already in worker? |
| --- | --- | --- |
| `pdftotext` (poppler) | PDF → plain text | Add to image |
| `pandoc` | DOCX/HTML/EPUB/LaTeX → markdown | Add to image |
| `tesseract` | Image → text (OCR) | Add to image |
| `ffmpeg` + `whisper-cli` | Audio → text | Optional |

These are lightweight CLI tools (~50 MB total), not library dependencies in the API server. The agent invokes them via bash when it can't read a file natively.

### Skill Adaptation Pattern

The skill instructions include a capability check:

```markdown
## Extracting Content

**If you can read the file directly** (you are a multi-modal model
that handles PDFs and images natively):
- Read the file directly from the workspace or presigned URL
- Process all pages/content in a single pass

**If you cannot read the file directly** (the file is binary and
you are a text-only model):
- For PDFs: `pdftotext input.pdf - | head -c 100000`
  or `pandoc input.pdf -t markdown` for better structure
- For DOCX: `pandoc input.docx -t markdown`
- For images: `tesseract input.png stdout`
- For audio: `whisper-cli -m /models/ggml-small.en.bin -f input.wav -otxt`
- Then process the extracted text as plain text input

**For all models**: Text files (markdown, JSON, YAML, CSV, code)
can always be read directly — no extraction needed.
```

This is elegant because:
- No conditional logic in the platform — the agent self-adapts
- Multi-modal models skip extraction entirely (faster, better quality)
- Text-only models get good-enough extraction via proven CLI tools
- No per-provider harness variants needed

### Two Default Harness Profiles

The pack ships with two profiles. Apps pick one:

```yaml
# .eve/manifest.yaml
harness_profiles:
  # Profile 1: Best quality — Claude native multi-modal
  ingest:
    harness: mclaude
    model: claude-opus-4-6
    reasoning_effort: medium

  # Profile 2: Multi-provider via pi (BYOK keys) — available today
  ingest-pi:
    harness: pi
    model: anthropic/claude-sonnet-4  # Or openai/gpt-4o, google/gemini-2.5-pro, etc.
    # pi uses provider/model format; provider key must be set as a project secret

  # Profile 3: Private/self-hosted via custom endpoint — available today
  ingest-pi-private:
    harness: pi
    model: lmstudio/qwen3:30b         # Provider name from PI_MODELS_JSON_B64
    # Set PI_MODELS_JSON_B64 as project secret with custom baseUrl config
    # Phase 2 will automate this via Eve's managed model registry
```

> **Note (2026-03-04)**: All three profiles work today. Profile 2 needs a provider API key as a project secret. Profile 3 needs `PI_MODELS_JSON_B64` as a project secret containing a `models.json` with custom `baseUrl` entries (e.g., pointing at LM Studio, vLLM, Ollama HTTP). Phase 2 of the pi integration will automate config generation from Eve's model registry.

Switching profiles is a one-line manifest change:

```yaml
agents:
  doc_processor:
    harness_profile: ingest-pi    # Switch from Claude to pi (any provider)
```

### pi + Eve Managed Inference

> **Status**: Functional today via manual `PI_MODELS_JSON_B64` project secret. Phase 2 will automate `models.json` generation from Eve's model registry — see [pi-harness-integration-plan.md](./../plans/pi-harness-integration-plan.md) §2.1–2.6.

The most interesting combination: pi harness pointed at Eve's managed model infrastructure. This means:

1. Org provisions an Ollama model (e.g., `qwen3:30b-a3b`) via `eve model install`
2. Manifest sets `ingest-pi` profile pointing to `managed/qwen3:30b-a3b`
3. pi's provider registry routes through Eve's inference endpoint
4. Worker writes `~/.pi/agent/models.json` with Eve inference URL as the base
5. Agent runs entirely on self-hosted infrastructure — zero external API calls

```yaml
# Fully self-hosted ingestion
harness_profiles:
  ingest-pi:
    harness: pi
    model: managed/qwen3:30b-a3b
    # Eve resolves managed/* → Ollama inference target
    # pi talks to Eve inference endpoint, which routes to Ollama
```

For orgs with data sovereignty requirements, this is the path. Documents never leave the org's infrastructure.

### Vision Gap for Text-Only Models

The one case where text-only models genuinely lose quality:

| File Type | Multi-modal model | Text-only model + tools |
| --- | --- | --- |
| PDF (text-based) | Perfect | Good (pdftotext/pandoc) |
| PDF (scanned) | Perfect (vision) | Decent (tesseract OCR) |
| Images (photos) | Full understanding | OCR text only — no visual context |
| Images (diagrams) | Structure + labels | Labels only — no spatial understanding |
| Images (handwritten) | Good | Poor (OCR struggles) |

For orgs that need both data sovereignty AND vision quality, the answer is a managed vision model (e.g., Qwen-VL via Ollama). The agent uses the same self-adaptation pattern — Qwen-VL can read images directly.

---

## Provenance & Deep Linking

Every fact, summary, or tag extracted by the agent must trace back to its source. This enables:
- A web UI to show exactly *where* in the original document a claim came from
- Users to verify agent work by jumping to the relevant section
- Downstream agents/apps to cite sources with precision

### Provenance Spans

The agent annotates extracted content with **provenance spans** — references into the source material:

```yaml
# In the org doc output frontmatter:
provenance:
  source_ingest_id: ing_abc123
  source_file: quarterly-report.pdf
  source_mime: application/pdf
  source_storage_key: ingest/ing_abc123/quarterly-report.pdf
  submitted_by: alice@example.com
  submitted_at: 2026-03-04T14:30:00Z
  instructions: "Focus on revenue figures and action items"

# Inline provenance in the document body (agent-generated):
spans:
  - id: s1
    type: page_range
    pages: [3, 4]          # PDF pages (1-indexed)
    text_excerpt: "Q4 revenue grew 23% YoY..."
  - id: s2
    type: timestamp_range
    start_ms: 145000       # Audio/video timestamp
    end_ms: 182000
    text_excerpt: "The CFO noted that enterprise expansion..."
  - id: s3
    type: char_range
    start: 4521            # Character offset in plain text
    end: 4687
    text_excerpt: "Action item: review pricing by March 15"
```

### Deep Link Format

Each span generates a deep link that a web UI can resolve:

```
eve://ingest/{ingest_id}/source?page=3         # PDF page
eve://ingest/{ingest_id}/source?t=145-182      # Audio timestamp range
eve://ingest/{ingest_id}/source?char=4521-4687 # Text character range
eve://ingest/{ingest_id}/source?line=42-58     # Line range (code/text)
```

A web UI renders these as:
- **PDF**: Open the PDF viewer at the relevant page, highlight the passage
- **Audio/Video**: Open the player, seek to the timestamp, play the segment
- **Text**: Open the document, scroll to the range, highlight
- **Image**: Show the image with a bounding box overlay (if OCR provides coordinates)

### Agent Responsibility

The skill instructions tell the agent to emit provenance spans. The agent is responsible for tracking which part of the source produced each output section. This is natural for agents — they're already reading the content sequentially. The skill just asks them to note the location as they go.

```markdown
## Provenance Tracking

As you process the document, annotate each key finding with its source location:
- For PDFs: note the page number(s)
- For audio transcripts: note the timestamp range (start-end in seconds)
- For text files: note the line number range
- For images: describe the region (e.g., "top-left quadrant", "table in center")

Include these as `spans` in the output frontmatter. Each span should have:
- A short `text_excerpt` (the actual words from the source)
- A location reference (page, timestamp, line, or character range)

Key points and summary items should each reference their span ID.
```

### Embedding Provenance in Output

The output document body uses span references inline:

```markdown
## Key Points

- Revenue grew 23% YoY to $4.2M [^s1]
- Enterprise expansion drove most growth [^s2]
- Action: Review pricing by March 15 [^s3]

[^s1]: quarterly-report.pdf, pages 3-4
[^s2]: quarterly-report.pdf, page 7 / board-meeting-recording.m4a @ 2:25-3:02
[^s3]: quarterly-report.pdf, page 12
```

This is standard markdown footnote syntax — readable as-is AND parseable by a web UI for interactive deep linking.

---

## Audio & Video: First-Class Transcription

Audio and video are not edge cases — they're a primary input channel. Meeting recordings, voice memos, podcasts, and video walkthroughs all need the same ingest treatment as documents.

### Transcription Pipeline

```
Audio/Video file
    │
    ▼
┌──────────────────────┐
│  Transcription Step  │
│  whisper-cli or API  │
│  → timestamped VTT   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Analysis Agent      │
│  (Claude/pi)         │
│  Works on transcript │
│  + original metadata │
│  Preserves timestamps│
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Org Docs output     │
│  with timecoded      │
│  provenance spans    │
└──────────────────────┘
```

### Implementation Options

| Option | Approach | Latency | Quality | Cost |
| --- | --- | --- | --- | --- |
| **Worker-local whisper** | `whisper-cli` in worker image | Low | Good (small/medium model) | Free (CPU) |
| **Code harness pre-step** | Separate job: code harness runs whisper, then doc agent processes transcript | Medium | Best (large model) | CPU time |
| **API transcription** | Groq Whisper API, OpenAI Whisper API, etc. via pi | Low | Excellent | $ per minute |
| **Native model support** | Future: Claude/Gemini process audio directly | Lowest | Best | $$ per token |

**Recommendation**: Ship with `whisper-cli` in the worker image (medium model, ~500MB). The agent runs `whisper-cli -f input.mp3 --output-vtt` to get a timestamped VTT transcript, then processes the VTT as a text document. Provenance spans reference timestamps from the VTT. For higher quality, orgs can use an API transcription provider via pi.

### VTT as the Intermediate Format

Whisper outputs VTT (Web Video Text Tracks) with timestamps:

```
WEBVTT

00:00:00.000 --> 00:00:04.500
Welcome everyone to the Q4 board review.

00:00:04.500 --> 00:00:12.000
I'll start with the revenue highlights. We saw 23% year-over-year growth.

00:00:12.000 --> 00:00:18.500
The main driver was enterprise expansion — three new accounts closed in December.
```

The analysis agent reads the VTT and preserves timestamps in its provenance spans. A web UI can then play the audio from any cited timestamp.

---

## File-Type Routing & Triage

Not all files need the same model. A scanned PDF needs vision. An audio file needs transcription. A plain text file needs the cheapest available model. Routing to the right harness/model by file type avoids waste and improves quality.

### Approach: Triage Agent (Team Dispatch)

The ingest workflow uses Eve's **team dispatch** pattern. A lightweight triage agent inspects file metadata and routes to the best sub-agent:

```yaml
# agents/teams.yaml
version: 1
teams:
  ingest_team:
    slug: ingest-triage
    name: "Ingest Triage"
    coordinator: triage_agent
    members:
      - doc_processor         # General documents (PDF, DOCX, text, code)
      - audio_processor       # Audio/video → transcription → analysis
      - ocr_processor         # Scanned PDFs, images → OCR → analysis
      - lightweight_processor # Plain text, markdown, CSV → cheap model

# agents/agents.yaml
agents:
  triage_agent:
    slug: ingest-triage
    name: "Ingest Triage"
    description: "Routes incoming files to the best processing agent based on type and size"
    skill: ingest-triage
    harness_profile: triage        # Fast, cheap model — just needs to read metadata
    workflow: coordinator

  audio_processor:
    slug: ingest-audio
    name: "Audio Processor"
    description: "Transcribes audio/video via whisper, then analyzes transcript"
    skill: audio-processor
    harness_profile: ingest        # Needs a smart model for analysis
    workflow: assistant

  ocr_processor:
    slug: ingest-ocr
    name: "OCR Processor"
    description: "Processes scanned documents and images via vision model"
    skill: ocr-processor
    harness_profile: ingest-vision  # Needs a vision-capable model
    workflow: assistant

  lightweight_processor:
    slug: ingest-light
    name: "Lightweight Processor"
    description: "Processes plain text, markdown, and structured data"
    skill: doc-processor
    harness_profile: ingest-fast   # Cheapest model that can summarize text
    workflow: assistant
```

### Triage Skill (Routing Logic)

```markdown
# Ingest Triage

You are a routing agent. Given file metadata, dispatch to the right processor.

## Routing Rules

Based on MIME type and file properties:

| MIME Pattern | Route to | Why |
|---|---|---|
| `audio/*`, `video/*` | `ingest-audio` | Needs transcription before analysis |
| `image/*` | `ingest-ocr` | Needs vision or OCR |
| `application/pdf` (size > 5MB or hints suggest scanned) | `ingest-ocr` | Likely scanned, needs vision |
| `application/pdf` (size < 5MB) | `doc_processor` | Likely text-based, standard processing |
| `text/*`, `application/json`, `application/yaml` | `ingest-light` | Plain text, use cheapest model |
| `application/vnd.openxmlformats*` (DOCX, XLSX, PPTX) | `doc_processor` | Office docs, standard processing |
| Everything else | `doc_processor` | Default fallback |

## User Override

If the user's `instructions` field specifies a processing preference
(e.g., "use OCR", "transcribe this", "just summarize the text"),
honor that over the default routing rules.

## Dispatch

For each file, create a child job dispatched to the chosen agent.
Pass through all user context (description, instructions, tags).
```

### Harness Profiles for Routing

```yaml
harness_profiles:
  triage:
    harness: pi
    model: groq/llama-3.3-70b-versatile   # Fast + cheap, just reads metadata
  ingest:
    harness: mclaude
    model: claude-sonnet-4-6               # Good balance for documents
  ingest-vision:
    harness: mclaude
    model: claude-sonnet-4-6               # Vision-capable for scanned docs
  ingest-fast:
    harness: pi
    model: groq/llama-3.3-70b-versatile   # Cheap for plain text
  ingest-audio:
    harness: mclaude
    model: claude-sonnet-4-6               # Smart model to analyze transcripts
```

### Simple Mode (No Triage)

For apps that don't need routing complexity, skip the team and use a single agent directly. The single agent handles all file types using the capability-adaptive pattern (try native read → fall back to tools). This is the default pack behavior — the triage team is an optional upgrade.

---

## Embeddings (Pack-Customizable)

Some apps want vector embeddings for semantic search (RAG, similarity matching, clustering). This is **not** a platform concern — it's an agent pack customization.

### How It Works

The agent pack adds an embedding step to the processing pipeline:

```markdown
## Post-Processing: Embeddings (if configured)

After writing the org doc, generate embeddings for semantic search:

1. Split the extracted content into chunks (by section, paragraph, or sliding window)
2. For each chunk, call the embedding API:
   `curl -X POST $EVE_INFERENCE_URL/v1/embeddings -d '{"input": "...", "model": "text-embedding-3-small"}'`
3. Write the embedding vectors to org docs metadata:
   `eve org-docs update --path /ingest/{type}/{slug}.md --metadata '{"embeddings": [...]}'`

Chunk size and overlap are configurable via pack settings.
```

### Pack-Level Configuration

```yaml
# In pack.yaml or manifest overlay:
x-eve:
  ingest:
    embeddings:
      enabled: true
      model: openai/text-embedding-3-small  # Or any OpenAI-compatible embedding API
      chunk_size: 512
      chunk_overlap: 64
      store: org_docs_metadata  # Where to write vectors
```

This keeps embeddings entirely in the agent/pack layer. The platform doesn't need to know about vectors. Apps that want RAG add the embedding config; apps that don't, skip it.

---

## Audit Trail

Every ingestion creates an immutable **ingest record** in the database:

```typescript
interface IngestRecord {
  id: string;                    // ing_xxx (TypeID)
  project_id: string;
  org_id: string;

  // What was submitted
  file_name: string;
  file_mime_type: string;
  file_size_bytes: number;
  file_storage_key: string;      // Object store path

  // Who submitted it
  actor_type: 'user' | 'service_principal' | 'agent' | 'system';
  actor_id: string;
  actor_display: string;         // Email or name for display

  // When and from where
  submitted_at: Date;
  channel: 'api' | 'slack' | 'org_fs' | 'cli';
  channel_metadata: Record<string, unknown>;  // Slack channel, thread, org-fs path, etc.

  // User intent
  title: string | null;
  description: string | null;
  instructions: string | null;
  tags: string[];
  user_metadata: Record<string, unknown>;

  // Processing outcome
  job_id: string | null;         // Job that processed this file
  output_doc_path: string | null; // Org doc path where result was written
  status: 'pending' | 'processing' | 'completed' | 'failed';
  completed_at: Date | null;
  error: string | null;
}
```

**Query patterns:**
```bash
# Who ingested files this week?
eve ingest list --since 7d --json

# What did alice submit?
eve ingest list --actor alice@example.com

# What happened to a specific file?
eve ingest show ing_abc123 --verbose

# Audit trail for compliance
eve ingest list --since 30d --format csv > audit-export.csv
```

---

## Default Agent Pack: `eve-doc-ingest`

Published as a **public repo** (`eve-horizon/eve-doc-ingest` or similar) so that external apps can reference it as a pack source. This follows the same pattern as `eve-skillpacks` — the platform source (eve-horizon) is private, but agent packs and skills that apps need to customize must be public (or at least accessible to the app's repo).

> **Why not ship in eve-horizon?** Eve-horizon is a private repo. When an app's manifest references a pack via `source: github:org/repo`, Eve clones that repo at sync time. If the pack lives in the private platform repo, apps can't access the skills to read, overlay, or customize them. A separate public repo also lets pack versioning evolve independently of platform releases.

### Pack Structure

```
eve-doc-ingest/   # Public repo: eve-horizon/eve-doc-ingest
├── eve/
│   └── pack.yaml
├── agents/
│   ├── agents.yaml
│   ├── teams.yaml
│   └── chat.yaml
└── skills/
    └── doc-processor/
        └── SKILL.md
```

### `eve/pack.yaml`

```yaml
version: 1
id: eve-doc-ingest
imports:
  agents: agents/agents.yaml
  teams: agents/teams.yaml
  chat: agents/chat.yaml
gateway:
  default_policy: routable
```

### `agents/agents.yaml`

```yaml
version: 1
agents:
  doc_processor:
    slug: doc-ingest
    name: "Document Processor"
    description: "Ingests documents — extracts content, classifies, tags, summarizes, and writes structured output to org docs."
    skill: doc-processor
    workflow: assistant
    harness_profile: ingest

    context:
      docs:
        - path: docs/ingest-schema
          recursive: true

    gateway:
      policy: routable
      clients: [slack, webchat]
```

### `agents/chat.yaml`

```yaml
version: 1
default_route: route_ingest

routes:
  - id: route_ingest
    match: ".*"
    target: doc_processor
```

### `skills/doc-processor/SKILL.md`

```markdown
# Document Processor

You are a document processing agent. When invoked, you receive a file
to ingest via resource_refs or job description.

## User Context

Check the job metadata for user-supplied context:
- **description**: What the submitter says the file is. Use this to
  inform your classification and tagging.
- **instructions**: How the submitter wants it processed. If present,
  these override default processing — e.g., "extract only action items"
  or "focus on the financial tables". Honor the intent.

If no instructions are provided, apply full default processing.

## Processing Steps

1. **Retrieve the file** — Download via the presigned URL or read from
   the workspace mount.

2. **Extract content** — Adapt to your capabilities:

   **If you can read the file directly** (you are a multi-modal model):
   - Read PDFs, images, and documents natively
   - Process all pages/content in a single pass

   **If the file is binary and you cannot read it directly**:
   - PDF: run `pdftotext input.pdf -` (fast) or `pandoc input.pdf -t markdown` (preserves structure)
   - DOCX/EPUB/HTML: run `pandoc input.docx -t markdown`
   - Images: run `tesseract input.png stdout` for OCR text extraction
   - Audio: run `whisper-cli -m /models/ggml-small.en.bin -f input.wav -otxt` if available

   **Always readable without tools**: .md, .txt, .csv, .json, .yaml,
   .xml, and all code/config files.

3. **Classify** — Determine the document type:
   - `report` — Business reports, quarterly reviews, status updates
   - `spec` — Technical specifications, requirements, RFCs
   - `meeting_notes` — Meeting minutes, action items
   - `design` — Architecture docs, wireframes, mockups
   - `reference` — API docs, guides, manuals
   - `correspondence` — Emails, memos, letters
   - `data` — Spreadsheets, datasets, exports
   - `other` — Anything that doesn't fit above

4. **Tag** — Apply relevant tags from the content:
   - Extract mentioned people, teams, projects
   - Identify key topics and themes
   - Note any dates, deadlines, or milestones

5. **Summarize** — Generate:
   - `one_liner`: Single sentence (max 120 chars)
   - `summary`: 2-5 sentence executive summary
   - `key_points`: 3-10 bullet points of important content

6. **Track provenance** — As you process, note where each key finding
   comes from in the source:
   - For PDFs: page number(s)
   - For audio/video transcripts: timestamp range (start-end seconds)
   - For text files: line number range
   - Emit these as `spans` in the output frontmatter. Reference them
     from key points and summary items using footnote syntax `[^s1]`.

7. **Structure** — Write the output as a markdown document with
   YAML frontmatter for metadata (including provenance spans).

## Output Format

Write the result to org docs using the Eve API. The output document
should follow this structure:

\```markdown
---
source_file: {original_filename}
source_mime: {mime_type}
source_ingest_id: {ingest_id}
source_storage_key: {storage_key}
ingested_at: {ISO timestamp}
ingested_by: doc-processor
submitted_by: {actor email/name}
submitted_via: {channel}
user_description: "{description from submitter, if any}"
user_instructions: "{processing instructions from submitter, if any}"
type: {classified type}
tags: [{tag1}, {tag2}, ...]
one_liner: "{single sentence summary}"
people: [{person1}, {person2}, ...]
provenance:
  spans:
    - id: s1
      type: page_range
      pages: [3, 4]
      excerpt: "Q4 revenue grew 23%..."
    - id: s2
      type: timestamp_range
      start_ms: 145000
      end_ms: 182000
      excerpt: "Enterprise expansion drove growth..."
---

# {Document Title}

## Summary

{2-5 sentence executive summary}

## Key Points

- {point 1} [^s1]
- {point 2} [^s2]
- ...

[^s1]: {source_file}, pages 3-4
[^s2]: {source_file} @ 2:25-3:02

## Full Content

{Extracted and cleaned markdown content, preserving structure}
\
```

Provenance footnotes use standard markdown footnote syntax — readable as plain text
AND parseable by a web UI for interactive deep linking (highlight passage, play audio
from timestamp, open PDF at page).

## Output Path

Write to org docs at: `/ingest/{type}/{slug}.md`

Where:
- `{type}` is the classified document type
- `{slug}` is a URL-safe slug derived from the title

## Responding to Slack

If the ingestion was triggered from Slack (check job metadata for
slack_channel), include a brief confirmation in your response:
- Document title
- Classification
- One-liner summary
- Link to the org doc path

## Error Handling

If the file cannot be read or is empty:
- Report the error clearly
- Include the file metadata (name, type, size)
- Do not write an empty org doc
```
### Manifest Integration

Apps install the pack and wire the trigger. Choose a harness profile:

```yaml
# .eve/manifest.yaml
x-eve:
  packs:
    - source: github:eve-horizon/eve-doc-ingest   # Public repo — apps need read access to customize skills
      ref: abc123...

  harness_profiles:
    # Option A: Claude — best quality, native multi-modal
    ingest:
      harness: mclaude
      model: claude-opus-4-6
      reasoning_effort: medium

    # Option B: pi + cloud provider — multi-provider flexibility (available today)
    ingest-pi:
      harness: pi
      model: openai/gpt-4o            # Or anthropic/claude-sonnet-4, google/gemini-2.5-pro
      # Note: pi uses provider/model format

    # Option C: pi + private model — data sovereignty, low cost (available today)
    ingest-pi-private:
      harness: pi
      model: lmstudio/qwen3:30b       # Provider from PI_MODELS_JSON_B64 secret

workflows:
  ingest:
    trigger:
      - source: system
        type: doc.ingest
    hints:
      timeout_seconds: 300
      permission_policy: auto_edit
    target:
      agent_slug: doc-ingest
```

The agent references one profile (`harness_profile: ingest`). Switch to private models by changing the profile — the skill self-adapts.

## Customization via Pack Overlay

Apps customize ingestion by overlaying the default pack's agent with their own instructions.

### Example: PM App

```yaml
# Project-level agents/agents.yaml (overlay)
version: 1
agents:
  doc_processor:
    skill: pm-doc-processor    # Override the skill

# skills/pm-doc-processor/SKILL.md
# Extends default with PM-specific classification:
#   - user_story, epic, bug_report, design_doc, meeting_notes
#   - Extracts acceptance criteria, story points, sprint references
#   - Writes to /specs/{area}/{slug}.md with PM metadata
#   - Generates delta proposals against existing spec tree
```

### Example: Knowledge Base (High Volume, Low Cost via pi)

```yaml
# Use a fast cloud model for bulk ingestion (available today)
agents:
  doc_processor:
    harness_profile: ingest-fast

# In manifest:
harness_profiles:
  ingest-fast:
    harness: pi
    model: groq/llama-3.3-70b-versatile   # Fast, cheap via Groq
    # Agent auto-detects text-only → uses pdftotext/pandoc for binaries
    # Or use self-hosted: model: lmstudio/llama3:8b (via PI_MODELS_JSON_B64)
```

### Example: Data Sovereign Org (pi + Self-Hosted Inference)

```yaml
# Everything on-prem — documents never leave org infrastructure
agents:
  doc_processor:
    harness_profile: ingest-sovereign

harness_profiles:
  ingest-sovereign:
    harness: pi
    model: lmstudio/qwen3:30b        # Custom provider name from models.json
    # User sets PI_MODELS_JSON_B64 secret with:
    #   {"providers":{"lmstudio":{"baseUrl":"http://gpu-node:1234/v1",
    #     "api":"openai-chat-completions","apiKey":"none","models":["qwen3:30b"]}}}
    # pi routes through custom endpoint. No external API calls.
    # Phase 2 will automate this config via Eve's managed model registry.
```

### Example: Compliance Audit

```yaml
# Override skill with compliance-specific processing
agents:
  doc_processor:
    skill: compliance-doc-processor

# skills/compliance-doc-processor/SKILL.md
# Classifies by regulation (SOX, GDPR, HIPAA, SOC2)
# Extracts control references, evidence items, findings
# Tags with severity, control_id, regulation
# Writes to /compliance/{regulation}/{control}/{slug}.md
# Flags documents requiring human review
```

## Slack Ingestion Flow

User experience:

```
User:    @eve doc-ingest [attaches quarterly-report.pdf]
         "Process this Q4 report — focus on revenue figures and action items for the board meeting"

Eve Bot: Processing quarterly-report.pdf (2.4 MB PDF)...
         Submitted by: alice@example.com via Slack
         Instructions: "focus on revenue figures and action items for the board meeting"

         [After ~30 seconds]

Eve Bot: Ingested: Q4 2025 Financial Report
         Type: report
         Tags: #finance #q4-2025 #board-meeting #revenue
         Summary: Q4 revenue grew 23% YoY to $4.2M, driven by
         enterprise expansion. Operating margin improved to 18%.

         Key Findings (per your instructions):
         • Revenue: $4.2M, +23% YoY (p.3-4)
         • Action: Review pricing by March 15 (p.12)
         • Action: Finalize enterprise renewal terms (p.15)

         Saved to: /ingest/report/q4-2025-financial-report.md
         Audit: ing_abc123 | alice@example.com | 2026-03-04 14:30
```

**Behind the scenes:**
1. Slack sends `app_mention` event with file attachment
2. Gateway downloads PDF from Slack → stores in object store
3. Gateway creates chat thread, routes to `doc-ingest` agent
4. Job created with `resource_refs` pointing to stored PDF
5. Agent reads PDF, processes, writes to org docs
6. Agent's response posted back to Slack thread

**Multi-file support (with triage routing):**
```
User:    @eve doc-ingest [attaches 5 files]
         "Process all of these from today's architecture review"

Eve Bot: Routing 5 files...
         📄 arch-review-slides.pdf (2.1 MB) → doc_processor (text PDF)
         📄 api-spec-v3.yaml (45 KB) → lightweight_processor (structured text)
         🖼️ whiteboard-photo.jpg (3.2 MB) → ocr_processor (image → OCR)
         🎙️ meeting-recording.m4a (48 MB) → audio_processor (transcribe → analyze)
         📄 action-items.md (2 KB) → lightweight_processor (plain text)

         [After ~2 minutes]

Eve Bot: All 5 files ingested:
         1. arch-review-slides.pdf → /ingest/design/arch-review-2026-03.md
         2. api-spec-v3.yaml → /ingest/spec/api-spec-v3.md
         3. whiteboard-photo.jpg → /ingest/design/whiteboard-arch-review.md
         4. meeting-recording.m4a → /ingest/meeting_notes/arch-review-transcript.md
            (45 min transcript with timestamped provenance — click any finding to play audio)
         5. action-items.md → /ingest/meeting_notes/arch-review-actions.md
```

The triage agent routes each file to the optimal processor. Audio files get transcribed via whisper first, then the transcript is analyzed with timestamped provenance — a web UI can play the audio from any cited timestamp.

## Org-FS Drop Folder

For bulk or automated ingestion:

```bash
# Copy files into the org's inbox
cp *.pdf /org/inbox/

# Org-fs sync pushes them to the object store
# file.created events fire for each file
# Trigger matches → ingest workflow runs for each
# Processed files moved to /org/inbox/processed/
```

**CLI shortcut:**
```bash
# Upload and ingest in one command
eve ingest quarterly-report.pdf --tags finance,q4

# With description and processing instructions
eve ingest quarterly-report.pdf \
  --description "Q4 board deck from CFO" \
  --instructions "Extract revenue tables and action items only" \
  --tags finance,q4,board

# Ingest audio with context
eve ingest meeting-recording.m4a \
  --description "Architecture review meeting, 2026-03-04" \
  --instructions "Focus on decisions made and action items assigned"

# Ingest from URL
eve ingest --url https://example.com/report.pdf --title "External Report"

# Bulk ingest a directory
eve ingest ./documents/ --recursive

# Query audit trail
eve ingest list --since 7d
eve ingest show ing_abc123 --verbose
```

The `eve ingest` command is syntactic sugar over the REST endpoint. It handles multipart upload, polls for completion, and displays the result. All flags map directly to the API fields.

## What We Don't Build

Intentionally excluded to keep the design minimal:

1. **Parser libraries in the API server** — No pdf-parse, mammoth, Ollama vision in the API. Multi-modal models read files natively. Text-only models (via pi) use lightweight CLI tools (`pdftotext`, `pandoc`, `tesseract`) already present in the worker image. The extraction logic lives in the agent skill, not platform code.

2. **Per-provider harness variants** — No `ingest-anthropic`, `ingest-openai`, `ingest-ollama` harness adapters. The pi harness handles provider routing via its unified provider registry. One harness covers 20+ providers.

3. **Extraction quality gates** — eve-pm's multi-lane extraction with quality scoring was necessary because it used small local models. The agent itself judges extraction quality and retries or reports errors. No platform-level quality pipeline.

4. **Schema enforcement in the platform** — The output schema lives in the agent's skill instructions, not in platform config. This keeps the platform generic while letting apps define arbitrary structures.

5. **Delta proposals** — eve-pm's delta system is app-specific (mutating a spec tree). Generic ingestion just produces documents. Apps that need deltas build that in their skill overlay.

6. **Deduplication** — Content-hash based dedup is handled naturally by org docs (unique path constraint). Re-ingesting the same file at the same path creates a new version, not a duplicate.

## Implementation Order

### Phase 0: Prerequisites

1. **~~pi harness integration~~** — **DONE.** The `pi` harness adapter is implemented and verified (see [pi-harness-integration-plan.md](./../plans/pi-harness-integration-plan.md), Phase 1 complete). Pi is registered as a canonical harness with full event normalization, auth checks, capabilities, reasoning mapping, and a test fixture stub. Manual scenario 29 verifies pi execution end-to-end.
  - **BYOK cloud providers** (Anthropic, OpenAI, Google, Groq, etc.) — works today via provider API key secrets.
  - **Self-hosted / OpenAI-compatible endpoints** (LM Studio, vLLM, Ollama, etc.) — **works today** via `PI_MODELS_JSON_B64` project secret. Users base64-encode a `models.json` with custom `baseUrl` entries and set it as a secret. Pi picks it up and routes to the custom endpoint. No Phase 2 needed.
  - **Phase 2 (convenience only)** — Auto-generates `models.json` from Eve's managed model registry so users don't hand-craft the config. This is ergonomics, not capability.
2. **Worker image extraction tools** — Add `pdftotext` (poppler-utils), `pandoc`, and `tesseract` to the worker Docker image. These are standard packages (~50 MB total) that enable text-only models to extract content from binary files. **Not yet done.**

### Phase 1: Ingest Endpoint + Audit Trail + Default Pack (2-3 days)

1. Add `ingest_records` table (immutable audit trail)
2. Add `POST /projects/{projectId}/ingest` endpoint
  - Multipart upload with `description` + `instructions` fields
  - Creates ingest record → stores file → fires `doc.ingest` event
  - Wire event type into trigger matcher
3. Create public repo `eve-horizon/eve-doc-ingest` with single-agent pack (no triage yet)
  - Skill includes user-context handling and provenance span tracking
4. Add `eve ingest` CLI command with `--description` and `--instructions` flags
5. Add `eve ingest list` and `eve ingest show` for audit trail queries
6. Manual test scenarios:
  - Upload PDF via Claude profile → verify org doc output with provenance spans
  - Upload PDF via pi profile → verify extraction fallback works
  - Verify ingest record captures actor, timestamp, instructions

### Phase 2: Audio + Triage Team (1-2 days)

1. Add `whisper-cli` and `ffmpeg` to worker image
2. Create `audio_processor` agent with VTT-based transcription pipeline
3. Create triage agent + team config (coordinator dispatches by MIME type)
4. Add manifest routing rules for obvious cases (audio/* → audio agent)
5. Test: Upload MP3 → verify timestamped transcript → verify provenance spans reference timestamps

### Phase 3: Slack File Download (0.5-1 day)

1. Enhance gateway to download Slack file attachments
2. Store downloaded files in object store with ingest ID
3. Slack message text becomes `description` + `instructions` in ingest record
4. Pass as `resource_refs` to the created job
5. Test: `@eve doc-ingest` with file attachment in Slack

### Phase 4: Org-FS Watch Paths (0.5 day)

1. Add `org_fs.file.created` as a trigger-matchable event type
2. Document the `/inbox/` convention
3. Test: drop file into org-fs → verify auto-ingestion

### Phase 5: Polish + Embeddings (1 day)

1. `eve ingest --url` for URL-based ingestion
2. Bulk ingestion (`eve ingest ./dir/ --recursive`)
3. Completion callback webhook
4. Embedding pack extension (configurable model, chunk size, output target)
5. Update eve-skillpacks references

## Comparison: eve-pm vs This Design

| Aspect | eve-pm (bespoke) | Eve Ingest (Claude) | Eve Ingest (pi + private) |
| --- | --- | --- | --- |
| Extraction | 4-lane pipeline with fallback chains | Agent reads natively | Agent uses CLI tools (pdftotext, pandoc, tesseract) |
| Parser deps | pdf-parse, mammoth, whisper, ffmpeg, Ollama | None | pdftotext, pandoc, tesseract in worker image |
| Provider | Ollama only | Anthropic only | 20+ via pi (cloud BYOK or self-hosted via `PI_MODELS_JSON_B64`) |
| Data sovereignty | Partial (Ollama local) | No (API calls to Anthropic) | Full (point pi at any OpenAI-compatible endpoint) |
| Multi-modal | Via Ollama vision models | Native (PDF, images, code) | Depends on model (Qwen-VL yes, Llama no) |
| Cost | $ (local models) | $$ (Opus) | $ (self-hosted) to $ (cloud via pi) |
| Configuration | Environment variables | Agent pack instructions | Agent pack + `models.json` |
| Customization | Fork the code | Overlay the skill | Overlay the skill |
| Output | Bespoke IntakeItem table | Standard org docs (versioned, searchable) | Standard org docs (versioned, searchable) |
| Input channels | REST upload only | REST, Slack, org-fs, CLI | REST, Slack, org-fs, CLI |
| Storage | Local filesystem | Object store (S3-compatible) | Object store (S3-compatible) |

## Open Questions

1. **~~Audio transcription~~** — **Resolved as first-class.** Audio/video is handled by a dedicated `audio_processor` agent in the triage team. Whisper runs in the worker image; output is timestamped VTT. The analysis agent works on the transcript with timecoded provenance spans. See "Audio & Video: First-Class Transcription" section above.

2. **Large file handling** — PDFs over 100 pages, large images:
  - Claude has context limits; very large documents may need chunking
  - Text-only models via pi have even tighter context windows
  - The agent skill can instruct page-range processing or chunked extraction
  - **Recommendation**: Agent handles this in instructions; no platform chunking. For pi with small context models, `pdftotext` output can be truncated/chunked by the agent.

3. **Batch ingestion throttling** — Dropping 100 files in `/inbox/`:
  - Each file creates a separate job
  - Orchestrator concurrency limits prevent resource exhaustion
  - **Recommendation**: Existing concurrency controls are sufficient

4. **Re-ingestion** — Same file uploaded twice:
  - Same path → org docs creates new version (versioning handles it)
  - Different path → separate document
  - **Recommendation**: Content-hash metadata enables agent to detect and note duplicates

5. **Org-fs event → system event bridge** — Currently org-fs events live in `org_fs_events` table, not the main `events` table:
  - Option A: Emit matching event into main events table on org-fs file creation
  - Option B: Event router also polls org-fs events table
  - **Recommendation**: Option A (emit into main events table) keeps the event spine unified

6. **~~pi harness JSON output mapping~~** — **Resolved.** Pi's `--mode json` output is normalized by eve-agent-cli's event pipeline. Key findings from implementation:
  - Pi emits `message_update` (with `assistantMessageEvent.text_delta`) for streaming text, `tool_execution_start/end` for tools, and `message_end` with `message.usage` for token tracking.
  - `llm.call` events are emitted only from `message_end` events (not `turn_end`) to avoid double-counting.
  - Provider is extracted from the `provider/model` format in the model string.
  - camelCase usage fields (`inputTokens`/`outputTokens`) are handled alongside snake_case variants.
  - See commits `ff64287`, `bcd3fb1`, `b2631c0` for the normalization implementation.

7. **pi extension for Eve tools** — pi's extension system could inject Eve-specific tools (org-docs write, org-fs access, secrets read) into the agent. Pi also supports skill discovery (`--list-skills`) which Eve now verifies in scenario 29.
  - Option A: Agent uses bash + `eve` CLI commands (works today, no pi extension needed)
  - Option B: Custom pi extension that wraps Eve API calls as native pi tools
  - **Recommendation**: Option A for now. Consider Option B as the pi integration matures — native tools would be faster and more ergonomic.

8. **Worker image size** — Adding pdftotext + pandoc + tesseract adds ~50 MB. Adding whisper adds ~500 MB:
  - Core extraction tools (pdftotext, pandoc, tesseract): always include — low cost, high value
  - Whisper: include medium model by default (~500 MB). Audio is first-class, not optional.
  - **Recommendation**: Single worker image with all tools. 550 MB is acceptable for a worker image. If size becomes a concern, use a resource class to select between "standard" and "audio-capable" worker variants.

9. **Model capability discovery** — How does the agent know if it's multi-modal?
  - Option A: Agent tries to read the file; if it fails, falls back to tools (pragmatic)
  - Option B: Job metadata includes `harness_capabilities: [vision, pdf, audio]` (explicit)
  - Option C: Skill instructions say "try direct read first, fall back to tools" (simplest)
  - **Recommendation**: Option C. The agent is smart enough to detect failure and adapt. No platform metadata needed.

10. **Pi installed in agent-runtime** — Pi is now installed in both the worker image AND the agent-runtime Dockerfile (commit `606c6bb`). This means pi-based ingestion agents can run as warm pods in the agent runtime, not just as cold-start worker jobs. This is particularly relevant for Slack-triggered ingestion where latency matters.

11. **Triage agent vs manifest routing rules** — Two approaches for file-type routing:
    - Option A: **Triage agent** (team coordinator) — inspects metadata, dispatches to sub-agents. Flexible, can use user instructions to override. Costs one extra LLM call per ingest.
    - Option B: **Manifest routing rules** — static MIME-type → agent mapping in the workflow config. Zero LLM overhead, but rigid and can't consider user intent.
    - Option C: **Hybrid** — manifest rules for obvious cases (audio → audio agent), triage agent for ambiguous ones (is this PDF scanned or text-based?).
    - **Recommendation**: Option C. Most routing is deterministic (audio files always need transcription). The triage agent only fires for ambiguous cases or when user instructions suggest a non-default route.

12. **Provenance span granularity** — How detailed should provenance be?
    - Page-level (PDF page 3) is always achievable
    - Paragraph-level requires the agent to track extraction position
    - Character-level requires tools like pdftotext to emit offsets
    - Timestamp-level (audio) comes free from VTT format
    - **Recommendation**: Page-level for PDFs, timestamp-level for audio, line-level for text. Character-level is nice-to-have but not essential for v1. The key is that every key point references *something* — the granularity can improve later.

13. **Ingest record storage** — Where does the audit trail live?
    - Option A: New `ingest_records` table in the Eve database
    - Option B: Metadata on the org doc output (no separate table)
    - Option C: Both — ingest record in DB for querying, provenance in org doc for display
    - **Recommendation**: Option C. The DB record enables `eve ingest list` queries and API filtering. The org doc metadata enables deep linking from the rendered output. They serve different purposes.

14. **Embedding storage** — Where do vector embeddings live?
    - Option A: In org docs metadata (keeps everything together, but metadata gets large)
    - Option B: Separate vector store (pgvector, Qdrant, etc.) with org doc path as foreign key
    - Option C: Object store as `.npy` or `.json` sidecar files
    - **Recommendation**: Defer to app layer. The agent pack writes embeddings wherever the app needs them. The platform doesn't need to own vector storage. Start with org docs metadata for simplicity; apps with heavy RAG needs can point at their own vector store.

15. **Pack distribution model** — Platform-provided packs must be public so apps can customize them:
    - Eve-horizon is a private repo → packs can't live here if apps need to read/overlay skills
    - Pattern: separate public repo per pack (e.g., `eve-horizon/eve-doc-ingest`), same as `eve-skillpacks`
    - Apps reference packs via `source: github:eve-horizon/eve-doc-ingest` + `ref: <sha>` in their manifest
    - **Open sub-questions**:
      - Should there be one mono-repo for all platform packs (like `eve-skillpacks`) or one repo per pack?
      - How does pack versioning work? Git refs (SHA/tags) are the current mechanism — is that sufficient?
      - Should the triage team config (agents, teams, skills) ship in the same repo as the single-agent pack, or as a separate "advanced" pack?
    - **Recommendation**: Start with one repo per pack (`eve-horizon/eve-doc-ingest`). The single-agent version and the triage-team version can be separate directories in the same repo (e.g., `basic/` and `advanced/`), referenced by path in the manifest. If pack proliferation becomes a problem, consolidate into a mono-repo later.
