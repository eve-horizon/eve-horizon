import { BadRequestException } from '@nestjs/common';
import { OutboundUrlError, requestVettedUrl, vetOutboundUrl } from './outbound-url.js';

const SPEC_TIMEOUT_MS = 15_000;
export const API_SPEC_MAX_BYTES = 10 * 1024 * 1024;

const CLUSTER_SERVICE_SUFFIX = '.svc.cluster.local';

/**
 * Fetch a component's API spec. The URL may point at:
 *
 * 1. the component's own in-cluster URL: the same scheme, host and port as
 *    `componentBaseUrl`, which must be a service in the environment's own
 *    namespace (`namespace`, when known); or
 * 2. a public internet address, checked with `vetOutboundUrl` and connected
 *    to at the address that was checked.
 *
 * Anything else, a redirect (never followed), a non-2xx status, a timeout or
 * a body over `API_SPEC_MAX_BYTES` is a 400.
 */
export async function fetchApiSpec(
  specUrl: string,
  options: {
    componentBaseUrl: string | null;
    namespace?: string | null;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<string> {
  let url: URL;
  try {
    url = new URL(specUrl);
  } catch {
    throw notAllowed(specUrl, 'the URL is not valid');
  }

  let target: { url: URL; address?: string; family?: 4 | 6 };
  if (isOwnComponentUrl(url, options.componentBaseUrl, options.namespace ?? null)) {
    target = { url };
  } else {
    try {
      target = await vetOutboundUrl(specUrl);
    } catch (err) {
      if (err instanceof OutboundUrlError) {
        throw notAllowed(specUrl, err.message);
      }
      throw err;
    }
  }

  let response: { status: number; body: string; truncated: boolean };
  try {
    response = await requestVettedUrl(target, {
      method: options.method ?? 'GET',
      headers: { Accept: 'application/json', ...options.headers },
      body: options.body,
      timeoutMs: SPEC_TIMEOUT_MS,
      maxResponseBytes: API_SPEC_MAX_BYTES,
    });
  } catch (err) {
    throw new BadRequestException(
      `Failed to fetch API spec from ${specUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status >= 300 && response.status < 400) {
    throw new BadRequestException(
      `API spec URL ${specUrl} answered with a redirect (HTTP ${response.status}); redirects are not followed`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new BadRequestException(`Failed to fetch API spec from ${specUrl}: HTTP ${response.status}`);
  }
  if (response.truncated) {
    throw new BadRequestException(
      `API spec from ${specUrl} is larger than ${API_SPEC_MAX_BYTES / (1024 * 1024)} MiB`,
    );
  }
  return response.body;
}

function isOwnComponentUrl(url: URL, componentBaseUrl: string | null, namespace: string | null): boolean {
  if (!componentBaseUrl) return false;
  let base: URL;
  try {
    base = new URL(componentBaseUrl);
  } catch {
    return false;
  }
  const host = base.hostname.toLowerCase();
  const suffix = namespace ? `.${namespace.toLowerCase()}${CLUSTER_SERVICE_SUFFIX}` : CLUSTER_SERVICE_SUFFIX;
  if (!host.endsWith(suffix) || (base.protocol !== 'http:' && base.protocol !== 'https:')) {
    return false;
  }
  return url.protocol === base.protocol
    && url.hostname.toLowerCase() === host
    && effectivePort(url) === effectivePort(base);
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

function notAllowed(specUrl: string, reason: string): BadRequestException {
  return new BadRequestException(
    `API spec URL not allowed (${specUrl}): ${reason}. Use a path on the component's own URL ` +
    '(for example /openapi.json) or a public https URL.',
  );
}
