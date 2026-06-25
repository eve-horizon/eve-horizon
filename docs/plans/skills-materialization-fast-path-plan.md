# Skills Materialization Fast Path Plan

> **Status**: Proposed
> **Created**: 2026-04-09
> **Updated**: 2026-04-09
> **Builds on**: `docs/plans/runtime-skill-materialization-plan.md`
> **Motivation**: Eve needs a clear public split between developer skills and runtime skills. Today those concerns are blurred, and `eve skills install` is sometimes used for work that should be manifest-driven runtime materialization.

## Recommendation

Make the split explicit and public:

- `skills.txt` at repo root is for developer coding agents working on the repo
- `.eve/manifest.yaml` is for skills Eve runtime agents need inside jobs

Keep `eve skills install` as the public developer command for refreshing local coding-agent skills from `skills.txt`.

Add a new Eve-native fast path:

- Canonical command: `eve skills materialize`

The new command should be manifest-driven and runtime-oriented. It should do zero `skills` subprocesses for manifest-resolved sources and produce the correct runtime skill folders by direct filesystem operations.

For external manifest refs, keep the manifest pointing at the original repo and pinned ref. Materialize from lockfile-backed resolved content into a project-local sidecar directory. Do not rewrite the manifest to a local path.

There is one deliberate exception:

- worker-executed software-engineering jobs may also need repo dev skills from `skills.txt`

That exception should be modeled as manifest-declared execution policy, not as a redefinition of what `skills.txt` means.

## Public Product Position

### Developer skills

Developer skills are:

- declared in root `skills.txt`
- refreshed with `eve skills install`
- meant for Claude Code, Codex, Gemini CLI, Pi, and other developer tools working on the repo locally

This is the public and normal developer workflow.

### Runtime skills

Runtime skills are:

- declared in `.eve/manifest.yaml`
- pinned by `.eve/packs.lock.yaml`
- materialized for Eve jobs by Eve-native logic

Runtime must not depend on `skills.txt`. The set of skills an Eve job sees should come entirely from the manifest-driven runtime path.

### Worker SE exception

When the worker is executing a software-engineering job against a repository, the harness may reasonably need the repo's dev skills from `skills.txt` in addition to runtime skills.

That is a worker-specific exception for SE-style repo work. It should not change the default rule that agent-runtime jobs are manifest-driven.

The clean model is:

- manifest declares named skill/execution modes
- job or orchestration chooses a mode
- agent-runtime and worker both honor the mode, but only worker SE jobs should normally request the dev-augmented mode

## Research Findings

### A. What the current developer install path does besides copying files

`../../opensource/agent-skills` is only a skill source repo. The extra behavior comes from our wrapper plus the `skills` binary itself.

Current Eve-side behavior in `packages/cli/src/commands/skills.ts`:

- Reads `skills.txt`
- Expands local directories and globs
- Filters `private-skills/`
- Reads `.eve/manifest.yaml` `x-eve.packs`
- Validates `.eve/packs.lock.yaml`
- Invokes `skills add` once per skill per agent
- Repairs `.claude/skills` linking after install

Current `skills` CLI behavior in `/opt/homebrew/lib/node_modules/skills/dist/cli.mjs`:

- Parses local paths, GitHub/GitLab repos, direct `SKILL.md` URLs, and well-known endpoints
- Clones remote repos and fetches remote skill content
- Heuristically discovers skills across many directories and plugin manifests
- Parses SKILL frontmatter and rejects entries without `name` and `description`
- Sanitizes install names from SKILL frontmatter, not directory names
- Copies content into canonical `.agents/skills/<name>`
- Creates per-agent symlinks or fallback copies
- Excludes `README.md`, `metadata.json`, `_*`, and `.git` while copying
- Detects many non-Eve agent types, supports interactive prompts, telemetry, update checks, and a global lock file

### Local benchmark

On 2026-04-09, a local probe run of:

```bash
eve skills install ~/dev/opensource/agent-skills
```

took about `1.5s` for 7 skills because Eve launched `skills add` 28 times (`7 skills x 4 agents`).

