# pi-mono Integration Opportunities

> Status: Idea
> Created: 2026-03-03
> Source: https://github.com/badlogic/pi-mono (19.3k stars, MIT, by Mario Zechner)

## What is pi-mono?

A TypeScript monorepo shipping 7 npm packages under `@mariozechner`. At its core: a minimal, radically extensible terminal coding agent. Philosophy is "adapt pi to your workflows, not the other way around" — no baked-in sub-agents, plan mode, or permission popups. Everything is pluggable via extensions.

### Package Map

| Package | npm | What it does |
|---------|-----|--------------|
| `pi-ai` | `@mariozechner/pi-ai` | Unified multi-provider LLM API — streaming, tool calling, model discovery, cost tracking |
| `pi-agent-core` | `@mariozechner/pi-agent-core` | Stateful agent runtime — tool execution loop, event streaming, steering/follow-up queues |
| `pi-coding-agent` | `@mariozechner/pi-coding-agent` | Interactive terminal coding agent — sessions, extensions, skills, themes |
| `pi-tui` | `@mariozechner/pi-tui` | Terminal UI library — differential rendering, editor components |
| `pi-web-ui` | `@mariozechner/pi-web-ui` | Web components for AI chat (mini-lit + Tailwind v4), IndexedDB storage |
| `pi-mom` | `@mariozechner/pi-mom` | Self-managing Slack bot that builds its own tools |
| `pi-pods` | `@mariozechner/pi-pods` | CLI for deploying/managing vLLM on GPU pods (DataCrunch, RunPod) |

---

## Integration Surface Areas

### 1. New Harness: `pi`

**Fit**: Natural. pi-coding-agent is a CLI coding agent with `--print` and JSON output modes, just like claude/mclaude/gemini/codex. It follows the same spawn-and-stream pattern Eve expects.

**Why it's interesting beyond "another harness":**

- **20+ providers from one binary.** pi supports Anthropic, OpenAI, Google, Bedrock, Mistral, Groq, Cerebras, xAI, OpenRouter, and more — all via a unified provider registry. A single `pi` harness could replace the need for per-provider harness variants.
- **Private model support via OpenAI-compatible URLs.** Any endpoint speaking the OpenAI completions or responses protocol works. Users configure custom providers in `~/.pi/agent/models.json`. This maps directly to Eve's managed inference: point pi at `EVE_INFERENCE_URL` and any `managed/*` model routes through Eve's Ollama/vLLM targets with zero pi-side configuration.
- **Mid-session model switching.** pi can switch providers mid-conversation. Its `transformMessages()` function handles the gnarly cross-provider translation (thinking blocks, tool call ID normalization, orphaned tool results). No other harness does this.
- **Extension-driven capabilities.** pi's extension system (44KB of type definitions) lets you inject tools, override compaction, control sessions, and add UI widgets — all without forking. Eve could ship pi extensions that integrate with Eve's own primitives (org-fs, secrets, managed models).

**Implementation sketch:**

```
# Proxy CLI adapter (eve-agent-cli)
pi --print --output-format stream-json \
  --model <model> \
  --provider <provider> \
  --tools read,bash,edit,write \
  "<prompt>"

# Auth: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
#        or custom via PI_MODELS_JSON pointing to Eve inference URL
```

Worker adapter would:
1. Write `~/.pi/agent/models.json` with Eve-managed model configs (base URL = Eve inference endpoint)
2. Install any Eve-specific pi extensions to the workspace
3. Pass API keys from resolved secrets
4. Stream JSON events through existing execution log pipeline

**What this unlocks:**
- Jobs can use *any* provider pi supports without Eve needing per-provider harness code
- Private/self-hosted models via OpenAI-compatible URLs just work
- Single harness binary covers the provider matrix that currently needs mclaude + zai + gemini + code + codex

### 2. `pi-ai` as a Standalone Library

**Beyond the harness**, `pi-ai` is a clean multi-provider LLM client library. Eve's own server-side code (orchestrator, API, agent runtime) currently doesn't have a unified way to call LLMs directly — it delegates everything through harnesses.

**Where Eve could use `pi-ai` directly:**

| Use case | Current approach | With pi-ai |
|----------|-----------------|------------|
| Job prompt enrichment / summarization | None (manual) | Call any provider to summarize/enrich before dispatch |
| Compaction / context management | Harness-specific | Server-side compaction using pi-ai's streaming |
| Agent runtime warm pod inference | Custom per-provider | Unified provider calls with cost tracking built in |
| Managed model health checks | Ollama API calls | Provider-agnostic health probes |
| Receipt generation | Parse harness JSONL | pi-ai emits structured usage events natively |

The provider registry pattern is elegant — each provider self-registers by API protocol type (`openai-completions`, `anthropic-messages`, `bedrock-converse-stream`, etc.), and models carry their `api` field. This maps cleanly to Eve's existing provider registry and protocol bridge concepts.

**Caution:** Adding a server-side LLM client is a significant architectural decision. Currently Eve is deliberately "dumb pipe" — it routes work to harnesses and records what happens. Using pi-ai server-side would start to blur that boundary. Worth considering carefully.

