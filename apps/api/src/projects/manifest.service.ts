import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  projectQueries,
  orgQueries,
  projectManifestQueries,
  environmentQueries,
  ingressAliasQueries,
  customDomainQueries,
  appLinkGrantQueries,
  appLinkSubscriptionQueries,
  type Project,
  type ProjectAppLinkGrant,
} from '@eve/db';
import {
  generateManifestId,
  generateIngressAliasId,
  type SyncManifestRequest,
  type ManifestResponse,
  type ManifestValidateRequest,
  type ManifestValidateResponse,
  ManifestSchema,
  getManifestDefaults,
  getManifestRequiredSecrets,
  type SecretValidationResult,
  getManifestAgents,
  getManifestBranding,
  getManifestAuthConfig,
  getServicesFromManifest,
  type ProjectBranding,
  type ProjectAuthConfig,
  type AppDomainSignupRule,
  type Manifest,
  getManifestIngressAliases,
  getManifestTcpIngressAliases,
  assertUniqueManifestIngressAliases,
  isReservedAlias,
  getManifestCustomDomainDeclarations,
  getManifestCustomDomainDesiredState,
  assertUniqueManifestCustomDomainDeclarations,
  type ManifestCustomDomainDesiredState,
  generateCustomDomainId,
  generateAppLinkGrantId,
  generateAppLinkSubscriptionId,
  analyzeManifestCoherence,
  validateWorkflowTemplates,
  assertNoUnresolvedManifestReferences,
  getManifestAppLinks,
  type AppLinks,
  type Service,
} from '@eve/shared';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import { SecretsService } from '../secrets/secrets.service.js';
import { ensureManifestEnvironment } from '../environments/manifest-environment.js';

type PreparedAppLinkGrant = {
  producer_project_id: string;
  export_kind: 'api' | 'events';
  export_name: string;
  consumer_project_id: string;
  api_scopes: string[];
  event_types: string[];
  envs: string[];
  service_name: string | null;
  cli_name: string | null;
  cli_image: string | null;
  cli_bin_path: string | null;
};

type PreparedAppLinkSubscription = {
  consumer_project_id: string;
  local_alias: string;
  api_grant_id: string | null;
  event_grant_id: string | null;
  requested_scopes: string[];
  event_types: string[];
  environment_strategy: 'same' | 'fixed';
  producer_env_name: string | null;
  inject_into_services: string[];
  inject_into_jobs: boolean;
};

type PreparedAppLinkReconciliation = {
  grants: PreparedAppLinkGrant[];
  grantKeys: Set<string>;
  subscriptions: PreparedAppLinkSubscription[];
  subscriptionAliases: Set<string>;
  warnings: string[];
};

