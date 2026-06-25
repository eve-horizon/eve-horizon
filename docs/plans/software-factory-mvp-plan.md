# Software Factory MVP — Implementation Plan

> Status: Plan
> Last Updated: 2026-02-09
> Purpose: Build and validate the MVP relay-chain software factory as an AgentPack.
> Design: docs/ideas/automated-software-factory-v4.md
> Depends on: All agent team coordination (complete), AgentPacks (complete), unified permissions (complete)

## Overview

Build the Factory Relay MVP: 4 agents in a relay chain that turns a feature
request into a PR. Ship as an AgentPack in a new sister repo
(`eve-software-factory`). Validate with a new manual test scenario (11) against
the local k3d stack.

### Goals

- End-to-end factory run: PM → Planner → Coder → Verifier → PR
- Ship as a proper AgentPack (pack.yaml, agents, teams, chat routes, harness profiles)
- Relay chain using existing dispatch primitives (no new platform code)
- Coordination thread captures handoffs between agents
- Validated by a repeatable manual test scenario using `claude` and `codex` harnesses

### Non-Goals

- Council mode, supervision loop, or lead agent (Phase 2)
- Review councils or specialized reviewers (Phase 2)
- HITL gates (Phase 3)
- GitHub/Slack triggers (Phase 4)
- Self-healing or self-improvement (Phase 5+)

---

## Prerequisites

### Credential Chain for `claude` and `codex` Harnesses

The factory MVP uses `claude` (Opus 4.6) and `codex` (Codex 5.3) harnesses.
These require OAuth tokens synced from the host machine into the test org.

**Credential flow:**
```
Host machine (macOS Keychain / ~/.claude/ / ~/.codex/)
    │ eve auth sync --org org_manualtestorg
    ▼
Eve secrets table (CLAUDE_CODE_OAUTH_TOKEN, CODEX_OAUTH_ACCESS_TOKEN)
    │ Worker resolves via POST /internal/.../secrets/resolve
    ▼
Worker adapter (claude.ts → resolveMclaudeAuth, codex.ts → resolveCodeAuth)
    │ Writes .credentials.json / auth.json
    ▼
Agent harness process (claude CLI / codex CLI)
```

**Verification before testing:**
```bash
# Sync OAuth tokens from host to test org
eve auth sync --org org_manualtestorg

# Verify tokens are set
eve secrets list --org org_manualtestorg --json
# Expected: CLAUDE_CODE_OAUTH_TOKEN and/or CODEX_OAUTH_ACCESS_TOKEN present

# Verify harness availability
eve harness list
# Expected: claude ✓, codex ✓
```

### Potential `eve auth sync` Issues

The `auth sync` command (`packages/cli/src/commands/auth.ts:422-631`) extracts
tokens from:

- **Claude**: macOS Keychain (`Claude Code-credentials`, `anthropic.claude`),
  then `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
- **Codex**: macOS Keychain (`openai.codex`, `Code-credentials`),
  then `~/.codex/auth.json` → `tokens.access_token`

Known risks:
1. Keychain service names may have changed since last use — verify with
   `security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null`
2. Credential file paths may have changed (e.g., new Claude Code versions)
3. OAuth tokens may have expired — re-authenticate with `claude` / `codex` CLI first

**Fix-up task:** Run `eve auth creds` to inspect what's discoverable on the host.
If tokens are found but `eve auth sync` fails, debug the specific extraction path.

---

## Phase 1: Create the `eve-software-factory` Repo

> The AgentPack repo. Contains skills + Eve metadata. Nothing else.

### 1.1 Repo Scaffold

Create `../eve-software-factory/` as a sibling to `eve-horizon`:

```
eve-software-factory/
├── skills/
│   ├── factory-pm/
│   │   ├── SKILL.md
│   │   └── references/
│   │       └── brief-template.md
│   ├── factory-planner/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── spec-template.md
│   │       └── plan-template.md
│   ├── factory-coder/
│   │   └── SKILL.md
│   └── factory-verifier/
│       └── SKILL.md
│
├── eve/
│   ├── pack.yaml
│   ├── agents.yaml
│   ├── teams.yaml
│   ├── chat.yaml
│   └── x-eve.yaml
│
├── README.md
└── .gitignore
```

### 1.2 Pack Descriptor (`eve/pack.yaml`)

```yaml
version: 1
kind: agentpack
id: software-factory

