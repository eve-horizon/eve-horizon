# First-Class Provider Registry + Model Auto-Discovery

> Status: Shipped (d0964e5)
> Last Updated: 2026-02-12
> Purpose: Make LLM providers a first-class abstraction with auto-discovery of models and dynamic rate card population.
> See also: [harness-execution.md](../system/harness-execution.md), [harness-adapters.md](../system/harness-adapters.md)

## Context

Adding a new LLM provider today touches **9 files across 3 packages** -- harness registry, auth checks, env map, capabilities, rate card, model normalization, receipt assembly, worker adapter, and entrypoint. The concept of "provider" already exists everywhere but has no name; it's implicit in harness adapters, scattered auth checks, and repeated per-model config.

Meanwhile, `ManagedModelConfig` repeats provider-level config (base_url, auth_header, auth_scheme, secret_ref) on every model -- all 3 current managed models are on GMI Cloud and share identical connection details.

Most providers expose model catalogs via `/v1/models` (OpenAI-compatible). OpenRouter provides cross-provider pricing for hundreds of models with no auth required. We can leverage both to auto-discover models and auto-populate rate cards.

## Definitions

- Provider: an external HTTP API endpoint (OpenAI/Anthropic/Gemini/Z.ai compatible) plus auth semantics, optional model discovery, and pricing metadata.
- Harness: a CLI tool invocation with its own binary/config directory (`mclaude`, `codex`, `code`, `gemini`, `zai`).
- Adapter: worker code that wraps a harness and prepares env/config (and optionally transforms requests).
- BYOK: provider auth comes from org/project/user secrets; usage is cost-estimated but not billed by Eve.
- Managed: provider auth comes from platform secrets (`system_settings["platform_secrets"]` via `platform.*` refs); usage is billable.

## Success Criteria

- Adding a provider requires editing exactly one registry file in `@eve/shared` (plus an adapter only if it is not OpenAI-compatible).
- Provider naming is consistent across receipts, rate cards, and managed model routing (no more `inferProviderFromHarness()` heuristics).
- Managed model configs no longer repeat provider connection/auth fields.
- Model discovery has predictable latency (cached) and does not leak secrets.
- Rate cards can be refreshed from OpenRouter into `pricing_rate_cards` as new immutable versions (never mutating history).

### Current provider-related code (scattered)

| Concern | File | How provider appears |
|---------|------|---------------------|
| Harness names | `packages/shared/src/harnesses/registry.ts` | `HARNESS_NAMES` array (harness != provider; claude+mclaude are both Anthropic) |
| Auth checks | `packages/shared/src/harnesses/auth.ts` | Hardcoded per-harness env var checks |
| Env var mapping | `packages/shared/src/pricing/managed-models.ts` | `HARNESS_ENV_MAP` constant |
| Managed models | `packages/shared/src/pricing/managed-models.ts` | `ManagedModelConfig` repeats provider config per model |
| Rate card | `packages/shared/src/pricing/default-rate-card.ts` | `byok[provider][model]`, `managed[provider][model]` |
| Provider inference | `packages/shared/src/pricing/receipt/assemble-attempt-receipt.ts` | `inferProviderFromHarness()` |
| Model normalization | `packages/shared/src/pricing/model-normalization.ts` | `if (p === 'anthropic')` branches |
| Worker adapters | `apps/worker/src/invoke/harnesses/*.ts` | Per-adapter env var resolution |
| Capabilities | `packages/shared/src/harnesses/capabilities.ts` | `model_examples` per harness |

### Model discovery APIs (research)

| Provider | Models Endpoint | Pricing in Response? |
|----------|----------------|---------------------|
| OpenAI | `GET /v1/models` | No |
| Anthropic | `GET /v1/models` | No |
| Google/Gemini | `GET /v1beta/models` | No |
| Together AI | `GET /v1/models` | **Yes** |
| GMI Cloud | `GET /v1/models` | No |
| Groq | `GET /openai/v1/models` | No |
| OpenRouter | `GET /api/v1/models` | **Yes** (hundreds of models, no auth required) |

**Goal**: One file to add a provider. Auto-discovery of available models. Auto-populated pricing.

## Phase 1: Provider Registry (foundation, zero behavior change)

Create `packages/shared/src/providers/` with the provider as a first-class type. Every field corresponds to something currently hardcoded elsewhere:

```typescript
// packages/shared/src/providers/types.ts

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'zai'
  | 'gmicloud'
  | 'together'
  | 'groq'
  | 'openrouter'
  | 'fireworks';

export interface ProviderDefinition {
  name: ProviderName;
  display_name: string;
  api_compatibility: 'openai' | 'anthropic' | 'gemini' | 'zai';
  base_url: string;                    // registry-controlled (SSRF guard)

  auth: {
    header: string;                    // 'Authorization' | 'x-api-key'
    scheme: string | null;             // 'Bearer' | null
    env_vars: string[];                // secret keys / env var names (e.g. ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
    // For managed models: resolve via system_settings["platform_secrets"] when prefixed with "platform."
    platform_secret_ref?: string;      // e.g. 'platform.gmicloud.api_key'
  };

  harnesses: {
    primary: HarnessCanonicalName;     // default harness for this provider
    all: HarnessCanonicalName[];       // all harnesses that talk to this provider
    env_map: { apiKey: string; baseUrl: string };
  };

  normalization: {
    strip_patterns: RegExp[];          // date suffix patterns to strip for rate card lookup
  };

  discovery: {                         // null = no auto-discovery
    models_path: string;               // e.g. '/v1/models'
    has_pricing: boolean;              // Together AI, OpenRouter include pricing
  } | null;

  extra_headers?: Record<string, string>;
}
```

Notes:
- The provider registry is **code-only** (not persisted). API responses must expose a JSON-safe shape (no `RegExp` objects).
- `ProviderDefinition.name` should be used consistently as the `provider` key in `llm.call` events, receipts, and rate cards.

### Field provenance

| Field | Currently lives in |
|-------|-------------------|
| `name` | `inferProviderFromHarness()` in `assemble-attempt-receipt.ts` |
| `api_compatibility` | Implicit in which harness adapter is used |
| `base_url` | Repeated per-model in `ManagedModelConfig.base_url` |
| `auth.env_vars` | Hardcoded in `auth.ts` checks per harness |
| `auth.header/scheme` | Repeated per-model in `ManagedModelConfig` |
| `harnesses.env_map` | `HARNESS_ENV_MAP` in `managed-models.ts` |
| `normalization.strip_patterns` | `normalizeModelName()` in `model-normalization.ts` |
| `discovery` | Does not exist yet |

### Registry entries

Initial providers: `anthropic`, `openai`, `google`, `zai`, `gmicloud`. Future: `together`, `groq`, `openrouter`, `fireworks`.

### Lookup functions

```typescript
getProvider(name: string): ProviderDefinition | undefined
getProviderForHarness(harness: HarnessCanonicalName): ProviderDefinition | undefined
getProviderByEnvVar(envVar: string): ProviderDefinition | undefined
```

These three functions replace `inferProviderFromHarness()`, the hardcoded auth checks, and `HARNESS_ENV_MAP`.

### Files

| Action | File | What changes |
|--------|------|-------------|
| **Create** | `packages/shared/src/providers/types.ts` | `ProviderDefinition` type |
| **Create** | `packages/shared/src/providers/registry.ts` | `PROVIDER_REGISTRY` + lookup functions |
| **Create** | `packages/shared/src/providers/index.ts` | Barrel export |
| **Edit** | `packages/shared/src/index.ts` | Add `export * from './providers/index.js'` |
| **Edit** | `packages/shared/src/pricing/model-normalization.ts` | `normalizeModelName()` reads `strip_patterns` from provider registry instead of `if (p === 'anthropic')` branches |
| **Edit** | `packages/shared/src/pricing/managed-models.ts` | `HARNESS_ENV_MAP` derived from `PROVIDER_REGISTRY` (re-exported for backward compat) |
| **Edit** | `packages/shared/src/pricing/receipt/assemble-attempt-receipt.ts` | `inferProviderFromHarness()` delegates to `getProviderForHarness()` |

**No behavior change.** All existing tests must pass unchanged. The derived values are identical to the hardcoded ones.

## Phase 2: Simplified ManagedModelConfig

Models reference their provider instead of repeating its config:

```typescript
// BEFORE (repeated 6 fields per model)
'deepseek-r1': {
  display_name: 'DeepSeek R1',
  inference_provider: 'gmicloud',
  harness: 'code',
  api_model_id: 'deepseek-ai/DeepSeek-R1',
  base_url: 'https://api.gmi-serving.com/v1/',
  auth_header: 'Authorization',
  auth_scheme: 'Bearer',
  secret_ref: 'platform.gmicloud.api_key',
  extra_headers: {},
  capabilities: { streaming: true, tool_calling: true, reasoning: true },
}

// AFTER (provider carries all connection config)
'deepseek-r1': {
  display_name: 'DeepSeek R1',
  provider: 'gmicloud',
  api_model_id: 'deepseek-ai/DeepSeek-R1',
  capabilities: { streaming: true, tool_calling: true, reasoning: true },
}
```

A `resolveManagedModelConfig()` function merges provider defaults with per-model overrides at runtime. `normalizeManagedModelConfig()` converts legacy V1 configs (in database JSONB) to V2 at read time.

### Files

| Action | File | What changes |
|--------|------|-------------|
| **Edit** | `packages/shared/src/pricing/managed-models.ts` | Add `ManagedModelConfigV2`, `resolveManagedModelConfig()`, `normalizeManagedModelConfig()`. Update `DEFAULT_MANAGED_MODELS` to V2 |
| **Edit** | `apps/worker/src/invoke/invoke.service.ts` | `resolveManagedModel()` uses `resolveManagedModelConfig()` |
| **Edit** | `apps/agent-runtime/src/invoke/invoke.service.ts` | Same pattern |

**No database migration.** V1 configs in `system_settings`/`orgs`/`projects` JSONB are normalized at read time.

## Phase 3: Provider API + Model Discovery

New API endpoints and a discovery service that queries `/v1/models` from providers with valid credentials.

```
GET /providers                     -- list known providers with auth status
GET /providers/:name               -- single provider details
GET /providers/:name/models        -- discover available models (cached 5min)
```

### Discovery service

- Queries each provider's `discovery.models_path` with resolved credentials
- Parses response (OpenAI-compatible format is the de facto standard; custom parsers for non-OpenAI catalogs as needed)
- In-memory cache with 5-minute TTL (not persisted -- models change frequently, stale DB is worse than cache miss)
- Cache must be scoped by auth context (at minimum: org/project) to avoid cross-tenant model list leakage
- Graceful fallback to static registry on API errors
- Enforce timeouts and max response sizes; never log response bodies (avoid secret/content leakage)

```typescript
// packages/shared/src/providers/discovery.ts (types)
export interface DiscoveredModel {
  id: string;                          // provider's model ID
  provider: string;
  display_name?: string;
  pricing?: { input_per_million_usd: string; output_per_million_usd: string } | null;
}

export interface DiscoveryResult {
  provider: string;
  models: DiscoveredModel[];
  fetched_at: string;
  ttl_seconds: number;
  source: 'api' | 'cache' | 'static_fallback';
}
```

### Files

| Action | File |
|--------|------|
| **Create** | `packages/shared/src/providers/discovery.ts` -- types only |
| **Create** | `apps/api/src/providers/provider.module.ts` |
| **Create** | `apps/api/src/providers/provider.controller.ts` |
| **Create** | `apps/api/src/providers/provider-discovery.service.ts` |
| **Edit** | `apps/api/src/app.module.ts` -- import ProviderModule |

### CLI

```bash
eve providers list                     # providers + auth status
eve providers models gmicloud          # discovered models from GMI Cloud
eve providers models --all             # all authenticated providers
```

## Phase 4: Dynamic Rate Cards via OpenRouter

OpenRouter's `GET /api/v1/models` (no auth required) returns standardized pricing for hundreds of models across multiple providers. We can use it as a pricing oracle to update our rate cards without scraping provider pricing pages.

### Flow

```
eve admin pricing refresh-openrouter [--dry-run] [--name default] [--effective-at <iso>]
  1. Fetch OpenRouter /api/v1/models (cached 1hr)
  2. Match models to our providers via normalization rules
  3. For providers with their own pricing (Together), prefer that; OpenRouter as fallback
  4. Generate diff: new models, changed prices, removed models
  5. --dry-run: display diff. Otherwise: create a new immutable `pricing_rate_cards` row
```

### Files

