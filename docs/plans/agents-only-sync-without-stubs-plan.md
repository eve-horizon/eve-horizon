# Agents-Only Sync Without `teams.yaml` / `chat.yaml` Stubs Plan

> **Status**: Drafted (not yet implemented)
> **Last Updated**: 2026-05-19
> **Origin**: ACME rebuild team + ACME Portal POC team. ACME gap `007 — Agents-only sync without teams.yaml / chat.yaml placeholders`. Promotes from ACME gap `0006-eve-agents-config-and-placeholder-files`. First hit during workflow bootstrap 2026-04-29.
> **Adjacent plans**: [`agents-teams-threads-primitives-plan.md`](./agents-teams-threads-primitives-plan.md), [`auth-token-sync-refactor.md`](./auth-token-sync-refactor.md).

## Why

Eve's `agents` / `teams` / `chat` triple has natural sparseness:

- Single-agent workflows have no teams.
- Non-chat workflows (e.g. `acme-make-plan` running on a pipeline tick) have no routes.

Today `eve project sync` treats the three files as mandatory once `x-eve.agents.config_path` is set. Missing `teams.yaml` or `chat.yaml` throws via `ensureFileExists` in [`packages/cli/src/lib/sync-project.ts:652-654`](../../packages/cli/src/lib/sync-project.ts):

```ts
agentsYaml = readFileSync(ensureFileExists(configPaths.agentsPath, 'agents config'), 'utf-8');
teamsYaml  = readFileSync(ensureFileExists(configPaths.teamsPath,  'teams config'),  'utf-8');
chatYaml   = readFileSync(ensureFileExists(configPaths.chatPath,   'chat config'),   'utf-8');
```

Per project this is two stub files. Across the ten-project ACME Portal / observation-platform mesh that is twenty stub files whose only purpose is to satisfy a CLI check, plus a recurring "what is this?" question from every new contributor opening a satellite repo. It also leaks platform implementation detail into every repo: a contributor learning Eve has to internalise three config files before their single-agent project can sync.

The pack-resolver path (`packages/cli/src/lib/sync-project.ts:304-320`) already tolerates the sparse shape — it merges only the files that exist. The file-based path is the asymmetry.

Adjacent friction noted in ACME 0006: `eve agents config --repo-dir . --json` reports the `x-eve.agents` policy/profiles block but does not load `config_path` and surface the effective agent definitions. There is no fast-feedback "did my `agents.yaml` resolve and parse?" answer outside of `eve project sync` itself.

Per [[platform-gaps-first]] the fix lives in `eve-horizon`, not in every consumer repo.

## Decision

1. **Default the missing files at the CLI layer.** When the file-based sync path runs and `teams.yaml` / `chat.yaml` are absent *and* not explicitly named in the manifest, substitute the empty-but-valid YAML constants instead of throwing:

   ```yaml
   # default teams_yaml
   version: 1
   teams: {}

   # default chat_yaml
   version: 1
   routes: []
   ```

2. **Preserve intent.** When the manifest explicitly sets `x-eve.agents.config_path`, `x-eve.agents.teams_path`, or `x-eve.chat.config_path` (or the legacy top-level `chat.config_path`) to a path that does not exist, still throw — the contributor's stated intent is to use that file. This strictness applies to both the file-only path and pack overlay files; sparse packs remain sparse, but explicitly named local overlay files must exist.

3. **Leave the API contract untouched.** `AgentsSyncRequestSchema` keeps requiring non-empty `agents_yaml` / `teams_yaml` / `chat_yaml`. The CLI sends valid defaults; the API still validates them with the same Zod schemas (`AgentsYamlSchema`, `TeamsYamlSchema`, `ChatYamlSchema`) and stores the raw YAML under the project's `agents/teams/chat_yaml` columns. Server-side parsing of the defaults yields `teams: {}` and `routes: []`; the latest agent config row exists, team listings return `teams: []`, and route listings normalize the empty route set to `routes: []` — same observable end-state the placeholder stubs produced.

