export type AppObjectStoreCredentialMode = 'irsa' | 'shared' | 'minio-static-key' | 'gcp-workload-identity';

export interface AppObjectStoreScope {
  orgId: string;
  projectId: string;
  /** Environment ID; never reused, unlike org, project and env names. */
  envId: string;
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
  /** IAM member granted on each bucket (bucket-level modes); recorded per row so it can be revoked later. */
  bucketMember?: string | null;
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
   * env's buckets exist. Revocation is not the provisioner's job: the object
   * store provisioner revokes the member recorded on each tracked row.
   */
  grantBucketAccess?(scope: AppObjectStoreScope, physicalBucketNames: string[]): Promise<void>;
  removeForEnv(scope: AppObjectStoreScope): Promise<void>;
}
