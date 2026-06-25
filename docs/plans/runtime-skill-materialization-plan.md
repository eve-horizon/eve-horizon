# Runtime Skill Materialization

> **Status**: Ready to implement
> **Created**: 2026-04-09
> **Motivation**: Agents running in Eve sandboxes have no access to project skills because `.agents/skills/` and `.claude/skills/` are gitignored — the platform must bridge the gap at runtime.

## Problem

When the agent-runtime clones a project workspace and launches a Claude Code harness, skills are missing:

1. **Project skills** live in `./skills/` (committed, convention from pack resolver's `discoverSkillPaths()`)
2. **Claude Code** discovers skills at `.claude/skills/*/SKILL.md`
3. **Other harnesses** (codex, gemini-cli, pi) look in `.agents/skills/`
4. Both `.claude/` and `.agents/skills/` are gitignored — they don't survive a clone
5. The only mechanism to rebuild them is the `on-clone.sh` hook calling `eve skills install`, which:
   - Requires the project to have `.eve/hooks/on-clone.sh` (Eden doesn't)
   - Shells out to the Vercel `skills` binary 4× per skill (~184 subprocess calls for Eden)
   - Takes 30-60 seconds — unacceptable for job startup

**Result**: Agents start with zero skills. They have no project-specific guidance, no domain knowledge, no slash commands. This is the root cause of [eden-3m6n].

### What Exists Today

| Component | State |
|---|---|
| `./skills/` directory convention | ✅ Committed in projects, discovered by `discoverSkillPaths()` |
| Pack resolver returns `skillPaths` | ✅ But the paths are logged and discarded — never acted on |
| `.agents/skills/` | ❌ Gitignored, not rebuilt at runtime |
| `.claude/skills/` | ❌ Gitignored (under `.claude/`), not rebuilt at runtime |
| `ensureSkillsSymlink()` in CLI | ✅ Creates `.claude/skills → ../.agents/skills` — but only runs via `eve skills install` |
| `on-clone.sh` hook | ❌ Optional per-project, Eden doesn't have one |

## Design

### Principle

The platform should make project skills available to every harness without requiring project-level hooks or the Vercel `skills` binary. This is a filesystem-only operation — symlinks, no copies, no network, no subprocesses.

### Key Decisions

**Symlinks, not copies.** Skills under `./skills/` are already in the workspace. Creating symlinks from `.agents/skills/<name> → ../../skills/<name>` avoids duplication and means edits to `./skills/` are immediately visible to the harness.

**Platform knows the skill locations.** The pack resolver's `discoverSkillPaths()` already scans `<packDir>/skills/` and returns absolute paths. For `source: ./` (self-pack), that's `<workspace>/skills/`. The metadata is there — we just need to use it.

**Harness-aware bridging.** Only Claude-family harnesses need `.claude/skills/`. The `.agents/skills/` directory is the universal target. The `.claude/skills` symlink points to it.

**Runs after hooks, before harness launch.** Hooks may install additional content. The skill bridge runs after `runAcquireHooks()` completes and before the harness adapter builds its command.

### Runtime Flow

```
Clone workspace
  → runAcquireHooks() (may run on-clone.sh if present)
  → materializePackSkills()          ← NEW
    1. Read .eve/manifest.yaml → x-eve.packs
    2. For each local pack source, scan <source>/skills/ for SKILL.md dirs
    3. mkdir .agents/skills/
    4. Symlink each skill: .agents/skills/<name> → ../../skills/<name>
    5. If Claude-family harness: symlink .claude/skills → ../.agents/skills
  → Build harness command + launch
```

### What About External Pack Skills?

Phase 1 handles **local pack skills only** (the `source: ./` case). External packs that contain skills needed at runtime are addressed in Phase 2 via a pre-materialization step at `eve project sync` time.

## Phase 1: Runtime Skill Bridge

**Goal**: After workspace clone, project skills from `./skills/` are available to all harnesses via `.agents/skills/` and `.claude/skills/`.

**Performance budget**: < 5ms for 20 skills.

### Implementation

#### Step 1: Add `materializePackSkills()` to shared invoke utilities

**File**: `packages/shared/src/invoke/skill-bridge.ts` (new)

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

const AGENTS_SKILLS_DIR = path.join('.agents', 'skills');
const CLAUDE_SKILLS_DIR = path.join('.claude', 'skills');

interface MaterializeOptions {
  repoPath: string;
  /** True for Claude-family harnesses (mclaude, claude, zai) */
  claudeHarness: boolean;
}

/**
 * Bridge project skills into .agents/skills/ (and optionally .claude/skills/)
 * using symlinks. Pure filesystem operation — no network, no subprocesses.
 *
 * Scans pack sources from the manifest for local skills directories,
 * then creates symlinks so harnesses can discover them.
 */
export function materializePackSkills(options: MaterializeOptions): number {
  const { repoPath, claudeHarness } = options;
  let count = 0;

  // 1. Discover skill directories from pack sources
  const skillSources = discoverSkillSources(repoPath);
  if (skillSources.length === 0) return 0;

  // 2. Create .agents/skills/ and symlink each skill
  const agentsSkillsAbs = path.join(repoPath, AGENTS_SKILLS_DIR);
  fs.mkdirSync(agentsSkillsAbs, { recursive: true });

  for (const { name, absolutePath } of skillSources) {
    const linkPath = path.join(agentsSkillsAbs, name);
    if (fs.existsSync(linkPath)) continue; // don't overwrite (hook may have created it)

    const relativePath = path.relative(agentsSkillsAbs, absolutePath);
    try {
      fs.symlinkSync(relativePath, linkPath);
      count++;
    } catch {
      // best-effort — don't fail the job over a skill symlink
    }
  }

  // 3. Bridge .claude/skills for Claude-family harnesses
  if (claudeHarness && count > 0) {
    ensureClaudeSkillsLink(repoPath);
  }

  return count;
}

/**
 * Scan manifest x-eve.packs for local pack sources, then discover
 * skills/ subdirectories within each.
 *
 * Also checks for a bare ./skills/ directory even without a manifest
 * (convention fallback for simple projects).
 */
function discoverSkillSources(
  repoPath: string,
): Array<{ name: string; absolutePath: string }> {
  const results: Array<{ name: string; absolutePath: string }> = [];
  const seen = new Set<string>();

  // Try manifest-declared packs first
  const manifestPath = path.join(repoPath, '.eve', 'manifest.yaml');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = parseYaml(fs.readFileSync(manifestPath, 'utf-8')) ?? {};
      const xEve = (manifest['x-eve'] ?? manifest['x_eve']) as
        | Record<string, unknown>
        | undefined;
      const packs = (xEve?.packs ?? []) as Array<{ source: string }>;

      for (const pack of packs) {
        const packDir = resolveLocalPackDir(pack.source, repoPath);
        if (!packDir) continue; // remote pack — skip in Phase 1
        collectSkillDirs(packDir, results, seen);
      }
    } catch {
      // manifest parse failure — fall through to convention
    }
  }

  // Convention fallback: if ./skills/ exists at repo root, scan it
  // (covers projects without a manifest or where packs don't capture ./skills/)
  const conventionSkills = path.join(repoPath, 'skills');
  if (fs.existsSync(conventionSkills)) {
    collectSkillDirs(repoPath, results, seen);
  }

  // Also check for materialized external skills (Phase 2 output)
  const materializedDir = path.join(repoPath, '.eve', 'skills');
  if (fs.existsSync(materializedDir)) {
    collectSkillDirs(materializedDir, results, seen);
  }

  return results;
}

