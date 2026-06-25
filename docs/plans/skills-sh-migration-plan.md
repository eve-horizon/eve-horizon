# Plan: Skills.sh Migration + Eve AgentPacks

Date: 2026-02-08
Owner: Eve Horizon
Status: Proposed

Design doc: `docs/ideas/skills-sh-migration.md`

## Goal

Replace OpenSkills with skills.sh and introduce Eve AgentPacks — a composition
primitive that lets projects adopt complex multi-agent systems (e.g. the Software
Factory) via a single manifest reference plus small overlays. Upgrades become
"bump ref, re-sync".

## Non-Goals

- No new API endpoints for pack management (sync endpoint shape is unchanged).
- No inter-pack dependency resolution (flat list only).
- No selective skill install (all skills from a pack are installed).
- No private registry or discovery service (private git repos with auth suffice).
- No changes to the harness runtime or job execution model.

## Design Principles

1. Packs are self-describing (`pack.yaml` required, consumer never repeats import paths).
2. Convention over configuration (common case = two-line manifest entry).
3. Single resolution time (sync resolves everything; worker is a dumb executor).
4. Standard merge semantics (RFC 7396-inspired: deep-merge maps, `null` to remove).
5. Automatic slug namespacing (invariant, not a config option).
6. Fail fast (all validation at sync time, no silent failures).

---

## Phase 1: Tool Swap (OpenSkills -> skills.sh)

Replace the skill installation tool. No new concepts, no manifest changes.
`skills.txt` continues to work.

### 1.1 Worker Image

**File:** `apps/worker/Dockerfile`

- Install `@vercel/skills` (or vendor the `skills` binary) into the worker image.
- Remove `openskills` binary/package.
- Set `DISABLE_TELEMETRY=1` in the image environment.

Verification: `skills --version` succeeds in the built image.

### 1.2 Worker CLI: Replace Install Commands

**File:** `packages/worker-cli/src/lib/skills.ts`

Current flow:
```
openskills install <source> --universal --yes
openskills sync --yes
```

New flow:
```
skills add <source> -a claude-code -y --all
skills add <source> -a codex -y --all
skills add <source> -a gemini-cli -y --all
```

Changes:
- Replace `commandExists('openskills')` check with `commandExists('skills')`.
- Replace `execOrThrow('openskills', ['install', ...])` with
  `execOrThrow('skills', ['add', source, '-a', agent, '-y', '--all'])`.
- Loop over a default agent list: `['claude-code', 'codex', 'gemini-cli']`.
- Remove `openskills sync` call. Evaluate whether skills.sh auto-updates
  `AGENTS.md`; if not, either remove the AGENTS.md sync step or implement a
  lightweight replacement.
- Keep `parseSkillsManifest()` reading `skills.txt` (unchanged for Phase 1).

**File:** `packages/worker-cli/src/commands/skills.ts`

- Update `skillsInstall()` to call the new lib functions.

### 1.3 Eve CLI: Replace Install Commands

**File:** `packages/cli/src/commands/skills.ts`

Same tool swap as worker CLI:
- Replace `openskills install` with `skills add`.
- Keep `skills.txt` parsing unchanged.

### 1.4 Symlink Verification

skills.sh defaults to symlink install (one canonical copy in `.agents/skills/`,
symlinks from agent-specific dirs). Verify this works in:
- Local dev (macOS, Linux).
- Worker container (Alpine/Debian — may need `copy` fallback).

If symlinks fail in container, add `--copy` flag to the `skills add` calls in
the worker CLI only.

### 1.5 Tests

**File:** `apps/api/test/integration/skills-hook-smoke.integration.test.ts`

- Assert the on-clone hook invokes `skills add`, not `openskills install`.

**New test:** `packages/worker-cli/test/skills-install.test.ts`

- Unit test: `parseSkillsManifest()` with `skills.txt` fixture (unchanged).
- Unit test: generated `skills add` commands for each agent.

### 1.6 Acceptance Criteria

- [ ] Worker image builds with `skills` CLI, no `openskills`.
- [ ] `eve-worker skills install` installs from `skills.txt` using `skills add`.
- [ ] `eve skills install` installs from `skills.txt` using `skills add`.
- [ ] Skills appear in `.agents/skills/` and `.claude/skills/` (symlink or copy).
- [ ] `DISABLE_TELEMETRY=1` is set in worker environment.
- [ ] All existing integration tests pass.

