# Inference Simplification Plan: Remove Platform-Managed Inference

> Status: Complete
> Created: 2026-03-06
> Completed: 2026-03-10

## Summary

Remove Eve's entire inference abstraction layer — Ollama targets, managed models, health probing, admission control, wake services, protocol bridges, and the chat completions proxy. Replace with a simple model: **harnesses and apps bring their own keys (BYOK) via secrets, point at whatever provider they want via base URL + API key, done.**

This plan replaces the [Unified Inference Substrate Plan](./unified-inference-substrate-plan.md), which proposed making the abstraction *more* complex (RunPod serverless, substrate lifecycle management). We're going the opposite direction: delete the abstraction entirely.

---

## Why

### The abstraction solves a problem nobody has

The inference system was built speculatively for an Ollama-based world where Eve would manage GPU endpoints. That world never materialized:

1. **No users** — Zero production usage of the inference proxy, managed models, or Ollama targets
2. **Harnesses don't use it** — Every harness (mclaude, claude, zai, gemini, code, codex, pi) calls its upstream provider directly using API keys from secrets. The inference system sits unused beside them.
3. **The chat completions proxy has no clients** — `POST /inference/v1/chat/completions` exists but nothing calls it
4. **Commercial APIs don't need lifecycle management** — Anthropic, OpenAI, Google, Z.ai are always-on SaaS endpoints. There's nothing to provision, wake, sleep, or health-check.
5. **Self-hosted models are a user concern** — If someone runs vLLM on RunPod, they set `OPENAI_BASE_URL` and `OPENAI_API_KEY` in their secrets. Eve doesn't need to know about it.

### The cost of keeping it

- **~3,000 lines** of API service code (inference.service.ts alone is 1,389 lines)
- **6 database tables** with complex scoped routing, admission control, and quota enforcement
- **30+ API endpoints** that need auth, testing, and documentation
- **671 lines** of CLI code (`eve ollama` commands)
- **5 background services** (bootstrap, health probing, wake, admission) running on every API instance
- **Ongoing maintenance burden** — every auth change, every schema migration, every test suite must account for inference
- **Cognitive overhead** — new developers must understand targets, installs, aliases, route policies, managed models, transport profiles, protocol bridges

### What we'd be building instead (the substrate plan)

The [unified-inference-substrate-plan.md](./unified-inference-substrate-plan.md) proposed:
- A new `InferenceSubstrate` interface with RunPod as first implementation
- RunPod REST + GraphQL client code
- Template + endpoint provisioning lifecycle
- More database columns (`substrate`, `substrate_config`, `substrate_endpoint_id`)
- A new `SubstrateWakeService`
- A complete CLI rewrite (`eve ollama` → `eve inference` with even more subcommands)
- Estimated **10-14 days** of work

That's 10-14 days building more abstraction on top of an abstraction nobody uses. The correct investment is **negative**: delete what exists.

---

## The Simple Model

### How it works today (and should continue to work)

```
Job created with harness=mclaude
  → Worker resolves project secrets (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, etc.)
  → Harness adapter injects env vars into the harness process
  → mclaude calls api.anthropic.com directly
  → Done. Eve never touches the inference traffic.
```

This is already the production path for every harness. The inference system runs alongside it doing nothing.

### For Eve-compatible apps

Apps that need LLM inference:
1. Store their API key as a project secret: `eve secrets set OPENAI_API_KEY sk-xxx --scope project`
2. Set a base URL if needed: `eve secrets set OPENAI_BASE_URL https://my-vllm.runpod.ai/v1 --scope project`
3. Use the standard SDK (OpenAI, Anthropic, etc.) with those env vars
4. Eve injects secrets into the app's environment at deploy time via manifest interpolation

No platform involvement. No managed catalog. No proxy layer. The app talks directly to the provider.

### For self-hosted models (RunPod, vLLM, etc.)

Users who want to run their own models:
1. Set up their RunPod/Modal/vLLM endpoint themselves
2. Store the endpoint URL and API key as Eve secrets
3. Configure their harness or app to use those secrets
4. Eve is not involved in the lifecycle of the GPU endpoint