function resolveLocalPackDir(
  source: string,
  repoPath: string,
): string | null {
  if (
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('/') ||
    source === '.'
  ) {
    const resolved = path.resolve(repoPath, source);
    return fs.existsSync(resolved) ? resolved : null;
  }
  return null; // remote source
}

function collectSkillDirs(
  packDir: string,
  results: Array<{ name: string; absolutePath: string }>,
  seen: Set<string>,
): void {
  const skillsDir = path.join(packDir, 'skills');
  if (!fs.existsSync(skillsDir)) return;

  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(skillsDir, entry.name);
      const skillMd = path.join(fullPath, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      results.push({ name: entry.name, absolutePath: fullPath });
    }
  } catch {
    // unreadable directory — skip
  }
}

function ensureClaudeSkillsLink(repoPath: string): void {
  const claudeDir = path.join(repoPath, '.claude');
  const claudeSkills = path.join(claudeDir, 'skills');

  // Don't touch if it already exists (hook or committed directory)
  if (fs.existsSync(claudeSkills)) return;

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.symlinkSync(`../${AGENTS_SKILLS_DIR}`, claudeSkills);
  } catch {
    // best-effort
  }
}
```

#### Step 2: Wire into agent-runtime invoke service

**File**: `apps/agent-runtime/src/invoke/invoke.service.ts`

Add the call after `runAcquireHooks()` (line ~901) and before harness adapter resolution (line ~1088):

```typescript
import { materializePackSkills } from '@eve/shared';

