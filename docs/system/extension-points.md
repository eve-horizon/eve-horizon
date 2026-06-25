# Extension Points

> Status: Mixed (Current + Planned)
> Last Updated: 2026-01-15
> Purpose: Define extension points we include today and those planned for post-MVP.

## Current (Implemented)

- Repo-only skills via paths listed in `skills.txt`, installed into `.agents/skills/` (optional `.claude/skills/` overrides).
- Skills manifest (`skills.txt`) + on-clone hook (`.eve/hooks/on-clone.sh`) for deterministic installs.
- CLI as a thin REST wrapper with clear extension points (subcommands, packaging).
- Per-job worker selection via `hints.worker_type` with routing map in `EVE_WORKER_URLS`.

## Planned (Not Implemented)

- Worker image registry and dynamic discovery.
- Skill pack registry + version pinning.
- Job hooks, custom migrations, and richer event streams.

## Legacy (Removed)

- Workflow-based extension hooks (workflows are removed).

## Principles

- Extensions should be **additive** (no forks required).
- Configuration should be **layered** (global -> project -> job -> override).
- Extension points must be stable and versioned.

## Planned Extension Points

### 1) Worker Types
- **Why**: keep tooling consistent across workers while allowing specialized runtimes
- **MVP**: per-job `hints.worker_type` + `EVE_WORKER_URLS` mapping
- **Later**: registry + dynamic routing policies

### 2) SkillPack Sources
- **Why**: add skills/tools without code changes
- **MVP**: repo-only skills from `skills.txt` sources → `.agents/skills/` (no system roots)
- **Later**: remote SkillPack registry + version pinning

### 3) Skill Pack Registry
- **Why**: discover and version skill packs across teams
- **MVP**: none (repo-only skills)
- **Later**: per-project skill pack catalogs + registry

### 4) Job Hooks (Setup/Cleanup)
- **Why**: project-specific setup, formatting, or cleanup
- **MVP**: none (explicit skills only)
- **Later**: typed hook contracts

### 5) Custom Migrations
- **Why**: downstream apps can extend the schema
- **MVP**: mount extra migrations dir, apply after core
- **Later**: tenant-specific migration support

### 6) Log + Event Stream
- **Why**: integrate external UI/monitoring
- **MVP**: JSONL logs stored in DB, simple streaming endpoint
- **Later**: webhooks and event bus

## Current: CLI Extension Pattern

### Goal
Make it easy to build or replace the CLI without touching core services.

### Pattern
- Keep core CLI thin: API client + subcommand routing
- Allow **plugins** as extra subcommands:
  - `~/.eve/plugins/<name>/bin`
  - `./.eve/plugins/<name>/bin`
- Respect layered config: `~/.eve/config` → project config → env → flags

### MVP Inclusion
- Document plugin search paths
- Provide a `cli/` package template

## Current: CLI Packaging Recommendation

### Goal
Provide a CLI that works in SkillPacks, on arbitrary machines, and in no-compile environments.

### Approach
- Ship a **thin, pure-JS Node CLI** (`@evehorizon/cli`)
- Support `npx @evehorizon/cli ...` and `npm i -g @evehorizon/cli`
- Preinstall the CLI in worker images for offline execution

### SkillPack shim (fallback)

Provide a small script in SkillPacks:

```
if command -v eve >/dev/null 2>&1; then
  eve "$@"
else
  npx @evehorizon/cli "$@"
fi
```

### Config layering
- `~/.eve/config` → project config → env → flags

## Planned: Additional Extension Points (Post-MVP)

- External secrets providers
- Remote test runners
- Alternate job schedulers
- Multi-worker routing policies
