/**
 * Eve CLI credential provisioning for agent/worker invocations.
 *
 * Extracted from `packages/shared/src/harnesses/invoke-utils.ts` — writes
 * `~/.eve/credentials.json` so agents can invoke the Eve CLI during
 * execution.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { HarnessInvocation } from '../types/harness.js';
import { loadConfig } from '../config/schema.js';
import { mintJobToken } from '../api-client/auth-client.js';
import { AccessBindingScopeSchema, type AccessBindingScope } from '../schemas/auth.js';

// ---------------------------------------------------------------------------
// getInvocationJobToken
// ---------------------------------------------------------------------------

/**
 * Extract a job token from the invocation's `data.__eve_job_token` field.
 * Returns `undefined` when not present.
 */
export function getInvocationJobToken(
  invocation: HarnessInvocation,
): string | undefined {
  const raw = invocation.data?.__eve_job_token;
  if (typeof raw !== 'string') return undefined;
  const token = raw.trim();
  return token.length > 0 ? token : undefined;
}

export function getInvocationJobScope(
  invocation: HarnessInvocation,
): AccessBindingScope | undefined {
  const raw = invocation.data?.__eve_job_scope;
  if (raw === undefined || raw === null) return undefined;
  const parsed = AccessBindingScopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid invocation job scope: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Extract a per-job permission list from the invocation envelope. Returns
 * `undefined` when the orchestrator did not attach one (caller should fall
 * back to its execution-type default).
 */
export function getInvocationJobPermissions(
  invocation: HarnessInvocation,
): string[] | undefined {
  const raw = invocation.data?.__eve_job_permissions;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// resolveInvocationJobToken
// ---------------------------------------------------------------------------

/**
 * Resolve a job token for the invocation.
 *
 * Priority:
 * 1. Explicit token passed by the caller (already trimmed).
 * 2. Token embedded in `invocation.data.__eve_job_token`.
 * 3. Freshly minted token via the Eve API.
 */
export async function resolveInvocationJobToken(
  invocation: HarnessInvocation,
  explicitToken?: string,
  permissions?: string[],
  scope?: AccessBindingScope,
): Promise<string | undefined> {
  const token = explicitToken?.trim() || getInvocationJobToken(invocation);
  if (token) return token;

  const tokenScope = scope ?? getInvocationJobScope(invocation);
  const tokenPermissions = permissions ?? getInvocationJobPermissions(invocation);
  const minted = await mintJobToken(invocation.jobId, {
    permissions: tokenPermissions,
    scope: tokenScope,
  });
  return minted?.access_token;
}

// ---------------------------------------------------------------------------
// writeEveCredentials
// ---------------------------------------------------------------------------

/**
 * Write `~/.eve/credentials.json` so agents can invoke the Eve CLI during
 * execution.  Returns the resolved job token (or `undefined` if credentials
 * could not be written).
 *
 * The credentials file mirrors the format produced by `eve auth login` — a
 * `tokens` map keyed by the API URL with trailing slashes stripped (matching
 * the CLI's `toAuthKey()` helper).
 *
 * When `jobUserHome` is provided (Phase 2 secret isolation), credentials are
 * written into the job-scoped home directory instead of the host `$HOME`.
 */
export async function writeEveCredentials(
  invocation: HarnessInvocation,
  invocationToken?: string,
  jobUserHome?: string,
  permissions?: string[],
  scope?: AccessBindingScope,
): Promise<string | undefined> {
  try {
    const config = loadConfig();
    if (!config.EVE_API_URL) return;

    const token = await resolveInvocationJobToken(
      invocation,
      invocationToken,
      permissions,
      scope,
    );
    if (!token) return;

    const tokenType = 'bearer';

    // Auth key matches the CLI's toAuthKey() — URL stripped of trailing slashes
    const authKey = config.EVE_API_URL.trim().replace(/\/+$/, '');

    const credentialsPayload = {
      tokens: {
        [authKey]: {
          access_token: token,
          token_type: tokenType,
          // Keep a compatible fallback TTL in case the mint call returns an
          // unexpected payload shape.
          expires_at: Math.floor(Date.now() / 1000) + (8 * 60 * 60),
        },
      },
    };

    // Use job user home if provided (Phase 2), otherwise fall back to host HOME
    const homeDir = jobUserHome ?? process.env.HOME ?? os.homedir();
    const eveDir = path.join(homeDir, '.eve');
    await fs.mkdir(eveDir, { recursive: true });
    await fs.writeFile(
      path.join(eveDir, 'credentials.json'),
      JSON.stringify(credentialsPayload, null, 2),
    );
    console.log(`[credentials] Wrote Eve CLI credentials for job ${invocation.jobId}${jobUserHome ? ' (isolated home)' : ''}`);
    return token;
  } catch (err) {
    console.warn(`[credentials] Failed to write Eve credentials: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
}
