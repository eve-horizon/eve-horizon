export type AppObjectStoreCredentialMode = 'irsa' | 'shared' | 'minio-static-key';

export interface AppObjectStoreScope {
  orgId: string;
  projectId: string;
  envName: string;
  orgSlug: string;
  projectSlug: string;
  namespace: string;
}

export interface AppServiceAccountBinding {
  name: string;
  namespace: string;
  annotations: Record<string, string>;
}

export interface AppObjectStoreBinding {
  mode: AppObjectStoreCredentialMode;
  envVars: Array<{ name: string; value: string }>;
  bindingHash: string;
  iamRoleArn?: string | null;
  iamRoleName?: string | null;
  serviceAccount?: AppServiceAccountBinding | null;
}

export interface AppCredentialProvisionerAvailability {
  available: boolean;
  reason?: string;
}

export interface AppCredentialProvisioner {
  readonly mode: AppObjectStoreCredentialMode;
  availability(): AppCredentialProvisionerAvailability;
  ensureForEnv(scope: AppObjectStoreScope, physicalBucketNames: string[]): Promise<AppObjectStoreBinding>;
  removeForEnv(scope: AppObjectStoreScope): Promise<void>;
}
