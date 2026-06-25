# Media Processing Architecture: Agent Tooling vs Platform Pre-Processing

> **Status**: Idea (draft)
> **Date**: 2026-03-05
> **Context**: The document ingestion MVP transports files (including audio/video) to agent workspaces, but agents have no tools to decode binary media. We need to decide where media processing lives.
> **See also**: [document-ingestion-agent-packs.md](./document-ingestion-agent-packs.md) — broader ingestion design

## The Problem

Today the ingestion pipeline is format-blind. Any file uploads to S3, hydrates into the agent workspace, and the agent receives raw bytes. This works for text files (md, txt, json, yaml) because LLMs can read them directly. It fails for:

- **Audio** (wav, mp3, m4a, ogg, flac, opus, webm) — agents can't listen
- **Video** (mp4, mkv, mov, avi, webm) — agents can't watch or extract audio tracks
- **Scanned PDFs / images** — agents need OCR before they can read (partially solved by multimodal models)

The question is where to put the processing: give agents the tools, or have the platform do it before the agent sees the file.

## Option A: Agent-Side Tooling

Install ffmpeg and whisper in the worker/agent-runtime Docker images. Agents use them as CLI tools during job execution, deciding when and how to process media.

### How It Works

```
File uploads to S3
       │
       ▼
Agent receives raw file in workspace
       │
       ▼
Agent inspects file type, runs tools:
  - ffmpeg -i video.mp4 -vn -acodec pcm_s16le audio.wav
  - whisper audio.wav --model small --output-format vtt
  - pdftotext document.pdf document.txt
       │
       ▼
Agent works with extracted text/transcript
```

### What Changes

**Worker Dockerfile** — Add a new `media` build stage (following existing pattern):

```dockerfile
FROM base AS media

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Whisper.cpp for CPU-based transcription (~150MB with small model)
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp /opt/whisper \
    && cd /opt/whisper && make -j$(nproc) \
    && cp main /usr/local/bin/whisper-cli \
    && curl -L -o /opt/whisper/models/ggml-small.en.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin \
    && rm -rf /opt/whisper/.git
USER node
```

**Agent-runtime Dockerfile** — Same additions (agents run there in k3d).

**Workflow prompts** — Agents instructed to use the tools:

```yaml
workflows:
  process-document:
    trigger:
      system:
        event: doc.ingest
    steps:
      - agent:
          prompt: |
            Process the ingested file in your workspace.
            For audio files: run `whisper-cli -m /opt/whisper/models/ggml-small.en.bin -f <file> -ovtt`
            For video files: first extract audio with `ffmpeg -i <file> -vn -acodec pcm_s16le /tmp/audio.wav`
            Then transcribe the extracted audio.
            Analyze the transcript and write your findings.
```

### Size Impact

| Component | Size | Notes |
|-----------|------|-------|
| ffmpeg | ~80 MB | Debian package, handles all container formats |
| whisper.cpp binary | ~5 MB | Compiled from source |
| ggml-small.en model | ~150 MB | English-only, good quality/speed balance |
| ggml-medium model | ~500 MB | Better quality, slower |
| ggml-large-v3 model | ~1.5 GB | Best quality, significantly slower |
| **Total (small model)** | **~235 MB** | Added to ~1.8 GB worker image |

### Supported Formats (via ffmpeg)

Everything ffmpeg supports, which is effectively everything:

| Category | Formats |
|----------|---------|
| Audio | wav, mp3, m4a, aac, ogg, opus, flac, wma, amr, webm (audio) |
| Video | mp4, mkv, mov, avi, webm, ts, flv, wmv |
| Containers | matroska, mpeg-ts, ogg, webm |

ffmpeg handles all demuxing, decoding, and format conversion. The agent just runs `ffmpeg -i input.anything -vn -acodec pcm_s16le output.wav` to extract audio from any container.

### Pros

1. **Zero platform complexity** — No new services, queues, or processing stages
2. **Agent decides** — The agent can inspect the file, read metadata, choose the right approach. A 3-second voice memo doesn't need the same treatment as a 2-hour meeting recording
3. **Composable via workflow** — Different workflows can use different prompts/strategies without platform changes
4. **Visible in logs** — `eve job follow` shows the agent running ffmpeg, whisper, etc. Full observability
5. **Customizable per org** — Different agent packs can use different models/tools
6. **Follows Eve philosophy** — Platform moves bytes, agents do the thinking
7. **Already have the pattern** — Worker Dockerfile already has multi-target stages (base, python, rust, java, full). Adding `media` is natural

### Cons

