import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  appLinkGrantQueries,
  appLinkSubscriptionQueries,
  projectManifestQueries,
  projectQueries,
  type AppLinkSubscriptionWithGrant,
  type Db,
  type Project,
  type ProjectAppLinkGrant,
  type ProjectAppLinkSubscription,
} from '@eve/db';
import {
  AppLinksExplainRequest,
  AppLinksExplainResponse,
  AppLinksListResponse,
  AppLinksPlanRequest,
  AppLinksPlanResponse,
  ManifestSchema,
  getManifestAppLinks,
} from '@eve/shared';
import * as yaml from 'yaml';

@Injectable()
export class AppLinksService {
  private projects: ReturnType<typeof projectQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private grants: ReturnType<typeof appLinkGrantQueries>;
  private subscriptions: ReturnType<typeof appLinkSubscriptionQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.projects = projectQueries(db);
    this.manifests = projectManifestQueries(db);
    this.grants = appLinkGrantQueries(db);
    this.subscriptions = appLinkSubscriptionQueries(db);
  }

  async list(projectId: string): Promise<AppLinksListResponse> {
    const project = await this.ensureProject(projectId);
    const [grants, subscriptions] = await Promise.all([
      this.grants.listForProject(project.id),
      this.subscriptions.listByConsumer(project.id),
    ]);

    return {
      project_id: project.id,
      exports: grants
        .filter((grant) => grant.producer_project_id === project.id)
        .map((grant) => this.grantToResponse(grant)),
      grants_to_project: grants
        .filter((grant) => grant.consumer_project_id === project.id)
        .map((grant) => this.grantToResponse(grant)),
      consumes: subscriptions.map((subscription) => this.subscriptionToResponse(subscription)),
    };
  }

  async explain(projectId: string, body: AppLinksExplainRequest): Promise<AppLinksExplainResponse> {
    const baseProject = await this.ensureProject(projectId);
    const consumer = body.consumer_project
      ? await this.resolveProjectRef(baseProject, body.consumer_project)
      : baseProject;

    if (body.alias) {
      const subscription = await this.subscriptions.findWithGrantsByConsumerAlias(consumer.id, body.alias);
      return this.explainSubscription(subscription);
    }

    if (!body.producer_project || (!body.api && !body.events)) {
      throw new BadRequestException('explain requires alias or producer_project plus api/events');
    }

    const producer = await this.resolveProjectRef(consumer, body.producer_project);
    const exportKind = body.api ? 'api' : 'events';
    const exportName = body.api ?? body.events!;
    const grant = await this.grants.findActive({
      producer_project_id: producer.id,
      export_kind: exportKind,
      export_name: exportName,
      consumer_project_id: consumer.id,
    });

    if (!grant) {
      const revoked = (await this.grants.listByConsumer(consumer.id, true))
        .find((candidate) => (
          candidate.producer_project_id === producer.id
          && candidate.export_kind === exportKind
          && candidate.export_name === exportName
        ));
      return {
        status: revoked?.revoked_at ? 'REVOKED' : 'MISSING',
        diagnostics: [{
          level: revoked?.revoked_at ? 'error' : 'error',
          message: revoked?.revoked_at
            ? `Grant was revoked at ${revoked.revoked_at.toISOString()}`
            : `No active ${exportKind} grant "${exportName}" from ${producer.slug} to ${consumer.slug}`,
        }],
        grant: revoked ? this.grantToResponse(revoked) : null,
        subscription: null,
      };
    }

    const subscription = (await this.subscriptions.listByConsumer(consumer.id))
      .find((candidate) => candidate.api_grant_id === grant.id || candidate.event_grant_id === grant.id) ?? null;

    return {
      status: 'OK',
      diagnostics: [
        { level: 'ok', message: `Grant ${producer.slug}/${exportKind}/${exportName} is active for ${consumer.slug}` },
        ...(subscription ? [] : [{ level: 'warning' as const, message: 'Consumer has no subscription row for this grant' }]),
      ],
      grant: this.grantToResponse(grant),
      subscription: subscription ? this.subscriptionToResponse(subscription) : null,
    };
  }

  async plan(projectId: string, body: AppLinksPlanRequest): Promise<AppLinksPlanResponse> {
    const project = await this.ensureProject(projectId);
    let manifestYaml = body.manifest_yaml;
    if (!manifestYaml) {
      const latest = await this.manifests.findLatestByProject(project.id);
      if (!latest) {
        return {
          valid: false,
          diagnostics: [{ level: 'error', message: 'No manifest synced and no manifest_yaml provided' }],
        };
      }
      manifestYaml = latest.manifest_yaml;
    }

    const diagnostics: AppLinksPlanResponse['diagnostics'] = [];
    let parsed: unknown;
    try {
      parsed = yaml.parse(manifestYaml);
    } catch (error) {
      return {
        valid: false,
        diagnostics: [{ level: 'error', message: `Invalid YAML: ${error instanceof Error ? error.message : 'unknown error'}` }],
      };
    }

    const manifest = ManifestSchema.safeParse(parsed);
    if (!manifest.success) {
      return {
        valid: false,
        diagnostics: [{ level: 'error', message: manifest.error.message }],
      };
    }

    const consumes = getManifestAppLinks(manifest.data)?.consumes ?? {};
    for (const [alias, consume] of Object.entries(consumes)) {
      const producer = await this.resolveProjectRef(project, consume.project);
      if (consume.api) {
        const grant = await this.grants.findActive({
          producer_project_id: producer.id,
          export_kind: 'api',
          export_name: consume.api,
          consumer_project_id: project.id,
        });
        if (!grant) {
          diagnostics.push({ level: 'error', message: `${alias}: missing API grant ${producer.slug}/${consume.api}` });
        } else {
          const missingScopes = consume.scopes.filter((scope) => !grant.api_scopes.includes(scope));
          if (missingScopes.length > 0) {
            diagnostics.push({
              level: 'error',
              message: `${alias}: requested scope(s) not granted: ${missingScopes.join(', ')}`,
            });
          } else {
            diagnostics.push({ level: 'ok', message: `${alias}: API grant ${producer.slug}/${consume.api} is usable` });
          }
        }
      }
      if (consume.events) {
        const grant = await this.grants.findActive({
          producer_project_id: producer.id,
          export_kind: 'events',
          export_name: consume.events.feed,
          consumer_project_id: project.id,
        });
        if (!grant) {
          diagnostics.push({ level: 'error', message: `${alias}: missing event grant ${producer.slug}/${consume.events.feed}` });
        } else {
          const requested = consume.events.types.length > 0 ? consume.events.types : grant.event_types;
          const missingTypes = requested.filter((type) => !grant.event_types.includes(type));
          if (missingTypes.length > 0) {
            diagnostics.push({
              level: 'error',
              message: `${alias}: requested event type(s) not granted: ${missingTypes.join(', ')}`,
            });
          } else {
            diagnostics.push({ level: 'ok', message: `${alias}: event grant ${producer.slug}/${consume.events.feed} is usable` });
          }
        }
      }
    }

    if (Object.keys(consumes).length === 0) {
      diagnostics.push({ level: 'warning', message: 'Manifest does not declare x-eve.app_links.consumes' });
    }

    return {
      valid: diagnostics.every((diagnostic) => diagnostic.level !== 'error'),
      diagnostics,
    };
  }

  private explainSubscription(subscription: AppLinkSubscriptionWithGrant | null): AppLinksExplainResponse {
    if (!subscription) {
      return {
        status: 'MISSING',
        diagnostics: [{ level: 'error', message: 'Subscription not found' }],
        grant: null,
        subscription: null,
      };
    }

    const diagnostics: AppLinksExplainResponse['diagnostics'] = [];
    let status: AppLinksExplainResponse['status'] = 'OK';
    const relevantGrant = subscription.api_grant ?? subscription.event_grant;

    if (subscription.api_grant?.revoked_at || subscription.event_grant?.revoked_at) {
      status = 'REVOKED';
      diagnostics.push({
        level: 'error',
        message: 'One or more grants referenced by this subscription are revoked',
      });
    }

    if (subscription.inject_into_services.length === 0 && !subscription.inject_into_jobs) {
      diagnostics.push({ level: 'warning', message: 'Subscription is recorded but not injected into services or jobs' });
    }

    if (diagnostics.length === 0) {
      diagnostics.push({ level: 'ok', message: 'Subscription and referenced grant are active' });
    }

    return {
      status,
      diagnostics,
      grant: relevantGrant ? this.grantToResponse(relevantGrant) : null,
      subscription: this.subscriptionToResponse(subscription),
    };
  }

  private async ensureProject(projectId: string): Promise<Project> {
    const project = await this.projects.findById(projectId, { include_deleted: false });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return project;
  }

  private async resolveProjectRef(currentProject: Project, ref: string): Promise<Project> {
    const project = ref.startsWith('proj_')
      ? await this.projects.findById(ref, { include_deleted: false })
      : await this.projects.findByOrgAndSlug(currentProject.org_id, ref, { include_deleted: false });
    if (!project) {
      throw new NotFoundException(`Project ${ref} not found`);
    }
    if (project.org_id !== currentProject.org_id) {
      throw new BadRequestException('Cross-org app links are not supported in v1');
    }
    return project;
  }

  private grantToResponse(grant: ProjectAppLinkGrant) {
    return {
      id: grant.id,
      producer_project_id: grant.producer_project_id,
      export_kind: grant.export_kind,
      export_name: grant.export_name,
      consumer_project_id: grant.consumer_project_id,
      api_scopes: grant.api_scopes,
      event_types: grant.event_types,
      envs: grant.envs,
      service_name: grant.service_name,
      cli_name: grant.cli_name,
      cli_image: grant.cli_image,
      cli_bin_path: grant.cli_bin_path,
      revoked_at: grant.revoked_at?.toISOString() ?? null,
      created_at: grant.created_at.toISOString(),
      updated_at: grant.updated_at.toISOString(),
    };
  }

  private subscriptionToResponse(subscription: ProjectAppLinkSubscription) {
    return {
      id: subscription.id,
      consumer_project_id: subscription.consumer_project_id,
      local_alias: subscription.local_alias,
      api_grant_id: subscription.api_grant_id,
      event_grant_id: subscription.event_grant_id,
      requested_scopes: subscription.requested_scopes,
      event_types: subscription.event_types,
      environment_strategy: subscription.environment_strategy,
      producer_env_name: subscription.producer_env_name,
      inject_into_services: subscription.inject_into_services,
      inject_into_jobs: subscription.inject_into_jobs,
      last_token_minted_at: subscription.last_token_minted_at?.toISOString() ?? null,
      last_token_principal: subscription.last_token_principal,
      last_token_audience: subscription.last_token_audience,
      created_at: subscription.created_at.toISOString(),
      updated_at: subscription.updated_at.toISOString(),
    };
  }
}