---

## Phase 2: AgentPacks + Manifest Migration

Add the composition layer, then retire `skills.txt`.

### 2.1 Schemas

#### `pack.yaml` Schema

**New file:** `packages/shared/src/schemas/pack.ts`

```typescript
import { z } from 'zod';

export const PackYamlSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).regex(/^[a-z0-9-]+$/),
  imports: z.object({
    agents: z.string().min(1),              // relative path
    teams: z.string().min(1),               // relative path
    chat: z.string().min(1).optional(),     // optional
    x_eve: z.string().min(1).optional(),    // optional
  }),
});

export type PackYaml = z.infer<typeof PackYamlSchema>;
```

#### Manifest `x-eve.packs` Schema

**File:** `packages/shared/src/schemas/manifest.ts` (extend existing)

```typescript
const PackEntrySchema = z.object({
  source: z.string().min(1),                                    // git URL or local path
  ref: z.string().length(40).optional(),                        // 40-char SHA (required for remote)
  install_agents: z.array(z.string()).optional(),                // per-pack override
  import: z.union([z.literal(false), z.undefined()]).optional(), // disable metadata import
});

// Add to ManifestXeveSchema:
//   install_agents: z.array(z.string()).optional()
//   packs: z.array(PackEntrySchema).optional()
```

Validation rules:
- `ref` is required when `source` is a URL (starts with `http`, `git@`, `github:`).
- `ref` is optional when `source` is a local path (starts with `./`, `../`, `/`).
- `install_agents` defaults to `['claude-code']` at project level if omitted.

#### Lockfile Schema

**New file:** `packages/shared/src/schemas/pack-lock.ts`

```typescript
export const PackLockSchema = z.object({
  resolved_at: z.string().datetime(),
  project_slug: z.string(),
  packs: z.array(z.object({
    id: z.string(),
    source: z.string(),
    ref: z.string().length(40),
    pack_version: z.number().int(),
  })),
  effective: z.object({
    agents_count: z.number().int(),
    teams_count: z.number().int(),
    routes_count: z.number().int(),
    profiles_count: z.number().int(),
    agents_hash: z.string(),
    teams_hash: z.string(),
    chat_hash: z.string(),
  }),
});
```

### 2.2 Pack Resolver

**New file:** `packages/shared/src/lib/pack-resolver.ts`

Responsibilities:
1. Fetch a pack source at a pinned ref.
2. Read and validate `eve/pack.yaml`.
3. Load imported YAML files from paths declared in `pack.yaml`.
4. Apply automatic slug prefixing to agent slugs.
5. Return a `ResolvedPack` object.

```typescript
interface ResolvedPack {
  id: string;
  source: string;
  ref: string;
  agents: Record<string, AgentEntry>;    // from pack agents.yaml
  teams: Record<string, TeamEntry>;      // from pack teams.yaml
  chat: ChatConfig | null;               // from pack chat.yaml (optional)
  xEve: Record<string, unknown> | null;  // from pack x-eve.yaml (optional)
  skillPaths: string[];                  // discovered SKILL.md directories
}
```

#### Fetch Strategy

```
resolvePack(entry, projectSlug, repoRoot?):
  if source is local path:
    packDir = resolve(repoRoot, source)
  else:
    packDir = cloneAtRef(source, ref)  // shallow clone, cache by SHA

  packYamlPath = join(packDir, 'eve/pack.yaml')
  if exists(packYamlPath):
    packYaml = parse + validate PackYamlSchema
    load agents/teams/chat/x_eve from packYaml.imports paths
    apply slug prefixing (projectSlug + '-' + slug)
    return ResolvedPack with metadata
  else if exists(join(packDir, 'eve/')):
    error: "Pack has eve/ directory but no pack.yaml"
  else:
    return ResolvedPack with skills only (SkillPack)
```

#### Slug Prefixing Rules

Applied to agent entries loaded from a pack:

1. If agent has explicit `slug`: prefix it → `{projectSlug}-{slug}`.
2. If agent has no `slug`: generate from ID → `{projectSlug}-{id}` (underscores to hyphens).
3. **Never** prefix agent IDs (map keys). IDs are pack-local references.
4. **Never** prefix references in teams (lead, members) or routes (target).
   These reference agent IDs, not slugs.

