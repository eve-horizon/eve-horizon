import { Injectable, Inject, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { Db } from '@eve/db';
import {
  environmentQueries,
  executionLogQueries,
  orgQueries,
  pipelineRunQueries,
  projectManifestQueries,
  projectQueries,
  releaseQueries,
} from '@eve/db';
import {
  buildAuthenticatedHttpsUrl,
  generateReleaseId,
  resolveProjectSecrets,
} from '@eve/shared';
import * as yaml from 'yaml';
import { DeployerService } from '../deployer/deployer.service';
import { K8sOperationError } from '../deployer/k8s-error.js';

const execFileAsync = promisify(execFile);

function extractErrorContext(error: unknown): Record<string, unknown> {
  if (error instanceof K8sOperationError) {
    return {
      error_context: {
        kind: 'k8s_api_error',
        status_code: error.statusCode,
        reason: error.reason,
        operation: error.operation,
        resource_kind: error.resourceKind,
        resource_name: error.resourceName,
        namespace: error.namespace,
      },
    };
  }
  return {};
}

type PipelineContext = {
  image_digests?: Record<string, string>;
  release_id?: string;
  image_tag?: string;
};

type ManifestShape = {
  environments?: Record<string, { approval?: string }>;
  tests?: Record<string, { command?: string }>;
  services?: Record<string, { image?: string }>;
};

type CreatePrInput = {
  repo?: string;
  head?: string;
  base?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  dry_run?: boolean;
};

function normalizeRepoSlug(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const githubMatch = trimmed.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (githubMatch && githubMatch[1]) {
    return githubMatch[1];
  }

  const simpleMatch = trimmed.replace(/\.git$/, '').split('/');
  if (simpleMatch.length >= 2) {
    return `${simpleMatch[simpleMatch.length - 2]}/${simpleMatch[simpleMatch.length - 1]}`;
  }

  return null;
}

function resolveRepoSlug(inputRepo?: string, repoUrl?: string | null): string {
  const candidates = [inputRepo, repoUrl].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const slug = normalizeRepoSlug(candidate);
    if (slug) return slug;
  }
  throw new Error('Create PR action requires repo (owner/name) or project repo_url');
}

