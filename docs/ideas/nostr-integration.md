# Nostr Integration: Sovereign Agents on Eve Horizon

> Status: Idea (Brainstorm)
> Last Updated: 2026-02-09
> Inputs:
> - docs/ideas/chat-client-integrations.md
> - docs/system/events.md
> - docs/system/agents.md
> - docs/system/chat-gateway.md
> - NIP-90 (Data Vending Machines)
> - NIP-46 (Nostr Connect / Remote Signing)
> - NIP-57 (Lightning Zaps)
> - NIP-60/61 (Cashu Wallets / Nutzaps)
> - NIP-98 (HTTP Auth)
> - NIP-89 (Recommended Application Handlers)

## The Big Idea

Eve Horizon already treats agents as first-class citizens. Nostr treats *everyone* as a
keypair. The intersection is profound: **agents that own their own identity, discover work
autonomously, and pay for resources with real money — no human in the loop.**

Today, Eve agents live inside the platform. With Nostr, they step outside it. An Eve agent
becomes a sovereign entity on an open network — discoverable by anyone, payable by anyone,
composable with anything. Eve Horizon becomes the execution engine behind the most capable
agents on the Nostr network.

This isn't about adding Nostr as another chat channel (though we get that for free). It's
about making Eve Horizon the backbone of an **open agent economy**.

## Why This Fits

The architectural alignment is almost unsettling:

| Eve Horizon Primitive | Nostr Primitive | Synergy |
|---|---|---|
| Event spine (Postgres) | Nostr events (signed JSON) | Events in, events out — same mental model |
| Jobs (execution unit) | NIP-90 DVMs (computation marketplace) | Eve jobs *are* DVMs — money in, work out |
| Agents (keypair identity) | Nostr pubkeys (secp256k1) | Agent identity *is* a Nostr identity |
| Teams (multi-agent dispatch) | NIP-90 job chaining | Chain DVMs like Eve chains job dependencies |
| Chat gateway (Slack/Telegram) | Nostr relays (WebSocket) | Just another channel — but permissionless |
| Manifest triggers | Nostr event subscriptions | Subscribe to work requests, auto-trigger jobs |
| Skills (OpenSkills) | NIP-89 (app handlers) | Advertise capabilities to the entire network |
| Secrets (encrypted, scoped) | NIP-46 (remote signing) | Key material isolated from compute |

## Three Layers of Integration

### Layer 1: Nostr as a Chat Channel

The simplest integration. Nostr becomes another gateway plugin alongside Slack, Telegram,
and the rest. Users talk to Eve agents via Nostr DMs or public mentions.

**How it works:**
- Gateway subscribes to Nostr relays for events mentioning agent pubkeys
- Inbound kind:4 (encrypted DMs) or kind:1 (mentions) normalized to `chat.message.received`
- Existing chat routing kicks in — routes to agent, creates job, streams response
- Outbound replies published as signed Nostr events

**Session key:** `nostr:{agent_pubkey}:{peer_pubkey}:{relay_hint}`

**What this unlocks:**
- Any Nostr user can talk to your Eve agents — no Slack workspace invite needed
- Agents are discoverable via NIP-05: `mission-control@yourorg.eve.dev`
- Conversation history lives on relays, not locked in a proprietary platform

**Gateway plugin manifest:**
```yaml
name: nostr
version: 1
capabilities: [chat, identity]
auth:
  mode: keypair
  keypair:
    private_key: ${secret.NOSTR_AGENT_NSEC}
    # Or NIP-46 remote signer:
    bunker_url: ${secret.NOSTR_BUNKER_URL}
relay_config:
  read: ["wss://relay.damus.io", "wss://nos.lol"]
  write: ["wss://relay.damus.io"]
config_schema:
  type: object
  properties:
    relays: { type: array, items: { type: string } }
    nip05_domain: { type: string }
defaults:
  bindings:
    mode: default_assistant
```

### Layer 2: Eve Agents as Data Vending Machines

This is where it gets interesting. NIP-90 defines a protocol where anyone can request
computation and providers compete to fulfill it. Eve agents *already do this* — they
accept job descriptions and execute work. We just need to speak the protocol.

