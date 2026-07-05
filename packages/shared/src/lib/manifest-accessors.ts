/**
 * Manifest accessor/derivation helpers.
 *
 * Pure functions that read parsed `Manifest` objects (x-eve fields, ingress
 * aliases, custom domains, buildable services, registry config, managed DBs,
 * object store, networking, TCP ingress). The zod schemas and inferred types
 * live in `../schemas/manifest.ts`, which re-exports everything here so
 * existing importers are unaffected.
 */
import type { z } from 'zod';
import type { PackEntrySchema } from '../schemas/pack.js';
import {
  IngressConfigSchema,
  ManagedDbConfigSchema,
  ServiceNetworkingSchema,
  ServiceXeveSchema,
  TcpIngressConfigSchema,
} from '../schemas/manifest.js';
import type {
  AppLinks,
  Environment,
  ManagedDbConfig,
  Manifest,
  ManifestXeve,
  ObjectStoreBucket,
  ObjectStoreIsolation,
  ProjectAuthConfig,
  ProjectBranding,
  Service,
  ServiceNetworking,
  TcpIngressConfig,
} from '../schemas/manifest.js';

function getXeveField<K extends keyof ManifestXeve>(manifest: Manifest, key: K): NonNullable<ManifestXeve[K]> | null {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && key in xEve) {
    return ((xEve as ManifestXeve)[key] ?? null) as NonNullable<ManifestXeve[K]> | null;
  }
  return null;
}

export function getManifestDefaults(manifest: Manifest): Record<string, unknown> | null {
  return getXeveField(manifest, 'defaults');
}

export function getManifestAgents(manifest: Manifest): Record<string, unknown> | null {
  return getXeveField(manifest, 'agents');
}

export function getManifestBranding(manifest: Manifest): ProjectBranding | null {
  return getXeveField(manifest, 'branding');
}

export function getManifestAuthConfig(manifest: Manifest): ProjectAuthConfig | null {
  return getXeveField(manifest, 'auth');
}

export function getManifestAppLinks(manifest: Manifest): AppLinks | null {
  return getXeveField(manifest, 'app_links');
}

export function getServicesFromManifest(manifest: Manifest): Record<string, Service> | null {
  return manifest.services ?? null;
}

const INGRESS_DUPLICATES_KEY = '__duplicates';

export const RESERVED_ALIASES = new Set([
  'api',
  'eve',
  'www',
  'status',
  'admin',
  'health',
  'sso',
  'registry',
]);

type IngressAliasMapWithMeta = Map<string, string> & {
  [INGRESS_DUPLICATES_KEY]?: string[];
};

/**
 * Extract alias -> serviceName mappings from service x-eve ingress config.
 * Duplicate aliases are tracked for downstream validation.
 */
export function getManifestIngressAliases(manifest: Manifest): Map<string, string> {
  const aliases = new Map<string, string>();
  const duplicateAliases = new Set<string>();
  const services = manifest.services ?? {};

  for (const [serviceName, service] of Object.entries(services)) {
    const xEve = service['x-eve'] ?? service.x_eve;
    const ingress = xEve?.ingress;
    if (!ingress || typeof ingress !== 'object') {
      continue;
    }

    const parsed = IngressConfigSchema.safeParse(ingress);
    if (!parsed.success) {
      continue;
    }

    const alias = parsed.data.alias?.trim().toLowerCase();
    if (!alias) {
      continue;
    }

    const existing = aliases.get(alias);
    if (existing && existing !== serviceName) {
      duplicateAliases.add(alias);
      continue;
    }

    aliases.set(alias, serviceName);
  }

  if (duplicateAliases.size > 0) {
    (aliases as IngressAliasMapWithMeta)[INGRESS_DUPLICATES_KEY] = Array.from(duplicateAliases.values());
  }

  return aliases;
}

/**
 * Extract TCP hostname alias -> serviceName mappings from service x-eve
 * tcp_ingress config. Duplicate aliases are tracked for downstream validation.
 */
