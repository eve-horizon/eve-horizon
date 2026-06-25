# CLI Agent Ops + Testware Plan

> Status: Plan
> Last Updated: 2026-02-03
> Purpose: Add CLI primitives for agent ops, chat simulation, and test scaffolding.
> Order: 4 (tooling + tests)

## Dependencies
- Agents/Teams/Threads plan
- Chat Gateway plan

## Goals
- Deterministic sync (`--ref` required) with safe local dev escape hatch.
- CLI coverage for agent config + chat simulation + integration setup.
- Manual test scenario for simulated Slack.
- Example repo updated with agents/teams/chat config.

## CLI Changes

### Agents
- `eve agents config` (resolve manifest pointers + show agents.yaml/teams.yaml/chat.yaml)
- `eve agents sync --ref <sha|branch|tag>`
- `eve agents sync --local --allow-dirty` (local dev only)

### Chat
- `eve chat simulate slack --team-id --channel --user --text`
- `eve chat simulate nostr --pubkey --text` (future)

### Integrations
- `eve integrations connect slack [--mode oauth|test]`
- `eve integrations list`
- `eve integrations test <id>`

## Sync Semantics (Safety)
- `--ref` required by default (no implicit HEAD).
- `--local` allowed only for localhost / *.lvh.me (unless --force-nonlocal).
- `--allow-dirty` required if working tree is dirty.
- Dirty syncs are marked non-deployable.

## Manual Tests
- Add scenario: `tests/manual/scenarios/08-agents-chat.md`.
- Update `tests/manual/README.md` table.

## Example Repo Updates
Repo: `../eve-horizon-fullstack-example`
- Add `agents/agents.yaml`, `agents/teams.yaml`, `agents/chat.yaml`.
- Add `agents/<agent>/SKILL.md` with OpenSkills format.
- Update `.eve/manifest.yaml` to point to `agents/*.yaml` and skills root.
- Add minimal `workflows.assistant` if missing.

## Work Breakdown
- [ ] Update CLI help + command handlers.
- [ ] Implement `agents sync` endpoint client (CLI only).
- [ ] Add `chat simulate` command.
- [ ] Add integrations commands.
- [ ] Update manual tests + example repo.

## Tests
- CLI unit tests (command parsing).
- Manual scenario 08 (simulated Slack).

## Spec Appendix

### CLI Commands (detailed)
- `eve agents sync --ref <sha|branch|tag> [--dir <repo>] [--project <id>]`
- `eve agents sync --local --allow-dirty [--force-nonlocal]`
- `eve chat simulate slack --team-id <id> --channel <id> --user <id> --text "<msg>" --project <id>`
- `eve integrations connect slack --mode oauth|test [--team-id <id>]`

### Error Cases
- Missing `--ref` without `--local` => error.
- `--local` against non-local API => error unless `--force-nonlocal`.
- Dirty tree without `--allow-dirty` => error.

### Manual Scenario Acceptance
- chat event created
- job created for agent workflow
- thread updated with response
