# Workflow Step Optimization Plan

> **Status**: Draft
> **Scope**: Platform (eve-horizon-2) + App (eden)
> **Observed on**: 2026-03-16 — ingestion pipeline job `eden-12c76892`

## Problem Statement

The Eden ingestion pipeline takes **7+ minutes** to process a 385-byte markdown file through a 3-step workflow (ingest → extract → synthesize). Observation of agent logs reveals that **less than 90 seconds is actual work** — the rest is agents fumbling to find context that should already be available.

### Timing Breakdown (observed run)

| Step | Duration | Actual Work | Wasted |
|------|----------|-------------|--------|
| Ingest | 48s | ~5s (read file, format) | ~43s (LLM overhead for trivial task) |
| Extract | 171s | ~40s (structured extraction) | ~130s (error recovery, wrong endpoints, document hunting) |
| Synthesize | 222s | ~20s (diff + changeset creation) | ~200s (90s searching git repo, 60s discovering APIs, 50s fetching doc) |
| **Total** | **441s** | **~65s** | **~376s (85% waste)** |

### Root Causes

1. **Platform gap: resource_refs only propagated to step 1** — `workflows.service.ts:435` hard-codes `resource_refs: (index === 0) ? resourceRefs : []`. Steps 2 and 3 get nothing.

2. **Platform gap: no result propagation between steps** — Step 2 has no access to step 1's output. Step 3 has no access to step 2's extraction JSON. Each step starts from scratch.

3. **Skill instructions contain wrong assumptions** — Extraction and synthesis skills say "the document is a file in the git repo" when it's actually in S3. Agents waste 1-2 minutes each discovering this.

4. **Ingest step is a passthrough** — It reads a file and returns it verbatim. 48s of latency with Sonnet for what is essentially `cat`.

5. **Extraction agent doesn't know the Eden CLI** — It tried `eden ingestion` (non-existent command), hit 500s using the Eve project ID instead of the Eden UUID, and tried non-existent API routes.

---

## Plan

### Phase 1: Platform — Propagate Resources to All Workflow Steps

**Repo**: `eve-horizon-2`
**File**: `apps/api/src/workflows/workflows.service.ts:435`

**Current**:
```typescript
resource_refs: (index === 0) ? resourceRefs : [],
```

**Change to**:
```typescript
resource_refs: resourceRefs,
```

All workflow steps should receive the parent workflow's `resource_refs`. The agent-runtime already handles hydration generically — if `resource_refs` is empty, hydration is a no-op. Giving all steps the refs means:

- The extraction agent gets the document materialized at `.eve/resources/ingest/.../file.md` without any API calls
- The synthesis agent gets the same document locally without searching the git repo or calling WebFetch
- Zero risk: if a step doesn't need the resources, they're just extra files in the workspace

**Validation**: Run the Eden ingestion pipeline after this change. Steps 2 and 3 should each have `resource_hydration.resolved_count: 1` in their attempt's `runtime_meta`.

---

### Phase 2: Platform — Propagate Prior Step Results to Dependent Steps

**Repo**: `eve-horizon-2`
**File**: `apps/api/src/workflows/workflows.service.ts` (step description construction, lines 376-379)

When a workflow step has `depends_on`, the step's description should include the completed prior step's `result_text`. This is the highest-leverage change — it means the extraction agent receives the ingestion output, and the synthesis agent receives the extraction JSON, without any API calls.

#### Implementation

The step description is built at job creation time (line 376-379), before prior steps have run. So we can't inject results at creation. Instead, the result injection must happen at **dispatch time** — when the orchestrator claims a ready job and sends it to the agent-runtime.

**Option A (recommended): Inject into job description at dispatch time**

In the orchestrator's dispatch flow (when a blocked job becomes ready after its dependency completes):

