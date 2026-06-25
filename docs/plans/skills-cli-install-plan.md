# Plan: Skills CLI Install + Skillpacks Cleanup

Date: 2026-01-21
Owner: Eve Horizon
Status: Shipped (dd360c4)

## Goal

Add `eve skills install` to install from `skills.txt` using the `skills` CLI (local-only). This is the one exception to the CLI-as-REST-wrapper rule. Document the npm-published CLI as the canonical way to install skills anywhere. Finish aligning the new public skillpacks repo and docs.

## Non-Goals

- No API changes or new endpoints.
- No harness/runtime changes.
- No changes to worker-cli wrappers (they remain available but are not the public install path).

## Open Questions

- Should `eve skills install` accept `--cwd` and/or `--manifest`? (Propose yes, default to repo root.)
- Should glob expansion match worker-cli behavior for local paths? (Propose yes to avoid surprises.)
- Fail-fast behavior when `skills` is missing or `skills.txt` is absent? (Propose fail with clear guidance.)

## Remaining Work

1. Skillpacks repo cleanup
   - Update `https://github.com/eve-horizon/eve-skillpacks` README + pack READMEs + ARCHITECTURE to reference npm-published CLI as the primary install path:
     - `npm i -g @eve/cli` then `eve skills install`
     - Or `npx @eve/cli skills install` for ephemeral usage.
   - Keep SKILL.md format details as the underlying mechanism, but not the primary user-facing path.
   - Commit and push the doc updates.

2. Eve Horizon docs alignment
   - Update `docs/system/skillpacks.md`, `docs/system/skills.md`, and `docs/system/skills-manifest.md` to show npm-published CLI as the canonical install path.
   - Ensure all references point at the public skillpacks repo and avoid stale in-repo paths.

3. Implement `eve skills install` (npm CLI)
   - Add `skills` command in `packages/cli/src/commands/skills.ts`.
   - Wire it into `packages/cli/src/index.ts` and `packages/cli/src/lib/help.ts`.
   - Behavior:
     - Read `skills.txt` (default CWD; support `--cwd`/`--manifest`).
     - Ignore blank/comment lines.
     - Expand local glob patterns (e.g., `./skillpacks/*`, `./skillpacks/**`).
     - Execute `skills add <source> -a <agent> -y --all` for each resolved source.
   - Document usage examples with `npm i -g @eve/cli` and `npx @eve/cli`.
     - Fail fast if `skills` is not on PATH or `skills.txt` is missing.

4. Tests
   - Add unit tests for manifest parsing + glob expansion (reuse or extract worker-cli logic).
   - Add CLI smoke tests for missing `skills.txt` and missing `skills`.

5. Example repo + E2E follow-ups
   - Update `eve-horizon-fullstack-example` `skills.txt` to reference `https://github.com/eve-horizon/eve-skillpacks`.
   - Extend client-only E2E to validate `eve-orchestration` via logs once the repo is referenced.

6. Project hygiene
   - Update `AGENTS.md` log after finishing the above.
   - `bd sync` at session end.
