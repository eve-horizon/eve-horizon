# Eve Horizon

**CRITICAL: Read [CLAUDE.md](./CLAUDE.md)** — it is the single source of truth for this project.

## CRITICAL: No Direct AWS Infrastructure Changes

**ALL AWS infrastructure changes MUST go through Terraform in the deployment
instance repository that owns the target environment.** No exceptions.

**NEVER** run AWS CLI commands that mutate infrastructure (security groups, IAM, DNS, EKS, ASGs, etc.) from this repo or any other context. Terraform is authoritative — any out-of-band change gets silently reverted on the next `terraform apply`, which has caused production outages.

**If deployment infrastructure is broken** (API unreachable, SG rules wrong, DNS misconfigured):
1. Diagnose the issue (curl, dig, AWS CLI **read-only** commands are fine)
2. Fix it in the target instance repo's Terraform configuration
3. Run `terraform plan` then `terraform apply` from that repo
4. Verify plan shows "No changes" after apply

**If you don't have access to the owning infra repo**, escalate to the user — do NOT apply a "quick fix" via AWS CLI.

## Deployment Kubeconfig Safety (Required)

When operating a non-local Kubernetes environment:

- Use only the kubeconfig and context documented by that deployment instance repo.
- Prefer the instance repo's operational wrapper scripts over raw `kubectl`.
- Never use an implicit default kube context for remote/staging/production work.
- If direct `kubectl` is unavoidable, always pass both `--kubeconfig` and `--context`
  explicitly.

## Codebase Knowledge Graph (graphify)

`graphify` is local tooling, not committed. It builds a knowledge graph of `apps/`, `packages/`, and `docs/` for structural questions.

- Check whether `graphify-out/graph.json` exists in the repo root at session start.
- If it exists, prefer graphify for structural or cross-cutting questions such as "how does X connect to Y?", "what are the core abstractions?", or "what is this module connected to?"
- If it does not exist, do **not** run `/graphify` unless the user asks. Full extraction is expensive.
- Prefer `rg`, file reads, and `git log` for lexical, code-current, or recent-history questions.
- Treat graph results as hints, not source of truth: the graph can be stale, so verify conclusions against current code before acting.
- Do not guess file paths from graph node labels alone; use the node `source_file` field.
- Trust `EXTRACTED` edges most, treat `INFERRED` edges as leads, and treat `AMBIGUOUS` edges as uncertain until verified.
- Do **not** commit `graphify-out/`; it is a personal, gitignored artifact.

<!-- BEGIN BEADS CODEX SETUP -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