The resolution layer maintains the mapping: `agentId -> prefixedSlug`.

#### Git Clone Cache

Remote packs are cloned into a deterministic cache directory:
```
~/.eve/cache/packs/{sha}/
```

Keyed by SHA, so the same ref is never cloned twice. Cache is append-only;
cleanup is manual or via `eve cache clean`.

### 2.3 Overlay Merge

**New file:** `packages/shared/src/lib/overlay-merge.ts`

A single merge function that handles all config types.

#### Core Algorithm: `deepMerge(base, overlay)`

RFC 7396-inspired with one extension for list-with-id (routes):

```typescript
function deepMerge(base: unknown, overlay: unknown): unknown {
  // null in overlay = remove
  if (overlay === null) return undefined;

  // both objects: recurse
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const result = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      if (value === null) {
        delete result[key];
      } else if (key in result) {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  // overlay replaces base for non-object types
  return overlay;
}
```

#### Map-Keyed Configs (agents.yaml, teams.yaml)

```typescript
function mergeAgents(base: AgentsYaml, overlay: AgentsYaml): AgentsYaml {
  return {
    version: overlay.version ?? base.version,
    agents: deepMerge(base.agents, overlay.agents),
  };
}
```

Examples:
- Override a field: `agents: { factory_intake: { policies: { ... } } }` → deep-merges.
- Remove an agent: `agents: { reviewer_simplicity: null }` → deleted from result.
- Add an agent: `agents: { my_agent: { ... } }` → inserted.

#### List-with-ID Configs (chat.yaml routes)

Routes are a list but each has a stable `id`. Treat as an id-keyed map for merge
purposes:

```typescript
function mergeRoutes(base: Route[], overlay: Route[]): Route[] {
  const result = new Map(base.map(r => [r.id, r]));

  for (const route of overlay) {
    if (route._remove) {
      result.delete(route.id);
    } else if (result.has(route.id)) {
      result.set(route.id, deepMerge(result.get(route.id), route));
    } else {
      result.set(route.id, route);  // append new route
    }
  }

  return Array.from(result.values());
}
```

#### Harness Policy (x-eve.yaml)

Pure deep-merge in listed order:

```typescript
function mergeXEve(packFragments: XEve[], projectXEve: XEve): XEve {
  let result = {};
  for (const fragment of packFragments) {
    result = deepMerge(result, fragment);
  }
  result = deepMerge(result, projectXEve);  // project always wins
  return result;
}
```

### 2.4 Full Resolution Pipeline

**Where:** `packages/cli/src/commands/agents.ts` (extend `sync` subcommand)

The sync command gains a pack resolution step before posting to the API.

```
resolveAndSync(manifest, repoRoot, projectSlug):
  1. Parse x-eve.packs from manifest
  2. installAgents = manifest.x-eve.install_agents ?? ['claude-code']

  3. For each pack entry:
     resolved = resolvePack(entry, projectSlug, repoRoot)
     add to resolvedPacks[]

  4. Check for agent ID collisions across packs:
     for each pair of packs, if they share an agent ID → error

  5. Merge pack bases in listed order:
     mergedAgents = {}
     mergedTeams = {}
     mergedRoutes = []
     xEveFragments = []
     for each resolved pack:
       mergedAgents = mergeAgents(mergedAgents, pack.agents)
       mergedTeams = mergeTeams(mergedTeams, pack.teams)
       mergedRoutes = mergeRoutes(mergedRoutes, pack.chat?.routes ?? [])
       if pack.xEve: xEveFragments.push(pack.xEve)

  6. Load project overlay files (agents.yaml, teams.yaml, chat.yaml):
     if files exist, deep-merge on top of merged pack result

  7. Merge x-eve: packs first, then project manifest x-eve on top

  8. Validate effective config:
     - Every agent's skill exists in at least one pack's skillPaths
     - All team leads/members reference valid agent IDs
     - All route targets reference valid agent/team IDs
     - All slugs unique within effective config
     - All route regex patterns valid

  9. Write .eve/packs.lock.yaml

  10. POST effective config to API (unchanged shape):
      agents_yaml, teams_yaml, chat_yaml, git_sha, branch

  11. Store provenance: pack refs alongside effective config
```

#### When No Packs Are Present