imports:
  agents: eve/agents.yaml
  teams: eve/teams.yaml
  chat: eve/chat.yaml
  x_eve: eve/x-eve.yaml
```

### 1.3 Agent Roster (`eve/agents.yaml`)

```yaml
version: 1
agents:
  factory_pm:
    slug: factory-pm
    skill: factory-pm
    harness_profile: fast-triage
    description: "Intake and brief — interviews if underspecified, writes brief with acceptance criteria"
    policies:
      permission_policy: auto_edit
      git: { commit: auto, push: on_success }

  factory_planner:
    slug: factory-planner
    skill: factory-planner
    harness_profile: deep-reasoning
    description: "Spec + plan — investigates repo if existing codebase, writes spec and implementation plan"
    policies:
      permission_policy: auto_edit
      git: { commit: auto, push: on_success }

  factory_coder:
    slug: factory-coder
    skill: factory-coder
    harness_profile: primary-coder
    description: "Implementation — builds the plan with tests, keeps changes scoped"
    policies:
      permission_policy: auto_edit
      git: { commit: auto, push: on_success }

  factory_verifier:
    slug: factory-verifier
    skill: factory-verifier
    harness_profile: deep-reasoning
    description: "Verification — runs tests, checks acceptance criteria, opens final PR"
    policies:
      permission_policy: auto_edit
      git: { commit: auto, push: on_success }
```

### 1.4 Team Topology (`eve/teams.yaml`)

```yaml
version: 1
teams:
  factory:
    lead: factory_pm
    members: [factory_planner, factory_coder, factory_verifier]
    dispatch:
      mode: relay
```

### 1.5 Chat Routes (`eve/chat.yaml`)

```yaml
version: 1
routes:
  - id: route_factory
    match: "^factory\\b"
    target: team:factory
    description: "Route 'factory ...' messages to the factory relay team"
```

### 1.6 Harness Profiles (`eve/x-eve.yaml`)

```yaml
agents:
  profiles:
    fast-triage:
      - harness: claude
        model: opus-4.6
        reasoning_effort: low

    deep-reasoning:
      - harness: codex
        model: codex-5.3
        reasoning_effort: x-high
      - harness: claude
        model: opus-4.6
        reasoning_effort: high

    primary-coder:
      - harness: codex
        model: codex-5.3
        reasoning_effort: high
      - harness: claude
        model: opus-4.6
        reasoning_effort: high

  defaults:
    harness: codex
    harness_profile: primary-coder
    git:
      commit: auto
      push: on_success
```

### 1.7 Skills (SKILL.md Files)

Each skill follows the OpenSkills SKILL.md format. Detailed content for each:

#### `skills/factory-pm/SKILL.md`

```markdown
---
name: factory-pm
description: Product manager intake — interviews when requirements are underspecified, writes a brief with acceptance criteria
---

# Factory PM

## When to Use

Invoked as the first step in a factory relay chain. Receives a feature
request and produces a structured brief.

## Instructions

1. Read the incoming feature request carefully.
2. Assess completeness:
   - Are the goals clear and testable?
   - Are there enough details to plan implementation?
   - If NOT: list 3-5 clarifying questions as a structured list and
     stop. Output a json-result with eve.status = "failed" and
     eve.summary listing the questions.
3. Determine factory_mode:
   - If the repo has existing source code → `existing`
   - If the repo is empty or scaffold-only → `greenfield`
4. Write brief to `docs/briefs/<slug>.md` using the template in
   references/brief-template.md.
5. Create a feature branch: `feat/<slug>`
6. Commit the brief and push.
7. Output a json-result with eve.summary describing the brief,
   factory_mode, acceptance criteria count, and branch name.

## Output Contract

