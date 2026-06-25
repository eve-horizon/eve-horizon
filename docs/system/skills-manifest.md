# Skills Manifest

> Purpose: Define developer `skills.txt` usage, runtime manifest skill materialization, and the split between them.

Developer skills and runtime skills are separate:

- `skills.txt` is for local developer agents and uses `eve skills install`
- `.eve/manifest.yaml` is for Eve runtime agents and uses `eve skills materialize`

## Manifest Format (skills.txt)

- One source per line
- Blank lines and `#` comments are ignored
- Sources may be local paths, Git URLs, or `org/repo` identifiers
- **Local paths should be explicit** (`./`, `../`, `/`, or `~`) to avoid being interpreted as `org/repo`

Example:

```txt
# Local skills
./private-eve-dev-skills/eve-dev/beads-task-management

# Remote sources (examples)
github.com/org/skills
git@github.com:org/private-skills
```

## Developer Install Flow

`eve skills install` performs:

1. Read `skills.txt` and resolve each source
2. Install each source via the `skills` CLI into `.agents/skills/`
3. Symlink `.claude/skills` → `.agents/skills` when possible
4. Fallback: install into `.claude/skills` when symlink fails

This is the developer compatibility path. Remote sources stay here.

## Runtime Materialization Flow

`eve skills materialize manifest` performs the runtime fast path:

1. Read `.eve/manifest.yaml`
2. Resolve the selected runtime `skill_mode` (default: `runtime`)
3. Read `.eve/packs.lock.yaml` for pinned manifest packs
4. Materialize skills into `.agents/skills/` without `skills add`
5. Bridge agent-specific layouts such as `.claude/skills/` and `.pi/skills/`

For external manifest packs, Eve vendors pinned content into
`.eve/materialized-skills/` and runtime consumes that committed sidecar instead
of performing clone-time network fetches.

`eve skills materialize skills.txt` exists for deterministic **local**
`skills.txt` materialization only. Remote `skills.txt` entries remain outside
the fast path.

## Hook Behavior

Worker and agent-runtime now materialize skills before `.eve/hooks/on-clone.sh`
runs. The shared hook can assume runtime skills are already available.

### Smoke Test (Lightweight)

For a lightweight check that avoids dependency installs, run:

```bash
./bin/eh test integration --target "skills-hook-smoke*"
```

This validates the split between install and materialize paths and checks that
`skills.txt` uses explicit local path prefixes.

## Gitignore Expectations

Install targets are gitignored:
- `.agents/skills/`
- `.claude/skills/`
- `.pi/skills/`

Tracked runtime sources live in `.eve/manifest.yaml` and `.eve/packs.lock.yaml`.
Tracked developer sources live in `skills.txt`.

## Migration to AgentPacks

To migrate skills from `skills.txt` into manifest-based packs:

```bash
eve migrate skills-to-packs
```

Review lockfile state and drift:

```bash
eve packs status
eve packs resolve --dry-run
```

Review the generated YAML and add it under `x-eve.packs` in `.eve/manifest.yaml`.
Once verified, remove any runtime-oriented entries from `skills.txt` and keep
only repo-local developer skills there.