If `x-eve.packs` is empty or absent, the sync command works exactly as it does
today — reads local YAML files and posts them. Zero behavior change for
projects that don't use packs.

### 2.5 Worker CLI: Read Lockfile

**File:** `packages/worker-cli/src/lib/skills.ts`

Replace `skills.txt` reading with lockfile/manifest reading:

```
skillsInstall(projectRoot):
  manifest = readManifest(projectRoot)
  packs = manifest.x-eve.packs ?? []
  installAgents = manifest.x-eve.install_agents ?? ['claude-code']

  if packs is empty:
    // No packs — nothing to install via this path
    // (project may still have local skills in .claude/skills/)
    return

  lock = readLockfile(projectRoot)  // .eve/packs.lock.yaml

  for each pack in packs:
    // Verify lock matches manifest
    lockedPack = lock.packs.find(p => p.source === pack.source)
    if lockedPack.ref !== pack.ref:
      error("Pack ref mismatch — re-run eve agents sync")

    // Fetch at locked ref
    packDir = fetchPackAtRef(pack.source, pack.ref)

    // Install all skills for each agent
    for each agent in (pack.install_agents ?? installAgents):
      exec: skills add <packDir> -a <agent> -y --all

  setEnv('DISABLE_TELEMETRY', '1')
```

### 2.6 API: Store Provenance

**File:** `apps/api/src/projects/projects.service.ts`

Extend the sync endpoint to accept and store pack provenance metadata alongside
the effective config:

```typescript
// Add to AgentsSyncRequest:
interface AgentsSyncRequest {
  // ... existing fields ...
  pack_refs?: Array<{
    id: string;
    source: string;
    ref: string;
  }>;
}
```

Store `pack_refs` in the project's agent config record. This enables
`eve agents config` to show provenance and `eve job diagnose` to include
resolved pack versions.

No new API endpoints. The sync shape is extended, not changed.

### 2.7 CLI: Packs Commands

**New file:** `packages/cli/src/commands/packs.ts`

Convenience commands for working with packs:

```
eve packs status [--project <id>]
  Read .eve/packs.lock.yaml and show:
  - Each pack: id, source, ref (short SHA), agent/team/route counts
  - Drift: whether re-resolving would produce different hashes

eve packs resolve --dry-run [--project <id>]
  Run full resolution pipeline without syncing to API.
  Print effective config to stdout. Useful for debugging overlays.
```

### 2.8 Migration: Retire skills.txt

**File:** `packages/worker-cli/src/lib/skills.ts`

- Delete `parseSkillsManifest()`, `parseSkillSource()`, `expandGlobPattern()`.
- Remove all `skills.txt` references.

**File:** `packages/cli/src/commands/skills.ts`

- Remove `skills.txt` parsing.
- `eve skills install` now reads `x-eve.packs` from the manifest.

**File:** `.eve/hooks/on-clone.sh`

- No change needed (still calls `eve-worker skills install`, which is now
  packs-aware).

**Delete:** `skills.txt` from this repo and all template repos.

#### Migration Script

**New file:** `packages/cli/src/commands/migrate.ts`

```
eve migrate skills-to-packs [--cwd <path>]

  1. Read skills.txt
  2. For each source:
     - If git URL: resolve HEAD SHA → create pack entry with ref
     - If local path: create pack entry with source as-is
  3. Check if source has eve/pack.yaml → it's an AgentPack
  4. Write x-eve.packs block to .eve/manifest.yaml
  5. Print diff for user review
  6. Prompt: "Remove skills.txt? [y/N]"
```

### 2.9 Tests

#### Unit Tests

**New file:** `packages/shared/test/overlay-merge.test.ts`

| Test Case | Input | Expected |
|---|---|---|
| Deep-merge agent field | base `{a: {x: 1}}` + overlay `{a: {y: 2}}` | `{a: {x: 1, y: 2}}` |
| Null removes agent | base `{a: {}, b: {}}` + overlay `{a: null}` | `{b: {}}` |
| Add new agent | base `{a: {}}` + overlay `{b: {}}` | `{a: {}, b: {}}` |
| Nested null removes field | base `{a: {x: 1, y: 2}}` + overlay `{a: {x: null}}` | `{a: {y: 2}}` |
| Route upsert by id | base `[{id: r1, match: "a"}]` + overlay `[{id: r1, match: "b"}]` | `[{id: r1, match: "b"}]` |
| Route remove | base `[{id: r1}, {id: r2}]` + overlay `[{id: r1, _remove: true}]` | `[{id: r2}]` |
| Route append | base `[{id: r1}]` + overlay `[{id: r2}]` | `[{id: r1}, {id: r2}]` |
| Multi-pack x-eve merge | fragments `[{a: 1}, {b: 2}]` + project `{a: 3}` | `{a: 3, b: 2}` |

