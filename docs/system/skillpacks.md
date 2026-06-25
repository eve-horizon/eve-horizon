# Skill Packs

Eve Horizon organizes skills into **skill packs** - grouped bundles of related skills that can be installed together. This makes it easy to distribute and install collections of related capabilities.

## What Are Skill Packs?

Skill packs are directories containing related skills grouped by purpose or domain. Each pack is a collection of skill directories, where each skill has its own `SKILL.md` file and optional resources.

Think of skill packs like npm packages or apt repositories - they're a way to bundle and distribute related functionality.

### Pack Structure (Public Eve Skillpacks Repo)

```
eve-skillpacks/
├── ARCHITECTURE.md
├── eve-work/              # Pack for productive work
│   ├── README.md          # Pack description
│   └── eve-orchestration/ # Individual skill
│       ├── SKILL.md
│       └── references/
└── eve-se/                # Pack for Eve platform users
    └── README.md
```

### Pack Structure (Private Dev Packs in eve-horizon)

```
private-eve-dev-skills/
└── eve-dev/               # Internal development pack
    ├── README.md
    └── beads-task-management/
        └── SKILL.md
```

## Available Packs

### eve-work (Productive Work)

Skills for doing work of any kind using Eve Horizon patterns.

**Skills included:**
- **eve-orchestration**: Orchestrate jobs via depth propagation, parallel decomposition, relations, and control signals

**Who should use:** Anyone using Eve Horizon to do work - whether software engineering, research, writing, or other knowledge work. These skills teach agents how to effectively decompose tasks, work in parallel, and coordinate complex multi-step work.

### eve-dev (Private Development)

Internal skills for developing and maintaining the Eve Horizon platform itself.

**Location:** `private-eve-dev-skills/eve-dev/` in this repo.

**Who should use:** Eve Horizon platform developers and contributors. These skills are specific to internal development workflows and may not be relevant for general users.

Recent updates include `eve-platform-debugging` pipeline run inspection (`eve pipeline runs`, `eve pipeline show-run`) and `eve-web-ui-testing-agent-browser`, which now adds a repo-local `./bin/eh browser` wrapper around the dashboard's pinned Playwright toolchain for faster exploratory UI debugging and local dashboard auth bootstrapping.

### eve-se (Software Engineering)

Skills specific to working with the Eve Horizon platform and conforming to its patterns.

**Status:** Under development. Planned skills include:
- Agent config authoring (`agents.yaml`, `teams.yaml`, `chat.yaml`)
- Chat gateway debugging + simulate flows
- Agent runtime health checks and placement diagnostics

**Who should use:** Teams building applications on Eve Horizon. These skills teach agents how to work effectively within the Eve ecosystem.

## Official Eve Packs (Public Repo)

Public Eve skill packs live in:
`https://github.com/eve-horizon/eve-skillpacks`

This repo contains **eve-se** and **eve-work**. Dev-only packs live in this repo under `private-eve-dev-skills/`.

To install all official packs, add to your `skills.txt`:
```txt
https://github.com/eve-horizon/eve-skillpacks
```

This installs every skill in the repo. For selective installs, clone the repo and list only the packs/skills you want in `skills.txt`, then run `./bin/eh skills install` (uses the worker CLI wrapper when available).

**AgentPacks alternative:** You can also declare packs in `.eve/manifest.yaml` via
`x-eve.packs` and generate a lockfile with `eve agents sync`. This is the
preferred path for shared agent configuration and reproducible pack resolution.
To migrate a legacy `skills.txt`, run `eve migrate skills-to-packs` and merge the
output into your manifest.

## Installing Skill Packs

### Install All Skills from a Pack

To install all skills from a pack, add a glob pattern to `skills.txt`:

```txt
# Install a local pack
./private-eve-dev-skills/eve-dev/*

# Install multiple local packs
./skillpacks/my-pack/*
./skillpacks/another-pack/*
```

Then run:
```bash
./bin/eh skills install
```

This will:
1. Scan each pack directory for subdirectories containing `SKILL.md`
2. Install each skill to `.agents/skills/` via the `skills` CLI
3. Symlink `.claude/skills` to `.agents/skills` (when possible)

### Install Individual Skills

You can also install specific skills from a pack:

```txt
# Install just one skill
./skillpacks/my-pack/my-skill
```

### Mix and Match

Combine pack-wide and individual installations:

```txt
# Install all skills from one pack
./skillpacks/my-pack/*

# Plus one specific skill from another pack
./skillpacks/another-pack/special-skill
```

## Glob Pattern Syntax

| Pattern | Meaning | Example |
| --- | --- | --- |
| `./path/*` | All direct child directories with SKILL.md | `./skillpacks/my-pack/*` installs all skills in the pack |
| `./path/**` | Recursive - all nested directories with SKILL.md | `./skillpacks/**/*` installs all skills in all packs |
| `./path/skill` | Single specific skill | `./skillpacks/my-pack/my-skill` |