The brief MUST contain:
- **Goals**: What the feature achieves (2-5 bullet points)
- **Non-Goals**: What is explicitly out of scope
- **Acceptance Criteria**: Numbered, testable criteria (Given/When/Then style)
- **Constraints**: Technical or business constraints
- **factory_mode**: `greenfield` or `existing`

See references/brief-template.md for the full template.
```

#### `skills/factory-planner/SKILL.md`

```markdown
---
name: factory-planner
description: Writes a specification with Given/When/Then scenarios and an implementation plan with ordered steps
---

# Factory Planner

## When to Use

Invoked as the second step in the factory relay chain. Reads the PM's
brief and produces a spec + plan.

## Instructions

1. Read .eve/coordination-inbox.md for the PM's summary.
2. Read the brief from docs/briefs/<slug>.md.
3. If factory_mode is `existing`:
   - Investigate the codebase: identify architecture, key files,
     test patterns, and dependencies relevant to the brief.
   - Note any risks or constraints discovered.
4. Write the spec to docs/specs/<slug>-spec.md:
   - One Given/When/Then scenario per acceptance criterion.
   - Additional edge-case scenarios as needed.
5. Write the plan to docs/plans/<slug>-plan.md:
   - Design decisions with rationale.
   - Ordered implementation steps (numbered).
   - Test strategy (what to test, how).
   - Files to create or modify.
6. Commit spec + plan and push.
7. Output a json-result with eve.summary describing scenario count,
   step count, and key design decisions.

See references/spec-template.md and references/plan-template.md for templates.
```

#### `skills/factory-coder/SKILL.md`

```markdown
---
name: factory-coder
description: Implements the plan with production code and tests
---

# Factory Coder

## When to Use

Invoked as the third step in the factory relay chain. Reads the spec
and plan, then implements.

## Instructions

1. Read .eve/coordination-inbox.md for the planner's summary.
2. Read the spec from docs/specs/<slug>-spec.md.
3. Read the plan from docs/plans/<slug>-plan.md.
4. Implement each step from the plan in order:
   - Follow the design decisions documented in the plan.
   - Write clean, well-structured code.
   - Keep changes scoped to what the plan specifies.
5. Write tests that cover each spec scenario:
   - Each Given/When/Then scenario should map to at least one test.
   - Run tests locally and fix any failures.
6. Commit all changes and push.
7. Output a json-result with eve.summary describing files changed,
   tests written, and test results.

## Constraints

- Do NOT deviate from the plan without documenting why.
- Do NOT add features beyond what the spec requires.
- Do NOT skip tests — every acceptance criterion needs coverage.
```

#### `skills/factory-verifier/SKILL.md`

```markdown
---
name: factory-verifier
description: Runs the test suite, verifies acceptance criteria, and opens a PR
---

# Factory Verifier

## When to Use

Invoked as the final step in the factory relay chain. Verifies the
implementation matches the spec and opens a PR.

## Instructions

1. Read .eve/coordination-inbox.md for the coder's summary.
2. Read the brief from docs/briefs/<slug>.md (acceptance criteria).
3. Read the spec from docs/specs/<slug>-spec.md.
4. Run the full test suite.
5. For each acceptance criterion, verify:
   - Is there a matching spec scenario?
   - Is there a matching test?
   - Does the test pass?
6. If any criteria are unmet or tests fail:
   - Output a json-result with eve.status = "failed" and
     eve.summary listing specific failures.
7. If all criteria are met and tests pass:
   - Open a PR from the feature branch to main.
   - Output a json-result with eve.summary including the PR URL
     and a verification matrix (criterion → test → result).
