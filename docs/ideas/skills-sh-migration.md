# Skills.sh Migration: Skills + Eve AgentPacks

> Status: Idea
> Last Updated: 2026-02-08
>
> Goal: Replace OpenSkills with skills.sh and introduce Eve AgentPacks — a
> composition primitive that lets projects adopt complex multi-agent systems
> via a single manifest reference plus small overlays.

## Upstream References

- skills.sh: https://skills.sh/
- CLI repo (authoritative): https://github.com/vercel/skills
- Agent Skills spec: https://agentskills.io/

## Related Eve Docs

- Skills today: `docs/system/skills.md`, `docs/system/skills-manifest.md`, `docs/system/skillpacks.md`
- Repo-first agents/teams/chat: `docs/system/agents.md`, `docs/system/chat-routing.md`
- Harness policy: `docs/system/harness-policy.md`
- Factory driver case: `docs/ideas/automated-software-factory-v2.md`

---

## Current State (Eve Today)

### Skills (OpenSkills)

- Skill sources declared in repo-local `skills.txt`.
- Worker runs `.eve/hooks/on-clone.sh` -> `eve-worker skills install`.
- Under the hood: `openskills install ...` + `openskills sync` to update `AGENTS.md`.
- Installed skills live in gitignored `.agents/skills/` with `.claude/skills` as a symlink.

### Agents + Chat (Repo-First Sync)

Projects sync repo-local YAML into the API:

```yaml
# .eve/manifest.yaml
x-eve:
  agents:
    config_path: agents/agents.yaml
    teams_path: agents/teams.yaml
    skills_root: skills/
  chat:
    config_path: agents/chat.yaml
```

Composition is manual: copy a template, edit it, `eve agents sync`.

---

## Problem

Skills-only packs don't compose a system. A coherent multi-agent system requires:

- **Agent roster** (agents.yaml)
- **Team topology** (teams.yaml)
- **Chat routing** (chat.yaml)
- **Harness policy** (x-eve.agents.profiles + defaults)

The Software Factory highlights this: installing it requires editing `skills.txt`,
copying YAML templates, editing the manifest, and syncing. Upgrading is worse —
re-copy or manually diff.

We want a single manifest reference that wires in skills + system config +
a clean way to override without forking.

---

## Design Principles

1. **Packs are self-describing.** The pack declares its contents; the consumer
   should never repeat what the producer already said.
2. **Convention over configuration.** The common case is two lines in the manifest.
   Overrides are additive.
3. **Single resolution time.** Everything resolves at sync time. The worker reads
   pre-resolved state, never independently fetches or resolves packs.
4. **Standard merge semantics.** RFC 7396-inspired: deep-merge maps, `null` to
   remove. One rule, not per-type removal syntax.
5. **Automatic namespacing.** Org-unique slugs are an invariant, not a config
   option. The system always prefixes pack-sourced agent slugs.
6. **Fail fast.** Validate everything at sync time. Mismatches between agents and
   skills, slug collisions, missing packs — all caught before a job runs.

---

## Proposal Overview

Two concepts:

- **SkillPack**: a repo containing skills only (one or more `SKILL.md` directories).
  Installs via `skills add`. No Eve metadata.
- **AgentPack**: a SkillPack plus an `eve/` metadata directory (agents, teams,
  chat, harness policy). Self-described by a required `eve/pack.yaml`.

The distinction is inferred from the presence of `eve/pack.yaml` — no `kind`
field needed in the consumer manifest.

---

## AgentPack Format (Repo Layout)

```
eve-software-factory/
  skills/
    factory-intake/
      SKILL.md
    factory-spec/
      SKILL.md
    ...
  eve/
    pack.yaml            # required descriptor
    agents.yaml          # base agent roster
    teams.yaml           # base team topology
    chat.yaml            # base chat routes
    x-eve.yaml           # harness profiles + defaults
```

### `eve/pack.yaml` (Required Descriptor)

```yaml
version: 1
id: software-factory

# Declare what this pack provides.
# Paths are relative to the pack root.
imports:
  agents: eve/agents.yaml
  teams: eve/teams.yaml
  chat: eve/chat.yaml       # optional (omit if pack has no routes)
  x_eve: eve/x-eve.yaml     # optional (omit if pack has no harness config)
```

`pack.yaml` is **required** for AgentPacks. It makes the pack self-describing
and eliminates the need for the consumer to specify import paths.

For SkillPacks (skills-only repos with no `eve/` directory), no `pack.yaml` is
needed. The system treats them as pure skill sources.

