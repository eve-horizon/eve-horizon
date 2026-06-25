# PM: Slack-Native Expert Panel for Document Review

> **Status**: Idea (for PM refinement)
> **Date**: 2026-03-06
> **Context**: A Slack bot (`@eve pm`) that monitors a channel, ingests all chat and uploaded documents, catalogs them for discovery, and triggers a panel of expert agents — each with a distinct perspective — to respond in threaded Slack conversations.
> **Depends on**: [Document Ingestion via Agent Packs](./document-ingestion-agent-packs.md)
> **UI**: Slack only (no web UI initially)
> **Inference**: All agents use the `pi` harness pointed at an external OpenAI-compatible endpoint running Qwen 3.5 (multimodal). No Anthropic API dependency.

---

## The Problem

Product teams share documents constantly in Slack — specs, designs, meeting notes, research, competitor analysis. These documents get buried in channels, never systematically reviewed, and only benefit from the perspective of whoever happens to read them.

What if every document dropped into a Slack channel was automatically:
1. **Ingested and cataloged** — searchable, tagged, classified, permanently stored
2. **Reviewed by a panel of experts** — each with a different lens (technical feasibility, user impact, business value, risk, etc.)
3. **Available for follow-up** — users can ask questions in threads, tag experts for deeper analysis

The result: every document gets multi-perspective scrutiny automatically, and the collective intelligence is preserved in Slack threads + org docs.

---

## User Experience

### Setup (One-Time)

A team admin connects the bot to their Slack workspace and designates a channel:

```
# In Slack:
@eve pm setup #product-decisions

Eve Bot: PM configured for #product-decisions
         Monitoring: all messages and file uploads
         Expert panel: Tech Lead, UX Advocate, Business Analyst,
                       GTM Advocate, Risk Assessor, QA Strategist,
                       Devil's Advocate
         Documents will be cataloged in org docs at /pm/
```

### Document Upload Flow

```
Alice uploads "q1-roadmap-proposal.pdf" to #product-decisions
Alice: "Here's the Q1 roadmap proposal. Looking for feedback on
        priorities and feasibility before the board meeting."

Eve Bot: Ingesting q1-roadmap-proposal.pdf (1.8 MB)...
         Cataloged as: /pm/report/q1-roadmap-proposal
         Tags: #roadmap #q1-2026 #priorities #board-meeting
         Summary: Proposes 4 major initiatives for Q1 with estimated
         headcount and timeline. Key themes: AI integration,
         enterprise tier, developer experience, observability.

         Starting expert review... (7 threads incoming)
```

Then, within 30-60 seconds, seven new Slack threads appear:

#### Thread 1: Tech Lead

```
Eve Bot (@tech-lead):
  Re: q1-roadmap-proposal.pdf
  doc: /pm/report/q1-roadmap-proposal

  ## Technical Feasibility Review

  The AI integration initiative (p.3-5) is ambitious. Three concerns:

  1. **Dependency risk**: The vector DB migration (p.4) blocks both
     the RAG pipeline and the embedding search. If that slips,
     initiatives 1 AND 3 slip together.

  2. **Headcount estimate is low**: The "developer experience" track
     estimates 2 engineers for 8 weeks. Based on similar refactors
     (see our auth migration), this is closer to 3 engineers / 10 weeks.

  3. **Missing: infrastructure cost model**. The proposal doesn't
     address GPU compute costs for the AI features. At our projected
     usage, this could be $15-30k/month — worth surfacing to the board.

  Questions for the team:
  - Has the vector DB vendor been selected? That affects the timeline
    significantly.
  - Is the "observability" initiative (p.8) a hard dependency for
    the AI features, or can they ship independently?
```

#### Thread 2: UX Advocate

```
Eve Bot (@ux-advocate):
  Re: q1-roadmap-proposal.pdf
  doc: /pm/report/q1-roadmap-proposal

  ## User Experience Review

  Strong proposal overall. The developer experience track (p.6-7)
  directly addresses our top 3 support tickets. But:

  1. **Missing user research**: The AI integration section assumes
     users want AI-powered search. Our last survey (Nov 2025) showed
     only 34% of users requested this — the top request was better
     filtering and saved views.

  2. **Onboarding gap**: None of the 4 initiatives include onboarding
     improvements. Our activation rate is 41% — new features won't
     move revenue if users can't get started.

  3. **Enterprise tier UX**: The proposal mentions "enterprise
     features" but doesn't specify the admin experience. Enterprise
     buyers evaluate based on admin UX as much as end-user features.

  4. **Internationalisation gap**: None of the initiatives mention
     i18n/l10n. If any of these features touch user-facing copy,
     date formatting, or currency display, multilanguage support
     needs to be scoped now — retrofitting i18n is always 3x harder.

  Questions:
  - Can we add a lightweight user research sprint (1 week) before
    committing to the AI integration scope?
  - Should onboarding be a standalone initiative or woven into each?
  - Are any of these features targeting non-English markets? If so,
    i18n needs to be in the initial scope, not a follow-up.
```

