import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { deriveNamespace } from '@eve/shared';
import type { Db } from '@eve/db';
import { environmentQueries, orgQueries, projectApiSourceQueries, projectManifestQueries, projectQueries, type ProjectApiSource } from '@eve/db';
import { type ApiSource, type ApiSourceType, type ApiSpec, type Service, getDefaultSpecUrl, getServicesFromManifest } from '@eve/shared';
import * as yaml from 'yaml';

@Injectable()
export class ProjectApisService {
  private apiSources: ReturnType<typeof projectApiSourceQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private environments: ReturnType<typeof environmentQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.apiSources = projectApiSourceQueries(db);
    this.projects = projectQueries(db);
    this.manifests = projectManifestQueries(db);
    this.orgs = orgQueries(db);
    this.environments = environmentQueries(db);
  }

  async list(projectId: string, options: { env?: string | null; limit?: number; offset?: number }) {
    await this.ensureProject(projectId);
    const sources = await this.apiSources.list({
      project_id: projectId,
      env_name: options.env ?? undefined,
      limit: options.limit,
      offset: options.offset,
    });

    let data = sources.map((source) => this.toResponse(source));
    if (data.length === 0 && options.env) {
      data = await this.listFromManifestFallback(projectId, options.env);
    } else if (data.length === 0 && !options.env) {
      const envs = await this.environments.list({ project_id: projectId, limit: 20, offset: 0 });
      const fallback = new Map<string, ApiSource>();
      for (const env of envs) {
        const envSources = await this.listFromManifestFallback(projectId, env.name);
        for (const source of envSources) {
          fallback.set(`${source.env_name}:${source.name}`, source);
        }
      }
      data = Array.from(fallback.values());
    }

    return {
      data,
      pagination: options.limit !== undefined || options.offset !== undefined ? {
        limit: options.limit ?? 100,
        offset: options.offset ?? 0,
        count: data.length,
      } : undefined,
    };
  }

  async find(projectId: string, name: string, envName?: string | null): Promise<ApiSource> {
    await this.ensureProject(projectId);
    const resolved = await this.findWithFallback(projectId, name, envName);
    if (!resolved) {
      throw new NotFoundException(`API source "${name}" not found for project ${projectId}`);
    }

    return resolved.apiSource;
  }

  async getSpec(projectId: string, name: string, envName?: string | null): Promise<Record<string, unknown>> {
    await this.ensureProject(projectId);
    const resolved = await this.findWithFallback(projectId, name, envName);
    if (!resolved) {
      throw new NotFoundException(`API source "${name}" not found for project ${projectId}`);
    }

    if (resolved.apiSource.cached_schema_json) {
      return resolved.apiSource.cached_schema_json as Record<string, unknown>;
    }

    return this.fetchSpecJson(resolved.specUrl);
  }

  async refreshSpec(projectId: string, name: string, envName?: string | null): Promise<ApiSource> {
    await this.ensureProject(projectId);
    const resolved = await this.findWithFallback(projectId, name, envName);
    if (!resolved) {
      throw new NotFoundException(`API source "${name}" not found for project ${projectId}`);
    }

    const payload = await this.fetchSpecJson(resolved.specUrl);
    const source = resolved.dbSource ?? await this.apiSources.upsert({
      project_id: resolved.apiSource.project_id,
      env_name: resolved.apiSource.env_name,
      name: resolved.apiSource.name,
      type: resolved.apiSource.type,
      base_url: resolved.apiSource.base_url,
      spec_url: resolved.apiSource.spec_url,
      auth_mode: resolved.apiSource.auth_mode,
    });

    const updated = await this.apiSources.updateCachedSchema(source.project_id, source.env_name, source.name, payload);

    if (!updated) {
      throw new NotFoundException(`API source "${name}" not found for project ${projectId}`);
    }

    return this.toResponse(updated);
  }

  private async ensureProject(projectId: string): Promise<void> {
    const project = await this.projects.findById(projectId, { include_deleted: true });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }

  private async findWithFallback(
    projectId: string,
    name: string,
    envName?: string | null,
  ): Promise<{ dbSource: ProjectApiSource | null; apiSource: ApiSource; specUrl: string } | null> {
    if (envName !== undefined) {
      const scoped = await this.apiSources.findByProjectEnvAndName(projectId, envName ?? null, name);
      if (scoped) {
        return {
          dbSource: scoped,
          apiSource: this.toResponse(scoped),
          specUrl: this.resolveSpecUrl(scoped),
        };
      }
    }

    const unscoped = await this.apiSources.findByProjectEnvAndName(projectId, null, name);
    if (unscoped) {
      return {
        dbSource: unscoped,
        apiSource: this.toResponse(unscoped),
        specUrl: this.resolveSpecUrl(unscoped),
      };
    }

    if (!envName) {
      return null;
    }

    const fallback = await this.listFromManifestFallback(projectId, envName);
    const source = fallback.find((entry) => entry.name === name);
    if (!source) {
      return null;
    }

    return {
      dbSource: null,
      apiSource: source,
      specUrl: this.resolveSpecUrlFromApiSource(source),
    };
  }

  private async listFromManifestFallback(projectId: string, envName: string): Promise<ApiSource[]> {
    const project = await this.projects.findById(projectId, { include_deleted: true });
    if (!project) return [];
    const org = await this.orgs.findById(project.org_id, { include_deleted: true });
    if (!org) return [];

    const manifestRecord = await this.manifests.findLatestByProject(projectId);
    if (!manifestRecord) return [];

    const manifest = yaml.parse(manifestRecord.manifest_yaml) as Record<string, unknown>;
    const services = getServicesFromManifest(manifest);
    if (!services) return [];

    const now = new Date().toISOString();
    const fallbackSources: ApiSource[] = [];

    for (const [componentName, service] of Object.entries(services)) {
      const xeve = this.resolveXeve(service);
      const specs = this.resolveApiSpecs(xeve);
      if (specs.length === 0) continue;

      const baseUrl = this.resolveBaseUrl(componentName, project.slug, org.slug, envName, service, xeve);
      for (const spec of specs) {
        if (spec.on_deploy === false) continue;
        const apiName = spec.name ?? componentName;
        fallbackSources.push({
          project_id: projectId,
          env_name: envName,
          name: apiName,
          type: this.convertApiType(spec.type),
          base_url: baseUrl,
          spec_url: spec.spec_url ?? getDefaultSpecUrl(spec.type),
          auth_mode: spec.auth ?? 'eve',
          cached_schema_json: null,
          last_synced_at: null,
          created_at: now,
          updated_at: now,
        });
      }
    }

    return fallbackSources;
  }

  private resolveXeve(service: Service): Record<string, unknown> | null {
    const raw = (service as Record<string, unknown>)['x-eve'] ?? (service as Record<string, unknown>).x_eve;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  }

  private resolveApiSpecs(xeve: Record<string, unknown> | null): ApiSpec[] {
    if (!xeve) return [];
    const specs: ApiSpec[] = [];
    const apiSpec = xeve.api_spec as ApiSpec | undefined;
    const apiSpecs = xeve.api_specs as ApiSpec[] | undefined;
    if (apiSpec) specs.push(apiSpec);
    if (Array.isArray(apiSpecs)) specs.push(...apiSpecs);
    return specs;
  }

  private resolveBaseUrl(
    componentName: string,
    projectSlug: string,
    orgSlug: string,
    envName: string,
    service: Service,
    xeve: Record<string, unknown> | null,
  ): string {
    const port = this.resolveServicePort(service, xeve);
    const portSuffix = port ? `:${port}` : '';

    const namespace = deriveNamespace(orgSlug, projectSlug, envName);
    return `http://${envName}-${componentName}.${namespace}.svc.cluster.local${portSuffix}`;
  }

  private resolveServicePort(service: Service, xeve: Record<string, unknown> | null): number | undefined {
    const ingress = xeve?.ingress;
    if (ingress && typeof ingress === 'object') {
      const ingressPort = (ingress as Record<string, unknown>).port;
      if (typeof ingressPort === 'number') {
        return ingressPort;
      }
    }

    const ports = (service as Record<string, unknown>).ports;
    if (!Array.isArray(ports) || ports.length === 0) return undefined;
    const first = ports[0];
    if (typeof first === 'number') return first;
    if (typeof first === 'string') {
      const pieces = first.split(':');
      const candidate = pieces[pieces.length - 1];
      const parsed = parseInt(candidate, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private convertApiType(type: ApiSpec['type']): ApiSourceType {
    switch (type) {
      case 'openapi':
        return 'openapi';
      case 'postgrest':
        return 'postgrest';
      case 'graphql':
        return 'supabase-graphql';
    }
  }

  private resolveSpecUrl(source: ProjectApiSource): string {
    const baseUrl = source.base_url.replace(/\/$/, '');

    if (source.spec_url) {
      // spec_url may be relative (like /openapi.json) or absolute
      if (source.spec_url.startsWith('http://') || source.spec_url.startsWith('https://')) {
        return source.spec_url;
      }
      // Ensure spec_url starts with /
      const specPath = source.spec_url.startsWith('/') ? source.spec_url : `/${source.spec_url}`;
      return `${baseUrl}${specPath}`;
    }

    if (source.type === 'openapi') {
      return `${baseUrl}/openapi.json`;
    }

    throw new BadRequestException(`API source "${source.name}" does not define spec_url`);
  }

  private resolveSpecUrlFromApiSource(source: ApiSource): string {
    const baseUrl = source.base_url.replace(/\/$/, '');
    const specUrl = source.spec_url;
    if (!specUrl) {
      throw new BadRequestException(`API source "${source.name}" does not define spec_url`);
    }
    if (specUrl.startsWith('http://') || specUrl.startsWith('https://')) {
      return specUrl;
    }
    const specPath = specUrl.startsWith('/') ? specUrl : `/${specUrl}`;
    return `${baseUrl}${specPath}`;
  }

  private async fetchSpecJson(specUrl: string): Promise<Record<string, unknown>> {
    const response = await fetch(specUrl);
    if (!response.ok) {
      throw new BadRequestException(`Failed to fetch spec from ${specUrl}: ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException(`Spec from ${specUrl} did not return JSON object`);
    }
    return payload as Record<string, unknown>;
  }

  private toResponse(source: ProjectApiSource): ApiSource {
    return {
      project_id: source.project_id,
      env_name: source.env_name,
      name: source.name,
      type: source.type as ApiSourceType,
      base_url: source.base_url,
      spec_url: source.spec_url,
      auth_mode: source.auth_mode,
      cached_schema_json: source.cached_schema_json,
      last_synced_at: source.last_synced_at ? source.last_synced_at.toISOString() : null,
      created_at: source.created_at.toISOString(),
      updated_at: source.updated_at.toISOString(),
    };
  }
}