**New file:** `packages/shared/test/pack-resolver.test.ts`

| Test Case | Expected |
|---|---|
| Local pack with pack.yaml | Loads agents/teams/chat/x-eve from declared paths |
| Local pack without eve/ dir | Returns SkillPack (skills only, no metadata) |
| Local pack with eve/ but no pack.yaml | Error: "has eve/ directory but no pack.yaml" |
| Slug prefixing with explicit slug | `factory-intake` → `myapp-factory-intake` |
| Slug prefixing without slug | ID `factory_intake` → slug `myapp-factory-intake` |
| Agent IDs in teams not prefixed | `lead: factory_intake` stays unchanged |

**New file:** `packages/shared/test/pack-lock.test.ts`

| Test Case | Expected |
|---|---|
| Lock round-trip | Write lock → read lock → identical |
| Drift detection | Change pack ref in manifest → drift detected |
| Lock/manifest mismatch | Different refs → error message |

#### Integration Tests

**File:** `apps/api/test/integration/agents-sync.integration.test.ts` (extend)

- Test: sync with pack provenance metadata stores and returns pack refs.
- Test: `eve agents config` includes provenance annotations.

**New file:** `packages/cli/test/integration/pack-resolution.integration.test.ts`

Using fixture repos:

```
tests/fixtures/packs/
  simple-skillpack/           # skills only, no eve/
    skills/hello/SKILL.md
  simple-agentpack/           # skills + eve/ metadata
    skills/greeter/SKILL.md
    eve/
      pack.yaml
      agents.yaml
      teams.yaml
  conflict-pack-a/            # defines agent "reviewer"
    eve/pack.yaml
    eve/agents.yaml
  conflict-pack-b/            # also defines agent "reviewer"
    eve/pack.yaml
    eve/agents.yaml
```

| Test Case | Expected |
|---|---|
| Single AgentPack resolves | Effective config has pack agents + slugs prefixed |
| SkillPack resolves (no metadata) | Skills installed, no agents imported |
| Overlay removes agent | Agent absent from effective config |
| Overlay overrides field | Field value from overlay in effective config |
| Overlay adds agent | New agent present in effective config |
| Two packs, no conflicts | Merged result has agents from both |
| Two packs, agent ID collision | Sync-time error |
| Agent references missing skill | Sync-time error |
| Team references missing agent | Sync-time error |
| Route references missing target | Sync-time error |
| No packs in manifest | Behaves exactly as current sync (no change) |

#### E2E Test

**New file:** `tests/e2e/pack-install-sync-claim.test.ts`

Full flow: manifest with pack → sync → worker claims job → skills are installed
→ harness can read skill content.

### 2.10 Acceptance Criteria

- [ ] `pack.yaml` schema validates correctly (Zod).
- [ ] `x-eve.packs` manifest entries parse and validate.
- [ ] Pack resolver fetches remote packs at pinned SHA.
- [ ] Pack resolver reads local packs from repo checkout.
- [ ] Slug prefixing is automatic and correct (slugs prefixed, IDs untouched).
- [ ] Overlay merge handles add/override/remove for agents, teams, routes.
- [ ] Agent ID collisions between packs produce sync-time errors.
- [ ] Skill-agent reference mismatches produce sync-time errors.
- [ ] Lockfile is written and committed.
- [ ] Worker reads lockfile and installs skills at locked refs.
- [ ] Worker detects lock/manifest drift and errors.
- [ ] `eve packs status` shows resolved state.
- [ ] `eve packs resolve --dry-run` prints effective config.
- [ ] `eve migrate skills-to-packs` converts skills.txt to x-eve.packs.
- [ ] Projects without packs behave identically to today.
- [ ] All existing integration tests pass.

---

## File Change Summary

### New Files