That is acceptable for an occasional developer refresh, but it is the wrong cost profile for on-clone hooks and runtime startup. The actual materialization work is much smaller than the process orchestration around it.

### Important correction to the earlier runtime draft

The fast path must install by parsed SKILL `name`, not by directory basename.

Example: in `agent-skills`, directory `skills/react-best-practices/` installs as `vercel-react-best-practices`. A directory-name-only materializer would create the wrong target paths and break parity with existing installs.

### B. `.agent/skills` vs `.agents/skills` naming inconsistency (FIXED)

The CLI uses `.agents/skills` (plural) as `UNIVERSAL_SKILLS_DIR` in `packages/cli/src/commands/skills.ts`. The Docker worker script (`docker/worker/eve-skills`) previously used `.agent/skills` (singular). Both created symlinks from `.claude/skills` but to different targets. This has been fixed — all code and docs now use `.agents/skills` (plural).

The `findSkillDirs()` walker already skips both `.agents` and `.agent` directories to avoid recursion into install targets. The materializer must canonicalize on one name.

**Decision**: Use `.agents/skills` (plural) everywhere. This is what the CLI uses and matches the upstream `skills` binary convention. The Docker worker script should be updated to match.

### C. `discoverSkillPaths()` already exists but returns paths, not install names

`packages/shared/src/lib/pack-resolver.ts` already has `discoverSkillPaths(packDir)` which recursively walks `<pack>/skills/` and returns full paths to directories containing `SKILL.md`. The `ResolvedPack` interface in `packages/shared/src/schemas/pack.ts` stores these as `skillPaths: string[]`.

However, these paths are raw filesystem paths. They do not include the parsed SKILL frontmatter `name` (the install name). The fast path materializer needs to layer install-name resolution on top of this existing discovery.

### D. Pack install path is also subprocess-heavy

The plan originally focused on `skills.txt` subprocess cost, but the pack install path in `installPackSkills()` (skills.ts lines 240-264) also calls `skills add` per agent per skill directory. For a pack with 10 skills and 4 agents, that is 40 subprocesses just for one pack. The materializer must eliminate subprocesses for both sources.

### E. `on-clone.sh` is the runtime entry point

The current `.eve/hooks/on-clone.sh` calls `eve skills install` as its first step. This is the hook that runs on agent-runtime and worker job provisioning for new workspaces. The materializer should replace this call with `eve skills materialize manifest` (or the runtime should invoke the materializer directly, bypassing the hook).

### F. Remote pack fetch uses broken shallow clone pattern

`fetchPackSource()` in `pack-resolver.ts` does `git clone --depth 1` then `git checkout <ref>`. This works only if `ref` is on the default branch HEAD. For arbitrary commit SHAs, the shallow clone may not contain the ref. Phase 2 must fix this: either use `git fetch --depth 1 origin <sha>` or a full clone.

## Goals

- Make the developer/runtime split explicit in product and docs
- Keep `eve skills install` as the public developer workflow from root `skills.txt`
- Zero network and zero `skills` subprocesses for manifest-resolved runtime sources
- Deterministic runtime materialization for Eve-supported agents: `claude-code`, `codex`, `gemini-cli`, `pi`
- Preserves external source-of-truth in manifest + lockfiles
- Supports runtime skill availability after clone without slow install hooks

## Non-Goals

- Replacing `skills` search, update, or well-known registry features
- Supporting every agent the upstream `skills` CLI knows about
- Rewriting manifest sources to local paths after materialization
- Replacing the public `skills.txt` developer workflow
- Solving every legacy remote `skills.txt` case in phase 1

## Command Model

### Keep

`eve skills install`

Use it for:

- root `skills.txt`
- developer coding agents working on the repo locally
- arbitrary remote repos and one-off installs for developer environments
- compatibility with the broader `skills` ecosystem

### Add

`eve skills materialize`

Use it for:

- remote manifest pack sources already pinned in `.eve/packs.lock.yaml`
- local manifest pack sources
- runtime/vendor materialization for cloned workspaces
- fast worker-side materialization from `skills.txt` when an SE job explicitly opts in