export function getManifestTcpIngressAliases(manifest: Manifest): Map<string, string> {
  const aliases = new Map<string, string>();
  const duplicateAliases = new Set<string>();
  const services = manifest.services ?? {};

  for (const [serviceName, service] of Object.entries(services)) {
    const xEve = service['x-eve'] ?? service.x_eve;
    const tcpIngress = xEve?.tcp_ingress;
    if (!tcpIngress || typeof tcpIngress !== 'object') {
      continue;
    }

    const parsed = TcpIngressConfigSchema.safeParse(tcpIngress);
    if (!parsed.success) {
      continue;
    }

    const alias = parsed.data.hostname?.trim().toLowerCase();
    if (!alias) {
      continue;
    }

    const existing = aliases.get(alias);
    if (existing && existing !== serviceName) {
      duplicateAliases.add(alias);
      continue;
    }

    aliases.set(alias, serviceName);
  }

  if (duplicateAliases.size > 0) {
    (aliases as IngressAliasMapWithMeta)[INGRESS_DUPLICATES_KEY] = Array.from(duplicateAliases.values());
  }

  return aliases;
}

/**
 * Ensure aliases within one manifest are unique across services.
 */
export function assertUniqueManifestIngressAliases(aliases: Map<string, string>): void {
  const duplicates = (aliases as IngressAliasMapWithMeta)[INGRESS_DUPLICATES_KEY] ?? [];
  if (duplicates.length > 0) {
    throw new Error(`Duplicate ingress alias values in manifest: ${duplicates.join(', ')}`);
  }
}

const CUSTOM_DOMAIN_DUPLICATES_KEY = '__cd_duplicates';

type CustomDomainMapWithMeta = Map<string, string> & {
  [CUSTOM_DOMAIN_DUPLICATES_KEY]?: string[];
};

type CustomDomainDeclarationsWithMeta = ManifestCustomDomainDeclaration[] & {
  [CUSTOM_DOMAIN_DUPLICATES_KEY]?: string[];
};

export type ManifestCustomDomainScope = 'project' | 'environment';

export interface ManifestCustomDomainDeclaration {
  hostname: string;
  service_name: string;
  scope: ManifestCustomDomainScope;
  env_name: string | null;
  origin_path: string;
}

export interface ManifestCustomDomainDesiredState {
  hostname: string;
  service_name: string;
  env_names: string[];
  has_project_scope: boolean;
  origin_paths: string[];
}

function getIngressDomainsFromService(service: unknown): string[] {
  if (!service || typeof service !== 'object') {
    return [];
  }

  const candidate = service as {
    x_eve?: { ingress?: unknown };
    'x-eve'?: { ingress?: unknown };
  };
  const xEve = candidate['x-eve'] ?? candidate.x_eve;
  const ingress = xEve?.ingress;
  if (!ingress || typeof ingress !== 'object') {
    return [];
  }

  const parsed = IngressConfigSchema.safeParse(ingress);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.domains ?? [];
}

function getEnvironmentOverrideServices(envConfig: Environment): Record<string, unknown> {
  const overrides = envConfig.overrides;
  if (!overrides || typeof overrides !== 'object') {
    return {};
  }
  const services = (overrides as Record<string, unknown>).services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    return {};
  }
  return services as Record<string, unknown>;
}

/**
 * Extract custom domain declarations from top-level services and environment
 * service overrides. Duplicate hostnames across different services are tracked
 * for downstream validation.
 */
export function getManifestCustomDomainDeclarations(manifest: Manifest): ManifestCustomDomainDeclaration[] {
  const declarations = [] as CustomDomainDeclarationsWithMeta;
  const servicesByHostname = new Map<string, string>();
  const duplicateDomains = new Set<string>();

  const addDeclaration = (declaration: ManifestCustomDomainDeclaration) => {
    const existingService = servicesByHostname.get(declaration.hostname);
    if (existingService && existingService !== declaration.service_name) {
      duplicateDomains.add(declaration.hostname);
    } else {
      servicesByHostname.set(declaration.hostname, declaration.service_name);
    }
    declarations.push(declaration);
  };

  const services = manifest.services ?? {};

  for (const [serviceName, service] of Object.entries(services)) {
    for (const hostname of getIngressDomainsFromService(service)) {
      const normalized = hostname.trim().toLowerCase();
      addDeclaration({
        hostname: normalized,
        service_name: serviceName,
        scope: 'project',
        env_name: null,
        origin_path: `services.${serviceName}.x-eve.ingress.domains`,
      });
    }
  }

  for (const [envName, envConfig] of Object.entries(manifest.environments ?? {})) {
    const overrideServices = getEnvironmentOverrideServices(envConfig);
    for (const [serviceName, service] of Object.entries(overrideServices)) {
      for (const hostname of getIngressDomainsFromService(service)) {
        const normalized = hostname.trim().toLowerCase();
        addDeclaration({
          hostname: normalized,
          service_name: serviceName,
          scope: 'environment',
          env_name: envName,
          origin_path: `environments.${envName}.overrides.services.${serviceName}.x-eve.ingress.domains`,
        });
      }
    }
  }

  if (duplicateDomains.size > 0) {
    declarations[CUSTOM_DOMAIN_DUPLICATES_KEY] = Array.from(duplicateDomains.values());
  }

  return declarations;
}

