import type { HarnessCanonicalName } from '../harnesses/registry.js';
import type { ProviderDefinition, ProviderName } from './types.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * The provider registry. Source of truth for all provider configuration.
 *
 * To add a new provider:
 * 1. Add its name to the ProviderName union in types.ts
 * 2. Add an entry here
 * 3. (If not OpenAI-compatible) add an adapter in apps/worker/src/invoke/harnesses/
 */
export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
  {
    name: 'anthropic',
    display_name: 'Anthropic',
    api_compatibility: 'anthropic',
    base_url: 'https://api.anthropic.com',
    auth: {
      header: 'x-api-key',
      scheme: null,
      env_vars: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    },
    harnesses: {
      primary: 'mclaude',
      all: ['mclaude', 'claude'],
      env_map: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
    },
    normalization: {
      strip_patterns: [/-\d{8}$/],
    },
    discovery: {
      models_path: '/v1/models',
      has_pricing: false,
    },
  },
  {
    name: 'openai',
    display_name: 'OpenAI',
    api_compatibility: 'openai',
    base_url: 'https://api.openai.com/v1',
    auth: {
      header: 'Authorization',
      scheme: 'Bearer',
      env_vars: ['OPENAI_API_KEY', 'CODEX_AUTH_JSON', 'CODEX_OAUTH_ACCESS_TOKEN'],
    },
    harnesses: {
      primary: 'code',
      all: ['code', 'codex'],
      env_map: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    },
    normalization: {
      strip_patterns: [/-\d{4}-\d{2}-\d{2}$/, /-\d{8}$/],
    },
    discovery: {
      models_path: '/v1/models',
      has_pricing: false,
    },
  },
  {
    name: 'google',
    display_name: 'Google',
    api_compatibility: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com',
    auth: {
      header: 'x-goog-api-key',
      scheme: null,
      env_vars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    },
    harnesses: {
      primary: 'gemini',
      all: ['gemini'],
      env_map: { apiKey: 'GOOGLE_API_KEY', baseUrl: 'GOOGLE_BASE_URL' },
    },
    normalization: {
      strip_patterns: [/-\d{4}-\d{2}-\d{2}$/, /-\d{8}$/],
    },
    discovery: {
      models_path: '/v1beta/models',
      has_pricing: false,
    },
  },
  {
    name: 'zai',
    display_name: 'Z.ai',
    api_compatibility: 'zai',
    base_url: 'https://open.z.ai/api/paas/v4',
    auth: {
      header: 'Authorization',
      scheme: 'Bearer',
      env_vars: ['Z_AI_API_KEY', 'ZAI_API_KEY'],
    },
    harnesses: {
      primary: 'zai',
      all: ['zai'],
      env_map: { apiKey: 'Z_AI_API_KEY', baseUrl: 'Z_AI_BASE_URL' },
    },
    normalization: {
      strip_patterns: [/-\d{4}-\d{2}-\d{2}$/, /-\d{8}$/],
    },
    discovery: null,
  },
  {
    name: 'gmicloud',
    display_name: 'GMI Cloud',
    api_compatibility: 'openai',
    base_url: 'https://api.gmi-serving.com/v1/',
    auth: {
      header: 'Authorization',
      scheme: 'Bearer',
      env_vars: ['OPENAI_API_KEY'],
      platform_secret_ref: 'platform.gmicloud.api_key',
    },
    harnesses: {
      primary: 'code',
      all: ['code'],
      env_map: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    },
    normalization: {
      strip_patterns: [/-\d{4}-\d{2}-\d{2}$/, /-\d{8}$/],
    },
    discovery: {
      models_path: '/v1/models',
      has_pricing: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Indexes (built once at import time)
// ---------------------------------------------------------------------------

const byName = new Map<string, ProviderDefinition>(
  PROVIDER_REGISTRY.map((p) => [p.name, p]),
);

const byHarness = new Map<string, ProviderDefinition>();
for (const provider of PROVIDER_REGISTRY) {
  for (const h of provider.harnesses.all) {
    // First provider wins — anthropic claims 'mclaude'/'claude' before anyone else
    if (!byHarness.has(h)) {
      byHarness.set(h, provider);
    }
  }
}

const byEnvVar = new Map<string, ProviderDefinition>();
for (const provider of PROVIDER_REGISTRY) {
  for (const ev of provider.auth.env_vars) {
    if (!byEnvVar.has(ev)) {
      byEnvVar.set(ev, provider);
    }
  }
}

// ---------------------------------------------------------------------------
// Lookup functions
// ---------------------------------------------------------------------------

/** Get a provider definition by canonical name */
export function getProvider(name: string): ProviderDefinition | undefined {
  return byName.get(name.trim().toLowerCase());
}

/** Get the provider that owns a given harness */
export function getProviderForHarness(harness: string): ProviderDefinition | undefined {
  const h = harness.trim().toLowerCase();
  // Direct index lookup first
  const direct = byHarness.get(h);
  if (direct) return direct;

  // Fuzzy match for legacy harness strings (e.g. 'mclaude-variant' still → anthropic)
  for (const provider of PROVIDER_REGISTRY) {
    for (const ph of provider.harnesses.all) {
      if (h.includes(ph)) return provider;
    }
  }
  return undefined;
}

/** Get the provider associated with a given env var */
export function getProviderByEnvVar(envVar: string): ProviderDefinition | undefined {
  return byEnvVar.get(envVar);
}

/** List all registered providers */
export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDER_REGISTRY;
}

/**
 * Infer provider name from a harness string.
 * Drop-in replacement for the old inferProviderFromHarness() in receipt assembly.
 */
export function inferProviderName(harness: string | null | undefined): ProviderName | 'unknown' {
  if (!harness) return 'unknown';
  const provider = getProviderForHarness(harness);
  return provider?.name ?? 'unknown';
}

/**
 * Derive HARNESS_ENV_MAP from the provider registry.
 * Returns the same shape as the old HARNESS_ENV_MAP constant for backward compatibility.
 */
export function deriveHarnessEnvMap(): Record<string, { apiKey: string; baseUrl: string }> {
  const map: Record<string, { apiKey: string; baseUrl: string }> = {};
  for (const provider of PROVIDER_REGISTRY) {
    for (const harness of provider.harnesses.all) {
      if (!map[harness]) {
        map[harness] = { ...provider.harnesses.env_map };
      }
    }
  }
  return map;
}
