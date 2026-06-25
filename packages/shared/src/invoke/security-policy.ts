/**
 * Security CLAUDE.md writer.
 *
 * Thin I/O helper that calls the existing `buildSecurityClaudeMd` content
 * builder and writes the result to the CLAUDE_CONFIG_DIR used by Claude-family
 * harnesses.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { buildSecurityClaudeMd } from '../harnesses/security-policy.js';

// Re-export content builders for convenience
export { buildSecurityPolicyPreamble, buildSecurityClaudeMd } from '../harnesses/security-policy.js';

/**
 * Write the security CLAUDE.md file to the CLAUDE_CONFIG_DIR.
 * This injects platform security policies into Claude-family harnesses.
 */
export async function writeSecurityClaudeMd(
  repoPath: string,
  claudeConfigDir: string,
): Promise<void> {
  const securityMd = buildSecurityClaudeMd(repoPath);
  const claudeMdPath = path.join(claudeConfigDir, 'CLAUDE.md');
  try {
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(claudeMdPath, securityMd);
  } catch (err) {
    console.warn(`Failed to write security CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`);
  }
}
