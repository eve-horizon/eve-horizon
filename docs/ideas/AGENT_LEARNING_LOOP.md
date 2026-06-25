# Agent Learning Loop for Eve Horizon

**How to make an Eve agent self-improving with mostly existing primitives, plus a few small glue improvements.**

---

## The Insight

The [Hermes Agent Learning Loop](./LEARNING_LOOP_SPEC.md) identifies five mechanisms that make agents learn over time: curated memory, procedural skills, background nudging, session search, and user modeling. The remarkable thing is that **Eve already has most of the storage and retrieval primitives needed for this loop**. What's missing is partly the behavioral layer that tells agents to learn, and partly a few small platform conveniences that make the loop cleaner and more automatic.

The core learning loop is a behavior, not a feature. It should mostly live in skill instructions, repo-first agent config, and pack conventions. Platform changes should be reserved for the small glue points that materially improve ergonomics or automation.

---

## Eve Primitives — What Already Exists

| Hermes Mechanism | Eve Primitive | Status |
|---|---|---|
| Curated Memory (bounded notes) | `eve memory` + org docs + `context.memory` carryover | Ready |
| Skills (procedural playbooks) | AgentPacks + skills root + org docs under `/agents/{slug}/skills/` | Ready |
| Session Search (past recall) | Org docs search + recent thread carryover | Partial |
| Background Nudging (auto-reflect) | `cron.tick` triggers + reviewer workflows | Ready |
| User Modeling (who am I talking to) | Memory/docs are sufficient for storage, but no first-class `user` carryover category yet | Partial |

The platform already provides:
- **Agent Memory API + CLI** — category-based entries with confidence, supersedes, review/expiry, search
- **Context Materialization** — declarative `context.memory` injects memory into `.eve/context/memory/` at job start (functionally a frozen snapshot)
- **Org Docs** — versioned, FTS-searchable document store with lifecycle management (`review_due`, `expires_at`)
- **Agent KV Store** — fast key-value with TTL per agent/namespace
- **Threads** — full conversation history with coordination inbox
- **Cron + Workflow Triggers** — `cron.tick` events plus manifest/pack workflow triggers for periodic reflection
- **Events + Workflow Triggers** — durable event spine for automation

---

## Architecture

### Where Knowledge Lives

```
Declarative Memory (always loaded)          Procedural Memory (loaded on demand)
──────────────────────────────────          ─────────────────────────────────────
Org Docs: /agents/{slug}/memory/            Org Docs: /agents/{slug}/skills/
  ├── learnings/                              ├── debug-k8s-networking.md
  ├── decisions/                              ├── handle-failed-builds.md
  ├── conventions/                            └── optimize-docker-layers.md
  ├── context/
  └── runbooks/                             Optional: promoted to repo at
                                            skills/{slug}/*.md after N uses
Injected via context.memory
~1,500 tokens fixed overhead               Loaded via context.docs when matched
                                            500-5,000 tokens on demand
```

### The Core Stores

| Store | Path Convention | Capacity | What Goes Here |
|---|---|---|---|
| Agent Memory | `/agents/{slug}/memory/{category}/*.md` | Bounded by policy | Environment facts, conventions, lessons, runbooks |
| Skills | `/agents/{slug}/skills/*.md` | On-demand | Reusable procedures, checklists, debugging playbooks |

Capacity is still enforced mostly by skill instructions and reviewer behavior, not hard platform quotas. The agent manages its own budget, while org-doc lifecycle fields (`expires_at`, `review_due`) handle staleness and review reminders. User-specific notes can still be stored today, but they are best treated as a convention loaded via `context.docs` until a dedicated carryover category exists.

### Knowledge Flow