If we later want Eve to *provision* GPU endpoints as a platform feature, that's a separate, standalone feature — not an extension of the inference routing system.

---

## What Gets Removed

### API Services (apps/api/src/inference/)

| File | Lines | Purpose |
|------|-------|---------|
| `inference.module.ts` | 16 | Module registration |
| `inference.service.ts` | 1,389 | Core routing, admission, chat completions proxy |
| `inference.controller.ts` | 352 | 30+ REST endpoints |
| `inference-bootstrap.service.ts` | 71 | Auto-creates platform-gpu target on boot |
| `inference-health.service.ts` | ~120 | Background health probing (60s interval) |
| `inference-wake.service.ts` | ~100 | AWS ASG wake-on-demand |
| `target-admission.service.ts` | ~100 | In-memory queue + admission control |

**Total: ~2,150 lines deleted**

### Database (6 tables)

| Table | Purpose |
|-------|---------|
| `inference_targets` | Registered inference endpoints |
| `inference_models` | Canonical model registry |
| `inference_aliases` | Scoped model → target routing |
| `inference_installs` | Which models are on which targets |
| `inference_quotas` | Per-scope rate limits (unused) |
| `inference_route_policies` | Scope routing preferences |

**Migration**: Single migration that drops all 6 tables.

### Schemas (packages/shared/src/schemas/)

| File | What to remove |
|------|---------------|
| `inference.ts` | Delete entirely (~219 lines) |
| `managed-models.ts` | Delete entirely |

### Managed Models (packages/shared/src/pricing/)

| File | What to remove |
|------|---------------|
| `managed-models.ts` | Delete entirely (~341 lines) |
| `__tests__/managed-models.spec.ts` | Delete entirely |

### Queries (packages/db/src/queries/)

| File | What to remove |
|------|---------------|
| `inference.ts` | Delete entirely (~411 lines) |

### CLI (packages/cli/src/commands/)

| File | What to remove |
|------|---------------|
| `ollama.ts` | Delete entirely (~671 lines) |
| `models.ts` | Delete entirely (~140 lines) |

### Protocol Bridges (packages/shared/src/protocol-bridges/)

| File | What to remove |
|------|---------------|
| `registry.ts` | Delete entirely |
| `types.ts` | Delete entirely |
| `__tests__/registry.spec.ts` | Delete entirely |

### K8s Manifests

| File | What to remove |
|------|---------------|
| `k8s/overlays/local/app-secret-ollama.patch.yaml` | Delete |
| `packages/cli/assets/local-k8s/overlays/local/app-secret-ollama.patch.yaml` | Delete |

### API Module + Auth

| File | Change |
|------|--------|
| `apps/api/src/app.module.ts` | Remove `InferenceModule` import |
| `apps/api/src/auth/auth.decorator.ts` | Remove `AllowOllamaApiKeyAuth` decorator |
| `apps/api/src/auth/auth.guard.ts` | Remove `OLLAMA_API_KEY_AUTH_KEY` handling |

### Tests

| File | What to remove |
|------|---------------|
| `apps/api/test/integration/inference-ollama.integration.test.ts` | Delete entirely |
| `tests/manual/scenarios/22-platform-ollama.md` | Delete entirely |
| `packages/shared/test/unit/managed-models.test.ts` | Delete entirely |

### Models Controller + System Service

| File | Change |
|------|--------|
| `apps/api/src/models/models.controller.ts` | Delete (or simplify to static BYOK info) |
| `apps/api/src/system/system.service.ts` | Remove `listModels()` and managed model catalog methods |

### IDs (packages/shared/src/ids.ts)

Remove generators:
- `generateInferenceTargetId()`
- `generateInferenceModelId()`
- `generateInferenceAliasId()`
- `generateInferenceInstallId()`
- `generateInferenceQuotaId()`
- `generateInferenceRoutePolicyId()`

### Environment Variables Removed

