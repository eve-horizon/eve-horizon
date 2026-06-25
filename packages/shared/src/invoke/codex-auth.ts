/**
 * Codex auth writeback — after harness execution, read back auth.json from the
 * Codex config directory, compare to the original base64, and update the secret
 * if changed.
 *
 * Failures are non-fatal — logged at warn level and swallowed.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { updateSecret } from '../api-client/secret-client.js';

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
