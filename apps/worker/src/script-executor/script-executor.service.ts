import { Injectable, Inject } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Db } from '@eve/db';
import { executionLogQueries, jobQueries, threadMessageQueries } from '@eve/db';
import {
  applyEnvOverrides,
  buildAppApiEnvVars,
  DEFAULT_SCRIPT_JOB_PERMISSIONS,
  deliverProvisioningError,
  ensureToolchains,
  buildAuthenticatedHttpsUrl,
  extractSecretRefs,
  GitWorkspace,
  handleCommitPolicy,
  handlePushPolicy,
  loadConfig,
  mintAppLinkToken,
  mintJobToken,
  resolveProjectSecrets,
  type AccessBindingScope,
  type AppApiCliInfo,
  type AppApiInfo,
  type GitAuth,
  type JobGit,
  type RelayDb,
  type ResolvedGitMetadata,
  type SecretResolveItem,
  type ToolchainCacheEvent,
} from '@eve/shared';
import { runStreamingCommand } from '../execution/streaming-command.js';

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; stderr: string };

function isMissingSecretOverrideError(
  error: unknown,
): error is Error & { code: 'missing_secret_override'; missing: string[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'missing_secret_override' &&
    Array.isArray((error as { missing?: unknown }).missing)
  );
}

async function runGit(args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<ExecResult> {
  return (await execFileAsync('git', args, {
    env: options?.env,
    cwd: options?.cwd,
  })) as ExecResult;
}

function getLocalRepoPath(repoUrl: string): string | null {
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== 'file:') return null;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

function redactRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    return url.toString();
  } catch {
    return repoUrl;
  }
}

interface ScriptExecutionResult {
  success: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  errorCode?: string;
  durationMs: number;
}

type GitRefSource = 'env_release' | 'manifest' | 'project_default' | 'explicit';

type ResolvedAppLinkHint = {
  name?: string;
  alias?: string;
  subscription_id?: string;
  type?: string;
  base_url?: string;
  scopes?: string[];
  producer_project_id?: string;
  producer_env?: string | null;
  cli?: unknown;
};

function getJobToolchains(job: unknown): string[] {
  const hints = (job as { hints?: unknown })?.hints;
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return [];
  const value = (hints as Record<string, unknown>).toolchains;
  return Array.isArray(value) ? value as string[] : [];
}