| Variable | Purpose |
|----------|---------|
| `EVE_OLLAMA_BASE_URL` | Ollama endpoint URL |
| `EVE_OLLAMA_ASG_NAME` | AWS ASG for GPU wake |
| `EVE_OLLAMA_WAKE_ENABLED` | Toggle wake-on-demand |
| `EVE_OLLAMA_TRANSPORT_PROFILE` | Transport profile override |
| `EVE_INFERENCE_HEALTH_PROBE_ENABLED` | Health probing toggle |
| `EVE_INFERENCE_TARGET_ROUTING_ENABLED` | Alias routing toggle |
| `EVE_INFERENCE_ADMISSION_ENABLED` | Admission control toggle |
| `EVE_INFERENCE_ADMISSION_FALLBACK_DIRECT` | Admission fallback |
| `EVE_INFERENCE_ADMISSION_TIMEOUT_MS` | Admission timeout |
| `EVE_INFERENCE_ORG_TOKENS_PER_HOUR` | Org token budget |
| `EVE_INFERENCE_PROJECT_TOKENS_PER_HOUR` | Project token budget |
| `EVE_BRIDGE_LITELLM_ANTHROPIC_OPENAI_URL` | LiteLLM bridge URL |
| `EVE_BRIDGE_LITELLM_ANTHROPIC_OPENAI_KEY` | LiteLLM bridge key |

### Documentation

| File | Change |
|------|--------|
| `docs/system/inference-ollama.md` | Delete |
| `docs/plans/unified-inference-substrate-plan.md` | Mark as superseded |
| `CLAUDE.md` | Remove inference/Ollama references |
| `docs/ideas/private-model-inference-substrate.md` | Archive or delete |

---

## What Stays

### Provider Registry (packages/shared/src/providers/)

The provider registry (`registry.ts`, `types.ts`) is **kept**. It serves purposes beyond inference:

- Maps harness names to providers (used in receipt assembly)
- Defines env var names per provider (used by harness adapters)
- Normalizes model names for billing (used in pricing)
- Provider discovery for `eve models` could be kept as lightweight reference

The provider registry is a lookup table, not infrastructure. It has no runtime services, no background processes, no database tables. It earns its ~200 lines.

### Provider Discovery (apps/api/src/providers/)

**Evaluate separately.** The provider discovery service fetches model lists from provider APIs. It's lightweight (~200 lines), has no database tables, and could be useful for showing users what models are available. Keep or remove based on whether `eve models list` remains useful.

**Recommendation**: Keep as a simple, read-only reference feature. Simplify `eve models list` to just show provider information from the registry without the managed model catalog.

### Harness Adapters (packages/shared/src/harnesses/adapters/)

These stay unchanged. They read API keys from resolved secrets and inject env vars. They're the correct, simple abstraction.

### Secrets System

Completely unaffected. Secrets resolution (system → org → user → project cascade) is the backbone of BYOK and stays as-is.

### Pricing / Receipt Assembly

The receipt assembly code references providers and model normalization. These continue to work via the provider registry. Remove any `isManagedModelSpec` / `managed/` model spec handling from receipt paths — treat all models as BYOK.

---

## Implementation

### Phase 1: Remove Inference Module (~1 day)

1. Delete `apps/api/src/inference/` directory (all 7 files)
2. Remove `InferenceModule` from `apps/api/src/app.module.ts`
3. Remove `AllowOllamaApiKeyAuth` decorator and `OLLAMA_API_KEY_AUTH_KEY` from auth
4. Remove inference exports from `packages/db/src/queries/index.ts`
5. Delete `packages/db/src/queries/inference.ts`
6. Delete `packages/shared/src/schemas/inference.ts`
7. Build and fix any import errors

### Phase 2: Remove Managed Models + Protocol Bridges (~0.5 day)

1. Delete `packages/shared/src/pricing/managed-models.ts`
2. Delete `packages/shared/src/protocol-bridges/` directory
3. Delete `packages/shared/src/schemas/managed-models.ts`
4. Remove managed model methods from `apps/api/src/system/system.service.ts`
5. Simplify or delete `apps/api/src/models/models.controller.ts`
6. Clean up `packages/shared/src/index.ts` exports
7. Remove `isManagedModelSpec` / `parseManagedModelName` references from receipt assembly
8. Remove ID generators from `packages/shared/src/ids.ts`

