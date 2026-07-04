import { Injectable, Inject, Optional, BadRequestException, NotFoundException, RequestTimeoutException } from '@nestjs/common';
import type { Db, Job, JobHints } from '@eve/db';
import { projectManifestQueries, projectQueries, jobQueries, agentQueries, agentConfigQueries, projectApiSourceQueries, orgQueries, environmentQueries, appLinkSubscriptionQueries } from '@eve/db';
import { deriveNamespace, ResourceRefSchema, EnvOverridesSchema, AccessBindingScopeSchema, WorkflowDefinitionSchema, VALID_TOOLCHAINS, buildIngestUri, buildAppApiInstructionBlock, getServicesFromManifest, resolveHarnessProfile as sharedResolveHarnessProfile, buildWorkflowInputsScope, interpolateValue, isValidPermission, mergeEnvOverrides, parseWorkflowStepExecution, type AccessBindingScope, type AppApiCliInfo, type AppApiInfo, type EnvOverrides, type EvaluateScope, type HarnessProfileSource, type InlineProfileBundle, type ResourceRef, type StepExecution, type WorkflowListResponse, type WorkflowResponse, type WorkflowInvokeRequest, type WorkflowInvokeResponse, type WorkflowInvokeResult, type WorkflowRetryRequest, type WorkflowRetryResponse, type WorkflowStepJob } from '@eve/shared';
import { AccessService } from '../auth/access.service.js';
import * as yaml from 'yaml';

const VALID_TOOLCHAIN_SET = new Set<string>(VALID_TOOLCHAINS);

type ResourceRefsPolicyMode = 'inherit' | 'none' | 'selected';
type ResourceRefsPolicySource = 'default' | 'workflow' | 'step';
type ResolvedResourceRefsPolicy = {
  mode: ResourceRefsPolicyMode;
  source: ResourceRefsPolicySource;
  selectors: string[];
};
type ResourceRefsAccessSummary = NonNullable<WorkflowStepJob['resource_refs']>;