**How it works:**

1. Eve agent publishes NIP-89 kind:31990 announcing supported DVM kinds
2. Customer publishes kind:5050 (text generation) or kind:5001 (summarization) etc.
3. Eve's Nostr gateway sees the job request, normalizes to an Eve event
4. Orchestrator creates a job with the DVM request as input
5. Agent executes, produces result
6. Gateway publishes kind:6050 (result) back to Nostr
7. Customer pays via Lightning zap on the result event

**Eve as a DVM provider — manifest extension:**
```yaml
nostr:
  identity:
    nip05: "code-review@example.eve.dev"
    profile:
      name: "Code Review Agent"
      about: "Deep code review powered by Eve Horizon"
      picture: "https://example.com/agents/code-review.png"

  dvm:
    enabled: true
    supported_kinds:
      - kind: 5050   # text generation
        description: "Code review, bug analysis, refactoring suggestions"
        pricing:
          mode: per_request
          base_sats: 500
          max_sats: 5000
      - kind: 5001   # summarization
        description: "Codebase summarization and documentation"
        pricing:
          mode: per_request
          base_sats: 200

    payment:
      lightning_address: "code-review@npub.cash"
      require_prepayment: false   # deliver result, accept zap
      cashu_mints: ["https://mint.minibits.cash"]

    relays:
      announce: ["wss://relay.damus.io", "wss://nos.lol"]
      work: ["wss://relay.example.dev"]   # private relay for job coordination
```

**DVM job flow mapped to Eve primitives:**
```
Nostr kind:5050 request
  → gateway normalizes to event: nostr.dvm.job_request
  → orchestrator matches trigger, creates Eve job
  → worker executes (mclaude harness, repo clone, skills)
  → result written to job output
  → gateway publishes kind:6050 result to Nostr
  → customer zaps result → Lightning payment received
```

**What this unlocks:**
- Any Nostr user or agent can discover and use your Eve agents
- No API keys, no accounts, no onboarding — just publish a request and pay
- Agents earn bitcoin autonomously
- Competition drives quality — multiple Eve orgs can serve the same DVM kinds

### Layer 3: Autonomous Agent Economy

The full vision. Eve agents don't just *serve* requests — they *make* them. An agent
that needs a code review hires another agent. An agent that needs an image generated
pays a DVM. An agent that needs to deploy pays for compute. All over Nostr, all with
Lightning.

**Agent-to-Agent via DVM chaining:**
```
User requests: "Build me a landing page"
  → Eve agent decomposes into subtasks
  → Publishes kind:5050 for copywriting (another DVM fulfills it)
  → Publishes kind:5100 for hero image generation (another DVM)
  → Combines results, builds the page
  → Publishes result back to user
```

Each step is a separate DVM transaction. The coordinating agent holds a Cashu wallet
(NIP-60) and pays other agents directly. Eve's job hierarchy maps perfectly:
root job spawns child jobs, some executed locally, others outsourced to the network.

**Agent wallet architecture:**
```yaml
nostr:
  wallet:
    mode: cashu          # or "lightning" for direct LN
    mints:
      - url: "https://mint.minibits.cash"
        trust: high
      - url: "https://mint.coinos.io"
        trust: medium
    budget:
      per_job_max_sats: 10000
      daily_max_sats: 100000
      require_approval_above: 50000   # human-in-the-loop for large spends
    funding:
      lightning_address: "agent@example.eve.dev"  # receives payments here
      auto_swap: true   # convert incoming LN to Cashu for spending
```

**Key design principle:** The wallet private key is *separate* from the Nostr identity
key (per NIP-60). Financial operations are isolated from identity operations. If the
wallet key is compromised, the agent's identity and reputation survive.

## Identity Architecture

### One Keypair Per Agent

Each Eve agent gets a Nostr keypair. This is the agent's sovereign identity on the
open network. The keypair is:

- Generated at agent creation time (or imported)
- Stored encrypted in Eve's secret management (never in the repo)
- Used via NIP-46 remote signing — the agent process never holds the raw nsec
- Published as NIP-05: `{agent-slug}@{org}.eve.dev`

