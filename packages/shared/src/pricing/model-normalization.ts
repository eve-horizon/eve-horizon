import { getProvider } from '../providers/registry.js';

/**
 * Canonicalize provider model identifiers to a stable key used in rate cards.
 *
 * Uses strip_patterns from the provider registry when available, falling back
 * to the default OpenAI-style date suffix patterns for unknown providers.
 */
export function normalizeModelName(provider: string, model: string): string {
  let m = model.trim();

  // Strip provider prefix if present (pi emits "anthropic/claude-sonnet-4")
  if (m.includes('/')) {
    m = m.split('/').slice(1).join('/');
  }

  const providerDef = getProvider(provider);
  if (providerDef) {
    for (const pattern of providerDef.normalization.strip_patterns) {
      m = m.replace(pattern, '');
    }
    return m;
  }

  // Fallback for unknown providers: common date suffix patterns
  m = m.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  m = m.replace(/-\d{8}$/, '');

  return m;
}