1. Before dispatching the job, query the job's blocking dependencies
2. For each completed dependency, fetch its latest attempt's `result_text`
3. Prepend to the job's description:
   ```
   ## Prior Step Results

   ### Step: ingest (eden-12c76892.1)
   <result_text from step 1>

   ---
   ```
4. This requires a new field or description mutation at dispatch time

**Where to implement**: The orchestrator's `loop.service.ts` already queries ready jobs and claims them. Before dispatching to agent-runtime, it should enrich the job description with prior step results.

Specifically, look at the flow:
- `getReadyJobs()` / `getReadyAssignedJobs()` returns jobs whose blockers are done
- Before sending to agent-runtime, check if the job has `workflow_name` in hints
- If so, query its blocking job relations, fetch their `result_text`
- Append to the job's description (or add a `prior_results` hint)

**Option B (simpler but less general): Add `prior_results` to hints**

Add a `prior_step_results` field to the job's hints at dispatch time:
```json
{
  "prior_step_results": {
    "ingest": "## Ingestion Output\n...",
    "extract": "{\"personas\":[...], \"activities\":[...]}"
  }
}
```

The agent-runtime can then materialize this into `.eve/prior-results/ingest.md` and `.eve/prior-results/extract.json` in the workspace.

**Recommendation**: Option A for simplicity — inject directly into the job description. The description is already included in the agent's system prompt. No agent-runtime changes needed.

**Size limit**: Cap prior result injection at 50KB per step to avoid bloating the prompt. If a result exceeds 50KB, materialize it as a file reference instead.

#### Where the dispatch enrichment should live

The orchestrator claims and dispatches jobs in `apps/orchestrator/src/loop/loop.service.ts`. The `dispatchJob()` or equivalent method is where the enrichment should happen. The flow is:

1. `getReadyJobs()` returns eligible jobs
2. Orchestrator claims the job (sets phase to `active`)
3. Orchestrator sends invocation to agent-runtime or worker

Between steps 2 and 3, check:
- Does the job have `hints.workflow_name`?
- Does the job have blocking dependencies (via `job_relations`)?
- If yes, fetch the blocking jobs' latest attempt `result_text`
- Mutate the description (or add to hints) before dispatch

---

### Phase 3: Eden — Merge Ingest + Extract into a Single Step

**Repo**: `eden` (`../../eve-horizon/eden`)

With Phase 1 in place (resources propagated to all steps), the extraction agent will have the document materialized locally. The ingestion step becomes fully redundant — its only job was to read the file and format it, which extraction can do as part of its process.

#### Changes

**1. Update workflow definition** (`eve/workflows.yaml` and `.eve/manifest.yaml`):

```yaml
ingestion-pipeline:
  trigger:
    system:
      event: doc.ingest
  with_apis:
    - service: api
      description: Eden Story Map API for reading map state and creating changesets
  steps:
    - name: extract
      agent:
        name: extraction
    - name: synthesize
      depends_on: [extract]
      agent:
        name: synthesis
  hints:
    timeout_seconds: 600   # Was 900, now 2 steps not 3
    permission_policy: yolo
```

**2. Update extraction skill** (`skills/extraction/SKILL.md`):

The extraction agent now gets materialized resources (Phase 1). Rewrite the "How to Find the Document" section:

```markdown
## CRITICAL: How to Find the Document

The document has been **materialized into your workspace** by the platform.

1. **Read `.eve/resources/index.json`** — lists all materialized resources with local paths
2. **Read the file** at the path specified in `local_path`
3. The file is already on disk — just read it directly

**Do NOT:**
- Search the git repo for the file — it's not there
- Call any download endpoint or presigned URL
- Use curl or WebFetch — the file is local
```

**3. Retire the ingestion skill** — Either delete `skills/ingestion/` or mark it deprecated. The ingestion agent definition in `eve/agents.yaml` can be removed or kept for potential future use (e.g., complex document parsing like PDF/images).

**Impact**: Eliminates 48s of pipeline latency and one LLM invocation (~$0.02 per run).