Suggested flags:

- `--from manifest|skills.txt`
- `--agents claude-code,codex,gemini-cli,pi`
- `--mode symlink|copy`
- `--runtime` to populate committed project-side materialized skills for clone-time use

Suggested shorthand:

- `eve skills materialize manifest`
- `eve skills materialize skills.txt`

`materialize` should remain distinct from `install` so developers do not confuse local dev-agent setup with runtime skill preparation.

`install` remains the public developer refresh command. `materialize` is the fast deterministic filesystem command.

## Recommended Policy Model

Put the selection mechanism in the manifest, but do not represent it as "worker always gets more packs".

Instead, add a named execution/skills mode concept. For example:

```yaml
x-eve:
  skill_modes:
    runtime:
      packs: runtime
    software-engineering:
      packs: runtime
      include_skills_txt: true
```

or, if we want explicit extra sources:

```yaml
x-eve:
  skill_modes:
    runtime:
      pack_set: runtime
    software-engineering:
      pack_set: runtime
      include_skills_txt: true
      extra_packs:
        - source: ./private-eve-dev-skills/eve-dev
```

Then jobs or orchestration can request:

- `skill_mode: runtime`
- `skill_mode: software-engineering`

Default:

- worker jobs default to `skill_mode: runtime`
- `software-engineering` is explicit opt-in only

### Why this is better than "worker has more packs"

- It keeps the policy declarative and reviewable in the manifest
- It avoids making executor type itself the source of truth
- It lets worker run both normal runtime jobs and SE jobs without special casing the whole executor
- It keeps `skills.txt` as dev skills while still allowing explicit worker SE opt-in
- It gives us room for future modes like `review`, `migration`, or `ops`

### Why this is better than putting dev packs directly into baseline `x-eve.packs`

- baseline manifest packs should describe runtime capability, not local developer ergonomics
- duplicating `skills.txt` sources into runtime pack lists creates drift
- many repos will want SE jobs to use dev skills only in specific job classes, not universally
- `skills.txt` remains a useful public convention for repo-local coding agents outside Eve jobs

## Core Design

### 1. Normalize sources into an Eve-native model

Introduce an internal `ResolvedSkillSource` model:

```ts
interface ResolvedSkillSource {
  id: string;
  source: string;
  ref?: string;
  origin: 'manifest-pack' | 'skills-txt';
  sourceType: 'local' | 'remote';
  resolvedRoot: string;
  installAgents: string[];
  skills: Array<{
    installName: string;
    skillPath: string;
  }>;
}
```

How it is populated:

- Manifest packs: reuse `resolvePack()` and `.eve/packs.lock.yaml`. Note that `ResolvedPack.skillPaths` already provides discovered paths — the materializer adds install-name resolution on top.
- `skills.txt`: local fast-path parser for worker SE use and developer-facing deterministic materialization. Reuses the existing `parseSkillsManifest()` and `findSkillDirs()` logic from `packages/cli/src/commands/skills.ts` but extracts it into the shared package.

And introduce a resolved mode:

```ts
interface ResolvedSkillMode {
  name: string;
  includeManifestPacks: boolean;
  includeSkillsTxt: boolean;
  extraPacks: PackEntry[];
}
```

The materializer should first resolve a mode, then resolve sources from that mode.

### 2. Discover skill install names from SKILL frontmatter

For every discovered skill directory:

- read `SKILL.md`
- parse frontmatter
- require `name` and `description`
- sanitize `name` with the same rules the current `skills` CLI uses

This is required for parity with current installs and to avoid name drift.

### 3. Materialize skills to a canonical Eve layout

Workspace outputs:

- `.agents/skills/<installName>/...` — the canonical shared skill directory (plural `.agents`, not singular `.agent`)
- `.claude/skills`
  - symlink to `../.agents/skills` when possible
  - otherwise per-skill overlay symlinks (for repos that commit `.claude/skills` as a real directory)
- `.codex/skills/<installName>` only when codex needs a different layout
- `.pi/skills/<installName>` only when a non-universal target needs it

