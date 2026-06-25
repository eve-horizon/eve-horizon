import { z } from 'zod';

// Git ref resolution policy
export const GitRefPolicySchema = z.enum([
  'auto', // Use env release SHA → manifest git_sha → project.branch
  'env', // Require env_name with current release SHA
  'project_default', // Always use project.branch
  'explicit', // Require git.ref to be provided
]);
export type GitRefPolicy = z.infer<typeof GitRefPolicySchema>;

// Branch creation policy
export const GitCreateBranchSchema = z.enum([
  'never', // Fail if branch doesn't exist
  'if_missing', // Create only when missing
  'always', // Reset branch to ref
]);
export type GitCreateBranch = z.infer<typeof GitCreateBranchSchema>;

// Commit policy
export const GitCommitPolicySchema = z.enum([
  'never', // Never auto-commit
  'manual', // Agent decides if/when to commit
  'auto', // Worker auto-commits staged changes at end
  'required', // Fail attempt if no commits produced
]);
export type GitCommitPolicy = z.infer<typeof GitCommitPolicySchema>;

// Push policy
export const GitPushPolicySchema = z.enum([
  'never', // Never push
  'on_success', // Push on successful attempt if commits exist
  'required', // Fail if push cannot be performed
]);
export type GitPushPolicy = z.infer<typeof GitPushPolicySchema>;

// Workspace mode
export const WorkspaceModeSchema = z.enum([
  'job', // Per-job worktree; reset/clean each attempt
  'session', // Persistent worktree for session continuity
  'isolated', // New worktree per attempt; no reuse
]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

/**
 * Job git controls configuration.
 * Controls how a job interacts with git: ref selection, branch creation, commit/push behavior.
 */
export const JobGitSchema = z.object({
  // Target ref (branch, tag, or SHA)
  ref: z.string().optional(),

  // How to resolve ref when not provided
  ref_policy: GitRefPolicySchema.optional().default('auto'),

  // Branch to create/checkout for this job
  branch: z.string().optional(),

  // When to create the branch
  create_branch: GitCreateBranchSchema.optional(),

  // Commit policy
  commit: GitCommitPolicySchema.optional().default('manual'),

  // Commit message template (supports ${job_id}, ${summary} placeholders)
  commit_message: z.string().optional(),

  // Push policy
  push: GitPushPolicySchema.optional().default('never'),

  // Remote to push to
  remote: z.string().optional().default('origin'),
});

export type JobGit = z.infer<typeof JobGitSchema>;

/**
 * Job workspace configuration.
 * Controls workspace reuse and lifecycle.
 */
export const JobWorkspaceSchema = z.object({
  // Workspace mode
  mode: WorkspaceModeSchema.optional().default('job'),

  // Workspace key for session mode (e.g., "session:${session_id}")
  key: z.string().optional(),
});

export type JobWorkspace = z.infer<typeof JobWorkspaceSchema>;

/**
 * Resolved git metadata stored on job attempts for auditability.
 */
export const ResolvedGitMetadataSchema = z.object({
  // Resolved ref (e.g., "refs/heads/main")
  resolved_ref: z.string().optional(),

  // Resolved SHA
  resolved_sha: z.string().optional(),

  // Resolved branch name
  resolved_branch: z.string().optional(),

  // How the ref was resolved
  ref_source: z
    .enum(['env_release', 'manifest', 'project_default', 'explicit'])
    .optional(),

  // Whether changes were pushed
  pushed: z.boolean().optional(),

  // Commit SHAs created during this attempt
  commits: z.array(z.string()).optional(),
});

export type ResolvedGitMetadata = z.infer<typeof ResolvedGitMetadataSchema>;

/**
 * Manifest-level git defaults (x-eve.defaults.git)
 */
export const ManifestGitDefaultsSchema = JobGitSchema.partial();
export type ManifestGitDefaults = z.infer<typeof ManifestGitDefaultsSchema>;

/**
 * Manifest-level workspace defaults (x-eve.defaults.workspace)
 */
export const ManifestWorkspaceDefaultsSchema = JobWorkspaceSchema.partial();
export type ManifestWorkspaceDefaults = z.infer<
  typeof ManifestWorkspaceDefaultsSchema
>;
