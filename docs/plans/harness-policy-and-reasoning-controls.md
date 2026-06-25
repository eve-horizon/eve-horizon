# Harness Policy + Reasoning Controls - Plan

> Status: Implemented (v1)
> Last Updated: 2026-01-27

## Purpose

Add per-project harness policy and per-job reasoning controls so review workflows can
select multiple models/harnesses based on credentials and intent (primary vs background),
while keeping default job execution unchanged.

## Source Docs

- `docs/ideas/prd-to-epic-workflow.md`
- `docs/system/harness-execution.md`
- `docs/system/harness-adapters.md`

## Goals

- Configure which harnesses/models run in parallel per project.
- Allow job-level overrides for model, variant, and reasoning effort.
- Resolve available harnesses based on credentials at runtime.
- Keep the core job model simple and backward compatible.

## Non-goals

- Multi-harness execution within a single job (use multiple jobs).
- Auto-merging or PR policy changes.
- New auth systems beyond existing secrets.

## Current State (Reference)

- Jobs support top-level `harness`, `harness_profile`, and `harness_options`.
- Scheduling hints cover `worker_type`, `permission_policy`, and `timeout_seconds`.
- Variants are supported via `harness_options.variant` (not `harness:variant`).
- Model and reasoning overrides are passed to adapters where supported.
- Project policy is stored in `x-eve.agents` and exposed via `eve agents config`.
- Harness availability + capability hints are exposed via `eve harness list` and `--capabilities`.

## Implemented Model

### Job Harness Fields (Per-Job Overrides)

Move harness config to top-level job fields (breaking change is OK):

```json
{
  "harness": "mclaude",
  "harness_profile": "primary-reviewer",
  "harness_options": {
    "variant": "deep",
    "model": "opus-4.5",
    "reasoning_effort": "high"
  },
  "hints": {
    "worker_type": "default",
    "permission_policy": "auto_edit"
  }
}
```

Notes:
- `harness` stays a single selection; parallel runs remain multiple jobs.
- `variant` remains a config overlay for harness-specific defaults.
- `reasoning_effort` is a cross-harness hint; adapters map it where supported.
- `harness_profile` is optional; when set, orchestrators resolve it into multiple jobs.

### Project Harness Policy (Agents / Profiles)

Store policy under `x-eve.agents` in the manifest (single source of truth).

```yaml
# .eve/manifest.yaml
x-eve:
   agents:
     version: 1
     availability:
       drop_unavailable: true
     profiles:
       primary-orchestrator:
         - harness: mclaude
           model: opus-4.5
           reasoning_effort: high
       primary-coder:
         - harness: codex
           model: gpt-5.2-codex
           reasoning_effort: high
       primary-reviewer:
         - harness: mclaude
           model: opus-4.5
           reasoning_effort: high
         - harness: codex
           model: gpt-5.2-codex
           reasoning_effort: x-high
       primary-planner:
         - harness: codex
           model: gpt-5.2-codex
           reasoning_effort: x-high
      planning-council:
        - profile: primary-planner
        - harness: gemini
          model: gemini-3
```

The PRD workflow (or other skills) references profiles instead of hardcoding harnesses.

### Profiles and Councils

Profile entries support two forms:
- **Harness target**: `{ harness, model?, variant?, reasoning_effort? }`
- **Profile reference**: `{ profile: <name> }` (expands to its entries)

Resolution is a simple expansion + flatten + availability filter. If a profile expands
to multiple targets, orchestration creates child jobs (one per target).

### Defaults

Allow defaults at the policy level (stored under `x-eve.agents.defaults`):

```yaml
x-eve:
  agents:
    defaults:
      profile: primary-orchestrator
      harness: mclaude
      reasoning_effort: medium
```

`x-eve.defaults.harness_profile` can set the default profile for jobs created
without explicit overrides.

### Availability Reporting

The API exposes system-level harness auth status via `GET /harnesses`, which is surfaced
through `eve harness list` and `eve agents config`. Orchestrators can apply policy rules
(like `drop_unavailable`) using this data.

### Capability Registry (Models + Reasoning)

Add a static capability map per harness in `@eve/shared`:
- `supports_model` (boolean)
- `reasoning.levels` (low|medium|high|x-high)
- `reasoning.mode` (`effort` | `thinking_tokens` | `unknown`)
- `model_examples` (small list; **not** a global catalog)

This is not a full model catalog; it provides UI/CLI hints and validation for policies.

### Reasoning Effort Mapping

Define a canonical taxonomy and adapter-level mapping:

```
ReasoningEffort = low | medium | high | x-high
```

- `code/codex`: map to `--reasoning <effort>` directly.
- `mclaude/claude/zai`: map effort → thinking tokens (adapter translation).
- `gemini`: map effort where supported, otherwise ignore with warning.

Adapters should log the resolved values and include them in harness lifecycle metadata.
### Credential Mapping (Baseline)

- `mclaude`/`claude`: `ANTHROPIC_API_KEY` or Claude OAuth tokens
- `zai`: `Z_AI_API_KEY`
- `gemini`: `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- `codex`/`code`: `CODEX_AUTH_JSON_B64` or `CODEX_OAUTH_*`

## API Changes (Implemented)

- Top-level `harness`, `harness_profile`, and `harness_options` are part of job requests.
- `hints.harness` is removed; hints remain for scheduling preferences only.
- Job responses include `harness`, `harness_profile`, and `harness_options`.

## CLI Changes (Implemented)

- `eve job create` supports `--profile`, `--variant`, `--model`, and `--reasoning`.
- `eve agents config [--path <dir>]` shows project policy + defaults + availability + capabilities.
- `eve harness list --capabilities` and `eve harness get <name>` expose harness details.

## Worker + Adapter Changes (Implemented)

- `harness_options` are passed into adapters.
- `--model`, `--variant`, and `--reasoning` are forwarded where supported.
- Capability map is defined in `@eve/shared` and exposed via API/CLI.

## Implementation Notes

- `harness:variant` is intentionally not parsed; use `harness_options.variant`.
- Availability is reported at the system level via `GET /harnesses`.

## Open Questions

- None (decisions locked: top-level harness fields, standard reasoning schema, `x-eve.agents` only).
