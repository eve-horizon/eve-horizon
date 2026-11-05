export type AppObjectStoreCredentialMode = 'irsa' | 'shared' | 'minio-static-key' | 'gcp-workload-identity';

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

/** Name of the per-namespace Secret that carries static app bucket credentials. */
export const APP_STORAGE_CREDENTIALS_SECRET = 'eve-app-storage-credentials';

/** A plain env var, or one read from the namespace's credentials Secret. */
export type AppObjectStoreEnvVar =
  | { name: string; value: string }
  | { name: string; valueFrom: { secretKeyRef: { name: string; key: string } } };

export interface AppObjectStoreCredentialSecret {
  name: string;
  /** Written to the env namespace; pods read it through secretKeyRef. */
  stringData: Record<string, string>;
}

export interface AppObjectStoreBinding {
  mode: AppObjectStoreCredentialMode;
  envVars: AppObjectStoreEnvVar[];
  /** Static credentials to store in the namespace Secret; null for keyless modes. */
  credentialSecret?: AppObjectStoreCredentialSecret | null;
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
  /** Whether `isolation: auto` may pick this mode when it is available (default true). */
  readonly autoSelectable?: boolean;
  availability(): AppCredentialProvisionerAvailability;
  ensureForEnv(scope: AppObjectStoreScope, physicalBucketNames: string[]): Promise<AppObjectStoreBinding>;
  /**
   * For modes whose grants live on the buckets themselves: called once the
   * env's buckets exist, with the env's buckets and those it no longer declares.
   */
  grantBucketAccess?(
    scope: AppObjectStoreScope,
    physicalBucketNames: string[],
    droppedBucketNames: string[],
  ): Promise<void>;
  /** `physicalBucketNames` are the env's tracked buckets, for modes that granted on them. */
  removeForEnv(scope: AppObjectStoreScope, physicalBucketNames: string[]): Promise<void>;
}
