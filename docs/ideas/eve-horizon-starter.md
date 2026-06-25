# Eve Horizon Starter Repo Plan

> Purpose: define a sister repo (`eve-horizon-starter`) that any developer can clone to create an Eve-compatible project with local-first defaults, an `eve-se` skillpack install, and a smooth path to cloud usage.

> Note: Starter examples should use v2 manifests (`services` + `x-eve.*`).
> Top-level `defaults` moved to `x-eve.defaults` (if used). See `docs/system/manifest.md`.
> Legacy terminology: The “defaults” referenced below are CLI profile defaults, not manifest defaults.

## Goals

- One-clone onboarding with runnable steps and minimal friction.
- Repo is Eve-compatible out of the box (manifest, hooks, skills install flow).
- Agents in the repo have `eve-se` skills installed by default.
- Local stack is the default target; cloud is a first-class optional profile.
- Starter stays in sync with platform best practices over time.

## Non-goals

- Replace `eve-horizon-fullstack-example` (still used for e2e validation).
- Bundle the Eve Horizon platform stack inside the starter repo.
- Solve cloud provisioning in this phase (only configure profile + auth).

## User Journey (Local-First)

1. Clone `eve-horizon-starter`.
2. Install CLI: `npm i -g @eve/cli` (or `npx @eve/cli ...`).
3. Install skills: `eve skills install` (reads `skills.txt`).
4. Set defaults: rely on repo `.eve/profile.yaml` or override with `eve profile set`.
5. Start local stack (link to Eve Horizon quick start).
6. Create org + project: `eve org ensure` + `eve project ensure` (or `eve project bootstrap`).
7. Sync manifest + deploy: `eve project sync` and `eve env deploy`.

## Starter Repo Contents (Proposed)

- `README.md` with clone, CLI install, skills install, local stack, and first deploy steps.
- `.eve/manifest.yaml` with a minimal component + environment definition.
- `.eve/hooks/on-clone.sh` that runs `eve-worker skills install` (idempotent).
- `skills.txt` referencing the `eve-se` pack via repo URL path (installs only `eve-se`).
- `.gitignore` entries for `.agents/skills/` and `.claude/skills/`.
- A tiny example app (single service) to validate deploys end-to-end.
- `scripts/` helpers (profile init, stack check, quick deploy).

## `eve-se` Skillpack Scope (New/Expanded)

Focus: best practices for building Eve-compatible projects.

Candidate skills:
- `eve-se/bootstrap`: org/project setup, manifest sync, profile defaults.
- `eve-se/manifest-authoring`: services, envs, secrets, interpolation.
- `eve-se/pipelines-workflows`: how to define and run pipelines/workflows.
- `eve-se/deploy-debugging`: diagnose deployments and job runs.
- `eve-se/auth-and-secrets`: token extraction + project secret wiring.
- `eve-se/repo-upkeep`: keep starter repo aligned (internal use).

Each skill should reference current system docs and be safe to run locally.

## CLI Enhancements (Published @eve/cli)

1. `eve auth sync` (or `eve auth extract`)
   - Extract Claude/Codex OAuth tokens from host.
   - Write secrets to Eve (`--project` default, `--system` optional).
   - Flags: `--claude`, `--codex`, `--json`, `--dry-run`.
2. Repo profile defaults
   - `.eve/profile.yaml` committed with `api_url`, `org_id`, `project_id`, `default_harness`.
   - Context resolution: flags > repo profile > user profile > env vars.
   - Repo profile is read-only; the CLI never writes user config from repo data.
3. `eve project bootstrap` (optional)
   - Create org/project from repo context and write repo profile defaults.

## Auth + Secrets Flow

- Local stack: `eve auth sync --project` then `eve harness list` to verify.
- Cloud stack: `eve auth sync --system` for team-wide defaults; override per project.
- Token refresh: CLI warns on expiry and re-extracts on demand.

## Local vs Cloud Profiles

- Starter defaults to `http://api.eve.lvh.me` (local k3d ingress).
- Provide a `cloud` profile entry placeholder for future hosted stack.
- README shows switching: `eve profile use cloud`.

## Upkeep and Drift Control

- The canonical source is the sister repo: `../eve-horizon-starter`.
- E2E smoke test: clone starter, `eve skills install`, `eve project ensure`, `eve env deploy`.
- Add a `starter-upkeep` dev skill to drive updates via agents.

## Phased Plan

1. Decide repo layout, skillpack scope, and profile file format.
2. Create `eve-horizon-starter` skeleton + README + manifest + skills.txt.
3. Publish `eve-se` pack with core skills and references.
4. Implement CLI changes (`auth sync`, repo profiles).
5. Add automation + tests + docs updates for drift prevention.
6. Integrate cloud default profile and auth onboarding.

## Open Questions

- Should project ID live in manifest, repo profile, or both?
- How to handle OAuth refresh without storing refresh tokens?