1. **Image size** — +235 MB (small model) to +1.7 GB (large model) per image, on both worker and agent-runtime
2. **CPU-bound transcription** — whisper.cpp on CPU: ~real-time for small model, ~4x real-time for medium. A 60-minute recording takes 60+ minutes to transcribe on CPU
3. **Agent must know the tools** — Prompt engineering required. Agent might use wrong flags, fail to handle edge cases
4. **No caching** — Same file transcribed again wastes compute. No deduplication
5. **Cold-start cost** — Every media job pays the transcription cost, even if the agent only needs a quick summary
6. **Model size trade-off** — Small model has lower accuracy (especially for non-English, accents, technical jargon). Large model bloats the image

## Option B: Platform Pre-Processing Pipeline

The platform automatically processes media files between upload and agent dispatch. The agent receives derived artifacts (transcript, metadata, thumbnails) alongside or instead of the raw file.

### How It Works

```
File uploads to S3
       │
       ▼
Platform inspects MIME type
       │
       ├── audio/* or video/* ──► Transcription worker
       │                            - ffmpeg extracts audio
       │                            - whisper transcribes
       │                            - Stores VTT + metadata in S3
       │                            - Attaches transcript as resource_ref
       │
       ├── image/* ──► OCR worker (optional)
       │
       └── text/*, application/* ──► Pass through
       │
       ▼
Agent receives: original file + transcript VTT + metadata JSON
```

### What Changes

**New service or job type** — A pre-processing step that runs between ingest confirm and workflow dispatch:

```
ingest confirm → pre-process job → system.doc.ingest event (enriched)
```

The event payload gains new fields:

```json
{
  "ingest_id": "ing_xxx",
  "file_name": "meeting.m4a",
  "mime_type": "audio/mp4",
  "derived": {
    "transcript_key": "ingest/ing_xxx/transcript.vtt",
    "duration_seconds": 3720,
    "language": "en",
    "model": "whisper-small.en"
  }
}
```

The workflow job gets multiple `resource_refs`: the original file plus the derived transcript.

**Transcription worker** — Could be:
- A dedicated k8s deployment with ffmpeg + whisper
- A special job type processed by the existing worker with media tools
- An external API call (Groq Whisper, OpenAI Whisper)

**Database** — `ingest_records` gains `derived_json` column for processing results.

**API** — New endpoint or expanded confirm flow that waits for pre-processing.

### Pros

1. **Agent simplicity** — Agents receive text transcripts. No CLI tools needed, no prompt engineering for tool usage
2. **Caching** — Platform can cache transcripts by content hash. Same file uploaded twice skips transcription
3. **Quality control** — Platform picks the best model/provider. Can route to GPU, external API, or local CPU based on file size
4. **No image bloat** — Transcription runs in a dedicated container or external service, not in every worker/agent-runtime pod
5. **Deterministic** — Same file always produces the same transcript (no agent variability)
6. **Parallel processing** — Platform can transcribe while the agent workspace is being set up

### Cons

1. **Significant platform complexity** — New processing stage, new job type or service, new database fields, new API surface
2. **Rigid pipeline** — Platform decides how to process each type. What if an agent needs the raw audio for speaker diarization? What if a vision model should see the video frames?
3. **Latency** — Pre-processing adds time before the agent starts. A 60-minute recording blocks the workflow for 60+ minutes of transcription
4. **Cost opacity** — Transcription costs hidden from the workflow author. Hard to budget or control
5. **Format assumptions** — Platform must decide: VTT or SRT? What language? Which model? These are decisions the workflow author should make
6. **Maintenance burden** — Another service to deploy, monitor, and scale. GPU provisioning for fast transcription
7. **Violates Eve philosophy** — Platform doing intelligent work that should be agent-driven. The whole point of Eve is that agents do the processing

## Option C: Hybrid (Recommended)

Install the tools in the image (Option A) but also provide a reusable workflow template and agent pack that handles common cases. The platform provides capabilities; workflows compose them.

### Why Hybrid

The two options aren't really competing — they're different layers:

| Layer | Responsibility | Owner |
|-------|---------------|-------|
| **Image capabilities** | ffmpeg, whisper-cli available in PATH | Platform (Dockerfile) |
| **Workflow composition** | When/how to use the tools | Manifest author |
| **Agent intelligence** | What to do with the output | Agent pack / prompt |

Option A is the foundation. Option B is premature optimization that can be added later if needed. The hybrid approach ships A now and leaves the door open for B-style caching/routing later.

### What to Build

**Phase 1: Image capabilities** (small, immediate)

Add ffmpeg and whisper.cpp to the worker and agent-runtime Dockerfiles:

```dockerfile
# New stage: media (add to worker Dockerfile multi-target pattern)
FROM base AS media
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp /tmp/whisper-build \
    && cd /tmp/whisper-build && make -j$(nproc) \
    && cp main /usr/local/bin/whisper-cli \
    && mkdir -p /opt/whisper/models \
    && curl -L -o /opt/whisper/models/ggml-small.en.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin \
    && rm -rf /tmp/whisper-build
USER node
```