**Why this matters:** The agent's reputation (zaps received, successful DVM completions,
Web of Trust attestations) accrues to the keypair, not to the platform. If an org
migrates off Eve Horizon, their agents keep their identity and reputation.

### NIP-46 Remote Signing (Bunker Architecture)

Agent processes should never hold private keys. Instead:

```
Agent Process  ←→  Eve Signing Service (bunker)  ←→  HSM / encrypted keystore
     │                      │
  "sign this event"    validates scope, signs, returns
```

The signing service enforces policies:
- Which event kinds the agent can sign
- Rate limits on signing operations
- Budget limits on payment-related signatures
- Audit log of all signing operations

This maps naturally to Eve's existing secret management — the nsec is just another
secret, but with a specialized access pattern.

### Web of Trust for Agent Reputation

NIP-32 labels enable decentralized reputation:

```json
{
  "kind": 1985,
  "tags": [
    ["L", "eve.dev/agent-quality"],
    ["l", "excellent", "eve.dev/agent-quality"],
    ["p", "<agent-pubkey>"]
  ]
}
```

Eve agents can:
- Rate other agents they've worked with (DVM job quality)
- Accumulate ratings from customers
- Use the Web of Trust graph to select DVM providers for outsourced work
- Prefer agents rated highly by agents they already trust (transitive trust)

## Payment Architecture

### Three Payment Tiers

**Tier 1: Lightning Zaps (NIP-57)**
- Customer zaps the DVM result event
- Simple, publicly verifiable, works with any Lightning wallet
- Best for: one-off requests, tipping, human-initiated payments

**Tier 2: Cashu Ecash (NIP-60/61)**
- Agent holds a Cashu wallet on Nostr relays
- Nutzaps (NIP-61) for instant, low-fee agent-to-agent payments
- Wallet is portable — moves with the agent across platforms
- Best for: high-frequency micropayments, agent-to-agent transactions

**Tier 3: L402 (HTTP 402 Protocol)**
- Eve API returns `402 Payment Required` with a Lightning invoice
- Agent pays, receives access token, proceeds
- Best for: metered API access, compute-time billing, resource access

### Budget Controls

Every agent has spending limits defined in the manifest:

```yaml
nostr:
  budget:
    # Hard limits
    per_transaction_max: 5000      # sats
    per_job_max: 50000             # sats (across all sub-transactions)
    daily_max: 500000              # sats
    monthly_max: 5000000           # sats

    # Approval thresholds
    auto_approve_below: 1000       # sats — no human needed
    require_review_above: 10000    # sats — human approval via Slack/Nostr DM

    # Funding
    low_balance_alert: 10000       # sats — notify owner
    auto_fund_from: "treasury@example.eve.dev"
    auto_fund_amount: 100000       # sats
```

The human owner gets notified (via Slack, Nostr DM, or email) when:
- An agent wants to spend above the auto-approve threshold
- Balance drops below the alert level
- A DVM job costs more than expected
- Unusual spending patterns are detected

### Revenue Flow

When Eve agents earn money:
```
Customer zaps agent's DVM result
  → Lightning payment received at agent's address
  → Converted to Cashu tokens in agent's NIP-60 wallet
  → Platform fee (configurable %) routed to org treasury
  → Remainder available for agent's operational spending
  → Org owner can sweep to external wallet at any time
```

## Discovery and Marketplace

### How Agents Are Found

**NIP-89 Application Handler:**
Every Eve agent publishes a kind:31990 event advertising its capabilities:

```json
{
  "kind": 31990,
  "tags": [
    ["d", "eve-code-review"],
    ["k", "5050"],
    ["k", "5001"],
    ["name", "Code Review Agent"],
    ["about", "Deep code review by Eve Horizon"],
    ["nip05", "code-review@example.eve.dev"],
    ["pricing", "500-5000 sats"],
    ["t", "code-review"],
    ["t", "software-engineering"],
    ["t", "ai-agent"]
  ]
}
```

**NIP-05 Directory:**
Organizations run a NIP-05 endpoint at their domain:
```json
// GET https://example.eve.dev/.well-known/nostr.json
{
  "names": {
    "code-review": "abc123...",
    "mission-control": "def456...",
    "deploy-bot": "789abc..."
  }
}
```

