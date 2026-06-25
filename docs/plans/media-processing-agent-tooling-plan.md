# Media Processing: Agent Tooling Plan

> **Status**: Plan (ready to build)
> **Date**: 2026-03-05
> **Distilled from**: [media-processing-architecture.md](../ideas/media-processing-architecture.md)
> **Depends on**: Document ingestion MVP (complete)
> **Scope**: Install ffmpeg + whisper.cpp in Docker images, expand CLI mime types, ship reference workflow, verify with manual test loop

## Goal

Give agents the ability to process audio and video files. After this work, an ingested MP3, M4A, MP4, or any other media file will be transcribed and analyzed by the agent — no platform pre-processing pipeline, no external APIs required.

The approach: install tools in the container, let the agent decide when and how to use them.

## Non-Goals

- Platform pre-processing pipeline (transcribe before agent sees file)
- GPU acceleration for whisper (CPU is sufficient for MVP)
- Speaker diarization (pyannote or similar)
- Real-time / streaming transcription
- External transcription APIs (Groq, OpenAI Whisper)
- Embeddings or vector search on transcripts
- Non-English models (ship English-only small model; multilingual is a config change later)

## Ground Truth on Events

- Document ingestion events are `system.doc.ingest`.
- In workflow YAML, match with `trigger.system.event: doc.ingest` (current matching strips the `system.` prefix).

## Ground Truth on whisper.cpp

- **Repository**: `https://github.com/ggml-org/whisper.cpp` (migrated from `ggerganov/whisper.cpp`)
- **Build system**: CMake (not plain Make — the Makefile is deprecated)
- **Binary**: `whisper-cli` (built at `./build/bin/whisper-cli`)
- **Stable tag**: `v1.8.1` — pin to this for reproducibility
- **Model URL**: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin` (HuggingFace URL unchanged)

## Architecture

```
eve ingest meeting.mp4
       │
       ▼
S3: ingest/{id}/meeting.mp4
       │
       ▼
system.doc.ingest event (mime_type: video/mp4)
       │
       ▼
Workflow: process-document
       │
       ▼
Agent-runtime hydrates file into workspace
       │
       ▼
Agent (in container with ffmpeg + whisper-cli):
  1. Reads .eve/resources/index.json
  2. Sees video/mp4 → extracts audio:
     ffmpeg -i meeting.mp4 -vn -acodec pcm_s16le -ac 1 -ar 16000 /tmp/audio.wav
  3. Transcribes:
     whisper-cli -m /opt/whisper/models/ggml-small.en.bin -f /tmp/audio.wav -ovtt
  4. Reads transcript.vtt, analyzes content
  5. Writes summary to org docs
```

## Phases

### Phase 1: Docker Image — ffmpeg + whisper.cpp

Add media tools to both worker and agent-runtime images.

#### 1a. Worker Dockerfile — New `media` Stage

The worker Dockerfile already has a multi-target pattern: `base → python → rust → java → full`. Add `media` as a new foundation that `full` inherits from.

**File**: `apps/worker/Dockerfile`

Insert a new stage between `base` and `python`:

```dockerfile
# =============================================================================
# Stage: media
# Purpose: Runtime with ffmpeg + whisper.cpp for audio/video processing
# =============================================================================
FROM base AS media

USER root