/**
 * Extract hostname -> serviceName mappings from service x-eve ingress config.
 * Duplicate hostnames are tracked for downstream validation.
 */
export function getManifestCustomDomains(manifest: Manifest): Map<string, string> {
  const declarations = getManifestCustomDomainDeclarations(manifest) as CustomDomainDeclarationsWithMeta;
  const domains = new Map<string, string>() as CustomDomainMapWithMeta;

  for (const declaration of declarations) {
    if (!domains.has(declaration.hostname)) {
      domains.set(declaration.hostname, declaration.service_name);
    }
  }

  const duplicates = declarations[CUSTOM_DOMAIN_DUPLICATES_KEY];
  if (duplicates && duplicates.length > 0) {
    domains[CUSTOM_DOMAIN_DUPLICATES_KEY] = duplicates;
  }
  return domains;
}

export function getManifestCustomDomainDesiredState(manifest: Manifest): Map<string, ManifestCustomDomainDesiredState> {
  const desired = new Map<string, ManifestCustomDomainDesiredState>();
  for (const declaration of getManifestCustomDomainDeclarations(manifest)) {
    const existing = desired.get(declaration.hostname);
    if (!existing) {
      desired.set(declaration.hostname, {
        hostname: declaration.hostname,
        service_name: declaration.service_name,
        env_names: declaration.env_name ? [declaration.env_name] : [],
        has_project_scope: declaration.scope === 'project',
        origin_paths: [declaration.origin_path],
      });
      continue;
    }

    if (declaration.env_name && !existing.env_names.includes(declaration.env_name)) {
      existing.env_names.push(declaration.env_name);
    }
    if (declaration.scope === 'project') {
      existing.has_project_scope = true;
    }
    if (!existing.origin_paths.includes(declaration.origin_path)) {
      existing.origin_paths.push(declaration.origin_path);
    }
  }
  return desired;
}

/**
 * Ensure custom domain hostnames within one manifest are unique across services.
 */
export function assertUniqueManifestCustomDomains(domains: Map<string, string>): void {
  const duplicates = (domains as CustomDomainMapWithMeta)[CUSTOM_DOMAIN_DUPLICATES_KEY] ?? [];
  if (duplicates.length > 0) {
    throw new Error(`Duplicate custom domain hostnames in manifest: ${duplicates.join(', ')}`);
  }
}

export function assertUniqueManifestCustomDomainDeclarations(declarations: ManifestCustomDomainDeclaration[]): void {
  const duplicates = (declarations as CustomDomainDeclarationsWithMeta)[CUSTOM_DOMAIN_DUPLICATES_KEY] ?? [];
  if (duplicates.length > 0) {
    throw new Error(`Duplicate custom domain hostnames in manifest: ${duplicates.join(', ')}`);
  }
}

/**
 * Check if a hostname conflicts with the platform domain (should use alias instead).
 */
export function isPlatformDomainHostname(hostname: string, platformDomain: string): boolean {
  if (!platformDomain) return false;
  const normalized = hostname.trim().toLowerCase();
  const pd = platformDomain.trim().toLowerCase();
  return normalized.endsWith(`.${pd}`) || normalized === pd;
}

export function isReservedAlias(alias: string): boolean {
  return RESERVED_ALIASES.has(alias.trim().toLowerCase());
}

