import { Injectable, Inject } from '@nestjs/common';
import { spawn, execFile } from 'child_process';
import * as readline from 'readline';
import { promisify } from 'util';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createStorageClient, type ObjectStorageClient } from '@eve/shared';
import {
  type HarnessInvocation,
  type HarnessResult,
  type SecretResolveItem,
  isAuthErrorMessage,
  type LifecycleEvent,
  type LifecyclePhase,
  type LifecycleAction,
  getCorrelationLogFields,
  lifecycleLogType,
  type JobGit,
  type ResolvedGitMetadata,
  buildSecurityPolicyPreamble,
  buildSecurityClaudeMd,
  loadConfig,
  DEFAULT_BILLING_DEFAULTS_V1,
  DEFAULT_RATE_CARD_EFFECTIVE_AT,
  DEFAULT_RATE_CARD_NAME,
  DEFAULT_RATE_CARD_V1,
  DEFAULT_RATE_CARD_VERSION,
  DEFAULT_RESOURCE_CLASS_NAME,
  DEFAULT_RESOURCE_CLASSES_V1,
  calculateBilledCost,
  parseResourceClassesV1,
  resolveResourceClassName,
  getResourceClassSpec,
  parseBillingDefaultsV1,
  resolveBillingConfigV1,
  type RateCardV1,
  parseResourceUri,
  defaultMountPathForUri,
  isValidMountPath,
  handleCommitPolicy,
  handlePushPolicy,
  sanitizeFilename,
  type ChatFile,
  type AttachmentIndex,
  selectClaudeAuth,
  scrubClaudeAuthEnv,
  prepareClaudeRuntimeConfig,
  materializeClaudeCredentials,
  redactAuthDecision,
  readClaudeApiKeySource,
  detectClaudeAuthFailure,
  type ClaudeAuthDecision,
  type ClaudeRuntimeConfig,
  type ClaudeCredentialMaterialization,
} from '@eve/shared';
// Shared invoke module — single source of truth for agent-execution logic
import {
  runGit,
  getLocalRepoPath,
  redactRepoUrl,
  readPositiveInt,
  readMaxCostHint,
  extractResults,
  type ExtractedResult,
  calculateBudgetTokenBreakdown,
  EveMessageRelay,
  deliverProvisioningError,
  writeCoordinationInbox,
  writeThreadContext,
  writeCarryoverContext,
  cleanupWorkspaceSecretArtifacts,
  applyEnvOverrides,
  materializeWorkspaceSkills,
  runAcquireHooks,
  runReleaseHook,
  emitResourceHydrationEvent,
  getInvocationJobToken,
  resolveInvocationJobToken,
  type CoordinationDb,
  type CarryoverContextDb,
  type RelayDb,
  type LifecycleLogger,
  type BudgetState,
} from '@eve/shared';
import {
  type Db,
  executionLogQueries,
  jobQueries,
  orgQueries,
  orgDocumentQueries,
  jobAttachmentQueries,
  eventQueries,
  exchangeRateQueries,
  pricingRateCardQueries,
  projectManifestQueries,
  projectQueries,
  systemSettingsQueries,
  threadMessageQueries,
} from '@eve/db';
import { resolveHarnessAdapter, type HarnessName, type PermissionPolicy, type HarnessHelpers } from '@eve/shared';
import { runInvocationInK8s } from './k8s-runner';
import { buildSanitizedHarnessEnv, buildAppApiEnvVars, mintAppLinkToken } from '@eve/shared';
import { GitWorkspace, buildAuthenticatedHttpsUrl, type GitAuth as GitWorkspaceAuth } from '@eve/shared';
import { resolveProjectSecrets, mintJobToken, updateSecret } from '@eve/shared';
import { extractPrefixedEnv, sanitizeSecretFilename, writeEveCredentials } from '@eve/shared';
import { createJobUserHome, cleanupJobUserHome } from '@eve/shared';
import { materializeScopedOrgFsMount, type OrgFsMountSpec } from '@eve/shared';

const execFileAsync = promisify(execFile);

interface OAuthTokens {
  accessToken: string;
  expiresAt?: number;
}

type ClaudeAuthRuntimeState = {
  runtimeConfig: ClaudeRuntimeConfig;
  materialized: ClaudeCredentialMaterialization;
};

type ServiceProvisioning = {
  env: Record<string, string>;
  cleanup: () => Promise<void>;
};

type GitAuth = {
  cloneUrl?: string;
  env?: NodeJS.ProcessEnv;
};

@Injectable()
export class InvokeService {
  private logs: ReturnType<typeof executionLogQueries>;
  private jobs: ReturnType<typeof jobQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private documents: ReturnType<typeof orgDocumentQueries>;
  private attachments: ReturnType<typeof jobAttachmentQueries>;
  private events: ReturnType<typeof eventQueries>;
  private _storageClient: ObjectStorageClient | null = null;

  constructor(@Inject('DB') private db: Db) {
    this.logs = executionLogQueries(this.db);
    this.jobs = jobQueries(this.db);
    this.orgs = orgQueries(this.db);
    this.projects = projectQueries(this.db);
    this.documents = orgDocumentQueries(this.db);
    this.attachments = jobAttachmentQueries(this.db);
    this.events = eventQueries(this.db);
  }

  private async logClaudeAuthSelected(
    invocation: HarnessInvocation,
    harness: HarnessName,
    decision: ClaudeAuthDecision | null,
    runtime: ClaudeAuthRuntimeState | null,
    scrubbedKeys: string[],
    jobUserHome: string,
    baseUrlSet: boolean,
  ): Promise<void> {
    const redacted = redactAuthDecision(decision);
    const warnings = [
      ...(redacted.warnings ?? []),
      ...(runtime?.materialized.warning ? [runtime.materialized.warning] : []),
    ];
    const payload = {
      event: 'claude_auth_selected',
      harness,
      ...redacted,
      warnings: warnings.length > 0 ? warnings : undefined,
      runtime_config_dir: runtime?.runtimeConfig.configDir ?? null,
      source_config_dir: runtime?.runtimeConfig.sourceConfigDir ?? null,
      credentials_path: runtime?.materialized.written ? runtime.materialized.path : null,
      credentials_materialized: Boolean(runtime?.materialized.written),
      scrubbed_keys: scrubbedKeys,
      home: jobUserHome,
      base_url_set: baseUrlSet,
    };

    await this.logs.appendLog(invocation.attemptId, 'claude_auth_selected', payload);
    await this.logLifecycleEvent(invocation.attemptId, 'secrets', 'log', {
      kind: 'claude_auth_selected',
      ...payload,
    });
  }

  private async emitClaudeAuthFailed(
    invocation: HarnessInvocation,
    decision: ClaudeAuthDecision | null,
    failure: { reason: string; apiKeySource?: string },
    apiKeySource: string | null,
  ): Promise<string> {
    const effectiveApiKeySource = failure.apiKeySource ?? apiKeySource ?? 'unknown';
    const probableCause = this.classifyClaudeAuthFailureCause(decision, effectiveApiKeySource);
    const hint = `Run: eve auth verify --harness claude --project ${invocation.projectId} --json`;
    const message =
      `Claude Code rejected the selected credential (apiKeySource=${effectiveApiKeySource}). ` +
      `${probableCause} ${hint}`;
    const payload = {
      event: 'claude_auth_failed',
      ...redactAuthDecision(decision),
      apiKeySource: effectiveApiKeySource,
      reason: failure.reason,
      probable_cause: probableCause,
      hint,
    };

    await this.logs.appendLog(invocation.attemptId, 'claude_auth_failed', payload);
    await this.logLifecycleEvent(invocation.attemptId, 'secrets', 'log', {
      kind: 'claude_auth_failed',
      ...payload,
    });
    await deliverProvisioningError(this.buildRelayDb(), {
      jobId: invocation.jobId,
      parentJobId: invocation.parentJobId ?? null,
      assignee: invocation.agentId ?? null,
      errorCode: 'claude_auth_failed',
      message,
    });

    return message;
  }

  private classifyClaudeAuthFailureCause(
    decision: ClaudeAuthDecision | null,
    apiKeySource: string,
  ): string {
    if (!decision) {
      return 'No Claude credential was selected; set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY on the project or org.';
    }
    if (apiKeySource === 'none') {
      return 'The selected credential was not honored by Claude Code; check CLAUDE_CONFIG_DIR materialization and env propagation.';
    }
    if (decision.tokenClass === 'setup-token') {
      return 'The selected setup-token is invalid or revoked.';
    }
    if (decision.tokenClass === 'oauth') {
      return 'The selected short-lived OAuth token is expired or invalid.';
    }
    return 'The selected API key was rejected; check key validity and whether a more-specific setup-token should override it.';
  }

  private async resolveClaudeAuthDecision(
    resolvedSecrets: SecretResolveItem[],
    env: Record<string, string | undefined>,
  ): Promise<ClaudeAuthDecision | null> {
    const selected = selectClaudeAuth(resolvedSecrets);
    if (selected) return selected;

    const fallbackSecrets: SecretResolveItem[] = [];
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) {
      fallbackSecrets.push({
        key: 'ANTHROPIC_API_KEY',
        value: apiKey,
        type: 'env_var',
        scope_type: undefined,
      });
    }
    const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (oauthToken) {
      fallbackSecrets.push({
        key: 'CLAUDE_CODE_OAUTH_TOKEN',
        value: oauthToken,
        type: 'env_var',
        scope_type: undefined,
      });
    }
    if (fallbackSecrets.length === 0) {
      const fileTokens = await this.readClaudeCredentialsFile();
      if (fileTokens?.accessToken) {
        fallbackSecrets.push({
          key: 'CLAUDE_CODE_OAUTH_TOKEN',
          value: fileTokens.accessToken,
          type: 'env_var',
          scope_type: undefined,
        });
      }
    }

