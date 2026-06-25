import type { ProviderName } from './types.js';

/**
 * A model discovered from a provider's models endpoint.
 */
export interface DiscoveredModel {
  /** Provider's model ID (e.g. "gpt-4o", "claude-sonnet-4-20250514") */
  id: string;
  /** Provider that hosts this model */
  provider: ProviderName | string;
  /** Human-readable name (if available from the API) */
  display_name?: string;
  /** Pricing info (available from Together AI, OpenRouter) */
  pricing?: {
    input_per_million_usd: string;
    output_per_million_usd: string;
  } | null;
}

/**
 * Result of a model discovery call to a provider.
 */
export interface DiscoveryResult {
  /** Provider that was queried */
  provider: ProviderName | string;
  /** Discovered models */
  models: DiscoveredModel[];
  /** When the data was fetched (ISO timestamp) */
  fetched_at: string;
  /** Cache TTL in seconds */
  ttl_seconds: number;
  /** Where the data came from */
  source: 'api' | 'cache' | 'static_fallback';
}