#### Thread 3: Business Analyst

```
Eve Bot (@biz-analyst):
  Re: q1-roadmap-proposal.pdf
  ...
  [Process flow analysis, user journey mapping, data landscape,
   success criteria per initiative, primary user identification]
```

#### Thread 4: GTM Advocate

```
Eve Bot (@gtm-advocate):
  Re: q1-roadmap-proposal.pdf
  ...
  [Revenue impact analysis, ROI estimates, competitive positioning,
   market timing, pricing implications, go-to-market readiness]
```

#### Thread 5: Risk Assessor

```
Eve Bot (@risk-assessor):
  Re: q1-roadmap-proposal.pdf
  ...
  [Dependency risks, timeline risks, resource constraints,
   commercial dependencies — deals tied to delivery milestones,
   regulatory risks]
```

#### Thread 6: QA Strategist

```
Eve Bot (@qa-strategist):
  Re: q1-roadmap-proposal.pdf
  ...
  [Testing strategy per feature, edge cases, integration test needs,
   regression risk, test automation requirements, acceptance criteria gaps]
```

#### Thread 7: Devil's Advocate

```
Eve Bot (@devils-advocate):
  Re: q1-roadmap-proposal.pdf
  ...
  [Challenges assumptions, proposes alternatives, stress-tests the logic]
```

### Follow-Up Conversations

Users reply in any expert's thread to ask follow-up questions:

```
Alice (in Tech Lead thread):
  @eve Good point about GPU costs. Can you estimate based on
  the usage projections in appendix B?

Eve Bot (@tech-lead):
  Looking at Appendix B (p.14-15)...
  At 10k queries/day with embedding generation:
  - GPU compute: ~$18k/month (A100 spot pricing)
  - Storage: ~$2k/month (vector DB + object store)
  - Total: ~$20k/month, scaling to ~$35k at the 6-month projection.

  This should be a line item in the board presentation. Want me
  to draft a cost appendix?
```

### Chat Monitoring (Non-Document Messages)

The bot also monitors regular chat in the channel, capturing decisions and context:

```
Bob: I talked to the CTO and she's OK with pushing observability
     to Q2 if we need the headcount for AI integration.

Eve Bot: Noted. Cataloged as decision:
         /pm/decision/observability-deferred-to-q2
         Context: CTO approved deprioritizing observability in favor
         of AI integration headcount.
         Participants: Bob
```

### Document Discovery

Users can search the catalog at any time:

```
@eve pm search "roadmap"

Eve Bot: Found 3 documents matching "roadmap":
  1. /pm/report/q1-roadmap-proposal (Mar 6)
     "Q1 roadmap with 4 initiatives: AI, enterprise, DX, observability"
  2. /pm/meeting_notes/roadmap-review-feb (Feb 28)
     "February roadmap review meeting — shifted mobile to Q2"
  3. /pm/spec/roadmap-scoring-framework (Feb 15)
     "Scoring framework for initiative prioritization"
```

---

## Eve Primitives Used

This design composes existing Eve primitives — no new platform features required beyond the document ingestion system (which is already designed).

| Primitive | Role in PM |
| --- | --- |
| **Slack Gateway** | Receives all messages and file uploads from the monitored channel |
| **Listener Subscriptions** | Channel-level listeners for all agents to receive every message |
| **Document Ingestion** | Files uploaded to Slack are ingested, cataloged in org docs |
| **Agent Pack** | Custom pack defining the expert panel agents + skills |
| **Teams (fanout dispatch)** | Coordinator agent fans out to all expert agents in parallel |
| **Threads** | Each expert's review is a separate Slack thread |
| **Org Docs** | Ingested documents stored as versioned, searchable markdown |
| **Chat Routing** | Routes `@eve` mentions to the right expert for follow-up |
| **Events** | `doc.ingest` event triggers the expert review workflow |
| **Workflows** | Wires `doc.ingest` → fan-out to expert panel |