**Note**: The Docker worker script (`docker/worker/eve-skills`) previously used `.agent/skills` (singular). It has been fixed to `.agents/skills` (plural) to match the CLI and the materializer.

Materialization rules:

- local manifest sources: prefer symlinks into `.agents/skills`
- local `skills.txt` sources: prefer symlinks into `.agents/skills`
- vendored external sources: copy into committed store, then symlink into `.agents/skills`
- later sources win on collision, but emit a warning with provenance

Copy exclusions (matching current `skills` CLI behavior):

- `README.md`, `metadata.json`, `_*` prefixed files, `.git`, `node_modules`

### 4. Use a committed sidecar for external runtime skills

Do not materialize external skills into `.eve/skills/`.

Reason: `docs/plans/skills-workflows-spec.md` already uses `.eve/skills/<skill>/...` as the conceptual location for project overrides. Mixing overrides and vendored source copies will become confusing quickly.

Use:

```text
.eve/materialized-skills/
  index.yaml
  <source-id>/
    <install-name>/
      SKILL.md
      references/
      scripts/
      assets/
```

`index.yaml` should record:

- original source
- pinned ref
- origin type
- install name
- source-relative path
- content hash

### 5. Execution policy differs by runtime

#### Agent Runtime

Agent runtime should materialize:

1. manifest-resolved local pack skills
2. committed external skills from `.eve/materialized-skills/`

Agent runtime should normally run with `skill_mode=runtime`.

Agent runtime should not read `skills.txt` unless a future explicit mode says so.

#### Worker Runtime

Worker runtime should support two modes:

1. default mode: `runtime` — same behavior as agent-runtime, manifest-driven only
2. SE mode: manifest-driven skills plus fast materialization from `skills.txt`

SE mode is for repo-focused software engineering jobs where the harness is acting like a developer agent working on the codebase.

The important distinction is executor policy, not source semantics:

- `skills.txt` still means dev skills
- manifest still means runtime skills
- worker SE mode is allowed to consume both

The recommended control flow is:

- manifest defines available modes
- orchestrator or job request selects a mode
- runtime resolves sources from the selected mode

If no mode is selected for a worker job, resolve `runtime`.

### 6. Runtime bridge consumes committed materialized externals

Runtime after clone should stay filesystem-only:

1. manifest-resolved local pack skills, for example from a local pack rooted in the repo
2. committed external skills from `.eve/materialized-skills/`
3. fast link into `.agents/skills`
4. fast bridge into `.claude/skills`

This keeps runtime startup fast and avoids network or `skills` subprocesses inside job startup.

In agent-runtime, `skills.txt` is not consulted in this flow.

In worker SE mode, `skills.txt` may be added as an extra local source set through the same materializer.

## Hook Model

The first split should be in manifest-declared, platform-controlled materialization policy, not in repo-authored hook names.

Current state: `.eve/hooks/on-clone.sh` calls `eve skills install` as its first step, before `pnpm install` and package builds. This is the hook that `runAcquireHooks()` in `packages/shared/src/invoke/workspace-hooks.ts` invokes for new workspaces in both agent-runtime and worker.

Recommended phase 1 behavior:

- keep existing shared `on-clone.sh` and `on-acquire.sh` semantics
- have the runtime invoke the materializer directly **before** running `on-clone.sh`, so skills are available to hook scripts
- update `on-clone.sh` to remove the `eve skills install` call (it becomes redundant after the materializer runs)
- have agent-runtime call materializer with the selected manifest mode, defaulting to `runtime`
- have worker call materializer with the selected manifest mode, defaulting to `runtime`
- only SE-style repo jobs should request `software-engineering`

Only add executor-specific hooks if we discover broader setup divergence beyond skills.

If we do need that later, the clean extension would be:

- `.eve/hooks/on-agent-clone.sh`
- `.eve/hooks/on-worker-clone.sh`

with `on-clone.sh` remaining the shared baseline hook.

## External Repo Strategy

### Manifest references

Preferred approach:

