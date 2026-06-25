import type { HarnessCanonicalName } from '../harnesses/registry.js';

export type ProviderApiCompatibility = 'openai' | 'anthropic' | 'gemini' | 'zai';

/**
 * Provider names — canonical identifiers used in rate cards, receipts, and routing.
 * Adding a new provider starts here.
 */
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

/**
 * First-class provider definition. Consolidates provider config previously
 * scattered across harness registry, auth checks, env maps, rate cards,
 * model normalization, and receipt assembly.
 */
export interface ProviderDefinition {
  /** Canonical provider name — used as key in rate cards, receipts, routing */
  name: ProviderName;

  /** Human-readable display name */
  display_name: string;

  /** API wire format this provider speaks */
  api_compatibility: ProviderApiCompatibility;

  /** Provider API base URL (registry-controlled — SSRF guard) */
  base_url: string;

  /** Authentication configuration */
  auth: {
    /** HTTP header name for auth (e.g. 'Authorization', 'x-api-key') */
    header: string;
    /** Auth scheme prefix (e.g. 'Bearer') or null for raw key */
    scheme: string | null;
    /** Env var names checked for credentials (priority order) */
    env_vars: string[];
    /** Platform secret ref for managed model access (e.g. 'platform.gmicloud.api_key') */
    platform_secret_ref?: string;
  };

  /** Harness mapping — which CLI tools talk to this provider */
  harnesses: {
    /** Default harness for this provider */
    primary: HarnessCanonicalName;
    /** All harnesses that can talk to this provider */
    all: HarnessCanonicalName[];
    /** Env var mapping for injecting credentials into harness subprocess */
    env_map: { apiKey: string; baseUrl: string };
  };

  /** Model name normalization rules for rate card lookup */
  normalization: {
    /** Regex patterns to strip from model names (e.g. date suffixes) */
    strip_patterns: RegExp[];
  };

  /** Model discovery endpoint config, or null if provider doesn't support it */
  discovery: {
    /** API path for model listing (e.g. '/v1/models') */
    models_path: string;
    /** Whether the response includes pricing data */
    has_pricing: boolean;
  } | null;

  /** Extra headers to include with every request to this provider */
  extra_headers?: Record<string, string>;
}

/**
 * JSON-safe version of ProviderDefinition for API responses.
 * RegExp patterns are serialized as strings.
 */
export interface ProviderDefinitionJson {
  name: ProviderName;
  display_name: string;
  api_compatibility: string;
  base_url: string;
  auth: {
    header: string;
    scheme: string | null;
    env_vars: string[];
    platform_secret_ref?: string;
  };
  harnesses: {
    primary: HarnessCanonicalName;
    all: HarnessCanonicalName[];
    env_map: { apiKey: string; baseUrl: string };
  };
  normalization: {
    strip_patterns: string[];
  };
  discovery: {
    models_path: string;
    has_pricing: boolean;
  } | null;
  extra_headers?: Record<string, string>;
}

/** Convert a ProviderDefinition to its JSON-safe representation */
export function toProviderJson(def: ProviderDefinition): ProviderDefinitionJson {
  return {
    ...def,
    normalization: {
      strip_patterns: def.normalization.strip_patterns.map((r) => r.source),
    },
  };
}
