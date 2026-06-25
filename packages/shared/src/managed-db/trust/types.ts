export type ManagedDbTrustProviderName = 'local' | 'aws-rds' | 'gcp-cloudsql';

export type ManagedDbSslMode = 'disable' | 'require' | 'verify-full';

export interface ManagedDbTrustProviderInput {
  region?: string | null;
}

export interface ManagedDbTrustProvider {
  name: ManagedDbTrustProviderName;
  getCaBundle(input: ManagedDbTrustProviderInput): Promise<string | null>;
  defaultSslMode(): ManagedDbSslMode;
}

export interface ManagedDbTrustInput {
  provider?: string | null;
  region?: string | null;
}
