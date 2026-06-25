/**
 * Shared workspace secret resolution and materialization.
 *
 * Extracted from agent-runtime invoke.service.ts (lines 481-637).
 * Both agent-runtime and worker can call these standalone functions
 * instead of duplicating secret handling in each service.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { SecretResolveItem } from '../schemas/secret.js';
import type { HarnessInvocation } from '../types/harness.js';
import { resolveProjectSecrets } from '../api-client/secret-client.js';
import { buildAuthenticatedHttpsUrl } from '../git/clone-url.js';
import type { LifecycleLogger, GitAuth } from './types.js';
import { sanitizeSecretFilename } from '../harnesses/invoke-utils.js';

/**
 * Resolve all secrets for a project via the Eve API.
 *
 * Emits lifecycle events when a `logLifecycle` callback and `attemptId` are
 * provided. Throws on resolution failure so callers can fail fast.
 */
export async function resolveSecrets(
  projectId: string,
  logLifecycle?: LifecycleLogger,
  userId?: string,
  attemptId?: string,
): Promise<SecretResolveItem[]> {
  const startTime = Date.now();
  if (attemptId && logLifecycle) {
    await logLifecycle(attemptId, 'secrets', 'start', {
      project_id: projectId,
    });
  }

  const result = await resolveProjectSecrets(projectId, { userId });

  if (attemptId && logLifecycle) {
    if (!result.resolved) {
      console.error(`Secret resolution failed for project ${projectId}: ${result.error}`);
      await logLifecycle(
        attemptId,
        'secrets',
        'end',
        { error: result.error ?? 'unknown' },
        { duration_ms: Date.now() - startTime, success: false, error: result.error ?? 'unknown' },
      );
      throw new Error(`Secret resolution failed: ${result.error}`);
    } else {
      await logLifecycle(
        attemptId,
        'secrets',
        'end',
        { project_id: projectId, resolved_count: result.secrets.length },
        { duration_ms: Date.now() - startTime, success: true },
      );
    }
  } else if (!result.resolved) {
    // No attemptId for lifecycle logging, but still fail fast
    console.error(`Secret resolution failed for project ${projectId}: ${result.error}`);
    throw new Error(`Secret resolution failed: ${result.error}`);
  }

  return result.secrets;
}

/**
 * Derive git authentication from resolved secrets and the invocation's
 * repo URL.
 *
 * Returns SSH env overrides for `git@` / `ssh://` URLs, or a rewritten
 * HTTPS clone URL with an embedded GitHub token. Returns `undefined` when
 * no applicable credential is found.
 */
export async function prepareGitAuth(
  invocation: HarnessInvocation,
  secrets: SecretResolveItem[],
): Promise<GitAuth | undefined> {
  const repoUrl = invocation.repoUrl;
  if (!repoUrl) return undefined;

  const sshSecret = secrets.find((secret) => secret.type === 'ssh_key');
  const githubToken =
    secrets.find((secret) => secret.type === 'github_token') ??
    secrets.find((secret) => ['GITHUB_TOKEN', 'GH_TOKEN'].includes(secret.key));

  if (sshSecret && (repoUrl.startsWith('git@') || repoUrl.startsWith('ssh://'))) {
    const workspaceSecretsDir = path.join(invocation.workspacePath, '.eve');
    await fs.mkdir(workspaceSecretsDir, { recursive: true });
    const keyPath = path.join(workspaceSecretsDir, 'git_ssh_key');
    await fs.writeFile(keyPath, sshSecret.value, { mode: 0o600 });
    return {
      env: {
        GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
      },
    };
  }

  if (githubToken && repoUrl.startsWith('http')) {
    const cloneUrl = buildAuthenticatedHttpsUrl(repoUrl, githubToken.value);
    if (cloneUrl !== repoUrl) {
      return { cloneUrl };
    }
  }

  return undefined;
}

/**
 * Write secret values into the environment and (for file-type secrets)
 * onto disk.
 *
 * Plain secrets become environment variables. File/SSH secrets are written
 * to a temp directory outside the workspace so hooks can reference them by
 * path without leaking values into the repo tree.
 *
 * Returns the augmented env and (currently always `null`) secrets file path.
 */