```

### Deliverables (Phase 1)

| Deliverable | Path |
|---|---|
| Pack descriptor | `eve-software-factory/eve/pack.yaml` |
| Agent roster | `eve-software-factory/eve/agents.yaml` |
| Relay team | `eve-software-factory/eve/teams.yaml` |
| Chat routes | `eve-software-factory/eve/chat.yaml` |
| Harness profiles | `eve-software-factory/eve/x-eve.yaml` |
| PM skill | `eve-software-factory/skills/factory-pm/SKILL.md` + references/ |
| Planner skill | `eve-software-factory/skills/factory-planner/SKILL.md` + references/ |
| Coder skill | `eve-software-factory/skills/factory-coder/SKILL.md` |
| Verifier skill | `eve-software-factory/skills/factory-verifier/SKILL.md` |
| README | `eve-software-factory/README.md` |

---

## Phase 2: Install into Test Project

> Wire the factory pack into the fullstack-example repo for testing.

### 2.1 Clone the Factory Pack Locally

The test scenario will use a local path reference to the factory pack:

```yaml
# eve-horizon-fullstack-example/.eve/manifest.yaml (additions)
x-eve:
  packs:
    - source: ./packs/notes-ops          # existing
    - source: ../../eve-software-factory  # factory pack (local path)
```

### 2.2 Add Factory Agent Overlays (Optional)

The fullstack-example project may want to override the factory's default
harness profiles to use `zai` (since that's what the test org has secrets for).

However, the factory MVP is designed to test `claude` and `codex` harnesses.
So we sync OAuth tokens via `eve auth sync` rather than downgrading to `zai`.

### 2.3 Sync and Verify

```bash
cd ../eve-horizon-fullstack-example
eve agents sync --project $PROJECT_ID --ref main --repo-dir . --allow-dirty --local
eve agents config --json  # Verify factory agents appear with correct profiles
```

**Expected:** 4 factory agents (`factory-pm`, `factory-planner`, `factory-coder`,
`factory-verifier`) appear in the agent config alongside the existing project agents.

### Deliverables (Phase 2)

| Deliverable | Path |
|---|---|
| Manifest update | `eve-horizon-fullstack-example/.eve/manifest.yaml` |
| Agent sync verified | CLI output shows factory agents resolved |

---

## Phase 3: Validate Auth Sync for claude/codex

> Ensure OAuth tokens flow from host machine through to harness execution.

### 3.1 Verify Host Credentials

```bash
eve auth creds
# Expected: Shows Claude OAuth token source + Codex OAuth token source
```

### 3.2 Sync to Test Org

```bash
eve auth sync --org org_manualtestorg
# Expected: "Set 2 secret(s) on org org_manualtestorg"
# Secrets: CLAUDE_CODE_OAUTH_TOKEN, CODEX_OAUTH_ACCESS_TOKEN
```

### 3.3 Verify Secret Resolution

```bash
eve secrets list --org org_manualtestorg --json
# Expected: Both CLAUDE_CODE_OAUTH_TOKEN and CODEX_OAUTH_ACCESS_TOKEN present
```

### 3.4 Smoke Test: Single Job with `claude` Harness

```bash
eve job create \
  --project $PROJECT_ID \
  --description "List the files in the current directory. Output a json-result with eve.summary listing the file count." \
  --harness claude \
  --json
export JOB_ID=<id_from_output>
eve job wait $JOB_ID --timeout 300
eve job show $JOB_ID --json
# Expected: phase = "done"
```

### 3.5 Smoke Test: Single Job with `codex` Harness

```bash
eve job create \
  --project $PROJECT_ID \
  --description "List the files in the current directory. Output a json-result with eve.summary listing the file count." \
  --harness codex \
  --json
