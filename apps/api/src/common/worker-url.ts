import { ServiceUnavailableException } from '@nestjs/common';
import { parseWorkerUrlMapping } from '@eve/shared';

/**
 * Resolve the worker base URL for API-initiated worker calls (deploy /
 * teardown requests). Prefers the `default-worker` entry of
 * `EVE_WORKER_URLS`, then the first mapped entry, then `WORKER_URL`.
 * Throws 503 with the given purpose when nothing is configured.
 */
export function resolveWorkerUrl(purpose: string): string {
  const mapping = parseWorkerUrlMapping(process.env.EVE_WORKER_URLS ?? '');
  const defaultUrl = mapping.get('default-worker') ?? mapping.values().next().value;
  if (defaultUrl) {
    return defaultUrl;
  }

  if (process.env.WORKER_URL) {
    return process.env.WORKER_URL;
  }

  throw new ServiceUnavailableException(`WORKER_URL or EVE_WORKER_URLS must be set to ${purpose}`);
}
