import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getManagedDbTrustProvider,
  normalizeManagedDbTrustProviderName,
  resolveManagedDbDefaultSslMode,
  resolveManagedDbTrustBundle,
} from '../index.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('managed DB trust registry', () => {
  it('normalizes provider aliases and resolves default ssl modes', () => {
    expect(normalizeManagedDbTrustProviderName('aws')).toBe('aws-rds');
    expect(normalizeManagedDbTrustProviderName('gcp')).toBe('gcp-cloudsql');
    expect(normalizeManagedDbTrustProviderName('local')).toBe('local');
    expect(normalizeManagedDbTrustProviderName('unknown')).toBeNull();

    expect(resolveManagedDbDefaultSslMode('local')).toBe('disable');
    expect(resolveManagedDbDefaultSslMode('aws-rds')).toBe('verify-full');
    expect(resolveManagedDbDefaultSslMode('gcp-cloudsql')).toBe('verify-full');
    expect(resolveManagedDbDefaultSslMode('custom-provider')).toBe('require');
  });

  it('returns no trust bundle for local providers', async () => {
    const provider = getManagedDbTrustProvider('local');
    expect(provider).not.toBeNull();
    await expect(provider!.getCaBundle({ region: 'local' })).resolves.toBeNull();
    await expect(resolveManagedDbTrustBundle([{ provider: 'local', region: 'local' }])).resolves.toBeNull();
  });

  it('uses env overrides before fetching remote bundles', async () => {
    process.env.EVE_MANAGED_DB_AWS_RDS_CA_BUNDLE_PEM = '-----BEGIN CERTIFICATE-----\nAWS\n-----END CERTIFICATE-----';
    process.env.EVE_MANAGED_DB_GCP_CLOUDSQL_CA_BUNDLE_PEM = '-----BEGIN CERTIFICATE-----\nGCP\n-----END CERTIFICATE-----';

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const bundle = await resolveManagedDbTrustBundle([
      { provider: 'aws-rds', region: 'eu-west-1' },
      { provider: 'gcp-cloudsql', region: 'europe-west2' },
      { provider: 'aws', region: 'us-east-1' },
    ]);

    expect(bundle).toContain('AWS');
    expect(bundle).toContain('GCP');
    expect(bundle!.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches official bundles when no override is configured', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('-----BEGIN CERTIFICATE-----\nREMOTE\n-----END CERTIFICATE-----\n', {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const bundle = await resolveManagedDbTrustBundle([{ provider: 'aws-rds', region: 'us-east-1' }]);

    expect(bundle).toContain('REMOTE');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
      expect.objectContaining({
        headers: expect.objectContaining({
          'user-agent': 'eve-horizon/managed-db-trust',
        }),
      }),
    );
  });

  it('fails fast for unsupported providers', async () => {
    await expect(resolveManagedDbTrustBundle([{ provider: 'custom', region: 'us-east-1' }])).rejects.toThrow(
      'Unsupported managed DB trust provider "custom"',
    );
  });
});