export JOB_ID=<id_from_output>
eve job wait $JOB_ID --timeout 300
eve job show $JOB_ID --json
# Expected: phase = "done"
```

### 3.6 Fix-Up: If Auth Sync Fails

If `eve auth sync` doesn't find tokens, or the jobs fail with auth errors:

1. **Check credential sources:**
   ```bash
   # Claude
   security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null
   cat ~/.claude/.credentials.json | jq '.claudeAiOauth.accessToken' 2>/dev/null

   # Codex
   security find-generic-password -s "openai.codex" -w 2>/dev/null
   cat ~/.codex/auth.json | jq '.tokens.access_token' 2>/dev/null
   ```

2. **If tokens are stale:** Re-authenticate with the native CLIs:
   ```bash
   claude --version  # Re-authenticates if needed
   codex --version   # Re-authenticates if needed
   ```

3. **If keychain service names changed:** Update the extraction arrays in
   `packages/cli/src/commands/auth.ts:460` (Claude) and `:512` (Codex).

4. **Manual fallback:** Set secrets directly:
   ```bash
   eve secrets set --org org_manualtestorg --name CLAUDE_CODE_OAUTH_TOKEN --value "<token>"
   eve secrets set --org org_manualtestorg --name CODEX_OAUTH_ACCESS_TOKEN --value "<token>"
   ```

### Deliverables (Phase 3)

| Deliverable | Path |
|---|---|
| OAuth tokens synced | Eve secrets store |
| claude harness smoke test | Job completes `phase: done` |
| codex harness smoke test | Job completes `phase: done` |
| Any auth sync fixes | `packages/cli/src/commands/auth.ts` (if needed) |

---

## Phase 4: Manual Test Scenario 11

> A new scenario that validates the full factory relay chain.

### File

`tests/manual/scenarios/11-software-factory-relay.md`

### Scenario Content

```markdown
# Scenario 11: Software Factory Relay Chain

**Time:** ~10-15m
**Parallel Safe:** Yes (uses unique project slug `sftest`)
**LLM Required:** Yes (claude + codex harnesses)

Validates the end-to-end factory relay chain: PM → Planner → Coder →
Verifier. Uses the eve-software-factory AgentPack installed as a local
pack into a test project.

## What This Tests

| Layer | Control | Verified By |
|-------|---------|-------------|
| AgentPack resolution | Factory pack resolves with agents + teams + chat | `eve agents config --json` |
| Relay dispatch | Team dispatch creates blocking relay chain | `eve job tree` shows 4 chained jobs |
| Coordination thread | Handoff summaries in coordination thread | `eve thread messages` shows entries |
| Harness: claude | Claude harness receives OAuth token and executes | PM + Planner jobs complete |
| Harness: codex | Codex harness receives OAuth token and executes | Coder job completes |
| Coordination inbox | Each agent reads .eve/coordination-inbox.md | Job logs reference inbox |
| Git workflow | Agents commit to feature branch and push | Branch exists with commits |

## Prerequisites

- K8s stack running (`./bin/eh status`)
- Smoke tests pass (scenario 01)
- OAuth tokens synced: `eve auth sync --org org_manualtestorg`
  - Verify: `eve secrets list --org org_manualtestorg --json` shows
    CLAUDE_CODE_OAUTH_TOKEN and CODEX_OAUTH_ACCESS_TOKEN
- eve-software-factory repo exists at `../eve-software-factory`
- eve-horizon-fullstack-example repo exists at `../eve-horizon-fullstack-example`

## Setup

```bash
export ORG_ID=org_manualtestorg
export EVE_API_URL=${EVE_API_URL:-http://api.eve.lvh.me}

# 1. Ensure factory pack manifest entry exists in fullstack-example
# (This should already be configured in Phase 2 of the plan)

# 2. Create test project
eve project ensure \
  --org $ORG_ID \
  --name "factory-test" \
  --slug sftest \
  --repo-url https://github.com/eve-horizon/eve-horizon-fullstack-example \
  --branch main \
  --force \
  --json
export PROJECT_ID=<id_from_output>

# 3. Sync agents (from fullstack-example repo with factory pack)
cd ../eve-horizon-fullstack-example
eve agents sync --project $PROJECT_ID --ref main --repo-dir . --allow-dirty --local
cd ../eve-horizon
```

## Steps

### 1. Verify Factory Agents Resolved

```bash
eve agents config --project $PROJECT_ID --json
```

**Expected:**
- Factory agents appear: `factory-pm`, `factory-planner`, `factory-coder`, `factory-verifier`
- Team `factory` appears with `dispatch.mode: relay`
- Chat route `route_factory` appears with pattern `^factory\b`

### 2. Trigger Factory Run via Chat Simulate

```bash
eve chat simulate \
  --project $PROJECT_ID \
  --agent factory-pm \
  --message "factory Add a /health endpoint that returns JSON { status: ok, timestamp: <iso> }" \
  --json
export LEAD_JOB_ID=<id_from_output>
```

