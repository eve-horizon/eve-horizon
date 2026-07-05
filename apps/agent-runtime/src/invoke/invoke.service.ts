import { Injectable, Inject } from '@nestjs/common';
import { spawn } from 'child_process';
import * as readline from 'readline';
import { createHash } from 'crypto';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createStorageClient, type ObjectStorageClient } from '@eve/shared';
import {
  type HarnessInvocation,
  type HarnessResult,
  ToolchainProvisionError,
  type ToolchainCacheEvent,
  type ToolchainProvisionResult,
  type LifecycleEvent,
  type LifecyclePhase,
  type LifecycleAction,
  getCorrelationLogFields,
  lifecycleLogType,
  type JobGit,
  loadConfig,
  parseResourceUri,
  defaultMountPathForUri,
  isValidMountPath,
  handleCommitPolicy,
  handlePushPolicy,
  type ChatFile,
  type AttachmentIndex,
  sanitizeFilename,
  generateEventId,
} from '@eve/shared';
import {
  type Db,
  executionLogQueries,
  jobQueries,
  orgQueries,
  orgDocumentQueries,
  jobAttachmentQueries,
  projectQueries,
  threadMessageQueries,
  eventQueries,
  systemSettingsQueries,
  pricingRateCardQueries,
  exchangeRateQueries,
  projectManifestQueries,
  agentQueries,
} from '@eve/db';
import {
  resolveHarnessAdapter,
  type HarnessName,
  type PermissionPolicy,
  type HarnessHelpers,
} from '@eve/shared';
import { runInvocationInK8s } from './k8s-runner';
import { GitWorkspace, type GitAuth as GitWorkspaceAuth } from '@eve/shared';
import { buildSanitizedHarnessEnv, buildAppApiEnvVars, mintAppLinkToken } from '@eve/shared';
import { extractPrefixedEnv, writeEveCredentials } from '@eve/shared';
import { materializeScopedOrgFsMount, normalizeOrgFsMountSpec } from '@eve/shared';

// Shared invoke module — single source of truth for agent execution logic
import {
  // Result extraction
  extractResults,
  type ExtractedResult,
  // Git utilities
  runGit,
  getLocalRepoPath,
  redactRepoUrl,
  updateAttemptGitMeta,
  // Eve credentials
  getInvocationJobToken,
  resolveInvocationJobToken,
  // Coordination
  writeCoordinationInbox,
  writeThreadContext,
  // Carryover context
  writeCarryoverContext,
  // Security policy
  writeSecurityClaudeMd,
  buildSecurityPolicyPreamble,
  // Workspace hooks
  materializeWorkspaceSkills,
  runHook,
  runAcquireHooks,
  runReleaseHook,
  // Workspace secrets
  resolveSecrets,
  prepareGitAuth,
  materializeSecrets,
  cleanupWorkspaceSecretArtifacts,
  applyEnvOverrides,
  // Harness lifecycle events
  logHarnessStart,
  logHarnessEnd,
  // Eve message relay
  EveMessageRelay,
  deliverProvisioningError,
  // Codex auth write-back
  writeBackCodexAuth,
  // Resource hydration events
  emitResourceHydrationEvent,
  // Budget enforcement
  resolveBudgetEnforcementConfig,
  BudgetEnforcer,
  // Per-job user home (Phase 2 secret isolation)
  createJobUserHome,
  cleanupJobUserHome,
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
  // Toolchain provisioning
  ensureToolchains,
  // DB facade types
  type CoordinationDb,
  type CarryoverContextDb,
  type RelayDb,
  type BudgetDb,
  type ChatDeliveryContext,
  type LogSink,
  DEFAULT_AGENT_PERMISSIONS,
} from '@eve/shared';
import {
  appendProvisionedToolchainEnv,
  buildToolchainRuntimeMeta,
  formatToolchainEvent,
  recordToolchainEvent,
} from './toolchains';
import type { SecretResolveItem, EveAgentCliOptions } from '@eve/shared';

const DEFAULT_K8S_NAMESPACE = 'eve';

type ClaudeAuthRuntimeState = {
  runtimeConfig: ClaudeRuntimeConfig;
  materialized: ClaudeCredentialMaterialization;
};

type LifecycleLoggerFn = (
  attemptId: string,
  phase: LifecyclePhase,
  action: LifecycleAction,
  meta: Record<string, unknown>,
  opts?: { duration_ms?: number; success?: boolean; error?: string; [key: string]: unknown },
) => Promise<void>;

/**
 * Read-mostly state assembled by execute() and threaded through the inline
 * execution phase methods. `env` (from materializeJobSecrets) is passed
 * separately and mutated in place by later phases, matching the original
 * single-function behavior.
 */
type InlineExecContext = {
  effectiveInvocation: HarnessInvocation;
  invocationWithOptions: HarnessInvocation;
  execTimings: Record<string, number>;
  timePhase: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  lifecycleLogger: LifecycleLoggerFn;
  resolvedSecrets: SecretResolveItem[];
  gitAuth: Awaited<ReturnType<typeof prepareGitAuth>>;
  gitConfig: JobGit | undefined;
  provisionedToolchains: ToolchainProvisionResult | null;
};

type PreparedRepo = {
  repoPath: string;
  gitWorkspace?: GitWorkspace;
  hadRepoPath: boolean;
};

/** Everything resolved up-front about how the harness process will run. */
type HarnessExecutionPlan = {
  harnessName: HarnessName;
  isClaudeHarness: boolean;
  jobUserHome: string;
  originalCodexB64: string | undefined;
  codexScopeType: 'user' | 'org' | 'project' | undefined;
  codexScopeId: string | undefined;
  claudeAuthDecision: ClaudeAuthDecision | null;
  claudeAuthRuntimeRef: { current: ClaudeAuthRuntimeState | null };
  harnessOptionsResolved: EveAgentCliOptions;
  harnessBinary: { binary: string; prefixArgs: string[] };
  harnessArgs: string[];
};

type HarnessProcessSetup = {
  startTime: number;
  logs: { type: string; content: Record<string, unknown> }[];
  processEnv: ReturnType<typeof buildSanitizedHarnessEnv>;
};

/**
 * Agent Runtime executor — orchestrates harness invocation with shared invoke module.
 */
@Injectable()
export class InvokeService {
  private logs: ReturnType<typeof executionLogQueries>;
  private jobs: ReturnType<typeof jobQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private documents: ReturnType<typeof orgDocumentQueries>;
  private attachments: ReturnType<typeof jobAttachmentQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private events: ReturnType<typeof eventQueries>;
  private agents: ReturnType<typeof agentQueries>;
  private _storageClient: ObjectStorageClient | null = null;