@Injectable()
export class PipelineRunnerService {
  private readonly logger = new Logger(PipelineRunnerService.name);
  private runs: ReturnType<typeof pipelineRunQueries>;
  private envs: ReturnType<typeof environmentQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private releases: ReturnType<typeof releaseQueries>;
  private logs: ReturnType<typeof executionLogQueries>;
  private orgs: ReturnType<typeof orgQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly deployer: DeployerService,
  ) {
    this.runs = pipelineRunQueries(db);
    this.envs = environmentQueries(db);
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
    this.releases = releaseQueries(db);
    this.logs = executionLogQueries(db);
    this.orgs = orgQueries(db);
  }

  async executeRun(runId: string): Promise<{ success: boolean; error?: string }> {
    const run = await this.runs.findRunById(runId);
    if (!run) {
      return { success: false, error: `Pipeline run ${runId} not found` };
    }

    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      return { success: true };
    }

    const manifest = await this.resolveManifest(run.project_id, run.manifest_hash);
    const steps = await this.runs.listStepRuns(runId);
    const inputs = run.inputs_json ?? {};
    const context: PipelineContext = {
      image_tag: typeof inputs.tag === 'string' ? inputs.tag : undefined,
    };
    const approvedEnvs = this.resolveApprovedEnvs(inputs);

    if (!run.started_at || run.status !== 'running') {
      await this.runs.updateRun(runId, { status: 'running', started_at: run.started_at ?? new Date() });
    }

    for (const step of steps) {
      if (step.status === 'succeeded') {
        continue;
      }

      if (step.status === 'blocked' && run.status === 'awaiting_approval') {
        return { success: true };
      }

      const startedAt = new Date();
      await this.runs.updateStepRun(step.id, { status: 'running', started_at: startedAt });
      await this.appendLog(step.id, 'status', { message: `Step ${step.step_name} started`, timestamp: startedAt.toISOString() });

      try {
        if (step.step_type === 'build') {
          await this.handleBuild(step.id, manifest, context);
        } else if (step.step_type === 'release') {
          await this.handleRelease(step.id, run, context);
        } else if (step.step_type === 'deploy') {
          const approvalRequired = this.isApprovalRequired(manifest, run.env_name);
          if (approvalRequired && !approvedEnvs.includes(run.env_name ?? '')) {
            await this.runs.updateStepRun(step.id, { status: 'blocked' });
            await this.runs.updateRun(runId, { status: 'awaiting_approval' });
            await this.appendLog(step.id, 'status', {
              message: `Deployment awaiting approval for env ${run.env_name}`,
              timestamp: new Date().toISOString(),
            });
            return { success: true };
          }

          await this.handleDeploy(step.id, run, context, step.input_json ?? {});
        } else if (step.step_type === 'run') {
          await this.handleRun(step.id, run, manifest, step.input_json ?? {});
        } else if (step.step_type === 'job') {
          const action = step.input_json ?? {};
          const envName = typeof action.env_name === 'string' ? action.env_name : run.env_name;
          const approvalRequired = this.isApprovalRequired(manifest, envName ?? null);
          const gateEnv = envName ?? null;
          if (approvalRequired && gateEnv && !approvedEnvs.includes(gateEnv)) {
            await this.runs.updateStepRun(step.id, { status: 'blocked' });
            await this.runs.updateRun(runId, { status: 'awaiting_approval' });
            await this.appendLog(step.id, 'status', {
              message: `Job awaiting approval for env ${gateEnv}`,
              timestamp: new Date().toISOString(),
            });
            return { success: true };
          }

          await this.handleJob(step.id, run, context, action);
        } else if (step.step_type === 'create-pr') {
          await this.handleCreatePr(step.id, run, step.input_json ?? {});
        } else {
          throw new Error(`Unsupported step type: ${step.step_type}`);
        }

        const completedAt = new Date();
        await this.runs.updateStepRun(step.id, { status: 'succeeded', completed_at: completedAt });
        await this.appendLog(step.id, 'status', { message: `Step ${step.step_name} succeeded`, timestamp: completedAt.toISOString() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        const errorClass = error instanceof Error ? error.constructor.name : typeof error;
        const errorContext = extractErrorContext(error);
        const completedAt = new Date();

        this.logger.error(
          `Pipeline step ${step.step_type} (${step.step_name}) failed: ${message}`,
          stack,
          JSON.stringify({
            run_id: runId,
            step_id: step.id,
            step_type: step.step_type,
            error_class: errorClass,
            ...errorContext,
          }),
        );

        await this.runs.updateStepRun(step.id, {
          status: 'failed',
          completed_at: completedAt,
          error_message: message,
        });

        await this.runs.updateRun(runId, {
          status: 'failed',
          completed_at: completedAt,
          error_message: message,
        });

        await this.appendLog(step.id, 'error', {
          message,
          timestamp: completedAt.toISOString(),
          error_class: errorClass,
          ...errorContext,
        });
        return { success: false, error: message };
      }
    }

    const completedAt = new Date();
    await this.runs.updateRun(runId, { status: 'succeeded', completed_at: completedAt });
    return { success: true };
  }

  private async handleBuild(stepId: string, manifest: ManifestShape, context: PipelineContext): Promise<void> {
    this.logger.error('Legacy handleBuild called — pipeline runs must use job-based execution');
    await this.appendLog(stepId, 'error', {
      message: 'Legacy build path invoked; no images were built. Use job-based pipeline execution.',
      timestamp: new Date().toISOString(),
    });
    throw new Error('Legacy pipeline build path is disabled; use job-based execution.');
  }

  private async handleRelease(stepId: string, run: { project_id: string; git_sha: string | null; manifest_hash: string | null }, context: PipelineContext): Promise<void> {
    if (!run.git_sha || !run.manifest_hash) {
      throw new Error('Release action missing git_sha or manifest_hash');
    }

    const project = await this.projects.findById(run.project_id);
    if (!project?.repo_url) {
      throw new Error(`Release action requires project repo_url (project ${run.project_id})`);
    }

    const workspace = await this.prepareWorkspace(project.repo_url, run.git_sha, run.project_id);
    let version: string | null = null;
    let tag: string | null = null;

    try {
      const result = await this.computeNextVersion(workspace, run.git_sha);
      version = result.version;
      tag = result.tag;

      try {
        await execFileAsync('git', ['tag', '-a', tag, '-m', `Release ${tag}`], {
          cwd: workspace,
          env: process.env,
          maxBuffer: 1024 * 1024,
        });
      } catch (error) {
        await this.appendLog(stepId, 'status', {
          message: `Warning: failed to create git tag ${tag}: ${error instanceof Error ? error.message : 'unknown error'}`,
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      await this.cleanupWorkspace(workspace);
    }

    const releaseId = generateReleaseId();
    const release = await this.releases.create({
      id: releaseId,
      project_id: run.project_id,
      git_sha: run.git_sha,
      manifest_hash: run.manifest_hash,
      image_digests_json: context.image_digests ?? null,
      build_id: null,
      version,
      tag,
      created_by: null,
    });

    context.release_id = release.id;
    await this.runs.updateStepRun(stepId, {
      output_json: { release_id: release.id, image_digests: context.image_digests ?? null },
      result_text: `Release ${release.id} created`,
    });
  }

  private async handleDeploy(
    stepId: string,
    run: { project_id: string; env_name: string | null },
    context: PipelineContext,
    action: Record<string, unknown>,
  ): Promise<void> {
    if (!run.env_name) {
      throw new Error('Deploy action requires env_name');
    }

    if (!context.release_id) {
      throw new Error('Deploy action requires release_id from previous step');
    }

    const environment = await this.envs.findByProjectAndName(run.project_id, run.env_name);
    if (!environment) {
      throw new Error(`Environment ${run.env_name} not found for project ${run.project_id}`);
    }

    const deployStatus = await this.deployer.deploy(environment.id, context.release_id, {
      imageTag: context.image_tag,
    });
    const timeout = this.resolveTimeout(action, 180);

    await this.appendLog(stepId, 'status', {
      message: `Deployment started; waiting up to ${timeout}s for readiness`,
      timestamp: new Date().toISOString(),
    });

    const finalStatus = deployStatus.k8sStatus?.ready
      ? deployStatus
      : await this.waitForDeployReady(environment.id, timeout, stepId);

    await this.runs.updateStepRun(stepId, {
      output_json: { deployment: finalStatus },
      result_text: `Deployed release ${context.release_id} to ${run.env_name}`,
    });
  }

  private async handleRun(
    stepId: string,
    run: { project_id: string; git_sha: string | null; env_name: string | null },
    manifest: ManifestShape,
    action: Record<string, unknown>,
  ): Promise<void> {
    const commandRef = typeof action.command_ref === 'string' ? action.command_ref : null;
    const command = typeof action.command === 'string'
      ? action.command
      : commandRef
        ? manifest.tests?.[commandRef]?.command ?? null
        : null;

    if (!command) {
      throw new Error('Run action missing command');
    }

    const project = await this.projects.findById(run.project_id, { include_deleted: true });
    if (!project) {
      throw new Error(`Project ${run.project_id} not found`);
    }

    const repoUrl = project.repo_url;
    if (!repoUrl) {
      throw new Error(`Project ${run.project_id} missing repo_url`);
    }

    if (!run.git_sha) {
      throw new Error('Run action requires git_sha');
    }

    const envNamespace = await this.resolveEnvNamespace(run.project_id, run.env_name ?? undefined);
    const workspace = await this.prepareWorkspace(repoUrl, run.git_sha, run.project_id);
    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
        cwd: workspace,
        env: {
          ...process.env,
          ...(run.env_name ? { EVE_ENV_NAME: run.env_name } : {}),
          ...(envNamespace ? { EVE_ENV_NAMESPACE: envNamespace } : {}),
        },
        maxBuffer: 1024 * 1024,
      });

      await this.runs.updateStepRun(stepId, {
        output_json: {
          command_ref: commandRef,
          command,
          stdout,
          stderr,
          exit_code: 0,
        },
        result_text: stdout?.trim() || 'Run action completed',
      });

      if (stdout) {
        await this.appendLog(stepId, 'output', {
          stream: 'stdout',
          text: stdout,
          timestamp: new Date().toISOString(),
        });
      }

      if (stderr) {
        await this.appendLog(stepId, 'output', {
          stream: 'stderr',
          text: stderr,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
      const message = err.message || 'Run action failed';
      await this.runs.updateStepRun(stepId, {
        output_json: {
          command_ref: commandRef,
          command,
          stdout: err.stdout,
          stderr: err.stderr,
          exit_code: err.code ?? 1,
        },
        error_message: message,
      });

      if (err.stdout) {
        await this.appendLog(stepId, 'output', {
          stream: 'stdout',
          text: err.stdout,
          timestamp: new Date().toISOString(),
        });
      }

      if (err.stderr) {
        await this.appendLog(stepId, 'output', {
          stream: 'stderr',
          text: err.stderr,
          timestamp: new Date().toISOString(),
        });
      }

      throw new Error(message);
    } finally {
      await this.cleanupWorkspace(workspace);
    }
  }

  private async handleJob(
    stepId: string,
    run: { project_id: string; env_name: string | null; manifest_hash: string | null },
    context: PipelineContext,
    action: Record<string, unknown>,
  ): Promise<void> {
    const envName = typeof action.env_name === 'string' ? action.env_name : run.env_name;
    if (!envName) {
      throw new Error('Job action requires env_name');
    }

    const service = typeof action.service === 'string' ? action.service : null;
    if (!service) {
      throw new Error('Job action requires service');
    }

    if (!run.manifest_hash) {
      throw new Error('Job action requires manifest_hash');
    }

    const manifest = await this.manifests.findByProjectAndHash(run.project_id, run.manifest_hash);
    if (!manifest) {
      throw new Error(`Manifest ${run.manifest_hash} not found for project ${run.project_id}`);
    }

    const timeoutSeconds = this.resolveTimeout(action, 300);

    await this.appendLog(stepId, 'status', {
      message: `Running job service ${service} in ${envName}`,
      timestamp: new Date().toISOString(),
    });

    const result = await this.deployer.runJobService({
      projectId: run.project_id,
      envName,
      manifestYaml: manifest.manifest_yaml,
      serviceName: service,
      attemptId: stepId,
      releaseId: context.release_id ?? null,
      imageDigests: context.image_digests,
      imageTag: context.image_tag,
      timeoutSeconds,
    });

    if (result.logs) {
      await this.appendLog(stepId, 'output', {
        stream: 'job',
        text: result.logs,
        timestamp: new Date().toISOString(),
      });
    }

    if (!result.success) {
      throw new Error(`Job service ${service} failed`);
    }

    await this.runs.updateStepRun(stepId, {
      output_json: {
        job_name: result.jobName,
        service,
        exit_code: result.exitCode,
      },
      result_text: `Job service ${service} completed`,
    });
  }

  private async handleCreatePr(
    stepId: string,
    run: { project_id: string },
    action: Record<string, unknown>,
  ): Promise<void> {
    const input = action as CreatePrInput;
    const project = await this.projects.findById(run.project_id, { include_deleted: true });
    const repoSlug = resolveRepoSlug(input.repo, project?.repo_url ?? null);
    const head = input.head;
    const base = input.base ?? 'main';
    const title = input.title ?? `Remediation for ${run.project_id}`;
    const body = input.body ?? '';
    const draft = input.draft ?? false;
    const dryRun = input.dry_run ?? false;

    if (!head) {
      throw new Error('Create PR action requires head branch');
    }

    await this.appendLog(stepId, 'status', {
      message: `Creating PR ${repoSlug} ${head} -> ${base}`,
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
    });

    if (dryRun) {
      await this.runs.updateStepRun(stepId, {
        output_json: { repo: repoSlug, head, base, title, draft, dry_run: true },
        result_text: 'Create PR dry-run completed',
      });
      return;
    }

    const token = process.env.EVE_GITHUB_TOKEN;
    if (!token) {
      throw new Error('Create PR action requires EVE_GITHUB_TOKEN');
    }

    const response = await fetch(`https://api.github.com/repos/${repoSlug}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        'User-Agent': 'eve-horizon',
      },
      body: JSON.stringify({
        title,
        head,
        base,
        body,
        draft,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`GitHub create PR failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { html_url?: string; number?: number; id?: number };
    await this.runs.updateStepRun(stepId, {
      output_json: {
        pr_url: data.html_url ?? null,
        pr_number: data.number ?? null,
        pr_id: data.id ?? null,
        repo: repoSlug,
        head,
        base,
        title,
        draft,
      },
      result_text: data.html_url ? `Created PR ${data.html_url}` : 'Create PR action completed',
    });

    await this.appendLog(stepId, 'output', {
      pr_url: data.html_url ?? null,
      pr_number: data.number ?? null,
      pr_id: data.id ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  private resolveTimeout(action: Record<string, unknown>, fallbackSeconds: number): number {
    const raw = action.timeout;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
    return fallbackSeconds;
  }

  private async waitForDeployReady(envId: string, timeoutSeconds: number, stepId: string) {
    const start = Date.now();
    let lastStatus = await this.deployer.getDeploymentStatus(envId);

    while (!lastStatus.k8sStatus?.ready && Date.now() - start < timeoutSeconds * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      lastStatus = await this.deployer.getDeploymentStatus(envId);
      await this.appendLog(stepId, 'status', {
        message: `Deployment status: ${lastStatus.k8sStatus?.availableReplicas ?? 0}/${
          lastStatus.k8sStatus?.desiredReplicas ?? 0
        } ready`,
        timestamp: new Date().toISOString(),
      });
    }

    if (!lastStatus.k8sStatus?.ready) {
      throw new Error(`Deployment did not become ready within ${timeoutSeconds}s`);
    }

    await this.appendLog(stepId, 'status', {
      message: 'Deployment ready',
      timestamp: new Date().toISOString(),
    });

    return lastStatus;
  }

  private async resolveEnvNamespace(projectId: string, envName?: string): Promise<string | null> {
    if (!envName) {
      return null;
    }

    const environment = await this.envs.findByProjectAndName(projectId, envName);
    if (!environment) {
      return null;
    }

    if (environment.namespace) {
      return this.toK8sName(environment.namespace);
    }

    const project = await this.projects.findById(projectId, { include_deleted: true });
    if (!project) {
      return null;
    }

    const org = await this.orgs.findById(project.org_id);
    if (!org) {
      return null;
    }

    return this.toK8sName(`eve-${org.slug}-${project.slug}-${environment.name}`);
  }

  private toK8sName(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .replace(/--+/g, '-');

    if (!normalized) {
      throw new Error(`Invalid namespace name: ${value}`);
    }

    return normalized.length > 63 ? normalized.slice(0, 63).replace(/-+$/, '') : normalized;
  }

  private async prepareWorkspace(repoUrl: string, gitSha: string, projectId?: string): Promise<string> {
    const cloneUrl = projectId ? await this.injectGitAuth(repoUrl, projectId) : repoUrl;
    const workspace = await fs.mkdtemp(join(tmpdir(), 'eve-pipeline-'));
    const safeUrl = cloneUrl.replace(/\/\/[^@]+@/, '//***@');

    try {
      await execFileAsync('git', ['clone', '--no-checkout', cloneUrl, workspace], {
        env: process.env,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Authentication') || errMsg.includes('could not read Username') || errMsg.includes('fatal: repository')) {
        throw new Error(
          `Git clone failed (authentication): ${errMsg}. ` +
          `Check that GITHUB_TOKEN is set for this project via 'eve secrets set'.`
        );
      }
      throw new Error(`Git clone failed for ${safeUrl}: ${errMsg}`);
    }

    await execFileAsync('git', ['checkout', gitSha], {
      cwd: workspace,
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    return workspace;
  }

  private async injectGitAuth(repoUrl: string, projectId: string): Promise<string> {
    if (!repoUrl.startsWith('http')) return repoUrl;
    try {
      const result = await resolveProjectSecrets(projectId);

      if (!result.resolved) {
        this.logger.error(
          `Cannot resolve secrets for git auth: ${result.error}. ` +
          `Clone of ${repoUrl} will proceed without authentication.`
        );
      }

      const token =
        result.secrets.find((s) => s.type === 'github_token') ??
        result.secrets.find((s) => ['GITHUB_TOKEN', 'GH_TOKEN'].includes(s.key));

      if (!token) {
        try {
          const url = new URL(repoUrl);
          if (url.hostname.includes('github.com')) {
            this.logger.warn(
              `No GITHUB_TOKEN found for project ${projectId}. ` +
              `If ${repoUrl} is private, clone will fail. ` +
              `Set GITHUB_TOKEN via: eve secrets set GITHUB_TOKEN <value> --project <id>`
            );
          }
        } catch { /* invalid URL — not a github URL */ }
        return repoUrl;
      }

      return buildAuthenticatedHttpsUrl(repoUrl, token.value);
    } catch (err) {
      this.logger.warn(`Git auth injection failed: ${err instanceof Error ? err.message : err}`);
    }
    return repoUrl;
  }

  private async computeNextVersion(workspace: string, gitSha: string): Promise<{ version: string; tag: string }> {
    const lastTag = await this.getLastTag(workspace, gitSha);
    const baseVersion = this.parseSemver(lastTag);

    const range = lastTag ? `${lastTag}..${gitSha}` : gitSha;
    const commitsRaw = await this.gitLog(workspace, range);
    const bump = this.determineBump(commitsRaw);

    const nextVersion = this.bumpVersion(baseVersion, bump);
    const version = nextVersion ?? '0.1.0';
    return { version, tag: `v${version}` };
  }

  private async getLastTag(workspace: string, gitSha: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['describe', '--tags', '--abbrev=0', gitSha], {
        cwd: workspace,
        env: process.env,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async gitLog(workspace: string, range: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--no-merges', '--pretty=format:%s%n%b%n----END----', range],
      {
        cwd: workspace,
        env: process.env,
        maxBuffer: 1024 * 1024,
      },
    );
    return stdout.split('----END----').map((entry) => entry.trim()).filter(Boolean);
  }

  private determineBump(commits: string[]): 'major' | 'minor' | 'patch' {
    let hasMinor = false;
    let hasPatch = false;

    for (const entry of commits) {
      const lines = entry.split('\n');
      const header = lines[0]?.trim() ?? '';
      const body = lines.slice(1).join('\n');

      if (/BREAKING CHANGE/i.test(body) || /^[a-zA-Z]+(\(.+\))?!:/.test(header)) {
        return 'major';
      }

      if (/^feat(\(.+\))?:/.test(header)) {
        hasMinor = true;
      }

      if (/^(fix|perf)(\(.+\))?:/.test(header)) {
        hasPatch = true;
      }
    }

    if (hasMinor) return 'minor';
    if (hasPatch) return 'patch';
    return 'patch';
  }

  private parseSemver(tag: string | null): { major: number; minor: number; patch: number } | null {
    if (!tag) return null;
    const normalized = tag.startsWith('v') ? tag.slice(1) : tag;
    const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return null;
    return {
      major: Number.parseInt(match[1], 10),
      minor: Number.parseInt(match[2], 10),
      patch: Number.parseInt(match[3], 10),
    };
  }

  private bumpVersion(
    base: { major: number; minor: number; patch: number } | null,
    bump: 'major' | 'minor' | 'patch',
  ): string | null {
    if (!base) return null;
    if (bump === 'major') return `${base.major + 1}.0.0`;
    if (bump === 'minor') return `${base.major}.${base.minor + 1}.0`;
    return `${base.major}.${base.minor}.${base.patch + 1}`;
  }

  private async cleanupWorkspace(workspace: string): Promise<void> {
    try {
      await fs.rm(workspace, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  private async appendLog(stepId: string, type: string, content: Record<string, unknown>): Promise<void> {
    await this.logs.appendStepLog(stepId, type, content);
  }

  private async resolveManifest(projectId: string, manifestHash: string | null): Promise<ManifestShape> {
    if (!manifestHash) {
      throw new Error('Pipeline run missing manifest hash');
    }

    const manifest = await this.manifests.findByProjectAndHash(projectId, manifestHash);
    if (!manifest) {
      throw new Error(`Manifest ${manifestHash} not found for project ${projectId}`);
    }

    const parsed = yaml.parse(manifest.manifest_yaml) as ManifestShape | null;
    if (!parsed) {
      throw new Error('Manifest is empty or invalid');
    }

    return parsed;
  }

  private resolveApprovedEnvs(inputs: Record<string, unknown>): string[] {
    const approved = inputs.approved_envs;
    if (Array.isArray(approved)) {
      return approved.filter((value) => typeof value === 'string');
    }
    return [];
  }

  private isApprovalRequired(manifest: ManifestShape, envName: string | null): boolean {
    if (!envName) {
      return false;
    }
    const env = manifest.environments?.[envName];
    return env?.approval === 'required';
  }
}
