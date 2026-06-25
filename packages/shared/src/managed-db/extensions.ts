export const PLAIN_EXTENSION_NAMES = [
  'postgis',
  'pgvector',
  'pg_trgm',
  'btree_gist',
  'hstore',
  'citext',
] as const;

export const PROVIDER_GATED_EXTENSION_NAMES = [
  'pg_cron',
] as const;

export const SUPPORTED_EXTENSION_NAMES = [
  ...PLAIN_EXTENSION_NAMES,
  ...PROVIDER_GATED_EXTENSION_NAMES,
] as const;

export type SupportedExtension = typeof SUPPORTED_EXTENSION_NAMES[number];
export type PlainSupportedExtension = typeof PLAIN_EXTENSION_NAMES[number];
export type ProviderGatedExtension = typeof PROVIDER_GATED_EXTENSION_NAMES[number];

export const MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS_ENV =
  'EVE_MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS';

export type SupportedExtensionDefinition =
  | {
    mode: 'plain';
    extname: string;
    installScope: 'tenant_db';
  }
  | {
    mode: 'preload';
    extname: string;
    preloadName: string;
    installScope: 'instance_admin_db';
    schema: string;
    providerHint: string;
  };

export const SUPPORTED_EXTENSIONS: Record<SupportedExtension, SupportedExtensionDefinition> = {
  postgis: { mode: 'plain', extname: 'postgis', installScope: 'tenant_db' },
  pgvector: { mode: 'plain', extname: 'vector', installScope: 'tenant_db' },
  pg_trgm: { mode: 'plain', extname: 'pg_trgm', installScope: 'tenant_db' },
  btree_gist: { mode: 'plain', extname: 'btree_gist', installScope: 'tenant_db' },
  hstore: { mode: 'plain', extname: 'hstore', installScope: 'tenant_db' },
  citext: { mode: 'plain', extname: 'citext', installScope: 'tenant_db' },
  pg_cron: {
    mode: 'preload',
    extname: 'pg_cron',
    preloadName: 'pg_cron',
    installScope: 'instance_admin_db',
    schema: 'cron',
    providerHint: 'Configure shared_preload_libraries=pg_cron on the backing instance before enabling pg_cron.',
  },
};

export const PRELOAD_EXTENSION_CANDIDATES = {
  pg_cron: {
    extname: 'pg_cron',
    preloadName: 'pg_cron',
    installScope: 'instance_admin_db',
  },
  timescaledb: {
    extname: 'timescaledb',
    preloadName: 'timescaledb',
    installScope: 'tenant_db',
    providerNote: 'not supported by AWS RDS PostgreSQL as of 2026-05-18',
  },
} as const;

const SUPPORTED_EXTENSION_SET = new Set<string>(SUPPORTED_EXTENSION_NAMES);
const PLAIN_EXTENSION_SET = new Set<string>(PLAIN_EXTENSION_NAMES);
const PROVIDER_GATED_EXTENSION_SET = new Set<string>(PROVIDER_GATED_EXTENSION_NAMES);

export function isSupportedExtensionName(name: string): name is SupportedExtension {
  return SUPPORTED_EXTENSION_SET.has(name);
}

export function isPlainExtensionName(name: string): name is PlainSupportedExtension {
  return PLAIN_EXTENSION_SET.has(name);
}

export function isProviderGatedExtensionName(name: string): name is ProviderGatedExtension {
  return PROVIDER_GATED_EXTENSION_SET.has(name);
}

export function isKnownManagedDbExtensionName(name: string): boolean {
  return isSupportedExtensionName(name) || name in PRELOAD_EXTENSION_CANDIDATES;
}

export function parseEnabledPreloadExtensions(value: string | undefined): ProviderGatedExtension[] {
  if (!value) {
    return [];
  }

  const requested = new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  if (requested.has('*')) {
    return [...PROVIDER_GATED_EXTENSION_NAMES];
  }

  return PROVIDER_GATED_EXTENSION_NAMES.filter((extension) => requested.has(extension));
}

export function getEnabledPreloadExtensions(): ProviderGatedExtension[] {
  return parseEnabledPreloadExtensions(process.env[MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS_ENV]);
}

export function isManagedDbExtensionEnabled(
  name: SupportedExtension,
  opts?: { enabledPreloadExtensions?: readonly string[] },
): boolean {
  if (isPlainExtensionName(name)) {
    return true;
  }

  const enabled = new Set(opts?.enabledPreloadExtensions ?? getEnabledPreloadExtensions());
  return enabled.has(name);
}

export function getManagedDbExtensionValidationError(
  name: string,
  opts?: { enabledPreloadExtensions?: readonly string[] },
): string | null {
  if (!isSupportedExtensionName(name)) {
    if (isKnownManagedDbExtensionName(name)) {
      return `Managed DB extension "${name}" is a preload candidate but is not supported by the current provider model`;
    }
    return `Unsupported managed DB extension "${name}". Supported extensions: ${SUPPORTED_EXTENSION_NAMES.join(', ')}`;
  }

  if (!isManagedDbExtensionEnabled(name, opts)) {
    return `Provider-gated managed DB extension "${name}" is disabled. Configure provider preload support and set ${MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS_ENV}=${name}.`;
  }

  return null;
}

export function normalizeManagedDbExtensions(
  extensions: readonly string[] | null | undefined,
  opts?: {
    enabledPreloadExtensions?: readonly string[];
    includeDisabledProviderGated?: boolean;
  },
): SupportedExtension[] {
  if (!extensions || extensions.length === 0) {
    return [];
  }

  const requested = new Set<SupportedExtension>();
  for (const extension of extensions) {
    if (!isSupportedExtensionName(extension)) {
      throw new Error(
        getManagedDbExtensionValidationError(extension, opts) ??
        `Unsupported managed DB extension: ${extension}`,
      );
    }
    if (!opts?.includeDisabledProviderGated && !isManagedDbExtensionEnabled(extension, opts)) {
      throw new Error(
        getManagedDbExtensionValidationError(extension, opts) ??
        `Disabled managed DB extension: ${extension}`,
      );
    }
    requested.add(extension);
  }

  return SUPPORTED_EXTENSION_NAMES.filter((extension) => requested.has(extension));
}

export function getSupportedExtensionDefinition(
  extension: SupportedExtension,
): SupportedExtensionDefinition {
  return SUPPORTED_EXTENSIONS[extension];
}

export function sharedPreloadLibrariesContains(setting: string | null | undefined, preloadName: string): boolean {
  return (setting ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(preloadName);
}

export function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