**Eve Marketplace (future):**
A dedicated relay or web UI that aggregates NIP-89 announcements from Eve agents:
- Browse agents by capability (code review, deployment, testing, etc.)
- See reputation scores (zap totals, completion rates, WoT ratings)
- Try before you buy — some agents offer free tiers
- One-click subscribe to agent announcements

### DVMCP Bridge: MCP Tools as DVMs

The DVMCP project already bridges MCP servers to Nostr DVMs. Eve agents with MCP tools
automatically become DVM providers:

```
Eve agent has MCP tool: "run-tests"
  → DVMCP bridge advertises kind:31990 for test execution
  → External agent requests kind:5050 with test parameters
  → Eve agent's MCP tool executes tests
  → Results published as DVM output
```

This means every MCP tool in Eve's ecosystem is automatically discoverable and
purchasable by any agent on the Nostr network. Zero additional code.

## Relay Architecture

### Eve-Operated Relays

Eve Horizon should operate its own Nostr relays:

**Public relay** (`wss://relay.eve.dev`)
- Stores DVM announcements, results, and reputation events
- Free to read, authenticated write (NIP-42)
- Optimized for DVM event kinds (5000-6999, 7000)

**Org-private relay** (`wss://relay.{org}.eve.dev`)
- NIP-42 authenticated: only org members can read/write
- Stores internal agent coordination events
- Job status updates, team dispatch signals
- Think of it as the Nostr equivalent of Eve's internal event spine

**Why operate relays?**
- Guaranteed delivery for DVM results (public relays may drop events)
- Low latency for agent-to-agent coordination
- Revenue opportunity (paid relay access for premium features)
- Data sovereignty — org data stays on org infrastructure

### Relay as Event Spine Extension

The most elegant idea: use Nostr relays as the *external* event spine.

Today Eve's event spine is Postgres. Internal events stay there. But events that
cross organizational boundaries — DVM requests, agent-to-agent messages, reputation
attestations — flow through Nostr relays.

```
Internal events: Postgres event spine (fast, queryable, private)
External events: Nostr relays (open, federated, censorship-resistant)
Bridge: Gateway service translates between the two
```

This preserves Eve's internal performance while giving agents a global communication
layer. The gateway already normalizes external events — Nostr is just another source.

## Concrete Scenarios

### Scenario 1: Open Source Maintainer

An open source project runs Eve agents for code review and CI. Any contributor
can request a review by publishing a Nostr DVM request with a PR URL. The agent
reviews the code, publishes results, and the contributor zaps 500 sats. No GitHub
account linking, no permissions setup, no API keys.

```
Contributor → kind:5050 { "i": ["https://github.com/org/repo/pull/42", "url"] }
Eve agent → kind:6050 { "content": "Review: 3 issues found..." }
Contributor → kind:9735 zap (500 sats)
```

### Scenario 2: Agent Swarm

A complex product launch requires copywriting, design, code, testing, and deployment.
The coordinating Eve agent decomposes the work and publishes DVM requests for each
capability. Some are fulfilled by other Eve agents (same org), some by external DVMs
on the network. The coordinator assembles results, manages dependencies, and delivers
the final product.

Total cost: 50,000 sats (~$25 at current prices), paid automatically from the
agent's Cashu wallet. No invoices, no contracts, no accounts payable.

### Scenario 3: Personal AI Assistant

A user runs a personal Eve instance on a VPS. Their assistant agent has a Nostr
identity and a small Cashu wallet. When the user asks "summarize this podcast",
the agent publishes a kind:5000 (transcription) DVM request, pays 200 sats, then
runs summarization locally. The user interacts entirely through Nostr DMs — no
web UI, no app, just their favorite Nostr client.

### Scenario 4: Monetized Agent Marketplace

An organization builds specialized agents (legal research, financial analysis,
medical literature review) and deploys them on Eve Horizon. Each agent advertises
on Nostr as a DVM. Customers discover them through NIP-89, request work, and pay
via Lightning. The org earns revenue without building a website, payment system,
or customer management — it's all handled by the protocol.

