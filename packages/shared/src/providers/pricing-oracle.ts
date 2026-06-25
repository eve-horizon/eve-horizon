import type { ProviderName } from './types.js';
import { PROVIDER_REGISTRY, getProvider } from './registry.js';
import { normalizeModelName } from '../pricing/model-normalization.js';
import type { TokenRate } from '../pricing/types.js';

/**
 * Raw model entry from OpenRouter's GET /api/v1/models response.
 */
export interface OpenRouterModel {
  id: string;
  name?: string;
  pricing?: {
    prompt?: string;      // per-token USD
    completion?: string;  // per-token USD
    request?: string;
    image?: string;
  };
  context_length?: number;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
}

/**
 * A pricing entry derived from OpenRouter data, matched to our provider taxonomy.
 */
export interface OraclePricingEntry {
  provider: ProviderName | string;
  model: string;
  normalized_model: string;
  source_model_id: string;
  input_per_million_usd: string;
  output_per_million_usd: string;
}

/**
 * Diff between current rate card and oracle-suggested prices.
 */
export interface PricingDiff {
  new_models: OraclePricingEntry[];
  changed_prices: Array<{
    provider: string;
    model: string;
    current: { input: string; output: string };
    proposed: { input: string; output: string };
  }>;
  unchanged: number;
}

const OPENROUTER_PROVIDER_MAP: Record<string, ProviderName> = {
  'anthropic': 'anthropic',
  'openai': 'openai',
  'google': 'google',
  'meta-llama': 'openai',      // served via OpenAI-compatible
  'deepseek': 'openai',
  'mistralai': 'openai',
};

/**
 * Map an OpenRouter model ID (e.g. "anthropic/claude-sonnet-4") to our provider + model.
 */
export function mapOpenRouterModel(orId: string): { provider: ProviderName | string; model: string } | null {
  const slashIdx = orId.indexOf('/');
  if (slashIdx === -1) return null;

  const orProvider = orId.slice(0, slashIdx).toLowerCase();
  const orModel = orId.slice(slashIdx + 1);

  // Direct provider match
  const provider = OPENROUTER_PROVIDER_MAP[orProvider]
    ?? (getProvider(orProvider)?.name)
    ?? null;

  if (!provider) return null;

  return { provider, model: normalizeModelName(provider, orModel) };
}

/**
 * Convert OpenRouter per-token pricing to our per-million-token format.
 */
export function convertOpenRouterPricing(
  promptPerToken: string | undefined,
  completionPerToken: string | undefined,
): { input_per_million_usd: string; output_per_million_usd: string } | null {
  if (!promptPerToken || !completionPerToken) return null;
  const inputFloat = parseFloat(promptPerToken);
  const outputFloat = parseFloat(completionPerToken);
  if (!Number.isFinite(inputFloat) || !Number.isFinite(outputFloat)) return null;
  if (inputFloat === 0 && outputFloat === 0) return null;

  return {
    input_per_million_usd: (inputFloat * 1_000_000).toFixed(2),
    output_per_million_usd: (outputFloat * 1_000_000).toFixed(2),
  };
}

/**
 * Process raw OpenRouter models into oracle pricing entries.
 */
export function processOpenRouterModels(models: OpenRouterModel[]): OraclePricingEntry[] {
  const entries: OraclePricingEntry[] = [];
  const seen = new Set<string>();

  for (const m of models) {
    const mapped = mapOpenRouterModel(m.id);
    if (!mapped) continue;

    const pricing = convertOpenRouterPricing(m.pricing?.prompt, m.pricing?.completion);
    if (!pricing) continue;

    // Deduplicate by provider:normalized_model (first wins)
    const key = `${mapped.provider}:${mapped.model}`;
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({
      provider: mapped.provider,
      model: mapped.model,
      normalized_model: mapped.model,
      source_model_id: m.id,
      ...pricing,
    });
  }

  return entries;
}

/**
 * Compute a diff between current rate card byok prices and oracle-suggested prices.
 */
export function computePricingDiff(
  currentByok: Record<string, Record<string, TokenRate>>,
  oracleEntries: OraclePricingEntry[],
): PricingDiff {
  const newModels: OraclePricingEntry[] = [];
  const changedPrices: PricingDiff['changed_prices'] = [];
  let unchanged = 0;

  for (const entry of oracleEntries) {
    const providerRates = currentByok[entry.provider];
    if (!providerRates) {
      newModels.push(entry);
      continue;
    }

    const currentRate = providerRates[entry.normalized_model];
    if (!currentRate) {
      newModels.push(entry);
      continue;
    }

    if (
      currentRate.input_per_million_usd !== entry.input_per_million_usd ||
      currentRate.output_per_million_usd !== entry.output_per_million_usd
    ) {
      changedPrices.push({
        provider: entry.provider,
        model: entry.normalized_model,
        current: {
          input: currentRate.input_per_million_usd,
          output: currentRate.output_per_million_usd,
        },
        proposed: {
          input: entry.input_per_million_usd,
          output: entry.output_per_million_usd,
        },
      });
    } else {
      unchanged++;
    }
  }

  return { new_models: newModels, changed_prices: changedPrices, unchanged };
}
