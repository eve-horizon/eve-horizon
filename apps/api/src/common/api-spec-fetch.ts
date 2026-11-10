import { BadRequestException } from '@nestjs/common';
import { combineK8sName, OutboundUrlError, requestVettedUrl, toK8sName, vetOutboundUrl } from '@eve/shared';

const SPEC_TIMEOUT_MS = 15_000;
export const API_SPEC_MAX_BYTES = 10 * 1024 * 1024;

const CLUSTER_SERVICE_SUFFIX = '.svc.cluster.local';
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * The in-cluster URL of a service the worker deploys: the Kubernetes Service
 * `<env>-<service>` (both through toK8sName, joined like the worker joins
 * them) in `namespace`, on `port`. Built only from sanitised names, so a
 * manifest key can never add userinfo, a path, a port or another host.
 */
export function componentInClusterBaseUrl(params: {
  envName: string;
  serviceName: string;
  namespace: string;
  port?: number;
}): string {
  const resource = combineK8sName(
    toK8sName(params.envName, 'environment'),
    toK8sName(params.serviceName, 'component'),
    'resource',
  );
  if (!DNS_LABEL.test(params.namespace)) {
    throw new Error(`Invalid namespace: ${params.namespace}`);
  }
  const { port } = params;
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw new Error(`Invalid service port: ${port}`);
  }
  return `http://${resource}.${params.namespace}${CLUSTER_SERVICE_SUFFIX}${port ? `:${port}` : ''}`;
}

/**
 * Whether the worker deploys this manifest service into the cluster (the
 * same rule as its filterDeployableServices): not external, no
 * connection_url, not a job or managed database, and a worker only when the
 * environment lists it.
 */
export function isServiceDeployedInCluster(
  serviceName: string,
  service: unknown,
  manifest: unknown,
  envName: string,
): boolean {
  const record = service && typeof service === 'object' ? (service as Record<string, unknown>) : {};
  const rawXeve = record['x-eve'] ?? record.x_eve;
  const xeve = rawXeve && typeof rawXeve === 'object' ? (rawXeve as Record<string, unknown>) : {};
  if (xeve.external || xeve.connection_url) return false;
  if (xeve.role === 'job' || xeve.role === 'managed_db') return false;
  if (xeve.role === 'worker') {
    const environments = (manifest as { environments?: Record<string, unknown> } | null)?.environments;
    const envConfig = environments?.[envName] as { workers?: unknown } | undefined;
    const workers = Array.isArray(envConfig?.workers) ? envConfig.workers : [];
    return workers.some((worker) => {
      if (!worker || typeof worker !== 'object') return false;
      const entry = worker as { service?: unknown; name?: unknown };
      return (entry.service ?? entry.name) === serviceName;
    });
  }
  return true;
}

/**
 * Fetch a component's API spec. The URL may point at:
 *
 * 1. the component's own in-cluster URL: the same scheme, host and port as
 *    `componentBaseUrl`, which must itself be a plain service URL
 *    (`<label>.<namespace>.svc.cluster.local[:port]`, no userinfo, path or
 *    fragment) in the environment's own `namespace`; or
 * 2. a public internet address, checked with `vetOutboundUrl` and connected
 *    to at the address that was checked.
 *
 * Anything else, a spec URL with userinfo or a fragment, a redirect (never
 * followed), a non-2xx status, a timeout or a body over `API_SPEC_MAX_BYTES`
 * is a 400.
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
  if (url.username || url.password) {
    throw notAllowed(specUrl, 'the URL carries credentials');
  }
  if (url.hash) {
    throw notAllowed(specUrl, 'the URL carries a fragment');
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
  if (!componentBaseUrl || !namespace || !DNS_LABEL.test(namespace)) return false;
  let base: URL;
  try {
    base = new URL(componentBaseUrl);
  } catch {
    return false;
  }
  if (
    (base.protocol !== 'http:' && base.protocol !== 'https:')
    || base.username
    || base.password
    || base.hash
    || base.search
    || (base.pathname !== '/' && base.pathname !== '')
  ) {
    return false;
  }
  const host = base.hostname;
  const suffix = `.${namespace}${CLUSTER_SERVICE_SUFFIX}`;
  if (!host.endsWith(suffix) || !DNS_LABEL.test(host.slice(0, -suffix.length))) {
    return false;
  }
  return url.protocol === base.protocol
    && url.hostname === host
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
