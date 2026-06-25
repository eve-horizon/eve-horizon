import type { JobGit, ResolvedGitMetadata } from '../schemas/git-controls.js';

/**
 * Minimal interface for git workspace operations needed by policy functions.
 * This avoids coupling policies to the full GitWorkspace class.
 */
export interface GitPolicyWorkspace {
  hasUncommittedChanges(): Promise<boolean>;
  commit(message: string): Promise<string | undefined>;
  push(remote?: string): Promise<void>;
  getResolvedMetadata(): ResolvedGitMetadata | undefined;
}

/**
 * Execute the commit policy after harness execution.
 *
 * Policies:
 * - `never` / `manual`: no automatic commit
 * - `auto`: commit if there are uncommitted changes
 * - `required`: commit if changes exist; throw if success=true but no changes
 *
 * @returns The commit SHA if a commit was made, undefined otherwise
 */
export async function handleCommitPolicy(
  workspace: GitPolicyWorkspace,
  gitConfig: JobGit,
  jobId: string,
  success: boolean,
): Promise<string | undefined> {
  const policy = gitConfig.commit ?? 'manual';

  if (policy === 'never' || policy === 'manual') return undefined;

  // 'auto' and 'required' both commit when there are changes
  const hasChanges = await workspace.hasUncommittedChanges();
  console.log(`[git-policy] commit=${policy} hasChanges=${hasChanges}`);

  if (hasChanges) {
    const message = formatCommitMessage(gitConfig.commit_message, jobId);
    return workspace.commit(message);
  }

  if (policy === 'required' && success) {
    throw new Error('git.commit=required but no changes to commit');
  }

  return undefined;
}

/**
 * Execute the push policy after harness execution.
 *
 * Policies:
 * - `never`: no push
 * - `on_success`: push only if harness succeeded
 * - `required`: push always; throw if nothing was pushed
 */
export async function handlePushPolicy(
  workspace: GitPolicyWorkspace,
  gitConfig: JobGit,
  success: boolean,
): Promise<void> {
  const policy = gitConfig.push ?? 'never';
  const remote = gitConfig.remote ?? 'origin';

  if (policy === 'never') return;
  if (policy === 'on_success' && !success) return;

  // on_success (with success=true) and required both push
  await workspace.push(remote);

  if (policy === 'required' && !workspace.getResolvedMetadata()?.pushed) {
    throw new Error('git.push=required but no commits were pushed');
  }
}

/**
 * Format a commit message template with job-specific placeholders.
 *
 * Supported placeholders:
 * - `${job_id}` — replaced with the job ID
 * - `${summary}` — replaced with "automated commit"
 */
export function formatCommitMessage(template: string | undefined, jobId: string): string {
  const defaultMessage = `job/${jobId}: automated commit`;
  if (!template) return defaultMessage;

  return template
    .replace(/\$\{job_id\}/g, jobId)
    .replace(/\$\{summary\}/g, 'automated commit');
}
