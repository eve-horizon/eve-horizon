import { execFile } from 'child_process';
import { redactRepoUrl } from '../invoke/git-utils.js';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  JobGit,
  ResolvedGitMetadata,
  GitCreateBranch,
} from '../schemas/git-controls.js';

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; stderr: string };

/**
 * Git authentication configuration.
 * Supports SSH keys, GitHub tokens, or URL-embedded credentials.
 */
export interface GitAuth {
  /** Modified clone URL with embedded credentials (for HTTPS auth) */
  cloneUrl?: string;
  /** Environment variables for git commands (e.g., GIT_SSH_COMMAND for SSH auth) */
  env?: NodeJS.ProcessEnv;
}

/**
 * Git user configuration for commits.
 */
export interface GitUserConfig {
  name: string;
  email: string;
}

/**
 * Configuration for GitWorkspace.
 */
export interface GitWorkspaceConfig {
  /** Repository URL (git@..., https://..., or file://...) */
  repoUrl: string;
  /** Path to the workspace directory */
  workspacePath: string;
  /** Optional git authentication */
  gitAuth?: GitAuth;
  /** Git controls from job configuration */
  gitConfig?: JobGit;
  /** Git user config for commits */
  gitUser?: GitUserConfig;
  /** Default branch from project */
  defaultBranch?: string;
}

/**
 * Error thrown when git operations fail.
 */
export class GitWorkspaceError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly exitCode?: number,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'GitWorkspaceError';
  }
}

/**
 * Helper to extract local file path from file:// URL.
 */
function getLocalRepoPath(repoUrl: string): string | null {
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== 'file:') return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/**
 * GitWorkspace provides git operations for job execution.
 *
 * Features:
 * - Clone/fetch repository with auth support
 * - Checkout branch, tag, or SHA
 * - Create branches with configurable policies
 * - Commit and push changes
 * - Track resolved git metadata for auditing
 *
 * @example
 * ```typescript
 * const workspace = new GitWorkspace({
 *   repoUrl: 'https://github.com/org/repo',
 *   workspacePath: '/tmp/workspace/job-123',
 *   gitAuth: { cloneUrl: 'https://token@github.com/org/repo' },
 *   gitConfig: { branch: 'job/fix-bug', create_branch: 'if_missing' },
 *   gitUser: { name: 'Eve Bot', email: 'eve@example.com' },
 * });
 *
 * await workspace.init();
 * await workspace.checkout('main');
 * await workspace.createBranch('job/fix-bug', 'main', 'if_missing');
 * // ... agent makes changes ...
 * await workspace.commit('Fix: resolve bug in auth flow');
 * await workspace.push('origin');
 *
 * const metadata = workspace.getResolvedMetadata();
 * ```
 */
export class GitWorkspace {
  private readonly repoUrl: string;
  private readonly workspacePath: string;
  private readonly repoPath: string;
  private readonly gitAuth?: GitAuth;
  private readonly gitConfig?: JobGit;
  private readonly gitUser?: GitUserConfig;
  private readonly defaultBranch: string;

  private resolvedRef?: string;
  private resolvedSha?: string;
  private resolvedBranch?: string;
  private refSource?: 'env_release' | 'manifest' | 'project_default' | 'explicit';
  private commits: string[] = [];
  private pushed = false;
  private initialized = false;

  constructor(config: GitWorkspaceConfig) {
    this.repoUrl = config.repoUrl;
    this.workspacePath = config.workspacePath;
    this.repoPath = path.join(config.workspacePath, 'repo');
    this.gitAuth = config.gitAuth;
    this.gitConfig = config.gitConfig;
    this.gitUser = config.gitUser;
    this.defaultBranch = config.defaultBranch ?? 'main';
  }