---

## Manifest Integration: `x-eve.packs`

### Minimal Entry (Common Case)

```yaml
x-eve:
  packs:
    - source: https://github.com/yourorg/eve-software-factory
      ref: 0123456789abcdef0123456789abcdef01234567
```

That's it. Two fields:

- `source`: git URL or local path.
- `ref`: immutable 40-char commit SHA (required for remote packs).

Everything else comes from `pack.yaml` inside the pack:
- Pack `id` from `pack.yaml`.
- Import paths from `pack.yaml`.
- Skills installed to agents listed in the project-level `install_agents` default.

### Project-Level Defaults

Target agents for skill installation are a project concern, not a per-pack
concern. Define them once:

```yaml
x-eve:
  install_agents: [claude-code, codex, gemini-cli]

  packs:
    - source: https://github.com/yourorg/eve-software-factory
      ref: 0123456789abcdef0123456789abcdef01234567
    - source: https://github.com/yourorg/eve-ops-skills
      ref: fedcba9876543210fedcba9876543210fedcba98
```

All packs install their skills to the same agent list. No repetition.

If `install_agents` is omitted, it defaults to `[claude-code]`.

### Full Entry (With Overrides)

When you need to deviate from defaults:

```yaml
x-eve:
  install_agents: [claude-code, codex, gemini-cli]

  packs:
    - source: https://github.com/yourorg/eve-software-factory
      ref: 0123456789abcdef0123456789abcdef01234567

      # Override: install skills to a subset of agents (rare)
      install_agents: [claude-code]

      # Override: disable metadata import (treat AgentPack as SkillPack)
      import: false
```

Override fields are additive — only specify what differs from the default.

### Inline Packs (Same Repo)

```yaml
x-eve:
  packs:
    - source: ./agentpacks/software-factory
      # ref omitted: pinned by the project's own git ref
```