**Expected:**
- Job created and assigned to `factory-pm` agent
- Team dispatch creates relay chain (child jobs for planner, coder, verifier)

### 3. Verify Relay Chain Structure

```bash
eve job tree $LEAD_JOB_ID
```

**Expected:**
- Root job: factory-pm (lead)
- Child 1: factory-planner (blocked by PM)
- Child 2: factory-coder (blocked by planner)
- Child 3: factory-verifier (blocked by coder)

### 4. Wait for Factory Completion

```bash
# Follow the lead job (will complete when all children complete)
eve job wait $LEAD_JOB_ID --timeout 900

# Or follow individual jobs for more detail:
# eve job follow $LEAD_JOB_ID
```

**Expected:**
- PM job completes first (~2-3m)
- Planner job starts and completes (~3-4m)
- Coder job starts and completes (~3-5m)
- Verifier job starts and completes (~2-3m)
- All jobs reach `phase: done`

### 5. Verify Coordination Thread

```bash
# Get coordination thread from lead job hints
eve job show $LEAD_JOB_ID --json
# Look for hints.coordination.thread_id

eve thread messages <thread_id>
```

**Expected:**
- At least 4 messages (one summary per agent)
- Messages have `kind: status` with job summaries
- Chronological order: PM → Planner → Coder → Verifier

### 6. Verify Job Artifacts

```bash
# Check PM job produced a brief
eve job show <pm_job_id> --json
eve job logs <pm_job_id>
# Look for: docs/briefs/ file committed

# Check Planner job produced spec + plan
eve job logs <planner_job_id>
# Look for: docs/specs/ and docs/plans/ files committed

# Check Coder job produced implementation
eve job logs <coder_job_id>
# Look for: source files + test files committed

# Check Verifier job result
eve job show <verifier_job_id> --json
# Look for: eve.summary mentioning PR or acceptance criteria
```

**Expected:**
- Each agent's logs show it reading `.eve/coordination-inbox.md`
- Each agent commits to the feature branch
- Verifier reports acceptance criteria status

## Success Criteria

- [ ] Factory pack resolves: 4 agents, 1 relay team, 1 chat route
- [ ] `eve chat simulate` creates a relay chain of 4 jobs
- [ ] Job tree shows correct blocking dependencies (PM → Planner → Coder → Verifier)
- [ ] All 4 jobs complete with `phase: done`
- [ ] Coordination thread contains summaries from each agent
- [ ] PM job creates a brief with acceptance criteria
- [ ] Planner job creates a spec and plan
- [ ] Coder job implements code with tests
- [ ] Verifier job validates acceptance criteria
- [ ] Claude harness executes successfully (PM + Planner jobs)
- [ ] Codex harness executes successfully (Coder job)

## Debugging

### Auth sync issues
```bash
# Check what's on the host
eve auth creds

# Check what's in the org
eve secrets list --org org_manualtestorg --json

# Re-sync
eve auth sync --org org_manualtestorg
```

### Job stuck in active
```bash
eve job diagnose <job_id>
eve job follow <job_id>
eve system logs worker --tail 50
```

### Relay chain not created
```bash
# Check team config
eve agents config --project $PROJECT_ID --json | jq '.teams'

# Check chat routing
eve agents config --project $PROJECT_ID --json | jq '.chat'
```

### Harness auth failure
```bash
eve job logs <job_id>
# Look for: "auth", "token", "credential" error messages
eve system logs worker --tail 50
# Look for: harness adapter errors
```

## Notes

- The factory run creates a feature branch in the target repo. After testing,
  you may want to clean up branches.
- Total time depends on harness response times. Budget 10-15 minutes for the
  full relay chain.
- If one agent in the chain fails, subsequent agents will remain blocked.
  Check `eve job tree` to identify which agent failed.
```

### README Update

Add row to `tests/manual/README.md` scenario table:

```
| 11 | [Software Factory Relay](scenarios/11-software-factory-relay.md) | ~10-15m | Yes | Factory relay chain: PM → Planner → Coder → Verifier |
```

### Deliverables (Phase 4)

| Deliverable | Path |
|---|---|
| Scenario 11 | `tests/manual/scenarios/11-software-factory-relay.md` |
| README update | `tests/manual/README.md` (new row in table) |

---

## Phase Dependency Graph

```
Phase 1 (Create eve-software-factory repo)
    │
    ▼
