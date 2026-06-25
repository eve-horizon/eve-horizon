/**
 * Security policy preamble and CLAUDE.md content for agent job prompts.
 *
 * These functions produce text that instructs an LLM to stay within its
 * sandbox — no filesystem snooping, no env-var exfiltration, no credential
 * leakage. The output is pure string; zero runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Progress update guidance (single source of truth)
// ---------------------------------------------------------------------------

const progressUpdateGuidance = [
  'When working on tasks, you can send progress updates to the user by emitting eve-message fenced blocks in your output:',
  '',
  '```eve-message',
  'Currently analyzing the authentication flow...',
  '```',
  '',
  'Use progress updates for:',
  '- Acknowledging receipt of complex requests',
  '- Milestone completions during long-running tasks',
  '- Status changes every few minutes of work',
  '',
  'Do NOT send progress updates for:',
  '- Every minor step (too noisy)',
  '- Internal reasoning or debugging notes',
];

/**
 * Returns standalone guidance text for emitting `eve-message` fenced blocks
 * as progress updates. Can be used independently of the security preamble.
 */
export function buildProgressUpdateGuidance(): string {
  return progressUpdateGuidance.join('\n');
}

// ---------------------------------------------------------------------------
// Shared rules (single source of truth)
// ---------------------------------------------------------------------------

function securityRules(workspacePath: string): string[] {
  return [
    `You MUST only access files within the workspace: ${workspacePath}`,
    'You MUST NOT use bash commands (cat, ls, head, tail, find, etc.) to read files outside the workspace — in particular ~/, ~/.config/, /etc/, and /var/ are off-limits.',
    'You MUST NOT run env, printenv, set, or echo $VAR (or any equivalent) to inspect environment variables.',
    'You MUST NOT include API keys, tokens, passwords, credentials, or secrets in your output under any circumstances.',
    'If a CLI tool requires authentication, it is already pre-configured. Do not search for, read, or reference credential files.',
  ];
}

// ---------------------------------------------------------------------------
// XML preamble (prepended to agent job prompts)
// ---------------------------------------------------------------------------

/**
 * Returns a `<security-policy>` XML block suitable for prepending to an
 * agent job prompt. LLMs that honour system-level XML tags will treat this
 * as a hard constraint.
 */
export function buildSecurityPolicyPreamble(workspacePath: string): string {
  const rules = securityRules(workspacePath);
  const ruleLines = rules.map((r) => `  <rule>${r}</rule>`).join('\n');

  const progressLines = progressUpdateGuidance.map((l) => `  ${l}`).join('\n');

  return [
    '<security-policy>',
    `  <workspace>${workspacePath}</workspace>`,
    ruleLines,
    '</security-policy>',
    '',
    '<progress-updates>',
    progressLines,
    '</progress-updates>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLAUDE.md markdown section (written into CLAUDE_CONFIG_DIR)
// ---------------------------------------------------------------------------

/**
 * Returns a markdown section (with `## Security Policy (System)` heading)
 * suitable for appending to a generated CLAUDE.md inside a CLAUDE_CONFIG_DIR.
 */
export function buildSecurityClaudeMd(workspacePath: string): string {
  const rules = securityRules(workspacePath);
  const bulletLines = rules.map((r) => `- ${r}`).join('\n');

  return [
    '## Security Policy (System)',
    '',
    `Workspace path: \`${workspacePath}\``,
    '',
    bulletLines,
    '',
    '## Progress Updates',
    '',
    progressUpdateGuidance.join('\n'),
  ].join('\n');
}
