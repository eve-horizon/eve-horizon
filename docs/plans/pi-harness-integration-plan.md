# Pi Harness Integration Plan

> Status: Phase 1 Complete (reviewed 2026-03-03, Phase 2 pending)
> Created: 2026-03-03
> Scope: Phase 1 (new `pi` harness) + Phase 2 (managed model routing through pi)
> Prereq: Read [pi-mono-integration.md](../ideas/pi-mono-integration.md) for full background
>
> **Review notes (2026-03-03)**: Verified all sections against actual codebase. Fixed:
> - §1.1: Dockerfile now uses existing combined `$PACKAGES` RUN pattern; removed unnecessary entrypoint changes for Phase 1
> - §1.3: Fixed import paths to use `.js` extensions (ESM); simplified adapter to match gemini pattern
> - §1.4: Added missing CLI `types.ts` HarnessName union update; added PI_HOME dir creation in main()
> - §1.5: Rewrote event normalization as four concrete function changes (classifyKind, extractToolName, extractPiProvider, extractUsage camelCase); fixed inferProvider model-extraction approach
> - §1.6: Fixed auth check to match `createAuthChecks()` function pattern (flat `AuthCheck`, not `{check:}` wrapper)
> - §1.7: **Critical fix** — replaced wrong capability fields (`supports_streaming`, etc.) with actual `HarnessCapability` type (`supports_model`, `reasoning: ReasoningCapability`)
> - §1.8: **Critical fix** — removed non-existent `off`/`minimal` levels; Eve's type is `'low'|'medium'|'high'|'x-high'` only
> - §1.9: Clarified model normalization happens upstream; added defensive strip
> - §1.10: Enriched stub with skill-pack event, model field, and realistic token counts
> - §1.11: Merged into §1.5c; added rate card coverage table
> - §1.12: Added harness selection consideration (don't add to DEFAULT_HARNESS_PREFERENCE)
> - §2.1: Fixed `ctx.helpers.writeTemp` (doesn't exist) — moved to worker invoke service
> - Checklist: Expanded from 16 to 20 items with section cross-refs

## Motivation

pi-mono (`@mariozechner/pi-coding-agent`) is a 19.3k-star MIT-licensed coding agent that supports 20+ LLM providers from a single binary. Adding it as an Eve harness gives us:

1. **Provider coverage** — One harness replaces the need for per-provider variants. Anthropic, OpenAI, Google, Bedrock, Mistral, Groq, xAI, OpenRouter all work out of the box.
2. **Private model support** — Any OpenAI-compatible endpoint works via `models.json`. Point it at Eve's managed inference URL and private models just work.
3. **Mid-session model switching** — pi can switch providers mid-conversation with proper message transformation. No other harness does this.
4. **No permission popups** — pi runs autonomously by default. No approval gates to work around in headless execution.

---

## Phase 1: Add `pi` Harness

### 1.1 Install pi in the Worker Image

**File: `apps/worker/Dockerfile`**

Add `@mariozechner/pi-coding-agent` to the existing combined `npm install -g` block in the `runtime-setup` stage. The Dockerfile accumulates all packages into `$PACKAGES` and installs them in one `RUN`:

```dockerfile
# Add ARG alongside the existing INSTALL_* ARGs
ARG INSTALL_PI=true

# Add to the existing combined RUN block (do NOT create a separate RUN)
    [ "$INSTALL_PI" = "true" ] && PACKAGES="$PACKAGES @mariozechner/pi-coding-agent" || true && \
```

Also pre-create the pi config directory (alongside existing `.claude`, `.code`, `.codex` dirs):

```dockerfile
# In the directory creation section
    mkdir -p /home/node/.pi/agent && \
```

**File: `docker/worker/entrypoint.sh`**

No entrypoint changes needed for Phase 1. pi reads API keys directly from environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) — no credentials file or config directory gymnastics needed. The `models.json` is only needed for Phase 2 (managed model routing).

> **Phase 2 note**: When models.json delivery is added, follow the entrypoint naming convention `write_pi_credentials()` and add it to the boot sequence alongside `write_claude_credentials` and `write_codex_credentials`.

### 1.2 Register the Harness Name

**File: `packages/shared/src/harnesses/registry.ts`**

```typescript
// Add 'pi' to both arrays
export const HARNESS_NAMES = ['mclaude', 'claude', 'zai', 'gemini', 'code', 'coder', 'codex', 'pi'] as const;
export const HARNESS_CANONICAL_NAMES = ['mclaude', 'claude', 'zai', 'gemini', 'code', 'codex', 'pi'] as const;

// Add entry to HARNESS_REGISTRY
{
  name: 'pi',
  description: 'pi coding agent — multi-provider, extensible',
}

// Keep aliases out of HARNESS_CANONICAL_NAMES (e.g., coder as an alias of code)
```

### 1.3 Shared Adapter (Server-Side)

**New file: `packages/shared/src/harnesses/adapters/pi.ts`**

pi is the simplest adapter — no auth helpers, no config dir resolution. Like `gemini.ts`, it just forwards env vars and options. Note the `.js` import extensions (required by the project's ESM config):

```typescript
import type { HarnessAdapter } from './types.js';
import { mapReasoningEffort } from './reasoning.js';

// Provider API keys that pi reads natively from environment
const PI_PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'Z_AI_API_KEY',
  'ZAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

export const piAdapter: HarnessAdapter = {
  name: 'pi',
  buildOptions: async (ctx) => {
    const env: Record<string, string | undefined> = {};

    // Forward any provider-specific API keys from resolved secrets
    for (const key of PI_PROVIDER_KEYS) {
      if (ctx.env[key]) env[key] = ctx.env[key];
    }

    // Phase 2: managed model routing via models.json
    if (ctx.env.PI_MODELS_JSON_B64) {
      env.PI_MODELS_JSON_B64 = ctx.env.PI_MODELS_JSON_B64;
    }

    return {
      harness: ctx.harness,
      permission: ctx.permission,
      variant: ctx.invocation.harness_options?.variant ?? ctx.invocation.variant,
      model: ctx.invocation.harness_options?.model,
      reasoning: mapReasoningEffort(ctx.harness, ctx.invocation.harness_options?.reasoning_effort),
      env,
    };
  },
};
```

**File: `packages/shared/src/harnesses/adapters/index.ts`**

Import and add to the `adapters` array:

```typescript
import { piAdapter } from './pi.js';

const adapters: HarnessAdapter[] = [
  claudeAdapter, mclaudeAdapter, zaiAdapter, geminiAdapter, codeAdapter, codexAdapter, piAdapter,
];
```

### 1.4 CLI Types + CLI Adapter (eve-agent-cli)

**File: `packages/eve-agent-cli/src/harnesses/types.ts`**

The CLI package has its own `HarnessName` union (separate from `@eve/shared`). Add `'pi'`:

```typescript
export type HarnessName =
  | 'claude'
  | 'mclaude'
  | 'zai'
  | 'gemini'
  | 'code'
  | 'coder'
  | 'codex'
  | 'pi';
```

**New file: `packages/eve-agent-cli/src/harnesses/pi.ts`**

```typescript
import type { CliHarnessAdapter, CliContext, HarnessCommand } from './types.js';

export function buildPiCommand(ctx: CliContext): { command: HarnessCommand; warnings: string[] } {
  const warnings: string[] = [];
  const args: string[] = [];
  const env: Record<string, string | undefined> = { ...ctx.env };

  // Non-interactive JSON streaming mode (no session persistence)
  args.push('--mode', 'json');
  args.push('--no-session');

  // Disable extension/skill/theme auto-discovery in containerized env
  args.push('--no-extensions', '--no-skills', '--no-themes', '--no-prompt-templates');

  // Model selection — pi uses provider/model prefix: --model openai/gpt-4o
  if (ctx.model) {
    args.push('--model', ctx.model);
  }

  // Thinking/reasoning level (already mapped by shared adapter)
  if (ctx.reasoning) {
    args.push('--thinking', ctx.reasoning);
  }

  // Tool selection — pi defaults to read,bash,edit,write
  args.push('--tools', 'read,bash,edit,write,grep,find,ls');

  // Permission policy — pi runs autonomously (no built-in gates)
  if (ctx.permission !== 'yolo' && ctx.permission !== 'never') {
    warnings.push('pi has no built-in permission gates; running autonomously');
  }

  // Prompt is the last positional argument
  args.push(ctx.prompt);

  return {
    command: {
      binary: 'pi',
      args,
      env,
    },
    warnings,
  };
}

export const piCliAdapter: CliHarnessAdapter = {
  name: 'pi',
  buildCommand: buildPiCommand,
};
```

**File: `packages/eve-agent-cli/src/harnesses/index.ts`**

Import and add to the `adapters` array:

```typescript
import { piCliAdapter } from './pi.js';

const adapters: CliHarnessAdapter[] = [
  claudeAdapter, mclaudeAdapter, zaiAdapter, geminiAdapter, codeAdapter, codexAdapter, piCliAdapter,
];
```

**File: `packages/eve-agent-cli/src/index.ts`** (config dir creation)

In `main()`, after the existing `CLAUDE_CONFIG_DIR` and `CODEX_HOME` dir creation, add pi's config dir:

```typescript
if (command.env.PI_HOME) {
  await ensureDir(path.join(command.env.PI_HOME, 'agent'));
}
```

### 1.5 Event Normalization

**File: `packages/eve-agent-cli/src/index.ts`**

All event normalization is inline in this file (no separate normalizer module). Three functions need pi-specific branches:

#### pi's JSONL output format

```jsonl
{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[]}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}
{"type":"message_end","message":{...,"usage":{"input_tokens":10,"output_tokens":20}}}
{"type":"tool_execution_start","toolCallId":"...","toolName":"bash","args":{...}}
{"type":"tool_execution_end","toolCallId":"...","toolName":"bash","result":{...},"isError":false}
{"type":"turn_end","message":{...},"toolResults":[...]}
{"type":"agent_end","messages":[...]}
```

#### 1.5a `classifyKind()` — add pi event type branches

```typescript
// Add BEFORE the final 'return system' fallback:

// pi events
if (raw.type === 'message_update') {
  const ame = raw.assistantMessageEvent as Record<string, unknown> | undefined;
  if (ame?.type === 'text_delta') return 'assistant';
  if (ame?.type === 'thinking_delta') return 'system';
  return 'assistant';
}
if (raw.type === 'tool_execution_start') return 'tool_use';
if (raw.type === 'tool_execution_end') return 'tool_result';
if (raw.type === 'session' || raw.type === 'agent_start' || raw.type === 'agent_end'
    || raw.type === 'turn_start' || raw.type === 'turn_end'
    || raw.type === 'message_start' || raw.type === 'message_end') return 'system';
```

#### 1.5b `extractToolName()` — extract from pi's tool events

```typescript
// Add: pi emits toolName at top level for tool_execution_start/end
if (typeof raw.toolName === 'string') return raw.toolName;
```

#### 1.5c `inferProvider()` — extract provider from pi model string

The current `inferProvider(harness, env)` maps harness→provider statically. For pi, the provider is embedded in the model string (`anthropic/claude-sonnet-4`). Since `inferProvider` doesn't receive the model, we need a different approach.

**Option A (recommended)**: Change `maybeBuildLlmCallEvent` to extract provider from the model string when harness is `pi`, before calling `inferProvider`:

```typescript
// In maybeBuildLlmCallEvent, after extractUsage:
let provider: string;
if (ctx.harness === 'pi') {
  const model = inferModel(ctx.env, { model: ctx.model }, raw);
  provider = extractPiProvider(model, ctx.env);
} else {
  provider = inferProvider(ctx.harness, ctx.env);
}
```

```typescript
function extractPiProvider(model: string, env: Record<string, string | undefined>): string {
  const override = env.EVE_LLM_PROVIDER;
  if (override) return override;
  if (model.includes('/')) {
    return model.split('/')[0]; // "anthropic/claude-sonnet-4" → "anthropic"
  }
  return 'unknown';
}
```

**Option B**: Add the default `case 'pi': return 'unknown'` to `inferProvider()` and rely on `maybeBuildLlmCallEvent`'s raw model extraction. Less precise but simpler.

#### 1.5d `extractUsage()` — camelCase aliases

pi may emit camelCase token fields (`inputTokens`, `outputTokens`). Add fallback aliases:

```typescript
const input =
  (typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined)
  ?? (typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined)
  ?? (typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined)  // pi
  ?? 0;

const output =
  (typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined)
  ?? (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined)
  ?? (typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined)  // pi
  ?? 0;
```

#### Event mapping summary

| pi event | Eve kind | Notes |
|----------|----------|-------|
| `session` | `system` | Session metadata |
| `agent_start`, `turn_start`, `message_start` | `system` | Lifecycle boundaries |
| `message_update` (text_delta) | `assistant` | Streaming text |
| `message_update` (thinking_delta) | `system` | Reasoning stream |
| `message_end` | `system` | Contains `message.usage` → triggers `llm.call` extraction |
| `tool_execution_start` | `tool_use` | Tool name from `toolName` field |
| `tool_execution_end` | `tool_result` | Result + isError |
| `turn_end`, `agent_end` | `system` | Lifecycle boundaries |

### 1.6 Auth Checks

**File: `packages/shared/src/harnesses/auth.ts`**

Auth checks are defined inside `createAuthChecks()` which returns `Record<HarnessCanonicalName, AuthCheck>` where `AuthCheck = (env: EnvLike) => HarnessAuthStatus`. Add a `pi` entry:

```typescript
pi: (env) => {
  const hasAnyKey = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'Z_AI_API_KEY',
    'ZAI_API_KEY',
    'MISTRAL_API_KEY',
    'XAI_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'PI_MODELS_JSON_B64',  // Custom models config (Phase 2)
  ].some(k => !!env[k]);
  return {
    available: hasAnyKey,
    reason: hasAnyKey ? 'using provider credentials' : 'missing pi provider credentials',
    instructions: hasAnyKey
      ? []
      : ['Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, Z_AI_API_KEY, or ZAI_API_KEY.'],
  };
},
```

### 1.7 Capabilities

**File: `packages/shared/src/harnesses/capabilities.ts`**

The actual `HarnessCapability` type is `{ supports_model, model_notes?, model_examples?, reasoning?: ReasoningCapability }`. Add entry to `HARNESS_CAPABILITIES`:

```typescript
pi: {
  supports_model: true,
  model_notes: 'Use provider/model format (e.g., anthropic/claude-sonnet-4)',
  model_examples: [
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
    'google/gemini-2.5-pro',
  ],
  reasoning: {
    supported: true,
    levels: ['low', 'medium', 'high', 'x-high'],
    mode: 'level',  // pi maps these to its own thinking levels
    notes: 'pi maps x-high to xhigh internally',
  },
},
```

### 1.8 Reasoning Mapping

**File: `packages/shared/src/harnesses/adapters/reasoning.ts`**

Eve's `ReasoningEffort` type is `'low' | 'medium' | 'high' | 'x-high'` — there is no `off` or `minimal`. pi uses the same level names except `x-high` → `xhigh`. The mapping follows the same pattern as `code/codex` (which also maps `x-high` → `xhigh`).

Add a `PI_REASONING_MAP` constant and a `case 'pi':` branch:

```typescript
const PI_REASONING_MAP: Record<ReasoningEffort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'x-high': 'xhigh',
};

// In mapReasoningEffort switch:
case 'pi':
  return PI_REASONING_MAP[effort as ReasoningEffort] ?? effort;
```

### 1.9 Pricing

**File: `packages/shared/src/pricing/default-rate-card.ts`**

No new rate card entries needed. pi is a harness, not a provider. The provider-specific rates (Anthropic, OpenAI, etc.) already exist. The `llm.call` events will carry the actual provider name extracted from pi's model identifier.

**File: `packages/shared/src/pricing/model-normalization.ts`**

The existing `normalizeModelName(provider, model)` already strips `managed/` prefix and applies provider-specific strip patterns. The provider/model split should happen upstream in `extractPiProvider` (§1.5c) and `inferModel` — by the time we reach `normalizeModelName`, the provider and model are already separated.

However, if a pi model string like `anthropic/claude-sonnet-4` leaks through as the raw model name, add a defensive strip in `normalizeModelName`:

```typescript
// Strip provider prefix if present (pi emits "anthropic/claude-sonnet-4")
if (model.includes('/') && !model.startsWith('managed/')) {
  model = model.split('/').slice(1).join('/');
}
```

### 1.10 Test Fixture

**New file: `tests/fixtures/bin/pi`**

The stub must emit pi-native JSONL that the normalizer (§1.5) will process. Existing stubs are `#!/usr/bin/env bash` with `set -euo pipefail`. The stub includes:
- Lifecycle events (→ `system` kind)
- A `message_update` with `text_delta` (→ `assistant` kind)
- A `message_end` with `message.usage` (→ triggers `llm.call` extraction)
- The `model` field at top level so `inferModel` can extract it

```bash
#!/usr/bin/env bash
set -euo pipefail

harness="pi"
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Lifecycle events (classified as 'system')
echo "{\"type\":\"session\",\"version\":3,\"id\":\"test-session\",\"timestamp\":\"$ts\",\"cwd\":\"$(pwd)\"}"
echo "{\"type\":\"agent_start\"}"
echo "{\"type\":\"turn_start\"}"
echo "{\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"content\":[]}}"

# Skill-pack event (matches existing harness stub pattern)
echo "{\"type\":\"event\",\"timestamp\":\"$ts\",\"content\":{\"message\":\"skill-pack-check core_pack=e2e-core repo_pack=e2e-repo\",\"harness\":\"$harness\"}}"

# Assistant text (classified as 'assistant')
echo "{\"type\":\"message_update\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Hello from $harness stub\"}]},\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"Hello from $harness stub\"}}"

# Message end with usage (triggers llm.call extraction via extractUsage → message.usage path)
echo "{\"type\":\"message_end\",\"model\":\"anthropic/claude-sonnet-4\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Hello from $harness stub\"}],\"usage\":{\"input_tokens\":1200,\"output_tokens\":340,\"cache_read_tokens\":0,\"cache_write_tokens\":0,\"reasoning_tokens\":0}}}"

# Lifecycle close
echo "{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Hello from $harness stub\"}]},\"toolResults\":[]}"
echo "{\"type\":\"agent_end\",\"messages\":[]}"
```

### 1.11 Provider Mapping

Handled in §1.5c via `extractPiProvider()`. pi's `provider/model` format means the provider prefix maps directly to Eve's provider names for pricing. Most map 1:1:

| pi prefix | Eve provider | Rate card exists? |
|-----------|-------------|-------------------|
| `anthropic` | `anthropic` | Yes |
| `openai` | `openai` | Yes |
| `google` | `google` | Yes (via gemini model IDs) |
| `bedrock` | `bedrock` | No — falls through to `normalizeModelName` strip |
| `zai` | `zai` | Yes |
| `mistral` | `mistral` | No rate card entry yet |
| `groq` | `groq` | No rate card entry yet |
| `xai` | `xai` | No rate card entry yet |
| `openrouter` | `openrouter` | No rate card entry yet |
| `eve-managed` | `eve-managed` | Phase 2 — uses managed rate card |

For providers without rate card entries, `llm.call` events still emit correctly — cost tracking falls back to zero-cost when no matching rate is found. Rate cards can be added incrementally.

### 1.12 Harness Selection (Optional)

**File: `packages/shared/src/harnesses/select.ts`**

`DEFAULT_HARNESS_PREFERENCE` is currently `['zai', 'claude', 'codex', 'gemini']`. Consider whether pi should be added. Since pi is a multi-provider harness (not tied to a single API key), it shouldn't participate in auto-selection initially — users should explicitly request `--harness pi`.

**Recommendation**: Don't add pi to `DEFAULT_HARNESS_PREFERENCE` for Phase 1.

---

## Phase 2: Managed Model Routing via pi

### Concept

Eve's managed inference endpoints (`/inference/v1/chat/completions`) speak the OpenAI Chat Completions protocol. pi supports custom OpenAI-compatible endpoints via `models.json`. By writing a `models.json` that points at Eve's inference URL, any managed model (Ollama, vLLM, external) becomes available to the pi harness without Eve-side protocol bridge changes.

### 2.1 Dynamic models.json Generation

**Where**: Worker invoke service (`apps/worker/src/invoke/invoke.service.ts`)

The `HarnessHelpers` type currently only provides `resolveMclaudeAuth` and `resolveCodeAuth` — there is no `writeTemp` helper. Rather than extending the helpers interface for pi alone, handle models.json generation in the worker's invoke service (which already has filesystem access for workspace setup):

```typescript
// In invoke.service.ts, after resolving adapter options but before spawning:
if (harness === 'pi' && managedModelsAvailable) {
  const piHome = path.join(workspace, '.pi-config', attemptId);
  await fs.mkdir(path.join(piHome, 'agent'), { recursive: true });
  await fs.writeFile(
    path.join(piHome, 'agent', 'models.json'),
    JSON.stringify(await buildPiModelsJson(ctx)),
  );
  processEnv.PI_HOME = piHome;
}
```

Alternatively, extend `HarnessHelpers` with a generic `writeTemp(name, content): string` if other harnesses need similar file-based config in future.

The `buildPiModelsJson()` function queries Eve's managed model availability and generates:

```json
{
  "providers": {
      "eve-managed": {
        "baseUrl": "http://eve-api:4801/inference/v1",
        "api": "openai-chat-completions",
        "apiKey": "EVE_INTERNAL_API_KEY",
      "models": [
        {
          "id": "managed/deepseek-r1",
          "name": "DeepSeek R1 (Eve Managed)",
          "reasoning": true,
          "contextWindow": 64000,
          "maxTokens": 8192
        },
        {
          "id": "managed/qwen3-30b",
          "name": "Qwen3 30B (Eve Managed)",
          "contextWindow": 32768,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

### 2.2 Managed Model Discovery

**Where**: Worker adapter or a new helper in `packages/shared/src/harnesses/`

Before job execution, query the API for available managed models:

```typescript
async function getAvailableManagedModels(apiBaseUrl: string, apiKey: string): Promise<ManagedModel[]> {
  // GET /inference/models or use the managed model availability from system_settings
  const response = await fetch(`${apiBaseUrl}/inference/models`, {
    headers: { 'x-eve-internal-key': apiKey },
  });
  return response.json();
}
```

Each managed model maps to a pi model entry with:
- `id`: `managed/<canonical>` (matches Eve's naming)
- `api`: `openai-chat-completions` (Eve's inference endpoint uses chat completions)
- `baseUrl`: Eve API's inference endpoint (internal cluster URL)
- `apiKey`: Eve internal API key (for internal routing)

### 2.3 models.json Delivery

Two options for getting the config to pi:

**Option A: Write to workspace (recommended)**

The worker writes `models.json` to a temp location and sets the `PI_HOME` env var:

```bash
PI_HOME=/tmp/pi-config-${ATTEMPT_ID}
mkdir -p $PI_HOME/agent
# Write generated models.json
echo '...' > $PI_HOME/agent/models.json
```

pi discovers `models.json` at `$HOME/.pi/agent/models.json` or wherever `PI_HOME` points.

**Option B: Base64 env var**

Encode the entire `models.json` as `PI_MODELS_JSON_B64`, have the entrypoint decode it. This avoids filesystem writes but is less debuggable.

Recommend **Option A** — it's what we do for Claude/Codex config dirs and is easier to inspect when debugging.

### 2.4 Model Selection in Jobs

Users specify managed models in job definitions:

```yaml
# .eve/manifest.yaml or job creation
harness: pi
harness_options:
  model: eve-managed/managed/deepseek-r1
```

Or via the Eve CLI:

```bash
eve job create \
  --harness pi \
  --model "eve-managed/managed/deepseek-r1" \
  --prompt "Implement the feature described in TASK.md"
```

The `eve-managed/` prefix tells pi to use the Eve managed provider from `models.json`. The `managed/deepseek-r1` model ID routes through Eve's inference endpoint to the actual Ollama/vLLM target.

### 2.5 Cost Tracking for Managed Models

When pi calls a managed model, the `llm.call` event should carry:
- `provider`: `eve-managed` (or the underlying provider from Eve's response headers)
- `model`: `managed/deepseek-r1`
- `tokens`: from pi's usage data

Eve's existing managed model cost tracking handles the rest — the inference endpoint already records usage and routes to the correct rate card.

For BYOK providers (Anthropic, OpenAI via pi), pi's `llm.call` events carry the standard provider name and model, which maps to existing rate cards.

### 2.6 Inference Endpoint Auth

The managed inference endpoint requires auth. For internal cluster traffic (worker → API):

- Use `EVE_INTERNAL_API_KEY` in the `models.json` apiKey field
- The inference endpoint validates this key and applies the job's org/project scope

For external inference (if pi needs to call the public Eve API):

- Use the job's bearer token or the org-scoped service principal token
- Set in `models.json` as `"apiKey": "Bearer <token>"` with appropriate `"authHeader": true`

---

## Implementation Checklist

### Phase 1: pi Harness

| # | Task | File(s) | §ref |
|---|------|---------|------|
| 1 | Add `pi` to shared harness name types + registry | `packages/shared/src/harnesses/registry.ts` | §1.2 |
| 2 | Add `pi` to CLI `HarnessName` union | `packages/eve-agent-cli/src/harnesses/types.ts` | §1.4 |
| 3 | Create shared adapter | `packages/shared/src/harnesses/adapters/pi.ts` (new) | §1.3 |
| 4 | Register shared adapter | `packages/shared/src/harnesses/adapters/index.ts` | §1.3 |
| 5 | Add auth check | `packages/shared/src/harnesses/auth.ts` | §1.6 |
| 6 | Add capabilities entry | `packages/shared/src/harnesses/capabilities.ts` | §1.7 |
| 7 | Add reasoning mapping | `packages/shared/src/harnesses/adapters/reasoning.ts` | §1.8 |
| 8 | Create CLI adapter | `packages/eve-agent-cli/src/harnesses/pi.ts` (new) | §1.4 |
| 9 | Register CLI adapter | `packages/eve-agent-cli/src/harnesses/index.ts` | §1.4 |
| 10 | Add `classifyKind` pi branches | `packages/eve-agent-cli/src/index.ts` | §1.5a |
| 11 | Add `extractToolName` pi branch | `packages/eve-agent-cli/src/index.ts` | §1.5b |
| 12 | Add `extractPiProvider` + wire into `maybeBuildLlmCallEvent` | `packages/eve-agent-cli/src/index.ts` | §1.5c |
| 13 | Add camelCase aliases to `extractUsage` | `packages/eve-agent-cli/src/index.ts` | §1.5d |
| 14 | Add `inferProvider` default case for pi | `packages/eve-agent-cli/src/index.ts` | §1.5c |
| 15 | Add PI_HOME dir creation in `main()` | `packages/eve-agent-cli/src/index.ts` | §1.4 |
| 16 | Add defensive provider/model split | `packages/shared/src/pricing/model-normalization.ts` | §1.9 |
| 17 | Add pi to worker Dockerfile | `apps/worker/Dockerfile` | §1.1 |
| 18 | Create test fixture stub | `tests/fixtures/bin/pi` (new) | §1.10 |
| 19 | Build + unit tests pass | `pnpm build && pnpm test` | — |
| 20 | Integration test with stub | `./bin/eh test integration` | — |

### Phase 2: Managed Model Routing

| # | Task | File(s) | §ref |
|---|------|---------|------|
| 21 | Dynamic models.json generation | `apps/worker/src/invoke/invoke.service.ts` | §2.1 |
| 22 | Managed model discovery helper | `packages/shared/src/harnesses/managed-models.ts` (new) | §2.2 |
| 23 | models.json workspace delivery | `apps/worker/src/invoke/invoke.service.ts` | §2.3 |
| 24 | Add `write_pi_credentials()` to entrypoint | `docker/worker/entrypoint.sh` | §2.3 |
| 25 | Verify inference endpoint auth | — | §2.6 |
| 26 | Cost tracking for managed models | `packages/eve-agent-cli/src/index.ts` | §2.5 |
| 27 | End-to-end test: pi → managed model | Manual test scenario | §Loop 3 |

---

## Open Design Questions

### 1. pi's JSON Output Format Normalization

pi emits a richer event stream than other harnesses (session headers, turn boundaries, compaction events). We need to decide:
- **Minimal**: Only extract text, tool calls, and usage — ignore pi-specific events
- **Rich**: Forward pi's full event stream through Eve's execution logs for better observability

Recommend **minimal** for Phase 1, with the option to enrich later.

### 2. Permission Policy Mapping

pi has no built-in permission system. Options:
- **Accept it**: pi runs autonomously. Map all Eve permission policies to "no gates" with a warning.
- **Eve extension**: Write a pi extension that implements Eve's permission policies by intercepting `tool_call` events. Ship it with the worker image and inject via `--extension`.

Recommend **accept it** for Phase 1. The `yolo` and `never` modes map naturally. For `default` and `auto_edit`, emit a warning that pi will run autonomously.

### 3. pi Home Directory

pi uses `~/.pi/agent/` for config. In the worker container:
- Use `$HOME/.pi/agent/` (worker runs as uid 1000)
- Or set a custom `PI_HOME` to a per-attempt temp directory

Recommend **per-attempt temp directory** to avoid config leakage between jobs.

### 4. pi Extensions in Eve

Should we invest in pi extensions for Phase 1? Candidates:
- **Eve tool bridge**: Extension that exposes Eve API operations as pi tools (e.g., `eve-deploy`, `eve-secret-get`)
- **Permission gate**: Extension implementing Eve's permission policies
- **Usage reporter**: Extension that emits Eve-compatible `llm.call` events

Recommend **no extensions in Phase 1**. pi's built-in tools (read, write, edit, bash, grep, find, ls) cover the coding agent use case. Extensions can be added incrementally.

### 5. Model String Format

pi uses `provider/model` (e.g., `anthropic/claude-sonnet-4`). Eve's existing harnesses use bare model names (e.g., `claude-sonnet-4`). For the pi harness:
- Jobs specify the full `provider/model` format
- Eve's model normalization strips the prefix for pricing lookup
- The provider is extracted for receipt attribution

This is a new pattern for Eve but natural for pi users.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| pi's JSONL format changes between versions | Event normalization breaks | Pin pi version in Dockerfile, test against known output |
| pi npm package is large | Worker image size grows | Measure impact; pi is TypeScript, not a compiled binary — should be modest |
| pi has no `--sandbox` flag | Security concern for untrusted workspaces | pi runs in Eve's containerized worker pods with filesystem isolation already |
| pi's `models.json` hot-reload | Config changes mid-job | Per-attempt temp directory prevents this |
| Single maintainer project | Long-term maintenance risk | MIT license, clean codebase, could fork or vendor |

---

## Verification Loop

### Prerequisites

- `EVE_API_URL` set for the target cluster
- Stable manual test org:

```bash
eve org ensure "manual-test-org" --slug manual-test-org --json
```

- Import secrets from the repo root:

```bash
eve secrets import --org org_manualtestorg --file ./manual-tests.secrets
```

Required for full coverage:
- `Z_AI_API_KEY` (or `ZAI_API_KEY`) for `zai` and BYOK compatibility path
- Optional: provider-specific keys for broader BYOK model matrix

### Loop 1 — Deterministic contract checks

1. **Static checks**
   - `pnpm -s build`
   - `pnpm -s test`
2. **Registry and config contract**
   - Harness appears in `HARNESS_NAMES`/`HARNESS_CANONICAL_NAMES` and `HARNESS_REGISTRY`
   - `auth` check returns explicit `available` + instructions for missing credentials
   - `getHarnessCapability('pi')` includes model + reasoning support
3. **Normalized event contract**
   - Ensure `tests/fixtures/bin/pi` outputs usage fields with numeric tokens in `input_tokens/output_tokens` form
   - Validate a stubbed execution emits:
     - `assistant` events (streamed text)
     - optional `tool_use`/`tool_result`
     - `llm.call` with parseable usage

### Loop 2 — Managed BYOK/runtime smoke

Use a dedicated verification project in `org_manualtestorg` and run:

```bash
eve job create \
  --project <project-id> \
  --harness pi \
  --model "anthropic/claude-sonnet-4" \
  --description "pi BYOK smoke" \
  --json
```

Then:

```bash
eve job follow <job-id>
eve job show <job-id> --json
eve job logs <job-id> --json | jq '.[] | select(.kind == "assistant" or .type == "llm.call")'
```

Acceptance:
- Job reaches `done`
- Execution stream includes assistant/tool events
- `llm.call.provider` is `anthropic` and usage is present

### Loop 3 — Managed routing smoke (requires managed inference target)

Only run this loop when managed inference is available:

```bash
eve job create \
  --project <project-id> \
  --harness pi \
  --model "eve-managed/managed/deepseek-r1" \
  --description "pi managed routing smoke" \
  --json
```

Acceptance:
- Job reaches `done`
- `models.json` provider/model mapping is reflected in normalized run output
- `llm.call.source` is `managed` and model/provider attribution remains intact

If managed routing is unavailable, mark this loop as blocked and continue with Loop 2.

## Success Criteria

### Phase 1
- [ ] `eve job create --harness pi --model anthropic/claude-sonnet-4 --prompt "..."` creates and executes a job
- [ ] Execution logs show normalized events (assistant text, tool calls, tool results)
- [ ] `llm.call` usage events are emitted with correct provider and token counts
- [ ] `pnpm build` and `pnpm test` pass
- [ ] Integration tests pass with stub fixture
- [ ] Verification Loop 1 and Loop 2 pass on target stack

### Phase 2
- [ ] `eve job create --harness pi --model eve-managed/managed/deepseek-r1 --prompt "..."` routes through Eve inference
- [ ] Managed model shows up in pi's available models (generated `models.json`)
- [ ] Cost tracking attributes usage to the correct managed model
- [ ] Works with Ollama targets on staging
- [ ] Verification Loop 3 runs when managed inference routing is available
