import type { HarnessName } from '../harnesses/registry.js';
import type { HarnessProfileSource, ResourceRef } from '../schemas/job.js';
import type { AttemptId, JobId, ProjectId } from './ids.js';

/**
 * Git controls for job-level ref selection, branch creation, and commit/push behavior.
 * See docs/system/job-git-controls.md for full specification.
 */
export interface JobGitConfig {
  /** Git ref to checkout (branch, tag, or SHA) */
  ref?: string;
  /** Ref resolution policy: auto, env, project_default, or explicit */
  ref_policy?: 'auto' | 'env' | 'project_default' | 'explicit';
  /** Branch to create/checkout (e.g., "job/${job_id}") */
  branch?: string;
  /** Branch creation behavior */
  create_branch?: 'never' | 'if_missing' | 'always';
  /** Commit behavior */
  commit?: 'never' | 'manual' | 'auto' | 'required';
  /** Commit message template */
  commit_message?: string;
  /** Push behavior */
  push?: 'never' | 'on_success' | 'required';
  /** Remote name (defaults to "origin") */
  remote?: string;
}

/**
 * Workspace configuration for job execution.
 * See docs/system/job-git-controls.md for full specification.
 */
export interface JobWorkspaceConfig {
  /** Workspace mode: job (reset each attempt), session (persist), or isolated (new each attempt) */
  mode?: 'job' | 'session' | 'isolated';
  /** Key for session-scoped workspaces (e.g., "session:${session_id}") */
  key?: string;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'x-high';

export type JobHarnessOptions = {
  variant?: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  [key: string]: unknown;
};

export interface HarnessInvocation {
  attemptId: AttemptId;
  agentId?: string | null;
  jobId: JobId;
  parentJobId?: string | null;
  projectId: ProjectId;
  text: string;
  workspacePath: string;
  repoUrl?: string;
  repoBranch?: string;
  skillPacks?: string[] | null;
  data?: Record<string, unknown>;
  harness?: HarnessName;
  variant?: string;
  harness_options?: JobHarnessOptions;
  permission?: 'default' | 'auto_edit' | 'never' | 'yolo';
  resource_refs?: ResourceRef[];
  /** Toolchains to mount via init containers (e.g. ['python', 'media']) */
  toolchains?: string[];
  /** App CLIs declared via manifest x-eve.cli (image-based, injected via init containers) */
  appClis?: Array<{ name: string; image: string }>;

  /** Git controls for ref selection, branch creation, and commit/push behavior */
  git?: JobGitConfig;
  /** Workspace configuration (mode, key) */
  workspace?: JobWorkspaceConfig;

  /**
   * Env overrides with ${secret.KEY} placeholders intact.
   * Resolved in the shared invoke module at spawn time against the already-resolved
   * project secret map. Keys are validated against a reserved list; resolved values
   * merge into adapter env AFTER Eve-reserved env vars so callers cannot shadow them.
   */
  env_overrides?: Record<string, string>;

  /** Profile provenance — recorded on routing log and job_attempts for audit/analytics. */
  harness_profile_source?: HarnessProfileSource;
  /** Stable hash over normalized profile + env override keys (never plaintext). */
  harness_profile_hash?: string;
  /** Profile name when derived from a named profile (for attribution). */
  harness_profile_name?: string | null;
}

export interface HarnessResult {
  attemptId: AttemptId;
  success: boolean;
  exitCode: number;
  error?: string;

  // Result extraction (populated when attempt completes)
  resultText?: string;
  resultJson?: Record<string, unknown>;
  durationMs?: number;
  tokenInput?: number;
  tokenOutput?: number;
}
