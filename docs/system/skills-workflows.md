# Skill-Based Workflows

> Status: Planned
> Last Updated: 2026-01-26
> Purpose: Define workflow skills (OpenSkills + metadata) and project overrides.

## Current (Implemented)

- Workflows are defined in `.eve/manifest.yaml` under `workflows`.
- Workflow invocation creates a job with workflow metadata in hints.
- Skills are standard OpenSkills without workflow-specific metadata.

## Planned (Not Implemented)

### Workflow Skills

A workflow skill is a normal OpenSkills skill with extra frontmatter fields. The
skill remains runnable via `skill read`, but tooling can treat it as a workflow.

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

### Skill Layout

```
skills/prd-workflow/
  SKILL.md
  config.yaml
  personas/
    security.md
  references/
```

### Project Overrides

```
.eve/skills/prd-workflow/
  config.yaml
  personas/
```

Resolution order:
1) Job inputs (workflow invocation overrides)
2) `.eve/skills/<skill>/config.yaml`
3) `<skill>/config.yaml`

### Manifest Mapping

Allow manifest workflows to reference a workflow skill:

```yaml
workflows:
  prd-epic:
    skill: prd-workflow
```

### Orchestration

Workflow skills should use standard job relations (`waits_for`, `blocks`) and
return `eve.status = "waiting"` when waiting on child jobs.

## Related Docs

- `docs/system/skills.md`
- `docs/system/workflows.md`
- `docs/plans/skills-workflows-spec.md`
