/**
 * Build a sanitized process env for agent harness execution.
 *
 * The env is an **allowlist** — only explicitly-listed system vars, job
 * metadata, and adapter-provided vars are included.  Worker-internal secrets
 * like DATABASE_URL, EVE_SECRETS_MASTER_KEY, etc. are excluded.
 */

import * as path from 'path';

export interface HarnessEnvParams {
  /** PATH entries to prepend (e.g. node_modules/.bin dirs) */
  binPaths: string[];
  /** Invocation metadata */
  jobId: string;
  attemptId: string;
  projectId: string;
  repoPath: string;
  /** Parent job ID (if this job is a child in a team dispatch) */
  parentJobId?: string | null;
  /** Eve API URL for CLI access from within the harness (not a secret) */
  eveApiUrl?: string;
  /** Eve environment name for API source resolution defaults (e.g. sandbox/staging) */
  envName?: string;
  /** Resource index path (workspace-local) */
  resourceIndexPath?: string;
  /** Per-job HOME directory (Phase 2 secret isolation) */
  jobUserHome?: string;
  /** Adapter-provided env (harness-specific, e.g. ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR) */
  adapterEnv?: Record<string, string | undefined>;
  /** Current process.env (defaults to process.env if not provided) */
  processEnv?: Record<string, string | undefined>;
}

/**
 * Keys from the host process.env that are forwarded to the harness.
 * This is the allowlist — everything else is excluded.
 */
export const ALLOWED_SYSTEM_ENV_KEYS = [
  'PATH',  // overridden below, but listed for documentation
  'HOME',
  'TERM',
  'LANG',
  'USER',
  'SHELL',
  'TMPDIR',
] as const;

function sanitizeAdapterEnv(
  adapterEnv?: Record<string, string | undefined>,
): Record<string, string> {
  const entries = Object.entries(adapterEnv ?? {}).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Record<string, string>;
}

function mergePathEntries(entries: string[]): string {
  return Array.from(new Set(entries.filter(Boolean))).join(path.delimiter);
}

export function buildSanitizedHarnessEnv(params: HarnessEnvParams): Record<string, string | undefined> {
  const hostEnv = params.processEnv ?? process.env;

  const hostPathEntries =
    typeof hostEnv.PATH === 'string' ? hostEnv.PATH.split(path.delimiter) : [];
  const adapterPathEntries =
    typeof params.adapterEnv?.PATH === 'string'
      ? params.adapterEnv.PATH.split(path.delimiter)
      : [];
  const fallbackPaths = [
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ];

  const pathEnv = mergePathEntries([
    ...params.binPaths,
    ...adapterPathEntries,
    ...hostPathEntries,
    ...fallbackPaths,
  ]);

  const adapterEnv = sanitizeAdapterEnv(params.adapterEnv);
  if ('PATH' in adapterEnv) {
    delete adapterEnv.PATH;
  }

  // Per-job HOME isolates credential files from the host (Phase 2 secret hardening)
  const homeDir = params.jobUserHome ?? hostEnv.HOME;

  return {
    // Minimal system env (allowlisted)
    PATH: pathEnv,
    HOME: homeDir,
    TERM: hostEnv.TERM,
    LANG: hostEnv.LANG,
    USER: hostEnv.USER,
    SHELL: hostEnv.SHELL,
    TMPDIR: hostEnv.TMPDIR,
    // Per-job home marker (agents/tools can detect isolated mode)
    ...(params.jobUserHome ? { EVE_JOB_USER_HOME: params.jobUserHome } : {}),
    // Harness tracking
    CLAUDE_CODE_TEAM_NAME: params.attemptId,
    // Non-secret job metadata
    EVE_JOB_ID: params.jobId,
    EVE_ATTEMPT_ID: params.attemptId,
    EVE_PROJECT_ID: params.projectId,
    EVE_REPO_PATH: params.repoPath,
    // Team coordination (agents derive coord thread key from this)
    ...(params.parentJobId ? { EVE_PARENT_JOB_ID: params.parentJobId } : {}),
    // Eve API URL for CLI access (not a secret — public URL)
    ...(params.eveApiUrl ? { EVE_API_URL: params.eveApiUrl } : {}),
    ...(params.envName ? { EVE_ENV_NAME: params.envName } : {}),
    // Resource index (workspace-local, non-secret)
    ...(params.resourceIndexPath ? { EVE_RESOURCE_INDEX: params.resourceIndexPath } : {}),
    // Adapter-provided env (harness-specific, e.g. ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR)
    ...adapterEnv,
  };
}