### 3. Cross-Provider Message Transformation

pi's `transformMessages()` solves a problem Eve will hit as managed model routing grows: what happens when a conversation started on Claude needs to continue on a different provider (failover, cost optimization, model unavailability)?

Current Eve behavior: harness choice is fixed for a job. If the harness can't reach its provider, the job fails.

pi's approach:
- Thinking blocks → plain text for non-Anthropic providers
- Tool call IDs normalized across provider ID formats
- Redacted thinking stripped for cross-model handoffs
- Errored/aborted messages pruned
- Orphaned tool calls get synthetic error results

This could be extracted and used in Eve's protocol bridge layer without adopting pi as a harness.

### 4. `EventStream<T,R>` Pattern

pi's core streaming primitive — a push-based async iterable with a `result()` promise for the final value. Simpler than Node streams or RxJS. Used at every layer from provider streaming to agent loops to proxy communication.

Eve's current streaming uses a mix of patterns (JSONL line parsing, SSE, custom event emitters). The `EventStream` pattern could inform a unified streaming primitive for:
- Execution log streaming (worker → API → CLI)
- Inference response streaming (managed models)
- Agent runtime message streaming

### 5. `pi-pods` for GPU Management

pi-pods is a CLI for deploying vLLM on GPU cloud providers (DataCrunch, RunPod). Eve already has Ollama GPU management (ASG wake, AMI provisioning), but pi-pods covers a different niche: **on-demand ephemeral GPU pods for vLLM inference**.

Potential synergy:
- Eve's managed model infrastructure could use vLLM pods as inference targets alongside Ollama
- pi-pods' provider abstraction (DataCrunch, RunPod, etc.) maps to Eve's inference target concept
- Could enable per-job or per-org ephemeral GPU allocation

### 6. `pi-web-ui` for Eve Dashboards

Eve's planned UI dashboards (jobs, runs, chat threads) need chat components. pi-web-ui provides:
- Markdown rendering with code blocks and syntax highlighting
- Streaming message display with tool call visualization
- Session management with branching/forking
- IndexedDB-backed local storage

These are lightweight web components (mini-lit, not React) that could be embedded in Eve's planned UI. The streaming proxy pattern (`streamProxy()` — SSE over POST with delta compression) is also worth studying for Eve's own UI streaming needs.

### 7. Session Tree (JSONL Branching)

pi stores sessions as JSONL files with `id` and `parentId` fields forming a tree. Branching creates new entries without duplicating the file. This is more elegant than Eve's current thread model for agent conversations that need:
- Mid-conversation branching (try different approaches)
- In-place compaction without losing history
- Lightweight session persistence

Could inform the design of Eve's thread/conversation storage.

### 8. Steering and Follow-up Queues (HITL)

pi has a clean HITL model:
- **Steering messages**: Interrupt the current tool chain, inject context, agent responds to interruption
- **Follow-up messages**: Queue work for after the agent finishes current chain

Eve's HITL model (review phase → continue/complete) is coarser-grained. pi's approach could inform a more interactive supervision model where humans can steer agents mid-execution without waiting for a full phase transition.

---

## Recommended Approach

### Phase 1: Harness Integration (Low Risk, High Value)

Add `pi` as a new harness. This is the most natural fit — it follows Eve's existing patterns exactly and immediately unlocks:
- All 20+ providers from one harness
- Private model support via OpenAI-compatible URLs
- Mid-session model switching

Implementation effort: ~2 days following the existing harness adapter pattern.

### Phase 2: Managed Model Routing via pi (Medium Risk, High Value)

Configure pi's `models.json` to point at Eve's inference endpoints. This makes managed models (Ollama, vLLM, external providers) available through pi without any Eve-side protocol bridge changes. The pi harness handles the provider protocol translation that currently requires LiteLLM bridges.

### Phase 3: Evaluate Component Adoption (Higher Risk, Strategic)

Study `pi-ai`, `EventStream`, and cross-provider message transformation for potential adoption in Eve's server-side code. These are architectural decisions that should be evaluated against Eve's current "dumb pipe" philosophy.

---

## Key Risks

| Risk | Mitigation |
|------|------------|
| pi is a single-maintainer project | MIT license, clean codebase, could fork if needed |
| pi's "stealth mode" (Claude Code tool name emulation) suggests fragile provider coupling | Monitor for breakage, pi community would catch this quickly |
| Adding pi as a harness increases worker image size | pi is an npm package, relatively lightweight |
| Server-side pi-ai adoption blurs the dumb-pipe boundary | Keep Phase 3 as evaluation only; harness-level integration is clean |

## Open Questions

1. Does pi's JSON output format map cleanly to Eve's execution log schema, or does it need a normalization layer?
2. How does pi handle permission policies? It has no built-in permission system — would Eve need a pi extension for this?
3. pi's extension system is powerful but filesystem-based. How would extensions work in Eve's containerized worker environment?
4. Could `pi-mom` (the self-managing Slack bot) inform Eve's chat gateway agent patterns?