---

### Phase 4: Eden — Fix Synthesis Skill Instructions

**Repo**: `eden` (`../../eve-horizon/eden`)
**File**: `skills/synthesis/SKILL.md`

With Phase 1 (resources) and Phase 2 (prior results), the synthesis agent will have:
- The document materialized locally (no more git searching)
- The extraction JSON in its prompt (no more re-discovering everything)

#### Changes

**1. Update "Find the Document" section:**

```markdown
## Find the Document

The document has been **materialized into your workspace** by the platform.

1. **Read `.eve/resources/index.json`** — lists all materialized resources with local paths
2. **Read the file** at the path specified in `local_path`

**Do NOT** search the git repo, call WebFetch, or use download URLs.
```

**2. Add "Prior Step Results" section:**

```markdown
## Prior Step Results

The extraction step's output (structured JSON with personas, activities, steps, tasks, questions)
is included in this job's description above. Parse it directly — do NOT re-extract from the document.

If the extraction JSON is not in the description, fall back to reading the document and
extracting entities yourself.
```

**3. Fix the CLI discovery section:**

The current skill already has good CLI instructions. But add explicit guidance for the `source list` command to avoid the agent running `eden source --help` every time:

```markdown
## Finding the Source Record

The `payload.ingest_id` in the workflow input identifies the Eve ingest session.
To find the Eden source record for status updates:

\```bash
SRC_ID=$(eden source list --json | jq -r '.[] | select(.eve_ingest_id == "ing_xxx") | .id')
\```

Replace `ing_xxx` with the actual `payload.ingest_id` from the workflow input.
```

---

### Phase 5: Eden — Update Extraction Skill with CLI Knowledge

**Repo**: `eden` (`../../eve-horizon/eden`)
**File**: `skills/extraction/SKILL.md`

The extraction agent needs to update the source status after completing extraction. Currently, it discovers the CLI through trial and error (`eden ingestion` → error → `eden --help` → `eden source --help`).

#### Add CLI section to extraction skill:

```markdown
## After Extraction: Update Source Status

After producing the structured extraction JSON, update the source status so the UI
reflects that extraction is complete.

The Eden CLI is available as `eden` on PATH. Use it to update the source:

\```bash
# Find the source by ingest_id from the workflow payload
SRC_ID=$(eden source list --json | jq -r '.[] | select(.eve_ingest_id == "INGEST_ID") | .id')
eden source update-status --source "$SRC_ID" --status extracted
\```

Replace INGEST_ID with `payload.ingest_id` from the workflow input.

**Do NOT:**
- Use `./cli/bin/eden` — it's just `eden` on PATH
- Use Eve project IDs (like `proj_xxx`) — use Eden project UUIDs from `eden projects list --json`
```

---

### Phase 6: Eden — Use Haiku for Extraction (if kept as separate step)

**Repo**: `eden` (`../../eve-horizon/eden`)
**File**: `eve/agents.yaml`

If Phase 3 (merge) is deferred, at minimum switch the ingestion agent from Sonnet to Haiku. The ingestion task is trivial — read a file and format metadata. Haiku can do this in <10s instead of 48s.

```yaml
ingestion:
  slug: ingestion
  name: "Ingestion Agent"
  skill: ingestion
  harness_profile: expert
  harness_options:
    model: haiku
  workflow: assistant
  # ...
```

