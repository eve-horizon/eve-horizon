/**
 * Codex auth provenance and writeback.
 *
 * Provenance: a redacted `codex_auth_selected` record of which credential an
 * attempt used (source, key name, scope — never the value), written to the
 * attempt log so `eve auth verify --harness codex` and job receipts can show it
 * after the runner pod is gone.
 *
 * Writeback: after harness execution, read back auth.json from the Codex
 * config directory, compare to the original base64, and update the secret if
 * changed. Failures are non-fatal — logged at warn level and swallowed.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { updateSecret } from '../api-client/secret-client.js';
import type { SecretResolveItem } from '../schemas/secret.js';

/** Credential sources in the order the runtime tries them. */
export const CODEX_AUTH_SOURCES = ['api_key', 'auth_json', 'oauth_access_token', 'preexisting'] as const;
export type CodexAuthSource = (typeof CODEX_AUTH_SOURCES)[number];

/** Redacted record of the credential a codex-family attempt selected. Carries no secret values. */
export interface CodexAuthSelection {
  source: CodexAuthSource;
  /** Name of the secret the credential came from; absent for pre-existing auth files. */
  secret_key?: string;
  scope_type?: string;
  scope_id?: string;
}

/**
 * Describe a selection from the secret that backed it. Only the key name and
 * scope are copied; fields the secret does not carry are omitted.
 */
export function selectedCodexAuth(
  source: CodexAuthSource,
  secret?: Pick<SecretResolveItem, 'key'> & Partial<Pick<SecretResolveItem, 'scope_type' | 'scope_id'>> | null,
): CodexAuthSelection {
  const selection: CodexAuthSelection = { source };
  if (!secret) return selection;
  selection.secret_key = secret.key;
  if (secret.scope_type) selection.scope_type = secret.scope_type;
  if (secret.scope_id) selection.scope_id = secret.scope_id;
  return selection;
}

export async function writeBackCodexAuth(
  originalB64: string,
  scopeType: 'user' | 'org' | 'project',
  scopeId: string,
  codexHome?: string,
): Promise<void> {
  try {
    const homeDir = process.env.HOME || os.homedir();
    const authPaths = codexHome
      ? [path.join(codexHome, 'auth.json')]
      : [path.join(homeDir, '.code', 'auth.json'), path.join(homeDir, '.codex', 'auth.json')];

    let freshestContent: string | null = null;
    let freshestExpiry = -1;

    for (const authPath of authPaths) {
      try {
        const content = await fs.readFile(authPath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const tokens = parsed.tokens as Record<string, unknown> | undefined;
        const expiresAt = typeof tokens?.expires_at === 'number' ? tokens.expires_at : 0;
        if (freshestContent === null || expiresAt > freshestExpiry) {
          freshestContent = content;
          freshestExpiry = expiresAt;
        }
      } catch {
        // File missing or invalid — skip
      }
    }

    if (!freshestContent) return;

    const newB64 = Buffer.from(freshestContent, 'utf-8').toString('base64');
    if (newB64 === originalB64) return;

    console.log(`[codex-writeback] Token refreshed — updating secret ${scopeType}/${scopeId}/CODEX_AUTH_JSON_B64`);
    await updateSecret(scopeType, scopeId, 'CODEX_AUTH_JSON_B64', newB64);
  } catch (err) {
    console.warn(`[codex-writeback] Failed to write back Codex auth: ${err instanceof Error ? err.message : String(err)}`);
  }
}