export function getManifestRequiredSecrets(manifest: Manifest): string[] {
  const required = new Set<string>();
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  const manifestRequires = xEve && typeof xEve === 'object' && 'requires' in xEve
    ? (xEve as ManifestXeve).requires
    : undefined;

  for (const key of manifestRequires?.secrets ?? []) {
    if (typeof key === 'string' && key.length > 0) {
      required.add(key);
    }
  }

  const collectEnvOverrideSecrets = (envOverrides?: Record<string, string>) => {
    if (!envOverrides) return;
    const secretRefPattern = /\$\{secret\.([A-Z_][A-Z0-9_]*)\}/g;
    for (const value of Object.values(envOverrides)) {
      secretRefPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = secretRefPattern.exec(value)) !== null) {
        required.add(match[1]);
      }
    }
  };

  const collectPipelineSecrets = (pipelines?: Record<string, {
    env_overrides?: Record<string, string>;
    steps?: Array<{ requires?: { secrets?: string[] }; env_overrides?: Record<string, string> }>;
  }>) => {
    if (!pipelines) return;
    for (const pipeline of Object.values(pipelines)) {
      collectEnvOverrideSecrets(pipeline.env_overrides);
      for (const step of pipeline.steps ?? []) {
        for (const key of step.requires?.secrets ?? []) {
          if (typeof key === 'string' && key.length > 0) {
            required.add(key);
          }
        }
        collectEnvOverrideSecrets(step.env_overrides);
      }
    }
  };

  collectPipelineSecrets(manifest.pipelines);
  collectPipelineSecrets(manifest.workflows);

  return Array.from(required.values());
}

/**
 * Returns services that need container image builds.
 * A service is buildable if it has both `build` config and `image` field,
 * and is not marked as external via x-eve.
 */
export function getBuildableServices(manifest: Manifest): Record<string, Service> {
  const services = manifest.services ?? {};
  const result: Record<string, Service> = {};
  for (const [name, service] of Object.entries(services)) {
    if (!service.build || !service.image) continue;
    const xEve = service['x-eve'] ?? service.x_eve;
    if (xEve?.external) continue;
    result[name] = service;
  }
  return result;
}

/**
 * Returns services with `build` config but no `image` field.
 */
export function getServicesWithBuildButNoImage(manifest: Manifest): Record<string, Service> {
  const services = manifest.services ?? {};
  const result: Record<string, Service> = {};
  for (const [name, service] of Object.entries(services)) {
    if (!service.build || service.image) continue;
    const xEve = service['x-eve'] ?? service.x_eve;
    if (xEve?.external) continue;
    result[name] = service;
  }
  return result;
}

/**
 * Returns true if the manifest has a registry that can receive images.
 */
export function hasUsableRegistry(manifest: Manifest): boolean {
  if (isEveRegistry(manifest)) return true;
  if (isRegistryNone(manifest)) return false;
  return getRegistryConfig(manifest)?.host != null;
}

/**
 * Superset of getBuildableServices that auto-derives image names.
 * Services with `build` but no `image` get `image: <serviceName>`
 * when a usable registry is configured.
 */
export function getBuildableServicesWithDefaults(manifest: Manifest): Record<string, Service> {
  const explicit = getBuildableServices(manifest);
  if (!hasUsableRegistry(manifest)) return explicit;

  const missing = getServicesWithBuildButNoImage(manifest);
  const result = { ...explicit };
  for (const [name, service] of Object.entries(missing)) {
    result[name] = { ...service, image: name };
  }
  return result;
}

export interface ManifestRegistryConfig {
  host: string;
  namespace?: string;
  auth?: {
    username_secret?: string;
    token_secret?: string;
  };
}

/**
 * Returns true if the manifest uses Eve-native registry (`registry: "eve"`).
 */
export function isEveRegistry(manifest: Manifest): boolean {
  return manifest.registry === 'eve';
}

/**
 * Returns true if registry is explicitly set to "none" (opt-out of any registry).
 */
export function isRegistryNone(manifest: Manifest): boolean {
  return manifest.registry === 'none';
}

/**
 * Extracts and validates registry configuration from a manifest.
 * Returns null if no registry is configured or if registry is "eve" (handled separately)
 * or "none" (no registry needed).
 */