Local packs follow the same layout and resolution rules. The only difference
is that `ref` is optional (the project's git ref is the pin).

---

## Slug Namespacing (Automatic)

Agent slugs must be org-unique. This is an invariant, not a config option.

**Rule**: when importing agents from a pack, the system automatically prefixes
every agent's slug with `{project_slug}-`. This applies to the `slug` field only,
never to agent IDs used in internal references.

Given project slug `myapp` and a pack `agents.yaml`:

```yaml
agents:
  factory_intake:         # agent ID (pack-local, stable)
    slug: factory-intake  # becomes "myapp-factory-intake"
    skill: factory-intake
```

If the agent omits `slug`, one is auto-generated from the agent ID:
`factory_intake` -> slug `myapp-factory-intake`.

**Internal references are never prefixed.** When `teams.yaml` says:

```yaml
teams:
  factory_ops:
    lead: factory_intake
    members: [reviewer_security, reviewer_performance]
```

These reference agent IDs, not slugs. IDs are pack-local. Slugs are the
org-visible surface. The resolution layer maintains the mapping.

**Override**: a project overlay can set an explicit `slug` on any agent to
bypass auto-prefixing. This is the escape hatch for cases where you need a
specific slug.

---

## Overlay Model

When packs are present, the project's local config files are treated as
**overlays** over pack bases:

- `agents/agents.yaml` overlays pack agents
- `agents/teams.yaml` overlays pack teams
- `agents/chat.yaml` overlays pack chat routes

If no packs are present, these files work exactly as they do today (no change).

### Merge Semantics

Inspired by RFC 7396 (JSON Merge Patch). One rule: **deep-merge maps; set a
value to `null` to remove it.**

#### agents.yaml / teams.yaml (Map-Keyed)

Base is a map keyed by ID. Overlay deep-merges matching keys.

**Override an agent's policy:**

```yaml
version: 1
agents:
  factory_intake:
    policies:
      permission_policy: default
```

**Remove an agent entirely:**

```yaml
version: 1
agents:
  reviewer_simplicity: null
```

**Add a new agent not in the pack:**

```yaml
version: 1
agents:
  my_custom_agent:
    slug: my-custom-agent
    skill: my-custom-skill
    workflow: assistant
```

Teams follow the same pattern:

```yaml
version: 1
teams:
  factory_ops:
    members: [reviewer_security, my_custom_agent]  # override members list
  unused_team: null                                 # remove
```

#### chat.yaml (List with Stable IDs)

Routes are a list, but each route has an `id`. Overlay routes are matched by
`id` and treated as upserts.

**Override a route's pattern:**

```yaml
version: 1
routes:
  - id: route_factory_intake
    match: "^intake\\b"
```

Deep-merges into the base route with the same `id`. Unmentioned fields are
preserved.

**Remove a route:**

```yaml
version: 1
routes:
  - id: route_factory_default
    _remove: true
```

**Add a new route:**

```yaml
version: 1
routes:
  - id: route_my_custom
    match: "^custom\\b"
    target: agent:my_custom_agent
```

Routes not present in the base are appended.

#### x-eve.yaml (Harness Policy)

Harness policy fragments are deep-merged in this order:
1. Pack `x-eve.yaml` fragments, in manifest-listed order (first pack is base)
2. Project's `x-eve` block from `.eve/manifest.yaml` (project always wins)

```yaml
# Project manifest — override a profile from the pack
x-eve:
  agents:
    profiles:
      primary-orchestrator:
        - harness: mclaude
          model: opus-4.5
          reasoning_effort: x-high   # project wants higher effort
```

### Merge Precedence (Multi-Pack)

When multiple packs are present:

1. Packs are merged in manifest-listed order (first = base, later = overlay).
2. If two packs define the same agent ID, it is a **sync-time error** unless one
   of them is the project overlay. Packs should not silently shadow each other.
3. Project local files overlay the merged pack result. Project always wins.

This makes conflicts loud and explicit rather than silently last-wins.

---

## Resolution: Single-Pass at Sync Time

All resolution happens during `eve agents sync`. The worker never independently
fetches or resolves packs — it reads the pre-resolved state.

### Sync-Time Resolution (`eve agents sync`)

```
1. Read .eve/manifest.yaml
2. For each pack in x-eve.packs:
   a. Fetch pack source at pinned ref
      - Remote: git clone at SHA into resolver cache
      - Local: read from repo checkout
   b. Read eve/pack.yaml (required for AgentPacks; absent = SkillPack)
   c. Load imported YAML (agents/teams/chat/x-eve) from paths in pack.yaml
   d. Apply automatic slug prefixing ({project_slug}-) to all agent slugs
3. Merge all pack bases in listed order (error on agent ID collisions between packs)
4. Deep-merge project overlays (agents/teams/chat.yaml) on top
5. Deep-merge project x-eve on top of pack x-eve fragments
6. Validate effective config:
   - Every agent's skill exists in at least one pack's skills/ directory
   - All team/route references point to valid agent/team IDs
   - All slugs are unique within the effective config
   - Route regex patterns are valid
7. Write .eve/packs.lock.yaml (resolved state for reproducibility)
8. Sync effective config to the API (unchanged API shape)
9. Store resolved pack refs + effective manifest for worker consumption
```

### Job-Time Skill Installation (Worker)

The worker reads the resolved manifest (stored by sync) and installs skills:

```
1. Read resolved pack list from sync artifacts
2. For each pack:
   a. Fetch pack source at the exact ref recorded in the lock
   b. Install all skills: skills add <packPath> -a <agent> -y --all
      for each agent in install_agents
3. Set DISABLE_TELEMETRY=1 in runner environment
```

The worker does **not** resolve overlays, merge configs, or make decisions.
It runs `skills add` with the exact refs that sync already validated. If a fetch
fails, the job fails fast — no partial state.

### Canonical Directories (skills.sh Agent Mapping)

- Claude Code (`-a claude-code`): `.claude/skills/`
- Codex (`-a codex`): `.agents/skills/`
- Gemini CLI (`-a gemini-cli`): `.agents/skills/`

Use the skills.sh symlink install method: one canonical copy in `.agents/skills/`,
agent-specific directories are symlinks. Note: verify symlink support in the
worker container filesystem. Fall back to copy mode if needed.

---

## Lockfile: `.eve/packs.lock.yaml`

Sync produces a lockfile recording the fully resolved state:

```yaml
# Auto-generated by eve agents sync. Do not edit.
resolved_at: 2026-02-08T14:30:00Z
project_slug: myapp

packs:
  - id: software-factory
    source: https://github.com/yourorg/eve-software-factory
    ref: 0123456789abcdef0123456789abcdef01234567
    pack_version: 1

effective:
  agents_count: 8
  teams_count: 2
  routes_count: 4
  profiles_count: 3

  # SHA-256 of the effective merged YAML (for drift detection)
  agents_hash: sha256:abc123...
  teams_hash: sha256:def456...
  chat_hash: sha256:789ghi...
```

The lockfile is committed to the repo. It serves three purposes:

1. **Reproducibility**: anyone can verify what the last sync produced.
2. **Drift detection**: `eve agents sync --check` can compare current resolution
   against the lock and report changes without syncing.
3. **Worker trust**: the worker reads the lock to know exactly which refs to fetch.

---

## Fail-Fast Validation

All validation happens at sync time. No silent failures.

### Sync-Time Checks

| Check | Error |
|---|---|
| Remote pack missing `eve/pack.yaml` but has `eve/` dir | `Pack at {source} has eve/ directory but no pack.yaml` |
| Agent references a skill not found in any pack | `Agent {id} references skill {skill} not found in packs` |
| Team references a non-existent agent ID | `Team {id} references unknown agent {agent_id}` |
| Route references a non-existent agent/team | `Route {id} targets unknown {target}` |
| Two packs define the same agent ID | `Agent ID {id} defined in both pack {a} and pack {b}` |
| Slug collision after prefixing | `Slug {slug} collides (org-unique constraint)` |
| Invalid route regex | `Route {id} has invalid regex: {pattern}` |
| Pack fetch fails (network, auth, bad ref) | `Failed to fetch pack {source} at ref {ref}: {error}` |

### Worker-Time Checks

| Check | Error |
|---|---|
| Lock ref doesn't match manifest ref | `Pack {id} ref mismatch: lock={a} manifest={b}; re-run eve agents sync` |
| `skills add` fails | `Failed to install skills from pack {id}: {error}` |

---

## Provenance + Diagnostics

Pack resolution should be observable:

- `eve agents config` shows which packs contributed which agents/profiles/config,
  with provenance annotations (pack ID + ref).
- `eve job diagnose` includes resolved pack versions from the lockfile.
- `eve packs status` shows current lock state vs. manifest (drift check).

---

## Example: Software Factory as an AgentPack

### Install

Add two lines to `.eve/manifest.yaml`:

```yaml
x-eve:
  install_agents: [claude-code, codex, gemini-cli]
  packs:
    - source: https://github.com/yourorg/eve-software-factory
      ref: 0123456789abcdef0123456789abcdef01234567
```

Run:

```bash
eve agents sync --project myapp --ref HEAD
```

Done. All factory agents, teams, routes, and harness profiles are live.
Slugs are auto-prefixed: `myapp-factory-intake`, `myapp-factory-review-security`, etc.

### Customize

Create a small overlay in `agents/agents.yaml`:

```yaml
version: 1
agents:
  reviewer_simplicity: null                     # don't need this reviewer
  factory_intake:
    policies:
      permission_policy: default                # relax policy for intake
```

Re-sync. The overlay is applied on top of the pack base.

### Upgrade

Bump the ref:

```yaml
  packs:
    - source: https://github.com/yourorg/eve-software-factory
      ref: new_sha_after_pack_update_here_0000000000
```

Re-sync. Overlays survive — only the base changes.

---

## Beyond Migration: Make Skills/Packs First-Class

### Workflow Skills

A pack can ship workflow skills and their config/resources. The project manifest
can map `workflows.<name>.skill = <skill-name>`. Invocation stays job-based.

See: `docs/system/skills-workflows.md`, `docs/system/workflows.md`.

### Pack Dependencies (Future)

Packs cannot currently depend on other packs. This is intentional — it keeps
the resolution model simple (flat list, no DAG). If a system needs multiple packs,
the consumer lists them all. This may change if we see real demand for
transitive pack dependencies, but YAGNI for now.

---

## Implementation Plan

The migration is split into two phases to reduce risk. Each phase is
independently shippable.

### Phase 1: Tool Swap (OpenSkills -> skills.sh)

Replace the skill installation tool. No new concepts.

**Changes:**

- Worker image (`apps/worker/Dockerfile`): install `@vercel/skills` (or bundle
  the `skills` CLI); remove `openskills`.
- Worker CLI (`packages/worker-cli/src/lib/skills.ts`):
  - Replace `openskills install <source> --universal` with
    `skills add <source> -a <agent> -y --all`.
  - Replace `openskills sync` with appropriate AGENTS.md update (or remove if
    skills.sh handles it).
  - Keep reading `skills.txt` for now (unchanged manifest format).
- Eve CLI (`packages/cli/src/commands/skills.ts`):
  - Same tool swap for local `eve skills install`.
- Worker environment: set `DISABLE_TELEMETRY=1`.
- Tests: update `apps/api/test/integration/skills-hook-smoke.integration.test.ts`
  to assert `skills add` not `openskills`.

**Validation:** existing `skills.txt` projects install correctly with skills.sh.
No new features, no new config — just a tool swap.

### Phase 2: AgentPacks + Manifest Migration

Add the composition layer, then retire `skills.txt`.

**Changes:**

- Shared:
  - New: `packages/shared/src/lib/pack-resolver.ts` — fetch pack at ref, read
    `pack.yaml`, load imported YAML, apply slug prefixing.
  - New: `packages/shared/src/lib/overlay-merge.ts` — RFC 7396-style deep-merge
    with `null`-removal for maps, id-based upsert for route lists.
  - New: `packages/shared/src/schemas/pack.ts` — Zod schema for `pack.yaml` and
    `x-eve.packs` manifest entries.
- Eve CLI:
  - `packages/cli/src/commands/agents.ts` — sync uses pack resolver + overlay
    merge before posting to API. Writes `.eve/packs.lock.yaml`.
  - New: `packages/cli/src/commands/packs.ts` — `eve packs status`, `eve packs resolve --dry-run`.
- Worker CLI:
  - `packages/worker-cli/src/lib/skills.ts` — reads resolved manifest / lockfile
    instead of `skills.txt`. Installs skills via `skills add` at locked refs.
- API:
  - `apps/api/src/projects/projects.service.ts` — sync endpoint stores provenance
    metadata (pack refs) alongside effective config.
- Migration:
  - Delete `skills.txt` and `parseSkillsManifest()`.
  - Remove `openskills` references if any remain after Phase 1.
  - Add `x-eve.packs` to manifest schema.
  - Update `.eve/hooks/on-clone.sh` to use `eve-worker skills install`
    (now packs-aware).
- Tests:
  - Integration tests for pack resolution + overlay merge + slug prefixing.
  - Integration test for multi-pack conflict detection.
  - E2E test: pack install -> sync -> job claim -> skill available in harness.
- Docs:
  - Update `docs/system/skills.md` and `docs/system/skillpacks.md`.
  - New: `docs/system/agentpacks.md`.

### Migration Path for Existing Projects

This is a flag-day migration. All projects must move from `skills.txt` to
`x-eve.packs` at the same time as the Phase 2 deploy.

For each project:
1. Convert `skills.txt` entries to `x-eve.packs` entries (with pinned SHAs).
2. Remove `skills.txt`.
3. Run `eve agents sync`.

We should provide a one-time migration script: `eve migrate skills-to-packs`
that reads `skills.txt`, resolves current refs, and writes the equivalent
`x-eve.packs` block.

---

## Key Technical Decisions

| Decision | Rationale |
|---|---|
| `pack.yaml` is required for AgentPacks | Packs must be self-describing. Eliminates import path repetition in consumer manifests. |
| No `kind` field in manifest | Inferred from presence of `pack.yaml`. Less ceremony. |
| Automatic slug prefixing | Org-unique slugs are an invariant, not a config option. Reduces manifest boilerplate. |
| RFC 7396-style merge (null = remove) | Standard, well-understood, one rule for all types. No custom `_remove` arrays. |
| Single resolution at sync time | Eliminates split-brain risk between CLI and worker. Worker is a dumb executor. |
| Agent ID collisions between packs are errors | Prevents silent shadowing. Forces explicit resolution in overlays. |
| No selective skill install | All skills from a pack are installed. Simplifies validation — every agent in the pack has its skill available. |
| No inter-pack dependencies | Keeps resolution flat (list, not DAG). Consumer lists all needed packs. YAGNI. |
| `install_agents` is project-level | Every pack in a project targets the same agents. No per-pack repetition. |
| Lockfile committed to repo | Reproducibility, drift detection, worker trust. |

---

## skills.sh Constraints and Workarounds

skills.sh has limitations relevant to this design:

| Constraint | Our Workaround |
|---|---|
| No built-in ref pinning (`add` always fetches default branch) | We clone at pinned SHA ourselves; pass local path to `skills add`. |
| Project-scoped skills have no update tracking | Our lockfile + `eve packs status` provides this. |
| Symlinks may fail on some filesystems | Worker falls back to copy mode. Test in container. |
| No private registry | Use private git repos with SSH/token auth. |
| Telemetry on by default | `DISABLE_TELEMETRY=1` in worker environment. |
| GitHub API rate limits on `check`/`update` | We don't use these commands; we manage refs ourselves. |