```
                         ┌──────────────────────┐
                         │    Agent Session      │
                         │                       │
   context.memory ──────►│  Frozen Memory        │
   context.docs ────────►│  Skill Index          │
   thread history ──────►│  Conversation         │
                         │                       │
                         │  ┌─────────────────┐  │
                         │  │ During Session:  │  │
                         │  │ • Read skills    │  │
                         │  │ • Write memory   │  │
                         │  │ • Use KV store   │  │
                         │  └─────────────────┘  │
                         └───────────┬───────────┘
                                     │
                          ┌──────────▼──────────┐
                          │  Post-Session        │
                          │  Review (async)      │
                          │                      │
                          │  Reviewer agent:     │
                          │  • Reads job logs    │
                          │  • Extracts insights │
                          │  • Updates memory    │
                          │  • Creates/patches   │
                          │    skills            │
                          └───────────┬──────────┘
                                      │
                           ┌──────────▼──────────┐
                           │  Outward Review      │
                           │  (platform friction) │
                           │                      │
                           │  • CLI bug?          │
                           │  • Missing feature?  │
                           │  • Stale skill?      │
                           │  • Wrong docs?       │
                           │                      │
                           │  ──► Open PR         │
                           │  ──► Patch skill     │
                           │  ──► Slack notify    │
                           └──────────────────────┘
```

### Two Review Dimensions

The reviewer doesn't just help agents learn — it improves the entire environment.

| Dimension | What It Watches For | Output |
|---|---|---|
| **Inward** (agent self-improvement) | Learnings, preferences, conventions, reusable procedures | Memory writes, skill creation/patches |
| **Outward** (environment improvement) | App bugs, API issues, stale skills, wrong docs, CLI gaps, config problems | PRs, issues, skill patches, Slack notifications |

Both flow through the same post-session review. The reviewer produces a structured report with two sections. Inward findings are written to memory/skills immediately. Outward findings are triaged and dispatched to a separate **improver agent** that has git access and can open PRs.

#### Why This Matters

When agents run inside an Eve-compatible app, they constantly hit small friction points. Most of these are in the **app itself**, not the Eve platform:

- The app's API returns an unexpected shape and the agent has to parse around it
- The app's CLI is missing a flag so the agent falls back to `curl`
- A skill has stale instructions that reference an old endpoint
- A docs page describes the v1 API but the app is on v2
- A config value is wrong and the agent wastes a turn discovering the right one

Occasionally it's an Eve platform issue (a `eve` CLI bug, a harness gap), but **most of the time the friction is in the app the agent is operating within**.

Today these paper cuts are invisible. The agent works around them, the session ends, nobody knows. With outward review, every friction point becomes a potential improvement — a PR opened, a skill patched, a Slack message sent. The app gets better every time an agent bumps into something. Over time, the agents sand down their own rough edges.

#### The Outward Review Flow

```
Reviewer reads session logs
    │
    ├── App API returned unexpected shape, agent had to parse around it
    │   → Classification: app_api_bug
    │
    ├── App CLI missing a flag, agent fell back to curl/fetch
    │   → Classification: app_cli_gap
    │
    ├── Agent loaded a skill, but instructions were wrong/outdated
    │   → Classification: stale_skill
    │
    ├── Agent couldn't find expected docs, had to discover by reading source
    │   → Classification: docs_gap
    │
    ├── Agent's config was wrong (wrong harness, missing context, bad policy)
    │   → Classification: config_issue
    │
    └── Eve platform CLI/API issue (less common)
        → Classification: platform_bug

Each classified finding becomes a structured issue:
{
  "source": "app" | "platform",
  "type": "api_bug" | "cli_gap" | "stale_skill" | "docs_gap" | "config_issue",
  "severity": "low" | "medium" | "high",
  "file_or_endpoint": "... where the issue is ...",
  "description": "...",
  "evidence": "... relevant log excerpt ...",
  "suggested_fix": "... if obvious ..."
}

High-severity findings → Improver agent opens a PR (app repo or platform repo)
Medium findings → PR or issue depending on whether a fix is obvious, Slack notification
Low findings → Logged to org docs for weekly batch review
All PRs require human review before merge — the PR is the review gate
```

#### The Improver Agent

A second agent in the pack. Unlike the reviewer (cheap, read-only, triage), the improver has full coding capability:

- **Harness**: opus or sonnet-high (needs real reasoning to write fixes)
- **Git access**: `commit: auto`, `push: on_success`
- **Scope**: Only acts on findings from the reviewer, never free-roaming
- **Target**: Primarily the app's own repo (code, CLI, skills, docs). For platform-level findings, the improver's skill instructions tell it to clone the relevant upstream repo (using the project's `repo_url` or well-known Eve repo URLs from its skill), create a branch, and open a PR there. Which repos it can push to depends on the credentials available to the agent at runtime (SSH keys, GitHub tokens in project secrets).
- **Output**: PR with description and evidence, always for human review. Issues for findings where the fix isn't obvious.
- **PR convention**: Branch named `learning-loop/{finding-type}/{short-description}`, PR body includes the session evidence and a link to the original job

```yaml
# eve/agents.yaml (addition)
agents:
  platform_improver:
    slug: platform-improver
    skill: platform-improver
    harness_profile: improver-capable
    description: "Fixes platform friction points identified by the session reviewer"
    policies:
      permission_policy: auto_edit
      git:
        commit: auto
        push: on_success
```

The improver runs as a child job of the review, only when the reviewer identifies actionable outward findings. This keeps cost bounded — no findings, no improver job.

#### Slack Notification

When the reviewer or improver takes action, post a summary to a configured Slack channel:

```
🔄 Learning Loop Review — agent `mission-control`, job `mc-a3f2dd12`

📝 Inward:
  • Added memory: "User prefers terse log output, no color codes"
  • Patched skill: `debug-k8s-networking` (added DNS check step)

🔧 Outward:
  • PR #247: Fix `myapp api users` returning nested array instead of flat list
  • PR #248: Add `--format json` flag to `myapp report generate`
  • Issue #249: `/api/v2/search` returns 500 on empty query string
  • Patched skill: `deploy-checklist` (updated rollback step for new API shape)
```

This uses Eve's existing Slack gateway integration. The reviewer posts via `eve-message` blocks that route through the chat gateway.

---

## The Learning Loop AgentPack

A self-contained pack that any Eve project can adopt:

```
learning-loop-agentpack/
├── .eve/
│   └── manifest.yaml
├── eve/
│   ├── pack.yaml
│   ├── agents.yaml            # Reviewer + improver agent definitions
│   ├── workflows.yaml         # Post-session + heartbeat + improvement triggers
│   └── x-eve.yaml             # Harness profiles (cheap for review, capable for fixes)
├── skills/
│   ├── learning-brain/
│   │   └── SKILL.md           # Core learning instructions (composable)
│   ├── memory-manager/
│   │   └── SKILL.md           # Memory CRUD operations
│   ├── session-reviewer/
│   │   └── SKILL.md           # Post-session reflection + triage procedure
│   └── platform-improver/
│       └── SKILL.md           # Fix platform friction, open PRs
└── README.md
```

### What Each Component Does

#### 1. The Learning Brain (Composable Skill)

`skills/learning-brain/SKILL.md` — instructions that any agent can load alongside its primary skill. Teaches the agent to:

- **Read memory at session start** — check `.eve/context/memory/` for prior knowledge
- **Scan the skill index** — check `.eve/context/docs/agents/{slug}/skills/` or other loaded doc paths for relevant procedures before acting
- **Write memory proactively** — when a convention is discovered, when a lesson is learned, or when the user reveals a durable preference worth keeping
- **Respect capacity** — self-manage the bounded memory budget, replace stale entries instead of appending forever
- **Use the right store** — durable facts and conventions go into memory; reusable procedures become skills; user-specific notes stay in a dedicated docs subtree until first-class support exists

This is the behavioral policy that makes agents learn. It's ~800 tokens injected into the system prompt alongside the agent's primary skill.

#### 2. The Memory Manager (Tool Guidance)

`skills/memory-manager/SKILL.md` — procedures for memory CRUD using Eve's existing APIs. Prefer the dedicated memory CLI/API surface for memory entries, and use org docs directly for skills:

```bash
# Read current memory
eve memory list --org $ORG --agent my-agent --category learnings --json

# Write a new entry
eve memory set --org $ORG --agent my-agent --category learnings --key k8s-networking \
  --content "Pods on this cluster often fail first on DNS before CNI." \
  --tags k8s,networking --confidence 0.8 --review-in 14d

# Write a shared convention
eve memory set --org $ORG --shared --category conventions --key api-style \
  --file ./api-style.md --confidence 0.9

# Search memory
eve memory search --org $ORG --agent my-agent --query "docker networking" --limit 10 --json

# Write or patch a skill doc
eve docs write --org $ORG --path /agents/my-agent/skills/handle-failed-builds.md \
  --file ./handle-failed-builds.md --metadata '{"kind":"skill"}'
```

No new tool class is needed — the Eve CLI already exposes the right building blocks.

#### 3. The Session Reviewer (Background Reflection + Triage)

`skills/session-reviewer/SKILL.md` — the "background nudging" agent. After a job completes:

1. Load the completed agent's current memory (org docs by prefix)
2. Load the job's conversation/logs (thread messages or job logs)
3. **Inward review** — scan for:
   - User preferences or corrections not yet in memory
   - Environmental discoveries worth recording
   - Procedural knowledge that could become a skill
4. **Outward review** — scan for app and environment friction:
   - App API calls that returned unexpected shapes or errors
   - App CLI commands that failed or were missing expected flags
   - Fallbacks to `curl`/`fetch` when a CLI command should have worked
   - Skills that were loaded but had wrong or stale instructions
   - Documentation gaps that forced the agent to discover by reading source
   - Config issues (wrong harness, missing context, bad permissions)
   - Eve platform issues (less common — `eve` CLI bugs, harness gaps)
5. Write inward findings to the agent's memory/skills namespace
6. Emit outward findings as structured issues (see "Outward Review Flow" above)
7. If outward findings exist, dispatch a child job to the platform-improver agent
8. Post a Slack summary of all actions taken

Uses a cheap/fast harness profile (sonnet with low reasoning) to minimize cost. The improver child job uses a more capable profile.

#### 4. The Platform Improver (Fix and PR)

`skills/platform-improver/SKILL.md` — acts on outward findings from the reviewer:

1. Read the structured finding (type, severity, evidence, suggested fix)
2. Locate the relevant code/skill/doc
3. For fixable issues: make the change, open a PR with description and evidence
4. For non-obvious issues: create a GitHub issue with full context
5. Notify on Slack with what was done

This agent needs a capable harness profile because it's writing real code. It only runs when the reviewer finds actionable friction — no findings, no cost.

### Agent Definitions

```yaml
# eve/agents.yaml
version: 1
agents:
  session_reviewer:
    slug: session-reviewer
    skill: session-reviewer
    harness_profile: review-cheap
    description: "Reviews completed agent sessions — extracts learnings (inward) and triages platform friction (outward)"
    policies:
      permission_policy: auto_edit
      git:
        commit: never
        push: never

  platform_improver:
    slug: platform-improver
    skill: platform-improver
    harness_profile: improver-capable
    description: "Fixes friction identified by the reviewer — opens PRs against app or platform repos for human review"
    policies:
      permission_policy: auto_edit
      git:
        commit: auto
        push: on_success
```

### Workflow Triggers

```yaml
# eve/workflows.yaml
workflows:
  post-session-review:
    trigger:
      system:
        event: job.attempt.completed    # Platform gap — see below
    steps:
      - name: review
        agent:
          name: session_reviewer
        prompt: |
          Review the completed job {event.job_id} for agent {event.assignee}.
          Skip non-agent jobs and skip the reviewer/improver themselves.

          INWARD: Load the agent's current memory from org docs.
          Read the job's conversation from thread {event.thread_id}.
          Extract learnings and update memory. Create skills if warranted.

          OUTWARD: Scan the session for app and environment friction:
          - App API calls that returned unexpected shapes or errors
          - App CLI commands that failed or were missing flags
          - Fallbacks to curl/fetch when a CLI command should have worked
          - Skills that were loaded but had wrong/stale instructions
          - Documentation that was missing or outdated
          - Config issues that slowed the agent down
          - Eve platform issues (less common)

          For each outward finding, emit a structured json-result with
          type, severity, description, evidence, and suggested_fix.

          If any outward findings have severity >= medium, dispatch
          a child job to platform-improver with the findings.

          Post a Slack summary of all actions taken.

  skill-review-heartbeat:
    trigger:
      cron:
        schedule: "0 */6 * * *"    # Every 6 hours
    steps:
      - name: review-skills
        agent:
          name: session_reviewer
        prompt: |
          Review all agent skills in this org.
          Check each skill's last-used date and update count.
          Archive unused skills. Merge duplicates.
          Promote high-value skills to the project repo if configured.

  batch-improvements:
    trigger:
      cron:
        schedule: "0 9 * * 1"    # Monday mornings
    steps:
      - name: batch-fix
        agent:
          name: platform_improver
        prompt: |
          Review accumulated low-severity outward findings from the past week.
          Group related findings (e.g. multiple CLI gaps in the same module).
          For each group, open a single PR that addresses all items.
          Post a weekly summary to Slack.
```

---

## Opt-In Experience

### Level 1: Passive Learning (5 minutes)

Add the pack. Your agents start building memory.

```yaml
# .eve/manifest.yaml
x-eve:
  packs:
    - source: github:eve-horizon/learning-loop-agentpack
      ref: <git-sha>
  agents:
    config_path: agents/agents.yaml
```

```yaml
# agents/agents.yaml
version: 1
agents:
  my_agent:
    slug: my-agent
    skill: app-builder
    context:
      memory:
        agent: my-agent
        categories: [learnings, decisions, runbooks, context, conventions]
        max_items: 10
        max_age: 30d
      docs:
        - path: /agents/shared/memory/conventions/
          recursive: true
```

That's it. The agent now:
- Receives its memory at session start via context materialization
- Follows the learning-brain skill to proactively write learnings
- Has a reviewer agent that extracts insights after each session

### Level 2: Active Skill Building (10 minutes)

Enable skill discovery and self-improvement:

```yaml
# agents/agents.yaml
version: 1
agents:
  my_agent:
    slug: my-agent
    skill: app-builder
    context:
      memory:
        agent: my-agent
        categories: [learnings, decisions, runbooks, context, conventions]
        max_items: 10
        max_age: 30d
      docs:
        - path: /agents/shared/memory/conventions/
          recursive: true
        - path: /agents/my-agent/skills/
          recursive: true
```

Now the agent also:
- Loads its skill index at session start
- Checks for relevant skills before acting on complex tasks
- Creates new skills when it discovers reusable procedures
- Patches skills when instructions are wrong or incomplete

If a team wants user-specific carryover today, keep it in a dedicated docs subtree and load it with `context.docs`. A first-class `user` memory category would make this cleaner, but it is not required for a pilot.

### Level 3: Repo-Committed Knowledge (15 minutes)

Promote proven skills to the project repo:

```yaml
# agents/agents.yaml
version: 1
agents:
  my_agent:
    slug: my-agent
    skill: app-builder
    policies:
      git:
        commit: auto
        push: on_success
```

```yaml
# .eve/manifest.yaml
workflows:
  promote-skills:
    trigger:
      cron:
        schedule: "0 0 * * 0"    # Weekly
    steps:
      - name: promote
        agent:
          name: session_reviewer
        prompt: |
          Review skills in org docs under /agents/my-agent/skills/.
          For any skill with confidence >= 0.8 and used >= 3 times:
          1. Write it to the repo at skills/my-agent/{skill-name}/SKILL.md
          2. Commit with message "learn: promote {skill-name} from org docs"
          3. Leave the org-doc copy in place until the repo version is validated
```

Skills start as ephemeral org docs, graduate to the repo when proven. The git history tells the story of what the agent learned.

---

## Platform Gaps

None of these block a pilot. A pack-based pilot can ship today using `eve memory`, `context.memory`, doc-backed skills, and `cron.tick` review workflows. These gaps only make the loop tighter or more ergonomic.

### High-Value Follow-Ons

**Completion Event for Immediate Review**

The orchestrator emits failure events, but there is no matching success/completion event that makes post-session review immediate and exact. Today the reviewer can poll on cron; an explicit completion event would be cleaner.

- **Where**: `apps/orchestrator/src/loop/loop.service.ts` (or the final attempt completion path if that moves)
- **Event type**: `system.job.attempt.completed`
- **Trigger syntax**: `system: { event: job.attempt.completed }`
- **Payload shape**: `{ job_id, attempt_id, assignee, thread_id, execution_type, duration_seconds }`
- **Effort**: ~50-80 lines. The orchestrator already records final attempt state, so this is a narrow glue change.

**Current workaround**: Use a `cron.tick` workflow. The reviewer runs every N minutes, queries recent completed agent jobs, and skips any with a `reviewed_at` marker in agent KV or memory metadata.

**First-Class User-Profile Carryover**

The storage primitive exists, but `context.memory.categories` currently supports `learnings`, `decisions`, `runbooks`, `context`, and `conventions` only. If we want user modeling to be a default part of the loop, we should stop treating it as an ad hoc docs convention.

- **Where**: `packages/shared/src/schemas/agent-config.ts`, `packages/shared/src/invoke/carryover-context.ts`
- **Change**: add a first-class `user` carryover category or a dedicated `context.user_docs` block
- **Effort**: ~40-80 lines plus tests

**Current workaround**: store user-specific notes in a dedicated docs subtree and load it via `context.docs`.

### Nice-to-Have

**Thread Message Search API**

Org docs have FTS. Thread messages don't. For session search ("did we discuss X last week?"), agents need to search across thread messages.

- **Where**: `apps/api/src/threads/` — add `GET /orgs/{org_id}/threads/messages/search?q=...`
- **Implementation**: Add `tsvector` column to `thread_messages`, GIN index, search endpoint
- **Effort**: ~200 lines

**Memory Capacity Metadata**

Currently capacity is enforced by skill instructions (agent self-manages). Platform could enforce limits:

```yaml
# Agent config extension
context:
  memory:
    capacity: 2200    # Max chars across all categories
    user_capacity: 1400
```

Low priority — self-management works well enough (Hermes proves this).

**Skill Usage Tracking**

To know when to promote a skill, we need usage counts. Could be:
- A `used_count` field on org docs (increment on read)
- Agent KV entries tracking skill invocations
- An event emitted when a skill is loaded

---

## Design Decisions

### Why Org Docs, Not Org Filesystem?

| Dimension | Org Docs | Org Filesystem |
|---|---|---|
| Versioning | Built-in (every update = new version) | None (overwrite) |
| Search | FTS with tsvector | None (grep the mount) |
| Lifecycle | `review_due`, `expires_at`, status | None |
| API access | Full REST API | Sync protocol only |
| Metadata | JSONB (confidence, tags, supersedes) | None |
| Capacity | Queryable (count chars by prefix) | Must scan files |

Org docs win on every dimension that matters for learning.

### Why Not Auto-Commit Everything?

Memory is **ephemeral and bounded**. It changes every session. Committing it to git would create noise — dozens of commits per day updating memory entries. Git is for **durable knowledge** (proven skills, established conventions).

The graduation model: org docs → repo. Memory stays in docs. Skills get promoted when they prove useful.

### Why a Separate Reviewer Agent?

Two reasons from the Hermes spec:

1. **Non-blocking** — the reviewer runs after the session ends, not during. The user never waits for reflection.
2. **Different cost profile** — the reviewer uses a cheap/fast model (sonnet-low). The primary agent might use opus. Reflection doesn't need expensive reasoning.

Eve's job system makes this natural — the reviewer is just another job triggered by an event.

### Why Not Turn-Level Nudging?

Hermes nudges after every 10 turns. This requires runtime hooks in the agent execution loop — a platform change. Eve's post-session model is cleaner:

- **Post-session review catches everything** that happened during the session
- **No runtime overhead** — the primary agent runs at full speed
- **No forking complexity** — separate job, separate agent, clean separation
- **Cost-bounded** — one review per session, not one per N turns

The tradeoff: mid-session learning is delayed until the next session. For most use cases, this is fine — memory refreshes at session start anyway.

### Why Pack, Not Platform Feature?

Packs are:
- **Opt-in** — agents that don't need learning don't pay for it
- **Customizable** — override the reviewer's harness profile, change the heartbeat interval
- **Evolvable** — update the pack without a platform deploy
- **Portable** — the pattern works for any Eve project

If learning proves universally valuable, the behavioral layer (skill instructions) could graduate into the platform's default agent config. But start as a pack.

---

## Implementation Plan

### Phase 1: Learning Brain Skill (1 day)

Write the composable skill instructions that teach agents to learn. This requires zero platform changes — it's just a well-crafted SKILL.md.

Test with an existing agent:
1. Add `context.memory` to `agents/agents.yaml`
2. Load the learning-brain skill alongside the agent's primary skill via the pack
3. Run 5-10 sessions
4. Verify memory entries accumulate via `eve memory list`
5. Verify next-session behavior improves

### Phase 2: AgentPack Structure (1 day)

Package the skills into a proper AgentPack:
- `eve/pack.yaml`, `eve/agents.yaml`, `eve/workflows.yaml`, `eve/x-eve.yaml`
- Reviewer agent definition with cheap/fast profile
- Cron-based review workflow (`cron.tick`, which exists today)

### Phase 3: Post-Session Event (0.5 days)

Emit `system.job.attempt.completed` from the orchestrator. This upgrades the reviewer from polling to exact event-driven review.

### Phase 4: Session Reviewer Agent (1 day)

Build and test the reviewer agent — both dimensions:
- **Inward**: Read completed job's thread/logs, compare against existing memory, write new entries, replace stale ones, create skills for discovered procedures
- **Outward**: Scan for CLI failures, curl fallbacks, stale skills, docs gaps. Emit structured findings. Dispatch improver when severity >= medium.

### Phase 5: Platform Improver Agent (1 day)

Build and test the improver agent:
- Read structured findings from the reviewer
- Locate relevant code/skill/doc in the project or pack repos
- Make the fix, open a PR with evidence and description
- Post Slack notification
- Monday batch job for accumulated low-severity findings

### Phase 6: Skill Promotion (0.5 days)

The promotion workflow:
- Weekly heartbeat scans skills in org docs
- Skills with high confidence + usage get committed to repo
- Creates proper `skills/{agent}/{name}/SKILL.md` structure

### Phase 7: Thread Message Search (1 day, optional)

Add FTS to thread messages for cross-session recall. Lower priority — org docs search covers most cases.

---

## Testing Plan

We should test this at three layers: contract, integration, and behavior. The point is not only to prove that memory entries get written, but to prove that later sessions actually consume them and change behavior.

### 1. Contract Tests

- **Carryover context**: add unit tests around `packages/shared/src/invoke/carryover-context.ts` to verify that `context.memory` materializes the expected categories into `.eve/context/memory/`, that `max_items` and `max_age` are honored, and that `context.docs` recursively materializes skill docs.
- **Trigger matching**: add unit tests around `apps/orchestrator/src/events/trigger-matcher.service.ts` for the cron-based reviewer workflow and, once added, the completion-event trigger.
- **Pack resolution**: add tests for pack imports so `eve/pack.yaml` resolves `agents`, `workflows`, and `x_eve` correctly for the learning-loop pack.

### 2. Integration Tests

- **Memory write path**: create an integration test that runs an agent job, writes memory via `eve memory set`, and asserts the stored entry is retrievable via `eve memory get` and `eve memory search`.
- **Reviewer loop**: trigger a review run against a completed agent job and assert that new memory is created only once, with a marker that prevents duplicate processing on the next cron tick.
- **Skill creation path**: simulate a session that should produce a reusable playbook and verify the reviewer writes a skill doc under `/agents/{slug}/skills/`.
- **Promotion path**: for repo-backed promotion, verify the reviewer only promotes a skill after the threshold is met and that git policy settings (`commit: auto`, `push: on_success`) are sufficient.

### 3. End-to-End Behavior Tests

Run a small pilot project locally and deliberately exercise repeated tasks.

1. Start with an agent that has no memory.
2. Run a session where the user corrects the agent or reveals a preference.
3. Confirm the reviewer stores the learning.
4. Run a second session with a similar prompt.
5. Verify the agent changes behavior without being re-told.

Concrete scenarios:

- **Preference retention**: tell the agent "always use `rg`, not `grep`". The next similar task should follow that preference because it appears in memory or loaded docs.
- **Convention retention**: correct the agent on a project naming or API style convention, then verify the next session follows it.
- **Runbook formation**: repeat a debugging class several times, then verify a skill doc is created and later loaded by `context.docs`.
- **Staleness handling**: mark a memory entry overdue with `review_due`, run the reviewer, and verify it refreshes, archives, or supersedes the entry rather than duplicating it.

### 4. Acceptance Criteria

A pilot is working if all of the following are true:

- After a correction in session N, session N+1 behaves differently without being re-prompted.
- Memory stays bounded and is updated in place instead of growing unbounded duplicates.
- The reviewer is idempotent: re-running it does not create duplicate learnings for the same session.
- Skills are only promoted after repeated use or explicit confidence thresholds.
- Disabling the pack cleanly removes the behavior without requiring platform changes.

### 5. Minimum Test Sequence for First Rollout

If we want the smallest useful validation pass before wider adoption:

1. Unit test carryover context.
2. Integration test memory CRUD plus reviewer idempotency.
3. One manual end-to-end preference-retention scenario on local Eve.
4. One manual end-to-end runbook-creation scenario on local Eve.

That is enough to prove the loop is real before investing in the optional platform follow-ons.

---

## Success Metrics

An agent with the learning loop should:

1. **Stop repeating mistakes** — if corrected once, the correction persists in memory
2. **Remember preferences** — user communication style, tool preferences, naming conventions
3. **Build playbooks** — after debugging the same type of issue 3x, a skill exists
4. **Self-curate** — old/stale entries get replaced, capacity stays bounded
5. **Share knowledge** — promoted skills are available to other agents in the project
6. **Sand down rough edges** — app bugs, CLI gaps, and stale skills get fixed automatically via PRs
7. **Surface invisible friction** — problems that agents silently work around become visible on Slack

### How to Measure

```bash
# Memory growth over time
eve docs list --org $ORG --prefix /agents/my-agent/memory/ --json | jq length

# Skill creation rate
eve docs list --org $ORG --prefix /agents/my-agent/skills/ --json | jq length

# Promoted skills (in repo)
ls skills/my-agent/

# Memory utilization
eve docs list --org $ORG --prefix /agents/my-agent/memory/ --json | \
  jq '[.[].content | length] | add'  # Total chars
```

---

## Open Questions

1. **Cross-agent memory sharing** — Should agent A be able to read agent B's memory? Useful for teams. Risk of context pollution. Probably scoped by team membership.

2. **Memory conflict resolution** — Two sessions writing to the same memory entry simultaneously. Org docs has versioning but not merge semantics. Last-write-wins is probably fine for memory (it's bounded anyway).

3. **Learning from failures** — Should the reviewer weight failed jobs differently? Failures often contain the most valuable learnings ("this approach doesn't work because...").

4. **Privacy boundaries** — User profile memory might contain sensitive preferences. Should there be ACLs on memory categories? Or is org-scoping sufficient?

5. **Skill quality gate** — Who reviews promoted skills before they enter the repo? Auto-promote with high confidence? Require human review? Create a PR?

6. **Improver autonomy level** — Should the improver auto-merge its own PRs for low-risk fixes (typos, docs updates, skill patches)? Or should every PR require human review? Probably configurable per project — some teams want full auto-pilot, others want approval gates.

7. **Cross-project learning** — If agent A in project X discovers a CLI pattern that works, should that knowledge propagate to agent B in project Y? Org-scoped shared memory partially handles this, but skill sharing across projects is a bigger question.

8. **Feedback on fixes** — When the improver opens a PR and it gets merged, the reviewer should learn "this type of fix works." When a PR gets rejected, it should learn "don't try this again." This creates a meta-learning loop on the improvement process itself.