export function getRegistryConfig(manifest: Manifest): ManifestRegistryConfig | null {
  const registry = manifest.registry;
  if (!registry || typeof registry === 'string') return null;

  const registryObj = registry as Record<string, unknown>;
  const host = registryObj.host as string | undefined;
  if (!host) return null;

  const auth = registryObj.auth as Record<string, unknown> | undefined;
  return {
    host,
    namespace: registryObj.namespace as string | undefined,
    auth: auth ? {
      username_secret: auth.username_secret as string | undefined,
      token_secret: auth.token_secret as string | undefined,
    } : undefined,
  };
}

export function getManifestPacks(manifest: Manifest): z.infer<typeof PackEntrySchema>[] {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && 'packs' in xEve) {
    return (xEve as ManifestXeve).packs ?? [];
  }
  return [];
}

export function getManifestInstallAgents(manifest: Manifest): string[] {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && 'install_agents' in xEve) {
    return (xEve as ManifestXeve).install_agents ?? ['claude-code', 'codex', 'gemini-cli', 'pi'];
  }
  return ['claude-code', 'codex', 'gemini-cli', 'pi'];
}

/**
 * Returns services that are managed databases (role: managed_db).
 */
export function getManagedDbServices(manifest: Manifest): Record<string, Service> {
  const services = manifest.services ?? {};
  const result: Record<string, Service> = {};
  for (const [name, service] of Object.entries(services)) {
    const xEve = service['x-eve'] ?? service.x_eve;
    if (xEve?.role === 'managed_db') {
      result[name] = service;
    }
  }
  return result;
}

/**
 * Gets the managed DB config from a service's x-eve block.
 */
export function getManagedDbConfig(service: Service): ManagedDbConfig | null {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || xEve.role !== 'managed_db') return null;
  const managed = xEve.managed;
  if (!managed || typeof managed !== 'object') return null;
  const parsed = ManagedDbConfigSchema.safeParse(managed);
  return parsed.success ? parsed.data : null;
}

/**
 * Extract object store bucket declarations from a service's x-eve config.
 */
export function getServiceObjectStoreBuckets(service: Service): ObjectStoreBucket[] {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || typeof xEve !== 'object') return [];
  const parsed = ServiceXeveSchema.safeParse(xEve);
  if (!parsed.success) return [];
  return parsed.data.object_store?.buckets ?? [];
}

/**
 * Resolve the requested object store credential isolation for a service.
 * Missing values intentionally resolve here, not in the schema, so callers can
 * distinguish old manifests from explicit `auto` when needed.
 */
export function getServiceObjectStoreIsolation(service: Service): ObjectStoreIsolation {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || typeof xEve !== 'object') return 'auto';
  const parsed = ServiceXeveSchema.safeParse(xEve);
  if (!parsed.success) return 'auto';
  return parsed.data.object_store?.isolation ?? 'auto';
}

/**
 * Extract additional permissions declared in a service's x-eve config.
 * These are merged with the platform's read-only defaults when minting the service token.
 */
export function getServicePermissions(service: Service): string[] {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || typeof xEve !== 'object') return [];
  const parsed = ServiceXeveSchema.safeParse(xEve);
  if (!parsed.success) return [];
  return parsed.data.permissions ?? [];
}

/**
 * Resolve a service's networking config, applying defaults. Always returns a
 * concrete object so downstream code can read `.egress` without null checks.
 */
export function resolveServiceNetworking(service: Service): ServiceNetworking {
  const xEve = service['x-eve'] ?? service.x_eve;
  const raw = xEve && typeof xEve === 'object' ? (xEve as Record<string, unknown>).networking : undefined;
  const parsed = ServiceNetworkingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { egress: 'nat' };
}

/**
 * True when the service has opted into stable egress
 * (`x-eve.networking.egress: stable`).
 */
export function requiresStableEgress(service: Service): boolean {
  return resolveServiceNetworking(service).egress === 'stable';
}

export function resolveTcpIngressConfig(service: Service): TcpIngressConfig | null {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || typeof xEve !== 'object') return null;
  const raw = (xEve as Record<string, unknown>).tcp_ingress;
  if (!raw || typeof raw !== 'object') return null;
  const parsed = TcpIngressConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function requiresTcpIngress(service: Service): boolean {
  return resolveTcpIngressConfig(service) !== null;
}