### Phase 3: Remove CLI Commands + K8s Config (~0.5 day)

1. Delete `packages/cli/src/commands/ollama.ts`
2. Delete or simplify `packages/cli/src/commands/models.ts`
3. Remove ollama command registration from CLI entry point
4. Delete K8s ollama patch files
5. Remove `EVE_OLLAMA_*` and `EVE_INFERENCE_*` env var references from K8s manifests

### Phase 4: Database Migration (~0.5 day)

1. Create migration to drop all 6 inference tables:
   ```sql
   DROP TABLE IF EXISTS inference_route_policies;
   DROP TABLE IF EXISTS inference_installs;
   DROP TABLE IF EXISTS inference_quotas;
   DROP TABLE IF EXISTS inference_aliases;
   DROP TABLE IF EXISTS inference_models;
   DROP TABLE IF EXISTS inference_targets;
   ```
2. Remove `managed_model_availability` from `system_settings`

### Phase 5: Clean Up Tests + Docs (~0.5 day)

1. Delete `apps/api/test/integration/inference-ollama.integration.test.ts`
2. Delete `tests/manual/scenarios/22-platform-ollama.md`
3. Delete `packages/shared/test/unit/managed-models.test.ts`
4. Delete `packages/shared/src/pricing/__tests__/managed-models.spec.ts`
5. Delete `docs/system/inference-ollama.md`
6. Mark `docs/plans/unified-inference-substrate-plan.md` as superseded
7. Update `CLAUDE.md` — remove inference/Ollama references
8. Update skillpacks references

### Phase 6: Build + Test + Deploy (~0.5 day)

1. `pnpm install && pnpm build` — verify clean compilation
2. `pnpm test` — verify no test failures
3. `./bin/eh test integration` — verify integration tests pass
4. Tag and deploy to staging
5. Verify staging health

**Total: ~3 days** (compared to 10-14 days for the substrate plan)

---

## What About Future GPU Inference?

If we ever need Eve to provision GPU endpoints:

1. Build it as a **standalone feature** — not layered on an inference routing system
2. It would be a simple provisioning API: "create a RunPod endpoint for this model, give me back a URL and key"
3. The URL and key go into project secrets, same as any other provider
4. The harness or app uses them via standard env vars
5. No routing, no admission control, no health probing, no protocol bridges

The abstraction boundary is clear: Eve provisions infrastructure and manages secrets. Eve does not proxy inference traffic.

---

## Impact Assessment

| Area | Impact |
|------|--------|
| Job execution | **None** — harnesses use secrets directly |
| Agent runtime | **None** — same path as jobs |
| Chat gateway | **None** — agents call harnesses, not the inference proxy |
| Builds/deploys | **None** |
| Auth/RBAC | **Simplified** — remove Ollama API key auth path |
| Secrets | **None** |
| Billing/receipts | **Minor cleanup** — remove `managed/` model spec handling |
| CLI | **Simplified** — remove `eve ollama`, simplify `eve models` |
| Database | **6 tables dropped** — all empty in production |
| API surface | **~30 endpoints removed** — all unused |
| Background services | **4 fewer services** — bootstrap, health, wake, admission gone |

---

## Design Decision

### Why not keep a minimal version?

We considered keeping just:
- The provider registry (for model reference)
- A simplified `eve models list` (for discoverability)
- The chat completions proxy (as a convenience)

But the proxy is the problem. The moment you have a proxy, you need routing, auth, error handling, streaming, usage tracking, and testing. You end up rebuilding the complexity. The clean cut is: Eve doesn't proxy inference. Period.

The provider registry stays because it's a static lookup table with no runtime cost.

### Why not "just disable it"?

Dead code that "might be useful someday" is worse than no code. It:
- Accumulates tech debt (schema migrations must work around it)
- Confuses developers ("is this used? should I update it?")
- Creates false confidence ("we have inference support" — no, we have dead code)
- Blocks simplification of adjacent systems (auth, CLI, tests)

We're pre-MVP with zero users. This is the cheapest possible time to delete.