// After hooks, before harness launch:
const harnessName = (invocationWithOptions.harness ?? 'mclaude') as HarnessName;
const isClaudeHarness = ['mclaude', 'claude', 'zai'].includes(harnessName);

const skillCount = materializePackSkills({
  repoPath,
  claudeHarness: isClaudeHarness,
});
if (skillCount > 0) {
  console.log(`🔗 Bridged ${skillCount} skill(s) into workspace`);
}
```

#### Step 3: Export from shared package

**File**: `packages/shared/src/invoke/index.ts`

```typescript
export { materializePackSkills } from './skill-bridge.js';
```

### Files Changed

| File | Change |
|---|---|
| `packages/shared/src/invoke/skill-bridge.ts` | New — `materializePackSkills()` function |
| `packages/shared/src/invoke/index.ts` | Export `materializePackSkills` |
| `apps/agent-runtime/src/invoke/invoke.service.ts` | Call `materializePackSkills()` after hooks |

### Testing

- **Unit test** (`packages/shared/test/unit/skill-bridge.test.ts`): Create a temp dir with `skills/foo/SKILL.md`, call `materializePackSkills()`, assert symlinks created at `.agents/skills/foo` and `.claude/skills`
- **Unit test**: Verify idempotency — calling twice doesn't error or duplicate
- **Unit test**: Verify existing `.claude/skills` directory is not overwritten
- **Unit test**: Verify convention fallback works without a manifest
- **Integration test**: Run a job against Eden on local k3d, verify agent can invoke `/extraction` skill

### Success Criteria

- [ ] Eden agents have access to all 16 project skills at runtime
- [ ] Skill bridge completes in < 5ms (log the timing)
- [ ] No changes required to Eden or any project repo
- [ ] Existing `on-clone.sh` hooks still work (bridge is additive, doesn't overwrite)

---

## Phase 2: External Skill Materialization at Sync Time

> **Status**: Draft
> **Depends on**: Phase 1 (runtime bridge reads from `.eve/skills/`)

**Goal**: Projects that depend on external skill packs (e.g., `eve-skillpacks` from GitHub) can materialize those skills into the repo at sync time, making them available at runtime without network I/O.

### Problem

Some projects need skills from external repositories at runtime. For example, a project might need `eve-read-eve-docs` from `eve-skillpacks` to give its agents platform knowledge. Today this requires either:

1. Committing the full `.agents/skills/` directory (mixing local and external, goes stale)
2. An `on-clone.sh` hook that runs `eve skills install` (slow — shells out to Vercel binary, clones repos)

Neither is acceptable. The platform should support a fast, version-locked materialization flow.

### Design

#### Materialization at sync time

Extend `eve project sync` (or add `eve skills materialize`) to:

1. Read `x-eve.packs` from manifest — the pack resolver already resolves remote packs via `fetchPackSource()` with SHA-pinned refs and a local cache at `~/.eve/cache/packs/`
2. For each resolved pack, use the already-discovered `skillPaths` (currently logged and discarded)
3. Copy the skill directories (SKILL.md + references/ + templates/) into `.eve/skills/<packId>/<skillName>/`
4. Commit the result

#### Directory layout

```
.eve/
  skills/                          ← materialized external skills (committed)
    eve-skillpacks/
      eve-read-eve-docs/
        SKILL.md
        references/
          cli.md
          manifest.md
          ...
      eve-auth-and-secrets/
        SKILL.md
        references/
          app-sso-integration.md
      beads-task-management/
        SKILL.md
        QUICKREF.md
  manifest.yaml
  packs.lock.yaml