---

## Architecture

```
#product-decisions (Slack channel)
         |
         | (all messages + file uploads)
         v
    Eve Gateway (Slack provider)
         |
         |-- File attachment? ──> Ingest Endpoint
         |                             |
         |                             v
         |                        Object Store
         |                        + Ingest Record
         |                        + doc.ingest event
         |                             |
         |                             v
         |                     Ingest Workflow trigger
         |                             |
         |                             v
         |                     Triage/Coordinator Agent
         |                             |
         |          ┌──────────┬───────┼───────┬──────┬──────┬──────────┐
         |          v          v       v       v      v      v          v
         |     Tech Lead  UX Adv.   Biz An.  GTM   Risk    QA     Devil's
         |     Agent      Agent     Agent    Agent  Agent  Agent   Advocate
         |          |          |       |       |      |      |          |
         |          v          v       v       v      v      v          v
         |     [Slack     [Slack    [Slack  [Slack [Slack [Slack    [Slack
         |      Thread]    Thread]  Thread] Thread] Thrd]  Thrd]    Thread]
         |
         |-- Regular message? ──> Chat Monitor Agent
         |                             |
         |                             v
         |                     Classify (decision / discussion / noise)
         |                     If decision: catalog in org docs
         |                     If relevant: update context for panel
         |
         |-- @eve mention in thread? ──> Route to specific expert agent
                                          (thread-level listener)
```

---

## Agent Pack Design

### Pack Structure

```
pm-pack/
  eve/
    pack.yaml
  agents/
    agents.yaml
    teams.yaml
    chat.yaml
  skills/
    coordinator/SKILL.md
    tech-lead/SKILL.md
    ux-advocate/SKILL.md
    biz-analyst/SKILL.md
    gtm-advocate/SKILL.md
    risk-assessor/SKILL.md
    qa-strategist/SKILL.md
    devils-advocate/SKILL.md
    chat-monitor/SKILL.md
    search/SKILL.md
```

### agents.yaml

```yaml
version: 1
agents:
  # Coordinator — receives doc.ingest events, fans out to panel
  pm-coordinator:
    slug: pm
    name: "PM Coordinator"
    description: "Receives ingested documents and dispatches to expert panel"
    skill: coordinator
    harness_profile: coordinator
    workflow: coordinator
    gateway:
      policy: routable
      clients: [slack]

  # Expert Panel Agents (all use pi + Qwen 3.5 multimodal)
  tech-lead:
    slug: tech-lead
    name: "Tech Lead"
    description: "Reviews documents for technical feasibility, architecture, cost, and engineering risk"
    skill: tech-lead
    harness_profile: expert
    workflow: assistant
    gateway:
      policy: routable
      clients: [slack]

  ux-advocate:
    slug: ux-advocate
    name: "UX Advocate"
    description: "Reviews documents for user experience impact, research gaps, and usability"
    skill: ux-advocate
    harness_profile: expert
    workflow: assistant
    gateway:
      policy: routable
      clients: [slack]

  biz-analyst:
    slug: biz-analyst
    name: "Business Analyst"
    description: "Reviews documents for process flows, user journeys, data landscape, and success criteria"
    skill: biz-analyst
    harness_profile: expert
    workflow: assistant
    gateway:
      policy: routable
      clients: [slack]

  gtm-advocate:
    slug: gtm-advocate
    name: "GTM Advocate"
    description: "Reviews documents for revenue impact, competitive positioning, market timing, and go-to-market readiness"
    skill: gtm-advocate
    harness_profile: expert
    workflow: assistant
    gateway:
      policy: routable
      clients: [slack]

  risk-assessor:
    slug: risk-assessor
    name: "Risk Assessor"
    description: "Reviews documents for risks: timeline, dependencies, resources, commercial commitments, regulatory"
    skill: risk-assessor
    harness_profile: expert
    workflow: assistant
    gateway:
      policy: routable
      clients: [slack]

  qa-strategist:
    slug: qa-strategist
    name: "QA Strategist"
    description: "Reviews documents for testing strategy, edge cases, acceptance criteria, and regression risk"
    skill: qa-strategist
    harness_profile: expert
    workflow: assistant
    gateway:
      policy: routable
      clients: [slack]

  devils-advocate:
    slug: devils-advocate
    name: "Devil's Advocate"
    description: "Challenges assumptions, proposes alternatives, stress-tests reasoning"
    skill: devils-advocate
    harness_profile: expert
    workflow: assistant
    gateway:
      policy: routable
      clients: [slack]

  # Chat monitor — listens to all channel messages (non-file)
  chat-monitor:
    slug: pm-monitor
    name: "Chat Monitor"
    description: "Monitors channel chat for decisions, action items, and context"
    skill: chat-monitor
    harness_profile: monitor
    workflow: assistant
    gateway:
      policy: routable
      clients: [slack]

  # Search agent — handles @eve pm search queries
  pm-search:
    slug: pm-search
    name: "PM Search"
    description: "Searches the document catalog"
    skill: search
    harness_profile: monitor
    workflow: assistant
    gateway:
      policy: routable
      clients: [slack]
```