function formatToolchainEvent(event: ToolchainCacheEvent): string {
  switch (event.type) {
    case 'cache_hit':
      return `Toolchain ${event.toolchain} cache hit`;
    case 'install_wait':
      return `Waiting for toolchain ${event.toolchain} install`;
    case 'install_start':
      return `Installing toolchain ${event.toolchain}`;
    case 'install_done':
      return `Installed toolchain ${event.toolchain}`;
    case 'env_loaded':
      return `Loaded toolchain ${event.toolchain} environment`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class ScriptExecutorService {
  private logs: ReturnType<typeof executionLogQueries>;
  private jobs: ReturnType<typeof jobQueries>;

  constructor(@Inject('DB') private db: Db) {
    this.logs = executionLogQueries(this.db);
    this.jobs = jobQueries(this.db);
  }

  private buildRelayDb(): RelayDb {
    return {
      queryJobHints: async (jobId) => {
        const rows = await this.db<{ hints: Record<string, unknown> | null }[]>`
          SELECT hints FROM jobs WHERE id = ${jobId}
        `;
        return rows[0];
      },
      createThreadMessage: async (msg) => {
        await threadMessageQueries(this.db).create(msg);
      },
    };
  }

  /**
   * Execute a script job by ID
   *
   * Process:
   * 1. Fetch job details from database
   * 2. Validate it's a script execution type
   * 3. Prepare workspace (clone repo)
   * 4. Run the script command with timeout
   * 5. Capture stdout/stderr and write to execution_logs
   * 6. Update attempt status with results
   *
   * @param jobId - Job ID to execute
   * @param attemptId - Attempt ID to track execution
   * @returns Execution result
   */
  async execute(jobId: string, attemptId: string): Promise<ScriptExecutionResult> {
    const startTime = Date.now();
    let workspacePathForCleanup: string | null = null;

    try {
      // 1. Fetch job details
      const job = await this.jobs.findById(jobId);
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      // 2. Validate execution type
      const executionType = (job as unknown as { execution_type?: string }).execution_type;
      if (executionType !== 'script') {
        throw new Error(`Job ${jobId} is not a script job (type: ${executionType})`);
      }

      const scriptCommand = (job as unknown as { script_command?: string }).script_command;
      if (!scriptCommand) {
        throw new Error(`Job ${jobId} has no script_command defined`);
      }

      await this.jobs.markExecutionStarted(attemptId);

      const scriptTimeoutSeconds = (job as unknown as { script_timeout_seconds?: number }).script_timeout_seconds ?? 300;
      const timeoutMs = scriptTimeoutSeconds * 1000;

      const envName = (job as unknown as { env_name?: string }).env_name;

      // Get project info (repo URL, org slug, project slug) for workspace and env resolution
      const [projectRow] = await this.db<{ repo_url: string | null; slug: string; org_slug: string; branch: string | null }[]>`
        SELECT p.repo_url, p.slug, p.branch, o.slug AS org_slug
        FROM projects p
        JOIN orgs o ON o.id = p.org_id
        WHERE p.id = ${job.project_id}
      `;
      if (!projectRow?.repo_url) {
        throw new Error(`Project ${job.project_id} has no repo_url configured`);
      }

      const repoUrl = projectRow.repo_url;
      const envOverrides = ((job as unknown as { env_overrides?: Record<string, string> | null }).env_overrides) ?? null;
      const envOverrideSecretRefs = extractSecretRefs(envOverrides ?? {});
      const resolvedSecrets = await this.resolveSecretsForExecution(
        job.project_id,
        envOverrideSecretRefs.length > 0,
        this.repoMayNeedGitAuth(repoUrl),
      );

      // Resolve the k8s namespace for the target environment
      const envNamespace = await this.resolveEnvNamespace(
        job.project_id, envName, projectRow.org_slug, projectRow.slug,
      );
      const workspacePath = path.join('/tmp', 'eve-script-workspaces', attemptId);
      workspacePathForCleanup = workspacePath;

      await this.appendLog(attemptId, 'status', {
        message: 'Starting script execution',
        timestamp: new Date().toISOString(),
        job_id: jobId,
        attempt_id: attemptId,
      });

      // 3. Prepare workspace (clone repo)
      const gitConfig = ((job as unknown as { git_json?: JobGit | null }).git_json) ?? undefined;
      const gitWorkspaceResult = gitConfig
        ? await this.prepareWorkspaceWithGitControls({
          workspacePath,
          repoUrl,
          attemptId,
          projectId: job.project_id,
          envName,
          gitConfig,
          defaultBranch: projectRow.branch ?? 'main',
          resolvedSecrets,
        })
        : {
          repoPath: await this.prepareWorkspace(workspacePath, repoUrl, attemptId, job.project_id, resolvedSecrets),
          gitWorkspace: undefined,
        };
      const repoPath = gitWorkspaceResult.repoPath;
      const gitWorkspace = gitWorkspaceResult.gitWorkspace;

      // 3b. Mint a job token so the script can call the Eve CLI.
      // Honour per-job overrides persisted by the workflow/pipeline expander
      // (jobs.token_permissions, jobs.token_scope) — fall back to the broad
      // script default when the step did not declare anything.
      const tokenPermissions =
        Array.isArray((job as unknown as { token_permissions?: unknown }).token_permissions) &&
        ((job as unknown as { token_permissions?: string[] }).token_permissions?.length ?? 0) > 0
          ? (job as unknown as { token_permissions: string[] }).token_permissions
          : [...DEFAULT_SCRIPT_JOB_PERMISSIONS];
      const tokenScope =
        ((job as unknown as { token_scope?: AccessBindingScope | null }).token_scope) ?? undefined;

      let jobToken: string | undefined;
      try {
        const tokenResult = await mintJobToken(jobId, {
          permissions: tokenPermissions,
          scope: tokenScope,
        });
        if (tokenResult) {
          jobToken = tokenResult.access_token;
        } else {
          console.warn(`[script-executor] Could not mint job token for ${jobId} — script will run without auth`);
        }
      } catch (err) {
        console.warn(`[script-executor] Token mint failed for ${jobId}:`, err);
      }

      // 3c. Write ~/.eve/credentials.json into a workspace-scoped HOME so the
      // CLI's standard credential resolution path works without env vars.
      const scriptHome = path.join(workspacePath, 'home');
      if (jobToken) {
        try {
          await this.writeScriptCredentials(scriptHome, jobToken);
        } catch (err) {
          console.warn(`[script-executor] Failed to write credentials.json for ${jobId}:`, err);
        }
      }

      const appLinkEnv = await this.buildAppLinkEnvForScript(
        jobId,
        envName ?? null,
        this.getResolvedAppLinks(job),
      );

      await this.appendLog(attemptId, 'status', {
        message: `Running script: ${scriptCommand}`,
        timestamp: new Date().toISOString(),
        timeout_seconds: scriptTimeoutSeconds,
      });

      // 4. Run the script command
      const result = await this.runScript(repoPath, scriptCommand, timeoutMs, {
        jobId,
        projectId: job.project_id,
        runId: (job as unknown as { run_id?: string }).run_id,
        attemptId,
        envName,
        envNamespace,
        jobToken,
        scriptHome,
        toolchains: getJobToolchains(job),
        envOverrides,
        ...(appLinkEnv ? { appLinkEnv } : {}),
        resolvedSecrets,
        parentJobId: job.parent_id ?? null,
        relayMissingSecrets: (missing) =>
          deliverProvisioningError(this.buildRelayDb(), {
            jobId,
            parentJobId: job.parent_id ?? null,
            assignee: null,
            errorCode: 'missing_secret_override',
            message: `env_overrides reference unresolved secret(s): ${missing.join(', ')}`,
          }),
        logToolchainEvent: (event) => this.appendLog(attemptId, 'status', {
          message: formatToolchainEvent(event),
          timestamp: new Date().toISOString(),
          toolchain_event: event.type,
          toolchain: event.toolchain,
          image: event.image,
          root: event.root,
        }),
      });

      if (gitWorkspace && gitConfig) {
        try {
          await handleCommitPolicy(gitWorkspace, gitConfig, jobId, result.success);
          await handlePushPolicy(gitWorkspace, gitConfig, result.success);
        } catch (gitError) {
          const msg = gitError instanceof Error ? gitError.message : String(gitError);
          console.error(`[script-git-policy] ${msg}`);
          result.success = false;
          result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
          result.error = result.error ? `${result.error}; ${msg}` : msg;
        }

        await this.updateAttemptGitMeta(attemptId, gitWorkspace.getResolvedMetadata());
      }

      const durationMs = Date.now() - startTime;

      if (result.success) {
        await this.appendLog(attemptId, 'status', {
          message: 'Script execution completed successfully',
          timestamp: new Date().toISOString(),
          exit_code: result.exitCode,
          duration_ms: durationMs,
        });
      } else {
        await this.appendLog(attemptId, 'error', {
          code: result.errorCode,
          message: result.error || result.stderr || 'Script execution failed',
          timestamp: new Date().toISOString(),
          exit_code: result.exitCode,
          duration_ms: durationMs,
        });
      }

      return {
        ...result,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (isMissingSecretOverrideError(error)) {
        await this.appendLog(attemptId, 'error', {
          code: error.code,
          message: errorMessage,
          missing: error.missing,
          timestamp: new Date().toISOString(),
          duration_ms: durationMs,
        });
      } else {
        await this.appendLog(attemptId, 'error', {
          message: errorMessage,
          timestamp: new Date().toISOString(),
          duration_ms: durationMs,
        });
      }

      return {
        success: false,
        exitCode: 1,
        error: errorMessage,
        durationMs,
      };
    } finally {
      if (workspacePathForCleanup) {
        await this.cleanupWorkspace(workspacePathForCleanup);
      }
    }
  }

  private async updateAttemptGitMeta(
    attemptId: string,
    gitMeta: ResolvedGitMetadata | undefined,
  ): Promise<void> {
    if (!gitMeta) return;
    try {
      await this.db`
        UPDATE job_attempts
        SET git_json = ${this.db.json(gitMeta as never)}::jsonb
        WHERE id = ${attemptId}::uuid
      `;
      console.log(`Updated git_json for script attempt ${attemptId}:`, gitMeta);
    } catch (error) {
      console.error(`Failed to update git_json for script attempt ${attemptId}:`, error);
    }
  }

  private async resolveGitRef(args: {
    projectId: string;
    envName?: string;
    gitConfig: JobGit;
    defaultBranch: string;
  }): Promise<{ ref: string; source: GitRefSource }> {
    const refPolicy = args.gitConfig.ref_policy ?? 'auto';

    if (args.gitConfig.ref) {
      return { ref: args.gitConfig.ref, source: 'explicit' };
    }

    if (refPolicy === 'explicit') {
      throw new Error('git.ref_policy=explicit requires git.ref to be provided');
    }

    if (refPolicy === 'env') {
      if (!args.envName) {
        throw new Error('git.ref_policy=env requires env_name to be set');
      }
      const releaseSha = await this.getEnvironmentReleaseSha(args.projectId, args.envName);
      if (!releaseSha) {
        throw new Error(`No release SHA found for environment: ${args.envName}`);
      }
      return { ref: releaseSha, source: 'env_release' };
    }

    if (refPolicy === 'project_default') {
      return { ref: args.defaultBranch, source: 'project_default' };
    }

    if (args.envName) {
      const releaseSha = await this.getEnvironmentReleaseSha(args.projectId, args.envName);
      if (releaseSha) {
        return { ref: releaseSha, source: 'env_release' };
      }
    }

    const manifestRef = await this.getManifestGitRef(args.projectId);
    if (manifestRef) {
      return { ref: manifestRef, source: 'manifest' };
    }

    return { ref: args.defaultBranch, source: 'project_default' };
  }

  private async getEnvironmentReleaseSha(
    projectId: string,
    envName: string,
  ): Promise<string | null> {
    try {
      const [result] = await this.db<{ sha: string | null }[]>`
        SELECT r.sha
        FROM releases r
        JOIN environments e ON e.id = r.env_id
        WHERE e.project_id = ${projectId}
          AND e.name = ${envName}
          AND r.status = 'deployed'
        ORDER BY r.deployed_at DESC
        LIMIT 1
      `;
      return result?.sha ?? null;
    } catch (error) {
      console.warn(`Failed to get environment release SHA: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async getManifestGitRef(projectId: string): Promise<string | null> {
    try {
      const [result] = await this.db<{ parsed_defaults: Record<string, unknown> | null }[]>`
        SELECT parsed_defaults
        FROM project_manifests
        WHERE project_id = ${projectId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (!result?.parsed_defaults) return null;

      const defaults = result.parsed_defaults as { git?: { ref?: string; branch?: string } };
      return defaults.git?.ref ?? defaults.git?.branch ?? null;
    } catch (error) {
      console.warn(`Failed to get manifest git ref: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async handleBranchCreation(
    workspace: GitWorkspace,
    gitConfig: JobGit,
    baseRef: string,
    refSource: GitRefSource,
  ): Promise<void> {
    if (!gitConfig.branch) return;
    const createPolicy = gitConfig.create_branch ?? 'if_missing';
    await workspace.createBranch(gitConfig.branch, baseRef, createPolicy, refSource);
  }

  private async prepareWorkspaceWithGitControls(args: {
    workspacePath: string;
    repoUrl: string;
    attemptId: string;
    projectId: string;
    envName?: string;
    gitConfig: JobGit;
    defaultBranch: string;
    resolvedSecrets?: SecretResolveItem[];
  }): Promise<{ repoPath: string; gitWorkspace: GitWorkspace }> {
    try {
      const { workspacePath, repoUrl, attemptId, projectId, gitConfig, defaultBranch } = args;
      await this.appendLog(attemptId, 'status', {
        message: `Preparing workspace at ${workspacePath}`,
        timestamp: new Date().toISOString(),
        repo_url: redactRepoUrl(repoUrl),
        has_git_controls: true,
      });

      const { ref: resolvedRef, source: refSource } = await this.resolveGitRef({
        projectId,
        envName: args.envName,
        gitConfig,
        defaultBranch,
      });
      const cloneUrl = await this.injectGitAuth(repoUrl, projectId, args.resolvedSecrets);
      const gitAuth: GitAuth | undefined = cloneUrl !== repoUrl ? { cloneUrl } : undefined;

      const workspace = new GitWorkspace({
        repoUrl,
        workspacePath,
        gitAuth,
        gitConfig,
        gitUser: {
          name: 'Eve Bot',
          email: 'eve@example.com',
        },
        defaultBranch,
      });

      await workspace.init(resolvedRef);
      if (gitConfig.branch) {
        await this.handleBranchCreation(workspace, gitConfig, resolvedRef, refSource);
      } else {
        await workspace.checkout(resolvedRef, refSource);
      }

      await this.appendLog(attemptId, 'status', {
        message: 'Workspace prepared successfully',
        timestamp: new Date().toISOString(),
        repo_path: workspace.getRepoPath(),
        resolved_ref: resolvedRef,
        ref_source: refSource,
        branch: gitConfig.branch ?? defaultBranch,
      });

      return {
        repoPath: workspace.getRepoPath(),
        gitWorkspace: workspace,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to prepare workspace with git controls: ${errMsg}`);

      await this.appendLog(args.attemptId, 'error', {
        message: `Workspace preparation failed: ${errMsg}`,
        timestamp: new Date().toISOString(),
      });

      throw new Error(`Workspace prep failed: ${errMsg}`);
    }
  }

  /**
   * Prepare workspace by cloning the repository
   *
   * @param workspacePath - Path to workspace directory
   * @param repoUrl - Repository URL to clone
   * @param attemptId - Attempt ID for logging
   * @returns Path to cloned repository
   */
  private async prepareWorkspace(
    workspacePath: string,
    repoUrl: string,
    attemptId: string,
    projectId: string,
    resolvedSecrets?: SecretResolveItem[],
  ): Promise<string> {
    try {
      await this.appendLog(attemptId, 'status', {
        message: `Preparing workspace at ${workspacePath}`,
        timestamp: new Date().toISOString(),
        repo_url: redactRepoUrl(repoUrl),
      });

      // Ensure workspace directory exists
      await fs.mkdir(workspacePath, { recursive: true });
      console.log(`Created workspace directory: ${workspacePath}`);

      const repoPath = path.join(workspacePath, 'repo');
      const localRepoPath = getLocalRepoPath(repoUrl);

      if (process.env.EVE_RUNTIME === 'k8s' && localRepoPath) {
        throw new Error('file:// repo URLs are not supported in k8s runtime');
      }

      if (localRepoPath) {
        console.log(`Copying local repository from ${localRepoPath} to ${repoPath}`);
        const stats = await fs.stat(localRepoPath);
        if (!stats.isDirectory()) {
          throw new Error('file:// path is not a directory');
        }
        await fs.cp(localRepoPath, repoPath, { recursive: true });
      } else {
        const cloneUrl = await this.injectGitAuth(repoUrl, projectId, resolvedSecrets);
        const cloneArgs = ['clone', '--depth', '1', '--', cloneUrl, repoPath];
        console.log(`Cloning repository from ${redactRepoUrl(cloneUrl)} to ${repoPath}`);
        try {
          await runGit(cloneArgs);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('Authentication') || errMsg.includes('could not read Username') || errMsg.includes('fatal: repository')) {
            throw new Error(
              `Git clone failed (authentication): ${errMsg}. ` +
              `Check that GITHUB_TOKEN is set for this project via 'eve secrets set'.`
            );
          }
          throw err;
        }
      }

      console.log(`Repository ready at ${repoPath}`);

      await this.appendLog(attemptId, 'status', {
        message: 'Workspace prepared successfully',
        timestamp: new Date().toISOString(),
        repo_path: repoPath,
      });

      return repoPath;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to prepare workspace: ${errMsg}`);

      await this.appendLog(attemptId, 'error', {
        message: `Workspace preparation failed: ${errMsg}`,
        timestamp: new Date().toISOString(),
      });

      throw new Error(`Workspace prep failed: ${errMsg}`);
    }
  }

  /**
   * Run a script command in the workspace
   *
   * @param repoPath - Path to repository
   * @param command - Script command to execute
   * @param timeoutMs - Timeout in milliseconds
   * @param context - Job context for environment variables
   * @returns Execution result
   */
  private async runScript(
    repoPath: string,
    command: string,
    timeoutMs: number,
    context: {
      jobId: string;
      projectId: string;
      runId?: string;
      attemptId: string;
      envName?: string;
      envNamespace?: string | null;
      jobToken?: string;
      scriptHome?: string;
      toolchains?: string[];
      envOverrides?: Record<string, string> | null;
      appLinkEnv?: Record<string, string>;
      resolvedSecrets?: SecretResolveItem[];
      parentJobId?: string | null;
      relayMissingSecrets?: (missing: string[]) => Promise<void>;
      logToolchainEvent?: (event: ToolchainCacheEvent) => Promise<void>;
    },
  ): Promise<Omit<ScriptExecutionResult, 'durationMs'>> {
    try {
      // Prepare environment with job context
      let env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: context.scriptHome ?? process.env.HOME,
        EVE_JOB_ID: context.jobId,
        EVE_PROJECT_ID: context.projectId,
        EVE_ATTEMPT_ID: context.attemptId,
      };

      // API URL so the Eve CLI can reach the API from inside the worker pod
      if (process.env.EVE_API_URL) {
        env.EVE_API_URL = process.env.EVE_API_URL;
      }
      if (process.env.EVE_PUBLIC_API_URL) {
        env.EVE_PUBLIC_API_URL = process.env.EVE_PUBLIC_API_URL;
      }

      // Job token for CLI authentication
      if (context.jobToken) {
        env.EVE_JOB_TOKEN = context.jobToken;
      }

      if (context.runId) {
        env.EVE_RUN_ID = context.runId;
      }

      if (context.envName) {
        env.EVE_ENV_NAME = context.envName;
      }

      if (context.envNamespace) {
        env.EVE_ENV_NAMESPACE = context.envNamespace;
      }

      if (context.toolchains && context.toolchains.length > 0) {
        const provisioned = await ensureToolchains({
          toolchains: context.toolchains,
          baseEnv: env,
          logger: context.logToolchainEvent,
        });
        env = provisioned.env;
      }

      const appLinkKeys = Object.keys(context.appLinkEnv ?? {}).sort();
      if (context.appLinkEnv && appLinkKeys.length > 0) {
        env = {
          ...env,
          ...context.appLinkEnv,
        };
        await this.appendLog(context.attemptId, 'status', {
          message: `Injected app-link env vars: ${appLinkKeys.join(', ')}`,
          timestamp: new Date().toISOString(),
          injected_keys: appLinkKeys,
        });
      }

      const overridesResult = await applyEnvOverrides({
        envOverrides: context.envOverrides,
        resolvedSecrets: context.resolvedSecrets ?? [],
        baseEnv: env,
        onMissingSecrets: context.relayMissingSecrets,
      });
      env = overridesResult.env;
      if (overridesResult.appliedKeys.length > 0) {
        await this.appendLog(context.attemptId, 'status', {
          message: `Applied env_overrides: ${overridesResult.appliedKeys.join(', ')}`,
          timestamp: new Date().toISOString(),
        });
      }
      if (overridesResult.strippedKeys.length > 0) {
        await this.appendLog(context.attemptId, 'warning', {
          message: `Stripped reserved env_overrides: ${overridesResult.strippedKeys.join(', ')}`,
          timestamp: new Date().toISOString(),
          stripped_keys: overridesResult.strippedKeys,
        });
      }

      const result = await runStreamingCommand({
        command,
        cwd: repoPath,
        env,
        attemptId: context.attemptId,
        timeoutMs,
        timeoutCode: 'script_timeout',
        appendLog: (attemptId, type, content) => this.appendLog(attemptId, type, content),
      });

      return {
        success: result.success,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
        errorCode: result.timedOut ? 'script_timeout' : undefined,
      };
    } catch (error) {
      if (isMissingSecretOverrideError(error)) {
        throw error;
      }

      const err = error as { stdout?: string; stderr?: string; code?: number; message?: string; killed?: boolean };

      // Check if timeout
      if (err.killed) {
        return {
          success: false,
          exitCode: 124, // Standard timeout exit code
          stdout: err.stdout,
          stderr: err.stderr,
          error: `Script execution timed out after ${timeoutMs / 1000}s`,
        };
      }

      return {
        success: false,
        exitCode: err.code ?? 1,
        stdout: err.stdout,
        stderr: err.stderr,
        error: err.message || 'Script execution failed',
      };
    }
  }

  private getResolvedAppLinks(job: unknown): ResolvedAppLinkHint[] {
    const hints = (job as { hints?: unknown })?.hints;
    if (!isRecord(hints)) return [];
    const links = hints.resolved_app_links;
    if (!Array.isArray(links)) return [];

    return links.filter(isRecord).map((link) => {
      const scopes = Array.isArray(link.scopes)
        ? link.scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
        : undefined;
      const normalized: ResolvedAppLinkHint = {
        producer_env: typeof link.producer_env === 'string' ? link.producer_env : null,
        cli: link.cli,
      };
      if (typeof link.name === 'string') normalized.name = link.name;
      if (typeof link.alias === 'string') normalized.alias = link.alias;
      if (typeof link.subscription_id === 'string') normalized.subscription_id = link.subscription_id;
      if (typeof link.type === 'string') normalized.type = link.type;
      if (typeof link.base_url === 'string') normalized.base_url = link.base_url;
      if (scopes?.length) normalized.scopes = scopes;
      if (typeof link.producer_project_id === 'string') normalized.producer_project_id = link.producer_project_id;
      return normalized;
    });
  }

  private normalizeAppLinkCli(value: unknown): AppApiCliInfo | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.name !== 'string' || typeof value.bin !== 'string') return undefined;
    return {
      name: value.name,
      bin: value.bin,
      ...(typeof value.image === 'string' ? { image: value.image } : {}),
    };
  }

  private async buildAppLinkEnvForScript(
    jobId: string,
    envName: string | null,
    resolvedLinks: ResolvedAppLinkHint[],
  ): Promise<Record<string, string> | undefined> {
    if (resolvedLinks.length === 0) return undefined;

    const appLinkApis: AppApiInfo[] = [];
    for (const link of resolvedLinks) {
      const alias = link.alias && link.alias.length > 0
        ? link.alias
        : link.name && link.name.length > 0
          ? link.name
          : 'unknown';
      const subscriptionId = link.subscription_id;
      if (!subscriptionId) {
        throw new Error(`Cannot mint app-link token for "${alias}" because subscription_id is missing`);
      }
      if (!link.base_url) {
        throw new Error(`Resolved app link "${alias}" (subscription ${subscriptionId}) is missing base_url`);
      }

      const token = await mintAppLinkToken({
        subscriptionId,
        consumerPrincipal: `job:${jobId}`,
        consumerEnv: envName ?? null,
        producerEnv: link.producer_env ?? null,
        ttlSeconds: 60 * 60,
      });
      if (!token?.access_token) {
        throw new Error(`Failed to mint app-link token for "${alias}" (subscription ${subscriptionId})`);
      }

      const api: AppApiInfo = {
        name: link.name && link.name.length > 0 ? link.name : alias,
        type: link.type ?? 'openapi',
        base_url: link.base_url,
        origin: 'app_link',
        alias,
        subscription_id: subscriptionId,
        token: token.access_token,
      };
      if (link.scopes?.length) {
        api.scopes = link.scopes;
      }
      if (link.producer_project_id) {
        api.producer_project_id = link.producer_project_id;
      }
      if (link.producer_env) {
        api.producer_env = link.producer_env;
      }
      const cli = this.normalizeAppLinkCli(link.cli);
      if (cli) {
        api.cli = cli;
      }
      appLinkApis.push(api);
    }

    return buildAppApiEnvVars(appLinkApis);
  }

  /**
   * Resolve the k8s namespace for a project environment.
   * Uses custom namespace if set, otherwise computes from org/project/env slugs.
   */
  private async resolveEnvNamespace(
    projectId: string,
    envName: string | undefined,
    orgSlug: string,
    projectSlug: string,
  ): Promise<string | null> {
    if (!envName) return null;

    // Check for custom namespace on the environment record
    const [envRow] = await this.db<{ namespace: string | null }[]>`
      SELECT namespace FROM environments
      WHERE project_id = ${projectId} AND name = ${envName}
    `;

    if (envRow?.namespace) {
      return this.toK8sName(envRow.namespace);
    }

    return this.toK8sName(`eve-${orgSlug}-${projectSlug}-${envName}`);
  }

  private toK8sName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .replace(/--+/g, '-');
  }

  /**
   * Write `~/.eve/credentials.json` into a workspace-scoped HOME so the Eve
   * CLI's standard credential resolution works for `eve …` calls inside the
   * script. Mirrors the agent-runtime layout.
   */
  private async writeScriptCredentials(scriptHome: string, jobToken: string): Promise<void> {
    const config = loadConfig();
    if (!config.EVE_API_URL) return;
    const authKey = config.EVE_API_URL.trim().replace(/\/+$/, '');
    const payload = {
      tokens: {
        [authKey]: {
          access_token: jobToken,
          token_type: 'bearer' as const,
          expires_at: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
        },
      },
    };
    const eveDir = path.join(scriptHome, '.eve');
    await fs.mkdir(eveDir, { recursive: true });
    await fs.writeFile(path.join(eveDir, 'credentials.json'), JSON.stringify(payload, null, 2));
  }

  /**
   * Clean up workspace directory
   *
   * @param workspacePath - Path to workspace to clean up
   */
  private async cleanupWorkspace(workspacePath: string): Promise<void> {
    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
      console.log(`Cleaned up workspace: ${workspacePath}`);
    } catch (error) {
      // Best-effort cleanup, don't fail the job
      console.warn(`Failed to cleanup workspace ${workspacePath}:`, error);
    }
  }

  private repoMayNeedGitAuth(repoUrl: string): boolean {
    return repoUrl.startsWith('http');
  }

  private async resolveSecretsForExecution(
    projectId: string,
    requiredForEnvOverrides: boolean,
    neededForGitAuth: boolean,
  ): Promise<SecretResolveItem[]> {
    if (!requiredForEnvOverrides && !neededForGitAuth) {
      return [];
    }

    const result = await resolveProjectSecrets(projectId);
    if (!result.resolved) {
      if (requiredForEnvOverrides) {
        throw new Error(`Secret resolution failed for env_overrides: ${result.error ?? 'unknown error'}`);
      }
      console.error(
        `Cannot resolve secrets for git auth: ${result.error}. ` +
        `Clone will proceed without authentication.`,
      );
      return [];
    }

    return result.secrets;
  }

  /**
   * Resolve GITHUB_TOKEN and embed it into an HTTPS clone URL for private repos.
   */
  private async injectGitAuth(
    repoUrl: string,
    projectId: string,
    resolvedSecrets?: SecretResolveItem[],
  ): Promise<string> {
    if (!repoUrl.startsWith('http')) return repoUrl;
    try {
      const secrets = resolvedSecrets ?? (await this.resolveSecretsForExecution(projectId, false, true));

      const token =
        secrets.find((s) => s.type === 'github_token') ??
        secrets.find((s) => ['GITHUB_TOKEN', 'GH_TOKEN'].includes(s.key));

      if (!token) {
        try {
          const url = new URL(repoUrl);
          if (url.hostname.includes('github.com')) {
            console.warn(
              `No GITHUB_TOKEN found for project ${projectId}. ` +
              `If ${repoUrl} is private, clone will fail. ` +
              `Set GITHUB_TOKEN via: eve secrets set GITHUB_TOKEN <value> --project <id>`
            );
          }
        } catch { /* invalid URL */ }
        return repoUrl;
      }

      return buildAuthenticatedHttpsUrl(repoUrl, token.value);
    } catch (err) {
      console.warn(`Git auth injection failed: ${err instanceof Error ? err.message : err}`);
    }
    return repoUrl;
  }

  /**
   * Append a log entry to execution logs
   *
   * @param attemptId - Attempt ID
   * @param type - Log type
   * @param content - Log content
   */
  private async appendLog(attemptId: string, type: string, content: Record<string, unknown>): Promise<void> {
    try {
      await this.logs.appendLog(attemptId, type, content);
    } catch (error) {
      console.error(`Failed to append log for attempt ${attemptId}:`, error);
    }
  }
}