4. **Make `eve agents config` agents-aware.** Extend the local `agents config` command so its JSON output includes the resolved effective agent slugs, team ids, and route ids (loaded from local files via the same `resolveAgentsConfigPaths` helper used by sync). This closes the verification gap from ACME 0006 without spending a sync round-trip. Summary generation stays local-only — pack resolution stays inside `eve project sync` where the network and lockfile cost is justified; the command's existing optional harness availability lookup remains unchanged and is still skipped with `--no-harnesses`.

### Why default at the CLI, not the API

- The API already accepts whatever YAML the CLI sends. Pushing the default-on-empty rule into the API would require either making the schema fields optional (breaking the wire contract that the API/Slack/UI all share) or having the API silently substitute defaults for empty strings (hidden behaviour). Keeping the default at the CLI keeps the wire contract honest and localises the fix to one function.
- The pack-resolver path (`resolvePacksAndMerge`) already tolerates sparse pack contents. Defaulting in the same shape on the file path is symmetry, not novelty.

## Today's behaviour (call sites)

`resolveAgentsConfigPaths` ([`packages/cli/src/lib/sync-project.ts:103-129`](../../packages/cli/src/lib/sync-project.ts)) returns three string paths, **losing the distinction** between "manifest explicitly named this path" and "this is the first default candidate, file may or may not exist":

```ts
const teamsPath = resolveConfigPath(
  repoRoot,
  pickString(agentsBlock.teams_path),  // explicit if set
  ['agents/teams.yaml', 'eve/teams.yaml'],  // fall-through defaults
);
```

`resolveConfigPath` ([line 88-101](../../packages/cli/src/lib/sync-project.ts)) returns the explicit path verbatim if set, else the first existing default, else the first default candidate. The caller can no longer tell which case fired — both produce a `string`.

`hasAgentsConfig` ([`packages/cli/src/lib/sync-project.ts:383-390`](../../packages/cli/src/lib/sync-project.ts)) currently returns true only when the resolved `agentsPath` exists (or packs are present). That means a manifest with an explicit-but-missing `x-eve.agents.config_path` is silently treated as "no agents config found" instead of surfacing the bad path. The implementation must fix this at the same time as teams/chat so all explicit paths are strict.

Three places consume the result:

| Site | File | Lines | Today |
|---|---|---|---|
| Pack-merge overlay load | `sync-project.ts` | 306-320 | Tolerates every missing overlay file via `existsSync` guard, even when the manifest explicitly named the path. **Needs explicit-missing strictness while preserving sparse implicit overlays.** |
| File-only sync load | `sync-project.ts` | 645-660 | Throws on missing teams/chat. **Target of this plan.** |
| `hasAgentsConfig` check | `sync-project.ts` | 383-390 | Only checks `agentsPath` existence. **Needs to treat explicit `agents.config_path` as sync intent.** |

The pack-merge path's tolerance for implicit sparse files is the model this plan extends to the file-only path. Explicit local paths are stricter: if the manifest names a local overlay file, absence is an error in both paths.

## Required behaviour