Also consider Haiku for extraction (the structured extraction of a 385-byte doc doesn't need Sonnet), though larger documents may benefit from Sonnet's stronger reasoning.

---

## Implementation Order

| Phase | Repo | Risk | Impact | Effort |
|-------|------|------|--------|--------|
| **1. Propagate resource_refs** | eve-horizon-2 | Low (additive) | High — eliminates document-hunting in steps 2+3 | 1-line change + test |
| **3. Merge ingest + extract** | eden | Low (skill change) | Medium — removes 48s latency, one LLM call | Skill rewrite + workflow YAML |
| **4. Fix synthesis skill** | eden | Low (skill change) | High — eliminates 90s git search + 60s API discovery | Skill rewrite |
| **5. Fix extraction skill** | eden | Low (skill change) | Medium — eliminates error recovery loops | Skill update |
| **2. Prior step result propagation** | eve-horizon-2 | Medium (orchestrator change) | High — enables extraction JSON to flow to synthesis | Orchestrator enrichment logic |
| **6. Haiku for ingestion** | eden | Low (config change) | Low — 30s savings if ingest step kept | YAML config |

**Recommended implementation order**: 1 → 4 → 5 → 3 → 2 → 6

- Phase 1 is a one-line platform fix that immediately unblocks Phases 3-5
- Phases 4 and 5 are skill-only changes in Eden — no platform deploy needed
- Phase 3 (merge steps) depends on Phase 1 being deployed
- Phase 2 is the largest platform change and provides the most value long-term (benefits all workflows, not just Eden)
- Phase 6 is optional if Phase 3 eliminates the ingest step

## Expected Results

| Metric | Before | After (Phase 1+3+4+5) | After (All phases) |
|--------|--------|------------------------|-------------------|
| Pipeline steps | 3 | 2 | 2 |
| Total wall-clock time | ~440s | ~120s | ~80s |
| LLM calls | 3 jobs | 2 jobs | 2 jobs |
| Token spend | ~$0.70 | ~$0.35 | ~$0.30 |
| Agent errors/retries | ~8 failed attempts | 0 | 0 |

## Appendix: Observed Agent Behavior (Full Trace)

### Extraction Agent (.2) — 171s

```
[3:20:54] eden ingestion              → ERROR: unknown command (tried non-existent CLI subcommand)
[3:21:01] eden --help                 → Recovering: discovering available commands
[3:21:09] eden source --help          → Learning source commands
[3:21:16] eden source list --project proj_xxx → 500 ERROR (used Eve project ID, not Eden UUID)
[3:21:30] curl <download-url>         → Connection failed (tried to download directly)
[3:21:37] curl (retry)                → 500 error
[3:21:44] eden projects list --json   → Found Eden project UUID
[3:21:59] eden source list --project <uuid> → Found source record with download_url
[3:22:17] GET /sources/{id}           → 404 (tried non-existent detail endpoint)
[3:22:24] GET /sources/{id}/download  → 404 (tried non-existent download endpoint)
[3:22:31] WebFetch download_url       → SUCCESS: got document content (3rd attempt)
[3:22:31–3:23:06] Structured extraction work → Actual valuable work (~35s)
[3:23:06] eden source update-status --help → Learning the command
[3:23:14] eden source update-status   → Success
```

### Synthesis Agent (.3) — 222s

```
[3:23:33] ToolSearch                  → Loaded Read, Bash tools
[3:23:38] Read (bad path)             → File does not exist
[3:23:44] eden projects list --json   → Found Eden project UUID (correct)
[3:24:00] eden source list --json     → Found source records (correct, 2 calls for 2 projects)
[3:24:20] eden map --project <uuid>   → Got map state (correct!)
[3:24:20] eden source --help          → Redundant (already knew from list)
[3:24:45–3:25:53] Searching git repo  → 90 SECONDS: ls scripts/, Glob *.md, Read scenarios,
                                         Read README, Read smoke-test.sh, check .eve/ dir,
                                         list manifest files — ALL dead ends
[3:26:13] "The document isn't in the git repo" → Finally gave up searching
[3:26:18] WebFetch download_url       → 302 redirect
[3:26:21] WebFetch (follow redirect)  → Got document content
[3:26:37–3:26:55] Actual synthesis    → 20 SECONDS: wrote changeset JSON + eden changeset create
[3:26:59] eden source update-status   → Success (correct)
```