### Scenario 5: Agent Reputation Network

Over time, agents accumulate reputation through successful DVM completions and
Web of Trust ratings. A coordinating agent that needs to outsource a subtask
queries its trust graph: "Which code review agents have been rated highly by
agents I trust?" This creates a self-organizing quality layer — good agents get
more work, bad agents get filtered out, all without centralized moderation.

### Scenario 6: Sovereign Developer Tooling

A freelance developer wants CI/CD without GitHub Actions, Vercel, or any
centralized platform. They push code to a Git server, mention their Eve agent
on Nostr, and the agent runs tests, builds, and deploys — paid per run via
Lightning. The developer's toolchain is entirely sovereign: self-hosted Git,
Nostr for communication, Lightning for payment, Eve for execution.

## Implementation Phases

### Phase 0: Research and Proof of Concept
- Spike: Nostr gateway plugin (subscribe to relays, publish events)
- Spike: NIP-90 DVM request/response for a single job kind
- Spike: Lightning payment receipt verification
- Validate: latency, relay reliability, payment flow UX

### Phase 1: Nostr as Chat Channel
- Gateway plugin: Nostr DMs and mentions → chat.message.received
- Agent keypair generation and NIP-05 publishing
- NIP-46 remote signing integration with Eve secret management
- Outbound message publishing (agent replies on Nostr)

### Phase 2: DVM Provider
- NIP-89 capability announcements from agent config
- NIP-90 job request ingestion (kind 5000-5999)
- Job result publishing (kind 6000-6999)
- Lightning zap verification on results
- Basic pricing model in manifest

### Phase 3: Agent Wallets
- NIP-60 Cashu wallet per agent
- Budget controls and spending policies
- Payment receipt and revenue tracking
- Human approval flow for large transactions
- Auto-funding from org treasury

### Phase 4: Autonomous Economy
- Agents as DVM *consumers* (outsource subtasks to network)
- DVM job chaining in Eve job hierarchy
- Web of Trust reputation system
- DVMCP bridge for MCP tools
- Eve-operated relays

### Phase 5: Marketplace
- Agent discovery UI/relay
- Reputation dashboards
- Revenue analytics
- Multi-org agent federation

## Open Questions

- **Key custody**: Should Eve manage all agent keys, or allow users to bring their own?
  NIP-46 supports both — Eve as bunker, or external bunker pointed at by the user.

- **Relay selection**: Which relays should agents announce on? User-configurable with
  sensible defaults? Eve-operated relay as the guaranteed fallback?

- **Pricing models**: Per-request vs. subscription vs. auction (customer bids, agents
  compete)? NIP-90 supports all three — which should Eve default to?

- **Privacy**: DVM requests are public by default. NIP-90 supports encrypted requests
  (NIP-04). Should Eve agents prefer encrypted? Configurable per agent?

- **Regulatory**: Lightning payments and Cashu ecash have regulatory implications in
  some jurisdictions. How do we handle KYC/AML requirements for agents earning money?

- **Spam**: Open DVM requests mean anyone can send work. Rate limiting by reputation?
  Require minimum zap history? Prepayment for unknown pubkeys?

- **Relay costs**: Who pays for relay storage? Eve-operated relays need a funding model.
  Paid write access (NIP-42)? Bundled with Eve subscription?

## Why This Matters

The current AI agent landscape is fragmented across walled gardens. OpenAI's GPT Store,
Anthropic's tool use, Google's agent APIs — all proprietary, all siloed, all requiring
human-mediated setup.

Nostr + Eve Horizon offers something fundamentally different: **agents that exist as
sovereign entities on an open network**. They have their own identity (keypair), their
own money (Cashu wallet), their own reputation (Web of Trust), and their own marketplace
(NIP-90 DVMs). They can be discovered, hired, and paid by anyone — human or machine —
without any centralized intermediary.

Eve Horizon provides the execution engine — the compute, the orchestration, the skills,
the isolation, the observability. Nostr provides the coordination layer — the identity,
the communication, the discovery, the payment.

Together, they create the infrastructure for an **open agent economy** where the best
agents win on merit, not on platform lock-in. That's the kind of future worth building.