### teams.yaml

```yaml
version: 1
teams:
  expert-panel:
    lead: pm-coordinator
    members:
      - tech-lead
      - ux-advocate
      - biz-analyst
      - gtm-advocate
      - risk-assessor
      - qa-strategist
      - devils-advocate
    dispatch:
      mode: fanout
      max_parallel: 7
      member_timeout: 120
```

### chat.yaml

```yaml
version: 1
default_route: route_coordinator
routes:
  - id: route_search
    match: "search|find|catalog|list docs"
    target: agent:pm-search

  - id: route_coordinator
    match: ".*"
    target: team:expert-panel
```

### Harness Profiles

All agents use the `pi` harness pointed at an external OpenAI-compatible endpoint running **Qwen 3.5** (multimodal). This means the entire PM system runs on a single self-hosted or public inference endpoint — no Anthropic/OpenAI API keys needed.

```yaml
# In manifest
harness_profiles:
  coordinator:
    harness: pi
    model: qwen/qwen3.5-vl              # Multimodal — can read PDFs/images natively
  expert:
    harness: pi
    model: qwen/qwen3.5-vl              # Same model for deep analysis (multimodal)
  monitor:
    harness: pi
    model: qwen/qwen3.5-vl              # Same endpoint, same model
```

### Inference Configuration

The `pi` harness discovers the Qwen endpoint via `PI_MODELS_JSON_B64` — a base64-encoded `models.json` set as a **project secret**:

```json
{
  "providers": {
    "qwen": {
      "baseUrl": "https://your-qwen-endpoint.example.com/v1",
      "api": "openai-chat-completions",
      "apiKey": "your-api-key-here",
      "models": ["qwen3.5-vl"]
    }
  }
}
```

```bash
# Set as project secret (base64-encoded)
eve secrets set PI_MODELS_JSON_B64 \
  --value "$(cat models.json | base64)" \
  --project proj_xxx
```

**Why Qwen 3.5 multimodal?**
- **Vision-native**: Reads PDFs, images, diagrams directly — no OCR fallback needed
- **Single model**: One model handles coordinator routing, expert analysis, and chat monitoring. Simpler operations.
- **Self-hostable**: Run on your own GPU infrastructure for data sovereignty, or use a public OpenAI-compatible endpoint (e.g., Together, Fireworks, or your own vLLM/SGLang deployment)
- **Cost**: Public Qwen 3.5 endpoints are significantly cheaper than Claude/GPT-4o. Self-hosted cost is just GPU compute.

**Upgrading later**: To use a more capable model for experts while keeping cheap routing, split the profiles:

```yaml
harness_profiles:
  coordinator:
    harness: pi
    model: qwen/qwen3.5-vl              # Cheap — just routing
  expert:
    harness: pi
    model: anthropic/claude-sonnet-4     # Upgrade experts to Claude (needs ANTHROPIC_API_KEY secret)
  monitor:
    harness: pi
    model: qwen/qwen3.5-vl              # Cheap — just classification
```

---

## Skill Sketches

### Coordinator (skills/coordinator/SKILL.md)

```markdown
# PM Coordinator

You are the coordinator for a panel of expert reviewers. When a document
is ingested, you:

1. Read the ingested document from org docs (path in job metadata)
2. Prepare a briefing for each expert:
   - Document title, type, and summary
   - The submitter's description and any instructions
   - The org doc path for reference
   - The Slack channel and thread context
3. Dispatch to all 7 expert agents in parallel (fanout)
4. Each expert should create a NEW Slack thread in the source channel
   with their review

Pass each expert:
- The full document content (or a summary if very long)
- The submitter's context and instructions
- A reminder of their specific perspective/role
- The Slack channel ID to post their thread to

Do NOT post your own review. Your job is coordination only.
```