- keep the manifest referencing the original external repo
- keep the ref pinned in `.eve/packs.lock.yaml`
- materialize from the resolved pack cache or resolved pack checkout
- write vendored copies to `.eve/materialized-skills/`

Why this is better than rewriting the manifest:

- source of truth stays human-readable
- refresh remains “bump ref, sync, materialize”
- provenance is preserved
- future updates can diff by source + ref cleanly

### Refresh flow

For external manifest packs:

1. update manifest or run `eve project sync`
2. `.eve/packs.lock.yaml` changes to the new ref
3. run `eve skills materialize --runtime`
4. materializer updates `.eve/materialized-skills/` and `index.yaml`

No manifest rewrite step needed.

### Ad hoc repo URLs

Do not make `eve skills materialize <repo-url>` rewrite the manifest automatically.

If we want a convenience path later, it should do one of:

- materialize ephemerally for the current workspace only
- print a manifest snippet to add under `x-eve.packs`

Auto-rewriting config from an install command is the wrong abstraction.

## Phases

### Phase 1: Local Fast Path

Scope:

- `eve skills materialize`
- local manifest pack sources
- local `skills.txt` sources
- direct filesystem materialization into `.agents/skills` and `.claude/skills`

Implementation:

- add a shared SKILL parser + install-name normalizer in `packages/shared/src/skills/`
- extract `parseSkillsManifest()` and `findSkillDirs()` from `packages/cli/src/commands/skills.ts` into the shared skills module (these are currently CLI-private functions that the materializer needs)
- add an Eve-native materializer library that uses existing `discoverSkillPaths()` from `pack-resolver.ts` for pack sources
- keep `eve skills install` untouched as the developer path
- support `eve skills materialize skills.txt` as the fast deterministic form
- add manifest-declared skill modes to `ManifestXeveSchema` in `packages/shared/src/schemas/manifest.ts`
- let worker SE jobs opt into the dev-augmented mode
- ~~fix `.agent/skills` → `.agents/skills` in `docker/worker/eve-skills`~~ (DONE)

Success criteria:

- no `skills add` subprocesses for local manifest sources
- no `skills add` subprocesses for local `skills.txt` materialization
- 20 skills materialize in well under 100ms on a warm filesystem

### Phase 2: External Manifest Packs

Scope:

- remote manifest pack sources pinned in `.eve/packs.lock.yaml`
- committed `.eve/materialized-skills/`
- runtime bridge reads committed materialized externals

Implementation:

- extend `eve project sync` (in `packages/cli/src/lib/sync-project.ts`, which already calls `resolvePack()`) or add `eve skills materialize --runtime`
- copy `resolvePack().skillPaths` into the committed sidecar, adding SKILL frontmatter install-name resolution
- write provenance index
- fix `fetchPackSource()` in `pack-resolver.ts` to handle arbitrary SHA refs — current `git clone --depth 1` then `git checkout <ref>` breaks for SHAs not on the default branch HEAD. Use `git init` + `git fetch --depth 1 origin <sha>` instead.

Success criteria:

- remote pack skills survive clone without `eve skills install`
- runtime bridge stays filesystem-only
- arbitrary pinned SHAs resolve correctly (not just HEAD-adjacent refs)

### Phase 3: Optional Executor-Specific Hooks

Scope:

- only if we discover worker and agent-runtime need different repo-authored clone behavior beyond materialization

Implementation:

- add optional `.eve/hooks/on-agent-clone.sh` and `.eve/hooks/on-worker-clone.sh`
- keep `on-clone.sh` as shared baseline
- define deterministic ordering relative to shared hooks

Success criteria:

- hook divergence is explicit and no longer overloaded onto one generic clone hook

## Suggested Implementation Files

- `packages/cli/src/commands/skills.ts`
  - add `materialize` subcommand routing alongside existing `install`
  - extract `parseSkillsManifest()`, `findSkillDirs()`, and `parseSkillSource()` into shared module (currently private to this file)
- `packages/cli/src/lib/skills-materialize.ts`
  - new fast-path orchestration: resolves mode → resolves sources → invokes materializer
