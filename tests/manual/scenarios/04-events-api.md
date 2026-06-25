# Scenario 04: Events API

**Time:** ~30 seconds
**Parallel Safe:** Yes
**LLM Required:** No

Tests the event system: emitting and listing events.

## Prerequisites

- Smoke tests pass (scenario 01)
- A project exists

## Setup

Use the stable manual test org:

```bash
export ORG_ID=org_manualtestorg

eve project ensure \
  --org $ORG_ID \
  --name "events-test-project" \
  --slug etest \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --force \
  --json
export PROJECT_ID=<id_from_output>
```

## Steps

### 1. Emit a Test Event

```bash
eve event emit \
  --project $PROJECT_ID \
  --type manual.test \
  --source manual \
  --payload '{"test": true, "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' \
  --json
```

**Expected:**
- Returns JSON with event details
- Event has `id`, `type`, `source`, `payload`
- `status` indicates event was received

### 2. List Events

```bash
eve event list --project $PROJECT_ID --json
```

**Expected:**
- Returns array of events
- Contains the event just emitted
- Events have `id`, `type`, `source`, `created_at`

### 3. Filter Events by Type

```bash
eve event list --project $PROJECT_ID --type manual.test --json
```

**Expected:**
- Returns only events matching the type filter
- Should include our test event

### 4. Emit System-Style Event

```bash
eve event emit \
  --project $PROJECT_ID \
  --type job.completed \
  --source system \
  --payload '{"job_id": "test-123", "phase": "done"}' \
  --json
```

**Expected:**
- Event created successfully
- This type of event could trigger pipelines (if configured)

### 5. Workflow with Per-Event Harness Profile Template (Phase 4)

Verifies that event-triggered workflows honor `${inputs.<key>}` template
expressions in step-level `harness_profile` with `workflow.inputs.<name>.from`
bindings to the event payload.

**Setup:** sync a manifest that declares a workflow with a template:

```yaml
# .eve/manifest.yaml snippet
x-eve:
  agents:
    profiles:
      planner:
        - harness: claude
          model: claude-sonnet-4-6
      fast:
        - harness: zai
          model: glm-4.6

workflows:
  per-event-brain:
    inputs:
      brain:
        from: event.payload.brain
        default: planner
    steps:
      - name: classify
        agent:
          name: default-agent
        harness_profile: "${inputs.brain}"
```

```bash
eve manifest sync --project $PROJECT_ID --json
```

**Expected:** sync succeeds (templates validate cleanly).

Now emit an event that routes to this workflow with `brain=fast`:

```bash
eve event emit \
  --project $PROJECT_ID \
  --type workflow.trigger \
  --source manual \
  --payload '{"brain": "fast"}' \
  --json
```

**Expected:**
- Event created.
- A workflow is triggered (if `chat.yaml`/trigger binds the event type).
- The workflow's step job records `harness=zai`, `harness_profile=fast`,
  `harness_profile_source=string_ref`.

```bash
eve job list --project $PROJECT_ID --limit 5 --json | jq '.[] | {id, harness, harness_profile, harness_profile_source}'
```

Omit the `brain` field and emit another event to verify the default path:

```bash
eve event emit \
  --project $PROJECT_ID \
  --type workflow.trigger \
  --source manual \
  --payload '{}' \
  --json
```

**Expected:**
- Resulting workflow step job uses `harness_profile=planner` (the declared
  default) and `harness_profile_source=string_ref`.

### 6. Manifest sync rejects malformed templates (Phase 4)

```bash
cat <<'YAML' | eve manifest validate --project $PROJECT_ID --json
name: bad-templates
workflows:
  broken:
    steps:
      - name: s
        agent:
          name: x
        harness_profile: "${bogus}"
YAML
```

**Expected:**
- Response is `valid: false`.
- `errors` array contains `workflow "broken" step "s" harness_profile: Unsupported expression head`.

## Success Criteria

- [ ] Can emit custom events
- [ ] Events appear in list
- [ ] Can filter events by type
- [ ] Event payload is preserved
- [ ] Workflow template `${inputs.brain}` honors event payload (Phase 4)
- [ ] Workflow template falls back to declared default when payload omits key
- [ ] Manifest sync rejects `${bogus}` expressions at validation time

## Event Types Reference

Common event types in Eve:
- `manual.*` - User-triggered events
- `job.created`, `job.completed`, `job.failed` - Job lifecycle
- `deploy.started`, `deploy.completed` - Deployment lifecycle
- `github.push`, `github.pr` - Git events (via webhooks)

## Notes

- Events can trigger pipelines if manifest has matching triggers
- Events are project-scoped
- The event system is the foundation for reactive automation