The `full` and `production` stages inherit from `media`. Size impact: ~235 MB.

For the agent-runtime, add the same packages in its Dockerfile's production stage.

**Phase 2: CLI mime inference** (trivial)

Expand `inferMimeType` in the CLI to cover all common audio/video formats:

```typescript
// Audio
case 'mp3': return 'audio/mpeg';
case 'wav': return 'audio/wav';
case 'm4a': return 'audio/mp4';
case 'ogg': return 'audio/ogg';
case 'opus': return 'audio/opus';
case 'flac': return 'audio/flac';
case 'aac': return 'audio/aac';
case 'wma': return 'audio/x-ms-wma';
case 'webm': return 'video/webm'; // webm can be audio-only but mime is video/webm
// Video
case 'mp4': return 'video/mp4';
case 'mkv': return 'video/x-matroska';
case 'mov': return 'video/quicktime';
case 'avi': return 'video/x-msvideo';
case 'wmv': return 'video/x-ms-wmv';
case 'ts': return 'video/mp2t';
```

**Phase 3: Workflow template** (agent pack)

Ship a reference `process-document` workflow that handles media:

```yaml
workflows:
  process-document:
    trigger:
      system:
        event: doc.ingest
    hints:
      gates: []
    steps:
      - agent:
          prompt: |
            You are a document processing agent. A file has been ingested
            and placed in your workspace under .eve/resources/.

            ## Instructions
            1. Find the ingested file (check .eve/resources/index.json)
            2. Determine the file type from the extension and MIME type
            3. Process according to type:

            ### Audio files (wav, mp3, m4a, ogg, flac, opus)
            - Transcribe using: whisper-cli -m /opt/whisper/models/ggml-small.en.bin -f <file> -ovtt
            - Read the resulting .vtt file
            - Summarize the spoken content with key points

            ### Video files (mp4, mkv, mov, avi, webm)
            - Extract audio: ffmpeg -i <file> -vn -acodec pcm_s16le -ar 16000 /tmp/extracted.wav
            - Transcribe the extracted audio using whisper-cli
            - Summarize the spoken content with key points

            ### Text documents (md, txt, json, yaml, csv, html, xml)
            - Read the file directly
            - Summarize content and extract key points

            ### PDF documents
            - If pdftotext is available, extract text first
            - Otherwise describe what you can determine from the file

            4. Write your analysis as a structured summary
```

**Phase 4: Smart routing (future, if needed)**

If transcription latency or cost becomes a problem:
- Add a `pre_process` step to workflow definitions
- Platform runs ffmpeg/whisper before dispatching to the agent
- Cache transcripts by content hash
- Route to GPU workers or external APIs for large files

This is pure optimization — only build it when there's evidence the simpler approach is insufficient.

### Decision Matrix

| Factor | A: Agent Tools | B: Pre-Process | C: Hybrid |
|--------|---------------|----------------|-----------|
| Time to ship | 1-2 days | 1-2 weeks | 1-2 days |
| Platform complexity | None | High | None |
| Image size | +235 MB | No change | +235 MB |
| Agent complexity | Medium | Low | Low (template) |
| Flexibility | High | Low | High |
| Caching | No | Yes | Later |
| Observability | Full | Partial | Full |
| Eve philosophy | Aligned | Misaligned | Aligned |
| Future-proof | Yes | Yes | Yes |

### Recommendation

**Ship Option C (Hybrid).** Concretely:

1. Add ffmpeg + whisper.cpp to Docker images (both worker and agent-runtime)
2. Expand CLI mime inference for all audio/video formats
3. Ship a reference workflow template that demonstrates media processing
4. Add media processing to manual test scenario 30

Don't build a pre-processing pipeline. The agent-with-tools approach is simpler, more flexible, fully observable, and aligns with Eve's core philosophy that agents do the intelligent work. If transcription latency proves to be a real problem for real users, we can add platform-level caching later without changing the agent-facing contract.

### What This Doesn't Solve

- **GPU acceleration** — whisper.cpp on CPU is ~real-time for small model. For large files or higher quality, you'd need GPU workers or an external API (Groq, OpenAI). This is an infrastructure scaling decision, not an architecture one.
- **Speaker diarization** — Whisper doesn't identify speakers. Would need pyannote or similar. Future agent pack territory.
- **Real-time streaming** — This is batch processing (file in, transcript out). Live transcription is a different problem entirely.
- **Non-English** — The small.en model is English-only. For multilingual support, use the larger `ggml-small` model (+12 MB, slightly slower) or an API provider.
