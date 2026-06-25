# Learning Loop Specification

**How Hermes Agent learns over time, and how to build the same in any agent system.**

This document reverse-engineers the five interconnected learning mechanisms in Hermes Agent into a portable spec. Each section describes *what* the mechanism does, *why* it matters, the key design decisions that make it work, and enough implementation detail to reproduce it in another stack.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Curated Memory (Declarative Knowledge)](#2-curated-memory)
3. [Skills (Procedural Knowledge)](#3-skills)
4. [Background Nudging (Learning Triggers)](#4-background-nudging)
5. [Session Search (Episodic Recall)](#5-session-search)
6. [Cross-Session User Modeling (Honcho)](#6-cross-session-user-modeling)
7. [How the Pieces Fit Together](#7-how-the-pieces-fit-together)
8. [Implementation Guide](#8-implementation-guide)
9. [Security Considerations](#9-security-considerations)

---

## 1. Architecture Overview

The agent's knowledge is layered by **cost, latency, and specificity**:

```
Layer           Always loaded?   Token cost    What it stores
─────────────────────────────────────────────────────────────
Curated Memory  Yes (frozen)     ~1,300 tok    User prefs, env facts
Skills Index    Yes (names only) ~200 tok      Skill names/descriptions
Skill Content   On demand        ~500-5k tok   Procedures, step-by-step
Session Search  On demand        LLM call      Past conversation recall
Honcho Context  Yes (if enabled) ~200 tok      Deep user model
```

The core insight: **not everything belongs in the context window**. Memory that is always relevant (user preferences, environment facts) is injected into every turn. Procedural knowledge (skills) is loaded only when matched. Historical recall (session search) is triggered only when explicitly needed. This layering keeps the fixed token overhead low (~1,500 tokens) while giving the agent access to unbounded knowledge.

### The Frozen Snapshot Pattern

All memory injected into the system prompt is **frozen at session start**. Mid-session writes update the persistent store on disk but do *not* mutate the system prompt. This preserves the LLM's prefix cache for the entire session. The snapshot refreshes on the next session start.

This is a critical performance optimization: without it, every memory write would invalidate the prefix cache and force reprocessing of the full system prompt on the next turn.

---

## 2. Curated Memory

**Purpose:** Bounded, agent-managed declarative knowledge that persists across sessions.

### Two Stores

| Store | File | Char Limit | What Goes Here |
|-------|------|-----------|----------------|
| Memory | `MEMORY.md` | 2,200 chars | Environment facts, project conventions, tool quirks, lessons learned |
| User Profile | `USER.md` | 1,375 chars | User's name, role, preferences, communication style, pet peeves |

### Why Two Stores?

Separating *facts about the world* from *facts about the user* serves two purposes:
1. **Different eviction priorities** -- user preferences are higher value per character than environment facts.
2. **Honcho integration** -- the user profile can be managed by a separate user-modeling system while agent notes stay local.

### Entry Format

Entries are delimited by `\n§\n` (section sign). This delimiter was chosen because:
- It never appears in natural language or code
- It supports multiline entries (unlike newline-delimited formats)
- It's model-independent (char counts, not tokens)

### Operations

The memory tool exposes three actions:

| Action | Input | Behavior |
|--------|-------|----------|
| `add` | target, content | Append new entry. Reject if limit exceeded. Reject exact duplicates. |
| `replace` | target, old_text, content | Find entry containing `old_text` substring, replace it entirely. Fail if 0 or >1 non-identical matches. |
| `remove` | target, old_text | Find entry containing `old_text` substring, delete it. Same matching rules. |

**Substring matching** instead of IDs: The agent doesn't need to remember entry IDs. A short unique substring is sufficient to identify an entry. This is more natural for LLMs and avoids ID management overhead.

### Concurrency Safety

Multiple sessions (CLI + gateway) may write simultaneously. Hermes uses:
1. **File-level locks** (`fcntl.flock`) on a separate `.lock` file for read-modify-write atomicity
2. **Atomic writes** via `tempfile.mkstemp` + `os.replace` so readers never see partial content
3. **Reload-under-lock** -- before mutating, re-read the file to pick up writes from other sessions

### System Prompt Injection

```
══════════════════════════════════════════════
MEMORY (your personal notes) [45% -- 990/2,200 chars]
══════════════════════════════════════════════
User's project uses Python 3.12 with uv for package management
§
The API key for staging is in ~/.config/staging.env, not .env
§
User prefers terse responses, no trailing summaries
```

The header shows utilization percentage so the agent can self-manage capacity. When memory is near the limit, the agent knows to replace or remove entries before adding new ones.

### What to Store (Tool Schema Guidance)

The tool's schema description encodes behavioral policy directly:

> **WHEN TO SAVE** (do this proactively, don't wait to be asked):
> - User corrects you or says "remember this" / "don't do that again"
> - User shares a preference, habit, or personal detail
> - You discover something about the environment
> - You learn a convention, API quirk, or workflow specific to this user
>
> **Do NOT save:** task progress, session outcomes, completed-work logs, or temporary TODO state. Use session_search for those.

This is a key design decision: **policy lives in the tool schema, not in a separate rules engine**. The LLM reads the tool description and follows the guidance naturally.

### How to Reproduce

1. Create two bounded text files with a non-colliding delimiter
2. Expose add/replace/remove operations as a tool
3. Inject content into the system prompt as a frozen snapshot
4. Put behavioral guidance in the tool schema description
5. Implement file locking for concurrent access
6. Scan entries for prompt injection before accepting (see [Security](#9-security-considerations))

---

## 3. Skills

**Purpose:** Procedural memory -- reusable step-by-step approaches for recurring task types.

### Why Skills, Not Just Memory?

Memory stores *what* (facts). Skills store *how* (procedures). A memory entry might say "User's CI uses GitHub Actions." A skill would contain the 12-step procedure for debugging a failing GitHub Actions workflow, including common pitfalls and verification steps.

Skills are also much larger than memory entries (hundreds to thousands of characters) and loaded on demand, so they don't consume context window when not needed.

### Skill Format

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```yaml
---
name: docker-debug
description: Debug Docker container networking issues
version: 1.2.0
platforms: [macos, linux]  # Optional OS restriction
metadata:
  hermes:
    tags: [devops, docker]
---

# Docker Network Debugging

## When to Use
- Container can't reach external services
- Port mapping isn't working
- DNS resolution fails inside container

## Steps
1. Check container network mode: `docker inspect --format='{{.HostConfig.NetworkMode}}' <id>`
2. ...

## Pitfalls
- On macOS, `host` network mode doesn't work (Docker runs in a VM)
- ...

## Verification
- `curl -v http://localhost:<port>` from host should return 200
```

### Progressive Disclosure (Three Tiers)

Skills use a token-efficient loading strategy:

| Tier | What's Loaded | When |
|------|--------------|------|
| **Index** | Name + 60-char description | Always (system prompt) |
| **Full Content** | Complete SKILL.md | When agent calls `skill_view(name)` |
| **References** | Supporting files in `references/`, `templates/`, `scripts/` | When agent calls `skill_view(name, "references/api.md")` |

The system prompt contains only the index:

```
## Skills (mandatory)
Before replying, scan the skills below. If one clearly matches your task,
load it with skill_view(name) and follow its instructions.

<available_skills>
  devops:
    - docker-debug: Debug Docker container networking issues
    - k8s-deploy: Deploy to Kubernetes with rolling update
  data-science:
    - jupyter-live-kernel: Connect to running Jupyter kernel
</available_skills>
```

This costs ~200 tokens for dozens of skills. Loading a specific skill on demand costs 500-5,000 tokens but only when needed.

### Self-Improvement During Use

The critical differentiator: **skills are not static**. The agent can modify its own skills mid-session.

The `skill_manage` tool supports:

| Action | Purpose |
|--------|---------|
| `create` | New skill from scratch |
| `patch` | Targeted find-and-replace (preferred -- token efficient) |
| `edit` | Full rewrite (major overhauls only) |
| `delete` | Remove a skill |
| `write_file` | Add supporting files (references, templates) |
| `remove_file` | Remove supporting files |

**Patch is preferred over edit** because it sends only the diff, not the entire file content. This saves tokens and reduces the chance of accidentally clobbering content.

### When to Create/Update (Tool Schema Policy)

> **Create when:** complex task succeeded (5+ calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered.
>
> **Update when:** instructions stale/wrong, OS-specific failures, missing steps or pitfalls found during use. If you used a skill and hit issues not covered by it, patch it immediately.

### How to Reproduce

1. Define a directory structure: `skills/<category>/<name>/SKILL.md`
2. Parse YAML frontmatter for name, description, platform filtering
3. Build a compact index for the system prompt (names + short descriptions only)
4. Expose `skill_view` for on-demand content loading
5. Expose `skill_manage` for creation, patching, and deletion
6. Security-scan all skill content before writing (see [Security](#9-security-considerations))
7. Encode creation/update policy in the tool schema description

---

## 4. Background Nudging

**Purpose:** Periodically prompt the agent to reflect on the conversation and extract learnings, without blocking the user-facing response.

This is the mechanism that makes learning *automatic* rather than requiring the user to say "remember this." It's the difference between an agent that learns when told to and one that learns on its own.

### Two Independent Counters

| Counter | Increments On | Default Interval | Resets On |
|---------|--------------|-------------------|-----------|
| Memory nudge | User turns (not tool calls) | 10 turns | Explicit memory tool use |
| Skill nudge | Tool-calling iterations | 10 iterations | Explicit skill_manage tool use |

The counters are independent because memory and skills track different signals:
- Memory nudge fires after sustained conversation (user may have revealed preferences)
- Skill nudge fires after sustained tool use (agent may have discovered a reusable procedure)

### Background Review Flow

When a nudge counter expires:

```
1. Main agent delivers its response to the user (non-blocking)
2. Background thread spawns
3. Thread creates a FORK of AIAgent with:
   - Same model and provider
   - Same memory store (shared reference)
   - max_iterations=8 (bounded work)
   - quiet_mode=true (no user-visible output)
   - Nudge intervals set to 0 (prevent recursive reviews)
4. Snapshot of conversation history is passed to the fork
5. Review prompt is appended as the next "user" message
6. Fork runs a full conversation with the review prompt
7. Fork writes directly to shared memory/skill stores
8. Summary of actions is displayed: "💾 Memory updated · Skill created"
```

### Review Prompts

Three variants depending on which counters fired:

**Memory review:**
> Review the conversation above and consider saving to memory if appropriate. Focus on: Has the user revealed things about themselves -- preferences, personal details? Has the user expressed expectations about how you should behave? If something stands out, save it using the memory tool. If nothing is worth saving, say "Nothing to save." and stop.

**Skill review:**
> Review the conversation above and consider saving or updating a skill. Focus on: was a non-trivial approach used that required trial and error, or changing course? If a relevant skill already exists, update it. Otherwise, create a new skill. If nothing is worth saving, say "Nothing to save." and stop.

**Combined review** (when both counters fire simultaneously): merges both prompts.

### Key Design Decisions

1. **Non-blocking**: Review runs *after* the response is delivered. The user never waits.
2. **Forked agent**: The review agent has full tool access (memory, skills) but can't affect the main conversation.
3. **Shared stores**: Writes to memory/skills are visible to the main agent in subsequent sessions.
4. **Bounded**: `max_iterations=8` prevents runaway reviews.
5. **Quiet mode**: stdout/stderr redirected to `/dev/null`.
6. **No recursion**: Nudge intervals set to 0 on the fork.

### How to Reproduce

1. Add turn/iteration counters to your agent loop
2. When a counter expires, capture a snapshot of the conversation
3. Spawn a background thread with a new agent instance
4. Share the memory/skill stores (by reference, not copy)
5. Append a review prompt and run the forked agent
6. Display a summary of any writes
7. Set the fork's nudge intervals to 0 to prevent recursion

---

## 5. Session Search

**Purpose:** Searchable long-term memory of every past conversation, with on-demand LLM summarization.

### Why Not Just Use Memory?

Memory is bounded (~2,200 chars). You can't store every conversation fact in memory. Session search provides unlimited capacity by keeping full transcripts in a database and summarizing them on demand.

The key insight: **raw transcripts are the wrong format for context injection**. They're too long and most content is irrelevant to the current query. Instead, search the transcripts, then summarize the relevant ones with a focused prompt.

### Storage: SQLite with FTS5

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,          -- 'cli', 'telegram', 'discord', etc.
    parent_session_id TEXT,        -- Lineage after compression
    started_at REAL NOT NULL,
    title TEXT,
    ...
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_name TEXT,
    tool_calls TEXT,              -- JSON
    timestamp REAL NOT NULL,
    ...
);

-- FTS5 for fast full-text search
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=id
);

-- Auto-sync triggers
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
-- (plus update and delete triggers)
```

**Why FTS5 over vector embeddings?** Simpler, faster, no external dependencies, no embedding model costs. FTS5 handles keyword search well enough for the "did we discuss X last week?" use case. Semantic search is handled by the summarization step.

### Search Flow

```
1. User asks about something from a past session
2. Agent calls session_search("docker networking issue")
3. FTS5 returns top 50 matching messages ranked by relevance
4. Results grouped by session, top 3 unique sessions selected
5. Each session's conversation loaded, truncated to ~100k chars centered on matches
6. Each session sent to a cheap/fast model (Gemini Flash) for focused summarization
7. Summaries returned to the main agent with metadata (date, source, model)
```

### Two Modes

| Mode | Trigger | Cost | Returns |
|------|---------|------|---------|
| **Recent sessions** | No query | Zero (DB only) | Titles, previews, timestamps |
| **Keyword search** | Query provided | LLM call per session | Focused summaries |

### Summarization Prompt

> You are reviewing a past conversation transcript to help recall what happened. Summarize with focus on the search topic. Include: what the user asked, what actions were taken, key decisions/solutions, specific commands/files/URLs, anything unresolved.

### Key Design Decisions

1. **Current session excluded**: The agent already has its own context. Searching it would be wasteful and confusing.
2. **Parent session resolution**: Compression splits sessions into parent/child chains. Search follows the chain to the root.
3. **Truncation centered on matches**: For long sessions, keep content near the matching terms, trim the edges.
4. **Parallel summarization**: Multiple sessions summarized concurrently.
5. **Cap at 5 sessions**: Prevents excessive LLM calls.

### How to Reproduce

1. Store all conversations in a searchable database (SQLite FTS5, Postgres tsvector, or Elasticsearch)
2. Expose a search tool with keyword query support
3. On search: find matching messages, group by session, take top N
4. Summarize each session with a cheap/fast LLM focused on the query
5. Return summaries (not raw transcripts) to the main agent
6. Add "recent sessions" mode for zero-cost browsing

---

## 6. Cross-Session User Modeling

**Purpose:** Deep, semantic understanding of the user that evolves across sessions, optionally backed by an external service (Honcho).

### What Honcho Adds Beyond Local Memory

Local memory (`USER.md`) is bounded and literal -- it stores exactly what the agent writes. Honcho provides:

- **Dialectic reasoning**: Both user and agent build representations of each other over time
- **Semantic understanding**: Not just facts but inferred preferences and goals
- **Cross-machine persistence**: Cloud-backed, not filesystem-dependent
- **Multi-peer modeling**: Different representations for different users

### Configuration

```json
{
  "apiKey": "honcho-api-key",
  "hosts": {
    "hermes": {
      "workspace": "hermes",
      "peerName": "adam",
      "aiPeer": "hermes",
      "memoryMode": "hybrid",
      "writeFrequency": "async",
      "recallMode": "hybrid",
      "dialecticReasoningLevel": "low"
    }
  }
}
```

### Memory Modes

| Mode | Local MEMORY.md | Honcho API | Use When |
|------|----------------|------------|----------|
| `hybrid` | Write + read | Write + read | Default. Best of both. |
| `honcho` | Disabled | Write + read | Full cloud memory. |
| `context` | Read only | Read only | Recall without writing. |

### How to Reproduce (Without Honcho)

The core concept -- dialectic user modeling -- can be implemented locally:

1. Maintain a `USER_MODEL.md` with structured sections (goals, preferences, communication style, expertise areas)
2. After each session, run a reflection prompt: "Based on this conversation, update the user model"
3. Use a schema (not free-form text) so the model updates specific fields rather than appending unboundedly
4. Store the model externally if cross-machine persistence is needed

---

## 7. How the Pieces Fit Together

### Session Lifecycle

```
Session Start
├── Load MEMORY.md and USER.md from disk
├── Freeze snapshot for system prompt (prefix cache stable)
├── Build skills index (names + descriptions)
├── Load Honcho context (if enabled)
├── Load context files (SOUL.md, AGENTS.md, etc.)
└── Assemble system prompt

During Conversation
├── Agent responds to user messages
├── Memory tool calls: write to disk immediately, don't change system prompt
├── Skill tool calls: load on demand, patch/create as needed
├── Session search: triggered by cross-session references
├── Turn counter increments on each user message
├── Iteration counter increments on each tool-calling loop
├── When nudge interval expires:
│   ├── Deliver response first (non-blocking)
│   ├── Spawn background review thread
│   └── Review agent writes to shared stores
└── All messages persisted to SQLite

Session End
├── Final flush to SQLite
├── Honcho sync (if enabled)
└── Next session starts with refreshed snapshot
```

### Knowledge Flow Diagram

```
                    ┌─────────────────┐
                    │   User Message   │
                    └────────┬────────┘
                             │
              ┌──────────────▼──────────────┐
              │        System Prompt         │
              │  ┌────────┐ ┌────────────┐  │
              │  │MEMORY  │ │ Skills     │  │
              │  │(frozen)│ │ Index      │  │
              │  └────────┘ └────────────┘  │
              │  ┌────────┐ ┌────────────┐  │
              │  │USER.md │ │ Honcho     │  │
              │  │(frozen)│ │ Context    │  │
              │  └────────┘ └────────────┘  │
              └──────────────┬──────────────┘
                             │
              ┌──────────────▼──────────────┐
              │         Agent Loop           │
              │                              │
              │  Tool calls ──► Skill load   │
              │  Tool calls ──► Memory write │
              │  Tool calls ──► Session search│
              │  Response ──► User           │
              └──────────────┬──────────────┘
                             │
              ┌──────────────▼──────────────┐
              │     Background Review        │
              │  (after nudge interval)      │
              │                              │
              │  Forked agent reviews convo  │
              │  ──► Memory writes           │
              │  ──► Skill creates/patches   │
              └──────────────┬──────────────┘
                             │
              ┌──────────────▼──────────────┐
              │       SQLite Persistence     │
              │  messages + FTS5 index       │
              │  (searchable forever)        │
              └─────────────────────────────┘
```

---

## 8. Implementation Guide

### Minimum Viable Learning Loop

To add learning to an existing agent, implement these in order of impact:

#### Phase 1: Curated Memory (Highest ROI)
- Two bounded text files (agent notes + user profile)
- Three operations: add, replace, remove
- Inject into system prompt as frozen snapshot
- Behavioral guidance in tool schema

**Effort:** ~500 lines. **Impact:** Agent stops asking repeated questions.

#### Phase 2: Session Persistence + Search
- Store all conversations in SQLite with FTS5
- Expose a search tool that summarizes matching sessions
- Add "recent sessions" browsing mode

**Effort:** ~800 lines. **Impact:** Agent can recall past work.

#### Phase 3: Background Nudging
- Turn counter for memory review
- Iteration counter for skill review
- Spawn forked agent in background thread
- Share memory store by reference

**Effort:** ~200 lines. **Impact:** Agent learns without being told.

#### Phase 4: Skills (Procedural Memory)
- Directory-based skill storage with YAML frontmatter
- Progressive disclosure (index → content → references)
- Create/patch/delete operations
- Security scanning

**Effort:** ~1,000 lines. **Impact:** Agent builds reusable playbooks.

#### Phase 5: Deep User Modeling
- Structured user model with sections (goals, preferences, expertise)
- Post-session reflection to update the model
- Optional external persistence (Honcho, database)

**Effort:** Variable. **Impact:** Agent understands user at a deeper level.

### Key Constants

| Constant | Hermes Default | Rationale |
|----------|---------------|-----------|
| Memory char limit | 2,200 | ~800 tokens. Enough for 8-12 entries. |
| User profile char limit | 1,375 | ~500 tokens. User facts are more stable. |
| Memory nudge interval | 10 turns | Frequent enough to catch preferences, rare enough to not waste compute. |
| Skill nudge interval | 10 tool iterations | After significant tool use, check for reusable patterns. |
| Session search limit | 3-5 sessions | Diminishing returns beyond 5. |
| Session truncation | 100k chars | Enough context for summarization. |
| Background review max_iterations | 8 | Bound the cost of review. |
| Entry delimiter | `\n§\n` | Never appears in natural text or code. |

### Technology Choices

Hermes makes specific choices that are not mandatory:

| Hermes Uses | Alternatives |
|------------|-------------|
| SQLite FTS5 | Postgres tsvector, Elasticsearch, Meilisearch |
| File-based memory | Database rows, Redis, key-value store |
| Gemini Flash for summarization | Any cheap/fast LLM |
| YAML frontmatter for skills | JSON metadata, database schema |
| `fcntl.flock` for locking | Advisory locks, database transactions, Redis locks |
| Background threads | Task queues (Celery), async tasks, separate processes |

---

## 9. Security Considerations

Memory and skills are injected into the system prompt. This creates an attack surface: if an attacker can get the agent to store malicious content, it will be executed on every future turn.

### Threat Patterns Scanned

Hermes scans all memory entries and skill content for:

**Prompt injection:**
- `ignore previous instructions`
- `you are now`
- `do not tell the user`
- `system prompt override`
- `disregard your instructions`

**Exfiltration:**
- `curl` / `wget` with `$KEY`, `$TOKEN`, `$SECRET`, `$PASSWORD`
- `cat .env`, `cat credentials`, `cat .netrc`
- `authorized_keys`, `~/.ssh`

**Steganography:**
- Invisible Unicode characters (zero-width spaces, directional overrides, word joiners)

### Defense in Depth

1. **Input scanning**: Block entries matching threat patterns before writing
2. **Context file scanning**: Scan AGENTS.md, SOUL.md, .cursorrules before system prompt injection
3. **Skill security scanning**: Dedicated `skills_guard.py` scans skill directories for shell commands, API key references, network calls
4. **Atomic writes**: Prevent partial-write corruption
5. **Rollback on block**: If security scan fails after write, restore original content

### Recommendations for Implementors

- Scan all user-controllable content before system prompt injection
- Use an allowlist approach for skill operations (only `references/`, `templates/`, `scripts/`, `assets/` subdirectories)
- Prevent path traversal in file operations (`..` in paths)
- Log all blocked entries for audit
- Consider rate-limiting memory writes to prevent flooding

---

## Appendix: File Map

Key files in the Hermes Agent codebase implementing each mechanism:

| Mechanism | File | Lines |
|-----------|------|-------|
| Memory store | `tools/memory_tool.py` | 549 |
| Skill management | `tools/skill_manager_tool.py` | 666 |
| Skill discovery | `tools/skills_tool.py` | ~800 |
| Skill security | `tools/skills_guard.py` | ~300 |
| Session storage | `hermes_state.py` | ~1,200 |
| Session search | `tools/session_search_tool.py` | 490 |
| Background nudging | `run_agent.py:1416-1560` | 145 |
| Nudge counters | `run_agent.py:927-1024` | 100 |
| Prompt assembly | `agent/prompt_builder.py` | 594 |
| Honcho integration | `honcho_integration/session.py` | ~800 |
| Honcho config | `honcho_integration/client.py` | ~400 |