    return selectClaudeAuth(fallbackSecrets);
  }

  /** Lazy storage client for ingest file downloads (uses same EVE_STORAGE_* config as StorageService) */
  private getStorageClient(): ObjectStorageClient | null {
    if (this._storageClient) return this._storageClient;
    this._storageClient = createStorageClient();
    return this._storageClient;
  }

  private getOrgBucketName(orgSlug: string): string {
    const prefix = process.env.EVE_STORAGE_ORG_BUCKET_PREFIX ?? 'eve-org';
    return `${prefix}-${orgSlug}`;
  }

  // -------------------------------------------------------------------------
  // DB facade builders — construct lightweight adapters that the shared
  // invoke module can use without depending on @eve/db directly.
  // -------------------------------------------------------------------------

  private buildCoordinationDb(): CoordinationDb {
    return {
      queryJobHints: async (jobId) => {
        const rows = await this.db<{ hints: Record<string, unknown> | null }[]>`
          SELECT hints FROM jobs WHERE id = ${jobId}
        `;
        return rows[0];
      },
      listThreadMessages: (threadId, opts) => threadMessageQueries(this.db).listByThread(threadId, opts),
      findJobById: async (jobId) => {
        const row = await this.jobs.findById(jobId);
        return row ?? undefined;
      },
    };
  }

  private buildCarryoverContextDb(): CarryoverContextDb {
    return {
      findJobById: async (jobId) => {
        const row = await this.jobs.findById(jobId);
        return row ?? undefined;
      },
      findProjectById: async (projectId) => {
        const row = await this.projects.findById(projectId);
        return row ?? undefined;
      },
      listOrgDocsByPrefix: (orgId, prefix, limit) =>
        this.documents.listByOrgAndPrefixWithContent(orgId, prefix, limit),
      findOrgDocByPath: async (orgId, docPath) => {
        const row = await this.documents.findByOrgAndPath(orgId, docPath);
        return row ?? undefined;
      },
      findJobAttachment: async (jobId, name) => {
        const row = await this.attachments.findByJobIdAndName(jobId, name);
        return row ?? undefined;
      },
      queryJobHints: async (jobId) => {
        const rows = await this.db<{ hints: Record<string, unknown> | null }[]>`
          SELECT hints FROM jobs WHERE id = ${jobId}
        `;
        return rows[0];
      },
      listThreadMessages: (threadId, opts) => threadMessageQueries(this.db).listByThread(threadId, opts),
    };
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

  private buildLifecycleLogger(): LifecycleLogger {
    return (attemptId, phase, action, meta, opts) =>
      this.logLifecycleEvent(attemptId, phase, action, meta, opts);
  }

  private async getInvocationWithJobToken(invocation: HarnessInvocation): Promise<HarnessInvocation> {
    const token = await resolveInvocationJobToken(invocation);
    if (!token) return invocation;

    return {
      ...invocation,
      data: {
        ...(invocation.data ?? {}),
        __eve_job_token: token,
      },
    };
  }

  private async getInvocationWithAppClis(invocation: HarnessInvocation): Promise<HarnessInvocation> {
    if (!invocation.jobId) return invocation;
    const rows = await this.db<{ hints: Record<string, unknown> | null }[]>`
      SELECT hints FROM jobs WHERE id = ${invocation.jobId}
    `;
    const hints = rows[0]?.hints ?? {};
    const resolvedApis = hints.resolved_app_apis as Array<{ cli?: { name?: string; image?: string } }> | undefined;
    const resolvedLinks = hints.resolved_app_links as Array<{ cli?: { name?: string; image?: string } }> | undefined;
    const appClis = new Map<string, { name: string; image: string }>();
    for (const cli of invocation.appClis ?? []) {
      appClis.set(cli.name, cli);
    }
    for (const item of [...(resolvedApis ?? []), ...(resolvedLinks ?? [])]) {
      if (item.cli?.name && item.cli.image) {
        appClis.set(item.cli.name, { name: item.cli.name, image: item.cli.image });
      }
    }
    return {
      ...invocation,
      appClis: Array.from(appClis.values()),
    };
  }

  private async shouldSkipWorkspaceSkills(invocation: HarnessInvocation): Promise<boolean> {
    const data = (invocation.data ?? {}) as Record<string, unknown>;
    if (data.skip_workspace_skills === true || data.skip_skills === true) {
      return true;
    }

    if (!invocation.jobId) return false;
    const rows = await this.db<{ hints: Record<string, unknown> | null }[]>`
      SELECT hints FROM jobs WHERE id = ${invocation.jobId}
    `;
    const hints = rows[0]?.hints ?? {};
    return hints.skip_workspace_skills === true || hints.skip_skills === true || hints.auth_probe === true;
  }

  /**
   * Log a lifecycle event for observability.
   * Events are stored in execution_logs with type = 'lifecycle_<phase>_<action>'.
   */
  private async logLifecycleEvent(
    attemptId: string,
    phase: LifecyclePhase,
    action: LifecycleAction,
    meta: Record<string, unknown>,
    opts?: { duration_ms?: number; success?: boolean; error?: string; [key: string]: unknown }
  ): Promise<void> {
    const event: LifecycleEvent = {
      ts: new Date().toISOString(),
      phase,
      action,
      ...opts,
      meta: {
        ...meta,
        ...getCorrelationLogFields(),
      },
    };
    try {
      await this.logs.appendLog(attemptId, lifecycleLogType(phase, action), event);
    } catch (err) {
      console.error(`Failed to log lifecycle event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }


  private async provisionServices(
    invocation: HarnessInvocation,
    repoPath: string,
    baseEnv: NodeJS.ProcessEnv,
  ): Promise<ServiceProvisioning> {
    // NOTE: services.yaml functionality has been deprecated.
    // Service provisioning is now handled at the platform level.
    return { env: {}, cleanup: async () => {} };
  }

  /**
   * Update git_json metadata on a job attempt.
   *
   * Stores resolved git metadata (ref, SHA, branch, commits, push status) for auditing.
   *
   * @param attemptId - Attempt UUID
   * @param gitMeta - Resolved git metadata
   */
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
      console.log(`Updated git_json for attempt ${attemptId}:`, gitMeta);
    } catch (error) {
      console.error(`Failed to update git_json for attempt ${attemptId}:`, error);
    }
  }

  /**
   * Resolve git ref based on policy and available context.
   *
   * Resolution order for ref_policy=auto:
   * 1. Environment release SHA (if env_name is set)
   * 2. Manifest git_sha or branch
   * 3. Project default branch
   *
   * @param invocation - Harness invocation
   * @param gitConfig - Job git controls
   * @returns Resolved ref and source
   */
  private async resolveGitRef(
    invocation: HarnessInvocation,
    gitConfig: JobGit,
  ): Promise<{ ref: string; source: 'env_release' | 'manifest' | 'project_default' | 'explicit' }> {
    const refPolicy = gitConfig.ref_policy ?? 'auto';

    // Explicit ref provided
    if (gitConfig.ref) {
      return { ref: gitConfig.ref, source: 'explicit' };
    }

    // ref_policy=explicit requires git.ref
    if (refPolicy === 'explicit') {
      throw new Error('git.ref_policy=explicit requires git.ref to be provided');
    }

    // ref_policy=env requires env_name and release SHA
    if (refPolicy === 'env') {
      const envName = invocation.data?.env_name as string | undefined;
      if (!envName) {
        throw new Error('git.ref_policy=env requires env_name to be set');
      }
      const releaseSha = await this.getEnvironmentReleaseSha(invocation.projectId, envName);
      if (!releaseSha) {
        throw new Error(`No release SHA found for environment: ${envName}`);
      }
      return { ref: releaseSha, source: 'env_release' };
    }

    // ref_policy=project_default always uses project branch
    if (refPolicy === 'project_default') {
      const projectBranch = invocation.repoBranch ?? 'main';
      return { ref: projectBranch, source: 'project_default' };
    }

    // ref_policy=auto: try env_release → manifest → project_default
    const envName = invocation.data?.env_name as string | undefined;
    if (envName) {
      const releaseSha = await this.getEnvironmentReleaseSha(invocation.projectId, envName);
      if (releaseSha) {
        return { ref: releaseSha, source: 'env_release' };
      }
    }

    // Try manifest defaults
    const manifestRef = await this.getManifestGitRef(invocation.projectId);
    if (manifestRef) {
      return { ref: manifestRef, source: 'manifest' };
    }

    // Fall back to project default branch
    const projectBranch = invocation.repoBranch ?? 'main';
    return { ref: projectBranch, source: 'project_default' };
  }

  /**
   * Get the current release SHA for an environment.
   */
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

  /**
   * Get git ref from manifest defaults.
   */
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

  /**
   * Handle branch creation based on policy.
   *
   * @param workspace - GitWorkspace instance
   * @param gitConfig - Job git controls
   * @param baseRef - Base ref to create branch from
   * @param refSource - How the base ref was resolved (for audit)
   */
  private async handleBranchCreation(
    workspace: GitWorkspace,
    gitConfig: JobGit,
    baseRef: string,
    refSource?: 'env_release' | 'manifest' | 'project_default' | 'explicit',
  ): Promise<void> {
    if (!gitConfig.branch) {
      return;
    }

    const createPolicy = gitConfig.create_branch ?? 'if_missing';
    await workspace.createBranch(gitConfig.branch, baseRef, createPolicy, refSource);
  }


  /**
   * Prepares the workspace for job execution using GitWorkspace.
   * Handles git controls: ref resolution, branch creation, and checkout.
   *
   * @param invocation - Harness invocation
   * @param gitAuth - Git authentication
   * @returns Object with repoPath and optional GitWorkspace for git controls
   */
  private async prepareWorkspaceWithGitControls(
    invocation: HarnessInvocation,
    gitAuth?: GitAuth,
  ): Promise<{ repoPath: string; gitWorkspace?: GitWorkspace; hadRepoPath: boolean }> {
    const startTime = Date.now();
    const { workspacePath, repoUrl, repoBranch } = invocation;
    // git controls are passed at top-level of HarnessInvocation, not under data
    const gitConfig = invocation.git as JobGit | undefined;

    await this.logLifecycleEvent(invocation.attemptId, 'workspace', 'start', {
      repo_url: redactRepoUrl(repoUrl ?? ''),
      branch: repoBranch,
      is_local: !!getLocalRepoPath(repoUrl ?? ''),
      has_git_controls: !!gitConfig,
    });

    try {
      if (!repoUrl) {
        throw new Error('repoUrl is required for job execution');
      }

      // Resolve the git ref based on policy
      const { ref: resolvedRef, source: refSource } = gitConfig
        ? await this.resolveGitRef(invocation, gitConfig)
        : { ref: repoBranch ?? 'main', source: 'project_default' as const };

      console.log(`Resolved git ref: ${resolvedRef} (source: ${refSource})`);

      const repoPath = path.join(workspacePath, 'repo');
      const hadRepoPath = await fs
        .stat(repoPath)
        .then((stats) => stats.isDirectory())
        .catch(() => false);

      // Create GitWorkspace with full configuration
      const workspace = new GitWorkspace({
        repoUrl,
        workspacePath,
        gitAuth: gitAuth as GitWorkspaceAuth | undefined,
        gitConfig,
        gitUser: {
          name: 'Eve Bot',
          email: 'eve@example.com',
        },
        defaultBranch: repoBranch ?? 'main',
      });

      // Initialize workspace (clone/copy repository)
      await workspace.init(resolvedRef);

      // If git controls specify a branch, handle branch creation
      if (gitConfig?.branch) {
        await this.handleBranchCreation(workspace, gitConfig, resolvedRef, refSource);
      } else {
        // Just checkout the resolved ref
        await workspace.checkout(resolvedRef, refSource);
      }

      await this.logLifecycleEvent(invocation.attemptId, 'workspace', 'end', {
        repo_url: redactRepoUrl(repoUrl),
        branch: gitConfig?.branch ?? repoBranch,
        resolved_ref: resolvedRef,
        ref_source: refSource,
        reused: hadRepoPath,
      }, { duration_ms: Date.now() - startTime, success: true });

      return {
        repoPath: workspace.getRepoPath(),
        gitWorkspace: workspace,
        hadRepoPath,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to prepare repository: ${errMsg}`);

      await this.logLifecycleEvent(invocation.attemptId, 'workspace', 'end', {
        repo_url: redactRepoUrl(repoUrl ?? ''),
      }, { duration_ms: Date.now() - startTime, success: false, error: errMsg });

      throw new Error(`Repo prep failed: ${errMsg}`);
    }
  }

  /**
   * Prepares the workspace for job execution.
   * - Ensures workspace directory exists
   * - Clones repository (required)
   *
   * If git controls are present (invocation.git), uses GitWorkspace
   * for advanced ref resolution, branch creation, and tracking.
   * Otherwise, uses legacy shallow clone behavior for backwards compatibility.
   */
  private async prepareWorkspace(
    invocation: HarnessInvocation,
    gitAuth?: GitAuth,
  ): Promise<{ repoPath: string; hadRepoPath: boolean }> {
    // Check if job has git controls (passed at top-level of HarnessInvocation)
    const gitConfig = invocation.git as JobGit | undefined;

    if (gitConfig) {
      // Use GitWorkspace for advanced git controls
      const { repoPath, hadRepoPath } = await this.prepareWorkspaceWithGitControls(invocation, gitAuth);
      return { repoPath, hadRepoPath };
    }

    // Legacy shallow clone behavior (backwards compatible)
    const startTime = Date.now();
    const { workspacePath, repoUrl, repoBranch } = invocation;

    await this.logLifecycleEvent(invocation.attemptId, 'workspace', 'start', {
      repo_url: redactRepoUrl(repoUrl ?? ''),
      branch: repoBranch,
      is_local: !!getLocalRepoPath(repoUrl ?? ''),
    });

    try {
      // Ensure workspace directory exists
      await fs.mkdir(workspacePath, { recursive: true });
      console.log(`Created workspace directory: ${workspacePath}`);

      if (!repoUrl) {
        throw new Error('repoUrl is required for job execution');
      }

      const repoPath = path.join(workspacePath, 'repo');
      const hadRepoPath = await fs
        .stat(repoPath)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
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
        const cloneArgs = ['clone', '--depth', '1'];
        if (repoBranch) {
          cloneArgs.push('--branch', repoBranch);
        }
        const cloneUrl = gitAuth?.cloneUrl ?? repoUrl;
        cloneArgs.push('--', cloneUrl, repoPath);
        console.log(`Cloning repository from ${redactRepoUrl(cloneUrl)} to ${repoPath}`);
        await runGit(cloneArgs, { env: gitAuth?.env ? { ...process.env, ...gitAuth.env } : undefined });
      }

      console.log(`Repository ready at ${repoPath}`);

      await this.logLifecycleEvent(invocation.attemptId, 'workspace', 'end', {
        repo_url: redactRepoUrl(repoUrl),
        branch: repoBranch,
        reused: hadRepoPath,
      }, { duration_ms: Date.now() - startTime, success: true });

      return { repoPath, hadRepoPath };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to prepare repository: ${errMsg}`);

      await this.logLifecycleEvent(invocation.attemptId, 'workspace', 'end', {
        repo_url: redactRepoUrl(repoUrl ?? ''),
      }, { duration_ms: Date.now() - startTime, success: false, error: errMsg });

      throw new Error(`Repo prep failed: ${errMsg}`);
    }
  }

  private async resolveSecrets(projectId: string, userId?: string, attemptId?: string): Promise<SecretResolveItem[]> {
    const startTime = Date.now();

    if (attemptId) {
      await this.logLifecycleEvent(attemptId, 'secrets', 'start', {
        project_id: projectId,
        user_id: userId,
      });
    }

    const result = await resolveProjectSecrets(projectId, { userId });

    if (attemptId) {
      if (!result.resolved) {
        console.error(`Secret resolution failed for project ${projectId}: ${result.error}`);
        await this.logLifecycleEvent(attemptId, 'secrets', 'end', {
          project_id: projectId,
        }, { duration_ms: Date.now() - startTime, success: false, error: result.error, resolved_count: 0 });
        throw new Error(`Secret resolution failed: ${result.error}`);
      } else {
        await this.logLifecycleEvent(attemptId, 'secrets', 'end', {
          project_id: projectId,
          resolved_count: result.secrets.length,
        }, { duration_ms: Date.now() - startTime, success: true });
      }
    } else if (!result.resolved) {
      console.error(`Secret resolution failed for project ${projectId}: ${result.error}`);
      throw new Error(`Secret resolution failed: ${result.error}`);
    }

    return result.secrets;
  }

  private async prepareGitAuth(
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
      const keyDir = path.join(os.tmpdir(), 'eve', 'worker-secrets', invocation.attemptId || 'unknown-attempt');
      await fs.mkdir(keyDir, { recursive: true });
      const keyPath = path.join(keyDir, 'git_ssh_key');
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

  private async materializeSecrets(
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
    // them by path.  Plain secrets are passed as env vars.
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

  private async hydrateResources(
    invocation: HarnessInvocation,
    orgId: string,
    repoPath: string,
  ): Promise<{
    indexPath: string | null;
    summary: {
      resolved_count: number;
      missing_optional_count: number;
      failed_required_count: number;
      resources: Array<Record<string, unknown>>;
      resolved_at: string;
    };
  }> {
    const refs = invocation.resource_refs ?? [];
    const resolvedAt = new Date().toISOString();
    const summary = {
      resolved_count: 0,
      missing_optional_count: 0,
      failed_required_count: 0,
      resources: [] as Array<Record<string, unknown>>,
      resolved_at: resolvedAt,
    };

    if (refs.length === 0) {
      return { indexPath: null, summary };
    }

    const resourcesDir = path.join(repoPath, '.eve', 'resources');
    await fs.mkdir(resourcesDir, { recursive: true });

    const usedMountPaths = new Map<string, string>();

    for (const ref of refs) {
      const required = ref.required !== false;
      const parsed = parseResourceUri(ref.uri);
      if (!parsed) {
        summary.resources.push({
          uri: ref.uri,
          label: ref.label,
          required,
          status: 'missing',
          error_code: 'resource_uri_invalid',
        });
        if (required) summary.failed_required_count += 1;
        else summary.missing_optional_count += 1;
        continue;
      }

      const mountPath = ref.mount_path ?? defaultMountPathForUri(parsed);
      if (!isValidMountPath(mountPath)) {
        summary.resources.push({
          uri: ref.uri,
          label: ref.label,
          required,
          status: 'missing',
          error_code: 'resource_uri_invalid',
        });
        if (required) summary.failed_required_count += 1;
        else summary.missing_optional_count += 1;
        continue;
      }

      const existing = usedMountPaths.get(mountPath);
      if (existing) {
        summary.resources.push({
          uri: ref.uri,
          label: ref.label,
          required,
          status: 'missing',
          error_code: 'resource_mount_conflict',
        });
        if (required) summary.failed_required_count += 1;
        else summary.missing_optional_count += 1;
        continue;
      }
      usedMountPaths.set(mountPath, ref.uri);

      const localPath = path.join(resourcesDir, mountPath);
      const indexPath = path.posix.join('.eve', 'resources', mountPath);

      try {
        if (parsed.scheme === 'org_docs') {
          const doc = await this.documents.findByOrgAndPath(orgId, parsed.path);
          if (!doc) {
            throw new Error('resource_not_found');
          }

          let content = doc.content;
          let contentHash = doc.content_hash;
          let version = parsed.version ?? null;

          if (parsed.version) {
            const versionRow = await this.documents.findVersion(doc.id, parsed.version);
            if (!versionRow) {
              throw new Error('resource_not_found');
            }
            content = versionRow.content;
            contentHash = versionRow.content_hash;
            version = versionRow.version;
          } else {
            const latest = await this.documents.getLatestVersionInfo(doc.id);
            version = latest?.version ?? null;
          }

          await fs.mkdir(path.dirname(localPath), { recursive: true });
          await fs.writeFile(localPath, content);

          summary.resources.push({
            uri: ref.uri,
            local_path: indexPath,
            content_hash: `sha256:${contentHash}`,
            version,
            label: ref.label,
            required,
            status: 'resolved',
          });
          summary.resolved_count += 1;
          continue;
        }

        if (parsed.scheme === 'ingest') {
          // Download ingested file from object store
          const storageClient = this.getStorageClient();
          if (!storageClient) throw new Error('resource_storage_unavailable');

          const org = await this.orgs.findById(orgId);
          if (!org) throw new Error('resource_access_denied');

          const bucketName = this.getOrgBucketName(org.slug);
          // Use path.basename to prevent path traversal from malicious file names
          const safeFileName = path.basename(parsed.fileName);
          const storageKey = `ingest/${parsed.ingestId}/${safeFileName}`;

          const result = await storageClient.getObject(bucketName, storageKey);
          const bodyBytes = result.body;
          await fs.mkdir(path.dirname(localPath), { recursive: true });
          await fs.writeFile(localPath, bodyBytes);

          const contentHash = createHash('sha256').update(bodyBytes).digest('hex');

          const resourceEntry: Record<string, unknown> = {
            uri: ref.uri,
            local_path: indexPath,
            content_hash: `sha256:${contentHash}`,
            label: ref.label,
            required,
            status: 'resolved',
          };
          if (ref.mime_type) resourceEntry.mime_type = ref.mime_type;
          if (ref.metadata) resourceEntry.metadata = ref.metadata;
          summary.resources.push(resourceEntry);
          summary.resolved_count += 1;
          continue;
        }

        const job = await this.jobs.findById(parsed.jobId);
        if (!job) {
          throw new Error('resource_not_found');
        }

        const project = await this.projects.findById(job.project_id);
        if (!project || project.org_id !== orgId) {
          throw new Error('resource_access_denied');
        }

        const attachment = await this.attachments.findByJobIdAndName(parsed.jobId, parsed.name);
        if (!attachment) {
          throw new Error('resource_not_found');
        }

        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, attachment.content);

        summary.resources.push({
          uri: ref.uri,
          local_path: indexPath,
          content_hash: `sha256:${attachment.content_hash}`,
          label: ref.label,
          required,
          status: 'resolved',
        });
        summary.resolved_count += 1;
      } catch (err) {
        const errorCode = err instanceof Error ? err.message : 'resource_not_found';
        summary.resources.push({
          uri: ref.uri,
          local_path: indexPath,
          label: ref.label,
          required,
          status: 'missing',
          error_code: errorCode,
        });
        if (required) summary.failed_required_count += 1;
        else summary.missing_optional_count += 1;
      }
    }

    const indexFilePath = path.join(resourcesDir, 'index.json');
    await fs.writeFile(indexFilePath, JSON.stringify({
      resolved_at: resolvedAt,
      resources: summary.resources,
    }, null, 2));

    return { indexPath: '.eve/resources/index.json', summary };
  }

  /**
   * Stage chat file attachments from Eve storage into .eve/attachments/.
   * Files with eve-storage:// URLs are downloaded via the API presigned URL
   * endpoint and written to the workspace. An index.json manifest is created
   * so agents can discover attached files.
   */
  private async stageAttachments(
    workspacePath: string,
    files: ChatFile[],
  ): Promise<void> {
    const eveFiles = files.filter(f => f.url?.startsWith('eve-storage://'));
    if (eveFiles.length === 0) return;

    const attachmentsDir = path.join(workspacePath, '.eve', 'attachments');
    await fs.mkdir(attachmentsDir, { recursive: true });

    const index: AttachmentIndex = { files: [] };
    const usedNames = new Set<string>();

    const apiUrl = process.env.EVE_API_URL;
    const internalToken = process.env.EVE_INTERNAL_API_KEY ?? '';

    if (!apiUrl) {
      console.warn('[attachments] EVE_API_URL not set, skipping attachment staging');
      return;
    }

    for (const file of eveFiles) {
      const key = file.url!.replace('eve-storage://', '');
      const safeName = sanitizeFilename(file.name || file.id || 'attachment');
      let filename = safeName;
      let suffix = 1;
      while (usedNames.has(filename)) {
        const dot = safeName.lastIndexOf('.');
        if (dot > 0) {
          filename = `${safeName.slice(0, dot)}-${suffix}${safeName.slice(dot)}`;
        } else {
          filename = `${safeName}-${suffix}`;
        }
        suffix += 1;
      }
      usedNames.add(filename);

      try {
        // Get presigned download URL from API
        const presignResp = await fetch(`${apiUrl}/internal/storage/chat-attachments/presign`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-eve-internal-token': internalToken,
          },
          body: JSON.stringify({ key, operation: 'download' }),
        });
        if (!presignResp.ok) {
          console.warn(`[attachments] Presign failed for ${key}: ${presignResp.status}`);
          continue;
        }
        const { url: downloadUrl } = await presignResp.json() as { url: string };

        // Download the file
        const response = await fetch(downloadUrl);
        if (!response.ok) {
          console.warn(`[attachments] Download failed for ${key}: ${response.status}`);
          continue;
        }

        const destPath = path.join(attachmentsDir, filename);
        await fs.writeFile(destPath, Buffer.from(await response.arrayBuffer()));

        index.files.push({
          id: file.id,
          name: file.name || file.id || 'attachment',
          path: `.eve/attachments/${filename}`,
          mimetype: file.mimetype,
          size: file.size,
          source_url: file.source_url,
          source_provider: file.source_provider,
          storage_key: file.storage_key,
        });
      } catch (err) {
        console.warn(`[attachments] Failed to stage ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (index.files.length > 0) {
      await fs.writeFile(
        path.join(attachmentsDir, 'index.json'),
        JSON.stringify(index, null, 2),
      );
      console.log(`[attachments] Staged ${index.files.length} file(s) to .eve/attachments/`);
    }
  }

  async execute(invocation: HarnessInvocation): Promise<HarnessResult> {
    try {
      // Apply manifest defaults if env_name is not set
      // This handles cases where jobs were created without explicit env targeting
      let effectiveInvocation = await this.applyManifestDefaults(invocation);

      // Managed model spec is detected early and passed through to invocation adapters.
      const modelSpec = (effectiveInvocation.harness_options as Record<string, unknown> | undefined)?.model as string | undefined;

      if (process.env.EVE_RUNTIME === 'k8s') {
        const localRepoPath = effectiveInvocation.repoUrl ? getLocalRepoPath(effectiveInvocation.repoUrl) : null;
        if (localRepoPath) {
          throw new Error('file:// repo URLs are not supported in k8s runtime');
        }

        // Phase 5: Resolve resource class and apply k8s sizing (best-effort; falls back to env vars).
        let runnerResources: { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } } | undefined;
        try {
          const resolved = await this.resolveResourceClassForJob(effectiveInvocation);
          const k8s = (resolved.spec as any)?.k8s as { cpu_request?: string; cpu_limit?: string; mem_request?: string; mem_limit?: string } | undefined;
          if (k8s?.cpu_request || k8s?.mem_request || k8s?.cpu_limit || k8s?.mem_limit) {
            runnerResources = {
              requests: {
                ...(k8s?.cpu_request ? { cpu: k8s.cpu_request } : {}),
                ...(k8s?.mem_request ? { memory: k8s.mem_request } : {}),
              },
              limits: {
                ...(k8s?.cpu_limit ? { cpu: k8s.cpu_limit } : {}),
                ...(k8s?.mem_limit ? { memory: k8s.mem_limit } : {}),
              },
            };
          }
        } catch (err) {
          console.warn(`[k8s] Failed to resolve resource class sizing for ${effectiveInvocation.jobId}: ${err instanceof Error ? err.message : String(err)}`);
        }

        const runnerInvocation = await this.getInvocationWithAppClis(
          await this.getInvocationWithJobToken(effectiveInvocation),
        );

        return await runInvocationInK8s(
          runnerInvocation,
          async (runtimeMeta) => {
            // Update runtime_meta in the database when pod is created
            try {
              await this.jobs.updateRuntimeMeta(effectiveInvocation.attemptId, runtimeMeta);
              console.log(`Updated runtime_meta for attempt ${effectiveInvocation.attemptId}:`, runtimeMeta);
            } catch (error) {
              console.error(`Failed to update runtime_meta for attempt ${effectiveInvocation.attemptId}:`, error);
            }
          },
          async (phase, action, meta, opts) => {
            await this.logLifecycleEvent(effectiveInvocation.attemptId, phase, action, meta, opts);
          },
          runnerResources ? { resources: runnerResources } : undefined,
        );
      }

      // Mark the start of execution (distinct from claim time).
      // In k8s runtime, the outer worker only spawns the runner pod; the runner pod
      // runs this same codepath with EVE_RUNTIME unset, so we only mark here.
      if (effectiveInvocation.attemptId) {
        await this.jobs.markExecutionStarted(effectiveInvocation.attemptId);
      }

      const userId = typeof effectiveInvocation.data?.user_id === 'string' ? effectiveInvocation.data.user_id : undefined;
      const resolvedSecrets = await this.resolveSecrets(effectiveInvocation.projectId, userId, effectiveInvocation.attemptId);
      const gitAuth = await this.prepareGitAuth(effectiveInvocation, resolvedSecrets);

      // Prepare workspace before execution
      // Check if job has git controls for advanced workspace handling
      // git controls are passed at top-level of HarnessInvocation, not under data
      const gitConfig = effectiveInvocation.git as JobGit | undefined;
      let repoPath: string;
      let gitWorkspace: GitWorkspace | undefined;

      let hadRepoPath = false;
      if (gitConfig) {
        // Use GitWorkspace for advanced git controls
        const result = await this.prepareWorkspaceWithGitControls(effectiveInvocation, gitAuth);
        repoPath = result.repoPath;
        gitWorkspace = result.gitWorkspace;
        hadRepoPath = result.hadRepoPath;
      } else {
        // Legacy shallow clone behavior (backwards compatible)
        const result = await this.prepareWorkspace(effectiveInvocation, gitAuth);
        repoPath = result.repoPath;
        hadRepoPath = result.hadRepoPath;
      }
      await cleanupWorkspaceSecretArtifacts(repoPath);
      if (effectiveInvocation.attemptId) {
        await this.logLifecycleEvent(effectiveInvocation.attemptId, 'workspace', 'log', {
          had_repo_path: hadRepoPath,
        });
      }

      // Org filesystem materialization — mirrors agent-runtime's ensureOrgRoot()
      const orgFsMount = effectiveInvocation.data?.orgfs_mount;
      let orgRootPath: string | null = null;
      let orgFsMountSpec: OrgFsMountSpec = { mode: 'none', allow_prefixes: [], read_only_prefixes: [] };

      const orgRoot = process.env.EVE_ORG_FS_ROOT;
      if (orgRoot && orgFsMount) {
        const { mountPath, spec } = await materializeScopedOrgFsMount({
          workspacePath: repoPath,
          orgRoot,
          rawSpec: orgFsMount,
        });
        orgRootPath = mountPath;
        orgFsMountSpec = spec;
      }

      if (effectiveInvocation.attemptId) {
        await this.jobs.updateRuntimeMeta(effectiveInvocation.attemptId, {
          orgfs_mount: {
            mode: orgFsMountSpec.mode,
            allow_prefixes: orgFsMountSpec.allow_prefixes,
            read_only_prefixes: orgFsMountSpec.read_only_prefixes,
            mounted: Boolean(orgRootPath),
          },
        });
      }

      const secretsContext = await this.materializeSecrets(repoPath, effectiveInvocation, resolvedSecrets, orgRootPath);

      let resourceIndexPath: string | null = null;
      if (effectiveInvocation.resource_refs && effectiveInvocation.resource_refs.length > 0) {
        const project = await this.projects.findById(effectiveInvocation.projectId);
        if (!project) {
          throw new Error(`Project ${effectiveInvocation.projectId} not found for resource hydration`);
        }

        await emitResourceHydrationEvent(this.events, effectiveInvocation, 'system.resource.hydration.started', {
          job_id: effectiveInvocation.jobId,
          attempt_id: effectiveInvocation.attemptId,
          resource_count: effectiveInvocation.resource_refs.length,
        });

        const hydration = await this.hydrateResources(effectiveInvocation, project.org_id, repoPath);
        resourceIndexPath = hydration.indexPath;

        if (resourceIndexPath) {
          secretsContext.env.EVE_RESOURCE_INDEX = resourceIndexPath;
        }

        await this.jobs.updateRuntimeMeta(effectiveInvocation.attemptId, {
          resource_hydration: hydration.summary,
          resource_index_path: resourceIndexPath,
        });

        if (hydration.summary.failed_required_count > 0) {
          await emitResourceHydrationEvent(this.events, effectiveInvocation, 'system.resource.hydration.failed', {
            job_id: effectiveInvocation.jobId,
            attempt_id: effectiveInvocation.attemptId,
            ...hydration.summary,
          });
          throw new Error('Resource hydration failed: required resources missing');
        }

        await emitResourceHydrationEvent(this.events, effectiveInvocation, 'system.resource.hydration.completed', {
          job_id: effectiveInvocation.jobId,
          attempt_id: effectiveInvocation.attemptId,
          ...hydration.summary,
        });
      }

      // Stage chat file attachments into .eve/attachments/
      const chatFiles = effectiveInvocation.data?.chat_files;
      if (Array.isArray(chatFiles) && chatFiles.length > 0) {
        await this.stageAttachments(repoPath, chatFiles as ChatFile[]);
      }

      const skipWorkspaceSkills = await this.shouldSkipWorkspaceSkills(effectiveInvocation);
      if (skipWorkspaceSkills) {
        await this.logLifecycleEvent(effectiveInvocation.attemptId, 'workspace', 'log', {
          kind: 'skills_materialize_skipped',
          reason: 'auth_probe',
        });
      } else {
        await materializeWorkspaceSkills(repoPath, {
          skillMode: typeof effectiveInvocation.data?.skill_mode === 'string'
            ? effectiveInvocation.data.skill_mode
            : 'runtime',
        });
      }

      // Run workspace hooks (on-clone/on-reuse + on-acquire)
      await runAcquireHooks(
        repoPath,
        secretsContext.env,
        secretsContext.secretsFilePath,
        !hadRepoPath,
        this.buildLifecycleLogger(),
        effectiveInvocation.attemptId,
      );

      const serviceProvisioning = await this.provisionServices(effectiveInvocation, repoPath, {
        ...secretsContext.env,
      });

      try {
        const harness = (effectiveInvocation.harness ?? 'mclaude') as HarnessName;
        const permission = (effectiveInvocation.permission ?? 'yolo') as PermissionPolicy;
        const adapter = resolveHarnessAdapter(harness);
        if (!adapter) {
          throw new Error(`Unknown harness: ${harness}`);
        }
        const harnessOptions =
          (effectiveInvocation.harness_options &&
            typeof effectiveInvocation.harness_options === 'object')
            ? effectiveInvocation.harness_options
            : {};
        const invocationWithOptions = {
          ...effectiveInvocation,
          variant: effectiveInvocation.variant ?? (harnessOptions as { variant?: string }).variant,
        };

        // Log resolved secrets for debugging (keys only, not values)
        console.log(`[secrets] Resolved ${resolvedSecrets.length} secrets: [${resolvedSecrets.map(s => s.key).join(', ')}]`);

        // Capture original Codex auth for post-execution write-back comparison
        const codexAuthSecret = resolvedSecrets.find(s => s.key === 'CODEX_AUTH_JSON_B64');
        const originalCodexB64 = codexAuthSecret?.value;
        const rawCodexScopeType = codexAuthSecret?.scope_type;
        const codexScopeType = (rawCodexScopeType === 'user' || rawCodexScopeType === 'org' || rawCodexScopeType === 'project')
          ? rawCodexScopeType : undefined;
        const codexScopeId = codexAuthSecret?.scope_id;

        // Build base environment with resolved secrets for harness adapter lookup.
        // The adapter picks harness-specific vars (auth tokens, config dirs) via
        // buildOptions().  All resolved project secrets are separately forwarded
        // to the harness env so agents can use tools like `gh`, custom API keys, etc.
        const prefixedEnv = extractPrefixedEnv(['EVE_WORKER_', 'EVE_HARNESS_'], process.env);
        const baseEnv: Record<string, string | undefined> = {
          ...prefixedEnv,
          ...secretsContext.env,
          ...serviceProvisioning.env,
        };
        const isClaudeHarness = harness === 'claude' || harness === 'mclaude';
        const jobUserHome = await createJobUserHome(effectiveInvocation.attemptId);
        const claudeAuthDecision = await this.resolveClaudeAuthDecision(resolvedSecrets, baseEnv);
        let claudeAuthRuntime: ClaudeAuthRuntimeState | null = null;

        // IMPORTANT: resolveMclaudeAuth/resolveCodeAuth must read from the per-invocation
        // env (which includes org/project/user secrets). Do not rely on worker process.env.
        const helpers: HarnessHelpers = {
          resolveMclaudeAuth: async (options) => {
            const sourceConfigDir = options?.configDir ?? path.join(os.homedir(), '.config', 'claude');
            const runtimeConfig = await prepareClaudeRuntimeConfig(
              repoPath,
              sourceConfigDir,
              jobUserHome,
              effectiveInvocation.attemptId,
              options?.harness ?? (harness === 'claude' ? 'claude' : 'mclaude'),
              options?.variant ?? invocationWithOptions.variant,
            );
            const materialized = await materializeClaudeCredentials(runtimeConfig.configDir, claudeAuthDecision);
            claudeAuthRuntime = { runtimeConfig, materialized };
            return {
              env: { ...(claudeAuthDecision?.env ?? {}) },
              configDir: runtimeConfig.configDir,
            };
          },
          resolveCodeAuth: (options?: { configDir?: string }) =>
            this.resolveCodeAuth({ ...options, env: baseEnv }),
        };

        const options = await adapter.buildOptions({
          invocation: invocationWithOptions,
          harness,
          permission,
          repoPath,
          helpers,
          env: baseEnv,
        });

        // Build harness env: adapter-selected vars + all resolved project secrets.
        //
        // Project/org/user secrets are explicitly set by users FOR their agents.
        // They must be available in the harness process (e.g. GITHUB_TOKEN for
        // `gh`, API keys for custom integrations).
        //
        // Worker-internal vars (DATABASE_URL, EVE_SECRETS_MASTER_KEY, etc.) are
        // safely excluded by buildSanitizedHarnessEnv's allowlist — those come
        // from process.env, not from secretsContext.env.
        const harnessEnv: Record<string, string | undefined> = {
          ...secretsContext.env,
          ...(options.env ?? {}),
        };

        const envOverridesRaw = (effectiveInvocation as { env_overrides?: Record<string, string> }).env_overrides;
        const envOverrideResult = await applyEnvOverrides({
          envOverrides: envOverridesRaw,
          resolvedSecrets,
          baseEnv: harnessEnv,
          onMissingSecrets: (missing) =>
            deliverProvisioningError(this.buildRelayDb(), {
              jobId: effectiveInvocation.jobId,
              parentJobId: effectiveInvocation.parentJobId ?? null,
              assignee: effectiveInvocation.agentId ?? null,
              errorCode: 'missing_secret_override',
              message: `env_overrides reference unresolved secret(s): ${missing.join(', ')}`,
            }),
        });
        Object.assign(harnessEnv, envOverrideResult.env);
        let claudeAuthFailureMessage: string | undefined;
        if (isClaudeHarness) {
          const { scrubbedKeys } = scrubClaudeAuthEnv(harnessEnv, claudeAuthDecision);
          await this.logClaudeAuthSelected(
            effectiveInvocation,
            harness,
            claudeAuthDecision,
            claudeAuthRuntime,
            scrubbedKeys,
            jobUserHome,
            Boolean(harnessEnv.ANTHROPIC_BASE_URL),
          );
        }

        const result = await this.executeEveAgentCli(
          invocationWithOptions,
          {
            ...options,
            env: harnessEnv,
          },
          repoPath,
          resourceIndexPath,
          jobUserHome,
          claudeAuthDecision,
          (message) => { claudeAuthFailureMessage = message; },
        );
        if (claudeAuthFailureMessage && !result.success && !result.error?.includes(claudeAuthFailureMessage)) {
          result.error = result.error
            ? `${result.error}\n\n${claudeAuthFailureMessage}`
            : claudeAuthFailureMessage;
        }

        // Write back refreshed Codex auth.json if the token was refreshed during execution
        if (originalCodexB64 && codexScopeType && codexScopeId) {
          await this.writeBackCodexAuth(originalCodexB64, codexScopeType, codexScopeId);
        }

        // Git policies: auto-commit and push after harness execution
        if (gitWorkspace && gitConfig) {
          try {
            await handleCommitPolicy(gitWorkspace, gitConfig, effectiveInvocation.jobId, result.success);
            await handlePushPolicy(gitWorkspace, gitConfig, result.success);
          } catch (gitError) {
            const msg = gitError instanceof Error ? gitError.message : String(gitError);
            console.error(`[git-policy] ${msg}`);
            result.success = false;
            result.error = result.error ? `${result.error}; ${msg}` : msg;
          }

          await this.updateAttemptGitMeta(effectiveInvocation.attemptId, gitWorkspace.getResolvedMetadata());
        }

        // Run release hook after execution (success or failure)
        await runReleaseHook(repoPath, secretsContext.env, secretsContext.secretsFilePath, this.buildLifecycleLogger(), effectiveInvocation.attemptId);

        return result;
      } finally {
        await serviceProvisioning.cleanup();
        // Phase 2 secret isolation: clean up per-job user home
        await cleanupJobUserHome(effectiveInvocation.attemptId);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Worker execution failed: ${errMsg}`);
      return {
        attemptId: invocation.attemptId,
        success: false,
        exitCode: 1,
        error: errMsg,
      };
    }
  }

  /**
   * Apply manifest defaults to invocation if env_name or other fields are not set.
   *
   * This ensures that jobs scheduled without explicit environment targeting
   * use the project's manifest defaults at execution time.
   *
   * @param invocation - Original harness invocation
   * @returns Enhanced invocation with manifest defaults applied
   */
  private async applyManifestDefaults(invocation: HarnessInvocation): Promise<HarnessInvocation> {
    // If invocation already has env_name set (or explicitly null), use it as-is
    const hasExplicitEnv = invocation.data?.env_name !== undefined;
    if (hasExplicitEnv) {
      return invocation;
    }

    // Look up the latest manifest for this project
    try {
      const manifest = await this.db<{ parsed_defaults: Record<string, unknown> | null }[]>`
        SELECT parsed_defaults FROM project_manifests
        WHERE project_id = ${invocation.projectId}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      if (!manifest || manifest.length === 0 || !manifest[0].parsed_defaults) {
        console.log(`No manifest defaults found for project ${invocation.projectId}, using invocation as-is`);
        return invocation;
      }

      const defaults = manifest[0].parsed_defaults as { env?: string; [key: string]: unknown };

      if (!defaults.env) {
        console.log(`Manifest for project ${invocation.projectId} has no default env, using invocation as-is`);
        return invocation;
      }

      // Apply the default environment to the invocation
      console.log(`Applying manifest default env "${defaults.env}" for job ${invocation.jobId}`);

      return {
        ...invocation,
        data: {
          ...(invocation.data ?? {}),
          env_name: defaults.env,
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to fetch manifest defaults for project ${invocation.projectId}: ${errMsg}`);
      // Return original invocation on error - don't fail the job
      return invocation;
    }
  }

  private async getManifestDefaults(projectId: string): Promise<Record<string, unknown> | null> {
    try {
      const manifests = projectManifestQueries(this.db);
      const manifest = await manifests.findLatestByProject(projectId);
      return manifest?.parsed_defaults ?? null;
    } catch (err) {
      console.warn(`[manifest] Failed to fetch defaults for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async resolveResourceClassForJob(invocation: HarnessInvocation): Promise<{ name: string | null; spec: unknown | null }> {
    const [job, manifestDefaults, setting] = await Promise.all([
      this.jobs.findById(invocation.jobId),
      this.getManifestDefaults(invocation.projectId),
      systemSettingsQueries(this.db).get('resource_classes'),
    ]);

    const resourceClasses = parseResourceClassesV1(setting?.value) ?? DEFAULT_RESOURCE_CLASSES_V1;
    const name = resolveResourceClassName({
      job_hints: (job?.hints ?? null) as Record<string, unknown> | null,
      manifest_defaults: manifestDefaults,
      fallback: DEFAULT_RESOURCE_CLASS_NAME,
    });
    const spec = getResourceClassSpec(resourceClasses, name);
    return { name, spec };
  }

  private async resolveBudgetEnforcementConfig(invocation: HarnessInvocation): Promise<{
    max_tokens: number | null;
    max_cost: { currency: string; amount: number } | null;
    pricing: {
      rate_card: { name: string; version: number; effective_at: string; rates: RateCardV1 };
      markup_pct: number;
      currency: string;
      fx_usd_to_currency: { rate: string; fetched_at: string; source: string } | null;
    };
    compute: {
      resource_class: string | null;
      requested_vcpu: number | null;
      requested_memory_gib: number | null;
      execution_started_at_ms: number;
    };
  } | null> {
    const job = await this.jobs.findById(invocation.jobId);
    if (!job) return null;

    const hints = (job.hints ?? {}) as Record<string, unknown>;
    const maxTokens = readPositiveInt(hints.max_tokens);
    const maxCost = readMaxCostHint(hints.max_cost);

    if (!maxTokens && !maxCost) {
      return null;
    }

    // Load org billing config + system defaults.
    const [orgRow] = await this.db<{ org_id: string; billing_config: Record<string, unknown> | null }[]>`
      SELECT p.org_id, o.billing_config
      FROM projects p
      JOIN orgs o ON o.id = p.org_id
      WHERE p.id = ${invocation.projectId}
      LIMIT 1
    `;

    const billingDefaultsSetting = await systemSettingsQueries(this.db).get('billing.defaults');
    let systemDefaults = DEFAULT_BILLING_DEFAULTS_V1;
    if (billingDefaultsSetting?.value) {
      try {
        systemDefaults = parseBillingDefaultsV1(billingDefaultsSetting.value);
      } catch (err) {
        console.warn(
          `[budget] Invalid system billing.defaults; falling back: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const billing = resolveBillingConfigV1({
      system_defaults: systemDefaults,
      org_billing_config: orgRow?.billing_config,
    });
    const billingCurrency = (billing.billing_currency ?? 'usd').toLowerCase();
    const enforcementCurrency = (maxCost?.currency ?? billingCurrency).toLowerCase();

    const at = new Date();
    const rateCards = pricingRateCardQueries(this.db);
    const cardRow = await rateCards.findLatestEffective(billing.rate_card_name, at);
    const rateCard = cardRow
      ? {
          name: cardRow.name,
          version: cardRow.version,
          effective_at: cardRow.effective_at.toISOString(),
          rates: cardRow.rates_json as unknown as RateCardV1,
        }
      : {
          name: DEFAULT_RATE_CARD_NAME,
          version: DEFAULT_RATE_CARD_VERSION,
          effective_at: DEFAULT_RATE_CARD_EFFECTIVE_AT,
          rates: DEFAULT_RATE_CARD_V1,
        };

    // FX snapshot (USD -> enforcement currency).
    let fx: { rate: string; fetched_at: string; source: string } | null = null;
    if (enforcementCurrency !== 'usd') {
      const fxRow = await exchangeRateQueries(this.db).findLatest('usd', enforcementCurrency);
      if (fxRow) {
        fx = {
          rate: fxRow.rate,
          fetched_at: fxRow.fetched_at.toISOString(),
          source: fxRow.source,
        };
      }
    }

    // Compute sizing for budget include (requested resources * elapsed time).
    const resolvedClass = await this.resolveResourceClassForJob(invocation);
    const spec = resolvedClass.spec as { vcpu?: unknown; memory_gib?: unknown } | null;
    const requestedVcpu = typeof spec?.vcpu === 'number' && Number.isFinite(spec.vcpu) ? spec.vcpu : null;
    const requestedMem = typeof spec?.memory_gib === 'number' && Number.isFinite(spec.memory_gib) ? spec.memory_gib : null;

    const [attemptRow] = await this.db<{ execution_started_at: Date | null }[]>`
      SELECT execution_started_at FROM job_attempts
      WHERE id = ${invocation.attemptId}::uuid
      LIMIT 1
    `;
    const execStartedAt = attemptRow?.execution_started_at ?? new Date();

    return {
      max_tokens: maxTokens,
      max_cost: maxCost,
      pricing: {
        rate_card: rateCard,
        markup_pct: billing.markup_pct,
        currency: enforcementCurrency,
        fx_usd_to_currency: fx,
      },
      compute: {
        resource_class: resolvedClass.name,
        requested_vcpu: requestedVcpu,
        requested_memory_gib: requestedMem,
        execution_started_at_ms: execStartedAt.getTime(),
      },
    };
  }

  private async readClaudeCredentialsFile(): Promise<OAuthTokens | null> {
    const homeDir = process.env.HOME || os.homedir();
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    const ccConfigDir =
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(homeDir, '.cc-mirror', 'mclaude', 'config');
    const candidates = [
      path.join(homeDir, '.claude', '.credentials.json'),
      path.join(homeDir, '.claude', 'credentials.json'),
      path.join(xdgConfigHome, 'claude', '.credentials.json'),
      path.join(xdgConfigHome, 'claude', 'credentials.json'),
      path.join(ccConfigDir, '.credentials.json'),
    ];

    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(candidate, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        const oauth = data.claudeAiOauth as Record<string, unknown> | undefined;
        if (!oauth) continue;

        const accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken : undefined;
        if (!accessToken) continue;

        const expiresRaw = oauth.expiresAt;
        const expiresAt =
          typeof expiresRaw === 'number'
            ? expiresRaw
            : typeof expiresRaw === 'string' && expiresRaw.trim()
              ? Number(expiresRaw)
              : undefined;

        return {
          accessToken,
          expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`Failed to read Claude credentials file ${candidate}: ${String(error)}`);
        }
      }
    }

    return null;
  }

  private async resolveCodeAuth(options?: {
    configDir?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<{
    env: Record<string, string | undefined>;
  }> {
    const homeDir = process.env.HOME || os.homedir();
    const env = options?.env ?? process.env;

    console.log(`[codex-auth] resolveCodeAuth called: configDir=${options?.configDir ?? '(none)'} HOME=${homeDir} OPENAI_API_KEY=${!!env.OPENAI_API_KEY} CODEX_AUTH_JSON_B64=${!!env.CODEX_AUTH_JSON_B64} CODEX_OAUTH_ACCESS_TOKEN=${!!env.CODEX_OAUTH_ACCESS_TOKEN}`);

    // Priority 1: OPENAI_API_KEY env var
    const apiKey = env.OPENAI_API_KEY;
    if (apiKey) {
      console.log('[codex-auth] Using OPENAI_API_KEY from env');
      return { env: { OPENAI_API_KEY: apiKey } };
    }

    // Priority 2: CODEX_AUTH_JSON_B64 env var (full auth.json as base64)
    // Write the complete auth.json (including refresh_token) so the Codex CLI
    // can use its native OAuth flow — reading from CODEX_HOME/auth.json and
    // auto-refreshing when the access_token expires.
    const authJsonB64 = env.CODEX_AUTH_JSON_B64;
    if (authJsonB64) {
      const authJsonStr = Buffer.from(authJsonB64, 'base64').toString('utf-8');

      try {
        const authData = JSON.parse(authJsonStr) as Record<string, unknown>;
        const tokens = authData.tokens as Record<string, unknown> | undefined;
        const hasAccessToken = typeof tokens?.access_token === 'string';
        const hasRefreshToken = typeof tokens?.refresh_token === 'string';
        const hasApiKey = typeof authData.OPENAI_API_KEY === 'string';
        console.log(
          `[codex-auth] CODEX_AUTH_JSON_B64 decoded: access_token=${hasAccessToken}, refresh_token=${hasRefreshToken}, OPENAI_API_KEY=${hasApiKey}, last_refresh=${String(authData.last_refresh ?? 'missing')}`,
        );
      } catch {
        console.warn('[codex-auth] Failed to parse CODEX_AUTH_JSON_B64 — writing raw');
      }

      // Write auth.json to CODEX_HOME (inside workspace, readable by codex binary)
      // and to standard fallback locations.
      const authTargets = [
        ...(options?.configDir ? [options.configDir] : []),
        path.join(homeDir, '.codex'),
        path.join(homeDir, '.code'),
      ];
      for (const dir of authTargets) {
        const authPath = path.join(dir, 'auth.json');
        try {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(authPath, authJsonStr);
          console.log(`[codex-auth] Wrote auth.json to ${authPath}`);
        } catch (error) {
          console.warn(`[codex-auth] Failed to write auth.json to ${authPath}: ${String(error)}`);
        }
      }

      // Do NOT pass OPENAI_API_KEY as env var — let the Codex CLI use file-based
      // auth from CODEX_HOME/auth.json so it can auto-refresh using refresh_token.
      return { env: {} };
    }

    // Priority 3: CODEX_OAUTH_ACCESS_TOKEN env var (access_token only, no refresh)
    const oauthToken = env.CODEX_OAUTH_ACCESS_TOKEN;
    if (oauthToken) {
      const authPayload = {
        tokens: { access_token: oauthToken },
        last_refresh: new Date().toISOString(),
      };
      const authJsonStr = JSON.stringify(authPayload, null, 2);
      const authDirs = [
        ...(options?.configDir ? [options.configDir] : []),
        path.join(homeDir, '.codex'),
        path.join(homeDir, '.code'),
      ];
      for (const dir of authDirs) {
        const authPath = path.join(dir, 'auth.json');
        try {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(authPath, authJsonStr);
        } catch (error) {
          console.warn(`[codex-auth] Failed to write auth.json to ${authPath}: ${String(error)}`);
        }
      }
      // No refresh_token available — pass as env var fallback
      return { env: { OPENAI_API_KEY: oauthToken } };
    }

    // Priority 4: Read from host auth.json files (mounted or pre-existing)
    const authPaths = [
      ...(options?.configDir ? [path.join(options.configDir, 'auth.json')] : []),
      path.join(homeDir, '.codex', 'auth.json'),
      path.join(homeDir, '.code', 'auth.json'),
    ];
    for (const authPath of authPaths) {
      try {
        const content = await fs.readFile(authPath, 'utf-8');
        const data = JSON.parse(content) as {
          OPENAI_API_KEY?: string;
          tokens?: { access_token?: string; refresh_token?: string };
        };
        if (data.tokens?.access_token || data.OPENAI_API_KEY) {
          console.log(`[codex-auth] Found pre-existing auth at ${authPath}`);
          // Copy to configDir if different from source
          if (options?.configDir && !authPath.startsWith(options.configDir)) {
            const targetPath = path.join(options.configDir, 'auth.json');
            try {
              await fs.mkdir(options.configDir, { recursive: true });
              await fs.writeFile(targetPath, content);
            } catch {
              // non-fatal
            }
          }
          return { env: {} };
        }
      } catch {
        // File doesn't exist or isn't valid JSON, try next
      }
    }

    throw new Error(
      'Missing code auth: set OPENAI_API_KEY or CODEX_AUTH_JSON_B64. Run: eve auth sync --codex',
    );
  }

  /**
   * After harness execution, read back auth.json from the paths the worker wrote to,
   * pick the freshest, compare to the original base64, and update the secret if changed.
   * Failures are non-fatal — logged at warn level and swallowed.
   */
  private async writeBackCodexAuth(
    originalB64: string,
    scopeType: 'user' | 'org' | 'project',
    scopeId: string,
    configDir?: string,
  ): Promise<void> {
    try {
      const homeDir = process.env.HOME || os.homedir();
      const authPaths = configDir
        ? [path.join(configDir, 'auth.json')]
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

  private async resolveEveAgentCliCommand(): Promise<{
    binary: string;
    prefixArgs: string[];
  }> {
    if (process.env.EVE_AGENT_CLI_PATH) {
      return { binary: process.env.EVE_AGENT_CLI_PATH, prefixArgs: [] };
    }

    const candidate = path.resolve(
      process.cwd(),
      '..',
      '..',
      'packages',
      'eve-agent-cli',
      'dist',
      'index.js',
    );

    try {
      await fs.stat(candidate);
      return { binary: process.execPath, prefixArgs: [candidate] };
    } catch {
      return { binary: 'eve-agent-cli', prefixArgs: [] };
    }
  }

  private async executeEveAgentCli(
    invocation: HarnessInvocation,
    options: {
      harness: string;
      permission: string;
      variant?: string;
      model?: string;
      reasoning?: string;
      env?: Record<string, string | undefined>;
    },
    repoPath: string,
    resourceIndexPath?: string | null,
    jobUserHome?: string,
    claudeAuthDecision?: ClaudeAuthDecision | null,
    onClaudeAuthFailure?: (message: string) => void,
  ): Promise<HarnessResult> {
    const { binary, prefixArgs } = await this.resolveEveAgentCliCommand();
    const startTime = Date.now();
    const harnessOptions = {
      ...(options.variant ? { variant: options.variant } : {}),
      ...(options.model ? { model: options.model } : {}),
    };
    const budgetConfig = await this.resolveBudgetEnforcementConfig(invocation).catch((err) => {
      console.warn(
        `[budget] Failed to resolve budget config for job ${invocation.jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });

    await this.logLifecycleEvent(invocation.attemptId, 'harness', 'start', {
      harness: options.harness,
      permission: options.permission,
      variant: options.variant,
      model: options.model,
      reasoning: options.reasoning,
      ...(Object.keys(harnessOptions).length > 0
        ? { harness_options: harnessOptions }
        : {}),
    });

    // Write security policy CLAUDE.md for Claude-family harnesses
    const claudeConfigDir = options.env?.CLAUDE_CONFIG_DIR;
    if (claudeConfigDir) {
      const securityMd = buildSecurityClaudeMd(repoPath);
      const claudeMdPath = path.join(claudeConfigDir, 'CLAUDE.md');
      try {
        await fs.mkdir(claudeConfigDir, { recursive: true });
        await fs.writeFile(claudeMdPath, securityMd);
      } catch (err) {
        console.warn(`Failed to write security CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Write coordination inbox if this job has a parent with a coordination thread
    const coordDb = this.buildCoordinationDb();
    await writeCoordinationInbox(invocation, repoPath, coordDb);

    // Write thread conversation history for multi-turn continuity
    await writeThreadContext(invocation, repoPath, coordDb);

    // Materialize agent context hints into .eve/context/* for carryover.
    await writeCarryoverContext(invocation, repoPath, this.buildCarryoverContextDb());

    // Phase 2 secret isolation: HOME is created before harness option
    // resolution so Claude config/auth can be materialized outside repoPath.
    const effectiveJobUserHome = jobUserHome ?? await createJobUserHome(invocation.attemptId);

    // Write Eve CLI credentials so the agent can call `eve` commands
    const invocationToken = getInvocationJobToken(invocation);
    const jobToken = await writeEveCredentials(invocation, invocationToken, effectiveJobUserHome);

    const adapterEnv: Record<string, string | undefined> = {
      ...(options.env ?? {}),
    };
    if (jobToken) {
      adapterEnv.EVE_JOB_TOKEN = jobToken;
    }

    // Inject with_apis env vars (EVE_APP_API_URL_{service}) from resolved hints
    // and set up app CLIs (chmod + add to PATH) for repo-bundled CLIs
    const appCliBinPaths: string[] = [];
    try {
      const hintsRow = await this.db<{ hints: Record<string, unknown> | null }[]>`
        SELECT hints FROM jobs WHERE id = ${invocation.jobId}
      `;
      const resolvedApis = hintsRow[0]?.hints?.resolved_app_apis as Array<{ name: string; type?: string; base_url: string; cli?: { name: string; bin: string; image?: string } }> | undefined;
      const resolvedLinks = hintsRow[0]?.hints?.resolved_app_links as Array<{ name: string; alias: string; subscription_id: string; type?: string; base_url: string; scopes?: string[]; producer_project_id?: string; producer_env?: string; cli?: { name: string; bin: string; image?: string } }> | undefined;
      const resolvedLinksWithTokens = [];
      for (const link of resolvedLinks ?? []) {
        const token = await mintAppLinkToken({
          subscriptionId: link.subscription_id,
          consumerPrincipal: `job:${invocation.jobId}`,
          producerEnv: link.producer_env,
          ttlSeconds: 60 * 60,
        });
        resolvedLinksWithTokens.push({
          ...link,
          origin: 'app_link' as const,
          type: link.type ?? 'openapi',
          token: token?.access_token,
        });
      }
      if (resolvedApis?.length || resolvedLinksWithTokens.length > 0) {
        Object.assign(adapterEnv, buildAppApiEnvVars([
          ...(resolvedApis ?? []).map((api) => ({ ...api, type: api.type ?? 'openapi' })),
          ...resolvedLinksWithTokens,
        ]));

        // Set up repo-bundled CLIs: chmod +x and add bin dir to PATH
        for (const api of resolvedApis ?? []) {
          if (!api.cli?.bin) continue;
          const cliBinPath = path.join(repoPath, api.cli.bin);
          try {
            await fs.chmod(cliBinPath, 0o755);
            appCliBinPaths.push(path.dirname(cliBinPath));
            console.log(`[app-cli] '${api.cli.name}' available at ${cliBinPath}`);
          } catch {
            console.warn(`[app-cli] '${api.cli.name}' declared but not found: ${cliBinPath}`);
          }
        }
      }
    } catch {
      // Non-fatal — description still has the URLs
    }

    return new Promise((resolve) => {
      const securityPreamble = buildSecurityPolicyPreamble(repoPath);
      const fullPromptText = securityPreamble + '\n\n' + invocation.text;

      const args = [
        '--harness',
        options.harness,
        '--permission',
        options.permission,
        '--output-format',
        'stream-json',
        '--workspace',
        repoPath,
        '--prompt',
        fullPromptText,
      ];

      if (options.variant) {
        args.push('--variant', options.variant);
      }

      if (options.model) {
        args.push('--model', options.model);
      }

      if (options.reasoning) {
        args.push('--reasoning', options.reasoning);
      }

      const processEnv = buildSanitizedHarnessEnv({
        binPaths: [
          ...appCliBinPaths,
          path.resolve(process.cwd(), 'node_modules', '.bin'),
          path.resolve(process.cwd(), '..', '..', 'node_modules', '.bin'),
        ],
        jobId: invocation.jobId,
        attemptId: invocation.attemptId,
        projectId: invocation.projectId,
        repoPath,
        parentJobId: invocation.parentJobId,
        eveApiUrl: loadConfig().EVE_API_URL,
        envName: typeof invocation.data?.env_name === 'string' ? invocation.data.env_name : undefined,
        resourceIndexPath: resourceIndexPath ?? undefined,
        jobUserHome: effectiveJobUserHome,
        adapterEnv,
      });

      const fullArgs = [...prefixArgs, ...args];
      console.log(`[harness] Executing: ${binary} ${fullArgs.join(' ')}`);
      console.log(`[harness-env] CODEX_HOME=${processEnv.CODEX_HOME ?? '(unset)'} OPENAI_API_KEY=${processEnv.OPENAI_API_KEY ? 'present' : '(unset)'}`);

      const harnessProcess = spawn(binary, fullArgs, {
        cwd: repoPath,
        env: processEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Budget enforcement state (Phase 7): best-effort, fail-open on internal errors.
      const llmUsageAgg = new Map<string, {
        provider: string;
        model: string;
        source: 'byok' | 'managed';
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
          reasoning_tokens: number;
        };
      }>();
      let budgetExceededError: string | null = null;
      let budgetKillIssued = false;
      let budgetSummaryAppended = false;
      let budgetInterval: NodeJS.Timeout | null = null;

      const formatCacheReadWeight = (weight: number | null): string =>
        weight == null ? 'full/mixed' : weight.toFixed(2);

      const estimateBudgetState = (): BudgetState | null => {
        if (!budgetConfig) return null;
        const currency = budgetConfig.pricing.currency;
        const fxRate =
          currency === 'usd'
            ? 1
            : Number(budgetConfig.pricing.fx_usd_to_currency?.rate ?? '1');

        const llmUsage = Array.from(llmUsageAgg.values()).map((e) => ({
          provider: e.provider,
          model: e.model,
          source: e.source,
          usage: e.usage,
        }));

        const nowMs = Date.now();
        const elapsedSeconds = Math.max(
          0,
          (nowMs - budgetConfig.compute.execution_started_at_ms) / 1000,
        );
        const requestedVcpu = budgetConfig.compute.requested_vcpu ?? 0;
        const requestedMem = budgetConfig.compute.requested_memory_gib ?? 0;
        const computeUsage = {
          resource_class: budgetConfig.compute.resource_class,
          vcpu_seconds: requestedVcpu * elapsedSeconds,
          memory_gib_seconds: requestedMem * elapsedSeconds,
        };

        const costs = calculateBilledCost({
          rate_card: budgetConfig.pricing.rate_card.rates,
          llm_usage: llmUsage,
          compute_usage: computeUsage,
          markup_pct: budgetConfig.pricing.markup_pct,
          billing_currency: currency,
          fx_usd_to_billing: budgetConfig.pricing.fx_usd_to_currency,
        });

        const billedTotal = Number(costs.billed_cost.total.amount) || 0;
        const byokUsd = Number(costs.base_cost_usd.llm_byok_usd.amount) || 0;
        const byokTotal = byokUsd * fxRate;

        const tokenBreakdown = calculateBudgetTokenBreakdown(
          budgetConfig.pricing.rate_card.rates,
          Array.from(llmUsageAgg.values()),
        );

        return {
          currency,
          ...tokenBreakdown,
          estimated_total: billedTotal + byokTotal,
          byok_total: byokTotal,
          billed_total: billedTotal,
        };
      };

      const triggerBudgetExceeded = async (
        input: { reason: string; trigger: string; state: BudgetState },
      ): Promise<void> => {
        if (budgetKillIssued) return;
        budgetKillIssued = true;

        const maxCost = budgetConfig?.max_cost ?? null;
        const maxTokens = budgetConfig?.max_tokens ?? null;
        const msgParts = [
          `BUDGET_EXCEEDED: ${input.reason}`,
          maxTokens ? `max_tokens=${maxTokens}` : null,
          maxCost ? `max_cost=${maxCost.currency} ${maxCost.amount}` : null,
          `est_total=${input.state.currency} ${input.state.estimated_total.toFixed(6)}`,
          `weighted_tokens=${input.state.weighted_tokens}`,
          `cache_read=${input.state.cache_read_tokens}(w=${formatCacheReadWeight(input.state.cache_read_token_weight)})`,
        ].filter(Boolean);
        budgetExceededError = msgParts.join(' ');

        if (budgetInterval) {
          clearInterval(budgetInterval);
          budgetInterval = null;
        }

        // Terminate the harness process (fail-fast). Escalate to SIGKILL after a grace window.
        try {
          harnessProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
        setTimeout(() => {
          if (!budgetKillIssued) return;
          try {
            harnessProcess.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 5000);

        try {
          await this.logs.appendLog(invocation.attemptId, 'budget.exceeded', {
            trigger: input.trigger,
            reason: input.reason,
            max_tokens: maxTokens,
            max_cost: maxCost,
            currency: input.state.currency,
            estimated_total: input.state.estimated_total.toFixed(6),
            estimated_byok_total: input.state.byok_total.toFixed(6),
            estimated_billed_total: input.state.billed_total.toFixed(6),
            total_tokens: input.state.total_tokens,
            weighted_tokens: input.state.weighted_tokens,
            cache_read_tokens: input.state.cache_read_tokens,
            cache_read_token_weight: input.state.cache_read_token_weight,
            cache_read_tokens_excluded: input.state.cache_read_tokens_excluded,
          });
        } catch (err) {
          console.warn(`[budget] Failed to append budget.exceeded log: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      const appendBudgetSummary = async (trigger: string): Promise<void> => {
        if (!budgetConfig || budgetSummaryAppended) return;
        budgetSummaryAppended = true;
        const state = estimateBudgetState();
        if (!state) return;
        try {
          await this.logs.appendLog(invocation.attemptId, 'budget.summary', {
            trigger,
            max_tokens: budgetConfig.max_tokens ?? null,
            max_cost: budgetConfig.max_cost ?? null,
            currency: state.currency,
            estimated_total: state.estimated_total.toFixed(6),
            estimated_byok_total: state.byok_total.toFixed(6),
            estimated_billed_total: state.billed_total.toFixed(6),
            total_tokens: state.total_tokens,
            weighted_tokens: state.weighted_tokens,
            cache_read_tokens: state.cache_read_tokens,
            cache_read_token_weight: state.cache_read_token_weight,
            cache_read_tokens_excluded: state.cache_read_tokens_excluded,
          });
        } catch (err) {
          console.warn(`[budget] Failed to append budget.summary log: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      const maybeEnforceBudget = async (trigger: string): Promise<void> => {
        if (!budgetConfig || budgetKillIssued) return;
        const state = estimateBudgetState();
        if (!state) return;

        if (budgetConfig.max_tokens && state.weighted_tokens >= budgetConfig.max_tokens) {
          await triggerBudgetExceeded({ reason: 'max_tokens exceeded', trigger, state });
          return;
        }

        if (budgetConfig.max_cost && state.currency === budgetConfig.max_cost.currency && state.estimated_total >= budgetConfig.max_cost.amount) {
          await triggerBudgetExceeded({ reason: 'max_cost exceeded', trigger, state });
          return;
        }
      };

      const messageRelay = new EveMessageRelay(
        this.buildRelayDb(),
        invocation.jobId,
        invocation.parentJobId ?? null,
        invocation.agentId ?? null,
      );
      const isClaudeHarness = options.harness === 'claude' || options.harness === 'mclaude';
      let claudeApiKeySource: string | null = null;
      let claudeAuthFailureCandidate: { reason: string; apiKeySource?: string } | null = null;
      let claudeAuthFailureMessage: string | undefined;
      const maybeRecordClaudeAuthFailure = async (
        input: unknown,
        stream?: 'stdout' | 'stderr' | 'error',
      ): Promise<void> => {
        if (!isClaudeHarness || claudeAuthFailureCandidate) return;
        const apiKeySource = readClaudeApiKeySource(input);
        if (apiKeySource) {
          claudeApiKeySource = apiKeySource;
        }
        const failure = detectClaudeAuthFailure(input, stream ? { stream } : undefined);
        if (!failure) return;
        claudeAuthFailureCandidate = failure;
      };

      const rl = readline.createInterface({
        input: harnessProcess.stdout,
        crlfDelay: Infinity,
      });

      // Ensure stdout/stderr log writes are drained before we finalize results.
      let logChain: Promise<void> = Promise.resolve();
      const enqueue = (fn: () => Promise<void>) => {
        logChain = logChain.then(fn).catch((err) => {
          console.error('Failed processing harness log line:', err);
        });
      };

      if (budgetConfig) {
        // Periodic compute-budget enforcement even when no llm.call events are emitted.
        budgetInterval = setInterval(() => {
          enqueue(async () => {
            await maybeEnforceBudget('timer');
          });
        }, 2000);
      }

      const stdoutClosed = new Promise<void>((resolve) => rl.on('close', () => resolve()));

      rl.on('line', (line) => {
        if (!line.trim()) return;

        enqueue(async () => {
          try {
            const parsedLine = JSON.parse(line);
            const logType = parsedLine.type ?? 'event';
            await this.logs.appendLog(invocation.attemptId, logType, parsedLine);
            await maybeRecordClaudeAuthFailure(parsedLine);

            if (budgetConfig && logType === 'llm.call') {
              try {
                const provider = typeof parsedLine.provider === 'string' ? parsedLine.provider : 'unknown';
                const model = typeof parsedLine.model === 'string' ? parsedLine.model : 'unknown';
                const sourceRaw = typeof parsedLine.source === 'string' ? parsedLine.source : 'byok';
                const source: 'byok' | 'managed' = sourceRaw === 'managed' ? 'managed' : 'byok';
                const status = typeof parsedLine.status === 'string' ? parsedLine.status : 'ok';
                const ok = status === 'ok';
                const usage = parsedLine.usage as Record<string, unknown> | undefined;

                if (ok && usage) {
                  const key = `${source}:${provider}:${model}`;
                  const existing = llmUsageAgg.get(key) ?? {
                    provider,
                    model,
                    source,
                    usage: {
                      input_tokens: 0,
                      output_tokens: 0,
                      cache_read_tokens: 0,
                      cache_write_tokens: 0,
                      reasoning_tokens: 0,
                    },
                  };

                  existing.usage.input_tokens += Number(usage.input_tokens) || 0;
                  existing.usage.output_tokens += Number(usage.output_tokens) || 0;
                  existing.usage.cache_read_tokens += Number(usage.cache_read_tokens) || 0;
                  existing.usage.cache_write_tokens += Number(usage.cache_write_tokens) || 0;
                  existing.usage.reasoning_tokens += Number(usage.reasoning_tokens) || 0;
                  llmUsageAgg.set(key, existing);
                }

                await maybeEnforceBudget('llm.call');
              } catch (err) {
                console.warn(`[budget] Failed processing llm.call for enforcement: ${err instanceof Error ? err.message : String(err)}`);
              }
            }

            // Scan for eve-message blocks in assistant text
            await messageRelay.processEvent(parsedLine);
          } catch (parseError) {
            // Non-JSON line — check for raw eve-message fenced blocks
            await messageRelay.processLine(line);
            await maybeRecordClaudeAuthFailure(line, 'stdout');

            await this.logs.appendLog(invocation.attemptId, 'parse_error', {
              content: line,
              error:
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError),
            });
          }
        });
      });

      harnessProcess.stderr.on('data', (data) => {
        const text = data.toString();
        enqueue(async () => {
          try {
            await maybeRecordClaudeAuthFailure(text, 'stderr');
            await this.logs.appendLog(invocation.attemptId, 'system_error', {
              content: text,
            });
          } catch (logError) {
            console.error('Failed to log stderr:', logError);
          }
        });
      });

      harnessProcess.on('exit', async (exitCode, signal) => {
        if (budgetInterval) {
          clearInterval(budgetInterval);
          budgetInterval = null;
        }

        // Wait for stdout/stderr log lines to be flushed before we compute results.
        await stdoutClosed;
        await logChain;
        await appendBudgetSummary('final');

        let finalExitCode: number;
        if (exitCode !== null) {
          finalExitCode = exitCode;
        } else {
          // Signal-killed: use Unix convention (128 + signal number)
          const signalCodes: Record<string, number> = {
            SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1, SIGQUIT: 3,
          };
          const sigNum = signal ? (signalCodes[signal] ?? 1) : 1;
          finalExitCode = 128 + sigNum;
        }
        const durationMs = Date.now() - startTime;

        if (finalExitCode !== 0 && claudeAuthFailureCandidate) {
          claudeAuthFailureMessage = await this.emitClaudeAuthFailed(
            invocation,
            claudeAuthDecision ?? null,
            claudeAuthFailureCandidate,
            claudeApiKeySource,
          );
          onClaudeAuthFailure?.(claudeAuthFailureMessage);
        }

        try {
          await this.logs.appendLog(invocation.attemptId, 'system', {
            event: 'completed',
            exitCode: finalExitCode,
            durationMs,
          });
        } catch (logError) {
          console.error('Failed to log completion:', logError);
        }

        // Extract results from logs
        let extracted: ExtractedResult = {
          tokenInput: 0,
          tokenOutput: 0,
        };
        try {
          const logs = await this.logs.listLogs(invocation.attemptId);
          const logEntries = logs.map((l) => ({
            type: l.type,
            content: l.content as Record<string, unknown>,
          }));
          extracted = extractResults(logEntries);
        } catch (extractError) {
          console.error('Failed to extract results from logs:', extractError);
        }

        let errorMessage: string | undefined;
        if (finalExitCode !== 0) {
          errorMessage =
            extracted.errorMessage || `Process exited with code ${finalExitCode}`;
          if (claudeAuthFailureMessage) {
            errorMessage = extracted.errorMessage
              ? `${extracted.errorMessage}\n\n${claudeAuthFailureMessage}`
              : claudeAuthFailureMessage;
          }

          // Add helpful message for auth errors
          if (isAuthErrorMessage(errorMessage)) {
            errorMessage = `${errorMessage}\n\nTo fix: Run ./bin/eh docker auth && ./bin/eh docker stop && ./bin/eh docker start --no-build`;
          }
        }

        if (budgetExceededError) {
          errorMessage = budgetExceededError;
          if (finalExitCode === 0) finalExitCode = 1;
        }

        // Log harness lifecycle end
        await this.logLifecycleEvent(invocation.attemptId, 'harness', 'end', {
          harness: options.harness,
          permission: options.permission,
          ...(Object.keys(harnessOptions).length > 0
            ? { harness_options: harnessOptions }
            : {}),
          reasoning: options.reasoning,
          exit_code: finalExitCode,
        }, {
          duration_ms: durationMs,
          success: finalExitCode === 0,
          error: finalExitCode !== 0 ? errorMessage : undefined,
        });

        resolve({
          attemptId: invocation.attemptId,
          success: finalExitCode === 0,
          exitCode: finalExitCode,
          error: finalExitCode !== 0 ? errorMessage : undefined,
          resultText: extracted.resultText,
          resultJson: extracted.resultJson,
          durationMs,
          tokenInput: extracted.tokenInput,
          tokenOutput: extracted.tokenOutput,
        });
      });

      harnessProcess.on('error', async (error) => {
        if (budgetInterval) {
          clearInterval(budgetInterval);
          budgetInterval = null;
        }

        const durationMs = Date.now() - startTime;

        await appendBudgetSummary('spawn_error');

        try {
          await this.logs.appendLog(invocation.attemptId, 'spawn_error', {
            error: error.message,
          });
        } catch (logError) {
          console.error('Failed to log spawn error:', logError);
        }

        resolve({
          attemptId: invocation.attemptId,
          success: false,
          exitCode: 1,
          error: `Failed to spawn ${options.harness}: ${error.message}`,
          durationMs,
          tokenInput: 0,
          tokenOutput: 0,
        });
      });
    });
  }
}