**Important:** Always use explicit path prefixes (`./`, `../`, `/`, or `~`) to distinguish local paths from `org/repo` identifiers.

## How It Works

When you run `./bin/eh skills install` with glob patterns:

1. The installer reads `skills.txt` line by line
2. For glob patterns, it expands them to find matching directories
3. Each directory containing a `SKILL.md` becomes a skill
4. Each skill is installed via the `skills` CLI
5. Skills are copied to `.agents/skills/` (gitignored)
6. `.claude/skills/` is symlinked to `.agents/skills/`

The skill name comes from its directory name (e.g., `eve-orchestration/` becomes skill `eve-orchestration`).

## Creating Your Own Skill Pack

### 1. Create the Pack Directory

```bash
mkdir -p skillpacks/my-pack
```

### 2. Add a README

Create `skillpacks/my-pack/README.md`:

```markdown
# My Pack

Brief description of what this pack does.

## Skills Included

- **skill-one** - Description
- **skill-two** - Description

## Installation

Add to your `skills.txt`:
\`\`\`
./skillpacks/my-pack/*
\`\`\`

## Who Should Use This

Target audience description.
```

### 3. Add Skills

Create skills in subdirectories:

```bash
mkdir -p skillpacks/my-pack/my-skill
cat > skillpacks/my-pack/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: Brief description of what this skill does
---

# My Skill

Instructions in imperative form.

## When to Use

Load this skill when...

## Instructions

To accomplish X:
1. Step one
2. Step two
EOF
```

### 4. Reference in skills.txt

Add to your repository's `skills.txt`:

```txt
./skillpacks/my-pack/*
```

### 5. Install

```bash
./bin/eh skills install
```

## Best Practices

### Pack Organization

- **Domain-focused**: Group skills by purpose or domain (e.g., testing, deployment, data processing)
- **Cohesive**: Skills in a pack should work together or share a common theme
- **Documented**: Always include a README explaining the pack's purpose and audience

### Skill Naming

- Use hyphen-case for skill directory names (e.g., `my-skill`, not `mySkill` or `my_skill`)
- Keep names concise but descriptive
- Avoid name collisions with skills in other packs

### Version Control

- **Track the pack**: Commit `skillpacks/` to your repository
- **Ignore installations**: `.agents/skills/` and `.claude/skills/` should be gitignored
- **Track the manifest**: `skills.txt` should be committed

### Distribution

Skill packs can be distributed:
- **In-repo**: Store in `skillpacks/` for project-specific skills
- **Git repository**: Reference via Git URL in `skills.txt`
- **Shared globally**: Install to `~/.agents/skills/` for personal use

## Troubleshooting

### Skills Not Installing

Check that:
1. Each skill directory contains a `SKILL.md` file
2. You're using explicit path prefixes (`./`, not bare paths)
3. The glob pattern matches your directory structure
4. You ran `./bin/eh skills install` after editing `skills.txt`

### Name Conflicts

If two skills have the same name, the first one found wins (based on [search priority](./skills.md#search-priority)). To resolve:
1. Rename one of the skills
2. Or use specific paths instead of glob patterns

### Skills Not Loading

To inspect installed skills, check `.agents/skills/` or use `skills list` when
the CLI is available in your environment.

If a skill is missing, check `AGENTS.md` to see what was installed.

## Related Documentation

- [skills.md](./skills.md) - How the skills system works
- [skills-manifest.md](./skills-manifest.md) - Format and install flow for `skills.txt`
- [AGENTS.md](.//AGENTS.md) - Auto-generated skill inventory

## Examples

### Personal Skill Pack

Create a pack for your personal workflow:

```bash
# Create pack
mkdir -p skillpacks/personal
cat > skillpacks/personal/README.md << 'EOF'
# Personal Skills
My custom skills for this project.
EOF

# Add a skill
mkdir -p skillpacks/personal/code-review
cat > skillpacks/personal/code-review/SKILL.md << 'EOF'
---
name: code-review
description: Review code changes for style and best practices
---
# Code Review
[skill instructions]
EOF

# Install
echo './skillpacks/personal/*' >> skills.txt
./bin/eh skills install
```

### Team Skill Pack

Share skills across your team:

```bash
# In your shared repository
skillpacks/
└── team-standards/
    ├── README.md
    ├── api-design/
    │   └── SKILL.md
    └── testing-standards/
        └── SKILL.md

# In each project's skills.txt
git@github.com:your-org/team-skills
```

### Mixed Installation

Combine packs and individual skills:

```txt
# Install a local pack
./skillpacks/my-pack/*

# Install a specific skill from another pack
./skillpacks/another-pack/special-skill

# Add a custom skill
./skillpacks/project-specific-skill

# Include remote pack
github.com/your-org/company-standards
```
