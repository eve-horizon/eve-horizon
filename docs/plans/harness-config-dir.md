# Harness Config Directory Plan

> **Plan (Historical)**: This plan may be partially or fully implemented.
> **Current default**: Kubernetes (k8s) is the standard deployment; Docker Compose is only for quick dev loops.
> See `docs/system/deployment.md` for current deployment guidance.

> Status: Draft
> Last Updated: 2026-01-16
> Owner: Eve Horizon

## Summary

Introduce a single harness config root with per-harness and per-variant folders. Eve passes config directories to harnesses (no parsing). A single env var overrides the root for deployments. Local dev keeps OAuth overlay support; production uses API keys only via secrets.

## Goals

- Standardize harness configuration layout in-repo with a single override for deployments.
- Keep harness-specific configuration files native (TOML/JSON/etc).
- Preserve local dev OAuth overlay (as an exception), while production uses API keys only.
- Keep the system simple: no extra registry/spec files or feature flags.

## Non-Goals

- Adding new auth flows or changing secrets storage.
- Defining a unified config schema across harnesses.
- Supporting multiple repos per project or skill pack registries.

## Background Notes

- Codex/Code read config from `CODEX_HOME` and `config.toml` layers (including `CODEX_HOME/config.toml` and repo `.codex/config.toml`).
- Codex auth uses `CODEX_HOME/auth.json` and a fallback `CODEX_HOME/.credentials.json`.
- Claude/mclaude rely on `CLAUDE_CONFIG_DIR` for config and local auth in dev.

## Proposed Directory Layout

```
.agent/harnesses/
  mclaude/
    config.json
    variants/
      fast/
        config.json
  code/
    config.toml
    variants/
      plan/
        config.toml
  codex/
    config.toml
```

### Root Override

- `EVE_HARNESS_CONFIG_ROOT=/opt/eve/harnesses`
- Same structure as `.agent/harnesses`.

## Resolution Rules

Given harness `H` and optional `variant`:

- `root = EVE_HARNESS_CONFIG_ROOT ?? <repo>/.agent/harnesses`
- `base = <root>/<H>/`
- `variant = <root>/<H>/variants/<variant>/`
- Effective config = `base` overlaid by `variant` (if exists)
- If neither exists, no config is applied

Eve does not parse these files; it only passes the effective directory to the harness.

## Local Dev OAuth Overlay

Local dev remains an exception:

- For harnesses that use OAuth in local dev, we overlay credentials into the staged config home.
- Sources are the normal local files (e.g., `~/.codex/auth.json`, `~/.codex/.credentials.json`, `~/.claude/.credentials.json`).
- This overlay is **disabled** in VPS/cloud deployments.

Production/VPS:

- API keys only, provided via secrets at user/org/project.
- No reading from `~` and no OAuth overlay.

## Harness-Specific Handling

- **Codex/Code**: stage config into a temp `CODEX_HOME` and set `CODEX_HOME` for the process. This supports `config.toml` and local OAuth files when allowed.
- **Claude/mclaude/zai**: set `CLAUDE_CONFIG_DIR` to the effective config dir. For local dev, overlay OAuth creds in that dir.
- **Gemini**: no config required initially; can adopt the same directory layout later.

## Implementation Plan (High-Level)

1. **Config resolution helper** in `eve-agent-cli`:
   - Resolve root, harness dir, and variant overlay.
2. **Harness adapters** in `eve-agent-cli`:
   - Apply config dir to env per harness.
   - For Codex/Code: stage into temp `CODEX_HOME`.
3. **Worker adapters**:
   - Keep auth resolution; stop config dir resolution in worker.
4. **Harness registry**:
   - Derive variants by scanning `<root>/<harness>/variants`.
5. **Docs**:
   - Update `docs/system/harness-execution.md` with layout + rules.

## Validation

- Manual: place config under `.agent/harnesses/<harness>/` and run a harness.
- CLI: `eve harness list` reflects variants from `variants/`.
- E2E: `./bin/eh test e2e` after registry/CLI changes.

## Risks / Edge Cases

- Container paths: external config root must be mounted into worker containers.
- Overlay correctness: ensure credentials are only overlaid in local dev.
- Avoid clobbering user auth outside temp directories.
