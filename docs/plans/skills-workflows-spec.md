# Skills + Workflows Spec - Plan

> Status: Draft
> Last Updated: 2026-01-26

## Purpose

Define a workflow-on-skills spec: OpenSkills with extra frontmatter and co-located
files that enable reusable workflows, persona-driven reviews, and project overrides.

## Source Docs

- `docs/system/skills.md`
- `docs/system/workflows.md`
- `docs/ideas/prd-to-epic-workflow.md`
- `docs/plans/harness-policy-and-reasoning-controls.md`

## Goals

- Keep workflows as OpenSkills with small, explicit extensions.
- Allow skills to ship default configs and persona metadata.
- Provide a clear override mechanism per project.
- Make orchestration patterns (waits_for + waiting) first-class.
- Avoid breaking the current manifest workflow model.

## Non-goals

- A new workflow engine.
- Hard dependency on a UI.
- Multi-harness execution inside a single job (use multiple jobs).

## Spec Overview

### 1) Workflow Skills

A workflow skill is a normal OpenSkills skill with additional frontmatter fields
that describe invocation, inputs/outputs, and optional config files.

Frontmatter (draft):

```yaml
---
name: prd-workflow
kind: workflow
version: 1
inputs_schema: inputs.schema.json
outputs_schema: outputs.schema.json
config: config.yaml
personas_dir: personas
skills_required:
  - eve-review-plan
  - eve-review-security
---
```

Notes:
- `kind: workflow` marks the skill as invocable by workflow tooling.
- `config` and `personas_dir` are optional.
- `skills_required` is advisory (documentation + validation).

### 2) Skill Directory Layout

```
skills/prd-workflow/
  SKILL.md
  config.yaml                 # default config (optional)
  personas/                    # review personas (optional)
    security.md
    simplicity.md
  references/
  inputs.schema.json           # optional
  outputs.schema.json          # optional
```

### 3) Project Overrides

Projects can override workflow config and personas without changing the skillpack.

```
.eve/skills/prd-workflow/
  config.yaml
  personas/
    security.md
```

Resolution order (highest priority first):
1) Job input overrides (workflow invocation inputs)
2) `.eve/skills/<skill>/config.yaml` (project override)
3) `<skill>/config.yaml` (skill default)

Persona resolution order:
1) `.eve/skills/<skill>/personas/*.md`
2) `<skill>/personas/*.md`

### 4) Workflow Invocation (Planned)

Two supported patterns:

A) Manifest mapping (preferred)

```yaml
workflows:
  prd-epic:
    skill: prd-workflow
```

B) Direct skill invocation (optional)

```
eve workflow run prd-workflow --input '{"prd_path":"docs/prd/x.md"}'
```

### 5) Persona Files

Persona files are markdown with frontmatter describing when and how to use the review.

```markdown
---
name: security
skill: eve-review-security
stage: [plan, code]
mode: [primary, background]
profile: primary-reviewer
blocking_default: true
auto_fix: false
---

# Security Persona

Review for auth flaws, secret exposure, and unsafe defaults.
```

### 6) Orchestration Pattern

Workflow skills should use the existing job relation model:

- Create child jobs for parallel work.
- Add `waits_for` relations from parent to child.
- Return `json-result` with `eve.status = "waiting"` to resume later.

This keeps control flow inside the existing job lifecycle.

## Implementation Phases

Phase 1
- Add workflow skill frontmatter conventions (docs only).
- Add override resolution logic inside workflow skills.

Phase 2
- Add `workflows.<name>.skill` support in the manifest and API.
- Add CLI support to run workflow skills directly.

Phase 3
- Add schema validation for inputs/outputs.
- Add persona registry tooling.

## Open Questions

- Should workflow skills be addressable without a manifest entry?
- Where should schema validation run (API vs worker)?
- Do we need a standard set of persona fields across all workflows?