| Action | File |
|--------|------|
| **Create** | `packages/shared/src/providers/pricing-oracle.ts` -- OpenRouter pricing client + normalized model pricing types |
| **Create** | `apps/api/src/pricing/rate-card-refresh.service.ts` -- builds candidate card + diff and optionally persists |
| **Edit** | `apps/api/src/pricing/pricing.controller.ts` -- admin refresh endpoint under `/admin/pricing/*` |
| **Edit** | `packages/cli/src/commands/admin.ts` -- add `eve admin pricing refresh-openrouter` |

Implementation notes:
- Rate cards are DB-backed (`pricing_rate_cards`). Refresh must create a new version (immutable history).
- `DEFAULT_RATE_CARD_V1` remains the compile-time fallback and is seeded via `eve admin pricing seed-defaults`.

## Phase 5: Derive Auth from Provider Registry (deferred)

Replace hardcoded per-harness auth checks in `auth.ts` with a generic function reading `provider.auth.env_vars`. Special cases (macOS Keychain, `~/.claude/.credentials.json`) become `auth.alternatives` on the provider definition.

**Deferred** because current auth checks work and changing them risks credential detection regressions. Ships after Phase 1-3 are battle-tested.

## Phase 6: Generic OpenAI-Compatible Adapter (future)

A single adapter that handles any OpenAI-compatible provider, driven entirely by `ProviderDefinition`. Eliminates the need to write a new adapter file for most new providers.

**Deferred** because current adapters have harness-specific logic (Claude config dir, Codex auth JSON, Zai dual API key) that doesn't generalize cleanly. Phase 6 builds a generic adapter for the common case with escape hatches for quirks.

## "Add a Provider" Surface Area

| Phase | Files to touch |
|-------|---------------|
| Today | 9 files across 3 packages |
| After Phase 1-2 | 1 file (`providers/registry.ts`) + adapter if needed |
| After Phase 3 | Same 1 file, models auto-discovered |
| After Phase 4 | Same 1 file, pricing auto-populated |
| After Phase 6 | 1 file only (generic adapter handles OpenAI-compatible providers) |

## Key Architectural Decisions

### Why a code registry, not a database table?

Providers change rarely (a few per year). They need to be available at build time (CLI bundles via esbuild). A code-level registry is simpler, version-controlled, and doesn't require a database connection to resolve. Discovery is a runtime enhancement on top of a compile-time foundation.

### Why OpenRouter as pricing oracle?

OpenRouter normalizes pricing across hundreds of models into a single API call with no authentication. Scraping individual provider pricing pages is fragile and provider-specific; OpenRouter gives us one consistent source for bulk pricing updates.

### Why in-memory discovery cache?

Model lists change frequently (new models, deprecated models). Stale data in a database table creates maintenance burden. An in-memory cache with 5-minute TTL ensures freshness and auto-evicts on service restart. The static registry (`DEFAULT_MANAGED_MODELS`) is the durable source; discovery is ephemeral enrichment.

### Why keep harnesses separate from providers?

A harness is a CLI tool invocation with its own binary, config directory, and subprocess lifecycle. A provider is an API endpoint. They are related but not the same:
- Claude Code (harness=`mclaude`) talks to Anthropic (provider=`anthropic`), but could also talk to a custom Anthropic-compatible proxy
- GMI Cloud models route through the `code` harness (OpenAI-compatible) even though GMI Cloud is a separate provider
- The relationship is many-to-one and the mapping lives in `ProviderDefinition.harnesses`

### Why rate card snapshots for billing?

Discovery can suggest prices, but an admin promotes them to the active rate card with a new `effective_at` timestamp. Receipts embed the rate card version and effective date for deterministic billing. Live API calls must never change prices mid-job.

## Verification (per phase)

```bash
# Phase 1
pnpm --filter @eve/shared test          # all existing tests pass unchanged
pnpm --filter @eve/shared build          # tsc clean

# Phase 2
pnpm --filter @eve/shared test           # managed model tests pass
# manual: run a managed/deepseek-r1 job, verify identical env injection

# Phase 3
pnpm --filter @eve-horizon/api test      # provider endpoints work
eve providers list                        # shows providers + auth status
eve providers models gmicloud             # discovers GMI Cloud models

# Phase 4
eve admin pricing refresh-openrouter --dry-run     # shows pricing diff from OpenRouter
```