| File | Purpose |
|---|---|
| `packages/shared/src/schemas/pack.ts` | Zod schemas: pack.yaml, pack entry, lockfile |
| `packages/shared/src/lib/pack-resolver.ts` | Fetch pack, read metadata, apply slug prefixing |
| `packages/shared/src/lib/overlay-merge.ts` | RFC 7396-style deep-merge + route upsert |
| `packages/cli/src/commands/packs.ts` | `eve packs status`, `eve packs resolve` |
| `packages/cli/src/commands/migrate.ts` | `eve migrate skills-to-packs` |
| `packages/shared/test/overlay-merge.test.ts` | Merge unit tests |
| `packages/shared/test/pack-resolver.test.ts` | Resolver unit tests |
| `packages/shared/test/pack-lock.test.ts` | Lockfile unit tests |
| `packages/cli/test/integration/pack-resolution.integration.test.ts` | Resolution integration tests |
| `tests/fixtures/packs/` | Fixture pack repos for tests |
| `tests/e2e/pack-install-sync-claim.test.ts` | Full E2E test |
| `docs/system/agentpacks.md` | AgentPack documentation |

### Modified Files

| File | Change |
|---|---|
| `apps/worker/Dockerfile` | Install `skills` CLI, remove `openskills` |
| `packages/worker-cli/src/lib/skills.ts` | Phase 1: tool swap. Phase 2: read lockfile instead of skills.txt |
| `packages/worker-cli/src/commands/skills.ts` | Call updated lib |
| `packages/cli/src/commands/skills.ts` | Phase 1: tool swap. Phase 2: read manifest packs |
| `packages/cli/src/commands/agents.ts` | Phase 2: pack resolution + overlay merge before sync |
| `packages/shared/src/schemas/manifest.ts` | Add `install_agents` and `packs` to `ManifestXeveSchema` |
| `apps/api/src/projects/projects.service.ts` | Store pack provenance on sync |
| `apps/api/test/integration/skills-hook-smoke.integration.test.ts` | Assert `skills add` |
| `apps/api/test/integration/agents-sync.integration.test.ts` | Test provenance storage |
| `docs/system/skills.md` | Update for skills.sh |
| `docs/system/skillpacks.md` | Update for AgentPacks |

### Deleted Files

| File | When |
|---|---|
| `skills.txt` | Phase 2 (after migration script run) |

---

## Rollout Sequence

```
Phase 1 (tool swap)
  1. Build worker image with skills CLI
  2. Update worker-cli + eve-cli to use skills add
  3. Deploy worker image
  4. Verify existing skills.txt projects install correctly
  5. Ship Phase 1

Phase 2 (AgentPacks)
  1. Implement schemas (pack.yaml, manifest packs, lockfile)
  2. Implement pack-resolver
  3. Implement overlay-merge
  4. Integrate into eve agents sync
  5. Implement worker lockfile reading
  6. Implement eve packs commands
  7. Write all tests, verify green
  8. Deploy API + CLI + worker
  9. Run eve migrate skills-to-packs on all projects
  10. Delete skills.txt, remove parseSkillsManifest
  11. Ship Phase 2
```

---

## Open Questions (Resolved)

1. **AGENTS.md sync**: ~~Do we still need AGENTS.md?~~
   **Decision: Drop entirely.** Not read by any runtime component (agents, harness,
   worker). Agent config flows through the API via `eve agents sync`. skills.sh
   doesn't generate it, and it was always documentation-only.

2. **Cache eviction**: ~~Should `eve cache clean` be a command?~~
   **Decision: Skip for now.** Manual cleanup sufficient pre-MVP. Add later if
   needed — trivial to implement.

3. **Lockfile format**: ~~YAML or JSON?~~
   **Decision: YAML (`.eve/packs.lock.yaml`).** Consistent with all other Eve
   config files (manifest, agents, teams, chat, pack.yaml).

4. **Worker container symlinks**: ~~Do containers support symlinks?~~
   **Decision: Yes, symlinks work.** Worker image uses `node:22-slim` (Debian-based),
   which fully supports symlinks. No `--copy` flag needed. If we ever switch to
   Alpine, add `--copy` then.

5. **Project slug source**: ~~Where does `{project_slug}` come from?~~
   **Decision: API project record.** The CLI already has project context during
   `eve agents sync`. The API project record is the authoritative slug source.
   Worker gets it via job context.