- `packages/shared/src/skills/discovery.ts`
  - parse SKILL.md frontmatter and extract install names
  - reuse `discoverSkillPaths()` from `pack-resolver.ts` for pack sources; add install-name overlay
  - shared `parseSkillsManifest()` extracted from CLI (for worker SE mode)
- `packages/shared/src/skills/materializer.ts`
  - canonical filesystem operations: symlink/copy into `.agents/skills/<installName>`
  - copy exclusion rules matching `skills` CLI behavior
  - per-agent bridge creation (`.claude/skills`, `.pi/skills`, etc.)
- `packages/shared/src/invoke/skill-bridge.ts`
  - read `.agents/skills/` and `.eve/materialized-skills/` for runtime consumption
- `packages/cli/src/lib/sync-project.ts`
  - already calls `resolvePack()` and logs `resolved.skillPaths.length`; extend with optional vendoring into `.eve/materialized-skills/` for Phase 2
- `docker/worker/eve-skills`
  - ~~fix `.agent/skills` (singular) → `.agents/skills` (plural)~~ (DONE)

## Repo-Specific Migration Recommendation

For this repo:

- move public `eve-skillpacks` usage toward manifest packs so it benefits from `.eve/packs.lock.yaml`
- keep local private dev skills in root `skills.txt` for developer agents
- add a manifest-declared `software-engineering` mode that includes fast `skills.txt` materialization when needed
- stop relying on slow `eve skills install` in clone-time paths once phase 2 lands

That gives us a clean split:

- manifest packs for pinned shared external capability
- `skills.txt` for repo-specific development workflow
- `install` for developer refresh
- `materialize skills.txt` for direct fast local dev-skill materialization when explicitly requested
- manifest-selected modes for runtime and worker provisioning

## Known Risks

### SKILL frontmatter sanitization parity

The `skills` CLI sanitizes install names with specific rules (lowercasing, stripping special characters, etc.). We must replicate these rules exactly or installed skill names will differ between `eve skills install` and `eve skills materialize`, breaking any code that references skills by name.

**Mitigation**: Write a comprehensive test suite comparing materializer install names against `skills add` output for the same sources. Run it as part of Phase 1 validation.

### Skills binary feature drift

If the upstream `skills` binary changes its install-name rules, copy-exclusion list, or directory layout, the materializer will silently diverge.

**Mitigation**: Pin the `skills` dependency version. Add a periodic CI check that installs via both paths and diffs the output.

### Committed `.eve/materialized-skills/` bloat

Vendoring external skills into the repo adds committed files that must be updated on every pack refresh. Large skillpacks could add significant repo weight.

**Mitigation**: Phase 2 should measure the size impact and consider `.gitattributes` LFS rules if needed. The `index.yaml` content hash enables deduplication checks.

## Acceptance Criteria

- docs and UX clearly distinguish developer skills from runtime skills
- `eve skills install` is defined as the public root-`skills.txt` developer workflow
- `eve skills materialize manifest` exists and does not invoke `skills add` for manifest-local or manifest-locked sources
- `eve skills materialize skills.txt` exists and does not invoke `skills add` for local `skills.txt` sources
- manifest can declare at least `runtime` and `software-engineering` skill modes
- worker jobs default to `runtime` when no skill mode is specified
- install names come from SKILL frontmatter, not path basenames
- `.eve/materialized-skills/` is the committed external sidecar, not `.eve/skills/`
- external manifest refs remain canonical in manifest + lockfile
- agent-runtime startup no longer depends on `skills.txt` or slow skill installation hooks for supported cases
- worker SE jobs can pick up repo dev skills without paying the generic `skills` CLI cost
- `.agents/skills` (plural) is the single canonical directory name everywhere — `docker/worker/eve-skills` and all docs updated from `.agent/skills` (DONE)
- `on-clone.sh` no longer calls `eve skills install` — materialization happens at the runtime level before hooks run
- `fetchPackSource()` correctly resolves arbitrary pinned SHA refs, not just HEAD-adjacent commits
