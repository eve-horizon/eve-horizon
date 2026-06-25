# Scenario 29: Pi Harness Execution + Skills Discovery

**Time:** ~5-6 minutes
**Parallel Safe:** Yes
**LLM Required:** Yes (pi harness with ANTHROPIC_API_KEY)

Validates the pi coding agent harness end-to-end: harness discovery, job creation,
event normalization (pi's JSONL format), provider extraction from model string,
llm.call usage tracking, and **skill auto-discovery** (Pi finds skills installed
by the on-clone hook without `--no-skills`).

## Prerequisites

- Smoke tests pass (scenario 01)
- Secrets imported to test org with at least one provider key (ANTHROPIC_API_KEY recommended)
- Worker image includes `@mariozechner/pi-coding-agent`
- Worker image built from code that does NOT pass `--no-skills` to Pi

## Setup

```bash
export ORG_ID=org_manualtestorg
```

### Verify Pi is Listed

```bash
eve harness list --json | jq -r '.data[] | select(.name == "pi") | .name'
```

**Expected:** `pi`

If missing, the API is running old code — rebuild and redeploy.

### Verify Provider Key Exists

```bash
eve secrets list --org $ORG_ID --json | jq -r '.data[] | select(.key == "ANTHROPIC_API_KEY") | .key'
```

**Expected:** `ANTHROPIC_API_KEY`

If missing, add it to `manual-tests.secrets` and re-import:
```bash
eve secrets import --org $ORG_ID --file ./manual-tests.secrets
```

## Steps

### 1. Create Test Project

Uses the fullstack-example repo which has AgentPacks with skills and an on-clone hook
that runs `eve skills install`.

```bash
export PROJECT_ID=$(eve project ensure \
  --org $ORG_ID \
  --name "pi-harness-test" \
  --slug pitest \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json | jq -r '.id')
echo "PROJECT_ID=$PROJECT_ID"
```

**Expected:**
- Returns JSON with `id` field

### 2. Create Baseline Job with Pi Harness

```bash
eve job create \
  --project $PROJECT_ID \
  --description "List the top-level files in the repository and report what you find." \
  --harness pi \
  --model "anthropic/claude-sonnet-4" \
  --json
```

**Expected:**
- Returns JSON with `id` field
- Job phase is `ready` or `active`

```bash
export JOB_ID=<id_from_output>
```

### 3. Follow Job (Real-time)

```bash
eve job follow $JOB_ID
```

**Expected:**
- Streams pi's output through eve-agent-cli normalization
- Shows assistant events (agent text)
- May show tool_use/tool_result events (bash, read)
- Completes with exit code 0

### 4. Verify Completion

```bash
eve job show $JOB_ID --json
```

**Expected:**
- `phase: "done"`
- `close_reason` is null or success-related

### 5. Verify Event Normalization

```bash
eve job logs $JOB_ID --json | jq 'select(.kind == "assistant") | .kind' | head -5
```

**Expected:**
- At least one `"assistant"` event (pi's `message_update` with `text_delta` was normalized)

### 6. Verify LLM Call Tracking

```bash
eve job logs $JOB_ID --json | jq 'select(.type == "llm.call") | {provider, model, source, usage}'
```

**Expected:**
- `provider: "anthropic"` (extracted from model string `anthropic/claude-sonnet-4`)
- `model: "anthropic/claude-sonnet-4"`
- `source: "byok"`
- `usage` with non-zero `input_tokens` and `output_tokens`

### 7. Verify Pi Skill Discovery

Create a second job that asks Pi to list its discovered skills. Pi's `--no-skills`
flag was removed, so it should auto-discover skills from `.agents/skills/` installed
by the on-clone hook.

```bash
eve job create \
  --project $PROJECT_ID \
  --description "List the contents of the .agents/skills/ directory and the .pi/skills/ directory (if they exist). Also check skills.txt and skills-lock.json at the repo root. Report exactly what files and directories you find." \
  --harness pi \
  --model "anthropic/claude-sonnet-4" \
  --json
```

> **WARNING:** Do NOT ask Pi to run `pi --list-skills` — Pi has no such flag and the
> command will launch a new Pi session that hangs indefinitely. Use filesystem
> listing instead.

```bash
export SKILLS_JOB_ID=<id_from_output>
eve job wait $SKILLS_JOB_ID --timeout 300
```

Check the job logs for evidence of skill discovery:

```bash
eve job logs $SKILLS_JOB_ID --json | jq -r 'select(.kind == "assistant") | .text // empty' | head -40
```

**Expected:**
- Job completes successfully
- Agent output mentions `.agents/skills/` directory contents
- On-clone hook ran (`[on-clone] Installing skills from AgentPacks...` in provisioning logs)
- Skills from the fullstack-example AgentPacks are present (e.g., `notes-api-reference`)

**Alternative verification** — check provisioning logs for on-clone output:

```bash
eve job logs $SKILLS_JOB_ID --json | jq -r 'select(.kind == "system" or .type == "provisioning") | .text // .message // empty' | head -20
```

**Expected:** Contains `Installing skills from AgentPacks` and no errors about `eve-worker`.

### 8. Verify eve-worker CLI is NOT Used

```bash
eve job logs $SKILLS_JOB_ID --json | jq -r '. | tostring' | grep -c "eve-worker" || echo "PASS: no eve-worker references"
```

**Expected:** `PASS: no eve-worker references` — the on-clone hook now uses `eve skills install`.

## Success Criteria

- [ ] `eve harness list` includes pi with correct capabilities
- [ ] Baseline job created with `--harness pi --model anthropic/claude-sonnet-4`
- [ ] Baseline job completed with phase "done"
- [ ] Normalized events include `assistant` kind (text from pi)
- [ ] `llm.call` events emitted with `provider: "anthropic"` and valid usage
- [ ] On-clone hook uses `eve skills install` (not `eve-worker`)
- [ ] Skills installed to `.agents/skills/` by on-clone hook
- [ ] Pi discovers installed skills (no `--no-skills` flag)

## Troubleshooting

### Pi binary not found

```bash
eve job diagnose $JOB_ID
```

If `spawn_error` with "pi not found", the worker image doesn't include `@mariozechner/pi-coding-agent`.
Rebuild the worker image with `INSTALL_PI=true`.

### Auth failure

Pi reads API keys from environment variables directly. Check that the provider key
(e.g., `ANTHROPIC_API_KEY`) is set as an org secret and being passed through.

```bash
eve secrets list --org $ORG_ID --json | jq '.data[] | .key'
```

### No llm.call events

Check raw logs for pi's `message_end` event (which contains usage data):

```bash
eve job logs $JOB_ID --json | jq 'select(.raw.type == "message_end")'
```

If `message_end` exists but no `llm.call`, the `extractUsage` function may not be
finding the usage data in pi's output format.

### Skills not discovered by Pi

If Pi doesn't see skills, check:

1. **On-clone hook ran:** `eve job logs $SKILLS_JOB_ID --json | jq 'select(.kind == "system")'`
2. **Skills directory exists:** The on-clone hook should create `.agents/skills/`
3. **`--no-skills` removed:** Verify `packages/eve-agent-cli/src/harnesses/pi.ts` does NOT contain `--no-skills`
4. **Worker image is current:** Rebuild with `./bin/eh k8s-image push` if code changed

### eve-worker not found in on-clone hook

If the on-clone hook fails with `eve-worker: command not found`, the hook still
references the deleted `eve-worker` CLI. Update the hook to use `eve skills install`.