```

#### Runtime integration

Phase 1's `materializePackSkills()` already scans `.eve/skills/` as a source (see `discoverSkillSources()` convention). When `.eve/skills/<packId>/` directories exist, skills from external packs are symlinked into `.agents/skills/` alongside local skills. No additional runtime changes needed.

#### Staleness detection

`eve project sync` should:

1. Compare the lockfile's `ref` for each pack against the content in `.eve/skills/<packId>/`
2. If the ref has changed but the materialized dir hasn't been updated, warn:
   ```
   ⚠ Pack "eve-skillpacks" lockfile ref changed (abc123 → def456)
     but .eve/skills/eve-skillpacks/ was not re-materialized.
     Run: eve skills materialize
   ```
3. Optionally auto-update with a `--materialize-skills` flag

#### Gitignore validation

After materialization, verify `.eve/skills/` is not gitignored. If it is, warn:

```
⚠ .eve/skills/ is gitignored — materialized skills won't survive clone.
  Remove the gitignore entry or skills won't be available at runtime.
```

### Implementation

#### Step 1: Add skill materialization to pack sync

**File**: `packages/cli/src/lib/sync-project.ts`

After the existing pack resolution loop (line ~256), add:

```typescript
// Materialize skills from resolved packs into .eve/skills/
for (const resolved of resolvedPacks) {
  if (resolved.skillPaths.length === 0) continue;
  // Skip local packs — their skills are already in the workspace
  const entry = packs.find(p => p.source === resolved.source);
  if (entry && isLocalSource(entry.source)) continue;

  const destDir = path.join(repoRoot, '.eve', 'skills', resolved.id);
  materializeSkillPaths(resolved.skillPaths, destDir);
  console.log(`  📦 Materialized ${resolved.skillPaths.length} skill(s) from ${resolved.id}`);
}
```

#### Step 2: Implement `materializeSkillPaths()`

**File**: `packages/cli/src/lib/skill-materializer.ts` (new)

Copy each skill directory (SKILL.md + subdirectories) to the destination. Use `fs.cpSync()` with `recursive: true` for simplicity. Clear the destination first to ensure clean state.

#### Step 3: Add staleness check

**File**: `packages/cli/src/lib/sync-project.ts`

Before the materialization step, compare the current lockfile ref for each pack against a `.eve/skills/<packId>/.ref` marker file written during materialization. If they differ, warn or auto-update.

#### Step 4: Add gitignore validation

After materialization, check if `.eve/skills/` matches any `.gitignore` pattern. Warn if so.

### Files Changed

| File | Change |
|---|---|
| `packages/cli/src/lib/sync-project.ts` | Add skill materialization after pack resolution |
| `packages/cli/src/lib/skill-materializer.ts` | New — `materializeSkillPaths()` + staleness check |
| `packages/shared/src/invoke/skill-bridge.ts` | No change — already scans `.eve/skills/` |

### Testing

- **Unit test**: Materialize skills from a mock resolved pack, verify directory structure
- **Unit test**: Re-materialize after ref change, verify old content replaced
- **Unit test**: Staleness detection warns when lockfile ref != materialized ref
- **Integration test**: `eve project sync` on a project with external packs, verify `.eve/skills/` populated
- **Manual test**: Clone a fresh workspace, run a job, verify external skills available

### Success Criteria

- [ ] `eve project sync` materializes external pack skills into `.eve/skills/`
- [ ] Materialized skills are committed and survive clone
- [ ] Staleness detection warns when lockfile ref changes
- [ ] Runtime skill bridge picks up materialized skills without additional config
- [ ] No dependency on `skills` binary or `on-clone.sh` hook

### Migration: Eden

To adopt this model, Eden would:

1. Remove `.agents/skills/` from the repo (already done)
2. Run `eve project sync` — materializes eve-skillpacks skills to `.eve/skills/eve-skillpacks/` *if* runtime agents need them
3. If runtime agents only need `./skills/*` (current case), no materialization needed — Phase 1 handles it
4. Remove `skills.txt` if all sources are covered by `x-eve.packs` (or keep it for dev-only skills that shouldn't be runtime-materialized)