### Tech Lead (skills/tech-lead/SKILL.md)

```markdown
# Tech Lead Expert

You are a senior technical leader reviewing documents from a product
team. Your lens is technical feasibility, engineering effort, and
architecture.

## Your Perspective

For every document, evaluate:
- **Technical feasibility**: Can this be built with current tech/team?
- **Effort estimation**: Are timelines and headcount realistic?
- **Architecture impact**: Does this require new infrastructure, schemas,
  or breaking changes?
- **Dependencies**: What blocks what? Where are the critical paths?
- **Cost implications**: Infrastructure, third-party services, compute
- **Technical debt**: Will this add debt? Does it address existing debt?

## Output Format

Post a new Slack thread in the source channel. Start with:
- Link to the document (org doc path)
- Document title as context

Then provide your review as a structured analysis with:
- Numbered findings (most important first)
- Specific page/section references from the document
- Questions for the team (end with 2-3 targeted questions)

## Tone

Direct, constructive, specific. Cite page numbers. Quantify where
possible (hours, dollars, risk percentages). Don't hedge — if
something is unrealistic, say so clearly.

## Follow-Up

When users reply in your thread, stay in character as Tech Lead.
You have access to the full document and can reference specific
sections. Be helpful and specific in answers.
```

### UX Advocate (skills/ux-advocate/SKILL.md)

```markdown
# UX Advocate Expert

You are a senior UX practitioner reviewing documents from a product
team. Your lens is user experience, accessibility, research validity,
and internationalisation readiness.

## Your Perspective

For every document, evaluate:
- **User research basis**: Are decisions backed by data or assumptions?
- **User journeys**: Are the happy paths AND edge cases mapped?
- **Onboarding impact**: Will this help or hinder new user activation?
- **Accessibility**: Does this consider users with disabilities?
- **Internationalisation**: Has i18n/l10n been considered? Multilanguage
  support, date/currency formatting, RTL layouts, string
  externalisation? This is often omitted unless consciously included.
- **Admin vs end-user UX**: For enterprise features, both matter.

## Tone

Empathetic but evidence-driven. Reference user data when available.
Flag missing research as a risk, not a criticism.

## Follow-Up

When users reply, stay in character. You can suggest lightweight
research methods (5-user tests, card sorts, surveys) to fill gaps.
```

### Business Analyst (skills/biz-analyst/SKILL.md)

```markdown
# Business Analyst Expert

You are a senior business analyst reviewing documents from a product
team. Your lens is process flows, data landscape, user journeys,
and success criteria — NOT go-to-market or revenue (that's GTM's role).

## Your Perspective

For every document, evaluate:
- **Primary users**: Who are the primary users for each item? Are they
  clearly identified and segmented?
- **Success criteria**: What does success look like for each user group?
  Are the metrics specific and measurable?
- **User journeys and process flows**: Do we understand the end-to-end
  flows? Are they documented or just assumed?
- **Data landscape**: What data is needed to support these journeys?
  Where and how will it be sourced? Are there data quality concerns?
- **Requirements completeness**: Are the requirements sufficient for
  engineering to build against? What's ambiguous?
- **Cross-functional dependencies**: Which teams/systems are involved
  in each flow?

## Tone

Methodical, thorough, process-oriented. Ask the questions that clarify
requirements before engineering starts. Focus on "do we understand what
we're building and for whom?" rather than "should we build it?"

## Follow-Up

When users reply, help them refine requirements, map process flows,
and identify data sources. Offer to draft user journey maps or
requirements matrices.
```

### GTM Advocate (skills/gtm-advocate/SKILL.md)

```markdown
# GTM Advocate Expert

You are a go-to-market and product marketing strategist reviewing
documents from a product team. Your lens is revenue impact, competitive
positioning, market timing, and commercial readiness.

## Your Perspective

For every document, evaluate:
- **Revenue impact**: How does this affect ARR, conversion, churn?
- **Competitive positioning**: How does this move us relative to
  competitors? Are we leading, following, or differentiating?
- **Market timing**: Is this the right moment? Are there market windows
  or competitive pressures that affect urgency?
- **Pricing implications**: Does this enable new pricing tiers, change
  value metrics, or affect packaging?
- **Sales enablement**: Can the sales team articulate this? Does it
  create new selling motions or complicate existing ones?
- **Launch readiness**: What's needed for a successful launch beyond
  just building the feature? (docs, training, marketing, support)

## Tone

Commercial, strategic, opportunity-focused. Quantify revenue impact
where possible. Frame features in terms of market value, not just
engineering effort.

## Follow-Up

When users reply, help with positioning, competitive analysis,
pricing models, and launch planning.
```

