# Scenario 30: Document Ingestion MVP

**Time:** ~15 minutes
**Parallel Safe:** No
**LLM Required:** Yes

End-to-end validation of document ingestion: CLI upload, presigned URL transport, workflow trigger matching, resource hydration (ingest:// from S3/MinIO), agent processing, and completion callback. Tests text documents, PDF files (Claude-native reading), audio files, and video files including media tool invocation (ffmpeg + whisper-cli).

## What This Tests

| Capability | Verified By |
|-----------|-------------|
| `eve ingest` CLI (upload + confirm) | Phase 1 |
| Presigned URL upload to MinIO/S3 | Phase 1 |
| `eve ingest list` and `eve ingest show` | Phase 1 |
| Pack resolution via `eve agents sync` | Phase 2 |
| Workflow trigger `doc.ingest` from pack | Phase 2 |
| Event routing → workflow → job creation | Phase 2 |
| `resource_refs` injection from event payload | Phase 3 |
| `ingest://` S3 hydration in agent-runtime | Phase 3 |
| Job completion → ingest record status callback | Phase 3 |
| PDF ingestion (Claude-native reading, no tools) | Phase 4 |
| `mime_type` and `metadata` in resource index | Phase 4 |
| Audio file ingestion (binary transport) | Phase 5 |
| Confirm idempotency on replay | Phase 1 |
| ffmpeg + whisper-cli tool availability in pods | Phase 6 |
| Audio transcription via whisper-cli | Phase 6 |
| Video → audio extraction → transcription pipeline | Phase 6 |

## Prerequisites

- Local k3d stack running (`./bin/eh k8s deploy`)
- `export EVE_API_URL=http://api.eve.lvh.me`
- Authenticated: `eve auth login --email admin@example.com --ssh-key ~/.ssh/id_ed25519`
- Secrets imported: `eve secrets import --org org_manualtestorg --file ./manual-tests.secrets`
- `jq` installed

## Setup

```bash
export EVE_API_URL=${EVE_API_URL:-http://api.eve.lvh.me}
export ORG_ID=${ORG_ID:-org_manualtestorg}

# Ensure test project
PROJECT_ID=$(eve project ensure \
  --org "$ORG_ID" \
  --name "doc-ingest-test" \
  --slug dingest \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json | jq -r '.id')

echo "Project: $PROJECT_ID"

# Auth token for raw API calls
TOKEN=$(eve auth token --raw)
api() {
  curl -sf -H "Authorization: Bearer $TOKEN" "$@"
}
```

## Phase 1: CLI Upload and Record Lifecycle

Tests the `eve ingest` CLI command for creating, uploading, and confirming ingestion records.

### 1a) Ingest a markdown file via CLI

```bash
# Create a test document
cat > /tmp/scenario-30-test.md <<'DOCEOF'
# Test Document for Ingestion

This document validates the Eve document ingestion pipeline.

## Key Points
- Presigned URL upload works
- Event fires on confirm
- Workflow trigger matches
DOCEOF

# Ingest via CLI (creates record, uploads, confirms in one step)
eve ingest /tmp/scenario-30-test.md --project "$PROJECT_ID" --json | tee /tmp/ingest-md-result.json

INGEST_MD_ID=$(jq -r '.ingest_id' /tmp/ingest-md-result.json)
echo "Markdown ingest ID: $INGEST_MD_ID"
```

**Expected:**
- Returns JSON with `ingest_id`, `status`, `file_name: "scenario-30-test.md"`
- `status` is `processing` (event fired, waiting for workflow) or `confirmed` (no workflow matched)

### 1b) Verify CLI list and show

```bash
# List all ingest records for this project
eve ingest list --project "$PROJECT_ID" --json | tee /tmp/ingest-list.json
echo "Total records: $(jq '.data | length' /tmp/ingest-list.json)"

# Show specific record
eve ingest show "$INGEST_MD_ID" --project "$PROJECT_ID" --json | tee /tmp/ingest-show.json
jq '{id, file_name, mime_type, status, event_id}' /tmp/ingest-show.json
```

**Expected:**
- List includes the just-created record
- Show returns full record with `event_id` populated

### 1c) Verify confirm idempotency via API

```bash
# Replay confirm — should return same status, not create duplicate events
confirm_resp=$(api -X POST "$EVE_API_URL/projects/$PROJECT_ID/ingest/$INGEST_MD_ID/confirm")
echo "$confirm_resp" | jq '{status, event_id, job_id}'
```

**Expected:**
- Status unchanged from initial confirm
- No duplicate event or job created

## Phase 2: Pack Resolution and Agent Sync

Syncs the `ingest-agentpack` pack which provides the `doc_processor` agent, `doc-processor` skill, `process-document` workflow (with `doc.ingest` trigger), and harness profiles.

### 2a) Clone the ingest-agentpack

```bash
PACK_DIR=${PACK_DIR:-/tmp/ingest-agentpack}
if [ ! -d "$PACK_DIR" ]; then
  git clone https://github.com/eve-horizon/ingest-agentpack.git "$PACK_DIR"
fi
echo "Pack dir: $PACK_DIR"
ls "$PACK_DIR/eve/"
```

**Expected:**
- Pack cloned with `eve/pack.yaml`, `eve/agents.yaml`, `eve/workflows.yaml`, `eve/x-eve.yaml`
- `skills/doc-processor/SKILL.md` present

### 2b) Sync agents and workflow from pack

```bash
eve agents sync \
  --project "$PROJECT_ID" \
  --local \
  --repo-dir "$PACK_DIR" \
  --allow-dirty \
  --json | jq .

# Verify workflow is registered
eve workflow list --project "$PROJECT_ID" --json | jq '.data[] | {name, definition}'
```

**Expected:**
- Agents sync returns success with `doc_processor` agent
- Workflows synced to manifest
- `process-document` workflow listed with `trigger.system.event: doc.ingest`

## Phase 3: End-to-End Document Ingestion with Workflow

### 3a) Ingest a document (triggers workflow)

```bash
cat > /tmp/scenario-30-workflow.md <<'DOCEOF'
# Architecture Decision Record: Event-Driven Ingestion

## Context
We need a document ingestion pipeline that handles multiple file types.

## Decision
Use presigned URLs for upload, S3 for storage, and workflow triggers for processing.

## Consequences
- Agents receive files via resource_refs hydration
- No binary proxying through the API
- Supports arbitrarily large files
DOCEOF

eve ingest /tmp/scenario-30-workflow.md --project "$PROJECT_ID" --json | tee /tmp/ingest-wf-result.json

INGEST_WF_ID=$(jq -r '.ingest_id' /tmp/ingest-wf-result.json)
echo "Workflow ingest ID: $INGEST_WF_ID"
```

**Expected:**
- Returns `status: "processing"` and `event_id` populated

### 3b) Wait for the processing job

```bash
# Poll for job creation (orchestrator picks up event within ~5s)
for i in $(seq 1 12); do
  JOB_ID=$(eve ingest show "$INGEST_WF_ID" --project "$PROJECT_ID" --json | jq -r '.job_id // empty')
  [ -n "$JOB_ID" ] && break
  sleep 5
done

echo "Processing job: $JOB_ID"

# Wait for completion
if [ -n "$JOB_ID" ]; then
  eve job wait "$JOB_ID" --timeout 300
  eve job show "$JOB_ID" --json | jq '{id, phase, close_reason}'
fi
```

**Expected:**
- `job_id` appears on the ingest record within 60s
- Job completes with `phase: "done"`

### 3c) Verify resource hydration

```bash
if [ -n "$JOB_ID" ]; then
  eve job show "$JOB_ID" --verbose --json | \
    jq '.attempts[-1].runtime_meta.resource_hydration'
fi
```

**Expected:**
- `resolved_count: 1`, `failed_required_count: 0`
- Resource status: `"resolved"`
- `content_hash` starts with `sha256:`

### 3d) Verify ingest record completion callback

```bash
eve ingest show "$INGEST_WF_ID" --project "$PROJECT_ID" --json | \
  jq '{status, job_id, completed_at, error_message}'
```

**Expected:**
- `status: "done"`
- `job_id` matches the processing job
- `completed_at` is set
- `error_message` is null

## Phase 4: PDF Document Ingestion (Claude Native)

Tests PDF ingestion using Claude's native PDF reading capability — no conversion tools (pdftotext, poppler) needed. Verifies that `mime_type` and `metadata` flow through the resource index.

### 4a) Ingest the test PDF

```bash
# Use the fixture PDF from the repo
PDF_FILE="$(pwd)/tests/fixtures/files/knowledge-management-tool.pdf"
echo "PDF file: $(ls -la "$PDF_FILE" | awk '{print $5}') bytes"

eve ingest "$PDF_FILE" --project "$PROJECT_ID" --json | tee /tmp/ingest-pdf-result.json

INGEST_PDF_ID=$(jq -r '.ingest_id' /tmp/ingest-pdf-result.json)
echo "PDF ingest ID: $INGEST_PDF_ID"
```

**Expected:**
- Returns `ingest_id` and `status: "processing"`
- File detected as `application/pdf`

### 4b) Wait for PDF processing job

```bash
for i in $(seq 1 12); do
  PDF_JOB_ID=$(eve ingest show "$INGEST_PDF_ID" --project "$PROJECT_ID" --json | jq -r '.job_id // empty')
  [ -n "$PDF_JOB_ID" ] && break
  sleep 5
done

echo "PDF processing job: $PDF_JOB_ID"

if [ -n "$PDF_JOB_ID" ]; then
  eve job wait "$PDF_JOB_ID" --timeout 300
  eve job show "$PDF_JOB_ID" --json | jq '{id, phase, close_reason}'
fi
```

**Expected:**
- Job created and completes with `phase: "done"`

### 4c) Verify resource index includes mime_type and metadata

```bash
if [ -n "$PDF_JOB_ID" ]; then
  HYDRATION=$(eve job show "$PDF_JOB_ID" --verbose --json | \
    jq '.attempts[-1].runtime_meta.resource_hydration')
  echo "$HYDRATION" | jq '.resources[0] | {uri, mime_type, local_path, content_hash, status}'

  # Verify mime_type is present
  MIME=$(echo "$HYDRATION" | jq -r '.resources[0].mime_type // "MISSING"')
  echo "mime_type in index: $MIME"
  [ "$MIME" = "application/pdf" ] && echo "PASS: mime_type correct" || echo "FAIL: expected application/pdf"
fi
```

**Expected:**
- Resource `mime_type` is `"application/pdf"`
- Resource status is `"resolved"`
- `content_hash` starts with `sha256:`

### 4d) Verify PDF was processed natively (no pdftotext)

```bash
if [ -n "$PDF_JOB_ID" ]; then
  # Check job result for structured output
  eve job result "$PDF_JOB_ID" --json | jq '.resultJson.analysis.source'

  # Verify agent read the PDF natively (no pdftotext in logs)
  LOGS=$(eve job logs "$PDF_JOB_ID" 2>&1)
  echo "$LOGS" | grep -c "pdftotext" && echo "WARNING: pdftotext used (should be native)" || echo "PASS: no pdftotext (native PDF reading)"

  # Check that the agent extracted meaningful content
  SUMMARY=$(eve job result "$PDF_JOB_ID" --json | jq -r '.resultJson.eve.summary // .resultJson.analysis.summary // "NO SUMMARY"')
  echo "Agent summary: $SUMMARY"
fi
```

**Expected:**
- Agent produces structured analysis with `summary`, `key_facts`, etc.
- No `pdftotext` invocation in logs (Claude reads PDF natively)
- Summary contains substantive content from the PDF

### 4e) Verify PDF ingest record status

```bash
eve ingest show "$INGEST_PDF_ID" --project "$PROJECT_ID" --json | \
  jq '{status, job_id, completed_at, error_message}'
```

**Expected:**
- `status: "done"`
- `completed_at` set, `error_message` null

## Phase 5: Audio File Ingestion

Tests binary file transport and hydration with a non-text file.

### 5a) Create a test audio file

```bash
# Generate a short WAV file using sox (if available) or use a simple binary file
if command -v sox &>/dev/null; then
  # Generate 2 seconds of a 440Hz tone as WAV
  sox -n -r 16000 -c 1 /tmp/scenario-30-audio.wav synth 2 sine 440
  echo "Generated test WAV via sox"
else
  # Create a minimal valid WAV header + silence (44 bytes header + 32000 bytes of zeros)
  python3 -c "
import struct, sys
sr, dur, ch = 16000, 2, 1
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
  echo "Generated minimal WAV via python3"
fi

ls -la /tmp/scenario-30-audio.wav
```

### 5b) Ingest the audio file

```bash
eve ingest /tmp/scenario-30-audio.wav --project "$PROJECT_ID" --json | tee /tmp/ingest-audio-result.json

INGEST_AUDIO_ID=$(jq -r '.ingest_id' /tmp/ingest-audio-result.json)
AUDIO_MIME=$(jq -r '.mime_type // "unknown"' /tmp/ingest-audio-result.json 2>/dev/null)
echo "Audio ingest ID: $INGEST_AUDIO_ID (mime: audio/wav)"
```

**Expected:**
- Returns `ingest_id` and `status`
- File size matches the generated WAV

### 5c) Wait for audio processing job

```bash
for i in $(seq 1 12); do
  AUDIO_JOB_ID=$(eve ingest show "$INGEST_AUDIO_ID" --project "$PROJECT_ID" --json | jq -r '.job_id // empty')
  [ -n "$AUDIO_JOB_ID" ] && break
  sleep 5
done

echo "Audio processing job: $AUDIO_JOB_ID"

if [ -n "$AUDIO_JOB_ID" ]; then
  eve job wait "$AUDIO_JOB_ID" --timeout 300
  eve job show "$AUDIO_JOB_ID" --json | jq '{id, phase, close_reason}'
fi
```

**Expected:**
- Job created and completes with `phase: "done"`

### 5d) Verify audio resource hydration

```bash
if [ -n "$AUDIO_JOB_ID" ]; then
  eve job show "$AUDIO_JOB_ID" --verbose --json | \
    jq '.attempts[-1].runtime_meta.resource_hydration'
fi
```

**Expected:**
- Resource resolved from S3/MinIO
- `local_path` ends with `.wav`
- `content_hash` populated
- `failed_required_count: 0`

### 5e) Verify audio ingest record status

```bash
eve ingest show "$INGEST_AUDIO_ID" --project "$PROJECT_ID" --json | \
  jq '{status, job_id, completed_at, error_message}'
```

**Expected:**
- `status: "done"`
- `completed_at` set, `error_message` null

## Phase 6: Media Processing Tool Verification

Verifies that ffmpeg and whisper-cli are available in pods and that the end-to-end media processing pipeline works across text, audio, and video files.

### 6a) Tool availability smoke test

```bash
echo "=== Tool Availability Check ==="

# Check agent-runtime (where ingest jobs run)
echo "--- agent-runtime ---"
kubectl -n eve exec eve-agent-runtime-0 -- ffmpeg -version 2>&1 | head -1
kubectl -n eve exec eve-agent-runtime-0 -- whisper-cli --help 2>&1 | head -1
kubectl -n eve exec eve-agent-runtime-0 -- test -f /opt/whisper/models/ggml-small.en.bin \
  && echo "Model: OK" || echo "Model: MISSING"

# Check worker
echo "--- worker ---"
kubectl -n eve exec deployment/eve-worker -- ffmpeg -version 2>&1 | head -1
kubectl -n eve exec deployment/eve-worker -- whisper-cli --help 2>&1 | head -1
kubectl -n eve exec deployment/eve-worker -- test -f /opt/whisper/models/ggml-small.en.bin \
  && echo "Model: OK" || echo "Model: MISSING"
```

**Expected:** Both pods report ffmpeg version, whisper-cli usage, and model file present. If any are missing, stop — Phase 1 image build is incomplete.

### 6b) Generate test input files

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

### 6c) Ingest text file and verify

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

**Expected:** Job completes with `phase: "done"`. Agent reads the markdown directly and summarizes.

### 6d) Ingest audio file and verify

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

**Expected:** Job completes with `phase: "done"`. Job logs contain `whisper-cli` invocation.

### 6e) Ingest video file and verify

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

**Expected:** Job completes with `phase: "done"`. Job logs show `ffmpeg` extracting audio, then `whisper-cli` transcribing.

### 6f) Verification summary

```bash
echo ""
echo "=== VERIFICATION SUMMARY ==="
echo "Text  (md):  ${TEXT_PHASE:-SKIPPED}"
echo "PDF   (pdf): ${PDF_PHASE:-SKIPPED}"
echo "Audio (wav): ${AUDIO_PHASE:-SKIPPED}"
echo "Video (mp4): ${VIDEO_PHASE:-SKIPPED}"
echo ""

# Check ingest record final statuses
for ID_VAR in TEXT_INGEST_ID PDF_INGEST_ID AUDIO_INGEST_ID VIDEO_INGEST_ID; do
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

### 6g) Cleanup

```bash
rm -f /tmp/scenario-30-text.md /tmp/scenario-30-audio.wav /tmp/scenario-30-video.mp4
rm -f /tmp/ingest-text.json /tmp/ingest-audio.json /tmp/ingest-video.json /tmp/ingest-pdf-result.json
```

## Cleanup

```bash
rm -f /tmp/scenario-30-*.md /tmp/scenario-30-audio.wav
rm -f /tmp/ingest-md-result.json /tmp/ingest-wf-result.json /tmp/ingest-audio-result.json /tmp/ingest-pdf-result.json
rm -f /tmp/ingest-list.json /tmp/ingest-show.json
rm -rf /tmp/ingest-agentpack
```

## Success Criteria

- [ ] `eve ingest <file>` creates record, uploads via presigned URL, and confirms
- [ ] `eve ingest list` and `eve ingest show` return correct data
- [ ] Confirm replay is idempotent (no duplicate events or jobs)
- [ ] `eve agents sync` resolves ingest-agentpack without errors
- [ ] `process-document` workflow trigger matches `doc.ingest` events
- [ ] Processing job receives `resource_refs` with `ingest://` URI
- [ ] Agent-runtime hydrates ingest resource from S3 (`resolved_count: 1`)
- [ ] Job completes with `phase: "done"`
- [ ] Ingest record status updated to `"done"` via orchestrator callback
- [ ] PDF file uploads, hydrates with `mime_type: "application/pdf"` in resource index
- [ ] PDF processed natively by Claude (no pdftotext in job logs)
- [ ] PDF agent produces structured summary with key_facts and entities
- [ ] Resource index includes `mime_type` and `metadata` from ingest event
- [ ] Audio file (WAV) uploads, hydrates, and processes successfully
- [ ] Audio resource hydration shows correct file path and content hash
- [ ] ffmpeg is available in agent-runtime pods
- [ ] whisper-cli is available in agent-runtime pods
- [ ] whisper model exists at /opt/whisper/models/ggml-small.en.bin
- [ ] Text file (md) → agent reads directly → produces summary → phase=done, status=done
- [ ] Audio file (wav) → agent runs whisper-cli → produces transcript output → phase=done, status=done
- [ ] Video file (mp4) → agent runs ffmpeg + whisper-cli → produces summary → phase=done, status=done
- [ ] Job logs contain evidence of tool invocation (whisper-cli, ffmpeg)
- [ ] Ingest records transition to status=done with completed_at set