- A repo with `.eve/agents.yaml` and **no** `.eve/teams.yaml` / `.eve/chat.yaml` passes `eve project sync` with exit 0. No throw, no warning.
- The synced project's agent rows are populated; `GET /projects/:id/teams` returns `teams: []`, and `GET /projects/:id/routes` returns `routes: []`.
- A manifest that names `x-eve.agents.config_path: nonexistent.yaml` throws with the existing `Missing agents config at <path>` message instead of silently skipping agents sync.
- A manifest that names `x-eve.agents.teams_path: nonexistent.yaml` still throws with the existing `Missing teams config at <path>` message (the contributor's intent was to use that file).
- A manifest that names `x-eve.chat.config_path: nonexistent.yaml` — or the legacy top-level `chat.config_path` — still throws. Both forms are explicit declarations.
- With `x-eve.packs` present, missing implicit local overlay files are still ignored, but explicitly named local overlay paths for agents/teams/chat still throw when absent.
- `eve agents config --repo-dir . --json` includes a resolved `agents[]`, `teams[]`, and `chat_routes[]` summary alongside today's `policy` block. The agents/teams/routes arrays come from the same path resolver used at sync time, so the answers match what `eve project sync` would send.
- The ten current ACME Portal / observation-platform-shaped repos can delete their `teams.yaml` + `chat.yaml` stubs without altering sync behaviour, and `eve project sync --local` continues to exit 0.

## Manifest contract

Minimal manifest for an agents-only project — no `.eve/teams.yaml`, no `.eve/chat.yaml`, sync just works:

```yaml
x-eve:
  agents:
    config_path: .eve/agents.yaml
    skills_root: skills/
```

```bash
eve project sync --project <id> --dir .
# synced: agents=2 teams=0 chat_routes=0

eve agents config --repo-dir . --json
# {
#   "repo_root": "/.../acme-make-plan",
#   "source": { "type": "manifest", "path": "/.../.eve/manifest.yaml" },
#   "policy": { "version": 1, "profiles": { ... } },
#   "agents":      [ { "slug": "acme-planner",  "harness_profile": "..." },
#                    { "slug": "acme-reviewer", "harness_profile": "..." } ],
#   "teams":       [],
#   "chat_routes": []
# }
```

Existing manifests that name `agents.config_path`, `teams_path`, or `chat.config_path` keep strict-existence semantics. There is **no schema change** to the manifest itself.

## Behaviour matrix

| Config | Manifest declares path? | File exists? | Today | After |
|---|---|---|---|---|
| `agents.yaml` | no (implicit default candidate) | yes | sync OK | sync OK |
| `agents.yaml` | no (implicit default candidate) | no | `synced: false, skipped: true` | unchanged |
| `agents.yaml` | yes (`agents.config_path: p`) | yes | sync OK | sync OK |
| `agents.yaml` | yes (`agents.config_path: p`) | no | `synced: false, skipped: true` | **throw** |
| `teams.yaml` | no (implicit default candidate) | yes | sync OK | sync OK |
| `teams.yaml` | no (implicit default candidate) | no | **throw** `Missing teams config` | **default to `{ version: 1, teams: {} }`** |
| `teams.yaml` | yes (`agents.teams_path: p`) | yes | sync OK | sync OK |
| `teams.yaml` | yes (`agents.teams_path: p`) | no | throw | **still throw** |
| `chat.yaml` | no (implicit default candidate) | yes | sync OK | sync OK |
| `chat.yaml` | no (implicit default candidate) | no | **throw** `Missing chat config` | **default to `{ version: 1, routes: [] }`** |
| `chat.yaml` | yes (`chat.config_path: p`) | yes | sync OK | sync OK |
| `chat.yaml` | yes (`chat.config_path: p`) | no | throw | **still throw** |

The intent column (manifest-explicit vs default-candidate) is currently lost inside `resolveConfigPath`. Recovering it is the core code change.

## Implementation

| # | File | Lines | Change |
|---|---|---|---|
| 1 | `packages/cli/src/lib/sync-project.ts` | 88-101 | Add an exported `ResolvedConfigPath` type and change `resolveConfigPath` to return `{ path: string; explicit: boolean }`. `explicit: true` when `explicitPath` was provided; `false` otherwise. |
| 2 | `packages/cli/src/lib/sync-project.ts` | 103-129 | Export `resolveAgentsConfigPaths`; it returns the richer shape: `{ agents: { path, explicit }, teams: { path, explicit }, chat: { path, explicit } }`. Existing callers (304, 388, 645) updated. |
| 3 | `packages/cli/src/lib/sync-project.ts` | new constants near 71 | Export `DEFAULT_TEAMS_YAML = 'version: 1\nteams: {}\n'` and `DEFAULT_CHAT_YAML = 'version: 1\nroutes: []\n'`. |
| 4 | `packages/cli/src/lib/sync-project.ts` | 645-660 | Replace the three `ensureFileExists` calls with a `loadOrDefault(pathInfo, defaultYaml, label)` helper for teams/chat and an `ensureRequiredOrSkip(pathInfo, label)` helper for agents. Teams/chat: throw when `explicit === true`; otherwise return the default constant when the file is missing. Agents: if implicit missing, keep today's soft skip; if explicit missing, throw rather than silently skipping. Existing-but-empty or invalid files are never defaulted — they pass through and remain API validation failures as today. |
| 5 | `packages/cli/src/lib/sync-project.ts` | 306-320 | Pack-merge overlay path: consume the new shape and preserve sparse implicit overlays, but throw via `ensureFileExists` for explicit missing local overlay paths. A project with packs and no local `teams.yaml` / `chat.yaml` still syncs; a project with packs and `x-eve.agents.teams_path: missing.yaml` does not. |
| 6 | `packages/cli/src/lib/sync-project.ts` | 383-390 | `hasAgentsConfig` consumes the new shape and returns true when packs exist, when the agents file exists, or when `agents.config_path` was explicitly declared. This routes explicit-but-missing agents files into the strict error path. |
| 7 | `packages/cli/src/commands/agents.ts` | 72-87, 100-144 | Extend `loadAgentsConfig` to import `resolveAgentsConfigPaths` plus the default YAML constants, read+parse each file when present, and return `{ agents: AgentSummary[], teams: TeamSummary[], chat_routes: RouteSummary[] }`. Reuse the same defaults from #3 when a non-explicit teams/chat file is missing. Reuse the existing `parseYaml` helper. `AgentSummary` includes `id, slug, harness_profile, workflow, gateway_policy`; derive `gateway_policy` from `agent.gateway.policy ?? 'none'`. `TeamSummary` includes `id, lead, members`; `RouteSummary` includes `id, match, target`. Add the fields to the JSON response and a short text summary in non-JSON mode (`Agents: 2 (acme-planner, acme-reviewer); Teams: 0; Routes: 0`). |
| 8 | `packages/cli/src/commands/agents.ts` | help block ~140 | Update the text-mode help/output for `agents config` to mention the new fields. Keep the existing harness availability output intact. |
| 9 | `packages/cli/src/lib/help.ts` | 677-720 | Add `--json` to the `eve agents config` option list and a one-line note under examples: "agents config also reports the resolved agent/team/route summary." |
| 10 | `packages/cli/test/sync-project-sparse.test.ts` | new | Unit tests: (a) repo with only `agents.yaml` — sync succeeds, payload carries default teams/chat YAML. (b) `agents.config_path` explicitly named at a missing path — throws `Missing agents config`. (c) `teams_path` explicitly named at a missing path — throws with the existing message. (d) `chat.config_path` explicitly named at a missing path — throws. (e) With packs present, implicit missing overlays are skipped but explicit missing overlays throw. (f) Existing-but-empty teams/chat files are passed through as file contents, not defaulted; API validation remains responsible for rejection. |
| 11 | `packages/cli/test/agents-config-summary.test.ts` | new | Unit test via `handleAgents('config', ..., { json: true, 'no-harnesses': true }, context)` over a sparse fixture returns the parsed agent slugs and harness profiles plus `teams: []` and `chat_routes: []` arrays (not undefined). Verifies the field shape so ACME / consumers can rely on it without requiring a live harness API. |
| 12 | `docs/system/agents.md` | repo-first config section (line ~11-32) | Document that `teams_path` and `chat.config_path` are optional and that absence defaults to empty teams / empty routes. Mention `eve agents config --json` reports the resolved summary. |
| 13 | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/agents-teams.md` | sync section (line ~360-390) | One paragraph: "Single-agent projects do not need `teams.yaml` or `chat.yaml`. If absent and the manifest does not name a path, sync defaults them to `{ teams: {} }` / `{ routes: [] }`. If the manifest declares `agents.teams_path` or `chat.config_path`, the named file must exist." |
| 14 | `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli.md` | `eve agents config` section | Document the new `agents`, `teams`, `chat_routes` fields in the `--json` output. |
| 15 | `CLAUDE.md` | Update Log | One-line entry on the release date describing the sparse-file default. |

Total: roughly 120 LOC of TypeScript + 180 LOC of tests + docs.

## Verification loop — local (fast, fixture-based)

The bug reproduces deterministically against the file system; no network or live cluster is needed for the inner loop.

```bash
# From repo root.
pnpm install
pnpm --filter @eve-horizon/cli build
pnpm --filter @eve-horizon/cli test
```

The new `sync-project-sparse.test.ts` asserts the behaviour matrix above against a fixture repo tree built into the test (no real filesystem writes outside the temp dir). Mock `requestJson` and the git helpers, or run the sync call with `--ref` plus mocked `resolveGitRef`, so these tests do not need a live API, a remote, or real git history. Each row gets one test; the throw cases assert on the message string so a wording regression is caught.

A second test (`agents-config-summary.test.ts`) covers the `eve agents config` extension on the same fixture tree. It does not call the real API — only the local-resolver path — keeping the test pure-Node and fast.

Loop time: <1s per `pnpm --filter @eve-horizon/cli test` run.

### Local end-to-end smoke (optional)

```bash
./bin/eh status
./bin/eh start docker        # Docker compose stack, no k3d needed for this gap

mkdir -p /tmp/sparse-agent-app/.eve
cat > /tmp/sparse-agent-app/.eve/manifest.yaml <<'YAML'
name: sparse-agent-app
x-eve:
  agents:
    config_path: .eve/agents.yaml
    skills_root: skills/
YAML
cat > /tmp/sparse-agent-app/.eve/agents.yaml <<'YAML'
version: 1
agents:
  planner:
    slug: sparse-agent-planner
    harness_profile: primary-orchestrator
    description: "Plans things; has no team and no chat route."
YAML
git -C /tmp/sparse-agent-app init -q && git -C /tmp/sparse-agent-app add . \
  && git -C /tmp/sparse-agent-app commit -q -m "initial"

eve org ensure sparse-test --slug sparse-test
eve project ensure --name sparse-agent-app --repo-url file:///tmp/sparse-agent-app --branch main
eve project sync --dir /tmp/sparse-agent-app --local
# Expect: synced: true, agents_count: 1. No mention of teams.yaml or chat.yaml.

eve agents config --repo-dir /tmp/sparse-agent-app --json | jq '.agents, .teams, .chat_routes'
# Expect: [{ "slug": "sparse-agent-planner", ... }], [], [].
```

## Verification loop — ACME Portal satellite (authoritative)

Real proof that the gap is closed runs in the consumer repo where the friction was first reported.

### Preconditions

- `acme-portal` repo cloned next to `eve-horizon-2`.
- Local k3d stack running (`./bin/eh k8s start && ./bin/eh k8s deploy`) **or** logged into staging with `eve profile use staging`.
- ACME Portal satellite repo already synced once today (so the project row exists).

The commands below assume a local/lvh API and use `--local`. If running the post-fix smoke against staging, sync committed refs only and omit `--local`; do not use dirty-worktree probes against staging.

### Step 1 — Establish the failing baseline

```bash
cd ../acme-portal/acme-make-plan
ls .eve/
# Today: agents.yaml  manifest.yaml  teams.yaml  chat.yaml
mv .eve/teams.yaml /tmp/teams.yaml.bak
mv .eve/chat.yaml  /tmp/chat.yaml.bak
eve project sync --dir . --local --allow-dirty
# Expected today: throws "Missing teams config at .../teams.yaml"
mv /tmp/teams.yaml.bak .eve/teams.yaml
mv /tmp/chat.yaml.bak  .eve/chat.yaml
```

### Step 2 — Cut a CLI version with the fix

```bash
# From eve-horizon-2.
pnpm install
pnpm --filter @eve-horizon/cli build
pnpm --filter @eve-horizon/cli test

# Bump and tag.
LAST=$(git tag --list 'cli-v*' --sort=-version:refname | head -1)
NEXT="cli-v$(echo $LAST | sed -E 's/cli-v//' | awk -F. '{print $1"."$2"."$3+1}')"
git tag "$NEXT" && git push origin "$NEXT"
gh run watch --exit-status               # publish-cli.yml

# On the test machine.
npm i -g @eve-horizon/cli@latest
eve --version    # confirm new version
```

### Step 3 — Delete the stubs and re-sync

```bash
cd ../acme-portal/acme-make-plan
rm .eve/teams.yaml .eve/chat.yaml
git add -A && git commit -m "chore: drop empty teams/chat stubs"
eve project sync --dir . --local
# Expect: synced: true, agents_count: <n>. Exit 0. No warnings.

# Cross-check what the API exposes.
PROJECT_ID=$(eve project list --name acme-make-plan --json | jq -r '.data[0].id')
AUTH_TOKEN=$(eve auth token)
curl -sH "Authorization: Bearer $AUTH_TOKEN" \
  "$EVE_API_URL/projects/$PROJECT_ID/agents" | jq '.agents | length'
# Expect: <agent_count>, same as before the stubs were deleted.
curl -sH "Authorization: Bearer $AUTH_TOKEN" \
  "$EVE_API_URL/projects/$PROJECT_ID/teams" | jq '.teams | length'
# Expect: 0.
curl -sH "Authorization: Bearer $AUTH_TOKEN" \
  "$EVE_API_URL/projects/$PROJECT_ID/routes" | jq '.routes | length'
# Expect: 0.
```

### Step 4 — Intent-test (explicit-but-missing still throws)

```bash
# Temporarily declare a teams_path that does not exist.
cp .eve/manifest.yaml /tmp/manifest.bak
yq -i '.x-eve.agents.teams_path = ".eve/teams.yaml"' .eve/manifest.yaml
eve project sync --dir . --local --allow-dirty
# Expect: throw "Missing teams config at .../teams.yaml. Update manifest config_path or add the file."
cp /tmp/manifest.bak .eve/manifest.yaml
```

Same probe for `x-eve.agents.config_path`, `x-eve.chat.config_path`, and the legacy top-level `chat.config_path`.

### Step 5 — `eve agents config` summary

```bash
eve agents config --repo-dir . --json | jq '{agents, teams, chat_routes}'
# Expect: agents array with the right slugs and harness_profile; teams: []; chat_routes: [].
```

### Step 6 — Cross-mesh sweep

After Steps 3-5 pass on `acme-make-plan`, repeat Step 3 on the remaining nine observation-platform satellites (`acme-eval`, `acme-ops-agents`, `acme-core`, etc.). Each should lose two stub files and continue to sync. Track via:

```bash
for repo in ../acme-portal/acme-*; do
  [ -d "$repo/.eve" ] || continue
  echo "=== $repo ==="
  ls "$repo/.eve" | grep -E '^(teams|chat)\.yaml$' || echo "(clean)"
done
```

### Step 7 — Rollback rehearsal

```bash
# Put one stub back and confirm the system still tolerates it (no regression for existing repos).
echo -e "version: 1\nteams: {}\n" > .eve/teams.yaml
eve project sync --dir . --local --allow-dirty
# Expect: synced: true. Behaviour identical to the missing-file case.
rm .eve/teams.yaml
```

## Acceptance criteria

- A repo with `.eve/agents.yaml` and **no** `.eve/teams.yaml` / `.eve/chat.yaml` passes `eve project sync` (exit 0, no throw, no warning).
- The synced project's agent rows are populated; the teams endpoint returns `teams: []`, and the routes endpoint returns `routes: []`.
- A manifest that names `x-eve.agents.config_path: nonexistent.yaml` throws with the existing missing-file message instead of silently skipping.
- A manifest that names `x-eve.agents.teams_path: nonexistent.yaml` still throws with the existing error message (intent test). Same for `x-eve.chat.config_path` and the legacy top-level `chat.config_path`.
- With `x-eve.packs` present, implicit missing local overlay files stay sparse-tolerant, and explicit missing local overlay files still throw.
- `eve agents config --repo-dir . --json` includes resolved `agents`, `teams`, and `chat_routes` arrays. The agent entries carry at least `slug` and `harness_profile`; team and route arrays are empty arrays (not `null` or absent) when the files are missing.
- The ten current ACME Portal / observation-platform-shaped repos can delete their `teams.yaml` + `chat.yaml` stubs without altering sync behaviour. The `acme-make-plan` satellite is the canonical smoke target.
- `pnpm test` green across `@eve-horizon/cli`, including the new sparse-file tests.
- Docs updated: `docs/system/agents.md`, `references/agents-teams.md`, `references/cli.md`, `CLAUDE.md` update-log entry.

## Non-goals

- **Removing the three-file model.** Teams and chat are first-class concepts; this plan is only about default-on-empty when sparse.
- **Changing sparse pack semantics.** Packs already handle sparse contents via `resolvePacksAndMerge`; a pack can still omit `teams.yaml` or `chat.yaml`. Only explicitly named local overlay paths become strict.
- **Loosening the API schema.** `AgentsSyncRequestSchema` keeps requiring non-empty YAML strings. The CLI just sends valid defaults instead of throwing locally.
- **Renaming the command.** `eve agents config` keeps its name; the JSON output gets richer.
- **Pack resolution inside `eve agents config`.** Packs require network + lockfile; the local-only path is enough for the "did my file resolve?" question. `eve project sync --dry-run` is the future home of pack-aware previews.
- **Soft-defaulting `agents.yaml`.** Missing agents config still falls through to today's `synced: false, skipped: true` — except when `agents.config_path` is *explicitly* named, in which case it should throw (we tighten this asymmetry in the same change so all three files behave consistently).

## Risks and follow-ups

- **Confusion when an existing stub disappears.** Some repos have `.eve/teams.yaml` files committed for documentation reasons. After this change those files are merely redundant, not load-bearing. Mitigation: the docs update in `agents-teams.md` calls this out, and `eve agents config` reports the same `teams: []` whether the file is missing or empty.
- **Cross-version skew.** Old CLI (`< cli-vN`) syncing into a new API: unchanged — old CLI still requires the files locally. New CLI (`>= cli-vN`) syncing into either old or new API: unchanged — defaults are sent over the wire as non-empty YAML, which the API has always accepted. No coordinated release required.
- **Hidden defaulting.** A future contributor may wonder why a project with no `teams.yaml` still ends up with `teams: {}` server-side. Mitigation: `eve agents config --json` reports `teams: []` and the field shape makes the absence explicit. The skillpack doc update is the discoverability fix.
- **`hasAgentsConfig` semantics.** The function still ignores teams/chat presence for "should we sync at all?", but it must also treat an explicit `agents.config_path` as sync intent so bad manifest paths do not silently skip.

## Docs to update

- `docs/system/agents.md` — Repo-First Config section: mark `teams_path` / `chat.config_path` as optional; document the empty-file default and the strict explicit-path rule for agents/teams/chat.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/agents-teams.md` — Sync section (~line 360-390): one paragraph on sparse-file defaulting, plus the intent rule for explicit paths and the unchanged sparse-pack behavior.
- `../eve-skillpacks/eve-work/eve-read-eve-docs/references/cli.md` — `eve agents config` entry: document the new `agents`, `teams`, `chat_routes` JSON fields.
- `CLAUDE.md` — Update Log: one-line entry on the release date.

## See also

- `packages/cli/src/lib/sync-project.ts:88-129` — `resolveConfigPath` / `resolveAgentsConfigPaths`.
- `packages/cli/src/lib/sync-project.ts:142-147` — `ensureFileExists`.
- `packages/cli/src/lib/sync-project.ts:629-660` — file-only sync load.
- `packages/cli/src/lib/sync-project.ts:280-320` — pack-merge overlay path (already sparse-tolerant; reference implementation).
- `packages/cli/src/commands/agents.ts:72-144` — `agents config` command.
- `packages/shared/src/schemas/agent-config.ts:150-161` — `AgentsSyncRequestSchema` (unchanged by this plan).
- `apps/api/src/projects/projects.service.ts:754-840` — server-side sync validation (unchanged).
- ACME gap `007 — Agents-only sync without teams.yaml / chat.yaml placeholders` — origin spec.
- ACME gap `0006-eve-agents-config-and-placeholder-files` — earlier friction report this promotes from.