### Risk Assessor (skills/risk-assessor/SKILL.md)

```markdown
# Risk Assessor Expert

You are a risk and project management specialist reviewing documents
from a product team. Your lens is what could go wrong and what
commitments are at stake.

## Your Perspective

For every document, evaluate:
- **Timeline risks**: Are deadlines realistic? What's the critical path?
- **Dependency risks**: What blocks what? Single points of failure?
- **Resource risks**: Do we have the people and skills? Key-person risk?
- **Commercial dependencies**: Are there deals, contracts, or partner
  commitments dependent on delivery of specific features by specific
  dates? Flag any commercial expectations tied to milestones.
- **Technical risks**: New technology, integration complexity, scale
  concerns?
- **Regulatory/compliance**: Any legal, privacy, or regulatory exposure?
- **Mitigation strategies**: For each major risk, suggest a mitigation.

## Tone

Direct, pragmatic, solution-oriented. Don't just list risks — rate
their likelihood and impact, and propose mitigations.

## Follow-Up

When users reply, help quantify risks, develop mitigation plans,
and identify early warning indicators.
```

### QA Strategist (skills/qa-strategist/SKILL.md)

```markdown
# QA Strategist Expert

You are a senior QA strategist reviewing documents from a product
team. Your lens is testability, edge cases, and quality assurance
planning. Think "Virtual Olivia" — the person who asks "but what
happens when...?" before engineering starts.

## Your Perspective

For every document, evaluate:
- **Testing strategy**: What are the specific testing needs for each
  feature? Unit, integration, e2e, performance, security?
- **Edge cases**: What edge cases has the proposal not considered?
  What happens with empty states, concurrent users, network failures,
  malformed input, boundary values?
- **Acceptance criteria**: Are acceptance criteria defined? Are they
  testable and unambiguous?
- **Regression risk**: What existing functionality could break? How do
  we detect regressions early?
- **Test automation**: Can this be automated? What's the test
  infrastructure cost?
- **Data requirements**: What test data is needed? Are there PII/GDPR
  concerns with test data?
- **Non-functional requirements**: Performance, scalability, security,
  accessibility — are these specified with measurable thresholds?

## Tone

Constructively sceptical. Your job is to find the holes before users
do. Be specific about scenarios, not vague about "more testing needed."
Propose concrete test cases, not abstract concerns.

## Follow-Up

When users reply, help define acceptance criteria, design test plans,
and identify test automation opportunities.
```

