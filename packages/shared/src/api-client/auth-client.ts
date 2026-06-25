import {
  loadConfig,
  getCorrelationHeaders,
} from '../index.js';
import { DEFAULT_AGENT_PERMISSIONS } from '../permissions.js';
import type { AccessBindingScope } from '../schemas/auth.js';

export interface JobTokenResult {
  access_token: string;
  token_type: string;
  expires_at: number;
}

/** 8 hours — long enough for extended jobs, well under 24h max. */
const DEFAULT_TTL_SECONDS = 28800;

export interface ServiceTokenResult {
  access_token: string;
  token_type: string;
  expires_at: number;
}

/** 90 days — refreshed on every deploy */
const DEFAULT_SERVICE_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface AppLinkTokenResult {
  access_token: string;
  token_type: string;
  expires_at: number;
}

/** 1 hour for job-surface app-link tokens. Service deploys override to 90d. */
const DEFAULT_APP_LINK_TTL_SECONDS = 60 * 60;

/**
 * Mint a service token via the internal API.
 *
 * The token allows a deployed app service to call the Eve API,
 * scoped to the service's org/project/environment with only the
 * permissions specified (or sensible defaults).
 */
export async function mintServiceToken(
  params: {
    projectId: string;
    orgId: string;
    envName: string;
    serviceName: string;
    permissions?: string[];
    ttlSeconds?: number;
  },
): Promise<ServiceTokenResult | null> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch {
    // Config not available (e.g. unit tests) — silently skip
    return null;
  }

  if (!config.EVE_INTERNAL_API_KEY || !config.EVE_API_URL) {
    console.warn('[auth-client] Missing EVE_INTERNAL_API_KEY or EVE_API_URL — cannot mint service token');
    return null;
  }

  try {
    const url = `${config.EVE_API_URL}/internal/auth/mint-service-token`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eve-internal-token': config.EVE_INTERNAL_API_KEY,
        ...getCorrelationHeaders(),
      },
      body: JSON.stringify({
        project_id: params.projectId,
        org_id: params.orgId,
        env_name: params.envName,
        service_name: params.serviceName,
        permissions: params.permissions,
        ttl_seconds: params.ttlSeconds ?? DEFAULT_SERVICE_TTL_SECONDS,
      }),
    });

    if (!response.ok) {
      console.warn(`[auth-client] mint-service-token returned ${response.status}: ${response.statusText}`);
      return null;
    }

    return await response.json() as ServiceTokenResult;
  } catch (err) {
    console.warn(`[auth-client] Failed to mint service token: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Mint a job token via the internal API.
 *
 * The token allows the agent to call `eve` CLI commands that hit the
 * public API on behalf of the job's actor user, scoped to the job's
 * org/project with only the permissions listed above.
 */
export async function mintJobToken(
  jobId: string,
  options?: {
    permissions?: string[];
    scope?: AccessBindingScope;
    ttlSeconds?: number;
  },
): Promise<JobTokenResult | null> {
  const config = loadConfig();

  if (!config.EVE_INTERNAL_API_KEY || !config.EVE_API_URL) {
    console.warn('[auth-client] Missing EVE_INTERNAL_API_KEY or EVE_API_URL — cannot mint job token');
    return null;
  }

  try {
    const url = `${config.EVE_API_URL}/internal/auth/mint-job-token`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eve-internal-token': config.EVE_INTERNAL_API_KEY,
        ...getCorrelationHeaders(),
      },
      body: JSON.stringify({
        job_id: jobId,
        permissions: options?.permissions ?? DEFAULT_AGENT_PERMISSIONS,
        scope: options?.scope,
        ttl_seconds: options?.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      }),
    });

    if (!response.ok) {
      console.warn(`[auth-client] mint-job-token returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const json = await response.json();
    return json as JobTokenResult;
  } catch (err) {
    console.warn(`[auth-client] Failed to mint job token: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function mintAppLinkToken(
  params: {
    subscriptionId: string;
    consumerPrincipal: string;
    consumerEnv?: string | null;
    producerEnv?: string | null;
    ttlSeconds?: number;
  },
): Promise<AppLinkTokenResult | null> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch {
    return null;
  }

  if (!config.EVE_INTERNAL_API_KEY || !config.EVE_API_URL) {
    console.warn('[auth-client] Missing EVE_INTERNAL_API_KEY or EVE_API_URL — cannot mint app-link token');
    return null;
  }

  try {
    const url = `${config.EVE_API_URL}/internal/auth/mint-app-link-token`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eve-internal-token': config.EVE_INTERNAL_API_KEY,
        ...getCorrelationHeaders(),
      },
      body: JSON.stringify({
        subscription_id: params.subscriptionId,
        consumer_principal: params.consumerPrincipal,
        consumer_env: params.consumerEnv ?? null,
        producer_env: params.producerEnv ?? null,
        ttl_seconds: params.ttlSeconds ?? DEFAULT_APP_LINK_TTL_SECONDS,
      }),
    });

    if (!response.ok) {
      console.warn(`[auth-client] mint-app-link-token returned ${response.status}: ${response.statusText}`);
      return null;
    }

    return await response.json() as AppLinkTokenResult;
  } catch (err) {
    console.warn(`[auth-client] Failed to mint app-link token: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
