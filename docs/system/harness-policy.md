# Harness Policy and Reasoning Controls

> Status: Current
> Last Updated: 2026-02-13
> Purpose: Define how projects select harness/model combinations and how jobs pass reasoning controls.

## Current (Implemented)

- Jobs specify a single harness via top-level `harness` (e.g., `mclaude`).
- Jobs can optionally specify `harness_profile` and `harness_options` (variant/model/reasoning).
- `hints` now cover scheduling preferences only (`worker_type`, `permission_policy`, `timeout_seconds`).
- `harness:variant` is **not** parsed; use `harness_options.variant` instead.
- Model + reasoning overrides are passed to workers via `harness_options`:
  - `mclaude/claude/zai`: `model` override supported; `reasoning_effort` maps to thinking tokens.
  - `code/codex`: `model` override supported; `reasoning_effort` maps to `--reasoning`.
  - `gemini`: `model` override supported; `reasoning_effort` passed through.
- Harness auth status is exposed via `GET /harnesses` and CLI commands.

### Job Harness Options

Harness configuration now lives on the job:

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

Adapters map these hints to harness-specific CLI flags. Unsupported options are ignored
with a warning.

### Project Harness Policy (Agents / Profiles)

Projects define named profiles under `x-eve.agents` in the manifest.

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
```

Skills (like the PRD epic workflow) reference profiles instead of hardcoding harnesses.


### CLI + API Introspection

Agents can inspect policy + availability from the CLI:
- Project policy + defaults: `eve agents config --json`
- Harness auth availability: `eve harness list`
- Harness capabilities: `eve harness list --capabilities` or via `eve agents config`

### Notes

- Project-level availability decisions (e.g., `drop_unavailable`) live in the manifest policy and
  are surfaced by `eve agents config`; orchestration behavior is implemented by orchestrators
  consuming that config.

## Related Docs

- `docs/system/harness-execution.md`
- `docs/system/harness-adapters.md`
- `docs/plans/harness-policy-and-reasoning-controls.md`