*(Devil's Advocate skill follows the same pattern — challenges assumptions, proposes alternatives, stress-tests reasoning.)*

### Chat Monitor (skills/chat-monitor/SKILL.md)

```markdown
# Chat Monitor

You passively monitor the product channel for important context.

## What to Capture

- **Decisions**: "We decided to...", "CTO approved...", "Let's go with..."
  -> Catalog as /pm/decision/{slug}
- **Action items**: "TODO:", "Action:", "@person will..."
  -> Catalog as /pm/action/{slug}
- **Context updates**: Significant new information that affects active
  documents (timeline changes, resource changes, priority shifts)
  -> Update relevant document metadata

## What to Ignore

- Casual chat, greetings, off-topic discussion
- Questions without answers (wait for the answer)
- Reactions and emoji-only messages

## Output

When you catalog something, post a brief confirmation in the channel
(not a thread):
  "Noted: [decision/action] — cataloged at /pm/{type}/{slug}"

Keep confirmations to ONE line. Don't be noisy.
```

---

## Workflow Wiring

### Manifest Configuration

```yaml
# .eve/manifest.yaml
x-eve:
  packs:
    - source: github:eve-horizon/pm-pack     # Public repo for pack customization
      ref: main

workflows:
  # Trigger expert panel on document ingestion
  pm-review:
    trigger:
      - source: system
        type: doc.ingest
    hints:
      timeout_seconds: 300
      permission_policy: auto_edit
    target:
      team: expert-panel

  # Monitor channel chat
  pm-monitor:
    trigger:
      - source: slack
        event: message
        channel: ${PM_CHANNEL_ID}
    hints:
      timeout_seconds: 60
    target:
      agent_slug: pm-monitor
```

### Listener Setup

After deployment, the bot subscribes to the channel:

```bash
# Subscribe all agents as channel-level listeners
# (this happens automatically via the coordinator on first setup,
# or manually via Slack):
@eve pm setup #product-decisions
```

This creates channel-level listener subscriptions for:
- `pm-monitor` (receives all non-mention messages)
- `pm` coordinator (receives file uploads for ingestion)

Expert agents get thread-level subscriptions automatically when they create their review threads (enabling follow-up conversations).

---

## Data Flow: Document Upload to Expert Threads

Step-by-step:

1. **User uploads file** in `#product-decisions` with a message
2. **Gateway receives** `app_mention` or `message` event with file attachment
3. **Gateway downloads** file from Slack, stores in object store
4. **Gateway creates** ingest record + fires `doc.ingest` event
5. **Ingest workflow triggers** — single-agent (or triage team) processes the file
6. **Document agent** extracts content, classifies, tags, writes to org docs at `/pm/{type}/{slug}`
7. **`system.doc.created` event** fires (or the ingest workflow completion triggers the review workflow)
8. **PM Review workflow triggers** — dispatches to `expert-panel` team
9. **Coordinator agent** reads the org doc, prepares briefings
10. **Coordinator fans out** to 7 expert agents in parallel
11. **Each expert agent** reads the document, writes their review, posts a **new Slack thread** in the source channel
12. **Each expert subscribes** as a thread-level listener on their own thread
13. **Users reply** in any thread — the expert agent responds in character

---

## Open Questions for PM Refinement

### 1. Expert Panel Composition

The default panel is: Tech Lead, UX Advocate, Business Analyst, GTM Advocate, Risk Assessor, QA Strategist, Devil's Advocate.

- Should the panel be configurable per channel? Per document type?
- Should some experts be optional? (e.g., skip Tech Lead for non-technical docs)
- Should users be able to add custom expert personas? ("Add a Legal Reviewer")
- Max panel size before it becomes noisy?

### 2. Document Type Sensitivity

Not all documents need 7 expert reviews:
- A quick meeting note might only need the Chat Monitor to catalog it
- A major strategy doc might deserve the full panel
- A data export might need none

**Possible approach**: The coordinator classifies documents by "review weight" and selects which experts to activate:
- `lightweight` (meeting notes, updates): catalog only, no panel
- `standard` (specs, proposals): full panel
- `deep-dive` (strategy, major decisions): full panel + summary synthesis

### 3. Thread Noise

7 new threads per document could be overwhelming in a busy channel.

**Possible mitigations**:
- Post a single "review summary" thread with links to each expert's thread
- Use a dedicated `#pm-reviews` channel for the expert threads, with a summary link posted in the original channel
- Configurable: full threads vs. collapsed summary
- Rate limiting: max N reviews per hour before batching

### 4. Chat Monitoring Scope

The chat monitor sees everything in the channel. Concerns:
- **Privacy**: Should certain messages be excluded? (e.g., DMs, private channels)
- **Noise**: How aggressively should it catalog? One decision per day? Per hour?
- **Opt-out**: Can users say "off the record" to suppress monitoring?
- **Historical**: Should it backfill the channel history on first setup?

### 5. Follow-Up Quality

When users reply in expert threads, the agent needs context:
- The full original document
- The expert's initial review
- The conversation history in the thread
- Any other documents that have been cataloged (for cross-referencing)

**Concern**: Long documents + long threads could exceed context windows. Strategy for managing this?

### 6. Cross-Document Intelligence

Over time, the catalog builds a knowledge base. Experts should reference prior documents:
- "This contradicts the decision in /pm/decision/observability-q2"
- "Similar proposal was reviewed in /pm/report/q3-roadmap — the timeline concern from that review applies here too"

**Requires**: Agents need access to org docs search. The coordinator could provide relevant prior documents as context.

### 7. Synthesis / Summary

After all experts post, should there be a synthesis step?
- An 8th thread that summarizes all expert opinions
- Highlights points of agreement and disagreement
- Lists all open questions across experts
- Provides a "readiness score" for the document

### 8. Integration with Existing Tools

- **Jira/Linear**: Should cataloged action items create tickets?
- **Confluence/Notion**: Should ingested docs also sync to a wiki?
- **Google Docs**: Can the bot ingest shared links (not just uploads)?
- **Email**: Forward emails to a channel for ingestion?

### 9. Customization Depth

The pack overlay model means teams can customize everything:
- Add/remove/rename experts
- Change expert perspectives entirely ("Add a Compliance Officer")
- Adjust harness profiles (upgrade experts to Claude, keep Qwen for routing)
- Point pi at a different endpoint (self-hosted, different provider)
- Change the catalog structure (/pm/ prefix, doc types)

**Question**: What's the simplest "getting started" experience? Should setup be zero-config (just add bot to channel) or require manifest authoring?

### 10. Metrics and Feedback

How do we know if this is useful?
- Track: threads with user replies (engagement)
- Track: documents with follow-up questions (depth)
- Track: catalog searches (discovery value)
- Feedback: thumbs up/down on expert reviews?
- Quality: periodic review of expert accuracy?

---

## Implementation Phases

### Phase 0: Prerequisites

- [ ] Document ingestion system (Phase 1 from [ingestion design](./document-ingestion-agent-packs.md))
- [ ] Slack file download in gateway (Phase 3 from ingestion design)
- [ ] Team fanout dispatch working end-to-end

### Phase 1: Single Expert (Proof of Concept)

- [ ] Create pm-pack with one expert agent (Tech Lead)
- [ ] Wire doc.ingest -> coordinator -> single expert thread
- [ ] Verify: upload file in Slack -> expert thread appears
- [ ] Verify: reply in thread -> expert responds
- [ ] Verify: document cataloged in org docs

### Phase 2: Full Panel

- [ ] Add remaining 6 expert agents (UX, BA, GTM, Risk, QA, Devil's Advocate)
- [ ] Implement fanout dispatch to all 7
- [ ] Add chat monitor agent
- [ ] Test with real documents in a staging Slack workspace

### Phase 3: Discovery + Polish

- [ ] Search agent (`@eve pm search ...`)
- [ ] Cross-document referencing (experts cite prior catalog entries)
- [ ] Summary synthesis thread
- [ ] Noise management (configurable review channels, rate limiting)

### Phase 4: Customization

- [ ] Pack overlay documentation for adding custom experts
- [ ] Per-document-type panel selection
- [ ] Harness profile flexibility (different models per expert)
- [ ] Channel configuration via Slack commands

---

## Cost Estimate

Per document review using Qwen 3.5 via a public OpenAI-compatible endpoint (e.g., Together, Fireworks). Costs vary by provider; estimates assume ~$0.30/M input, ~$0.60/M output tokens:

| Component | Model | Est. Tokens | Est. Cost |
| --- | --- | --- | --- |
| Document ingestion | Qwen 3.5 VL | ~10k in, ~2k out | ~$0.004 |
| Coordinator | Qwen 3.5 VL | ~5k in, ~1k out | ~$0.002 |
| 7x Expert reviews | Qwen 3.5 VL (each) | ~10k in, ~2k out each | ~$0.029 |
| Follow-up (avg 2 exchanges) | Qwen 3.5 VL | ~5k in, ~1k out each | ~$0.004 |
| **Total per document** | | | **~$0.04** |

Chat monitoring: ~$0.0002 per message (most are classified as noise and ignored).

At 10 documents/week: **~$0.40/week** or **~$1.60/month**. An order of magnitude cheaper than Claude-based alternatives.

**Self-hosted**: If running Qwen 3.5 on your own GPU (e.g., A100 at ~$1.50/hr spot), the marginal cost per document is essentially zero — you're paying for the GPU time regardless. A single A100 can handle the full PM workload comfortably.

---

## Why This Works on Eve

This isn't a custom Slack bot with bespoke code. It's a **configuration** of existing Eve primitives:

1. **No new API code** — Uses existing gateway, ingestion, agents, teams, threads, org docs
2. **No new infrastructure** — Runs on existing Eve worker/agent-runtime pods
3. **Customizable without code** — Change experts by editing YAML and skill markdown
4. **Single inference endpoint** — All agents use pi + Qwen 3.5 via one OpenAI-compatible URL. No API key sprawl.
5. **Self-hostable** — Point pi at your own GPU endpoint for full data sovereignty
6. **Auditable** — Every ingestion has an immutable record, every expert review is a logged job
7. **Extensible** — Add experts, change perspectives, swap models per profile

The entire PM system is an **agent pack** — a folder of YAML and markdown files that any team can fork and customize.
