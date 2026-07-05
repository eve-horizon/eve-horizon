/**
 * Parse the `EVE_WORKER_URLS` / `EVE_AGENT_RUNTIME_URLS` mapping format:
 * a comma-separated list of `name=url` pairs. Malformed entries are dropped.
 */
export function parseWorkerUrlMapping(value: string): Map<string, string> {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split('=').map((part) => part.trim()))
    .filter((parts) => parts.length === 2 && parts[0] && parts[1]);

  return new Map(entries as Array<[string, string]>);
}
