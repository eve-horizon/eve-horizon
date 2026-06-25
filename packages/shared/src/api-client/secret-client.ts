import {
  loadConfig,
  getCorrelationHeaders,
  SecretResolveResponseSchema,
  type SecretResolveItem,
} from '../index.js';

/**
 * Update an existing secret via the internal write-back API.
 * Uses the same EVE_API_URL + EVE_INTERNAL_API_KEY credentials as resolveProjectSecrets.
 * Throws on non-2xx responses; callers should wrap in try/catch.
 * Only updates existing secrets — does not create new ones.
 */
export async function updateSecret(
  scopeType: 'user' | 'org' | 'project',
  scopeId: string,
  key: string,
  value: string,
): Promise<void> {
  const config = loadConfig();
  if (!config.EVE_INTERNAL_API_KEY || !config.EVE_API_URL) {
    throw new Error(`Cannot update secret: EVE_API_URL or EVE_INTERNAL_API_KEY not configured`);
  }

  const url = `${config.EVE_API_URL}/internal/secrets/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}/${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-eve-internal-token': config.EVE_INTERNAL_API_KEY,
      ...getCorrelationHeaders(),
    },
    body: JSON.stringify({ value }),
  });

  if (!response.ok) {
    throw new Error(`Secret update failed [${response.status}] for ${scopeType}/${scopeId}/${key}`);
  }
}

export interface SecretResolutionResult {
  secrets: SecretResolveItem[];
  /** Whether the API was reachable and returned secrets */
  resolved: boolean;
  /** If resolved is false, the reason why */
  error?: string;
}

/**
 * Resolve secrets for a project via the internal API.
 *
 * Unlike the old per-service `resolveSecrets()` which silently returned `[]` on every failure,
 * this function returns structured metadata about whether resolution succeeded. Callers can then
 * decide whether to fail fast (git auth for private repos) or degrade gracefully (optional hints).
 */
export async function resolveProjectSecrets(
  projectId: string,
  options?: { userId?: string },
): Promise<SecretResolutionResult> {
  const config = loadConfig();

  if (!config.EVE_INTERNAL_API_KEY || !config.EVE_API_URL) {
    console.error(`[secrets] Cannot resolve secrets: EVE_API_URL=${config.EVE_API_URL ? 'set' : 'MISSING'}, EVE_INTERNAL_API_KEY=${config.EVE_INTERNAL_API_KEY ? 'set' : 'MISSING'}`);
    return {
      secrets: [],
      resolved: false,
      error: `Worker missing ${!config.EVE_API_URL ? 'EVE_API_URL' : ''}${!config.EVE_API_URL && !config.EVE_INTERNAL_API_KEY ? ' and ' : ''}${!config.EVE_INTERNAL_API_KEY ? 'EVE_INTERNAL_API_KEY' : ''} — cannot reach secrets API`,
    };
  }

  try {
    const url = `${config.EVE_API_URL}/internal/projects/${projectId}/secrets/resolve`;
    console.log(`[secrets] Resolving secrets for project ${projectId} via ${config.EVE_API_URL}`);
    const body: Record<string, string> = { project_id: projectId };
    if (options?.userId) {
      body.user_id = options.userId;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eve-internal-token': config.EVE_INTERNAL_API_KEY,
        ...getCorrelationHeaders(),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return {
        secrets: [],
        resolved: false,
        error: `Secrets API returned ${response.status}: ${response.statusText}`,
      };
    }

    const json = await response.json();
    const parsed = SecretResolveResponseSchema.safeParse(json);
    if (!parsed.success) {
      return {
        secrets: [],
        resolved: false,
        error: `Secrets API returned invalid response: ${parsed.error.message}`,
      };
    }

    const secretKeys = parsed.data.data.map((s) => s.key);
    console.log(`[secrets] Resolved ${parsed.data.data.length} secrets: [${secretKeys.join(', ')}]`);
    return { secrets: parsed.data.data, resolved: true };
  } catch (err) {
    return {
      secrets: [],
      resolved: false,
      error: `Failed to reach secrets API: ${err instanceof Error ? err.message : err}`,
    };
  }
}