  constructor(@Inject('DB') private readonly db: Db) {
    this.logs = executionLogQueries(db);
    this.jobs = jobQueries(db);
    this.orgs = orgQueries(db);
    this.documents = orgDocumentQueries(db);
    this.attachments = jobAttachmentQueries(db);
    this.projects = projectQueries(db);
    this.events = eventQueries(db);
    this.agents = agentQueries(db);
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

  // ---------------------------------------------------------------------------
  // DB facade builders
  // ---------------------------------------------------------------------------

  private buildCoordinationDb(): CoordinationDb {
    return {
      queryJobHints: async (jobId) => {
        const rows = await this.db<{ hints: Record<string, unknown> | null }[]>`
          SELECT hints FROM jobs WHERE id = ${jobId}
        `;
        return rows[0];
      },
      listThreadMessages: (threadId, opts) =>
        threadMessageQueries(this.db).listByThread(threadId, opts),
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
        const doc = await this.documents.findByOrgAndPath(orgId, docPath);
        return doc ? { content: doc.content } : undefined;
      },
      findJobAttachment: async (jobId, name) => {
        const att = await this.attachments.findByJobIdAndName(jobId, name);
        return att ? { content: att.content } : undefined;
      },
      queryJobHints: async (jobId) => {
        const rows = await this.db<{ hints: Record<string, unknown> | null }[]>`
          SELECT hints FROM jobs WHERE id = ${jobId}
        `;
        return rows[0];
      },
      listThreadMessages: (threadId, opts) =>
        threadMessageQueries(this.db).listByThread(threadId, opts),
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

  private buildBudgetDb(): BudgetDb {
    const settings = systemSettingsQueries(this.db);
    const rateCards = pricingRateCardQueries(this.db);
    const fxRates = exchangeRateQueries(this.db);
    const manifests = projectManifestQueries(this.db);

    return {
      findJobById: async (jobId) => {
        const row = await this.jobs.findById(jobId);
        return row ?? undefined;
      },
      getSystemSetting: async (key) => {
        const row = await settings.get(key);
        return row ? { value: row.value } : undefined;
      },
      findLatestRateCard: async (name, at) => {
        const row = await rateCards.findLatestEffective(name, at);
        return row
          ? {
              name: row.name,
              version: row.version,
              effective_at: row.effective_at,
              rates_json: row.rates_json,
            }
          : undefined;
      },
      findLatestExchangeRate: async (from, to) => {
        const row = await fxRates.findLatest(from, to);
        return row
          ? { rate: row.rate, fetched_at: row.fetched_at, source: row.source }
          : undefined;
      },
      findLatestProjectManifest: async (projectId) => {
        const row = await manifests.findLatestByProject(projectId);
        return row ? { parsed_defaults: row.parsed_defaults } : undefined;
      },
      getOrgBillingConfig: async (projectId) => {
        const project = await this.projects.findById(projectId);
        if (!project) return undefined;
        const org = await this.orgs.findById(project.org_id);
        if (!org) return undefined;
        return { org_id: org.id, billing_config: org.billing_config };
      },
      getAttemptExecutionStart: async (attemptId) => {
        const [row] = await this.db<{ execution_started_at: Date | null }[]>`
          SELECT execution_started_at FROM job_attempts WHERE id = ${attemptId}::uuid
        `;
        return row;
      },
    };
  }

  private buildLogSink(): LogSink {
    return {
      appendLog: async (attemptId, type, content) => {
        await this.logs.appendLog(attemptId, type, content as Record<string, unknown>);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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

  private async applyManifestDefaults(invocation: HarnessInvocation): Promise<HarnessInvocation> {
    if (invocation.data?.env_name) return invocation;

    const job = await this.jobs.findById(invocation.jobId);
    const envName = job?.env_name ?? null;
    if (!envName) return invocation;

    return {
      ...invocation,
      data: {
        ...invocation.data,
        env_name: envName,
      },
    };
  }

  private async ensureOrgRoot(
    workspacePath: string,
    rawMountSpec: unknown,
  ): Promise<{ mountPath: string | null; mountSpec: ReturnType<typeof normalizeOrgFsMountSpec> }> {
    const orgRoot = process.env.EVE_ORG_FS_ROOT ?? '/org';
    const { mountPath, spec } = await materializeScopedOrgFsMount({
      workspacePath,
      orgRoot,
      rawSpec: rawMountSpec,
    });
    return {
      mountPath,
      mountSpec: spec,
    };
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
    const failedFiles = files.filter(f => f.error);
    if (eveFiles.length === 0 && failedFiles.length === 0) return;

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

    // Record files that failed resolution so agents know they were attached
    for (const file of failedFiles) {
      index.files.push({
        id: file.id,
        name: file.name || file.id || 'attachment',
        path: null,
        mimetype: file.mimetype,
        size: file.size,
        source_url: file.source_url,
        source_provider: file.source_provider,
        error: file.error,
      });
    }

    if (index.files.length > 0) {
      const stagedCount = index.files.filter(f => f.path).length;
      const failedCount = index.files.filter(f => f.error).length;
      await fs.writeFile(
        path.join(attachmentsDir, 'index.json'),
        JSON.stringify(index, null, 2),
      );
      console.log(`[attachments] Staged ${stagedCount} file(s), ${failedCount} failed, to .eve/attachments/`);
    }
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
    await fs.writeFile(indexFilePath, JSON.stringify(
      {
        resolved_at: resolvedAt,
        resources: summary.resources,
      },
      null,
      2,
    ));

    return { indexPath: '.eve/resources/index.json', summary };
  }

  private async resolveAgentPermissions(
    invocation: HarnessInvocation,
  ): Promise<string[] | undefined> {
    if (!invocation.agentId || !invocation.projectId) return undefined;

    const agent = await this.agents.findByProjectAndId(
      invocation.projectId, invocation.agentId,
    );
    if (!agent) return undefined;

    const rawPerms = (agent.access_json as Record<string, unknown> | undefined)?.permissions;
    if (!Array.isArray(rawPerms)) return undefined;
    const accessPerms = rawPerms.filter((p): p is string => typeof p === 'string');
    if (accessPerms.length === 0) return undefined;

    return [...new Set([...DEFAULT_AGENT_PERMISSIONS, ...accessPerms])];
  }

  private async getInvocationWithJobToken(invocation: HarnessInvocation): Promise<HarnessInvocation> {
    const permissions = await this.resolveAgentPermissions(invocation);
    const token = await resolveInvocationJobToken(invocation, undefined, permissions);
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

  // ---------------------------------------------------------------------------
  // Main execution entry point
  // ---------------------------------------------------------------------------

  async execute(invocation: HarnessInvocation): Promise<HarnessResult> {
    try {
      const effectiveInvocation = await this.applyManifestDefaults(invocation);
      const harnessOptions =
        (effectiveInvocation.harness_options &&
          typeof effectiveInvocation.harness_options === 'object')
          ? effectiveInvocation.harness_options
          : {};
      const invocationWithOptions = {
        ...effectiveInvocation,
        variant: effectiveInvocation.variant ?? (harnessOptions as { variant?: string }).variant,
      };
      const executeStartTime = Date.now();

      if (this.shouldRunInK8sRunnerPod()) {
        return await this.dispatchToRunner(effectiveInvocation);
      }

      if (process.env.EVE_RUNTIME === 'k8s' && effectiveInvocation.attemptId) {
        try {
          await this.jobs.updateRuntimeMeta(effectiveInvocation.attemptId, this.currentRuntimeMeta());
        } catch (error) {
          console.error(`Failed to set runtime_meta for inline execution on ${effectiveInvocation.attemptId}:`, error);
        }
      }

      const toolchains = await this.provisionRequestedToolchains(effectiveInvocation, executeStartTime);
      if (!toolchains.ok) {
        return toolchains.failure;
      }

      // Mark the start of execution (distinct from claim time).
      if (effectiveInvocation.attemptId) {
        await this.jobs.markExecutionStarted(effectiveInvocation.attemptId);
      }

      const execTimings: Record<string, number> = {};
      const timePhase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const t0 = Date.now();
        const result = await fn();
        const elapsed = Date.now() - t0;
        execTimings[name] = elapsed;
        console.log(`⏱️ ${name}: ${elapsed}ms`);
        return result;
      };

      const lifecycleLogger = this.logLifecycleEvent.bind(this);
      const userId = typeof effectiveInvocation.data?.user_id === 'string' ? effectiveInvocation.data.user_id : undefined;
      const resolvedSecrets = await timePhase('secrets', () => resolveSecrets(
        effectiveInvocation.projectId,
        lifecycleLogger,
        userId,
        effectiveInvocation.attemptId,
      ));
      const gitAuth = await prepareGitAuth(effectiveInvocation, resolvedSecrets);

      const gitConfig = effectiveInvocation.git as JobGit | undefined;

      const ctx: InlineExecContext = {
        effectiveInvocation,
        invocationWithOptions,
        execTimings,
        timePhase,
        lifecycleLogger,
        resolvedSecrets,
        gitAuth,
        gitConfig,
        provisionedToolchains: toolchains.provisioned,
      };

      const prepared = await this.prepareRepo(ctx);
      const { repoPath, hadRepoPath } = prepared;

      const orgRootPath = await this.mountOrgFs(ctx);
      const { env, secretsFilePath } = await this.materializeJobSecrets(ctx, repoPath, orgRootPath);

      const skipWorkspaceSkills = await this.shouldSkipWorkspaceSkills(effectiveInvocation);
      if (skipWorkspaceSkills) {
        await this.logLifecycleEvent(effectiveInvocation.attemptId, 'workspace', 'log', {
          kind: 'skills_materialize_skipped',
          reason: 'auth_probe',
        });
      } else {
        await timePhase('skills_materialize', () => materializeWorkspaceSkills(repoPath, {
          skillMode: typeof effectiveInvocation.data?.skill_mode === 'string'
            ? effectiveInvocation.data.skill_mode
            : 'runtime',
        }));
      }

      await timePhase('hooks', () => runAcquireHooks(repoPath, env, secretsFilePath, !hadRepoPath, lifecycleLogger, invocationWithOptions.attemptId));

      await this.runResourceHydration(ctx, repoPath, env);
      await this.stageWorkspaceContext(ctx, repoPath);

      const plan = await this.resolveHarnessExecution(ctx, repoPath, env);
      const setup = await this.buildHarnessProcessEnv(ctx, plan, repoPath, env);
      const messageRelay = await this.createMessageRelay(ctx);

      const result = await this.runHarness(ctx, plan, setup, messageRelay, repoPath);

      await this.finalizeExecution(ctx, plan, result, prepared, env, secretsFilePath);

      return result;
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      return {
        attemptId: invocation.attemptId,
        success: false,
        exitCode: 1,
        error: errMessage,
      };
    } finally {
      // Phase 2 secret isolation: clean up per-job user home
      await cleanupJobUserHome(invocation.attemptId);
    }
  }

  // ---------------------------------------------------------------------------
  // Inline execution phases (in execute() order)
  // ---------------------------------------------------------------------------

  /** Dispatch the invocation to a dedicated k8s runner pod. */
  private async dispatchToRunner(effectiveInvocation: HarnessInvocation): Promise<HarnessResult> {
    const localRepoPath = effectiveInvocation.repoUrl ? getLocalRepoPath(effectiveInvocation.repoUrl) : null;
    if (localRepoPath) {
      throw new Error('file:// repo URLs are not supported in k8s runtime');
    }

    const runnerInvocation = await this.getInvocationWithAppClis(
      await this.getInvocationWithJobToken(effectiveInvocation),
    );

    return await runInvocationInK8s(
      runnerInvocation,
      async (runtimeMeta) => {
        try {
          await this.jobs.updateRuntimeMeta(effectiveInvocation.attemptId, runtimeMeta);
          console.log(`Updated runtime_meta for attempt ${effectiveInvocation.attemptId}:`, runtimeMeta);
        } catch (error) {
          console.error(`Failed to update runtime_meta for attempt ${effectiveInvocation.attemptId}:`, error);
        }
      },
      async (phase, action, meta, opts) => {
        await this.logLifecycleEvent(
          effectiveInvocation.attemptId,
          phase,
          action,
          meta,
          {
            duration_ms: opts?.duration_ms,
            success: opts?.success,
            error: opts?.error,
          }
        );
      }
    );
  }

  /**
   * Provision declared toolchains before harness start. On provisioning
   * failure, returns the terminal `toolchain_unavailable` result instead of
   * throwing so execute() can fail fast with the classified error.
   */
  private async provisionRequestedToolchains(
    effectiveInvocation: HarnessInvocation,
    executeStartTime: number,
  ): Promise<
    | { ok: true; provisioned: ToolchainProvisionResult | null }
    | { ok: false; failure: HarnessResult }
  > {
    const requestedToolchains = [...new Set(effectiveInvocation.toolchains ?? [])];
    let provisionedToolchains: ToolchainProvisionResult | null = null;
    if (requestedToolchains.length > 0) {
      const toolchainEvents = new Map<string, Set<string>>();
      const logToolchainEvent = async (event: ToolchainCacheEvent) => {
        recordToolchainEvent(toolchainEvents, event);
        const message = formatToolchainEvent(event);
        console.log(`[toolchain] ${message}`);
        if (effectiveInvocation.attemptId) {
          await this.logs.appendLog(effectiveInvocation.attemptId, 'status', {
            kind: 'toolchain',
            event_type: event.type,
            toolchain: event.toolchain,
            image: event.image,
            root: event.root,
            message,
            timestamp: new Date().toISOString(),
          });
        }
      };

      try {
        provisionedToolchains = await ensureToolchains({
          toolchains: requestedToolchains,
          baseEnv: process.env,
          logger: logToolchainEvent,
        });
        if (effectiveInvocation.attemptId) {
          await this.jobs.updateRuntimeMeta(effectiveInvocation.attemptId, {
            toolchains: buildToolchainRuntimeMeta({
              executionMode: 'inline',
              requested: requestedToolchains,
              resolved: provisionedToolchains.resolved,
              missing: provisionedToolchains.missing,
              eventsByToolchain: toolchainEvents,
            }),
          });
        }
      } catch (error) {
        const provisionError = error instanceof ToolchainProvisionError ? error : null;
        const errorMessage = provisionError?.message
          ?? (error instanceof Error ? error.message : String(error));
        const resultJson = {
          error_code: 'toolchain_unavailable',
          toolchain: provisionError?.toolchain ?? requestedToolchains[0] ?? null,
          image: provisionError?.image ?? null,
        };

        if (effectiveInvocation.attemptId) {
          await this.jobs.updateRuntimeMeta(effectiveInvocation.attemptId, {
            toolchains: buildToolchainRuntimeMeta({
              executionMode: 'inline',
              requested: requestedToolchains,
              resolved: [],
              missing: requestedToolchains,
              source: 'unavailable',
              eventsByToolchain: toolchainEvents,
              errorCode: 'toolchain_unavailable',
              error: errorMessage,
              toolchain: provisionError?.toolchain,
              image: provisionError?.image,
            }),
          });
          await this.logs.appendLog(effectiveInvocation.attemptId, 'status', {
            kind: 'toolchain',
            event_type: 'provision_failed',
            error_code: 'toolchain_unavailable',
            toolchain: resultJson.toolchain,
            image: resultJson.image,
            message: errorMessage,
            timestamp: new Date().toISOString(),
          });
        }

        return {
          ok: false,
          failure: {
            attemptId: effectiveInvocation.attemptId,
            success: false,
            exitCode: 1,
            error: errorMessage,
            resultJson,
            durationMs: Date.now() - executeStartTime,
          },
        };
      }
    }

    return { ok: true, provisioned: provisionedToolchains };
  }

  /** Prepare the git workspace (with or without git controls). */
  private async prepareRepo(ctx: InlineExecContext): Promise<PreparedRepo> {
    const { effectiveInvocation, gitConfig, gitAuth, timePhase } = ctx;

    let prepared: PreparedRepo;
    if (gitConfig) {
      const cloneRef = gitConfig.ref ?? effectiveInvocation.repoBranch ?? 'main';
      prepared = await this.cloneRepoWithLifecycle(
        effectiveInvocation,
        cloneRef,
        'git_workspace',
        timePhase,
        () => this.prepareWorkspaceWithGitControls(effectiveInvocation, gitAuth),
      );
    } else {
      prepared = await this.cloneRepoWithLifecycle(
        effectiveInvocation,
        effectiveInvocation.repoBranch,
        'git_clone',
        timePhase,
        () => this.prepareWorkspace(effectiveInvocation, gitAuth),
      );
    }
    await cleanupWorkspaceSecretArtifacts(prepared.repoPath);
    if (effectiveInvocation.attemptId) {
      await this.logLifecycleEvent(effectiveInvocation.attemptId, 'workspace', 'log', {
        had_repo_path: prepared.hadRepoPath,
      });
    }
    return prepared;
  }

  /**
   * Run a workspace-preparation step bracketed by the `git_clone` lifecycle
   * start/end events (folds the previously duplicated try/catch logging).
   */
  private async cloneRepoWithLifecycle(
    effectiveInvocation: HarnessInvocation,
    cloneRef: string | undefined,
    phaseName: string,
    timePhase: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
    doPrepare: () => Promise<PreparedRepo>,
  ): Promise<PreparedRepo> {
    if (effectiveInvocation.attemptId) {
      await this.logLifecycleEvent(effectiveInvocation.attemptId, 'workspace', 'start', {
        kind: 'git_clone',
        ref: cloneRef,
      });
    }
    const cloneStartMs = Date.now();
    try {
      const result = await timePhase(phaseName, doPrepare);
      if (effectiveInvocation.attemptId) {
        await this.logLifecycleEvent(effectiveInvocation.attemptId, 'workspace', 'end', {
          kind: 'git_clone',
          ref: cloneRef,
        }, { duration_ms: Date.now() - cloneStartMs, success: true });
      }
      return result;
    } catch (err) {
      if (effectiveInvocation.attemptId) {
        await this.logLifecycleEvent(effectiveInvocation.attemptId, 'workspace', 'end', {
          kind: 'git_clone',
          ref: cloneRef,
        }, { duration_ms: Date.now() - cloneStartMs, success: false, error: err instanceof Error ? err.message : String(err) });
      }
      throw err;
    }
  }

  /** Mount the scoped org filesystem and record the mount in runtime_meta. */
  private async mountOrgFs(ctx: InlineExecContext): Promise<string | null> {
    const { effectiveInvocation, invocationWithOptions, timePhase } = ctx;

    const {
      mountPath: orgRootPath,
      mountSpec: orgFsMountSpec,
    } = await timePhase('orgfs_mount', () => this.ensureOrgRoot(
      effectiveInvocation.workspacePath,
      invocationWithOptions.data?.orgfs_mount,
    ));
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
    return orgRootPath;
  }

  /** Materialize resolved secrets into the harness env (and files on disk). */
  private async materializeJobSecrets(
    ctx: InlineExecContext,
    repoPath: string,
    orgRootPath: string | null,
  ): Promise<{ env: NodeJS.ProcessEnv; secretsFilePath: string | null }> {
    const { invocationWithOptions, resolvedSecrets, timePhase } = ctx;
    return await timePhase('materialize_secrets', () => materializeSecrets(
      repoPath,
      invocationWithOptions,
      resolvedSecrets,
      orgRootPath,
    ));
  }

  /** Hydrate declared resource refs into .eve/resources/, emitting hydration events. */
  private async runResourceHydration(
    ctx: InlineExecContext,
    repoPath: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const { effectiveInvocation, invocationWithOptions, timePhase } = ctx;

    // Resource hydration with event emission
    if (invocationWithOptions.resource_refs && invocationWithOptions.resource_refs.length > 0) {
      const project = await this.projects.findById(effectiveInvocation.projectId);
      if (!project) {
        throw new Error(`Project ${effectiveInvocation.projectId} not found for resource hydration`);
      }

      const eventCreator = this.events;

      await emitResourceHydrationEvent(eventCreator, invocationWithOptions, 'system.resource.hydration.started', {
        resource_count: invocationWithOptions.resource_refs.length,
        attempt_id: invocationWithOptions.attemptId,
      });

      const hydration = await timePhase('resource_hydration', () => this.hydrateResources(invocationWithOptions, project.org_id, repoPath));
      if (hydration.indexPath) {
        env.EVE_RESOURCE_INDEX = hydration.indexPath;
      }

      if (effectiveInvocation.attemptId) {
        await this.jobs.updateRuntimeMeta(effectiveInvocation.attemptId, {
          resource_hydration: hydration.summary,
          resource_index_path: hydration.indexPath,
        });
      }

      if (hydration.summary.failed_required_count > 0) {
        await emitResourceHydrationEvent(eventCreator, invocationWithOptions, 'system.resource.hydration.failed', {
          summary: hydration.summary,
          attempt_id: invocationWithOptions.attemptId,
        });
        throw new Error('Resource hydration failed: required resources missing');
      }

      await emitResourceHydrationEvent(eventCreator, invocationWithOptions, 'system.resource.hydration.completed', {
        summary: hydration.summary,
        attempt_id: invocationWithOptions.attemptId,
      });
    }
  }

  /** Stage chat attachments and coordination/thread/carryover context files. */
  private async stageWorkspaceContext(ctx: InlineExecContext, repoPath: string): Promise<void> {
    const { effectiveInvocation, invocationWithOptions } = ctx;

    // Stage chat file attachments into .eve/attachments/
    const chatFiles = effectiveInvocation.data?.chat_files;
    if (Array.isArray(chatFiles) && chatFiles.length > 0) {
      await this.stageAttachments(repoPath, chatFiles as ChatFile[]);
    }

    // Materialize coordination inbox + thread context before harness launch
    const coordinationDb = this.buildCoordinationDb();
    await writeCoordinationInbox(invocationWithOptions, repoPath, coordinationDb);
    await writeThreadContext(invocationWithOptions, repoPath, coordinationDb);

    // Materialize carryover context (agent_context from hints)
    const carryoverContextDb = this.buildCarryoverContextDb();
    await writeCarryoverContext(invocationWithOptions, repoPath, carryoverContextDb);
  }

  /**
   * Resolve the harness adapter, per-job HOME, Codex/Claude auth, adapter
   * options, security preamble, and the eve-agent-cli binary + args.
   */
  private async resolveHarnessExecution(
    ctx: InlineExecContext,
    repoPath: string,
    env: NodeJS.ProcessEnv,
  ): Promise<HarnessExecutionPlan> {
    const { invocationWithOptions, resolvedSecrets, execTimings, timePhase } = ctx;

    const harnessName = (invocationWithOptions.harness ?? 'mclaude') as HarnessName;
    const permission = (invocationWithOptions.permission ?? 'yolo') as PermissionPolicy;
    const harnessAdapter = resolveHarnessAdapter(harnessName);
    if (!harnessAdapter) {
      throw new Error(`Unknown harness: ${harnessName}`);
    }
    const isClaudeHarness = harnessName === 'claude' || harnessName === 'mclaude';

    // Phase 2 secret isolation: create per-job HOME before harness option
    // resolution so Claude auth/config materialization cannot land in repoPath.
    const jobUserHome = await createJobUserHome(invocationWithOptions.attemptId);

    // Capture original Codex auth for post-execution write-back comparison
    const codexAuthSecret = resolvedSecrets.find(s => s.key === 'CODEX_AUTH_JSON_B64');
    const originalCodexB64 = codexAuthSecret?.value;
    const rawCodexScopeType = codexAuthSecret?.scope_type;
    const codexScopeType = (rawCodexScopeType === 'user' || rawCodexScopeType === 'org' || rawCodexScopeType === 'project')
      ? rawCodexScopeType : undefined;
    const codexScopeId = codexAuthSecret?.scope_id;

    const claudeAuthDecision = selectClaudeAuth(resolvedSecrets);
    const claudeAuthRuntimeRef: { current: ClaudeAuthRuntimeState | null } = { current: null };
    const helpers: HarnessHelpers = {
      resolveMclaudeAuth: async (options) => {
        const sourceConfigDir = options?.configDir ?? path.join(os.homedir(), '.config', 'claude');
        const runtimeConfig = await prepareClaudeRuntimeConfig(
          repoPath,
          sourceConfigDir,
          jobUserHome,
          invocationWithOptions.attemptId,
          options?.harness ?? (harnessName === 'claude' ? 'claude' : 'mclaude'),
          options?.variant ?? invocationWithOptions.variant,
        );
        const materialized = await materializeClaudeCredentials(runtimeConfig.configDir, claudeAuthDecision);
        claudeAuthRuntimeRef.current = { runtimeConfig, materialized };
        return {
          env: { ...(claudeAuthDecision?.env ?? {}) },
          configDir: runtimeConfig.configDir,
        };
      },
      resolveCodeAuth: async (options) => {
        const homeDir = process.env.HOME || os.homedir();
        const configDir = options?.configDir ?? path.join(homeDir, '.codex');

        // Priority 1: OPENAI_API_KEY from secrets
        const apiKeySecret = resolvedSecrets.find(s => s.key === 'OPENAI_API_KEY');
        if (apiKeySecret) {
          console.log('[codex-auth] Using OPENAI_API_KEY from resolved secrets');
          return { env: { OPENAI_API_KEY: apiKeySecret.value } };
        }

        // Priority 2: CODEX_AUTH_JSON_B64 — decode and write full auth.json
        const authB64Secret = resolvedSecrets.find(s => s.key === 'CODEX_AUTH_JSON_B64');
        if (authB64Secret) {
          const authJsonStr = Buffer.from(authB64Secret.value, 'base64').toString('utf-8');

          try {
            const authData = JSON.parse(authJsonStr) as Record<string, unknown>;
            const tokens = authData.tokens as Record<string, unknown> | undefined;
            console.log(
              `[codex-auth] Decoded CODEX_AUTH_JSON_B64: access_token=${!!tokens?.access_token} refresh_token=${!!tokens?.refresh_token} last_refresh=${String(authData.last_refresh ?? 'missing')}`,
            );
          } catch {
            console.warn('[codex-auth] Failed to parse CODEX_AUTH_JSON_B64');
          }

          // Write auth.json to CODEX_HOME (inside workspace) and fallback locations
          const authTargets = [configDir, path.join(homeDir, '.codex'), path.join(homeDir, '.code')];
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

          // Let Codex CLI use file-based auth with refresh_token support
          return { env: {} };
        }

        // Priority 3: CODEX_OAUTH_ACCESS_TOKEN (no refresh support)
        const oauthSecret = resolvedSecrets.find(s => s.key === 'CODEX_OAUTH_ACCESS_TOKEN');
        if (oauthSecret) {
          const authPayload = {
            tokens: { access_token: oauthSecret.value },
            last_refresh: new Date().toISOString(),
          };
          const authJsonStr = JSON.stringify(authPayload, null, 2);
          const authTargets = [configDir, path.join(homeDir, '.codex'), path.join(homeDir, '.code')];
          for (const dir of authTargets) {
            try {
              await fs.mkdir(dir, { recursive: true });
              await fs.writeFile(path.join(dir, 'auth.json'), authJsonStr);
            } catch {
              // non-fatal
            }
          }
          return { env: { OPENAI_API_KEY: oauthSecret.value } };
        }

        // Priority 4: Pre-existing auth files
        const authPaths = [
          path.join(configDir, 'auth.json'),
          path.join(homeDir, '.codex', 'auth.json'),
          path.join(homeDir, '.code', 'auth.json'),
        ];
        for (const authPath of authPaths) {
          try {
            const content = await fs.readFile(authPath, 'utf-8');
            const data = JSON.parse(content) as { tokens?: { access_token?: string }; OPENAI_API_KEY?: string };
            if (data.tokens?.access_token || data.OPENAI_API_KEY) {
              console.log(`[codex-auth] Found pre-existing auth at ${authPath}`);
              if (configDir && !authPath.startsWith(configDir)) {
                try {
                  await fs.mkdir(configDir, { recursive: true });
                  await fs.writeFile(path.join(configDir, 'auth.json'), content);
                } catch { /* non-fatal */ }
              }
              return { env: {} };
            }
          } catch {
            // next
          }
        }

        console.error('[codex-auth] No codex auth found in secrets or filesystem');
        throw new Error('Missing code auth: set OPENAI_API_KEY or CODEX_AUTH_JSON_B64. Run: eve auth sync --codex');
      },
    };

    // baseEnv is a read context for adapter resolution.
    const prefixedEnv = extractPrefixedEnv(['EVE_WORKER_', 'EVE_HARNESS_'], process.env);
    const baseEnv: Record<string, string | undefined> = {
      ...prefixedEnv,
      ...env,
    };

    const harnessOptionsResolved = await timePhase('harness_options', () => harnessAdapter.buildOptions({
      invocation: invocationWithOptions,
      harness: harnessName,
      permission,
      repoPath,
      helpers,
      env: baseEnv,
    }));

    // Gap #3: Write security CLAUDE.md for Claude-family harnesses
    const claudeConfigDir = harnessOptionsResolved.env?.CLAUDE_CONFIG_DIR;
    if (claudeConfigDir) {
      await writeSecurityClaudeMd(repoPath, claudeConfigDir);
    }

    const securityPreamble = buildSecurityPolicyPreamble(repoPath);
    const fullPromptText = securityPreamble + '\n\n' + invocationWithOptions.text;

    const harnessBinary = this.resolveHarnessBinary();
    const harnessArgs = this.buildHarnessArgs({
      harness: harnessOptionsResolved.harness,
      permission: harnessOptionsResolved.permission,
      variant: harnessOptionsResolved.variant,
      model: harnessOptionsResolved.model,
      reasoning: harnessOptionsResolved.reasoning,
      workspace: repoPath,
      prompt: fullPromptText,
    });

    // Emit setup timing summary before harness launch
    const setupTotalMs = Object.values(execTimings).reduce((a, b) => a + b, 0);
    console.log(`⏱️ SETUP TOTAL: ${setupTotalMs}ms | ${JSON.stringify(execTimings)}`);

    return {
      harnessName,
      isClaudeHarness,
      jobUserHome,
      originalCodexB64,
      codexScopeType,
      codexScopeId,
      claudeAuthDecision,
      claudeAuthRuntimeRef,
      harnessOptionsResolved,
      harnessBinary,
      harnessArgs,
    };
  }

  /**
   * Assemble the harness process environment: adapter env, env overrides,
   * Claude auth scrub/log, Eve credentials, app APIs/CLIs, sanitized env.
   */
  private async buildHarnessProcessEnv(
    ctx: InlineExecContext,
    plan: HarnessExecutionPlan,
    repoPath: string,
    env: NodeJS.ProcessEnv,
  ): Promise<HarnessProcessSetup> {
    const { invocationWithOptions, resolvedSecrets, provisionedToolchains } = ctx;
    const {
      harnessName,
      isClaudeHarness,
      jobUserHome,
      claudeAuthDecision,
      claudeAuthRuntimeRef,
      harnessOptionsResolved,
    } = plan;

    const startTime = Date.now();
    const logs: { type: string; content: Record<string, unknown> }[] = [];

    const binPaths = [
      path.resolve(process.cwd(), 'node_modules', '.bin'),
      path.resolve(process.cwd(), '..', '..', 'node_modules', '.bin'),
    ];

    // Forward resolved project secrets + adapter-selected vars to the harness.
    const adapterEnv: Record<string, string | undefined> = {
      ...env,
      ...(harnessOptionsResolved.env ?? {}),
    };
    if (provisionedToolchains) {
      appendProvisionedToolchainEnv(provisionedToolchains, binPaths, adapterEnv);
    }

    const envOverridesRaw = (invocationWithOptions as { env_overrides?: Record<string, string> }).env_overrides;
    const envOverrideResult = await applyEnvOverrides({
      envOverrides: envOverridesRaw,
      resolvedSecrets,
      baseEnv: adapterEnv,
      onMissingSecrets: (missing) =>
        deliverProvisioningError(this.buildRelayDb(), {
          jobId: invocationWithOptions.jobId,
          parentJobId: invocationWithOptions.parentJobId ?? null,
          assignee: invocationWithOptions.agentId ?? null,
          errorCode: 'missing_secret_override',
          message: `env_overrides reference unresolved secret(s): ${missing.join(', ')}`,
        }),
    });
    Object.assign(adapterEnv, envOverrideResult.env);
    if (isClaudeHarness) {
      const { scrubbedKeys } = scrubClaudeAuthEnv(adapterEnv, claudeAuthDecision);
      await this.logClaudeAuthSelected(
        invocationWithOptions,
        harnessName,
        claudeAuthDecision,
        claudeAuthRuntimeRef.current,
        scrubbedKeys,
        jobUserHome,
        Boolean(adapterEnv.ANTHROPIC_BASE_URL),
      );
    }
    const agentPermissions = await this.resolveAgentPermissions(invocationWithOptions);
    const invocationToken = getInvocationJobToken(invocationWithOptions);
    const credsStartMs = Date.now();
    if (invocationWithOptions.attemptId) {
      await this.logLifecycleEvent(invocationWithOptions.attemptId, 'secrets', 'start', { kind: 'credentials_write' });
    }
    const jobToken = await writeEveCredentials(invocationWithOptions, invocationToken, jobUserHome, agentPermissions);
    if (invocationWithOptions.attemptId) {
      await this.logLifecycleEvent(invocationWithOptions.attemptId, 'secrets', 'end', { kind: 'credentials_write' }, {
        duration_ms: Date.now() - credsStartMs,
        success: Boolean(jobToken),
      });
    }
    if (jobToken) {
      adapterEnv.EVE_JOB_TOKEN = jobToken;
    }

    // Inject with_apis env vars (EVE_APP_API_URL_{service}) from resolved hints
    // and set up app CLIs (chmod + add to PATH) for repo-bundled CLIs
    try {
      const hintsRow = await this.db<{ hints: Record<string, unknown> | null }[]>`
        SELECT hints FROM jobs WHERE id = ${invocationWithOptions.jobId}
      `;
      const resolvedApis = hintsRow[0]?.hints?.resolved_app_apis as Array<{ name: string; type?: string; base_url: string; cli?: { name: string; bin: string; image?: string } }> | undefined;
      const resolvedLinks = hintsRow[0]?.hints?.resolved_app_links as Array<{ name: string; alias: string; subscription_id: string; type?: string; base_url: string; scopes?: string[]; producer_project_id?: string; producer_env?: string; cli?: { name: string; bin: string; image?: string } }> | undefined;
      const resolvedLinksWithTokens = [];
      for (const link of resolvedLinks ?? []) {
        const token = await mintAppLinkToken({
          subscriptionId: link.subscription_id,
          consumerPrincipal: `job:${invocationWithOptions.jobId}`,
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
            binPaths.push(path.dirname(cliBinPath));
            console.log(`[app-cli] '${api.cli.name}' available at ${cliBinPath}`);
            if (invocationWithOptions.attemptId) {
              await this.logLifecycleEvent(invocationWithOptions.attemptId, 'workspace', 'log', {
                kind: 'app_cli_discovery',
                name: api.cli.name,
                available: true,
              });
            }
          } catch {
            console.warn(`[app-cli] '${api.cli.name}' declared but not found: ${cliBinPath}`);
            if (invocationWithOptions.attemptId) {
              await this.logLifecycleEvent(invocationWithOptions.attemptId, 'workspace', 'log', {
                kind: 'app_cli_discovery',
                name: api.cli.name,
                available: false,
              });
            }
          }
        }
      }
    } catch {
      // Non-fatal — description still has the URLs
    }

    const processEnv = buildSanitizedHarnessEnv({
      binPaths,
      jobId: invocationWithOptions.jobId,
      attemptId: invocationWithOptions.attemptId,
      projectId: invocationWithOptions.projectId,
      repoPath,
      parentJobId: invocationWithOptions.parentJobId,
      eveApiUrl: loadConfig().EVE_API_URL,
      jobUserHome,
      adapterEnv,
    });

    return { startTime, logs, processEnv };
  }

  /** Construct the EveMessageRelay, with chat delivery context when chat-originated. */
  private async createMessageRelay(ctx: InlineExecContext): Promise<EveMessageRelay> {
    const { invocationWithOptions } = ctx;

    // Construct EveMessageRelay with chat context if this is a chat-originated job
    let chatDeliveryCtx: ChatDeliveryContext | null = null;
    try {
      const jobRow = await this.db<{ hints: Record<string, unknown> | null; labels: string[] | null }[]>`
        SELECT hints, labels FROM jobs WHERE id = ${invocationWithOptions.jobId}
      `;
      const jobHints = jobRow[0]?.hints ?? {};
      const jobLabels = jobRow[0]?.labels ?? [];
      if (jobLabels.includes('chat') && typeof jobHints.thread_id === 'string') {
        chatDeliveryCtx = {
          threadId: jobHints.thread_id as string,
          projectId: invocationWithOptions.projectId,
        };
      }
    } catch (err) {
      console.warn(`[eve-message] Failed to look up chat context: ${err instanceof Error ? err.message : String(err)}`);
    }

    const relayDb = this.buildRelayDb();
    return new EveMessageRelay(
      relayDb,
      invocationWithOptions.jobId,
      invocationWithOptions.parentJobId ?? null,
      invocationWithOptions.agentId ?? null,
      chatDeliveryCtx,
    );
  }

  /**
   * Spawn the harness process, stream/persist its output, enforce budget,
   * relay eve-messages, and resolve the harness result.
   */
  private async runHarness(
    ctx: InlineExecContext,
    plan: HarnessExecutionPlan,
    setup: HarnessProcessSetup,
    messageRelay: EveMessageRelay,
    repoPath: string,
  ): Promise<HarnessResult> {
    const { invocationWithOptions, lifecycleLogger } = ctx;
    const { isClaudeHarness, claudeAuthDecision, harnessOptionsResolved, harnessBinary, harnessArgs } = plan;
    const { startTime, logs, processEnv } = setup;

    // Gap #1: Resolve budget enforcement config
    const budgetDb = this.buildBudgetDb();
    const budgetConfig = await resolveBudgetEnforcementConfig(budgetDb, invocationWithOptions).catch(err => {
      console.warn(`[budget] Failed to resolve budget config: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

    // Gap #7: Log harness start lifecycle event
    await logHarnessStart(lifecycleLogger, invocationWithOptions.attemptId, {
      harness: harnessOptionsResolved.harness,
      permission: harnessOptionsResolved.permission,
      variant: harnessOptionsResolved.variant,
      model: harnessOptionsResolved.model,
      reasoning: harnessOptionsResolved.reasoning,
    });

    const logSink = this.buildLogSink();
    let claudeApiKeySource: string | null = null;
    let claudeAuthFailureCandidate: { reason: string; apiKeySource?: string } | null = null;
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

    let claudeAuthFailureMessage: string | undefined;
    return await new Promise<HarnessResult>((resolve) => {
      const child = spawn(harnessBinary.binary, [...harnessBinary.prefixArgs, ...harnessArgs], {
        cwd: repoPath,
        env: processEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Emit periodic heartbeat lifecycle logs so `eve job diagnose` can detect stuck processes
      const harnessStartTime = Date.now();
      const heartbeatInterval = setInterval(async () => {
        if (invocationWithOptions.attemptId) {
          await lifecycleLogger(
            invocationWithOptions.attemptId,
            'runner',
            'log',
            {
              kind: 'heartbeat',
              elapsed_ms: Date.now() - harnessStartTime,
              harness: harnessOptionsResolved.harness,
              pid: child.pid,
            },
          );
        }
      }, 30_000);

      // Gap #1: Set up budget enforcer after spawn
      let budgetEnforcer: BudgetEnforcer | null = null;
      if (budgetConfig) {
        budgetEnforcer = new BudgetEnforcer(budgetConfig, logSink, invocationWithOptions.attemptId, () => {
          try { child.kill('SIGTERM'); } catch { /* process may have already exited */ }
          setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignored */ } }, 5000);
        });
        budgetEnforcer.startPeriodicCheck();
      }

      const rl = readline.createInterface({ input: child.stdout });
      let logChain: Promise<void> = Promise.resolve();
      const enqueue = (fn: () => Promise<void>) => {
        logChain = logChain.then(fn).catch((err) => {
          console.error('Failed processing harness log line', err);
        });
      };
      const stdoutClosed = new Promise<void>((resolveClosed) => rl.on('close', () => resolveClosed()));

      rl.on('line', (line) => {
        if (!line.trim()) return;

        enqueue(async () => {
          try {
            const parsed = JSON.parse(line);
            const logType = (parsed as { type?: string }).type ?? 'event';
            logs.push({ type: logType, content: parsed as Record<string, unknown> });
            if (invocationWithOptions.attemptId) {
              await this.logs.appendLog(invocationWithOptions.attemptId!, logType, parsed);
            }
            await maybeRecordClaudeAuthFailure(parsed);

            // Gap #1: Feed llm.call events to budget enforcer
            if (budgetEnforcer && logType === 'llm.call') {
              await budgetEnforcer.processLlmCall(parsed as Record<string, unknown>);
            }

            // Scan for eve-message blocks in assistant text
            await messageRelay.processEvent(parsed as Record<string, unknown>);
          } catch (parseError) {
            // Non-JSON line — check for raw eve-message fenced blocks
            await messageRelay.processLine(line);
            await maybeRecordClaudeAuthFailure(line, 'stdout');

            if (invocationWithOptions.attemptId) {
              await this.logs.appendLog(invocationWithOptions.attemptId!, 'parse_error', {
                content: line,
                error: parseError instanceof Error ? parseError.message : String(parseError),
              });
            }
          }
        });
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (invocationWithOptions.attemptId) {
          enqueue(async () => {
            await maybeRecordClaudeAuthFailure(text, 'stderr');
            await this.logs.appendLog(invocationWithOptions.attemptId!, 'system_error', {
              content: text,
            });
          });
        }
      });

      child.on('error', async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        clearInterval(heartbeatInterval);
        budgetEnforcer?.stop();
        await budgetEnforcer?.appendSummary('spawn_error');
        if (invocationWithOptions.attemptId) {
          enqueue(async () => {
            await this.logs.appendLog(invocationWithOptions.attemptId!, 'spawn_error', {
              error: msg,
            });
          });
        }
        resolve({
          attemptId: invocationWithOptions.attemptId,
          success: false,
          exitCode: 1,
          error: `Harness spawn failed: ${msg}`,
        });
      });

      child.on('close', async (code) => {
        clearInterval(heartbeatInterval);
        budgetEnforcer?.stop();
        await stdoutClosed;
        await logChain;
        await budgetEnforcer?.appendSummary('final');

        const durationMs = Date.now() - startTime;

        if (code !== 0 && claudeAuthFailureCandidate) {
          claudeAuthFailureMessage = await this.emitClaudeAuthFailed(
            invocationWithOptions,
            claudeAuthDecision,
            claudeAuthFailureCandidate,
            claudeApiKeySource,
          );
        }

        // Gap #5/#6: Use shared extractResults for Codex + error support
        const extracted = extractResults(logs);
        let errorMessage = code === 0
          ? undefined
          : (extracted.errorMessage || `Harness exited with code ${code}`);
        if (code !== 0 && claudeAuthFailureMessage) {
          errorMessage = extracted.errorMessage
            ? `${extracted.errorMessage}\n\n${claudeAuthFailureMessage}`
            : claudeAuthFailureMessage;
        }

        // Gap #1: Check budget enforcement result
        if (budgetEnforcer?.exceeded) {
          errorMessage = budgetEnforcer.exceededError ?? 'Budget exceeded';
          if (code === 0) code = 1;
        }

        // Gap #7: Log harness end lifecycle event
        await logHarnessEnd(lifecycleLogger, invocationWithOptions.attemptId, {
          harness: harnessOptionsResolved.harness,
          permission: harnessOptionsResolved.permission,
          reasoning: harnessOptionsResolved.reasoning,
          exit_code: code ?? 1,
        }, durationMs, errorMessage);

        resolve({
          attemptId: invocationWithOptions.attemptId,
          success: code === 0 && !budgetEnforcer?.exceeded,
          exitCode: code ?? 1,
          resultText: extracted.resultText,
          resultJson: extracted.resultJson,
          durationMs,
          tokenInput: extracted.tokenInput,
          tokenOutput: extracted.tokenOutput,
          error: errorMessage,
        });
      });
    });
  }

  /** Codex auth write-back, git commit/push policies, and the release hook. */
  private async finalizeExecution(
    ctx: InlineExecContext,
    plan: HarnessExecutionPlan,
    result: HarnessResult,
    prepared: PreparedRepo,
    env: NodeJS.ProcessEnv,
    secretsFilePath: string | null,
  ): Promise<void> {
    const { invocationWithOptions, gitConfig, lifecycleLogger } = ctx;
    const { originalCodexB64, codexScopeType, codexScopeId, harnessOptionsResolved } = plan;
    const { repoPath, gitWorkspace } = prepared;

    // Write back refreshed Codex auth.json if the token was refreshed during execution
    if (originalCodexB64 && codexScopeType && codexScopeId) {
      const codexHome = harnessOptionsResolved.env?.CODEX_HOME;
      await writeBackCodexAuth(originalCodexB64, codexScopeType, codexScopeId, codexHome);
    }

    // Git policies: auto-commit and push after harness execution
    if (gitWorkspace && gitConfig) {
      try {
        await handleCommitPolicy(gitWorkspace, gitConfig, invocationWithOptions.jobId, result.success);
        await handlePushPolicy(gitWorkspace, gitConfig, result.success);
      } catch (gitError) {
        const msg = gitError instanceof Error ? gitError.message : String(gitError);
        console.error(`[git-policy] ${msg}`);
        result.success = false;
        result.error = result.error ? `${result.error}; ${msg}` : msg;
      }

      if (invocationWithOptions.attemptId) {
        const updateFn = async (attemptId: string, gitMeta: Record<string, unknown>) => {
          await this.db`
            UPDATE job_attempts
            SET git_json = ${this.db.json(gitMeta as never)}::jsonb
            WHERE id = ${attemptId}::uuid
          `;
        };
        await updateAttemptGitMeta(updateFn, invocationWithOptions.attemptId, gitWorkspace.getResolvedMetadata());
      }
    }

    await runReleaseHook(repoPath, env, secretsFilePath, lifecycleLogger, invocationWithOptions.attemptId);
  }

  // ---------------------------------------------------------------------------
  // Harness binary resolution and argument building
  // ---------------------------------------------------------------------------

  private resolveHarnessBinary(): { binary: string; prefixArgs: string[] } {
    if (process.env.EVE_AGENT_CLI_PATH) {
      return { binary: process.env.EVE_AGENT_CLI_PATH, prefixArgs: [] };
    }

    const bundledCli = '/app/packages/eve-agent-cli/bin/eve-agent-cli.js';
    if (fsSync.existsSync(bundledCli)) {
      return { binary: bundledCli, prefixArgs: [] };
    }

    return { binary: 'eve-agent-cli', prefixArgs: [] };
  }

  private buildHarnessArgs(options: {
    harness: HarnessName;
    permission: PermissionPolicy;
    variant?: string;
    model?: string;
    reasoning?: string;
    workspace: string;
    prompt: string;
  }): string[] {
    const args: string[] = [
      '--harness',
      options.harness,
      '--permission',
      options.permission,
      '--output-format',
      'stream-json',
      '--workspace',
      options.workspace,
      '--prompt',
      options.prompt,
    ];
    if (options.variant) args.push('--variant', options.variant);
    if (options.model) args.push('--model', options.model);
    if (options.reasoning) args.push('--reasoning', options.reasoning);
    return args;
  }

  // ---------------------------------------------------------------------------
  // Workspace preparation
  // ---------------------------------------------------------------------------

  private async prepareWorkspace(
    invocation: HarnessInvocation,
    gitAuth?: { cloneUrl?: string; env?: NodeJS.ProcessEnv },
  ): Promise<{ repoPath: string; hadRepoPath: boolean }> {
    const workspacePath = invocation.workspacePath;
    const repoPath = path.join(workspacePath, 'repo');

    await fs.mkdir(workspacePath, { recursive: true });

    let hadRepoPath = false;
    try {
      await fs.stat(repoPath);
      hadRepoPath = true;
    } catch {
      // repo doesn't exist
    }

    if (!hadRepoPath) {
      if (!invocation.repoUrl) {
        throw new Error('Missing repoUrl');
      }

      const localRepo = getLocalRepoPath(invocation.repoUrl);
      if (process.env.EVE_RUNTIME === 'k8s' && localRepo) {
        throw new Error('file:// repo URLs are not supported in k8s runtime');
      }

      if (localRepo) {
        console.log(`Copying local repository from ${localRepo} to ${repoPath}`);
        const stats = await fs.stat(localRepo);
        if (!stats.isDirectory()) {
          throw new Error('file:// path is not a directory');
        }
        await fs.cp(localRepo, repoPath, { recursive: true });
      } else {
        const cloneUrl = gitAuth?.cloneUrl ?? invocation.repoUrl;
        const cloneArgs = ['clone', '--depth', '1'];
        if (invocation.repoBranch) {
          cloneArgs.push('--branch', invocation.repoBranch);
        }
        cloneArgs.push('--', cloneUrl, repoPath);

        console.log(`Cloning repo ${redactRepoUrl(cloneUrl)} to ${repoPath}`);
        const result = await runGit(cloneArgs, { env: gitAuth?.env });
        if (result.stderr) {
          console.warn(`git clone stderr: ${result.stderr}`);
        }
      }
    }

    // Only attempt git operations for non-file URLs.
    if (invocation.repoBranch && !getLocalRepoPath(invocation.repoUrl ?? '')) {
      await runGit(['checkout', invocation.repoBranch], { cwd: repoPath, env: gitAuth?.env });
    }

    return { repoPath, hadRepoPath };
  }

  private async prepareWorkspaceWithGitControls(
    invocation: HarnessInvocation,
    gitAuth?: { cloneUrl?: string; env?: NodeJS.ProcessEnv },
  ): Promise<{ repoPath: string; gitWorkspace: GitWorkspace; hadRepoPath: boolean }> {
    if (!invocation.repoUrl) {
      throw new Error('Missing repoUrl');
    }

      const gitConfig = invocation.git as JobGit | undefined;
      const gitWorkspace = new GitWorkspace({
        repoUrl: invocation.repoUrl,
        workspacePath: invocation.workspacePath,
        gitAuth: gitAuth as GitWorkspaceAuth,
        gitConfig,
        gitUser: {
          name: 'Eve Bot',
          email: 'eve@example.com',
        },
        defaultBranch: invocation.repoBranch ?? 'main',
      });

    const repoPath = gitWorkspace.getRepoPath();
    const hadRepoPath = await this.pathExists(repoPath);

    // Resolve the target ref for clone/checkout
    const targetRef = gitConfig?.ref ?? invocation.repoBranch ?? 'main';
    const refSource: 'explicit' | 'project_default' = gitConfig?.ref ? 'explicit' : 'project_default';

    if (!hadRepoPath) {
      await gitWorkspace.init(targetRef);
    }

    // Handle branch creation if specified
    if (gitConfig?.branch) {
      const sha = await gitWorkspace.resolveRef(targetRef);
      gitWorkspace.setResolvedMetadata({ ref: targetRef, sha, refSource });

      // Checkout base ref first, then create the target branch
      await gitWorkspace.checkout(targetRef);
      const createPolicy = gitConfig.create_branch ?? 'if_missing';
      await gitWorkspace.createBranch(gitConfig.branch, targetRef, createPolicy);
    } else {
      // Just checkout the resolved ref
      const sha = await gitWorkspace.resolveRef(targetRef);
      gitWorkspace.setResolvedMetadata({ ref: targetRef, sha, refSource });
      await gitWorkspace.checkout(targetRef);
    }

    return { repoPath, gitWorkspace, hadRepoPath };
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // K8s runtime decisions
  // ---------------------------------------------------------------------------

  private shouldRunInK8sRunnerPod(): boolean {
    if (process.env.EVE_RUNTIME !== 'k8s') {
      return false;
    }

    const mode = (process.env.EVE_AGENT_RUNTIME_EXECUTION_MODE ?? 'inline').trim().toLowerCase();
    return mode === 'runner';
  }

  private currentRuntimeMeta(): Record<string, unknown> {
    return {
      runtime: 'agent-runtime',
      pod_name: process.env.AGENT_RUNTIME_POD_NAME ?? process.env.HOSTNAME ?? 'agent-runtime',
      namespace: process.env.EVE_K8S_NAMESPACE ?? DEFAULT_K8S_NAMESPACE,
    };
  }
}