@Injectable()
export class WorkflowsService {
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private jobs: ReturnType<typeof jobQueries>;
  private agents: ReturnType<typeof agentQueries>;
  private agentConfigs: ReturnType<typeof agentConfigQueries>;
  private apiSources: ReturnType<typeof projectApiSourceQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private environments: ReturnType<typeof environmentQueries>;
  private appLinkSubscriptions: ReturnType<typeof appLinkSubscriptionQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    @Optional() private readonly accessService?: AccessService,
  ) {
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
    this.jobs = jobQueries(db);
    this.agents = agentQueries(db);
    this.agentConfigs = agentConfigQueries(db);
    this.apiSources = projectApiSourceQueries(db);
    this.orgs = orgQueries(db);
    this.environments = environmentQueries(db);
    this.appLinkSubscriptions = appLinkSubscriptionQueries(db);
  }

  async list(projectId: string): Promise<WorkflowListResponse> {
    await this.ensureProjectExists(projectId);
    const manifest = await this.manifests.findLatestByProject(projectId);
    if (!manifest) {
      return { data: [] };
    }

    const workflows = this.parseWorkflows(manifest.manifest_yaml);
    const data = Object.entries(workflows)
      .map(([name, definition]) => ({
        project_id: projectId,
        name,
        definition,
        db_access: this.extractDbAccess(definition),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { data };
  }

  async findByName(projectId: string, name: string): Promise<WorkflowResponse> {
    await this.ensureProjectExists(projectId);
    const manifest = await this.manifests.findLatestByProject(projectId);
    if (!manifest) {
      throw new NotFoundException(`No manifest synced for project ${projectId}`);
    }

    const workflows = this.parseWorkflows(manifest.manifest_yaml);
    const definition = workflows[name];
    if (!definition) {
      throw new NotFoundException(`Workflow "${name}" not found for project ${projectId}`);
    }

    return {
      project_id: projectId,
      name,
      definition,
      db_access: this.extractDbAccess(definition),
    };
  }

  private parseWorkflows(manifestYaml: string): Record<string, Record<string, unknown>> {
    try {
      const parsed = yaml.parse(manifestYaml) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }

      const workflows = (parsed as Record<string, unknown>).workflows;
      if (!workflows || typeof workflows !== 'object') {
        return {};
      }

      const validated: Record<string, Record<string, unknown>> = {};
      for (const [name, definition] of Object.entries(workflows as Record<string, unknown>)) {
        const parsedWorkflow = WorkflowDefinitionSchema.safeParse(definition);
        if (!parsedWorkflow.success) {
          const details = parsedWorkflow.error.issues
            .map((issue) => {
              const path = ['workflows', name, ...issue.path].join('.');
              return `${path}: ${issue.message}`;
            })
            .join('; ');
          throw new BadRequestException(`Invalid workflow definition: ${details}`);
        }
        validated[name] = parsedWorkflow.data as Record<string, unknown>;
      }

      return validated;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Invalid manifest YAML: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  }

  private extractDbAccess(definition: Record<string, unknown>): 'read_only' | 'read_write' | undefined {
    const dbAccess = definition.db_access;
    if (dbAccess === 'read_only' || dbAccess === 'read_write') {
      return dbAccess;
    }
    return undefined;
  }

  private parseEnvOverrides(value: unknown, path: string): EnvOverrides | undefined {
    if (value === undefined || value === null) return undefined;
    const parsed = EnvOverridesSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid ${path}: ${this.formatEnvOverrideIssues(parsed.error.issues)}`);
    }
    return parsed.data;
  }

  private mergeStepEnvOverrides(
    workflowEnv: EnvOverrides | undefined,
    stepEnv: EnvOverrides | undefined,
    invocationEnv: EnvOverrides | undefined,
    path: string,
  ): EnvOverrides | null {
    try {
      return mergeEnvOverrides(workflowEnv, stepEnv, invocationEnv);
    } catch (error) {
      throw new BadRequestException(
        `Invalid ${path}: ${error instanceof Error ? error.message : 'env_overrides validation failed'}`,
      );
    }
  }

  private formatEnvOverrideIssues(issues: Array<{ path: Array<string | number>; message: string }>): string {
    return issues
      .map((issue) => {
        const prefix = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${prefix}${issue.message}`;
      })
      .join('; ');
  }

  private parseTokenScope(value: unknown, path: string): AccessBindingScope | undefined {
    if (value === undefined || value === null) return undefined;
    const parsed = AccessBindingScopeSchema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid ${path}: ${parsed.error.issues.map((issue) => {
        const prefix = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${prefix}${issue.message}`;
      }).join('; ')}`);
    }
    return parsed.data;
  }

  private mergeStepTokenScope(
    workflowScope: AccessBindingScope | undefined,
    stepScope: AccessBindingScope | undefined,
    invocationScope: AccessBindingScope | undefined,
  ): AccessBindingScope | null {
    const scopes = [workflowScope, stepScope, invocationScope].filter((scope): scope is AccessBindingScope => Boolean(scope));
    if (scopes.length === 0) return null;
    return scopes.reduce((acc, scope) => this.intersectScopes(acc, scope));
  }

  private intersectScopes(left: AccessBindingScope, right: AccessBindingScope): AccessBindingScope {
    return {
      ...(left.orgfs || right.orgfs ? { orgfs: this.intersectPrefixScope(left.orgfs, right.orgfs) } : {}),
      ...(left.orgdocs || right.orgdocs ? { orgdocs: this.intersectPrefixScope(left.orgdocs, right.orgdocs) } : {}),
      ...(left.envdb || right.envdb ? { envdb: {
        schemas: this.intersectStringSets(left.envdb?.schemas, right.envdb?.schemas),
        tables: this.intersectStringSets(left.envdb?.tables, right.envdb?.tables),
      } } : {}),
      ...(left.cloud_fs || right.cloud_fs ? { cloud_fs: {
        allow_mount_ids: this.intersectStringSets(left.cloud_fs?.allow_mount_ids, right.cloud_fs?.allow_mount_ids),
      } } : {}),
    };
  }

  private intersectPrefixScope(
    left: AccessBindingScope['orgfs'],
    right: AccessBindingScope['orgfs'],
  ): NonNullable<AccessBindingScope['orgfs']> {
    return {
      allow_prefixes: this.intersectPathPatterns(left?.allow_prefixes, right?.allow_prefixes),
      read_only_prefixes: this.intersectPathPatterns(left?.read_only_prefixes, right?.read_only_prefixes),
    };
  }

  private intersectStringSets(left: string[] | undefined, right: string[] | undefined): string[] {
    if (left === undefined) return [...new Set(right ?? [])].sort();
    if (right === undefined) return [...new Set(left)].sort();
    if (left.includes('*')) return [...new Set(right)].sort();
    if (right.includes('*')) return [...new Set(left)].sort();
    const rightSet = new Set(right);
    return [...new Set(left.filter((item) => rightSet.has(item)))].sort();
  }

  private intersectPathPatterns(left: string[] | undefined, right: string[] | undefined): string[] {
    if (left === undefined) return [...new Set(right ?? [])].sort();
    if (right === undefined) return [...new Set(left)].sort();
    const out = new Set<string>();
    for (const a of left) {
      for (const b of right) {
        const intersection = this.intersectPathPattern(a, b);
        if (intersection) out.add(intersection);
      }
    }
    return [...out].sort();
  }

  private intersectPathPattern(a: string, b: string): string | null {
    if (a === '*') return b;
    if (b === '*') return a;
    const aBase = this.pathPatternBase(a);
    const bBase = this.pathPatternBase(b);
    if (aBase === bBase) return a.length >= b.length ? a : b;
    if (aBase.startsWith(`${bBase}/`)) return a;
    if (bBase.startsWith(`${aBase}/`)) return b;
    return null;
  }

  private pathPatternBase(pattern: string): string {
    const trimmed = pattern.trim();
    if (trimmed === '*' || trimmed === '') return '/';
    return trimmed
      .replace(/\/\*\*$/, '')
      .replace(/\/\*$/, '')
      .replace(/\/+$/, '') || '/';
  }

  private async assertActorCanUseScope(
    orgId: string,
    projectId: string,
    userId: string | undefined,
    scope: AccessBindingScope | null,
    context: string,
  ): Promise<void> {
    if (!userId || !scope || !this.accessService) return;
    const checks: Array<{ permission: string; resource: { type: 'orgfs' | 'orgdocs' | 'envdb' | 'cloud_fs'; id: string; action: 'read' | 'write' | 'admin' } }> = [];
    for (const prefix of scope.orgfs?.allow_prefixes ?? []) {
      checks.push({ permission: 'orgfs:write', resource: { type: 'orgfs', id: this.pathPatternBase(prefix), action: 'write' } });
    }
    for (const prefix of scope.orgfs?.read_only_prefixes ?? []) {
      checks.push({ permission: 'orgfs:read', resource: { type: 'orgfs', id: this.pathPatternBase(prefix), action: 'read' } });
    }
    for (const prefix of scope.orgdocs?.allow_prefixes ?? []) {
      checks.push({ permission: 'orgdocs:write', resource: { type: 'orgdocs', id: this.pathPatternBase(prefix), action: 'write' } });
    }
    for (const prefix of scope.orgdocs?.read_only_prefixes ?? []) {
      checks.push({ permission: 'orgdocs:read', resource: { type: 'orgdocs', id: this.pathPatternBase(prefix), action: 'read' } });
    }
    for (const mountId of scope.cloud_fs?.allow_mount_ids ?? []) {
      checks.push({ permission: 'cloud_fs:read', resource: { type: 'cloud_fs', id: mountId, action: 'read' } });
    }
    for (const schema of scope.envdb?.schemas ?? []) {
      checks.push({ permission: 'envdb:read', resource: { type: 'envdb', id: schema, action: 'read' } });
    }
    for (const table of scope.envdb?.tables ?? []) {
      checks.push({ permission: 'envdb:read', resource: { type: 'envdb', id: table, action: 'read' } });
    }

    for (const check of checks) {
      if (check.resource.id === '*') continue;
      const result = await this.accessService.can({
        org_id: orgId,
        principal_type: 'user',
        principal_id: userId,
        project_id: projectId,
        permission: check.permission,
        resource: check.resource,
      });
      if (!result.allowed) {
        throw new BadRequestException(`${context} is outside the invoking actor's access scope: ${check.permission} ${check.resource.id}`);
      }
    }
  }

  private parseTokenPermissions(value: unknown, path: string): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      throw new BadRequestException(`Invalid ${path}: expected array of permission strings`);
    }
    const invalid: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new BadRequestException(`Invalid ${path}: every entry must be a non-empty string`);
      }
      if (!isValidPermission(entry)) invalid.push(entry);
    }
    if (invalid.length > 0) {
      throw new BadRequestException(`Invalid ${path}: unknown permission(s) ${invalid.join(', ')}`);
    }
    return [...new Set(value as string[])].sort();
  }

  private mergeStepTokenPermissions(
    workflowPermissions: string[] | undefined,
    stepPermissions: string[] | undefined,
    invocationPermissions: string[] | undefined,
  ): string[] | null {
    // Innermost wins: step > invocation > workflow. (The plan's stated precedence
    // is invocation > step > workflow, but invocation overrides are admin-gated
    // and not implemented yet; favouring step keeps least-privilege for the MVP.)
    const winner = stepPermissions ?? invocationPermissions ?? workflowPermissions;
    if (!winner) return null;
    return [...new Set(winner)].sort();
  }

  private async assertActorCanGrantPermissions(
    orgId: string,
    projectId: string,
    userId: string | undefined,
    permissions: string[] | null,
    context: string,
  ): Promise<void> {
    if (!userId || !permissions || permissions.length === 0 || !this.accessService) return;
    for (const permission of permissions) {
      const result = await this.accessService.can({
        org_id: orgId,
        principal_type: 'user',
        principal_id: userId,
        project_id: projectId,
        permission,
      });
      if (!result.allowed) {
        throw new BadRequestException(`${context} requests permission "${permission}" that the invoking actor does not hold`);
      }
    }
  }

  /**
   * Extract with_apis from workflow definition.
   * Supports both `with_apis` and `with-apis` keys.
   */
  private extractWithApis(definition: Record<string, unknown>): string[] | undefined {
    const withApis = definition.with_apis ?? definition['with-apis'];
    if (!Array.isArray(withApis) || withApis.length === 0) return undefined;

    // Handle both string format ["api"] and object format [{service: "api", ...}]
    const names = withApis.map(a => {
      if (typeof a === 'string') return a;
      if (typeof a === 'object' && a !== null && 'service' in a) return (a as { service: string }).service;
      return null;
    }).filter((n): n is string => n !== null);

    return names.length > 0 ? names : undefined;
  }

  /**
   * Validate that requested APIs exist for the project and append an instruction
   * block to the description so the agent can call them at runtime.
   * For workflows, missing APIs produce a warning rather than a hard failure.
   */
  private async resolveAppApis(
    projectId: string,
    description: string,
    apiNames: string[],
    envName?: string | null,
  ): Promise<{ description: string; resolvedApis: Array<{ name: string; type: string; base_url: string; cli?: AppApiCliInfo }> }> {
    // Look up available APIs for this project from registered sources
    const sources = await this.apiSources.list({
      project_id: projectId,
      env_name: envName ?? undefined,
    });
    const unscopedSources = envName
      ? await this.apiSources.list({ project_id: projectId, env_name: null })
      : [];
    const allSources = [...sources, ...unscopedSources];

    const availableApis = new Map<string, { type: string; base_url: string; cli?: AppApiCliInfo }>(
      allSources.map(s => [s.name, { type: s.type, base_url: s.base_url }]),
    );

    // Fallback: construct internal K8s URLs from manifest services + environments
    // This path also extracts CLI metadata from the manifest x-eve.cli declarations
    const missing = apiNames.filter(name => !availableApis.has(name));
    if (missing.length > 0) {
      await this.resolveApisFromManifest(projectId, missing, availableApis);
    }

    const stillMissing = apiNames.filter(name => !availableApis.has(name));
    if (stillMissing.length > 0) {
      console.warn(
        `Workflow references APIs not found in project ${projectId}: ${stillMissing.join(', ')}. ` +
        `Available: ${[...availableApis.keys()].join(', ') || '(none)'}`,
      );
    }

    // Only generate instruction lines for APIs that actually exist
    const resolved = apiNames
      .filter(name => availableApis.has(name))
      .map(name => {
        const info = availableApis.get(name)!;
        return { name, type: info.type, base_url: info.base_url, ...(info.cli ? { cli: info.cli } : {}) };
      });

    return {
      description: resolved.length > 0 ? description + buildAppApiInstructionBlock(resolved) : description,
      resolvedApis: resolved,
    };
  }

  private async resolveWorkflowAppLinkHints(
    projectId: string,
    hints: JobHints,
    envName: string | null,
  ): Promise<JobHints> {
    const explicitLinks = Array.isArray(hints.app_links)
      ? hints.app_links.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0)
      : undefined;

    let linkAliases = explicitLinks;
    if (!linkAliases?.length) {
      const subscriptions = await this.appLinkSubscriptions.listByConsumer(projectId);
      linkAliases = subscriptions
        .filter((subscription) =>
          subscription.inject_into_jobs &&
          (envName || subscription.environment_strategy !== 'same')
        )
        .map((subscription) => subscription.local_alias);
    }
    if (!linkAliases?.length) return hints;

    const resolvedLinks = await this.resolveAppLinks(projectId, linkAliases, envName);
    return {
      ...hints,
      app_links: linkAliases,
      ...(resolvedLinks.length > 0 ? { resolved_app_links: resolvedLinks } : {}),
    };
  }

  private async resolveAppLinks(
    projectId: string,
    aliases: string[],
    envName?: string | null,
  ): Promise<AppApiInfo[]> {
    const resolved: AppApiInfo[] = [];
    const subscriptions = await this.appLinkSubscriptions.listWithGrants({
      consumer_project_id: projectId,
    });
    const byAlias = new Map(subscriptions.map((subscription) => [subscription.local_alias, subscription]));

    for (const alias of aliases) {
      const subscription = byAlias.get(alias);
      if (!subscription || !subscription.api_grant) {
        throw new BadRequestException(`App link not found for project: ${alias}`);
      }
      const grant = subscription.api_grant;
      if (grant.revoked_at) {
        throw new BadRequestException(`App link "${alias}" grant is revoked`);
      }
      if (!subscription.inject_into_jobs) {
        throw new BadRequestException(`App link "${alias}" is not exposed to jobs (set inject_into.jobs: true)`);
      }
      if (!grant.service_name) {
        throw new BadRequestException(`App link "${alias}" does not expose an API service`);
      }

      const producerEnv = subscription.environment_strategy === 'same'
        ? envName
        : subscription.producer_env_name;
      if (!producerEnv) {
        throw new BadRequestException(`App link "${alias}" requires an env_name or fixed producer environment`);
      }
      if (grant.envs.length > 0 && !grant.envs.includes(producerEnv)) {
        throw new BadRequestException(`App link "${alias}" is not granted for producer env ${producerEnv}`);
      }

      const producerProject = await this.projects.findById(grant.producer_project_id);
      if (!producerProject) {
        throw new BadRequestException(`Producer project ${grant.producer_project_id} not found for app link "${alias}"`);
      }
      const producerOrg = await this.orgs.findById(producerProject.org_id, { include_deleted: false });
      if (!producerOrg) {
        throw new BadRequestException(`Producer org ${producerProject.org_id} not found for app link "${alias}"`);
      }
      const port = await this.resolveAppLinkServicePort(grant.producer_project_id, grant.service_name);
      const namespace = deriveNamespace(producerOrg.slug, producerProject.slug, producerEnv);
      const baseUrl = `http://${producerEnv}-${grant.service_name}.${namespace}.svc.cluster.local${port ? `:${port}` : ''}`;
      resolved.push({
        name: grant.export_name,
        alias,
        subscription_id: subscription.id,
        origin: 'app_link',
        type: 'openapi',
        base_url: baseUrl,
        scopes: subscription.requested_scopes,
        producer_project_id: grant.producer_project_id,
        producer_env: producerEnv,
        ...(grant.cli_name ? { cli: { name: grant.cli_name, bin: grant.cli_bin_path ?? grant.cli_name, ...(grant.cli_image ? { image: grant.cli_image } : {}) } } : {}),
      });
    }

    return resolved;
  }

  private async resolveAppLinkServicePort(projectId: string, serviceName: string): Promise<number | null> {
    const manifestRecord = await this.manifests.findLatestByProject(projectId);
    if (!manifestRecord) return null;
    try {
      const manifest = yaml.parse(manifestRecord.manifest_yaml) as Record<string, unknown>;
      const services = getServicesFromManifest(manifest as never);
      const service = services?.[serviceName];
      if (!service) return null;
      return this.extractServicePort(service as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fallback: resolve API URLs from manifest services and deployed environments.
   * When with_apis references a service name that matches a manifest service with ports,
   * construct the internal K8s URL from the environment deployment.
   */
  private async resolveApisFromManifest(
    projectId: string,
    apiNames: string[],
    availableApis: Map<string, { type: string; base_url: string; cli?: AppApiCliInfo }>,
  ): Promise<void> {
    try {
      const project = await this.projects.findById(projectId);
      if (!project) { console.warn(`[with_apis fallback] Project ${projectId} not found`); return; }

      const org = await this.orgs.findById(project.org_id, { include_deleted: false });
      if (!org) { console.warn(`[with_apis fallback] Org ${project.org_id} not found`); return; }

      const manifestRecord = await this.manifests.findLatestByProject(projectId);
      if (!manifestRecord) { console.warn(`[with_apis fallback] No manifest for project ${projectId}`); return; }

      const manifest = yaml.parse(manifestRecord.manifest_yaml) as Record<string, unknown>;
      const services = getServicesFromManifest(manifest as never);

      // Find first deployed environment
      const envs = await this.environments.list({ project_id: projectId, limit: 10, offset: 0 });
      const activeEnv = envs.find(e => e.status === 'active') ?? envs[0];
      if (!activeEnv) { console.warn(`[with_apis fallback] No environments for ${projectId}`); return; }

      for (const name of apiNames) {
        let portSuffix = '';
        let cliInfo: AppApiCliInfo | undefined;
        if (services) {
          const service = services[name];
          if (service) {
            const port = this.extractServicePort(service as Record<string, unknown>);
            portSuffix = port ? `:${port}` : '';

            // Extract CLI metadata from x-eve.cli
            const xeve = (service as Record<string, unknown>)['x-eve'] ?? (service as Record<string, unknown>).x_eve;
            const cli = xeve && typeof xeve === 'object' ? (xeve as Record<string, unknown>).cli : undefined;
            if (cli && typeof cli === 'object') {
              const c = cli as Record<string, string>;
              if (c.name && c.bin) {
                cliInfo = { name: c.name, bin: c.bin, ...(c.image ? { image: c.image } : {}) };
              }
            }
          }
        }

        // Construct internal K8s URL from naming convention
        const namespace = deriveNamespace(org.slug, project.slug, activeEnv.name);
        const baseUrl = `http://${activeEnv.name}-${name}.${namespace}.svc.cluster.local${portSuffix}`;
        console.warn(`[with_apis fallback] Resolved ${name} → ${baseUrl}${cliInfo ? ` (CLI: ${cliInfo.name})` : ''}`);

        availableApis.set(name, { type: 'openapi', base_url: baseUrl, ...(cliInfo ? { cli: cliInfo } : {}) });
      }
    } catch (error) {
      // Non-fatal — just means we couldn't resolve from manifest
      console.warn(`Failed to resolve APIs from manifest for ${projectId}: ${error}`);
    }
  }

  /**
   * Extract the first port number from a service definition.
   */
  private extractServicePort(service: Record<string, unknown>): number | undefined {
    const ports = service.ports;
    if (!Array.isArray(ports) || ports.length === 0) return undefined;
    const first = ports[0];
    if (typeof first === 'number') return first;
    if (typeof first === 'string') {
      const pieces = first.split(':');
      const parsed = parseInt(pieces[pieces.length - 1], 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  /**
   * Extract resource refs from workflow input. For doc.ingest events, builds
   * an ingest:// URI so the worker hydrates the uploaded file into the workspace.
   */
  private buildResourceRefsFromInput(
    input?: Record<string, unknown>,
  ): ResourceRef[] {
    if (!input) return [];

    const refs: ResourceRef[] = [];
    const explicitRefs = input.resource_refs;
    if (explicitRefs !== undefined) {
      if (!Array.isArray(explicitRefs)) {
        throw new BadRequestException('Workflow input.resource_refs must be an array');
      }
      for (const [index, rawRef] of explicitRefs.entries()) {
        const parsed = ResourceRefSchema.safeParse(rawRef);
        if (!parsed.success) {
          throw new BadRequestException(
            `Workflow input.resource_refs[${index}] is invalid: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`,
          );
        }
        refs.push(parsed.data);
      }
    }

    const payload = input.payload as Record<string, unknown> | undefined;
    if (!payload) return refs;

    const ingestId = payload.ingest_id;
    const fileName = payload.file_name;
    if (typeof ingestId === 'string' && typeof fileName === 'string') {
      const ref: ResourceRef = {
        uri: buildIngestUri(ingestId, fileName),
        label: fileName as string,
        required: true,
      };

      // Thread mime_type so agents know the file type without guessing from extension
      if (typeof payload.mime_type === 'string') {
        ref.mime_type = payload.mime_type;
      }

      // Thread ingest context so agents can honor submitter instructions
      const metadata: Record<string, unknown> = {};
      if (typeof payload.title === 'string' && payload.title) metadata.title = payload.title;
      if (typeof payload.description === 'string' && payload.description) metadata.description = payload.description;
      if (typeof payload.instructions === 'string' && payload.instructions) metadata.instructions = payload.instructions;
      if (Array.isArray(payload.tags) && payload.tags.length > 0) metadata.tags = payload.tags;
      if (typeof payload.size_bytes === 'number') metadata.size_bytes = payload.size_bytes;
      if (Object.keys(metadata).length > 0) ref.metadata = metadata;

      refs.push(ref);
    }

    return refs;
  }

  private parseResourceRefsPolicy(
    raw: unknown,
    source: ResourceRefsPolicySource,
    context: string,
  ): ResolvedResourceRefsPolicy | null {
    if (raw === undefined || raw === null) {
      return null;
    }

    if (typeof raw === 'string') {
      if (raw === 'inherit' || raw === 'all') {
        return { mode: 'inherit', source, selectors: [] };
      }
      if (raw === 'none') {
        return { mode: 'none', source, selectors: [] };
      }
      throw new BadRequestException(
        `${context} has invalid resource_refs value "${raw}". Use "inherit", "none", or an array of selectors.`,
      );
    }

    if (Array.isArray(raw)) {
      if (!raw.every((item): item is string => typeof item === 'string' && item.length > 0)) {
        throw new BadRequestException(`${context} resource_refs array must contain non-empty strings`);
      }
      return { mode: 'selected', source, selectors: raw };
    }

    if (typeof raw === 'object') {
      const config = raw as Record<string, unknown>;
      const modeValue = config.mode;
      const includeValue = config.include;
      const selectors = includeValue === undefined
        ? []
        : Array.isArray(includeValue) && includeValue.every((item): item is string => typeof item === 'string' && item.length > 0)
          ? includeValue
          : null;
      if (selectors === null) {
        throw new BadRequestException(`${context} resource_refs.include must be an array of non-empty strings`);
      }

      if (modeValue !== undefined && modeValue !== 'inherit' && modeValue !== 'all' && modeValue !== 'none' && modeValue !== 'selected') {
        throw new BadRequestException(
          `${context} resource_refs.mode must be one of inherit, all, none, selected`,
        );
      }

      const mode = modeValue === 'all'
        ? 'inherit'
        : (modeValue as ResourceRefsPolicyMode | undefined) ?? (selectors.length > 0 ? 'selected' : 'inherit');

      if (mode === 'selected' && selectors.length === 0) {
        throw new BadRequestException(`${context} resource_refs selected mode requires include selectors`);
      }
      if (mode !== 'selected' && selectors.length > 0) {
        throw new BadRequestException(`${context} resource_refs.include can only be used with selected mode`);
      }

      return { mode, source, selectors };
    }

    throw new BadRequestException(`${context} resource_refs must be "inherit", "none", an array, or an object`);
  }

  private resolveStepResourceRefs(
    invocationRefs: ResourceRef[],
    workflowPolicy: ResolvedResourceRefsPolicy | null,
    step: Record<string, unknown>,
    workflowName: string,
    stepName: string,
  ): { resourceRefs: ResourceRef[]; summary: ResourceRefsAccessSummary } {
    const stepPolicy = this.parseResourceRefsPolicy(
      step.resource_refs,
      'step',
      `Workflow "${workflowName}" step "${stepName}"`,
    );
    const policy = stepPolicy ?? workflowPolicy ?? { mode: 'inherit' as const, source: 'default' as const, selectors: [] };

    const selected = policy.mode === 'inherit'
      ? { refs: invocationRefs, missingSelectors: [] as string[] }
      : policy.mode === 'none'
        ? { refs: [] as ResourceRef[], missingSelectors: [] as string[] }
        : this.selectResourceRefs(invocationRefs, policy.selectors);

    return {
      resourceRefs: selected.refs,
      summary: {
        mode: policy.mode,
        source: policy.source,
        count: selected.refs.length,
        inherited_count: invocationRefs.length,
        ...(policy.selectors.length > 0 ? { selectors: policy.selectors } : {}),
        ...(selected.missingSelectors.length > 0 ? { missing_selectors: selected.missingSelectors } : {}),
      },
    };
  }

  private selectResourceRefs(
    refs: ResourceRef[],
    selectors: string[],
  ): { refs: ResourceRef[]; missingSelectors: string[] } {
    const selected: ResourceRef[] = [];
    const seen = new Set<ResourceRef>();
    const missingSelectors: string[] = [];

    for (const selector of selectors) {
      const matches = refs.filter((ref) => this.resourceRefSelectorValues(ref).has(selector));
      if (matches.length === 0) {
        missingSelectors.push(selector);
        continue;
      }
      for (const ref of matches) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        selected.push(ref);
      }
    }

    return { refs: selected, missingSelectors };
  }

  private resourceRefSelectorValues(ref: ResourceRef): Set<string> {
    const values = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value === 'string' && value.length > 0) values.add(value);
    };

    add(ref.name);
    add(ref.label);
    add(ref.mount_path);
    add(ref.uri);

    const metadata = ref.metadata;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      add(metadata.name);
      add(metadata.resource_name);
      add(metadata.key);
    }

    return values;
  }

  private async ensureProjectExists(projectId: string): Promise<void> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }

  private parseWorkflowStepExecution(
    step: Record<string, unknown>,
    workflowName: string,
    stepName: string,
  ): StepExecution {
    try {
      return parseWorkflowStepExecution(step, stepName);
    } catch (error) {
      throw new BadRequestException(
        `Workflow "${workflowName}" step "${stepName}" has invalid execution config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private parseToolchains(value: unknown, path: string): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      throw new BadRequestException(`Invalid ${path}: expected array of toolchain names`);
    }

    const toolchains: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new BadRequestException(`Invalid ${path}: every entry must be a non-empty string`);
      }
      if (!VALID_TOOLCHAIN_SET.has(entry)) {
        throw new BadRequestException(`Invalid ${path}: unknown toolchain "${entry}"`);
      }
      toolchains.push(entry);
    }

    return [...new Set(toolchains)];
  }

  private resolveStepToolchains(
    workflowToolchains: string[] | undefined,
    stepToolchains: string[] | undefined,
  ): string[] {
    if (stepToolchains && stepToolchains.length > 0) return stepToolchains;
    if (workflowToolchains && workflowToolchains.length > 0) return workflowToolchains;
    return [];
  }

  private resolveAgentToolchains(
    workflowToolchains: string[] | undefined,
    stepToolchains: string[] | undefined,
    agentToolchains: string[] | undefined,
  ): string[] {
    if (stepToolchains && stepToolchains.length > 0) return stepToolchains;
    if (agentToolchains && agentToolchains.length > 0) return agentToolchains;
    if (workflowToolchains && workflowToolchains.length > 0) return workflowToolchains;
    return [];
  }

  private emptyStepAgentConfig(): {
    agentId: string | null;
    harness: string | null;
    harnessProfile: string | null;
    harnessOptions: Record<string, unknown> | null;
    permission: string | null;
    toolchains: string[];
    harnessProfileOverride: InlineProfileBundle | null;
    harnessProfileSource: HarnessProfileSource | null;
    harnessProfileHash: string | null;
  } {
    return {
      agentId: null,
      harness: null,
      harnessProfile: null,
      harnessOptions: null,
      permission: null,
      toolchains: [],
      harnessProfileOverride: null,
      harnessProfileSource: null,
      harnessProfileHash: null,
    };
  }

  private workflowHintsForExecution(
    workflowHints: JobHints,
    executionType: StepExecution['executionType'],
  ): JobHints {
    const hints = { ...workflowHints } as JobHints;
    if (executionType === 'script') {
      delete hints.permission_policy;
      delete hints.toolchains;
      delete hints.app_apis;
      delete hints.resolved_app_apis;
    }
    return hints;
  }

  // ============================================================================
  // Workflow invocation — expands into a job DAG
  // ============================================================================

  async invoke(
    projectId: string,
    workflowName: string,
    request?: WorkflowInvokeRequest,
    wait: boolean = false,
    userId?: string,
  ): Promise<WorkflowInvokeResponse | WorkflowInvokeResult> {
    // 1. Validate project and workflow exist
    await this.ensureProjectExists(projectId);
    const workflow = await this.findByName(projectId, workflowName);
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const steps = workflow.definition.steps as Array<Record<string, unknown>> | undefined;
    if (!steps?.length) {
      throw new BadRequestException(`Workflow "${workflowName}" has no steps`);
    }

    // 2. Validate the dependency graph before creating any jobs
    validateStepGraph(workflowName, steps);
    const stepExecutions = steps.map((step, index) => {
      const stepName = (step.name as string) || `step-${index + 1}`;
      const execution = this.parseWorkflowStepExecution(step, workflowName, stepName);
      if (execution.executionType === 'action') {
        throw new BadRequestException('workflow action steps not yet supported — use a pipeline');
      }
      return execution;
    });

    // 3. Prepare shared context
    const rawWorkflowHints = this.extractWorkflowHints(workflow.definition, projectId);
    const workflowGit = this.extractWorkflowGit(workflow.definition);
    const workflowEnvName =
      typeof workflow.definition.env === 'string' && workflow.definition.env.length > 0
        ? workflow.definition.env
        : null;
    const workflowHints = await this.resolveWorkflowAppLinkHints(projectId, rawWorkflowHints, workflowEnvName);
    const resourceRefs = this.buildResourceRefsFromInput(request?.input);
    const workflowResourceRefsPolicy = this.parseResourceRefsPolicy(
      workflow.definition.resource_refs,
      'workflow',
      `Workflow "${workflowName}"`,
    );
    const workflowEnvOverrides = this.parseEnvOverrides(
      workflow.definition.env_overrides,
      `Workflow "${workflowName}".env_overrides`,
    );
    const invocationEnvOverrides = this.parseEnvOverrides(
      request?.env_overrides,
      `Workflow "${workflowName}" invocation env_overrides`,
    );
    const workflowTokenScope = this.parseTokenScope(
      workflow.definition.scope,
      `Workflow "${workflowName}".scope`,
    );
    const invocationTokenScope = this.parseTokenScope(
      request?.scope,
      `Workflow "${workflowName}" invocation scope`,
    );
    const workflowTokenPermissions = this.parseTokenPermissions(
      (workflow.definition as { permissions?: unknown }).permissions,
      `Workflow "${workflowName}".permissions`,
    );
    const invocationTokenPermissions = this.parseTokenPermissions(
      request?.permissions,
      `Workflow "${workflowName}" invocation permissions`,
    );
    const appApis = this.extractWithApis(workflow.definition);
    const workflowToolchains = this.parseToolchains(
      (workflow.definition as { toolchains?: unknown }).toolchains,
      `Workflow "${workflowName}".toolchains`,
    );

    // Phase 4: Build the template scope for `${inputs.<key>}` and
    // `${event.payload.<path>}` references in step harness_profile /
    // harness_profile_override. Event-triggered workflows receive the raw
    // event payload on `input.payload` (see orchestrator EventRouterService),
    // so we surface it as both `inputs.*` (via `from:` declarations) and as
    // the `event.payload` scope root.
    const invokeInput = (request?.input && typeof request.input === 'object')
      ? request.input as Record<string, unknown>
      : {};
    const eventPayload = invokeInput.payload;
    const declaredInputs = workflow.definition.inputs as Record<string, unknown> | undefined;
    const resolvedInputs = buildWorkflowInputsScope(declaredInputs, invokeInput, eventPayload);
    const templateScope: EvaluateScope = {
      inputs: resolvedInputs,
      event: { payload: eventPayload },
    };

    // 4. Create root/container job
    const { id: rootJobId } = await this.jobs.generateJobId(project.id);

    await this.jobs.create({
      id: rootJobId,
      project_id: projectId,
      parent_id: null,
      depth: 0,
      title: `[Workflow] ${workflowName}`,
      description: `Workflow: ${workflowName} (${steps.length} steps)`,
      issue_type: 'task',
      labels: [`workflow:${workflowName}`],
      phase: 'active', // Container — stays active until children complete
      priority: 0,
      assignee: null,
      review_required: 'none',
      review_status: null,
      reviewer: null,
      defer_until: null,
      due_at: null,
      hints: {
        ...workflowHints,
        workflow_name: workflowName,
        workflow_root: true,
        ...(request?.input ? { request_json: JSON.stringify(request.input) } : {}),
      },
      harness: null,
      harness_profile: null,
      harness_options: null,
      harness_profile_override: null,
      env_overrides: null,
      token_scope: null,
      token_permissions: null,
      harness_profile_source: null,
      harness_profile_hash: null,
      git_json: workflowGit,
      resolved_git_json: null,
      workspace_json: null,
      blocked_on_gates: [],
      env_name: workflowEnvName,
      execution_mode: 'ephemeral',
      execution_type: 'agent',
      run_id: null,
      step_name: null,
      action_type: null,
      action_input: null,
      script_command: null,
      script_timeout_seconds: null,
      target: null,
      resource_refs: resourceRefs,
      content_hash: null,
      actor_user_id: userId ?? null,
      failure_disposition: null,
      closed_at: null,
      close_reason: null,
    });

    // 5. Create one child job per step
    const stepNameToJobId = new Map<string, string>();
    const stepJobSummaries: WorkflowStepJob[] = [];

    for (const [index, step] of steps.entries()) {
      const stepName = (step.name as string) || `step-${index + 1}`;
      const { id: stepJobId } = await this.jobs.generateJobId(project.id, rootJobId);
      const stepExecution = stepExecutions[index];
      const stepToolchains = this.parseToolchains(
        step.toolchains,
        `Workflow "${workflowName}" step "${stepName}".toolchains`,
      );

      // Resolve agent config only for agent steps. Script steps execute on the worker.
      const agentConfig = stepExecution.executionType === 'agent'
        ? await this.resolveStepAgentFromStep(projectId, step, templateScope, workflowName, workflowToolchains, stepToolchains)
        : this.emptyStepAgentConfig();
      const resolvedToolchains = stepExecution.executionType === 'agent'
        ? agentConfig.toolchains
        : this.resolveStepToolchains(workflowToolchains, stepToolchains);

      // Resolve app API instructions for step description.
      // Per-step with_apis overrides workflow-level; workflow-level is the fallback.
      const stepApis = stepExecution.executionType === 'agent'
        ? this.extractWithApis(step as Record<string, unknown>) ?? appApis
        : undefined;
      let stepDescription = stepExecution.executionType === 'script'
        ? stepExecution.scriptCommand ?? `Workflow step: ${stepName}`
        : `Workflow step: ${stepName}`;
      if (request?.input && typeof request.input === 'object' && Object.keys(request.input).length > 0) {
        stepDescription += `\n\nWorkflow input:\n${JSON.stringify(request.input, null, 2)}`;
      }
      let resolvedApis: Array<{ name: string; type: string; base_url: string }> = [];
      if (stepApis?.length) {
        const apiResult = await this.resolveAppApis(projectId, stepDescription, stepApis, workflowEnvName);
        stepDescription = apiResult.description;
        resolvedApis = apiResult.resolvedApis;
      }

      const dependsOn = step.depends_on as string[] | undefined;
      const condition = typeof step.condition === 'string' ? step.condition : undefined;
      const stepGit = this.resolveStepGit(workflowGit, step, templateScope, workflowName, stepName);
      const stepEnvOverrides = this.parseEnvOverrides(
        step.env_overrides,
        `Workflow "${workflowName}" step "${stepName}".env_overrides`,
      );
      const stepJobEnvOverrides = this.mergeStepEnvOverrides(
        workflowEnvOverrides,
        stepEnvOverrides,
        invocationEnvOverrides,
        `Workflow "${workflowName}" step "${stepName}" merged env_overrides`,
      );
      const stepTokenScope = this.parseTokenScope(
        step.scope,
        `Workflow "${workflowName}" step "${stepName}".scope`,
      );
      const stepJobTokenScope = this.mergeStepTokenScope(
        workflowTokenScope,
        stepTokenScope,
        invocationTokenScope,
      );
      await this.assertActorCanUseScope(
        project.org_id,
        projectId,
        userId,
        stepJobTokenScope,
        `Workflow "${workflowName}" step "${stepName}" scope`,
      );
      const stepTokenPermissions = this.parseTokenPermissions(
        (step as { permissions?: unknown }).permissions,
        `Workflow "${workflowName}" step "${stepName}".permissions`,
      );
      const stepJobTokenPermissions = this.mergeStepTokenPermissions(
        workflowTokenPermissions,
        stepTokenPermissions,
        invocationTokenPermissions,
      );
      await this.assertActorCanGrantPermissions(
        project.org_id,
        projectId,
        userId,
        stepJobTokenPermissions,
        `Workflow "${workflowName}" step "${stepName}" permissions`,
      );
      const {
        resourceRefs: stepResourceRefs,
        summary: stepResourceRefsSummary,
      } = this.resolveStepResourceRefs(resourceRefs, workflowResourceRefsPolicy, step, workflowName, stepName);
      const agentStep =
        step.agent && typeof step.agent === 'object' && !Array.isArray(step.agent)
          ? step.agent as Record<string, unknown>
          : null;
      const agentPrompt =
        typeof agentStep?.prompt === 'string' && agentStep.prompt.length > 0
          ? agentStep.prompt
          : null;
      const description =
        agentPrompt
          ? `${agentPrompt}${stepDescription === `Workflow step: ${stepName}` ? '' : `\n\n${stepDescription}`}`
          : stepDescription;

      await this.jobs.create({
        id: stepJobId,
        project_id: projectId,
        parent_id: rootJobId,
        depth: 1,
        title: `[${workflowName}] ${stepName}`,
        description,
        issue_type: 'task',
        labels: [`workflow:${workflowName}`, `step:${stepName}`],
        phase: 'ready',
        priority: Math.min(index, 4),  // Clamp to valid range (0-4); step ordering uses depends_on
        assignee: agentConfig.agentId,
        review_required: 'none',
        review_status: null,
        reviewer: null,
        defer_until: null,
        due_at: null,
        hints: {
          ...this.workflowHintsForExecution(workflowHints, stepExecution.executionType),
          workflow_name: workflowName,
          step_name: stepName,
          step_index: index,
          ...(condition ? { condition } : {}),
          ...(agentConfig.permission ? { permission_policy: agentConfig.permission } : {}),
          ...(workflow.db_access ? { db_access: workflow.db_access } : {}),
          ...(request?.input ? { request_json: JSON.stringify(request.input) } : {}),
          ...(resolvedToolchains.length > 0 ? { toolchains: resolvedToolchains } : {}),
          ...(stepApis ? { app_apis: stepApis } : {}),
          ...(resolvedApis.length > 0 ? { resolved_app_apis: resolvedApis } : {}),
          resource_refs_policy: stepResourceRefsSummary.mode,
          resource_refs_policy_source: stepResourceRefsSummary.source,
          resource_refs_count: stepResourceRefsSummary.count,
          resource_refs_inherited_count: stepResourceRefsSummary.inherited_count,
          ...(stepResourceRefsSummary.selectors ? { resource_refs_selectors: stepResourceRefsSummary.selectors } : {}),
          ...(stepResourceRefsSummary.missing_selectors ? { resource_refs_missing_selectors: stepResourceRefsSummary.missing_selectors } : {}),
        },
        harness: agentConfig.harness,
        harness_profile: agentConfig.harnessProfile,
        harness_options: agentConfig.harnessOptions,
        harness_profile_override: agentConfig.harnessProfileOverride,
        env_overrides: stepJobEnvOverrides,
        token_scope: stepJobTokenScope,
        token_permissions: stepJobTokenPermissions,
        harness_profile_source: agentConfig.harnessProfileSource,
        harness_profile_hash: agentConfig.harnessProfileHash,
        git_json: stepGit,
        resolved_git_json: null,
        workspace_json: null,
        blocked_on_gates: [],
        env_name: workflowEnvName,
        execution_mode: 'ephemeral',
        execution_type: stepExecution.executionType,
        run_id: null,
        step_name: stepName,
        action_type: null,
        action_input: null,
        script_command: stepExecution.scriptCommand,
        script_timeout_seconds: stepExecution.scriptTimeoutSeconds,
        target: null,
        resource_refs: stepResourceRefs,
        content_hash: null,
        actor_user_id: userId ?? null,
        failure_disposition: null,
        closed_at: null,
        close_reason: null,
      });

      stepNameToJobId.set(stepName, stepJobId);
      stepJobSummaries.push({
        job_id: stepJobId,
        step_name: stepName,
        depends_on: Array.isArray(dependsOn) && dependsOn.length > 0 ? dependsOn : undefined,
        resource_refs: stepResourceRefsSummary,
      });
    }

    // 6. Wire dependencies via job relations
    for (const [index, step] of steps.entries()) {
      const stepName = (step.name as string) || `step-${index + 1}`;
      const jobId = stepNameToJobId.get(stepName);
      if (!jobId) continue;

      const dependsOn = step.depends_on as string[] | undefined;
      if (Array.isArray(dependsOn)) {
        for (const depName of dependsOn) {
          const depJobId = stepNameToJobId.get(depName);
          if (!depJobId) {
            // Should never happen — validateStepGraph already checked
            throw new BadRequestException(
              `Step "${stepName}" depends on unknown step "${depName}"`,
            );
          }
          await this.jobs.addDependency(jobId, depJobId, 'blocks');
        }
      }
    }

    // 7. Return response
    if (!wait) {
      return {
        job_id: rootJobId,
        status: 'active',
        step_jobs: stepJobSummaries,
      };
    }

    // 8. Poll for completion (wait=true) — all step children must finish
    return this.pollStepJobsForCompletion(rootJobId, stepNameToJobId);
  }

  /**
   * Retry the failed/current tail of an existing workflow root.
   *
   * This intentionally clones the already-materialized child jobs instead of
   * re-reading the current manifest. That preserves the original inputs,
   * interpolated git controls, harness choices, API hints, and resource refs.
   */
  async retry(
    projectId: string,
    request: WorkflowRetryRequest,
    userId?: string,
  ): Promise<WorkflowRetryResponse> {
    await this.ensureProjectExists(projectId);

    const root = await this.jobs.findById(request.root_job_id);
    if (!root) {
      throw new NotFoundException(`Workflow root job ${request.root_job_id} not found`);
    }
    if (root.project_id !== projectId) {
      throw new BadRequestException(
        `Workflow root ${root.id} belongs to project ${root.project_id}, not ${projectId}`,
      );
    }
    if (!this.isWorkflowRoot(root)) {
      throw new BadRequestException(`Job ${root.id} is not a workflow root`);
    }

    const mode = request.failed ? 'failed' as const : 'from' as const;
    const requestedAt = new Date().toISOString();

    return this.db.begin(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const txJobs = jobQueries(tx);

      const [lockedRoot] = await tx<Job[]>`
        SELECT * FROM jobs WHERE id = ${root.id} FOR UPDATE
      `;
      if (!lockedRoot) {
        throw new NotFoundException(`Workflow root job ${root.id} not found`);
      }
      if (!this.isWorkflowRoot(lockedRoot)) {
        throw new BadRequestException(`Job ${root.id} is not a workflow root`);
      }

      const allChildren = await tx<Job[]>`
        SELECT * FROM jobs
        WHERE parent_id = ${lockedRoot.id}
        ORDER BY created_at ASC, id ASC
        FOR UPDATE
      `;
      const currentChildren = allChildren.filter((job) => !this.isSupersededWorkflowStep(job));
      if (currentChildren.length === 0) {
        throw new BadRequestException(`Workflow root ${lockedRoot.id} has no current step jobs to retry`);
      }

      const openChildren = currentChildren.filter((job) => !this.isTerminal(job));
      if (openChildren.length > 0) {
        const blockers = openChildren
          .map((job) => `${job.step_name ?? job.id} (${job.id}: ${job.phase})`)
          .join(', ');
        throw new BadRequestException(
          `Cannot retry workflow ${lockedRoot.id} while current steps are not terminal: ${blockers}`,
        );
      }

      const currentIds = currentChildren.map((job) => job.id);
      const relations = currentIds.length === 0
        ? []
        : await tx<Array<{ job_id: string; related_job_id: string; relation_type: string }>>`
            SELECT r.job_id, r.related_job_id, r.relation_type
            FROM job_relations r
            WHERE r.job_id = ANY(${currentIds})
              AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
          `;

      const childrenById = new Map(currentChildren.map((job) => [job.id, job]));
      const childrenByStep = new Map<string, Job>();
      for (const child of currentChildren) {
        if (!child.step_name) continue;
        if (childrenByStep.has(child.step_name)) {
          throw new BadRequestException(
            `Workflow ${lockedRoot.id} has multiple current jobs for step "${child.step_name}"; cannot retry safely`,
          );
        }
        childrenByStep.set(child.step_name, child);
      }

      const selectedIds = this.selectWorkflowRetrySteps({
        mode,
        fromStep: request.from_step,
        currentChildren,
        relations,
      });

      for (const sourceId of selectedIds) {
        const sourceDeps = relations.filter((relation) => relation.job_id === sourceId);
        for (const relation of sourceDeps) {
          if (selectedIds.has(relation.related_job_id)) continue;
          const dependency = childrenById.get(relation.related_job_id);
          if (!dependency) {
            throw new BadRequestException(
              `Cannot retry workflow ${lockedRoot.id}: step ${sourceId} depends on non-current job ${relation.related_job_id}`,
            );
          }
          if (dependency.phase !== 'done') {
            throw new BadRequestException(
              `Cannot retry workflow ${lockedRoot.id}: dependency ${dependency.step_name ?? dependency.id} (${dependency.id}) is ${dependency.phase}, not done`,
            );
          }
        }
      }

      const selectedChildren = currentChildren.filter((job) => selectedIds.has(job.id));
      const generation = this.nextRetryGeneration(allChildren);
      const oldToNew = new Map<string, string>();
      const createdByOldId = new Map<string, Job>();

      for (const source of selectedChildren) {
        const { id: retryJobId } = await txJobs.generateJobId(lockedRoot.project_id, lockedRoot.id);
        oldToNew.set(source.id, retryJobId);

        const retryHints = this.buildRetryStepHints(source, {
          rootJobId: lockedRoot.id,
          generation,
          mode,
          fromStep: request.from_step,
          requestedAt,
        });

        const created = await txJobs.create({
          id: retryJobId,
          project_id: source.project_id,
          parent_id: lockedRoot.id,
          depth: source.depth,
          title: `${source.title} [retry ${generation}]`,
          description: source.description,
          issue_type: source.issue_type,
          labels: this.withRetryLabels(source.labels, source.id, generation),
          phase: 'ready',
          priority: source.priority,
          assignee: source.assignee,
          review_required: source.review_required,
          review_status: null,
          reviewer: source.reviewer,
          defer_until: null,
          due_at: source.due_at,
          hints: retryHints,
          harness: source.harness,
          harness_profile: source.harness_profile,
          harness_options: source.harness_options,
          harness_profile_override: source.harness_profile_override,
          env_overrides: source.env_overrides,
          token_scope: source.token_scope,
          token_permissions: source.token_permissions,
          harness_profile_source: source.harness_profile_source,
          harness_profile_hash: source.harness_profile_hash,
          git_json: source.git_json,
          resolved_git_json: null,
          workspace_json: source.workspace_json,
          blocked_on_gates: [],
          env_name: source.env_name,
          execution_mode: source.execution_mode,
          execution_type: source.execution_type,
          run_id: source.run_id,
          step_name: source.step_name,
          action_type: source.action_type,
          action_input: source.action_input,
          script_command: source.script_command,
          script_timeout_seconds: source.script_timeout_seconds,
          target: source.target,
          resource_refs: source.resource_refs,
          content_hash: source.content_hash,
          actor_user_id: userId ?? source.actor_user_id,
          failure_disposition: null,
          closed_at: null,
          close_reason: null,
        });
        createdByOldId.set(source.id, created);
      }

      for (const source of selectedChildren) {
        const retryJobId = oldToNew.get(source.id);
        if (!retryJobId) continue;

        const sourceDeps = relations.filter((relation) => relation.job_id === source.id);
        for (const relation of sourceDeps) {
          const relatedJobId = oldToNew.get(relation.related_job_id) ?? relation.related_job_id;
          await txJobs.addDependency(retryJobId, relatedJobId, relation.relation_type);
        }

        await tx`
          UPDATE jobs
          SET hints = COALESCE(hints, '{}'::jsonb) || ${tx.json({
            workflow_retry_superseded_by: retryJobId,
            workflow_retry_superseded_at: requestedAt,
            workflow_retry_superseded_generation: generation,
          } as never)}::jsonb,
              updated_at = NOW()
          WHERE id = ${source.id}
        `;
      }

      const rootRetryHints = {
        workflow_retry_generation: generation,
        workflow_retry_mode: mode,
        workflow_retry_from_step: request.from_step ?? null,
        workflow_retry_requested_at: requestedAt,
        workflow_retry_requested_by: userId ?? null,
        workflow_retry_superseded_job_ids: selectedChildren.map((job) => job.id),
        workflow_retry_job_ids: selectedChildren.map((job) => oldToNew.get(job.id)).filter(Boolean),
      };

      const [updatedRoot] = await tx<Job[]>`
        UPDATE jobs
        SET phase = 'active',
            closed_at = NULL,
            close_reason = NULL,
            failure_disposition = NULL,
            hints = COALESCE(hints, '{}'::jsonb) || ${tx.json(rootRetryHints as never)}::jsonb,
            updated_at = NOW()
        WHERE id = ${lockedRoot.id}
        RETURNING *
      `;

      await this.insertWorkflowRetryAudit(tx, lockedRoot.id, {
        action: 'updated',
        workflowRetryAction: 'workflow_retry',
        userId,
        generation,
        mode,
        fromStep: request.from_step,
        oldToNew,
      });

      for (const source of selectedChildren) {
        const retryJobId = oldToNew.get(source.id);
        if (!retryJobId) continue;
        await this.insertWorkflowRetryAudit(tx, retryJobId, {
          action: 'created',
          workflowRetryAction: 'workflow_retry_created',
          userId,
          generation,
          mode,
          fromStep: request.from_step,
          oldToNew: new Map([[source.id, retryJobId]]),
        });
      }

      return {
        root_job_id: lockedRoot.id,
        status: updatedRoot?.phase ?? 'active',
        mode,
        ...(request.from_step ? { from_step: request.from_step } : {}),
        generation,
        retried_steps: selectedChildren.map((source) => ({
          step_name: source.step_name ?? source.id,
          previous_job_id: source.id,
          retry_job_id: oldToNew.get(source.id)!,
          depends_on: relations
            .filter((relation) => relation.job_id === source.id)
            .map((relation) => {
              const related = createdByOldId.get(relation.related_job_id) ?? childrenById.get(relation.related_job_id);
              return related?.step_name ?? oldToNew.get(relation.related_job_id) ?? relation.related_job_id;
            }),
        })),
        superseded_job_ids: selectedChildren.map((job) => job.id),
      };
    });
  }

  private isWorkflowRoot(job: Job): boolean {
    return this.asRecord(job.hints).workflow_root === true;
  }

  private isTerminal(job: Job): boolean {
    return job.phase === 'done' || job.phase === 'cancelled';
  }

  private isSupersededWorkflowStep(job: Job): boolean {
    return typeof this.asRecord(job.hints).workflow_retry_superseded_by === 'string';
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  private selectWorkflowRetrySteps(params: {
    mode: 'failed' | 'from';
    fromStep?: string;
    currentChildren: Job[];
    relations: Array<{ job_id: string; related_job_id: string; relation_type: string }>;
  }): Set<string> {
    const { mode, fromStep, currentChildren, relations } = params;

    if (mode === 'failed') {
      const failed = currentChildren.filter((job) =>
        job.failure_disposition === 'failed' || job.failure_disposition === 'upstream_failed',
      );
      if (failed.length === 0) {
        throw new BadRequestException('Workflow has no failed or upstream-failed current steps to retry');
      }
      return new Set(failed.map((job) => job.id));
    }

    if (!fromStep) {
      throw new BadRequestException('from_step is required for workflow retry from mode');
    }

    const start = currentChildren.find((job) => job.step_name === fromStep);
    if (!start) {
      const available = currentChildren.map((job) => job.step_name ?? job.id).join(', ');
      throw new BadRequestException(
        `Workflow has no current step named "${fromStep}". Available steps: ${available}`,
      );
    }

    const dependentsByDependency = new Map<string, string[]>();
    for (const relation of relations) {
      const dependents = dependentsByDependency.get(relation.related_job_id) ?? [];
      dependents.push(relation.job_id);
      dependentsByDependency.set(relation.related_job_id, dependents);
    }

    const selected = new Set<string>([start.id]);
    const queue = [start.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dependentId of dependentsByDependency.get(current) ?? []) {
        if (selected.has(dependentId)) continue;
        selected.add(dependentId);
        queue.push(dependentId);
      }
    }

    return selected;
  }

  private nextRetryGeneration(children: Job[]): number {
    let max = 0;
    for (const child of children) {
      const value = this.asRecord(child.hints).workflow_retry_generation;
      if (typeof value === 'number' && Number.isFinite(value)) {
        max = Math.max(max, value);
      } else if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) max = Math.max(max, parsed);
      }
    }
    return max + 1;
  }

  private buildRetryStepHints(
    source: Job,
    retry: {
      rootJobId: string;
      generation: number;
      mode: 'failed' | 'from';
      fromStep?: string;
      requestedAt: string;
    },
  ): JobHints {
    const hints = { ...this.asRecord(source.hints) } as JobHints;
    delete hints.workflow_retry_superseded_by;
    delete hints.workflow_retry_superseded_at;
    delete hints.workflow_retry_superseded_generation;

    return {
      ...hints,
      workflow_retry_generation: retry.generation,
      workflow_retry_of: source.id,
      workflow_retry_root: retry.rootJobId,
      workflow_retry_mode: retry.mode,
      workflow_retry_from_step: retry.fromStep ?? null,
      workflow_retry_requested_at: retry.requestedAt,
    };
  }

  private withRetryLabels(labels: string[], sourceJobId: string, generation: number): string[] {
    return Array.from(new Set([
      ...labels,
      'workflow-retry',
      `retry-generation:${generation}`,
      `retry-of:${sourceJobId}`,
    ]));
  }

  private async insertWorkflowRetryAudit(
    tx: Db,
    entityId: string,
    details: {
      action: 'created' | 'updated';
      workflowRetryAction: 'workflow_retry' | 'workflow_retry_created';
      userId?: string;
      generation: number;
      mode: 'failed' | 'from';
      fromStep?: string;
      oldToNew: Map<string, string>;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO audit_log (
        entity_type,
        entity_id,
        action,
        actor,
        actor_type,
        changes,
        context
      )
      VALUES (
        'job',
        ${entityId},
        ${details.action},
        ${details.userId ?? 'workflow-retry'},
        ${details.userId ? 'user' : 'system'},
        ${tx.json({
          workflow_retry_generation: { old: null, new: details.generation },
        } as never)},
        ${tx.json({
          action: details.workflowRetryAction,
          mode: details.mode,
          from_step: details.fromStep ?? null,
          replacements: Object.fromEntries(details.oldToNew.entries()),
        } as never)}
      )
    `;
  }

  // ============================================================================
  // Per-step agent resolution
  // ============================================================================

  /**
   * Resolve agent config from a single workflow step's agent reference.
   * Looks up the agent in the DB, resolves its harness_profile from the manifest's
   * x-eve profiles section, and determines the appropriate harness binary.
   *
   * Phase 4: honors step-level `harness_profile` (with `${inputs.<key>}` /
   * `${event.payload.<path>}` templates) and `harness_profile_override`
   * (inline bundle with per-field templates). Templates are interpolated
   * against `templateScope`; unresolved references fall back to the agent
   * default with a warning log (R3.2).
   */
  private async resolveStepAgentFromStep(
    projectId: string,
    step: Record<string, unknown>,
    templateScope: EvaluateScope,
    workflowName: string,
    workflowToolchains: string[] | undefined,
    stepToolchains: string[] | undefined,
  ): Promise<{
    agentId: string | null;
    harness: string | null;
    harnessProfile: string | null;
    harnessOptions: Record<string, unknown> | null;
    permission: string | null;
    toolchains: string[];
    harnessProfileOverride: InlineProfileBundle | null;
    harnessProfileSource: HarnessProfileSource | null;
    harnessProfileHash: string | null;
  }> {
    const empty = {
      agentId: null,
      harness: null,
      harnessProfile: null,
      harnessOptions: null,
      permission: null,
      toolchains: [],
      harnessProfileOverride: null as InlineProfileBundle | null,
      harnessProfileSource: null as HarnessProfileSource | null,
      harnessProfileHash: null as string | null,
    };

    // Step-level harness overrides: if step defines harness/harness_options directly,
    // they take precedence over agent-resolved values (same pattern as toolchains).
    const stepHarness = (typeof step?.harness === 'string') ? step.harness : null;
    const stepHarnessOptions = (step?.harness_options && typeof step.harness_options === 'object')
      ? step.harness_options as Record<string, unknown> : null;

    // Phase 4: interpolate step-level harness_profile and harness_profile_override.
    const stepName = (typeof step.name === 'string' && step.name) || '(unnamed)';
    const rawStepHarnessProfile = typeof step?.harness_profile === 'string'
      ? step.harness_profile
      : null;
    let resolvedStepProfileRef: string | null = null;
    if (rawStepHarnessProfile !== null) {
      const { value, missing } = interpolateValue(rawStepHarnessProfile, templateScope);
      if (missing.length > 0) {
        console.warn(
          `[workflow ${workflowName}/${stepName}] harness_profile template has unresolved refs (${missing.map((m) => m.ref.raw).join(', ')}); falling back to agent default`,
        );
      } else {
        resolvedStepProfileRef = value;
      }
    }

    const rawStepOverride = (step?.harness_profile_override && typeof step.harness_profile_override === 'object')
      ? step.harness_profile_override as Record<string, unknown>
      : null;
    let resolvedStepOverride: InlineProfileBundle | null = null;
    if (rawStepOverride) {
      const { value, missing } = interpolateValue(rawStepOverride, templateScope);
      if (missing.length > 0) {
        console.warn(
          `[workflow ${workflowName}/${stepName}] harness_profile_override has unresolved refs (${missing.map((m) => m.ref.raw).join(', ')}); falling back to agent default`,
        );
      } else {
        resolvedStepOverride = this.toInlineProfileBundle(value);
        if (!resolvedStepOverride) {
          console.warn(
            `[workflow ${workflowName}/${stepName}] harness_profile_override resolved to an invalid bundle; falling back to agent default`,
          );
        }
      }
    }

    const agentStep = step?.agent as Record<string, unknown> | undefined;
    if (!agentStep?.name || typeof agentStep.name !== 'string') {
      // No named agent — use step-level harness if provided.
      if (resolvedStepOverride || stepHarness || stepHarnessOptions) {
        const resolved = await sharedResolveHarnessProfile(
          { agentConfigs: this.agentConfigs, manifests: this.manifests, logger: { warn: (m: string) => console.warn(m) } },
          {
            projectId,
            workflowTemplate: resolvedStepOverride ?? undefined,
            stringRef: resolvedStepProfileRef ?? undefined,
          },
        );
        return {
          agentId: null,
          harness: stepHarness ?? (resolved.harness ?? null),
          harnessProfile: resolvedStepProfileRef,
          harnessOptions: stepHarnessOptions ?? ((resolved.harness_options as Record<string, unknown>) ?? null),
          permission: null,
          toolchains: this.resolveStepToolchains(workflowToolchains, stepToolchains),
          harnessProfileOverride: resolvedStepOverride,
          harnessProfileSource: resolved.source,
          harnessProfileHash: resolved.profile_hash,
        };
      }
      return {
        ...empty,
        toolchains: this.resolveStepToolchains(workflowToolchains, stepToolchains),
      };
    }

    const agentName = agentStep.name;

    // Look up agent in DB
    const agents = await this.agents.listByProject(projectId);
    const agent = agents.find(a => a.id === agentName);
    if (!agent) {
      return {
        ...empty,
        toolchains: this.resolveStepToolchains(workflowToolchains, stepToolchains),
      };
    }

    const permission = ((agent.policies_json as Record<string, unknown> | null)?.permission_policy as string) ?? null;

    // Delegate profile lookup to the shared resolver (single source of truth
    // with chat.service.ts and jobs.service.ts). Precedence, highest first:
    //   workflow_template (step-level override) → string_ref (step-level
    //   harness_profile) → agent_default (agent.harness_profile).
    const resolved = await sharedResolveHarnessProfile(
      { agentConfigs: this.agentConfigs, manifests: this.manifests, logger: { warn: (m: string) => console.warn(m) } },
      {
        projectId,
        workflowTemplate: resolvedStepOverride ?? undefined,
        stringRef: resolvedStepProfileRef ?? undefined,
        agentDefault: agent.harness_profile ?? undefined,
      },
    );

    const harness = resolved.harness ?? null;
    const harnessOptions = (resolved.harness_options as Record<string, unknown>) ?? null;

    // Resolve toolchains: step-level overrides agent-level, root workflow defaults
    // fill only when neither source declares a non-empty list.
    let agentToolchains: string[] | undefined;
    if (!stepToolchains || stepToolchains.length === 0) {
      const agentConfig = await this.agentConfigs.findLatestByProject(projectId);
      const parsedAgents = agentConfig?.parsed_agents as Record<string, Record<string, unknown>> | undefined;
      const agentDef = parsedAgents?.[agentName];
      agentToolchains = this.parseToolchains(
        agentDef?.toolchains,
        `Agent "${agentName}".toolchains`,
      );
    }
    const toolchains = this.resolveAgentToolchains(workflowToolchains, stepToolchains, agentToolchains);

    return {
      agentId: agent.id,
      harness: stepHarness ?? harness,
      // Record the profile name when it was sourced from a string ref so
      // receipts attribute the run correctly. Inline overrides leave this null.
      harnessProfile: resolved.profile_name ?? (agent.harness_profile ?? null),
      harnessOptions: stepHarnessOptions ?? harnessOptions,
      permission,
      toolchains,
      harnessProfileOverride: resolvedStepOverride,
      harnessProfileSource: resolved.source,
      harnessProfileHash: resolved.profile_hash,
    };
  }

  /**
   * Coerce an interpolated object into an `InlineProfileBundle`, dropping
   * unknown keys and normalizing temperature (templates produce strings).
   * Returns null when `harness` is missing or empty — the caller falls back.
   */
  private toInlineProfileBundle(value: unknown): InlineProfileBundle | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const harness = typeof v.harness === 'string' ? v.harness.trim() : '';
    if (!harness) return null;

    const bundle: InlineProfileBundle = { harness };
    if (typeof v.model === 'string' && v.model.trim()) bundle.model = v.model.trim();
    if (typeof v.variant === 'string' && v.variant.trim()) bundle.variant = v.variant.trim();
    if (typeof v.reasoning_effort === 'string') {
      const effort = v.reasoning_effort.trim();
      if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'x-high') {
        bundle.reasoning_effort = effort;
      }
    }
    if (typeof v.temperature === 'number') {
      bundle.temperature = v.temperature;
    } else if (typeof v.temperature === 'string' && v.temperature.trim()) {
      const n = Number(v.temperature);
      if (Number.isFinite(n)) bundle.temperature = n;
    }
    return bundle;
  }

  // ============================================================================
  // Wait/poll helpers
  // ============================================================================

  private async pollStepJobsForCompletion(
    rootJobId: string,
    stepNameToJobId: Map<string, string>,
  ): Promise<WorkflowInvokeResult> {
    const timeoutMs = 60000;
    const pollIntervalMs = 500;
    const startTime = Date.now();
    const stepJobIds = Array.from(stepNameToJobId.values());

    while (Date.now() - startTime < timeoutMs) {
      let allTerminal = true;
      let anyCancelled = false;
      let anyFailed = false;

      for (const jobId of stepJobIds) {
        const job = await this.jobs.findById(jobId);
        if (!job) continue;
        if (job.phase === 'cancelled') {
          anyCancelled = true;
        } else if (job.phase === 'done') {
          if (job.close_reason && job.close_reason !== 'completed' && job.close_reason !== 'condition_not_met') {
            anyFailed = true;
          }
        } else {
          allTerminal = false;
        }
      }

      if (allTerminal) {
        if (anyCancelled) {
          return {
            job_id: rootJobId,
            status: 'cancelled',
            result: null,
            error: 'One or more workflow steps were cancelled',
          };
        }

        const lastStepId = stepJobIds[stepJobIds.length - 1];
        const lastAttempt = lastStepId ? await this.jobs.getLatestAttempt(lastStepId) : null;

        return {
          job_id: rootJobId,
          status: anyFailed ? 'failed' : 'done',
          result: lastAttempt?.result_json ?? null,
          error: anyFailed ? 'One or more workflow steps failed' : null,
        };
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new RequestTimeoutException(
      `Workflow invocation timed out after ${timeoutMs / 1000} seconds. Root job: ${rootJobId}`,
    );
  }

  // ============================================================================
  // Hint/git extraction helpers
  // ============================================================================

  private extractWorkflowGit(
    definition: Record<string, unknown>,
  ): Record<string, unknown> | null {
    return this.extractGitConfig(definition);
  }

  private extractGitConfig(
    source: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const git = source.git;
    if (!git || typeof git !== 'object') {
      return null;
    }
    return git as Record<string, unknown>;
  }

  private resolveStepGit(
    workflowGit: Record<string, unknown> | null,
    step: Record<string, unknown>,
    templateScope: EvaluateScope,
    workflowName: string,
    stepName: string,
  ): Record<string, unknown> | null {
    const stepGit = this.extractGitConfig(step);
    if (!workflowGit && !stepGit) {
      return null;
    }

    const merged = {
      ...(workflowGit ?? {}),
      ...(stepGit ?? {}),
    };
    const interpolated = interpolateValue(merged, templateScope, 'git');
    if (interpolated.missing.length > 0 || interpolated.nonScalar.length > 0) {
      const missing = interpolated.missing.map(
        (item) => `${item.path}: ${item.ref.raw}`,
      );
      const nonScalar = interpolated.nonScalar.map(
        (item) => `${item.path}: ${item.ref.raw}`,
      );
      const details = [
        ...(missing.length > 0 ? [`missing refs (${missing.join(', ')})`] : []),
        ...(nonScalar.length > 0 ? [`non-scalar refs (${nonScalar.join(', ')})`] : []),
      ].join('; ');

      throw new BadRequestException(
        `Workflow "${workflowName}" step "${stepName}" has invalid git template: ${details}`,
      );
    }

    return interpolated.value;
  }

  private extractWorkflowHints(
    definition: Record<string, unknown>,
    projectId: string,
  ): Record<string, unknown> {
    const hints = definition.hints;
    if (!hints || typeof hints !== 'object') {
      return {};
    }

    const hintRecord = { ...(hints as Record<string, unknown>) };
    const gates = hintRecord.gates;
    if (gates !== undefined) {
      if (!Array.isArray(gates) || gates.some((gate) => typeof gate !== 'string')) {
        throw new BadRequestException('Workflow hints.gates must be an array of strings');
      }

      for (const gate of gates as string[]) {
        if (gate.startsWith('remediate:')) {
          this.assertRemediationGateKey(gate, projectId);
        }
      }
    }

    return hintRecord;
  }

  private assertRemediationGateKey(gate: string, projectId: string): void {
    const parts = gate.split(':');
    const envName = parts[2];
    if (parts.length !== 3 || parts[0] !== 'remediate' || parts[1] !== projectId || !envName) {
      throw new BadRequestException(
        `Invalid remediation gate key "${gate}" (expected remediate:${projectId}:<env_name>)`,
      );
    }
  }
}

// ============================================================================
// Pure helpers (exported for testing and reuse in manifest coherence)
// ============================================================================

/**
 * Validate the workflow step graph before creating jobs:
 * - No duplicate step names
 * - All depends_on references point to existing steps
 * - No cycles in the dependency graph
 */
export function validateStepGraph(
  workflowName: string,
  steps: Array<Record<string, unknown>>,
): void {
  const names = new Map<string, number>();
  for (const [i, step] of steps.entries()) {
    const name = (step.name as string) || `step-${i + 1}`;
    const executionKeys = ['action', 'script', 'agent', 'run'] as const;
    const executionKeyCount = executionKeys.filter((key) => step[key] !== undefined).length;
    if (executionKeyCount !== 1) {
      throw new BadRequestException(
        `Workflow "${workflowName}" step "${name}" must define exactly one of action, script, agent, or run`,
      );
    }
    if (names.has(name)) {
      throw new BadRequestException(
        `Workflow "${workflowName}" has duplicate step name "${name}"`,
      );
    }
    names.set(name, i);
  }

  const depMap = new Map<string, string[]>();
  for (const [i, step] of steps.entries()) {
    const name = (step.name as string) || `step-${i + 1}`;
    const deps = step.depends_on as string[] | undefined;
    if (!Array.isArray(deps)) {
      depMap.set(name, []);
      continue;
    }
    for (const dep of deps) {
      if (!names.has(dep)) {
        throw new BadRequestException(
          `Workflow "${workflowName}" step "${name}" depends on nonexistent step "${dep}"`,
        );
      }
    }
    depMap.set(name, deps);
  }

  const cycle = detectCycleInGraph(Array.from(names.keys()), depMap);
  if (cycle) {
    throw new BadRequestException(
      `Workflow "${workflowName}" has a dependency cycle: ${cycle.join(' -> ')}`,
    );
  }

  // Validate condition references
  for (const [i, step] of steps.entries()) {
    const name = (step.name as string) || `step-${i + 1}`;
    const condition = step.condition as string | undefined;
    if (typeof condition !== 'string') continue;

    const parsed = parseStepCondition(condition);
    if (!parsed) {
      throw new BadRequestException(
        `Workflow "${workflowName}" step "${name}" has invalid condition "${condition}". ` +
        `Expected format: step_name.status == 'value' or step_name.status != 'value'`,
      );
    }

    if (!names.has(parsed.stepName)) {
      throw new BadRequestException(
        `Workflow "${workflowName}" step "${name}" condition references nonexistent step "${parsed.stepName}"`,
      );
    }

    const deps = depMap.get(name) ?? [];
    if (!deps.includes(parsed.stepName)) {
      throw new BadRequestException(
        `Workflow "${workflowName}" step "${name}" condition references step "${parsed.stepName}" ` +
        `which is not in its depends_on list. The condition step must be a dependency.`,
      );
    }
  }
}

/**
 * Parse a step condition string into its components.
 * Supports: `step_name.status == 'value'` and `step_name.status != 'value'`
 * Returns null if the condition doesn't match the expected format.
 */
export function parseStepCondition(
  condition: string,
): { stepName: string; operator: '==' | '!='; value: string } | null {
  // Match: stepName.status == 'value' or stepName.status != 'value'
  // Allows single or double quotes around the value
  const match = condition.match(
    /^(\w[\w-]*)\s*\.\s*status\s*(==|!=)\s*['"]([^'"]*)['"]\s*$/,
  );
  if (!match) return null;

  return {
    stepName: match[1],
    operator: match[2] as '==' | '!=',
    value: match[3],
  };
}

/**
 * Detect cycles in a directed graph using DFS.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCycleInGraph(
  nodes: string[],
  depMap: Map<string, string[]>,
): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): string[] | null {
    if (inStack.has(node)) return [...path, node];
    if (visited.has(node)) return null;
    visited.add(node);
    inStack.add(node);
    for (const dep of depMap.get(node) ?? []) {
      const cycle = dfs(dep, [...path, node]);
      if (cycle) return cycle;
    }
    inStack.delete(node);
    return null;
  }

  for (const name of nodes) {
    const cycle = dfs(name, []);
    if (cycle) return cycle;
  }
  return null;
}