export async function materializeSecrets(
  repoPath: string,
  invocation: HarnessInvocation,
  secrets: SecretResolveItem[],
  orgRootPath: string | null,
): Promise<{ env: NodeJS.ProcessEnv; secretsFilePath: string | null }> {
  const env: NodeJS.ProcessEnv = {
    EVE_JOB_ID: invocation.jobId,
    EVE_ATTEMPT_ID: invocation.attemptId,
    EVE_PROJECT_ID: invocation.projectId,
    EVE_REPO_PATH: repoPath,
  };

  if (invocation.agentId) {
    env.EVE_AGENT_ID = invocation.agentId;
  }
  if (orgRootPath) {
    env.EVE_ORG_ROOT = orgRootPath;
  }

  if (secrets.length === 0) {
    return { env, secretsFilePath: null };
  }

  // File-type secrets are written outside the workspace so hooks can reference
  // them by path. Plain secrets are passed as env vars.
  const secretFilesDir = path.join(os.tmpdir(), 'eve', 'job-secrets', invocation.attemptId || 'unknown-attempt');

  for (const secret of secrets) {
    if (secret.type === 'file' || secret.type === 'ssh_key') {
      await fs.mkdir(secretFilesDir, { recursive: true });
      const fileName = sanitizeSecretFilename(secret.key);
      const filePath = path.join(secretFilesDir, fileName);
      await fs.writeFile(filePath, secret.value, { mode: 0o600 });
      env[secret.key] = filePath;
    } else {
      env[secret.key] = secret.value;
    }
  }

  return { env, secretsFilePath: null };
}

// Matches one ${secret.KEY} placeholder. Zod validation already rejects any
// other ${...} expression before the value lands on the job row, but the
// runtime helpers remain defensive so a malformed payload never reaches the
// harness with a half-expanded value.
const SECRET_PLACEHOLDER = /\$\{secret\.([A-Z_][A-Z0-9_]*)\}/g;
const ANY_PLACEHOLDER = /\$\{[^}]+\}/;

/**
 * Return the deduplicated list of secret keys referenced by any value in
 * `raw` via `${secret.KEY}` placeholders. Keys appear in first-seen order.
 */
export function extractSecretRefs(raw: Record<string, string>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of Object.values(raw)) {
    SECRET_PLACEHOLDER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SECRET_PLACEHOLDER.exec(value)) !== null) {
      const key = match[1];
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  return ordered;
}

/**
 * Interpolate ${secret.KEY} placeholders against already-resolved project
 * secrets. Pure — does not call the API or read disk. Missing keys are
 * returned in `missing` (caller fails fast with `missing_secret_override`).
 *
 * Any ${...} expression that isn't a well-formed ${secret.KEY} is rejected
 * by throwing, since the API-layer validator should have already scrubbed
 * it. Never logs resolved values.
 */
export function interpolateEnvOverrides(
  raw: Record<string, string>,
  resolvedSecrets: SecretResolveItem[],
): { resolved: Record<string, string>; missing: string[] } {
  const secretMap = new Map<string, string>();
  for (const secret of resolvedSecrets) {
    secretMap.set(secret.key, secret.value);
  }

  const resolved: Record<string, string> = {};
  const missingSet = new Set<string>();

  for (const [key, value] of Object.entries(raw)) {
    SECRET_PLACEHOLDER.lastIndex = 0;
    const resolvedValue = value.replace(SECRET_PLACEHOLDER, (_match, ref: string) => {
      const lookup = secretMap.get(ref);
      if (lookup === undefined) {
        missingSet.add(ref);
        return '';
      }
      return lookup;
    });

    if (ANY_PLACEHOLDER.test(resolvedValue)) {
      throw new Error(
        `env_overrides value for ${key} contains an unsupported expression; only \${secret.KEY} is allowed`,
      );
    }

    resolved[key] = resolvedValue;
  }

  return { resolved, missing: Array.from(missingSet) };
}

/**
 * Remove any secret artifacts that may have been written inside the
 * workspace tree (legacy `.eve/secrets.env` and `.eve/secrets/` directory).
 *
 * Called during workspace cleanup so secrets are never left on disk after
 * a job completes.
 */
export async function cleanupWorkspaceSecretArtifacts(repoPath: string): Promise<void> {
  const artifactPaths = [
    path.join(repoPath, '.eve', 'secrets.env'),
    path.join(repoPath, '.eve', 'secrets'),
  ];

  await Promise.all(
    artifactPaths.map((artifactPath) =>
      fs.rm(artifactPath, { recursive: true, force: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }),
    ),
  );
}