# ffmpeg: universal audio/video demuxing, decoding, conversion
# cmake + g++: build whisper.cpp from source
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg cmake make g++ \
    && rm -rf /var/lib/apt/lists/*

# whisper.cpp v1.8.1: CPU-based speech-to-text (pinned for reproducibility)
RUN git clone --depth 1 --branch v1.8.1 https://github.com/ggml-org/whisper.cpp /tmp/whisper-build \
    && cd /tmp/whisper-build \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF \
    && cmake --build build -j$(nproc) --target whisper-cli \
    && cp build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && mkdir -p /opt/whisper/models \
    && rm -rf /tmp/whisper-build

# Download small.en model (~150 MB, English-only, good speed/quality balance)
RUN curl -L -o /opt/whisper/models/ggml-small.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin

# Clean up build tools (keep ffmpeg runtime)
RUN apt-get purge -y --auto-remove cmake g++ \
    && rm -rf /var/lib/apt/lists/*

USER node
```

Update the `full` stage to inherit media tools. Currently `full` inherits from `base` — change it to inherit from `media`:

```dockerfile
# Before:
FROM base AS full
# After:
FROM media AS full
```

This gives `full` (and `production`) ffmpeg + whisper automatically. The `base` target stays lean for users who don't need media processing.

**Size impact**: ~235 MB (ffmpeg ~80 MB, whisper binary ~5 MB, ggml-small.en ~150 MB).

#### 1b. Agent-Runtime Dockerfile — Add ffmpeg + whisper

The agent-runtime Dockerfile is simpler (no multi-target). The existing `production` stage has one large `RUN` that installs packages and then purges `curl` at the end. We must add media tools **within that same RUN** (before the curl purge) so that `git clone` and model download succeed.

**File**: `apps/agent-runtime/Dockerfile`

In the `production` stage, modify the existing `RUN` to insert media tool installation before the final `apt-get purge` line. Add these lines after the `chown -R node:node /home/node` and before `apt-get purge -y --auto-remove curl`:

```dockerfile
    # --- Media processing tools (ffmpeg + whisper.cpp) ---
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg cmake make g++ \
    && git clone --depth 1 --branch v1.8.1 https://github.com/ggml-org/whisper.cpp /tmp/whisper-build \
    && cd /tmp/whisper-build \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF \
    && cmake --build build -j$(nproc) --target whisper-cli \
    && cp build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && mkdir -p /opt/whisper/models \
    && curl -L -o /opt/whisper/models/ggml-small.en.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin \
    && rm -rf /tmp/whisper-build \
    && apt-get purge -y --auto-remove cmake g++ \
```

**Why inside the same RUN?** The existing RUN installs `curl` and `git` at the start and purges `curl` at the end. A separate RUN block after this would not have `curl` or `git` available. Integrating within the existing RUN keeps everything in one layer and avoids re-installing packages.

#### 1c. Verify Tools Available in Containers

After building images and deploying to k3d:

```bash
# Worker
kubectl -n eve exec deployment/eve-worker -- ffmpeg -version | head -1
kubectl -n eve exec deployment/eve-worker -- whisper-cli --help 2>&1 | head -3
kubectl -n eve exec deployment/eve-worker -- ls -la /opt/whisper/models/

# Agent-runtime
kubectl -n eve exec eve-agent-runtime-0 -- ffmpeg -version | head -1
kubectl -n eve exec eve-agent-runtime-0 -- whisper-cli --help 2>&1 | head -3
kubectl -n eve exec eve-agent-runtime-0 -- ls -la /opt/whisper/models/
```

**Acceptance**: Both services report ffmpeg and whisper-cli versions. Model file exists at `/opt/whisper/models/ggml-small.en.bin` (~150 MB).

### Phase 2: CLI Mime Type Expansion

Expand `inferMimeType` in the CLI to cover all common audio and video formats so the ingest record gets the correct MIME type.

**File**: `packages/cli/src/commands/ingest.ts`

Replace the existing `inferMimeType` function:

```typescript
function inferMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    // Text
    case 'md': return 'text/markdown';
    case 'txt': return 'text/plain';
    case 'csv': return 'text/csv';
    case 'html':
    case 'htm': return 'text/html';
    // Structured data
    case 'json': return 'application/json';
    case 'yaml':
    case 'yml': return 'application/yaml';
    case 'xml': return 'application/xml';
    // Documents
    case 'pdf': return 'application/pdf';
    case 'doc': return 'application/msword';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'rtf': return 'application/rtf';
    // Images
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'tiff':
    case 'tif': return 'image/tiff';
    // Audio
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'm4a': return 'audio/mp4';
    case 'aac': return 'audio/aac';
    case 'ogg': return 'audio/ogg';
    case 'opus': return 'audio/opus';
    case 'flac': return 'audio/flac';
    case 'wma': return 'audio/x-ms-wma';
    case 'amr': return 'audio/amr';
    case 'm4b': return 'audio/mp4';
    case 'm4r': return 'audio/mp4';
    case 'oga': return 'audio/ogg';
    // Video
    case 'mp4': return 'video/mp4';
    case 'mkv': return 'video/x-matroska';
    case 'mov': return 'video/quicktime';
    case 'avi': return 'video/x-msvideo';
    case 'wmv': return 'video/x-ms-wmv';
    case 'webm': return 'video/webm';
    case 'flv': return 'video/x-flv';
    case 'm4v': return 'video/x-m4v';
    case 'mpeg': return 'video/mpeg';
    case 'mpg': return 'video/mpeg';
    case '3gp': return 'video/3gpp';
    case 'ogv': return 'video/ogg';
    default: return 'application/octet-stream';
  }
}
```

**Note**: `.ts` is intentionally omitted — it collides with TypeScript files, and MPEG-TS containers are rare in ingestion workflows. If needed, users can pass `--mime-type video/mp2t` explicitly.

**Acceptance**: `eve ingest meeting.m4a` sets `mime_type: audio/mp4`, `eve ingest video.mkv` sets `mime_type: video/x-matroska`.

### Phase 3: Reference Workflow with Media Instructions

Update the manual test workflow template to instruct the agent on media processing. This also serves as the reference implementation for anyone defining their own ingest workflows.

The workflow prompt teaches the agent the exact commands for each file type. The agent reads the resource index, inspects the MIME type, and runs the appropriate tool chain.

**No code changes** — this is a manifest YAML definition synced via the existing `POST /projects/:id/manifest` API. The workflow template is documented in the manual test scenario and can be adapted by any project.

Example workflow prompt (for manual test scenario 30):

```
You are a document processing agent. A file has been ingested into your workspace.

## Steps
1. Read .eve/resources/index.json to find the ingested file path and label
2. Determine the MIME type from `.eve/resources/index.json` (or fall back to extension)
3. Process based on type:

### Audio (wav, mp3, m4a, ogg, flac, opus, aac, amr, wma)
Run: whisper-cli -m /opt/whisper/models/ggml-small.en.bin -f <file> -ovtt
Read the resulting .vtt transcript.
Summarize the spoken content with key points and timestamps.

### Video (mp4, mkv, mov, avi, webm, wmv, flv)
Extract audio: ffmpeg -i <file> -vn -acodec pcm_s16le -ar 16000 /tmp/audio.wav
Transcribe: whisper-cli -m /opt/whisper/models/ggml-small.en.bin -f /tmp/audio.wav -ovtt
Read the transcript. Summarize with key points and timestamps.

### Text (md, txt, json, yaml, csv, html, xml)
Read the file directly. Summarize and extract key points.

### Documents (pdf, doc, docx)
Read the file. If PDF is unreadable, try: pdftotext <file> /tmp/extracted.txt
Summarize and extract key points.

4. Write your analysis summary.
```

**Acceptance**: Ingested audio file triggers workflow, agent runs whisper-cli, produces transcript-based summary. Ingested video file triggers workflow, agent runs ffmpeg then whisper-cli, produces summary.

### Phase 4: Verification Loop (Manual Test Scenario 30)

Update scenario 30 with a full verification loop that tests the pipeline end-to-end with multiple file types. This phase is both the test plan and the acceptance gate — all phases 1-3 must pass before the work is considered done.

**File**: `tests/manual/scenarios/30-document-ingestion-mvp.md`

Add Phase 5 after the existing Phase 4 (audio file ingestion).

#### 5a. Tool availability smoke test

Before ingesting files that need media processing, verify the tools are actually present in the running pods. This catches image build issues early.

```bash
echo "=== Tool Availability Check ==="

# Check agent-runtime (where ingest jobs run)
echo "--- agent-runtime ---"
kubectl -n eve exec eve-agent-runtime-0 -- ffmpeg -version 2>&1 | head -1
kubectl -n eve exec eve-agent-runtime-0 -- whisper-cli --help 2>&1 | head -1
kubectl -n eve exec eve-agent-runtime-0 -- test -f /opt/whisper/models/ggml-small.en.bin \
  && echo "Model: OK" || echo "Model: MISSING"

# Check worker (fallback execution path)
echo "--- worker ---"
kubectl -n eve exec deployment/eve-worker -- ffmpeg -version 2>&1 | head -1
kubectl -n eve exec deployment/eve-worker -- whisper-cli --help 2>&1 | head -1
kubectl -n eve exec deployment/eve-worker -- test -f /opt/whisper/models/ggml-small.en.bin \
  && echo "Model: OK" || echo "Model: MISSING"
```

**Expected**: Both pods report ffmpeg version, whisper-cli usage, and model file present. If any are missing, stop — Phase 1 image build is incomplete.

#### 5b. Generate test input files

Create a set of test files covering the three main categories: text, audio, and video. These are generated locally and ingested one at a time.

```bash
echo "=== Generating Test Files ==="

# 1. Text file — a structured markdown document
cat > /tmp/scenario-30-text.md <<'DOCEOF'
# Quarterly Review Notes

## Revenue
- Q4 revenue up 12% year-over-year
- Subscription ARR crossed $5M milestone

## Product
- Shipped v2.0 with media processing support
- Agent runtime latency reduced by 40%

## Action Items
- Finalize pricing for enterprise tier
- Hire two more SREs for scaling work
DOCEOF
echo "Text file: $(wc -c < /tmp/scenario-30-text.md) bytes"

# 2. Audio file — a short WAV with a tone (whisper will produce empty/noise transcript, that's fine)
if command -v sox &>/dev/null; then
  sox -n -r 16000 -c 1 /tmp/scenario-30-audio.wav synth 3 sine 440
  echo "Audio file (sox): $(wc -c < /tmp/scenario-30-audio.wav) bytes"
else
  python3 -c "
import struct, sys
sr, dur, ch = 16000, 3, 1
n = sr * dur * ch
data_size = n * 2
sys.stdout.buffer.write(b'RIFF')
sys.stdout.buffer.write(struct.pack('<I', 36 + data_size))
sys.stdout.buffer.write(b'WAVEfmt ')
sys.stdout.buffer.write(struct.pack('<IHHIIHH', 16, 1, ch, sr, sr*ch*2, ch*2, 16))
sys.stdout.buffer.write(b'data')
sys.stdout.buffer.write(struct.pack('<I', data_size))
sys.stdout.buffer.write(b'\x00' * data_size)
" > /tmp/scenario-30-audio.wav
  echo "Audio file (python): $(wc -c < /tmp/scenario-30-audio.wav) bytes"
fi

# 3. Video file — minimal MP4 with audio track (requires ffmpeg on host)
if command -v ffmpeg &>/dev/null; then
  ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3" \
    -f lavfi -i "color=black:s=320x240:d=3" \
    -c:v libx264 -c:a aac -shortest \
    /tmp/scenario-30-video.mp4 2>/dev/null
  echo "Video file: $(wc -c < /tmp/scenario-30-video.mp4) bytes"
else
  echo "SKIP: ffmpeg not on host, cannot generate test MP4"
  echo "  Install ffmpeg locally or provide /tmp/scenario-30-video.mp4 manually"
fi
```

#### 5c. Ingest text file and verify

```bash
echo "=== Test 1: Text Document ==="
eve ingest /tmp/scenario-30-text.md --project "$PROJECT_ID" --json | tee /tmp/ingest-text.json
TEXT_INGEST_ID=$(jq -r '.ingest_id' /tmp/ingest-text.json)

for i in $(seq 1 12); do
  TEXT_JOB_ID=$(eve ingest show "$TEXT_INGEST_ID" --project "$PROJECT_ID" --json | jq -r '.job_id // empty')
  [ -n "$TEXT_JOB_ID" ] && break
  sleep 5
done
echo "Text job: $TEXT_JOB_ID"

if [ -n "$TEXT_JOB_ID" ]; then
  eve job wait "$TEXT_JOB_ID" --timeout 120
  TEXT_PHASE=$(eve job show "$TEXT_JOB_ID" --json | jq -r '.phase')
  echo "Text result: phase=$TEXT_PHASE"
fi
```

**Expected**: Job completes with `phase: "done"`. Agent reads the markdown directly and summarizes.

#### 5d. Ingest audio file and verify

```bash
echo "=== Test 2: Audio File (WAV) ==="
eve ingest /tmp/scenario-30-audio.wav --project "$PROJECT_ID" --json | tee /tmp/ingest-audio.json
AUDIO_INGEST_ID=$(jq -r '.ingest_id' /tmp/ingest-audio.json)

for i in $(seq 1 24); do
  AUDIO_JOB_ID=$(eve ingest show "$AUDIO_INGEST_ID" --project "$PROJECT_ID" --json | jq -r '.job_id // empty')
  [ -n "$AUDIO_JOB_ID" ] && break
  sleep 5
done
echo "Audio job: $AUDIO_JOB_ID"

if [ -n "$AUDIO_JOB_ID" ]; then
  eve job wait "$AUDIO_JOB_ID" --timeout 300
  AUDIO_PHASE=$(eve job show "$AUDIO_JOB_ID" --json | jq -r '.phase')
  echo "Audio result: phase=$AUDIO_PHASE"

  # Check job logs for whisper-cli invocation
  eve job logs "$AUDIO_JOB_ID" 2>&1 | grep -c "whisper-cli" && echo "whisper-cli: INVOKED" || echo "whisper-cli: NOT FOUND in logs"
fi
```

**Expected**: Job completes with `phase: "done"`. Job logs contain `whisper-cli` invocation. Agent produces transcript-based output (even if the tone generates no real speech content, the agent should report that).

#### 5e. Ingest video file and verify

```bash
if [ -f /tmp/scenario-30-video.mp4 ]; then
  echo "=== Test 3: Video File (MP4) ==="
  eve ingest /tmp/scenario-30-video.mp4 --project "$PROJECT_ID" --json | tee /tmp/ingest-video.json
  VIDEO_INGEST_ID=$(jq -r '.ingest_id' /tmp/ingest-video.json)

  for i in $(seq 1 24); do
    VIDEO_JOB_ID=$(eve ingest show "$VIDEO_INGEST_ID" --project "$PROJECT_ID" --json | jq -r '.job_id // empty')
    [ -n "$VIDEO_JOB_ID" ] && break
    sleep 5
  done
  echo "Video job: $VIDEO_JOB_ID"

  if [ -n "$VIDEO_JOB_ID" ]; then
    eve job wait "$VIDEO_JOB_ID" --timeout 300
    VIDEO_PHASE=$(eve job show "$VIDEO_JOB_ID" --json | jq -r '.phase')
    echo "Video result: phase=$VIDEO_PHASE"

    # Check job logs for ffmpeg + whisper-cli
    LOGS=$(eve job logs "$VIDEO_JOB_ID" 2>&1)
    echo "$LOGS" | grep -c "ffmpeg" && echo "ffmpeg: INVOKED" || echo "ffmpeg: NOT FOUND in logs"
    echo "$LOGS" | grep -c "whisper-cli" && echo "whisper-cli: INVOKED" || echo "whisper-cli: NOT FOUND in logs"
  fi
else
  echo "=== SKIP Test 3: No MP4 file (install ffmpeg locally to generate) ==="
fi
```

**Expected**: Job completes with `phase: "done"`. Job logs show `ffmpeg` extracting audio, then `whisper-cli` transcribing. Agent produces a summary.

#### 5f. Verification summary

```bash
echo ""
echo "=== VERIFICATION SUMMARY ==="
echo "Text  (md):  ${TEXT_PHASE:-SKIPPED}"
echo "Audio (wav): ${AUDIO_PHASE:-SKIPPED}"
echo "Video (mp4): ${VIDEO_PHASE:-SKIPPED}"
echo ""

# Check ingest record final statuses
for ID_VAR in TEXT_INGEST_ID AUDIO_INGEST_ID VIDEO_INGEST_ID; do
  ID="${!ID_VAR}"
  if [ -n "$ID" ]; then
    STATUS=$(eve ingest show "$ID" --project "$PROJECT_ID" --json | jq -r '.status')
    echo "Ingest $ID_VAR ($ID): status=$STATUS"
  fi
done

echo ""
echo "All tests should show phase=done and status=done."
echo "If audio/video jobs show phase=done but logs don't mention whisper-cli/ffmpeg,"
echo "the agent may have fallen back to text-only processing (tools not in image)."
```

#### 5g. Cleanup

```bash
rm -f /tmp/scenario-30-text.md /tmp/scenario-30-audio.wav /tmp/scenario-30-video.mp4
rm -f /tmp/ingest-text.json /tmp/ingest-audio.json /tmp/ingest-video.json
```

### Phase 5 (Post-Verification): Success Criteria Update

Update the success criteria section of scenario 30 to include media processing:

```
- [ ] ffmpeg is available in agent-runtime pods
- [ ] whisper-cli is available in agent-runtime pods
- [ ] whisper model exists at /opt/whisper/models/ggml-small.en.bin
- [ ] Text file (md) → agent reads directly → produces summary → phase=done, status=done
- [ ] Audio file (wav) → agent runs whisper-cli → produces transcript output → phase=done, status=done
- [ ] Video file (mp4) → agent runs ffmpeg + whisper-cli → produces summary → phase=done, status=done
- [ ] Job logs contain evidence of tool invocation (whisper-cli, ffmpeg)
- [ ] Ingest records transition to status=done with completed_at set
```

## File Change Summary

| File | Change |
|------|--------|
| `apps/worker/Dockerfile` | Add `media` stage (ffmpeg + whisper.cpp v1.8.1 via CMake + model). Change `full` to inherit from `media` |
| `apps/agent-runtime/Dockerfile` | Add ffmpeg + whisper.cpp v1.8.1 via CMake + model into existing `production` RUN block |
| `packages/cli/src/commands/ingest.ts` | Expand `inferMimeType` with audio/video formats (omit `.ts` to avoid TypeScript collision) |
| `tests/manual/scenarios/30-document-ingestion-mvp.md` | Add Phase 5: tool smoke test + text/audio/video verification loop + summary |

## Performance Notes

Whisper.cpp transcription speed on CPU (small.en model):

| Input Duration | Transcription Time | Notes |
|---------------|-------------------|-------|
| 10 seconds | ~5 seconds | Faster than real-time |
| 1 minute | ~30 seconds | Roughly 2x real-time |
| 10 minutes | ~5 minutes | Roughly 2x real-time |
| 60 minutes | ~30 minutes | May hit job timeouts |

For files over ~30 minutes, use the async flow and poll `eve ingest show` rather than short `job wait` timeouts.

## Future Enhancements (Not In Scope)

| Enhancement | Trigger |
|-------------|---------|
| Multilingual model (ggml-small) | First non-English user request |
| Larger model (ggml-medium/large) | Quality complaints with small.en |
| GPU worker variant | Transcription latency > 10x real-time on CPU |
| Platform transcript cache | Same file re-uploaded frequently |
| External API provider (Groq/OpenAI Whisper) | Need for speed without GPU |
| Speaker diarization | Meeting transcript use case |
| Subtitle / caption generation | Video publishing use case |

These are all additive — none require changing the architecture. The agent-side tooling approach scales by swapping models, adding tools, or routing to faster backends.

## Risks

| Risk | Mitigation |
|------|-----------:|
| Image size +235 MB | Acceptable for worker images (~1.8 GB → ~2 GB). Monitor CI build times |
| whisper.cpp build breaks on new base image | Pinned to v1.8.1 tag. Bump deliberately when needed |
| CMake not available in slim image | Installed as build dep, purged after compilation |
| Agent uses wrong whisper flags | Workflow prompt is explicit. Agent has bash to inspect `--help` |
| Long audio exceeds job timeout | Async mode has no timeout. Document the limitation |
| Model download fails during image build | Cache the model file in CI or use a mirror |
| `.ts` extension collision (TypeScript vs MPEG-TS) | Omitted from MIME map; users pass `--mime-type` for MPEG-TS |
