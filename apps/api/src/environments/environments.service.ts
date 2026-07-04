import { Injectable, Inject, NotFoundException, ConflictException, ServiceUnavailableException, Logger, BadRequestException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { environmentQueries, releaseQueries, projectQueries, projectManifestQueries, orgQueries, managedDbQueries, ingressAliasQueries } from '@eve/db';
import {
  generateReleaseId,
  generateEnvironmentId,
  type DeployRequest,
  type DeployResponse,
  type EnvironmentResponse,
  type ReleaseResponse,
  type CreateEnvironmentRequest,
  type UpdateEnvironmentRequest,
  type EnvironmentListResponse,
  type DeploymentStatus,
  type Manifest,
  type Environment,
  type Service,
  type ApiSpec,
  type DeleteEnvironmentRequest,
  type UndeployEnvironmentRequest,
  getServicesFromManifest,
  toK8sName,
  deriveNamespace,
} from '@eve/shared';
import * as yaml from 'yaml';
import { ApiRegistrationService } from './api-registration.service.js';
import { fileURLToPath } from 'node:url';
import { PipelineRunsService } from '../pipelines/pipeline-runs.service.js';
import { EnvDiagnosticsService } from './env-diagnostics.service.js';
import { ensureManifestEnvironment } from './manifest-environment.js';

@Injectable()
export class EnvironmentsService {
  private readonly logger = new Logger(EnvironmentsService.name);
  private environments: ReturnType<typeof environmentQueries>;
  private releases: ReturnType<typeof releaseQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private managedDb: ReturnType<typeof managedDbQueries>;
  private ingressAliases: ReturnType<typeof ingressAliasQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly apiRegistrationService: ApiRegistrationService,
    private readonly pipelineRunsService: PipelineRunsService,
    private readonly envDiagnosticsService: EnvDiagnosticsService,
  ) {
    this.environments = environmentQueries(db);
    this.releases = releaseQueries(db);
    this.projects = projectQueries(db);
    this.manifests = projectManifestQueries(db);
    this.orgs = orgQueries(db);
    this.managedDb = managedDbQueries(db);
    this.ingressAliases = ingressAliasQueries(db);
  }

  async create(
    projectId: string,
    data: CreateEnvironmentRequest,
  ): Promise<EnvironmentResponse> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Check for existing environment with same name
    const existing = await this.environments.findByProjectAndName(projectId, data.name);
    if (existing) {
      throw new ConflictException(`Environment "${data.name}" already exists for project ${projectId}`);
    }

    const environmentId = generateEnvironmentId();
    // Normalize user-supplied namespace so it matches the actual K8s namespace
    // (which is always lowercased). Sentinel + deployer both query K8s with
    // exact-case matching.
    const namespace = data.namespace ? toK8sName(data.namespace, 'namespace') : null;
    const environment = await this.environments.create({
      id: environmentId,
      project_id: projectId,
      name: data.name,
      type: data.type,
      kind: data.kind ?? 'standard',
      namespace,
      db_ref: data.db_ref ?? null,
      overrides_json: data.overrides ?? null,
      labels_json: data.labels ?? null,
      current_release_id: null,
      last_failed_release_id: null,
      last_applied_release_id: null,
      last_deploy_failure_json: null,
    });

    return this.toEnvironmentResponse(environment);
  }

  async list(
    projectId: string,
    options: { limit?: number; offset?: number },
  ): Promise<EnvironmentListResponse> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;

    const environments = await this.environments.list({
      project_id: projectId,
      limit,
      offset,
    });
    const ingressAliasMap = await this.loadIngressAliasMap(
      projectId,
      environments.map((env) => env.id),
    );

    return {
      data: environments.map((env) => this.toEnvironmentResponse(env, ingressAliasMap.get(env.id) ?? [])),
      pagination: {
        limit,
        offset,
        count: environments.length,
      },
    };
  }

  async findByName(
    projectId: string,
    name: string,
  ): Promise<EnvironmentResponse | null> {
    const environment = await this.environments.findByProjectAndName(projectId, name);
    if (!environment) {
      return null;
    }
    const aliases = await this.loadEnvironmentAliases(projectId, environment.id);
    return this.toEnvironmentResponse(environment, aliases);
  }

  async resolveNamespace(projectId: string, envName: string): Promise<string> {
    const environment = await this.environments.findByProjectAndName(projectId, envName);
    if (!environment) {
      throw new NotFoundException(
        `Environment "${envName}" not found for project ${projectId}`
      );
    }

    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const org = await this.orgs.findById(project.org_id);
    if (!org) {
      throw new NotFoundException(`Org ${project.org_id} not found for project ${projectId}`);
    }

    return deriveNamespace(org.slug, project.slug, environment.name, environment.namespace);
  }

  private async resolveNamespaceById(environmentId: string): Promise<string> {
    const environment = await this.environments.findById(environmentId);
    if (!environment) {
      throw new NotFoundException(`Environment ${environmentId} not found`);
    }
    // Always normalize: a previously-stored mixed-case value would otherwise
    // be returned as-is, causing K8s lookups (which are case-sensitive) to miss.
    if (environment.namespace) {
      return toK8sName(environment.namespace, 'namespace');
    }
    const project = await this.projects.findById(environment.project_id);
    if (!project) {
      throw new NotFoundException(`Project ${environment.project_id} not found`);
    }
    const org = await this.orgs.findById(project.org_id);
    if (!org) {
      throw new NotFoundException(`Org ${project.org_id} not found`);
    }
    return deriveNamespace(org.slug, project.slug, environment.name);
  }

  async update(
    projectId: string,
    name: string,
    data: UpdateEnvironmentRequest,
  ): Promise<EnvironmentResponse> {
    // Find environment
    const environment = await this.environments.findByProjectAndName(projectId, name);
    if (!environment) {
      throw new NotFoundException(
        `Environment "${name}" not found for project ${projectId}`
      );
    }

    const updated = await this.environments.update(environment.id, {
      namespace: data.namespace,
      db_ref: data.db_ref,
      overrides_json: data.overrides,
      labels_json: data.labels,
      current_release_id: data.current_release_id,
      last_failed_release_id: data.last_failed_release_id,
    });

    if (!updated) {
      throw new NotFoundException(`Environment ${environment.id} not found after update`);
    }

    return this.toEnvironmentResponse(updated);
  }

  async delete(
    projectId: string,
    name: string,
    data: DeleteEnvironmentRequest = {},
  ): Promise<void> {
    // Find environment
    const environment = await this.environments.findByProjectAndName(projectId, name);
    if (!environment) {
      throw new NotFoundException(
        `Environment "${name}" not found for project ${projectId}`
      );
    }

    // Mark as undeploying and clean up
    await this.environments.update(environment.id, { deploy_status: 'undeploying' });
    await this.cleanupManagedDbTenants(environment.id, data.force);
    await this.teardownEnvironmentDeployment(environment.id, data.force);

    // Force-delete: hard-remove any remaining managed_db_tenants rows to
    // avoid FK constraint violations on the environments table.
    if (data.force) {
      const removed = await this.managedDb.hardDeleteTenantsByEnv(environment.id);
      if (removed > 0) {
        this.logger.log(`[env-delete] Hard-deleted ${removed} managed DB tenant row(s) for env ${environment.id}`);
      }
    }

    const deleted = await this.environments.delete(environment.id);
    if (!deleted) {
      throw new NotFoundException(`Environment ${environment.id} not found`);
    }
  }

  async undeploy(
    projectId: string,
    name: string,
    data: UndeployEnvironmentRequest = {},
  ): Promise<EnvironmentResponse> {
    const environment = await this.environments.findByProjectAndName(projectId, name);
    if (!environment) {
      throw new NotFoundException(
        `Environment "${name}" not found for project ${projectId}`
      );
    }

    await this.environments.update(environment.id, { deploy_status: 'undeploying' });
    await this.teardownEnvironmentDeployment(environment.id, data.force);

    const updated = await this.environments.update(environment.id, {
      deploy_status: 'undeployed',
      current_release_id: null,
    });

    if (!updated) {
      throw new NotFoundException(`Environment ${environment.id} not found after undeploy`);
    }

    this.logger.log(`Undeployed environment "${name}" (${environment.id})`);
    return this.toEnvironmentResponse(updated);
  }

  private async cleanupManagedDbTenants(
    envId: string,
    force = false,
  ): Promise<void> {
    try {
      const tenants = await this.managedDb.listTenantsByEnv(envId);
      for (const tenant of tenants) {
        if (tenant.status !== 'deleting' && !tenant.deleted_at) {
          try {
            await this.managedDb.softDeleteTenant(tenant.id);
            this.logger.log(`[env-delete] Initiated managed DB tenant cleanup: ${tenant.id}`);
          } catch (error) {
            if (force) {
              const message = error instanceof Error ? error.message : String(error);
              this.logger.warn(`[env-delete] Managed DB tenant cleanup failed for ${tenant.id} (force=true): ${message}`);
              continue;
            }

            const message = error instanceof Error ? error.message : String(error);
            throw new ServiceUnavailableException(`Failed to cleanup managed DB tenants: ${message}`);
          }
        }
      }
    } catch (error) {
      if (force) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[env-delete] Managed DB cleanup failed (force=true) for env ${envId}: ${message}`);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(`Failed to cleanup managed DB tenants: ${message}`);
    }
  }

  private async teardownEnvironmentDeployment(
    envId: string,
    force = false,
  ): Promise<void> {
    let workerUrl: string;
    try {
      workerUrl = this.resolveWorkerUrl();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[env-delete] Worker URL unavailable, skipping deployment teardown: ${message}`);
      return;
    }

    try {
      const response = await fetch(`${workerUrl}/environments/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env_id: envId }),
      });

      if (response.ok) {
        return;
      }

      const text = await response.text();
      const lower = `${response.status} ${text}`.toLowerCase();
      if (response.status === 404 || lower.includes('not found')) {
        this.logger.log(`[env-delete] Deployment namespace already absent for env ${envId}`);
        return;
      }

      if (force) {
        this.logger.warn(`[env-delete] Worker delete failed (force=true) for env ${envId}: ${response.status} ${text || response.statusText}`);
        return;
      }

      throw new ServiceUnavailableException(
        `Worker environment delete failed (${response.status}): ${text || response.statusText}`,
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        if (force) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`[env-delete] Worker delete failed (force=true) for env ${envId}: ${message}`);
          return;
        }

        throw error;
      }
      if (force) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[env-delete] Worker delete failed (force=true) for env ${envId}: ${message}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(`Failed to teardown environment deployment: ${message}`);
    }
  }

  async findActivePipelineRunForEnv(
    projectId: string,
    envName: string,
  ): Promise<{ id: string; pipeline_name: string; status: string; git_sha: string | null; created_at: string } | null> {
    const run = await this.pipelineRunsService.findActiveRunByEnv(projectId, envName);
    if (!run) return null;
    return {
      id: run.id,
      pipeline_name: run.pipeline_name,
      status: run.status,
      git_sha: run.git_sha,
      created_at: run.created_at.toISOString(),
    };
  }

  async rollback(
    projectId: string,
    envName: string,
    data: { release: string; skip_preflight?: boolean },
  ): Promise<DeployResponse> {
    const environment = await this.environments.findByProjectAndName(projectId, envName);
    if (!environment) {
      throw new NotFoundException(`Environment "${envName}" not found for project ${projectId}`);
    }

    const release = await this.resolveReleaseForRollback(projectId, environment.current_release_id, data.release);
    await this.environments.update(environment.id, { deploy_status: 'deploying' });
    const deploymentStatus = await this.deployRelease(environment.id, release.id, undefined, data.skip_preflight);
    const updatedEnvironment = await this.finalizeReleasePointer(environment.id, release.id, deploymentStatus);

    await this.registerComponentApis(projectId, envName, release.manifest_hash);
    const warnings = this.buildDeploymentWarnings(deploymentStatus);

    return {
      release: this.toReleaseResponse(release),
      environment: this.toEnvironmentResponse(updatedEnvironment),
      deployment_status: deploymentStatus ?? undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async reset(
    projectId: string,
    envName: string,
    data: {
      release?: string;
      force?: boolean;
      danger_reset_production?: boolean;
      skip_preflight?: boolean;
    },
  ): Promise<DeployResponse> {
    const environment = await this.environments.findByProjectAndName(projectId, envName);
    if (!environment) {
      throw new NotFoundException(`Environment "${envName}" not found for project ${projectId}`);
    }

    const isProduction = this.isProductionEnvName(envName);
    if (isProduction) {
      if (!data.danger_reset_production) {
        throw new BadRequestException('Resetting production requires danger_reset_production=true');
      }
    } else if (environment.type === 'persistent' && !data.force) {
      throw new BadRequestException('Resetting persistent environments requires force=true');
    }

    const activeRun = await this.pipelineRunsService.findActiveRunByEnv(projectId, envName);
    if (activeRun) {
      await this.pipelineRunsService.cancelRun(activeRun.id, `Cancelled by env reset for ${envName}`);
    }

    await this.teardownEnvironmentDeployment(environment.id);

    let release;
    if (data.release) {
      release = await this.resolveReleaseForRollback(projectId, environment.current_release_id, data.release);
    } else if (environment.current_release_id) {
      const current = await this.releases.findById(environment.current_release_id);
      if (!current || current.project_id !== projectId) {
        throw new NotFoundException(`Current release ${environment.current_release_id} not found for environment ${envName}`);
      }
      release = current;
    } else {
      throw new BadRequestException('No current release found. Provide release explicitly.');
    }

    await this.environments.update(environment.id, { deploy_status: 'deploying' });
    const deploymentStatus = await this.deployRelease(environment.id, release.id, undefined, data.skip_preflight);
    const updatedEnvironment = await this.finalizeReleasePointer(environment.id, release.id, deploymentStatus);

    await this.registerComponentApis(projectId, envName, release.manifest_hash);
    const warnings = this.buildDeploymentWarnings(deploymentStatus);

    return {
      release: this.toReleaseResponse(release),
      environment: this.toEnvironmentResponse(updatedEnvironment),
      deployment_status: deploymentStatus ?? undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async recover(projectId: string, envName: string): Promise<{
    project_id: string;
    env_name: string;
    active_pipeline_run_id: string | null;
    current_release_id: string | null;
    last_failed_release_id: string | null;
    diagnose: Awaited<ReturnType<EnvDiagnosticsService['diagnose']>>;
    suggested_command: string;
    summary: string;
  }> {
    const environment = await this.environments.findByProjectAndName(projectId, envName);
    if (!environment) {
      throw new NotFoundException(`Environment "${envName}" not found for project ${projectId}`);
    }

    const activeRun = await this.pipelineRunsService.findActiveRunByEnv(projectId, envName);
    const namespace = await this.resolveNamespace(projectId, envName);
    const diagnose = await this.envDiagnosticsService.diagnose(projectId, envName, namespace, { eventLimit: 20 });

    let suggestedCommand = `eve env diagnose ${projectId} ${envName}`;
    let summary = 'No clear recovery action detected. Run diagnose for details.';

    if (activeRun) {
      suggestedCommand = `eve pipeline cancel ${activeRun.id} --reason "recovery"`;
      summary = `Pipeline run ${activeRun.id} is still active.`;
    } else if (diagnose.pods.some((pod) => pod.containers?.some((container) => container.reason === 'ImagePullBackOff'))) {
      if (environment.current_release_id) {
        suggestedCommand = `eve env rollback ${envName} --project ${projectId} --release previous`;
        summary = 'Detected ImagePullBackOff; rollback to previous release is recommended.';
      } else {
        suggestedCommand = `eve env deploy ${envName} --project ${projectId} --ref <git-sha>`;
        summary = 'Detected ImagePullBackOff with no current release pointer.';
      }
    } else if (environment.last_failed_release_id) {
      suggestedCommand = `eve env rollback ${envName} --project ${projectId} --release ${environment.last_failed_release_id}`;
      summary = `Last failed release recorded: ${environment.last_failed_release_id}.`;
    } else if (!environment.current_release_id) {
      suggestedCommand = `eve env deploy ${envName} --project ${projectId} --ref <git-sha>`;
      summary = 'Environment has no current release.';
    }

    return {
      project_id: projectId,
      env_name: envName,
      active_pipeline_run_id: activeRun?.id ?? null,
      current_release_id: environment.current_release_id,
      last_failed_release_id: environment.last_failed_release_id,
      diagnose,
      suggested_command: suggestedCommand,
      summary,
    };
  }

  async deploy(
    projectId: string,
    envName: string,
    data: DeployRequest,
  ): Promise<DeployResponse> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Load manifest early — needed for both auto-creation and pipeline routing
    const manifestRecord = await this.manifests.findLatestByProject(projectId);
    if (!manifestRecord) {
      throw new NotFoundException(`No manifest synced for project ${projectId}`);
    }
    const manifest: Manifest = yaml.parse(manifestRecord.manifest_yaml);

    // Find or auto-create environment
    let environment = await this.environments.findByProjectAndName(projectId, envName);
    if (!environment) {
      environment = await ensureManifestEnvironment(this.environments, projectId, envName, manifest);
      if (environment) {
        this.logger.log(`Auto-created environment "${envName}" for project ${projectId} (defined in manifest)`);
      } else {
        const defined = Object.keys(manifest.environments ?? {}).join(', ') || 'none';
        throw new NotFoundException(
          `Environment "${envName}" not found for project ${projectId}. Environments defined in manifest: ${defined}. Create it with: eve env create ${envName} --project ${projectId}`,
        );
      }
    }

    // Block deploys to suspended environments
    if (environment.status === 'suspended') {
      throw new ConflictException(
        `Environment "${envName}" is suspended: ${environment.suspension_reason ?? 'no reason given'}. Resume the environment before deploying.`,
      );
    }

    const envConfig = manifest.environments?.[envName] as Environment | undefined;

    // Check if environment has a pipeline configured and direct flag is not set
    if (envConfig?.pipeline && !data.direct) {
      // Route to pipeline execution
      return this.deployViaPipeline(projectId, envName, envConfig, data, environment);
    }

    // Fall back to direct deploy flow
    return this.deployDirect(projectId, envName, data, environment, project);
  }

  private async deployViaPipeline(
    projectId: string,
    envName: string,
    envConfig: Environment,
    data: DeployRequest,
    environment: Awaited<ReturnType<typeof this.environments.findByProjectAndName>> & object,
  ): Promise<DeployResponse> {
    const pipelineName = envConfig.pipeline!;

    // Merge pipeline_inputs from manifest with request inputs (request wins)
    const manifestInputs = envConfig.pipeline_inputs ?? {};
    const requestInputs = data.inputs ?? {};
    const mergedInputs = { ...manifestInputs, ...requestInputs };

    // Determine git_sha for pipeline run
    let gitSha: string;
    if (data.release_tag) {
      // Look up release by tag to get git_sha
      const release = await this.releases.findByProjectAndTag(projectId, data.release_tag);
      if (!release) {
        throw new NotFoundException(`Release tag ${data.release_tag} not found for project ${projectId}`);
      }
      gitSha = release.git_sha;
    } else if (data.git_sha) {
      gitSha = data.git_sha;
    } else {
      throw new BadRequestException('Deploy request requires git_sha or release_tag for pipeline execution');
    }

    // Create pipeline run
    const pipelineRunRequest = {
      ref: gitSha,
      env: envName,
      inputs: mergedInputs,
    };

    this.logger.log(
      `Routing environment deploy to pipeline "${pipelineName}" for ${envName} (ref: ${gitSha})`
    );

    // Mark the env as deploying when the pipeline run is created. The direct
    // path (deployDirect) already does this via release-pointer finalization;
    // the pipeline path previously left deploy_status untouched until the
    // pipeline itself updated it on completion, which hid in-flight deploys
    // from `eve env show`.
    await this.environments.update(environment.id, { deploy_status: 'deploying' });

    const { detail: pipelineRun } = await this.pipelineRunsService.createRun(
      projectId,
      pipelineName,
      pipelineRunRequest,
      'env-deploy',
    );

    return {
      pipeline_run: pipelineRun,
      environment: this.toEnvironmentResponse(environment),
      poll_url: `/pipeline-runs/${pipelineRun.run.id}`,
    };
  }

  private async deployDirect(
    projectId: string,
    envName: string,
    data: DeployRequest,
    environment: Awaited<ReturnType<typeof this.environments.findByProjectAndName>> & object,
    project: Awaited<ReturnType<typeof this.projects.findById>> & object,
  ): Promise<DeployResponse> {
    let release = null as Awaited<ReturnType<typeof this.releases.create>> | null;

    if (data.release_tag) {
      release = await this.releases.findByProjectAndTag(projectId, data.release_tag);
      if (!release) {
        throw new NotFoundException(`Release tag ${data.release_tag} not found for project ${projectId}`);
      }
    } else {
      if (!data.git_sha || !data.manifest_hash) {
        throw new BadRequestException('Deploy request missing git_sha or manifest_hash');
      }
      const manifest = await this.manifests.findByProjectAndHash(projectId, data.manifest_hash);
      if (!manifest) {
        throw new BadRequestException('manifest_hash not found for project');
      }
      if (manifest.git_sha && manifest.git_sha !== data.git_sha) {
        throw new BadRequestException('manifest_hash does not match git_sha');
      }
      // Create release record
      const releaseId = generateReleaseId();
      release = await this.releases.create({
        id: releaseId,
        project_id: projectId,
        git_sha: data.git_sha,
        manifest_hash: data.manifest_hash,
        image_digests_json: data.image_digests ?? null,
        build_id: null,
        version: null,
        tag: null,
        created_by: null, // TODO: Add user context when auth is implemented
      });
    }

    await this.environments.update(environment.id, { deploy_status: 'deploying' });
    const deploymentStatus = await this.deployRelease(
      environment.id,
      release.id,
      data.image_tag,
      data.skip_preflight,
    );
    const updatedEnvironment = await this.finalizeReleasePointer(environment.id, release.id, deploymentStatus);

    // Register API specs for services (after deployment and migrations complete)
    await this.registerComponentApis(projectId, envName, release.manifest_hash);

    const warnings = this.buildDeploymentWarnings(deploymentStatus);

    return {
      release: this.toReleaseResponse(release),
      environment: this.toEnvironmentResponse(updatedEnvironment),
      deployment_status: deploymentStatus ?? undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private async registerComponentApis(
    projectId: string,
    envName: string,
    manifestHash: string,
  ): Promise<void> {
    try {
      // Fetch the manifest using the manifest_hash
      const manifestRecord = await this.manifests.findByProjectAndHash(projectId, manifestHash);
      if (!manifestRecord) {
        this.logger.warn(
          `Manifest not found for hash ${manifestHash}, skipping API registration`
        );
        return;
      }

      // Parse the manifest YAML
      const manifest: Manifest = yaml.parse(manifestRecord.manifest_yaml);
      const services = getServicesFromManifest(manifest);
      if (!services) {
        this.logger.debug('No services in manifest, skipping API registration');
        return;
      }

      const project = await this.projects.findById(projectId, { include_deleted: true });
      if (!project) {
        this.logger.warn(`Project ${projectId} not found, skipping API registration`);
        return;
      }

      const org = await this.orgs.findById(project.org_id);
      if (!org) {
        this.logger.warn(`Org ${project.org_id} not found, skipping API registration`);
        return;
      }

      const repoPath = this.extractLocalRepoPath(project.repo_url);

      // Register API specs for each service
      for (const [serviceName, service] of Object.entries(services)) {
        await this.registerComponentApiSpecs(
          org.slug,
          project.slug,
          projectId,
          envName,
          serviceName,
          service,
          repoPath,
        );
      }
    } catch (error) {
      // Don't fail deployment if API registration fails
      this.logger.error(
        `Failed to register API specs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async registerComponentApiSpecs(
    orgSlug: string,
    projectSlug: string,
    projectId: string,
    envName: string,
    componentName: string,
    component: Service,
    repoPath: string | undefined,
  ): Promise<void> {
    const xeve = this.resolveXeve(component);
    const apiSpecs = this.resolveServiceApiSpecs(xeve);

    if (apiSpecs.length === 0) {
      return;
    }

    const namespace = deriveNamespace(orgSlug, projectSlug, envName);

    for (const apiSpec of apiSpecs) {
      // Only register if on_deploy is true (default)
      if (apiSpec.on_deploy === false) {
        this.logger.debug(
          `Skipping API registration for ${componentName} (on_deploy=false)`
        );
        continue;
      }

      try {
        const port = this.resolveServicePort(component, xeve);
        const deployedBaseUrl = this.resolveServiceBaseUrl({
          componentName,
          envName,
          namespace,
          port,
        });

        await this.apiRegistrationService.registerComponentApi(
          projectId,
          envName,
          componentName,
          apiSpec,
          deployedBaseUrl,
          repoPath,
        );

        this.logger.log(
          `Registered API spec for ${componentName} in ${envName}`
        );
      } catch (error) {
        // Log error but continue with other API specs
        this.logger.warn(
          `Failed to register API spec for ${componentName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private resolveXeve(service: Service): Record<string, unknown> | null {
    const xeve = (service as Record<string, unknown>)['x-eve'] ?? (service as Record<string, unknown>).x_eve;
    return xeve && typeof xeve === 'object' ? xeve as Record<string, unknown> : null;
  }

  private resolveServiceApiSpecs(xeve: Record<string, unknown> | null): ApiSpec[] {
    if (!xeve) return [];
    const apiSpecs: ApiSpec[] = [];
    const apiSpec = xeve.api_spec as ApiSpec | undefined;
    const apiSpecsArray = xeve.api_specs as ApiSpec[] | undefined;

    if (apiSpec) {
      apiSpecs.push(apiSpec);
    }
    if (Array.isArray(apiSpecsArray)) {
      apiSpecs.push(...apiSpecsArray);
    }

    return apiSpecs;
  }

  private resolveServicePort(service: Service, xeve: Record<string, unknown> | null): number | undefined {
    const ingress = xeve?.ingress;
    if (ingress && typeof ingress === 'object') {
      const port = (ingress as Record<string, unknown>).port;
      if (typeof port === 'number') {
        return port;
      }
    }

    const ports = (service as Record<string, unknown>).ports;
    if (Array.isArray(ports) && ports.length > 0) {
      const first = ports[0];
      if (typeof first === 'number') return first;
      if (typeof first === 'string') {
        const parts = first.split(':');
        const candidate = parts[parts.length - 1];
        const parsed = parseInt(candidate, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
    }

    return undefined;
  }

  private resolveServiceBaseUrl(params: {
    componentName: string;
    envName: string;
    namespace: string;
    port?: number;
  }): string {
    const portSuffix = params.port ? `:${params.port}` : '';

    const deployedBaseUrl = `http://${params.envName}-${params.componentName}.${params.namespace}.svc.cluster.local${portSuffix}`;
    this.logger.debug(
      `Using internal URL for API source ${params.componentName}: ${deployedBaseUrl}`
    );
    return deployedBaseUrl;
  }

  private extractLocalRepoPath(repoUrl: string | null | undefined): string | undefined {
    if (!repoUrl) return undefined;
    try {
      const url = new URL(repoUrl);
      if (url.protocol !== 'file:') return undefined;
      return fileURLToPath(url);
    } catch {
      return undefined;
    }
  }

  private toReleaseResponse(
    release: Awaited<ReturnType<typeof this.releases.create>>
  ): ReleaseResponse {
    return {
      id: release.id,
      project_id: release.project_id,
      git_sha: release.git_sha,
      manifest_hash: release.manifest_hash,
      image_digests: release.image_digests_json,
      build_id: release.build_id,
      version: release.version ?? null,
      tag: release.tag ?? null,
      created_by: release.created_by,
      created_at: release.created_at.toISOString(),
    };
  }

  private resolveWorkerUrl(): string {
    const mapping = process.env.EVE_WORKER_URLS ?? '';
    if (mapping.trim().length > 0) {
      const entries = mapping
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [name, url] = entry.split('=');
          return { name: name?.trim() ?? '', url: url?.trim() ?? '' };
        })
        .filter((entry) => entry.name && entry.url);

      const defaultEntry = entries.find((entry) => entry.name === 'default-worker');
      if (defaultEntry) {
        return defaultEntry.url;
      }

      if (entries.length > 0) {
        return entries[0].url;
      }
    }

    if (process.env.WORKER_URL) {
      return process.env.WORKER_URL;
    }

    throw new ServiceUnavailableException('WORKER_URL or EVE_WORKER_URLS must be set to deploy environments');
  }

  private async finalizeReleasePointer(
    environmentId: string,
    releaseId: string,
    deploymentStatus: DeploymentStatus | null,
  ) {
    // Always persist the namespace — it's an infrastructure fact (the k8s namespace was
    // created by the worker) regardless of whether pods are fully ready yet.
    // Sentinel needs this to discover and monitor the environment.
    const namespace = await this.resolveNamespaceById(environmentId);
    await this.environments.update(environmentId, { namespace });

    const isReady = deploymentStatus?.state === 'ready' || deploymentStatus?.k8s_status?.ready === true;
    if (!isReady) {
      // Record the applied-but-unhealthy state: the manifest was applied so the
      // cluster is running this release even though it isn't ready. Leave
      // current_release_id pointing at the last ready release so rollback still
      // has a valid target.
      await this.environments.update(environmentId, {
        last_failed_release_id: releaseId,
        last_applied_release_id: releaseId,
        last_deploy_failure_json: {
          kind: 'readiness_timeout',
          release_id: releaseId,
          available_replicas: deploymentStatus?.k8s_status?.available_replicas ?? null,
          desired_replicas: deploymentStatus?.k8s_status?.desired_replicas ?? null,
          at: new Date().toISOString(),
        },
        deploy_status: 'failed',
      });
      const details = deploymentStatus?.k8s_status
        ? ` (${deploymentStatus.k8s_status.available_replicas}/${deploymentStatus.k8s_status.desired_replicas} replicas ready)`
        : '';
      throw new ServiceUnavailableException(
        `Deployment failed readiness check for release ${releaseId}${details}`,
      );
    }

    const updated = await this.environments.update(environmentId, {
      current_release_id: releaseId,
      last_applied_release_id: releaseId,
      last_failed_release_id: null,
      last_deploy_failure_json: null,
      deploy_status: 'deployed',
    });
    if (!updated) {
      throw new NotFoundException(`Environment ${environmentId} not found after update`);
    }
    return updated;
  }

  private async resolveReleaseForRollback(
    projectId: string,
    currentReleaseId: string | null,
    releaseRef: string,
  ) {
    if (releaseRef === 'previous') {
      if (!currentReleaseId) {
        throw new BadRequestException('Cannot resolve previous release without current_release_id');
      }

      const releases = await this.releases.list({ project_id: projectId, limit: 1000 });
      const currentIndex = releases.findIndex((release) => release.id === currentReleaseId);
      if (currentIndex < 0) {
        throw new NotFoundException(`Current release ${currentReleaseId} not found in project ${projectId}`);
      }
      const previous = releases[currentIndex + 1];
      if (!previous) {
        throw new NotFoundException(`No previous release found before ${currentReleaseId}`);
      }
      return previous;
    }

    const byId = await this.releases.findById(releaseRef);
    if (byId && byId.project_id === projectId) {
      return byId;
    }

    const byTag = await this.releases.findByProjectAndTag(projectId, releaseRef);
    if (byTag) {
      return byTag;
    }

    throw new NotFoundException(`Release ${releaseRef} not found for project ${projectId}`);
  }

  private async deployRelease(
    envId: string,
    releaseId: string,
    imageTag?: string,
    skipPreflight?: boolean,
  ): Promise<DeploymentStatus | null> {
    const workerUrl = this.resolveWorkerUrl();
    const body: { env_id: string; release_id: string; image_tag?: string; options?: { skipPreflight?: boolean } } = {
      env_id: envId,
      release_id: releaseId,
    };
    if (imageTag) {
      body.image_tag = imageTag;
    }
    if (skipPreflight) {
      body.options = { skipPreflight: true };
    }
    const response = await fetch(`${workerUrl}/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ServiceUnavailableException(
        `Worker deploy failed (${response.status}): ${body || response.statusText}`
      );
    }

    const raw = await response.text();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as {
        envId?: string;
        currentReleaseId?: string;
        state?: DeploymentStatus['state'];
        message?: string;
        namespace?: string;
        k8sStatus?: {
          ready: boolean;
          availableReplicas: number;
          desiredReplicas: number;
          conditions: Array<{ type: string; status: string; message?: string }>;
        };
      };
      return {
        env_id: parsed.envId ?? envId,
        current_release_id: parsed.currentReleaseId ?? null,
        state: parsed.state ?? 'unknown',
        message: parsed.message ?? null,
        namespace: parsed.namespace ?? null,
        k8s_status: parsed.k8sStatus
          ? {
              ready: parsed.k8sStatus.ready,
              available_replicas: parsed.k8sStatus.availableReplicas,
              desired_replicas: parsed.k8sStatus.desiredReplicas,
              conditions: parsed.k8sStatus.conditions ?? [],
            }
          : null,
      };
    } catch {
      return null;
    }
  }

  private buildDeploymentWarnings(status: DeploymentStatus | null): string[] {
    if (!status) return [];
    const warnings: string[] = [];
    if (status.state !== 'ready') {
      warnings.push(`Deployment state: ${status.state}`);
    }
    if (status.k8s_status) {
      const { available_replicas, desired_replicas, ready, conditions } = status.k8s_status;
      if (!ready) {
        warnings.push(`Deployment replicas not ready (${available_replicas}/${desired_replicas})`);
      }
      for (const condition of conditions) {
        if (condition.status !== 'True' && condition.message) {
          warnings.push(`${condition.type}: ${condition.message}`);
        }
      }
    }
    return Array.from(new Set(warnings));
  }

  private isProductionEnvName(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized === 'production' || normalized === 'prod';
  }

  async suspend(
    projectId: string,
    envName: string,
    reason: string,
  ): Promise<{ id: string; name: string; status: 'active' | 'suspended' | 'terminated'; suspended_at: string | null; suspension_reason: string | null }> {
    const environment = await this.environments.findByProjectAndName(projectId, envName);
    if (!environment) {
      throw new NotFoundException(
        `Environment "${envName}" not found for project ${projectId}`
      );
    }

    if (environment.status === 'suspended') {
      throw new ConflictException(
        `Environment "${envName}" is already suspended`
      );
    }

    if (environment.status === 'terminated') {
      throw new ConflictException(
        `Environment "${envName}" is terminated and cannot be suspended`
      );
    }

    const updated = await this.environments.suspend(environment.id, reason);
    if (!updated) {
      throw new NotFoundException(`Environment ${environment.id} not found after suspend`);
    }

    this.logger.log(
      `Suspended environment "${envName}" (${environment.id}): ${reason}`
    );

    return {
      id: updated.id,
      name: updated.name,
      status: updated.status as 'active' | 'suspended' | 'terminated',
      suspended_at: updated.suspended_at?.toISOString() ?? null,
      suspension_reason: updated.suspension_reason,
    };
  }

  async resume(
    projectId: string,
    envName: string,
  ): Promise<{ id: string; name: string; status: 'active' | 'suspended' | 'terminated'; suspended_at: string | null; suspension_reason: string | null }> {
    const environment = await this.environments.findByProjectAndName(projectId, envName);
    if (!environment) {
      throw new NotFoundException(
        `Environment "${envName}" not found for project ${projectId}`
      );
    }

    if (environment.status !== 'suspended') {
      throw new ConflictException(
        `Environment "${envName}" is not suspended (current status: ${environment.status})`
      );
    }

    const updated = await this.environments.resume(environment.id);
    if (!updated) {
      throw new NotFoundException(`Environment ${environment.id} not found after resume`);
    }

    this.logger.log(
      `Resumed environment "${envName}" (${environment.id})`
    );

    return {
      id: updated.id,
      name: updated.name,
      status: updated.status as 'active' | 'suspended' | 'terminated',
      suspended_at: updated.suspended_at?.toISOString() ?? null,
      suspension_reason: updated.suspension_reason,
    };
  }

  private toEnvironmentResponse(
    environment: Awaited<ReturnType<typeof this.environments.findById>> & object,
    ingressAliases: Array<{ alias: string; service_name: string }> = [],
  ): EnvironmentResponse {
    return {
      id: environment.id,
      project_id: environment.project_id,
      name: environment.name,
      type: environment.type,
      kind: environment.kind,
      namespace: environment.namespace,
      db_ref: environment.db_ref,
      overrides: environment.overrides_json,
      labels: environment.labels_json,
      current_release_id: environment.current_release_id,
      last_failed_release_id: environment.last_failed_release_id,
      last_applied_release_id: environment.last_applied_release_id ?? null,
      last_deploy_failure: (environment.last_deploy_failure_json ?? null) as EnvironmentResponse['last_deploy_failure'],
      ingress_aliases: ingressAliases,
      deploy_status: (environment.deploy_status ?? 'unknown') as 'unknown' | 'deployed' | 'undeployed' | 'deploying' | 'undeploying' | 'failed',
      status: environment.status,
      suspended_at: environment.suspended_at?.toISOString() ?? null,
      suspension_reason: environment.suspension_reason,
      created_at: environment.created_at.toISOString(),
      updated_at: environment.updated_at.toISOString(),
    };
  }

  private async loadEnvironmentAliases(
    projectId: string,
    environmentId: string,
  ): Promise<Array<{ alias: string; service_name: string }>> {
    const rows = await this.ingressAliases.findByProjectAndEnvironment(projectId, environmentId);
    return rows.map((row) => ({ alias: row.alias, service_name: row.service_name }));
  }

  private async loadIngressAliasMap(
    projectId: string,
    environmentIds: string[],
  ): Promise<Map<string, Array<{ alias: string; service_name: string }>>> {
    if (environmentIds.length === 0) {
      return new Map();
    }

    const rows = await this.ingressAliases.findByEnvironmentIds(environmentIds);
    const grouped = new Map<string, Array<{ alias: string; service_name: string }>>();
    for (const row of rows) {
      if (row.project_id !== projectId || !row.environment_id) {
        continue;
      }

      const current = grouped.get(row.environment_id) ?? [];
      current.push({ alias: row.alias, service_name: row.service_name });
      grouped.set(row.environment_id, current);
    }

    return grouped;
  }
}