Phase 2 (Install into fullstack-example)
    │
    ├──▶ Phase 3 (Validate auth sync for claude/codex)
    │
    ▼
Phase 4 (Manual test scenario 11)
```

Phase 3 can run in parallel with Phase 2 (auth sync is independent of pack
installation). Phase 4 depends on both Phase 2 and Phase 3.

---

## Files Changed Summary

### New Repo: `../eve-software-factory/`

| File | Purpose |
|---|---|
| `eve/pack.yaml` | AgentPack descriptor |
| `eve/agents.yaml` | 4-agent roster |
| `eve/teams.yaml` | Relay team topology |
| `eve/chat.yaml` | Chat route for factory |
| `eve/x-eve.yaml` | Harness profiles (claude + codex) |
| `skills/factory-pm/SKILL.md` | PM intake + brief skill |
| `skills/factory-pm/references/brief-template.md` | Brief template |
| `skills/factory-planner/SKILL.md` | Spec + plan skill |
| `skills/factory-planner/references/spec-template.md` | Spec template |
| `skills/factory-planner/references/plan-template.md` | Plan template |
| `skills/factory-coder/SKILL.md` | Implementation skill |
| `skills/factory-verifier/SKILL.md` | Verification + PR skill |
| `README.md` | Pack README |
| `.gitignore` | Standard gitignore |

### Modified: `../eve-horizon-fullstack-example/`

| File | Change |
|---|---|
| `.eve/manifest.yaml` | Add factory pack to `x-eve.packs` |

### Modified: `eve-horizon` (this repo)

| File | Change |
|---|---|
| `tests/manual/scenarios/11-software-factory-relay.md` | New test scenario |
| `tests/manual/README.md` | Add scenario 11 row |
| `packages/cli/src/commands/auth.ts` | Fix-up if auth sync needs updates |

---

## Testing Plan

### Unit (None Required)

No platform code changes — this is pure configuration + skills.

### Integration (None Required)

No new API endpoints or services.

### Manual Verification (Scenario 11)

The manual test scenario IS the verification. It validates:

1. **Pack resolution** — factory agents and teams appear in config
2. **Relay dispatch** — correct job tree with blocking dependencies
3. **Harness execution** — both `claude` and `codex` jobs complete
4. **Coordination** — thread captures handoff summaries
5. **Skill execution** — each agent follows its SKILL.md instructions
6. **Git workflow** — feature branch with commits from each phase

---

## Acceptance Criteria

- [ ] `eve-software-factory` repo exists with complete pack structure
- [ ] Pack resolves when added to fullstack-example manifest
- [ ] `eve auth sync` successfully pushes claude + codex tokens to test org
- [ ] Single `claude` harness job completes successfully
- [ ] Single `codex` harness job completes successfully
- [ ] Full relay chain (PM → Planner → Coder → Verifier) completes
- [ ] Coordination thread shows handoff summaries from all 4 agents
- [ ] Manual test scenario 11 documented and passes

---

## Open Questions

1. **Target repo for factory run**: Should the factory test create features in
   the fullstack-example repo itself, or a dedicated throwaway repo? Using
   fullstack-example means the factory operates on a real codebase (good for
   `existing` mode testing) but leaves artifacts. A throwaway repo is cleaner.
   *Leaning toward*: fullstack-example (tests `existing` mode, more realistic).

2. **Harness fallback in test**: If `codex` auth fails, should the test fall
   back to `claude` for all agents, or fail? The pack defines fallback profiles
   (codex primary, claude secondary) — this should work automatically via
   `drop_unavailable: true`. Verify this works.

3. **Skill prompt tuning**: The SKILL.md content above is a starting point.
   Real factory runs will likely require iterating on prompt specificity,
   output format enforcement, and edge case handling. Plan for 2-3 prompt
   tuning iterations after the first successful relay run.
