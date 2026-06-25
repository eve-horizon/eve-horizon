import { awsRdsManagedDbTrustProvider } from './providers/aws-rds.js';
import { gcpCloudSqlManagedDbTrustProvider } from './providers/gcp-cloudsql.js';
import { localManagedDbTrustProvider } from './providers/local.js';
import type { ManagedDbSslMode, ManagedDbTrustInput, ManagedDbTrustProvider, ManagedDbTrustProviderName } from './types.js';

export type {
  ManagedDbSslMode,
  ManagedDbTrustInput,
  ManagedDbTrustProvider,
  ManagedDbTrustProviderInput,
  ManagedDbTrustProviderName,
} from './types.js';

const MANAGED_DB_TRUST_PROVIDERS: Record<ManagedDbTrustProviderName, ManagedDbTrustProvider> = {
  local: localManagedDbTrustProvider,
  'aws-rds': awsRdsManagedDbTrustProvider,
  'gcp-cloudsql': gcpCloudSqlManagedDbTrustProvider,
};

const MANAGED_DB_PROVIDER_ALIASES = new Map<string, ManagedDbTrustProviderName>([
  ['local', 'local'],
  ['aws', 'aws-rds'],
  ['aws-rds', 'aws-rds'],
  ['gcp', 'gcp-cloudsql'],
  ['google-cloudsql', 'gcp-cloudsql'],
  ['gcp-cloudsql', 'gcp-cloudsql'],
]);

export function normalizeManagedDbTrustProviderName(provider?: string | null): ManagedDbTrustProviderName | null {
  const normalized = (provider ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return MANAGED_DB_PROVIDER_ALIASES.get(normalized) ?? null;
}

export function getManagedDbTrustProvider(provider?: string | null): ManagedDbTrustProvider | null {
  const normalized = normalizeManagedDbTrustProviderName(provider);
  return normalized ? MANAGED_DB_TRUST_PROVIDERS[normalized] : null;
}

export function resolveManagedDbDefaultSslMode(provider?: string | null): ManagedDbSslMode {
  const trustProvider = getManagedDbTrustProvider(provider);
  return trustProvider ? trustProvider.defaultSslMode() : 'require';
}

export async function resolveManagedDbTrustBundle(inputs: ManagedDbTrustInput[]): Promise<string | null> {
  const bundles: string[] = [];
  const seenProviders = new Set<ManagedDbTrustProviderName>();

  for (const input of inputs) {
    const provider = getManagedDbTrustProvider(input.provider);
    const normalized = normalizeManagedDbTrustProviderName(input.provider);
    const original = (input.provider ?? '').trim();

    if (!provider) {
      if (original.length > 0) {
        throw new Error(`Unsupported managed DB trust provider "${original}"`);
      }
      continue;
    }

    if (seenProviders.has(provider.name)) {
      continue;
    }
    seenProviders.add(provider.name);

    const bundle = await provider.getCaBundle({ region: input.region });
    if (bundle && normalized !== 'local') {
      bundles.push(bundle);
    }
  }

  if (bundles.length === 0) {
    return null;
  }

  return `${bundles.join('\n').trim()}\n`;
}