@Injectable()
export class ManifestService {
  private projects: ReturnType<typeof projectQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private envs: ReturnType<typeof environmentQueries>;
  private ingressAliases: ReturnType<typeof ingressAliasQueries>;
  private customDomains: ReturnType<typeof customDomainQueries>;
  private appLinkGrants: ReturnType<typeof appLinkGrantQueries>;
  private appLinkSubscriptions: ReturnType<typeof appLinkSubscriptionQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly secretsService: SecretsService,
  ) {
    this.projects = projectQueries(db);
    this.orgs = orgQueries(db);
    this.manifests = projectManifestQueries(db);
    this.envs = environmentQueries(db);
    this.ingressAliases = ingressAliasQueries(db);
    this.customDomains = customDomainQueries(db);
    this.appLinkGrants = appLinkGrantQueries(db);
    this.appLinkSubscriptions = appLinkSubscriptionQueries(db);
  }

  async syncManifest(projectId: string, data: SyncManifestRequest): Promise<ManifestResponse> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Parse and validate manifest
    let validatedManifest: Manifest | null = null;
    let parsedDefaults: Record<string, unknown> | null = null;
    let parsedAgents: Record<string, unknown> | null = null;
    let parsedBranding: ProjectBranding | null = null;
    let parsedAuthConfig: ProjectAuthConfig | null = null;
    let secretValidation: SecretValidationResult | undefined;
    let warnings: string[] | undefined;
    let appLinkReconciliation: PreparedAppLinkReconciliation | null = null;
    try {
      const parsed = yaml.parse(data.yaml);
      const validated = ManifestSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error(validated.error.message);
      }
      validatedManifest = validated.data;
      try {
        assertNoUnresolvedManifestReferences(validated.data as Record<string, unknown>);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Unresolved manifest references',
        );
      }

      parsedDefaults = getManifestDefaults(validated.data);
      parsedAgents = getManifestAgents(validated.data);
      parsedBranding = getManifestBranding(validated.data);
      parsedAuthConfig = await this.normalizeProjectAuthConfig(
        project.org_id,
        getManifestAuthConfig(validated.data),
      );

      const aliases = getManifestIngressAliases(validated.data);
      const tcpAliases = getManifestTcpIngressAliases(validated.data);
      try {
        assertUniqueManifestIngressAliases(aliases);
        assertUniqueManifestIngressAliases(tcpAliases);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Duplicate ingress alias values in manifest';
        throw new BadRequestException(message);
      }
      for (const alias of tcpAliases.keys()) {
        if (aliases.has(alias)) {
          throw new BadRequestException(`Ingress alias "${alias}" is declared for both HTTP and TCP ingress`);
        }
      }

      const allAliases = new Map([...aliases.entries(), ...tcpAliases.entries()]);
      for (const alias of allAliases.keys()) {
        if (isReservedAlias(alias)) {
          throw new BadRequestException(`Ingress alias "${alias}" is reserved`);
        }

        const existingAlias = await this.ingressAliases.findByAlias(alias);
        if (existingAlias && existingAlias.project_id !== projectId) {
          throw new ConflictException(`Ingress alias "${alias}" is already claimed by another project`);
        }
      }

      // Validate custom domains
      const customDomainDeclarations = getManifestCustomDomainDeclarations(validated.data);
      try {
        assertUniqueManifestCustomDomainDeclarations(customDomainDeclarations);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Duplicate custom domain hostnames in manifest';
        throw new BadRequestException(message);
      }
      for (const declaration of customDomainDeclarations) {
        const existingDomain = await this.customDomains.findByHostname(declaration.hostname);
        if (existingDomain && existingDomain.project_id !== projectId) {
          throw new ConflictException(`Custom domain "${declaration.hostname}" is already claimed by another project`);
        }
      }

      if (data.validate_secrets || data.strict) {
        const requiredSecrets = getManifestRequiredSecrets(validated.data);
        if (requiredSecrets.length > 0) {
          secretValidation = await this.secretsService.validateRequiredSecrets(projectId, requiredSecrets);
          if (secretValidation.missing.length > 0) {
            warnings = secretValidation.missing.map((item) => {
              const hint = item.hints[0] ? ` ${item.hints[0]}` : '';
              return `Missing secret ${item.key}.${hint}`.trim();
            });
            if (data.strict) {
              throw new BadRequestException({
                message: 'Missing required secrets',
                secret_validation: secretValidation,
              });
            }
          }
        }
      }

      // Coherence analysis — surface structural warnings at sync time
      const coherenceResults = analyzeManifestCoherence(validated.data);
      const coherenceWarnings = coherenceResults
        .filter((w) => w.severity === 'warning')
        .map((w) => w.message);
      const coherenceErrors = coherenceResults
        .filter((w) => w.severity === 'error')
        .map((w) => w.message);
      if (coherenceWarnings.length > 0 || coherenceErrors.length > 0) {
        const allMessages = [...coherenceErrors, ...coherenceWarnings];
        if (warnings) {
          warnings.push(...allMessages);
        } else {
          warnings = allMessages;
        }
      }

      // Phase 4: Reject malformed workflow step template expressions and
      // undeclared `${inputs.<key>}` references. Event-payload refs are
      // accepted structurally — the payload shape is only known at runtime.
      const templateErrors = validateWorkflowTemplates(
        validated.data.workflows as Record<string, unknown> | undefined,
      );
      if (templateErrors.length > 0) {
        const lines = templateErrors.map(
          (e) =>
            `workflow "${e.workflow}"${e.stepName ? ` step "${e.stepName}"` : ''} ${e.field}: ${e.message}`,
        );
        throw new BadRequestException(
          `Invalid workflow templates: ${lines.join('; ')}`,
        );
      }

      appLinkReconciliation = await this.prepareAppLinkReconciliation(
        project,
        validated.data,
        data.local_cli_images,
      );
      if (appLinkReconciliation.warnings.length > 0) {
        warnings = [
          ...(warnings ?? []),
          ...appLinkReconciliation.warnings,
        ];
      }
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException) {
        throw error;
      }
      throw new BadRequestException(`Invalid YAML: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    if (!validatedManifest) {
      throw new BadRequestException('Invalid manifest: no validated manifest content');
    }

    // Hash the manifest content
    const manifestHash = crypto
      .createHash('sha256')
      .update(data.yaml)
      .digest('hex');

    // Check if manifest with same hash already exists
    const existing = await this.manifests.findByProjectAndHash(projectId, manifestHash);
    if (existing) {
      const updated = await this.manifests.update(existing.id, {
        git_sha: data.git_sha ?? existing.git_sha ?? null,
        branch: data.branch ?? existing.branch ?? null,
        parsed_defaults: parsedDefaults,
        parsed_agents: parsedAgents,
      });
      await this.projects.updateBranding(projectId, parsedBranding);
      await this.projects.updateAuthConfig(projectId, parsedAuthConfig);
      if (appLinkReconciliation) {
        await this.applyAppLinkReconciliation(projectId, appLinkReconciliation);
      }
      await this.reconcileIngressAliases(projectId, validatedManifest);
      const domainWarnings = await this.reconcileCustomDomains(projectId, validatedManifest);
      if (domainWarnings.length > 0) {
        warnings = [...(warnings ?? []), ...domainWarnings];
      }
      if (updated) {
        const response = this.toManifestResponse(updated);
        if (secretValidation) response.secret_validation = secretValidation;
        if (warnings) response.warnings = warnings;
        return response;
      }
      const touched = await this.manifests.touch(existing.id);
      const response = this.toManifestResponse(touched ?? existing);
      if (secretValidation) response.secret_validation = secretValidation;
      if (warnings) response.warnings = warnings;
      return response;
    }

    // Create new manifest
    const id = generateManifestId();
    const manifest = await this.manifests.create({
      id,
      project_id: projectId,
      manifest_yaml: data.yaml,
      manifest_hash: manifestHash,
      git_sha: data.git_sha ?? null,
      branch: data.branch ?? null,
      parsed_defaults: parsedDefaults,
      parsed_agents: parsedAgents,
    });
    if (appLinkReconciliation) {
      await this.applyAppLinkReconciliation(projectId, appLinkReconciliation);
    }
    await this.reconcileIngressAliases(projectId, validatedManifest);
    const domainWarnings = await this.reconcileCustomDomains(projectId, validatedManifest);
    if (domainWarnings.length > 0) {
      warnings = [...(warnings ?? []), ...domainWarnings];
    }
    await this.projects.updateBranding(projectId, parsedBranding);
    await this.projects.updateAuthConfig(projectId, parsedAuthConfig);

    const response = this.toManifestResponse(manifest);
    if (secretValidation) response.secret_validation = secretValidation;
    if (warnings) response.warnings = warnings;
    return response;
  }

  async getLatestManifest(projectId: string): Promise<ManifestResponse | null> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const manifest = await this.manifests.findLatestByProject(projectId);
    if (!manifest) {
      return null;
    }

    return this.toManifestResponse(manifest);
  }

  async validateManifest(
    projectId: string,
    data: ManifestValidateRequest,
  ): Promise<ManifestValidateResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const response: ManifestValidateResponse = {
      valid: false,
    };

    let manifestYaml = data.manifest_yaml;
    if (!manifestYaml) {
      const latest = await this.manifests.findLatestByProject(projectId);
      if (!latest) {
        response.errors = ['No manifest available for validation. Provide manifest_yaml or sync a manifest first.'];
        return response;
      }
      manifestYaml = latest.manifest_yaml;
      response.manifest_hash = latest.manifest_hash;
    }

    let parsed: unknown;
    try {
      parsed = yaml.parse(manifestYaml);
    } catch (error) {
      response.errors = [
        `Invalid YAML: ${error instanceof Error ? error.message : 'unknown error'}`,
      ];
      return response;
    }

    const validated = ManifestSchema.safeParse(parsed);
    if (!validated.success) {
      response.errors = [validated.error.message];
      return response;
    }

    response.valid = true;
    try {
      assertNoUnresolvedManifestReferences(validated.data as Record<string, unknown>);
    } catch (error) {
      response.errors = [
        ...(response.errors ?? []),
        error instanceof Error ? error.message : 'Unresolved manifest references',
      ];
      response.valid = false;
    }
    response.parsed_defaults = getManifestDefaults(validated.data);
    response.parsed_agents = getManifestAgents(validated.data);

    // Pipeline coherence analysis
    const coherenceResults = analyzeManifestCoherence(validated.data);
    const coherenceErrors = coherenceResults.filter((w) => w.severity === 'error');
    const coherenceWarnings = coherenceResults.filter((w) => w.severity === 'warning');

    if (coherenceErrors.length > 0) {
      response.errors = coherenceErrors.map((e) => e.message);
      response.valid = false;
    }

    if (coherenceWarnings.length > 0) {
      response.warnings = [
        ...(response.warnings ?? []),
        ...coherenceWarnings.map((w) => w.message),
      ];
    }

    // Phase 4: workflow template expression validation.
    const templateErrors = validateWorkflowTemplates(
      validated.data.workflows as Record<string, unknown> | undefined,
    );
    if (templateErrors.length > 0) {
      const lines = templateErrors.map(
        (e) =>
          `workflow "${e.workflow}"${e.stepName ? ` step "${e.stepName}"` : ''} ${e.field}: ${e.message}`,
      );
      response.errors = [...(response.errors ?? []), ...lines];
      response.valid = false;
    }

    response.manifest_hash = crypto
      .createHash('sha256')
      .update(manifestYaml)
      .digest('hex');

    if (data.validate_secrets || data.strict) {
      const requiredSecrets = getManifestRequiredSecrets(validated.data);
      if (requiredSecrets.length > 0) {
        const validation = await this.secretsService.validateRequiredSecrets(projectId, requiredSecrets);
        response.secret_validation = validation;
        if (validation.missing.length > 0) {
          response.warnings = validation.missing.map((item) => {
            const hint = item.hints[0] ? ` ${item.hints[0]}` : '';
            const suggestion = item.suggestion ? ` (${item.suggestion})` : '';
            return `Missing secret ${item.key}.${suggestion}${hint}`.trim();
          });
          if (data.strict) {
            response.valid = false;
            response.errors = ['Missing required secrets'];
          }
        }
      }
    }

    return response;
  }

  private getManifestStructure(manifestYaml: string | null | undefined): {
    services: Record<string, unknown> | null;
    environments: Record<string, unknown> | null;
  } {
    if (!manifestYaml) {
      return { services: null, environments: null };
    }

    try {
      const parsed = yaml.parse(manifestYaml);
      const validated = ManifestSchema.safeParse(parsed);
      if (!validated.success) {
        return { services: null, environments: null };
      }

      return {
        services: validated.data.services ?? null,
        environments: validated.data.environments ?? null,
      };
    } catch {
      return { services: null, environments: null };
    }
  }

  private toManifestResponse(manifest: Awaited<ReturnType<typeof this.manifests.findById>> & object): ManifestResponse {
    const { services, environments } = this.getManifestStructure(
      ('manifest_yaml' in manifest ? (manifest as { manifest_yaml?: string | null }).manifest_yaml : null) ?? null,
    );

    return {
      id: manifest.id,
      project_id: manifest.project_id,
      manifest_hash: manifest.manifest_hash,
      git_sha: manifest.git_sha,
      branch: manifest.branch,
      parsed_defaults: manifest.parsed_defaults,
      parsed_agents: manifest.parsed_agents,
      services,
      environments,
      created_at: manifest.created_at.toISOString(),
      updated_at: manifest.updated_at.toISOString(),
    };
  }

  private async prepareAppLinkReconciliation(
    project: Project,
    manifest: Manifest,
    localCliImages?: Record<string, string>,
  ): Promise<PreparedAppLinkReconciliation> {
    const appLinks = getManifestAppLinks(manifest);
    const services = getServicesFromManifest(manifest) ?? {};
    const producerEnvNames = await this.getKnownEnvironmentNames(project.id, manifest);
    const grants: PreparedAppLinkGrant[] = [];
    const grantKeys = new Set<string>();
    const subscriptions: PreparedAppLinkSubscription[] = [];
    const subscriptionAliases = new Set<string>();
    const warnings: string[] = [];

    await this.prepareProducerAppLinkGrants({
      project,
      services,
      producerEnvNames,
      appLinks,
      localCliImages,
      grants,
      grantKeys,
      warnings,
    });

    await this.prepareConsumerAppLinkSubscriptions({
      project,
      services,
      manifest,
      appLinks,
      subscriptions,
      subscriptionAliases,
    });

    return {
      grants,
      grantKeys,
      subscriptions,
      subscriptionAliases,
      warnings,
    };
  }

  private async prepareProducerAppLinkGrants(input: {
    project: Project;
    services: Record<string, Service>;
    producerEnvNames: Set<string>;
    appLinks: AppLinks | null;
    localCliImages?: Record<string, string>;
    grants: PreparedAppLinkGrant[];
    grantKeys: Set<string>;
    warnings: string[];
  }): Promise<void> {
    const exports = input.appLinks?.exports;
    if (!exports) return;

    for (const [exportName, apiExport] of Object.entries(exports.apis ?? {})) {
      const service = input.services[apiExport.service];
      if (!service) {
        throw new BadRequestException(
          `app_links.exports.apis.${exportName}: service "${apiExport.service}" does not exist`,
        );
      }

      const xEve = this.getServiceXeve(service);
      if (!xEve?.api_spec && (!Array.isArray(xEve?.api_specs) || xEve.api_specs.length === 0)) {
        throw new BadRequestException(
          `app_links.exports.apis.${exportName}: service "${apiExport.service}" must declare x-eve.api_spec or x-eve.api_specs`,
        );
      }

      let cliName: string | null = null;
      let cliImage: string | null = null;
      let cliBinPath: string | null = null;
      if (apiExport.cli) {
        const cli = xEve?.cli;
        if (!cli || cli.name !== apiExport.cli) {
          throw new BadRequestException(
            `app_links.exports.apis.${exportName}: cli "${apiExport.cli}" must match service "${apiExport.service}" x-eve.cli.name`,
          );
        }
        if (!cli.image) {
          throw new BadRequestException(
            `app_links.exports.apis.${exportName}: cross-project CLI export "${apiExport.cli}" requires x-eve.cli.image`,
          );
        }
        cliName = cli.name;
        cliImage = this.resolveLocalCliImageOverride(input.localCliImages, {
          cliName: cli.name,
          serviceName: apiExport.service,
          exportName,
        }) ?? cli.image;
        cliBinPath = cli.bin;
      }

      for (const [consumerIndex, consumer] of apiExport.consumers.entries()) {
        const consumerProject = await this.resolveAppLinkProjectRef(
          input.project,
          consumer.project,
          `app_links.exports.apis.${exportName}.consumers[${consumerIndex}].project`,
        );
        this.assertSubset(
          consumer.scopes,
          apiExport.scopes,
          `Consumer ${consumerProject.slug} requested scope`,
          `producer export ${exportName}`,
        );
        for (const envName of consumer.envs) {
          if (!input.producerEnvNames.has(envName)) {
            throw new BadRequestException(
              `app_links.exports.apis.${exportName}.consumers[${consumerIndex}].envs: producer environment "${envName}" does not exist`,
            );
          }
        }

        const grant: PreparedAppLinkGrant = {
          producer_project_id: input.project.id,
          export_kind: 'api',
          export_name: exportName,
          consumer_project_id: consumerProject.id,
          api_scopes: [...consumer.scopes],
          event_types: [],
          envs: [...consumer.envs],
          service_name: apiExport.service,
          cli_name: cliName,
          cli_image: cliImage,
          cli_bin_path: cliBinPath,
        };
        input.grants.push(grant);
        input.grantKeys.add(this.appLinkGrantKey(grant));
      }
    }

    for (const [exportName, eventExport] of Object.entries(exports.events ?? {})) {
      for (const eventType of eventExport.types) {
        if (!/^(app|runner)\./.test(eventType)) {
          input.warnings.push(
            `app_links.exports.events.${exportName}: event type "${eventType}" should normally start with app. or runner.`,
          );
        }
      }

      for (const [consumerIndex, consumer] of eventExport.consumers.entries()) {
        const consumerProject = await this.resolveAppLinkProjectRef(
          input.project,
          consumer.project,
          `app_links.exports.events.${exportName}.consumers[${consumerIndex}].project`,
        );
        const grantedTypes = consumer.types ?? eventExport.types;
        this.assertSubset(
          grantedTypes,
          eventExport.types,
          `Consumer ${consumerProject.slug} requested event type`,
          `producer event export ${exportName}`,
        );

        const grant: PreparedAppLinkGrant = {
          producer_project_id: input.project.id,
          export_kind: 'events',
          export_name: exportName,
          consumer_project_id: consumerProject.id,
          api_scopes: [],
          event_types: [...grantedTypes],
          envs: [],
          service_name: null,
          cli_name: null,
          cli_image: null,
          cli_bin_path: null,
        };
        input.grants.push(grant);
        input.grantKeys.add(this.appLinkGrantKey(grant));
      }
    }
  }

  private resolveLocalCliImageOverride(
    localCliImages: Record<string, string> | undefined,
    keys: { cliName: string; serviceName: string; exportName: string },
  ): string | null {
    if (!localCliImages) return null;
    for (const key of [keys.cliName, keys.serviceName, keys.exportName]) {
      const image = localCliImages[key];
      if (typeof image === 'string' && image.trim().length > 0) {
        return image.trim();
      }
    }
    return null;
  }

  private async prepareConsumerAppLinkSubscriptions(input: {
    project: Project;
    services: Record<string, Service>;
    manifest: Manifest;
    appLinks: AppLinks | null;
    subscriptions: PreparedAppLinkSubscription[];
    subscriptionAliases: Set<string>;
  }): Promise<void> {
    const consumes = input.appLinks?.consumes ?? {};
    const consumerEnvNames = await this.getKnownEnvironmentNames(input.project.id, input.manifest);

    for (const [alias, consume] of Object.entries(consumes)) {
      const producer = await this.resolveAppLinkProjectRef(
        input.project,
        consume.project,
        `app_links.consumes.${alias}.project`,
      );
      let apiGrant: ProjectAppLinkGrant | null = null;
      let eventGrant: ProjectAppLinkGrant | null = null;

      if (consume.api) {
        apiGrant = await this.findUsableGrant({
          producerProject: producer,
          consumerProject: input.project,
          exportKind: 'api',
          exportName: consume.api,
          path: `app_links.consumes.${alias}.api`,
        });

        this.assertSubset(
          consume.scopes,
          apiGrant.api_scopes,
          `Consumer ${input.project.slug} requested scope`,
          `producer ${producer.slug} grant ${consume.api}`,
        );
        this.validateConsumeEnvironment(alias, consume.environment, apiGrant, consumerEnvNames);
      }

      if (consume.events) {
        eventGrant = await this.findUsableGrant({
          producerProject: producer,
          consumerProject: input.project,
          exportKind: 'events',
          exportName: consume.events.feed,
          path: `app_links.consumes.${alias}.events.feed`,
        });
        const requestedTypes = consume.events.types.length > 0
          ? consume.events.types
          : eventGrant.event_types;
        this.assertSubset(
          requestedTypes,
          eventGrant.event_types,
          `Consumer ${input.project.slug} requested event type`,
          `producer ${producer.slug} event grant ${consume.events.feed}`,
        );
      }

      const injectInto = consume.inject_into;
      const injectServices = injectInto?.services ?? [];
      for (const serviceName of injectServices) {
        if (!input.services[serviceName]) {
          throw new BadRequestException(
            `app_links.consumes.${alias}.inject_into.services: service "${serviceName}" does not exist`,
          );
        }
      }

      const environmentStrategy = consume.environment === 'same' ? 'same' : 'fixed';
      const subscription: PreparedAppLinkSubscription = {
        consumer_project_id: input.project.id,
        local_alias: alias,
        api_grant_id: apiGrant?.id ?? null,
        event_grant_id: eventGrant?.id ?? null,
        requested_scopes: [...consume.scopes],
        event_types: consume.events
          ? (consume.events.types.length > 0 ? [...consume.events.types] : [...(eventGrant?.event_types ?? [])])
          : [],
        environment_strategy: environmentStrategy,
        producer_env_name: environmentStrategy === 'fixed' ? consume.environment : null,
        inject_into_services: [...injectServices],
        inject_into_jobs: injectInto?.jobs ?? false,
      };
      input.subscriptions.push(subscription);
      input.subscriptionAliases.add(alias);
    }
  }

  private async applyAppLinkReconciliation(
    projectId: string,
    reconciliation: PreparedAppLinkReconciliation,
  ): Promise<void> {
    for (const grant of reconciliation.grants) {
      await this.appLinkGrants.upsert({
        id: generateAppLinkGrantId(),
        ...grant,
      });
    }
    await this.appLinkGrants.revokeMissing(projectId, reconciliation.grantKeys);

    for (const subscription of reconciliation.subscriptions) {
      await this.appLinkSubscriptions.upsert({
        id: generateAppLinkSubscriptionId(),
        ...subscription,
      });
    }
    await this.appLinkSubscriptions.deleteMissingForConsumer(
      projectId,
      reconciliation.subscriptionAliases,
    );
  }

  private async resolveAppLinkProjectRef(
    currentProject: Project,
    ref: string,
    path: string,
  ): Promise<Project> {
    const project = ref.startsWith('proj_')
      ? await this.projects.findById(ref, { include_deleted: false })
      : await this.projects.findByOrgAndSlug(currentProject.org_id, ref, { include_deleted: false });

    if (!project) {
      throw new BadRequestException(`${path}: project not found: ${ref}`);
    }
    if (project.org_id !== currentProject.org_id) {
      throw new BadRequestException(`${path}: cross-org app links are not supported in v1`);
    }
    return project;
  }

  private async getKnownEnvironmentNames(projectId: string, manifest: Manifest): Promise<Set<string>> {
    const names = new Set<string>(Object.keys(manifest.environments ?? {}));
    try {
      const rows = await this.envs.listByProject(projectId);
      for (const row of rows) {
        names.add(row.name);
      }
    } catch {
      // Environment rows may not exist during early syncs. Manifest names are enough for validation.
    }
    return names;
  }

  private getServiceXeve(service: Service): NonNullable<Service['x_eve']> | undefined {
    return service['x-eve'] ?? service.x_eve;
  }

  private assertSubset(
    requested: string[],
    allowed: string[],
    requestedLabel: string,
    allowedLabel: string,
  ): void {
    const allowedSet = new Set(allowed);
    const missing = requested.filter((value) => !allowedSet.has(value));
    if (missing.length > 0) {
      throw new BadRequestException(
        `${requestedLabel} ${missing.map((value) => `"${value}"`).join(', ')}, but ${allowedLabel} only grants ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
      );
    }
  }

  private validateConsumeEnvironment(
    alias: string,
    environment: string,
    grant: ProjectAppLinkGrant,
    consumerEnvNames: Set<string>,
  ): void {
    if (environment !== 'same') {
      if (grant.envs.length > 0 && !grant.envs.includes(environment)) {
        throw new BadRequestException(
          `app_links.consumes.${alias}.environment: producer grant allows ${grant.envs.join(', ') || '(none)'}, not "${environment}"`,
        );
      }
      return;
    }

    if (grant.envs.length === 0 || consumerEnvNames.size === 0) {
      return;
    }

    const missing = [...consumerEnvNames].filter((name) => !grant.envs.includes(name));
    if (missing.length > 0) {
      throw new BadRequestException(
        `app_links.consumes.${alias}.environment: same-env link is not granted for producer env(s): ${missing.join(', ')}`,
      );
    }
  }

  private async findUsableGrant(input: {
    producerProject: Project;
    consumerProject: Project;
    exportKind: 'api' | 'events';
    exportName: string;
    path: string;
  }): Promise<ProjectAppLinkGrant> {
    const grant = await this.appLinkGrants.findActive({
      producer_project_id: input.producerProject.id,
      export_kind: input.exportKind,
      export_name: input.exportName,
      consumer_project_id: input.consumerProject.id,
    });
    if (grant) return grant;

    const existing = (await this.appLinkGrants.listByConsumer(input.consumerProject.id, true))
      .find((candidate) => (
        candidate.producer_project_id === input.producerProject.id
        && candidate.export_kind === input.exportKind
        && candidate.export_name === input.exportName
      ));
    if (existing?.revoked_at) {
      throw new BadRequestException(
        `${input.path}: grant from producer ${input.producerProject.slug} is revoked at ${existing.revoked_at.toISOString()}`,
      );
    }

    throw new BadRequestException(
      `${input.path}: no active ${input.exportKind} grant "${input.exportName}" from producer ${input.producerProject.slug} to consumer ${input.consumerProject.slug}`,
    );
  }

  private appLinkGrantKey(grant: Pick<PreparedAppLinkGrant, 'export_kind' | 'export_name' | 'consumer_project_id'>): string {
    return `${grant.export_kind}:${grant.export_name}:${grant.consumer_project_id}`;
  }

  private async normalizeProjectAuthConfig(
    projectOrgId: string,
    authConfig: ProjectAuthConfig | null,
  ): Promise<ProjectAuthConfig | null> {
    if (!authConfig) return null;

    const orgAccess = authConfig.org_access;

    let resolvedAllowedOrgs: string[];
    if (orgAccess.mode === 'project_org') {
      resolvedAllowedOrgs = [projectOrgId];
    } else {
      resolvedAllowedOrgs = [];
      for (const ref of orgAccess.allowed_orgs) {
        const org = ref.startsWith('org_')
          ? await this.orgs.findById(ref, { include_deleted: false })
          : await this.orgs.findBySlug(ref, { include_deleted: false });
        if (!org) {
          throw new BadRequestException(`Allowed org not found: ${ref}`);
        }
        if (!resolvedAllowedOrgs.includes(org.id)) {
          resolvedAllowedOrgs.push(org.id);
        }
      }
    }

    const domainSignup = orgAccess.domain_signup;
    let resolvedDomainSignup = domainSignup;
    if (domainSignup.enabled) {
      // Resolve each rule's target_org slug → canonical id, then validate it
      // falls inside the project's effective allowed_orgs. Rules keep their
      // declaration order so first-match precedence is preserved at runtime.
      const resolvedRules: AppDomainSignupRule[] = [];
      for (const [index, rule] of domainSignup.domains.entries()) {
        const ref = rule.target_org;
        const org = ref.startsWith('org_')
          ? await this.orgs.findById(ref, { include_deleted: false })
          : await this.orgs.findBySlug(ref, { include_deleted: false });
        if (!org) {
          throw new BadRequestException(
            `domain_signup.domains[${index}] ("${rule.domain}"): target_org not found: ${ref}`,
          );
        }
        if (!resolvedAllowedOrgs.includes(org.id)) {
          throw new BadRequestException(
            `domain_signup.domains[${index}] ("${rule.domain}"): target_org ${org.id} must be one of the app's allowed_orgs`,
          );
        }
        resolvedRules.push({ ...rule, target_org: org.id });
      }
      resolvedDomainSignup = {
        ...domainSignup,
        domains: resolvedRules,
      };
    }

    return {
      ...authConfig,
      org_access: {
        ...orgAccess,
        allowed_orgs: resolvedAllowedOrgs,
        domain_signup: resolvedDomainSignup,
      },
    };
  }

  private async reconcileIngressAliases(projectId: string, manifest: Manifest): Promise<void> {
    const aliases = getManifestIngressAliases(manifest);
    const tcpAliases = getManifestTcpIngressAliases(manifest);
    assertUniqueManifestIngressAliases(aliases);
    assertUniqueManifestIngressAliases(tcpAliases);
    for (const alias of tcpAliases.keys()) {
      if (aliases.has(alias)) {
        throw new BadRequestException(`Ingress alias "${alias}" is declared for both HTTP and TCP ingress`);
      }
    }
    const allAliases = new Map([...aliases.entries(), ...tcpAliases.entries()]);

    try {
      await this.db.begin(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const txIngressAliases = ingressAliasQueries(tx);
        const existingClaims = await txIngressAliases.findByProject(projectId);
        const desiredAliases = new Set(allAliases.keys());

        for (const [alias, serviceName] of allAliases.entries()) {
          const row = await txIngressAliases.claimOrUpdate({
            id: generateIngressAliasId(),
            alias,
            project_id: projectId,
            service_name: serviceName,
          });

          if (!row || row.project_id !== projectId) {
            throw new ConflictException(`Ingress alias "${alias}" is already claimed by another project`);
          }
        }

        for (const claim of existingClaims) {
          if (!desiredAliases.has(claim.alias)) {
            await txIngressAliases.release(claim.alias, projectId);
          }
        }
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '23505') {
        throw new ConflictException('One or more ingress aliases are already claimed');
      }
      throw error;
    }
  }

  private async reconcileCustomDomains(projectId: string, manifest: Manifest): Promise<string[]> {
    const declarations = getManifestCustomDomainDeclarations(manifest);
    assertUniqueManifestCustomDomainDeclarations(declarations);
    const desired = getManifestCustomDomainDesiredState(manifest);
    this.validateManifestCustomDomainServices(manifest, desired);
    const warnings: string[] = [];

    try {
      await this.db.begin(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const txCustomDomains = customDomainQueries(tx);
        const txEnvironments = environmentQueries(tx);
        const existingClaims = await txCustomDomains.findByProject(projectId);
        const desiredHostnames = new Set(desired.keys());

        for (const state of desired.values()) {
          const row = await txCustomDomains.claimOrUpdate({
            id: generateCustomDomainId(),
            hostname: state.hostname,
            project_id: projectId,
            service_name: state.service_name,
            source: 'manifest',
          });

          if (!row || row.project_id !== projectId) {
            throw new ConflictException(`Custom domain "${state.hostname}" is already claimed by another project`);
          }

          if (state.env_names.length === 1) {
            const envName = state.env_names[0];
            const environment = await ensureManifestEnvironment(txEnvironments, projectId, envName, manifest);
            if (!environment) {
              throw new BadRequestException(
                `Custom domain "${state.hostname}" references unknown environment "${envName}" at ${state.origin_paths.join(', ')}`,
              );
            }

            const bound = await txCustomDomains.bindToEnvironment(
              state.hostname,
              projectId,
              environment.id,
              state.service_name,
              'manifest',
            );

            if (!bound) {
              const owner = row.environment_id
                ? await txEnvironments.findById(row.environment_id)
                : null;
              const ownerName = owner?.name ?? row.environment_id ?? 'unknown';
              warnings.push(
                `Custom domain "${state.hostname}" is already owned by environment "${ownerName}". ` +
                `To move it, run: eve domain transfer ${state.hostname} --to ${envName}`,
              );
            }
            continue;
          }

          if (state.env_names.length > 1) {
            if (!row.environment_id) {
              warnings.push(
                `Custom domain "${state.hostname}" is declared in multiple environments (${state.env_names.join(', ')}) and is unbound. ` +
                `Run eve domain transfer ${state.hostname} --to <env> to choose the owner explicitly.`,
              );
              continue;
            }

            const owner = await txEnvironments.findById(row.environment_id);
            if (!owner || !state.env_names.includes(owner.name)) {
              const ownerName = owner?.name ?? row.environment_id;
              warnings.push(
                `Custom domain "${state.hostname}" is declared in multiple environments (${state.env_names.join(', ')}) but is owned by "${ownerName}". ` +
                `Run eve domain transfer ${state.hostname} --to <env> to choose one of the declared owners.`,
              );
            }
          }
        }

        for (const claim of existingClaims) {
          if (!desiredHostnames.has(claim.hostname)) {
            await txCustomDomains.releaseManifestManaged(claim.hostname, projectId);
          }
        }
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '23505') {
        throw new ConflictException('One or more custom domains are already claimed');
      }
      throw error;
    }

    return warnings;
  }

  private validateManifestCustomDomainServices(
    manifest: Manifest,
    desired: Map<string, ManifestCustomDomainDesiredState>,
  ): void {
    const baseServices = manifest.services ?? {};
    for (const state of desired.values()) {
      if (state.has_project_scope && !baseServices[state.service_name]) {
        throw new BadRequestException(
          `Custom domain "${state.hostname}" references missing service "${state.service_name}" at ${state.origin_paths.join(', ')}`,
        );
      }

      for (const envName of state.env_names) {
        const envConfig = manifest.environments?.[envName];
        if (!envConfig) {
          throw new BadRequestException(
            `Custom domain "${state.hostname}" references unknown environment "${envName}" at ${state.origin_paths.join(', ')}`,
          );
        }

        const envServices = this.getManifestEnvironmentServiceNames(manifest, envName);
        if (!envServices.has(state.service_name)) {
          throw new BadRequestException(
            `Custom domain "${state.hostname}" references missing service "${state.service_name}" for environment "${envName}" at ${state.origin_paths.join(', ')}`,
          );
        }
      }
    }
  }

  private getManifestEnvironmentServiceNames(manifest: Manifest, envName: string): Set<string> {
    const serviceNames = new Set(Object.keys(manifest.services ?? {}));
    const envConfig = manifest.environments?.[envName];
    const overrides = envConfig?.overrides;
    if (!overrides || typeof overrides !== 'object') {
      return serviceNames;
    }

    const services = (overrides as Record<string, unknown>).services;
    if (!services || typeof services !== 'object' || Array.isArray(services)) {
      return serviceNames;
    }

    for (const serviceName of Object.keys(services)) {
      serviceNames.add(serviceName);
    }
    return serviceNames;
  }
}