  /**
   * Execute a git command in the repository.
   *
   * @param args - Git command arguments
   * @param options - Additional options
   * @returns Command output
   */
  async runGit(
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<ExecResult> {
    const cwd = options?.cwd ?? this.repoPath;
    const env = {
      ...process.env,
      ...this.gitAuth?.env,
      ...options?.env,
    };

    try {
      const result = await execFileAsync('git', args, { cwd, env });
      return result as ExecResult;
    } catch (error) {
      const err = error as {
        code?: number;
        stderr?: string;
        message?: string;
      };
      throw new GitWorkspaceError(
        `Git command failed: git ${args.join(' ')}\n${err.stderr || err.message}`,
        args[0],
        err.code,
        err.stderr,
      );
    }
  }

  /**
   * Initialize the workspace by cloning or copying the repository.
   *
   * @param branch - Optional branch to checkout during clone
   */
  async init(branch?: string): Promise<void> {
    await fs.mkdir(this.workspacePath, { recursive: true });

    const localRepoPath = getLocalRepoPath(this.repoUrl);

    if (process.env.EVE_RUNTIME === 'k8s' && localRepoPath) {
      throw new GitWorkspaceError(
        'file:// repo URLs are not supported in k8s runtime',
        'init',
      );
    }

    if (localRepoPath) {
      // Copy local repository
      console.log(
        `Copying local repository from ${localRepoPath} to ${this.repoPath}`,
      );
      const stats = await fs.stat(localRepoPath);
      if (!stats.isDirectory()) {
        throw new GitWorkspaceError(
          'file:// path is not a directory',
          'init',
        );
      }
      await fs.cp(localRepoPath, this.repoPath, { recursive: true });
    } else {
      // Clone remote repository
      const cloneArgs = ['clone', '--depth', '1'];
      const targetBranch = branch ?? this.gitConfig?.ref ?? this.defaultBranch;
      if (targetBranch) {
        cloneArgs.push('--branch', targetBranch);
      }
      const cloneUrl = this.gitAuth?.cloneUrl ?? this.repoUrl;
      cloneArgs.push('--', cloneUrl, this.repoPath);

      console.log(
        `Cloning repository from ${redactRepoUrl(cloneUrl)} to ${this.repoPath}`,
      );

      try {
        await this.runGit(cloneArgs, { cwd: this.workspacePath });
      } catch (error) {
        // If shallow clone with branch fails, try full clone
        if (error instanceof GitWorkspaceError && targetBranch) {
          const errMsg = error.message;
          console.log(
            `Shallow clone with branch '${targetBranch}' failed: ${errMsg}. Retrying with full clone...`,
          );
          const fullCloneArgs = ['clone', '--', cloneUrl, this.repoPath];
          await this.runGit(fullCloneArgs, { cwd: this.workspacePath });
        } else {
          throw error;
        }
      }
    }

    // Configure git user if provided
    if (this.gitUser) {
      await this.runGit(['config', 'user.name', this.gitUser.name]);
      await this.runGit(['config', 'user.email', this.gitUser.email]);
    }

    this.initialized = true;
    console.log(`Repository ready at ${this.repoPath}`);
  }

  /**
   * Checkout a specific ref (branch, tag, or SHA).
   *
   * For remote branches, this performs a fetch-based checkout to ensure
   * the ref is up to date.
   *
   * @param ref - Branch name, tag, or commit SHA
   * @param source - How the ref was resolved (for audit)
   */
  async checkout(
    ref: string,
    source?: 'env_release' | 'manifest' | 'project_default' | 'explicit',
  ): Promise<void> {
    this.ensureInitialized();

    // Fetch to ensure we have the latest refs
    try {
      await this.runGit(['fetch', 'origin', ref]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Fetch of '${ref}' failed (${msg}), trying fetch --all --tags...`);
      try {
        await this.runGit(['fetch', '--all', '--tags']);
      } catch (fetchErr) {
        const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        console.log(`Fetch --all --tags also failed (${fetchMsg}), proceeding to checkout with local refs`);
      }
    }

    // Try to checkout the ref
    try {
      // First try as a local or remote branch
      await this.runGit(['checkout', ref]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Direct checkout of '${ref}' failed (${msg}), trying remote tracking branch...`);
      try {
        await this.runGit(['checkout', '-B', ref, `origin/${ref}`]);
      } catch (trackErr) {
        const trackMsg = trackErr instanceof Error ? trackErr.message : String(trackErr);
        console.log(`Remote tracking checkout of '${ref}' failed (${trackMsg}), trying detached HEAD...`);
        // Final attempt -- let it throw if this also fails
        await this.runGit(['checkout', '--detach', ref]);
      }
    }

    // Resolve the SHA
    const sha = await this.resolveRef('HEAD');

    this.resolvedRef = ref;
    this.resolvedSha = sha;
    this.resolvedBranch = await this.getCurrentBranch();
    this.refSource = source ?? 'explicit';

    console.log(`Checked out ${ref} at ${sha.substring(0, 8)}`);
  }

  /**
   * Create or checkout a branch with configurable policy.
   *
   * @param name - Branch name to create
   * @param baseRef - Base ref to create branch from
   * @param mode - Creation policy: 'never', 'if_missing', or 'always'
   * @param source - How the base ref was resolved (for audit)
   */
  async createBranch(
    name: string,
    baseRef: string,
    mode: GitCreateBranch = 'if_missing',
    source?: 'env_release' | 'manifest' | 'project_default' | 'explicit',
  ): Promise<void> {
    this.ensureInitialized();

    const branchExists = await this.branchExists(name);

    switch (mode) {
      case 'never':
        if (!branchExists) {
          throw new GitWorkspaceError(
            `Branch ${name} does not exist and create_branch=never`,
            'createBranch',
          );
        }
        await this.runGit(['checkout', name]);
        break;

      case 'if_missing':
        if (branchExists) {
          await this.runGit(['checkout', name]);
        } else {
          await this.runGit(['checkout', '-b', name, baseRef]);
        }
        break;

      case 'always':
        // Reset/create branch to baseRef
        if (branchExists) {
          await this.runGit(['checkout', name]);
          await this.runGit(['reset', '--hard', baseRef]);
        } else {
          await this.runGit(['checkout', '-b', name, baseRef]);
        }
        break;
    }

    const sha = await this.resolveRef('HEAD');
    this.resolvedRef = baseRef;
    this.resolvedSha = sha;
    this.resolvedBranch = name;
    this.refSource = source ?? this.refSource ?? 'explicit';

    console.log(`Branch ${name} ready at ${sha.substring(0, 8)} (mode: ${mode}, base: ${baseRef})`);
  }

  /**
   * Stage and commit changes.
   *
   * @param message - Commit message
   * @returns Commit SHA, or undefined if nothing to commit
   */
  async commit(message: string): Promise<string | undefined> {
    this.ensureInitialized();

    // Check if there are changes to commit
    if (!(await this.hasUncommittedChanges())) {
      console.log('No changes to commit');
      return undefined;
    }

    // Stage all changes
    await this.runGit(['add', '-A']);

    // Commit
    await this.runGit(['commit', '-m', message]);

    // Get the commit SHA
    const sha = await this.resolveRef('HEAD');
    this.commits.push(sha);

    console.log(`Committed ${sha.substring(0, 8)}: ${message.split('\n')[0]}`);
    return sha;
  }

  /**
   * Push the current branch to a remote.
   *
   * Uses detectUnpushedCommits() to catch ALL unpushed commits,
   * including those made directly by agents via shell commands
   * (not through workspace.commit()).
   *
   * @param remote - Remote name (default: 'origin')
   */
  async push(remote: string = 'origin'): Promise<void> {
    this.ensureInitialized();

    if (!this.resolvedBranch) {
      throw new GitWorkspaceError(
        'Cannot push: no branch checked out',
        'push',
      );
    }

    // Detect unpushed commits using git (catches both platform and agent commits)
    const unpushed = await this.detectUnpushedCommits(remote);
    if (unpushed.length === 0) {
      console.log('No commits to push');
      return;
    }

    // Capture agent-made commits that weren't tracked through workspace.commit()
    for (const sha of unpushed) {
      if (!this.commits.includes(sha)) {
        this.commits.push(sha);
      }
    }

    // Push with upstream tracking
    await this.runGit(['push', '-u', remote, this.resolvedBranch]);
    this.pushed = true;

    console.log(`Pushed ${unpushed.length} commit(s) to ${remote}/${this.resolvedBranch}`);
  }

  /**
   * Detect commits on the current branch that haven't been pushed to the remote.
   * This catches all commits regardless of whether they were made through
   * workspace.commit() or directly by the agent via shell commands.
   *
   * @param remote - Remote name
   * @returns Array of unpushed commit SHAs (newest first)
   */
  private async detectUnpushedCommits(remote: string): Promise<string[]> {
    try {
      // Compare against remote tracking branch
      const { stdout } = await this.runGit([
        'rev-list', `${remote}/${this.resolvedBranch}..HEAD`,
      ]);
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      // Remote tracking branch doesn't exist (new branch) --
      // use the checkout SHA as baseline to find new commits
      if (this.resolvedSha) {
        try {
          const { stdout } = await this.runGit([
            'rev-list', `${this.resolvedSha}..HEAD`,
          ]);
          return stdout.trim().split('\n').filter(Boolean);
        } catch {
          return [];
        }
      }
      return [];
    }
  }

  /**
   * Resolve a ref to its SHA.
   *
   * @param ref - Branch, tag, or symbolic ref
   * @returns Full commit SHA
   */
  async resolveRef(ref: string): Promise<string> {
    this.ensureInitialized();

    const { stdout } = await this.runGit(['rev-parse', ref]);
    return stdout.trim();
  }

  /**
   * Check if there are uncommitted changes in the working tree.
   *
   * @returns True if there are staged or unstaged changes
   */
  async hasUncommittedChanges(): Promise<boolean> {
    this.ensureInitialized();

    const { stdout } = await this.runGit(['status', '--porcelain']);
    return stdout.trim().length > 0;
  }

  /**
   * Check if a branch exists (locally or remotely).
   *
   * @param name - Branch name
   * @returns True if branch exists
   */
  async branchExists(name: string): Promise<boolean> {
    try {
      // Check local branch
      await this.runGit(['rev-parse', '--verify', `refs/heads/${name}`]);
      return true;
    } catch {
      // Check remote branch
      try {
        await this.runGit(['rev-parse', '--verify', `refs/remotes/origin/${name}`]);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Get the path to the repository.
   */
  getRepoPath(): string {
    return this.repoPath;
  }

  /**
   * Get the path to the workspace.
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Set resolved git metadata externally.
   *
   * Used by Agent Runtime's invoker which resolves refs before checkout
   * and needs to inject metadata from outside the workspace's own
   * checkout/createBranch flow.
   *
   * @param metadata - Resolved ref, SHA, branch, and source
   */
  setResolvedMetadata(metadata: {
    ref: string;
    sha: string;
    branch?: string;
    refSource?: 'env_release' | 'manifest' | 'project_default' | 'explicit';
  }): void {
    this.resolvedRef = metadata.ref;
    this.resolvedSha = metadata.sha;
    this.resolvedBranch = metadata.branch;
    this.refSource = metadata.refSource;
  }

  /**
   * Get resolved git metadata for audit logging.
   *
   * Returns undefined when no ref/SHA has been resolved (i.e., before
   * checkout, createBranch, or setResolvedMetadata has been called).
   *
   * @returns Resolved metadata including ref, SHA, branch, and push status
   */
  getResolvedMetadata(): ResolvedGitMetadata | undefined {
    if (!this.resolvedRef && !this.resolvedSha && this.commits.length === 0 && !this.pushed) {
      return undefined;
    }

    return {
      resolved_ref: this.resolvedRef,
      resolved_sha: this.resolvedSha,
      resolved_branch: this.resolvedBranch,
      ref_source: this.refSource,
      pushed: this.pushed,
      commits: this.commits.length > 0 ? this.commits : undefined,
    };
  }

  /**
   * Reset the working tree to a clean state.
   *
   * @param ref - Optional ref to reset to (default: HEAD)
   */
  async reset(ref: string = 'HEAD'): Promise<void> {
    this.ensureInitialized();

    await this.runGit(['reset', '--hard', ref]);
    await this.runGit(['clean', '-fdx']);

    console.log(`Reset working tree to ${ref}`);
  }

  /**
   * Fetch updates from remote.
   *
   * @param remote - Remote name (default: 'origin')
   * @param prune - Whether to prune deleted remote branches
   */
  async fetch(remote: string = 'origin', prune: boolean = true): Promise<void> {
    this.ensureInitialized();

    const args = ['fetch', remote];
    if (prune) {
      args.push('--prune');
    }

    await this.runGit(args);
    console.log(`Fetched from ${remote}`);
  }

  /**
   * Get the current branch name, or undefined if in detached HEAD state.
   */
  async getCurrentBranch(): Promise<string | undefined> {
    this.ensureInitialized();

    try {
      const { stdout } = await this.runGit(['symbolic-ref', '--short', 'HEAD']);
      return stdout.trim();
    } catch {
      // Detached HEAD state
      return undefined;
    }
  }

  /**
   * Get the diff between two refs.
   *
   * @param baseRef - Base ref for comparison
   * @param headRef - Head ref for comparison (default: HEAD)
   * @returns Diff output
   */
  async getDiff(baseRef: string, headRef: string = 'HEAD'): Promise<string> {
    this.ensureInitialized();

    const { stdout } = await this.runGit(['diff', baseRef, headRef]);
    return stdout;
  }

  /**
   * Get commit log between two refs.
   *
   * @param baseRef - Base ref
   * @param headRef - Head ref (default: HEAD)
   * @param format - Log format (default: oneline)
   * @returns Log output
   */
  async getLog(
    baseRef: string,
    headRef: string = 'HEAD',
    format: string = 'oneline',
  ): Promise<string> {
    this.ensureInitialized();

    const { stdout } = await this.runGit([
      'log',
      `--format=${format}`,
      `${baseRef}..${headRef}`,
    ]);
    return stdout;
  }

  /**
   * Ensure the workspace has been initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new GitWorkspaceError(
        'GitWorkspace not initialized. Call init() first.',
        'ensureInitialized',
      );
    }
  }
}
