import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Db } from '@eve/db';
import { projectApiSourceQueries } from '@eve/db';
import { type ApiSpec, getDefaultSpecUrl } from '@eve/shared';

interface ResolvedBaseUrls {
  internal_base_url: string;
  external_base_url: string;
}

@Injectable()
export class ApiRegistrationService {
  private readonly logger = new Logger(ApiRegistrationService.name);
  private apiSources: ReturnType<typeof projectApiSourceQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.apiSources = projectApiSourceQueries(db);
  }

  /**
   * Register a component's API during deployment
   */
  async registerComponentApi(
    projectId: string,
    envName: string,
    componentName: string,
    apiSpec: ApiSpec,
    deployedBaseUrl: string,
    repoPath?: string,
  ): Promise<void> {
    this.logger.log(
      `Registering API for ${componentName} in ${envName} (${apiSpec.type})`,
    );

    // Resolve spec URL
    const specUrl = apiSpec.spec_url ?? getDefaultSpecUrl(apiSpec.type);
    const normalizedBase = deployedBaseUrl.endsWith('/') ? deployedBaseUrl : `${deployedBaseUrl}/`;
    const fullSpecUrl = new URL(specUrl, normalizedBase).toString();

    // Fetch the spec
    let spec: string;
    try {
      if (apiSpec.spec_path) {
        spec = await this.readSpecFromPath(componentName, apiSpec.spec_path, repoPath);
      } else {
        spec = await this.fetchSpec(fullSpecUrl, apiSpec.type);
      }
    } catch (error) {
      this.logger.error(
        `Failed to fetch spec from ${fullSpecUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    // Parse spec to store in cached_schema_json
    let cachedSchema: Record<string, unknown>;
    try {
      cachedSchema = JSON.parse(spec);
    } catch (error) {
      this.logger.error(
        `Failed to parse spec JSON for ${componentName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException('Spec is not valid JSON');
    }

    // Determine the API name (use custom name or default to component name)
    const apiName = apiSpec.name ?? componentName;

    // Convert api type to match DB type
    const dbType = this.convertApiType(apiSpec.type);

    // Upsert into project_api_sources
    // Note: auth_mode defaults to 'eve' if not specified
    await this.apiSources.upsert({
      project_id: projectId,
      env_name: envName,
      name: apiName,
      type: dbType,
      base_url: deployedBaseUrl,
      spec_url: specUrl,
      auth_mode: apiSpec.auth ?? 'eve',
    });

    // Update cached schema
    await this.apiSources.updateCachedSchema(
      projectId,
      envName,
      apiName,
      cachedSchema,
    );

    this.logger.log(
      `Successfully registered API ${apiName} for ${componentName} in ${envName}`,
    );
  }

  private async readSpecFromPath(
    componentName: string,
    specPath: string,
    repoPath?: string,
  ): Promise<string> {
    if (!repoPath) {
      this.logger.warn(
        `spec_path is only supported for local file:// repos. Skipping ${componentName}.`,
      );
      throw new Error('spec_path requires local repo path');
    }

    const repoRoot = path.resolve(repoPath);
    const resolved = path.resolve(repoRoot, specPath);
    const relative = path.relative(repoRoot, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`spec_path ${specPath} escapes repo root`);
    }

    return fs.readFile(resolved, 'utf-8');
  }

  /**
   * Resolve internal and external base URLs for a component
   */
  resolveBaseUrls(
    orgSlug: string,
    projectSlug: string,
    envName: string,
    componentName: string,
    domain: string,
    port?: number,
  ): ResolvedBaseUrls {
    const portSuffix = port ? `:${port}` : '';

    return {
      internal_base_url: `http://${envName}-${componentName}.eve-${orgSlug}-${projectSlug}-${envName}.svc.cluster.local${portSuffix}`,
      external_base_url: `http://${componentName}.${orgSlug}-${projectSlug}-${envName}.${domain}`,
    };
  }

  /**
   * Fetch an API spec from a URL
   */
  async fetchSpec(
    url: string,
    type: ApiSpec['type'],
  ): Promise<string> {
    this.logger.debug(`Fetching ${type} spec from ${url}`);

    try {
      if (type === 'graphql') {
        // For GraphQL, use introspection query
        return await this.fetchGraphQLIntrospection(url);
      }

      // For OpenAPI and PostgREST, fetch directly
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      return await response.text();
    } catch (error) {
      this.logger.error(
        `Failed to fetch spec from ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Fetch GraphQL schema using introspection query
   */
  private async fetchGraphQLIntrospection(url: string): Promise<string> {
    // GraphQL introspection query
    const introspectionQuery = {
      query: `
        query IntrospectionQuery {
          __schema {
            queryType { name }
            mutationType { name }
            subscriptionType { name }
            types {
              ...FullType
            }
            directives {
              name
              description
              locations
              args {
                ...InputValue
              }
            }
          }
        }

        fragment FullType on __Type {
          kind
          name
          description
          fields(includeDeprecated: true) {
            name
            description
            args {
              ...InputValue
            }
            type {
              ...TypeRef
            }
            isDeprecated
            deprecationReason
          }
          inputFields {
            ...InputValue
          }
          interfaces {
            ...TypeRef
          }
          enumValues(includeDeprecated: true) {
            name
            description
            isDeprecated
            deprecationReason
          }
          possibleTypes {
            ...TypeRef
          }
        }

        fragment InputValue on __InputValue {
          name
          description
          type { ...TypeRef }
          defaultValue
        }

        fragment TypeRef on __Type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                    ofType {
                      kind
                      name
                      ofType {
                        kind
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(introspectionQuery),
    });

    if (!response.ok) {
      throw new Error(
        `GraphQL introspection failed: HTTP ${response.status}: ${response.statusText}`,
      );
    }

    return await response.text();
  }

  /**
   * Convert ApiSpec type to DB ApiSourceType
   */
  private convertApiType(type: ApiSpec['type']): 'openapi' | 'postgrest' | 'supabase-graphql' {
    switch (type) {
      case 'openapi':
        return 'openapi';
      case 'postgrest':
        return 'postgrest';
      case 'graphql':
        return 'supabase-graphql';
      default:
        // Shouldn't happen due to type constraints, but handle defensively
        throw new BadRequestException(`Unknown API type: ${type}`);
    }
  }
}
