import * as crypto from 'crypto';
import {
  APP_STORAGE_CREDENTIALS_SECRET,
  type AppCredentialProvisioner,
  type AppCredentialProvisionerAvailability,
  type AppObjectStoreBinding,
  type AppObjectStoreCredentialMode,
  type AppObjectStoreEnvVar,
  type AppObjectStoreScope,
} from './types';

interface StaticStorageEnv {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class SharedKeyAppCredentialProvisioner implements AppCredentialProvisioner {
  readonly mode: AppObjectStoreCredentialMode = 'shared';

  constructor(private readonly forcePathStyle = false) {}

  availability(): AppCredentialProvisionerAvailability {
    const missing = this.missingVars();
    return missing.length === 0
      ? { available: true }
      : { available: false, reason: `missing ${missing.join(', ')}` };
  }

  async ensureForEnv(
    scope: AppObjectStoreScope,
    physicalBucketNames: string[],
  ): Promise<AppObjectStoreBinding> {
    const env = this.resolveEnv();
    const missing = this.missingVars(env);
    if (missing.length > 0) {
      throw new Error(`app storage env injection is incomplete. Missing: ${missing.join(', ')}.`);
    }

    // The key pair lives in a namespace Secret, not in the Deployment spec,
    // so reading Deployments does not reveal it.
    const stringData: Record<string, string> = {
      STORAGE_ACCESS_KEY_ID: env.accessKeyId,
      STORAGE_SECRET_ACCESS_KEY: env.secretAccessKey,
    };
    const envVars: AppObjectStoreEnvVar[] = [
      { name: 'STORAGE_ENDPOINT', value: env.endpoint },
      { name: 'STORAGE_REGION', value: env.region },
      ...Object.keys(stringData).map((key) => ({
        name: key,
        valueFrom: { secretKeyRef: { name: APP_STORAGE_CREDENTIALS_SECRET, key } },
      })),
    ];

    if (this.forcePathStyle) {
      envVars.push({ name: 'STORAGE_FORCE_PATH_STYLE', value: 'true' });
    }

    return {
      mode: this.mode,
      envVars,
      credentialSecret: { name: APP_STORAGE_CREDENTIALS_SECRET, stringData },
      bindingHash: this.hashBinding(scope, physicalBucketNames, envVars, stringData),
      iamRoleArn: null,
      iamRoleName: null,
      serviceAccount: null,
    };
  }

  async removeForEnv(_scope: AppObjectStoreScope): Promise<void> {
    return;
  }

  protected resolveEnv(): StaticStorageEnv {
    return {
      endpoint:
        process.env.EVE_APP_STORAGE_PUBLIC_ENDPOINT ??
        process.env.EVE_APP_STORAGE_ENDPOINT ??
        process.env.EVE_STORAGE_PUBLIC_ENDPOINT ??
        process.env.EVE_STORAGE_ENDPOINT ??
        '',
      region:
        process.env.EVE_APP_STORAGE_REGION ??
        process.env.EVE_STORAGE_REGION ??
        'us-east-1',
      accessKeyId:
        process.env.EVE_APP_STORAGE_ACCESS_KEY_ID ??
        process.env.EVE_STORAGE_ACCESS_KEY_ID ??
        '',
      secretAccessKey:
        process.env.EVE_APP_STORAGE_SECRET_ACCESS_KEY ??
        process.env.EVE_STORAGE_SECRET_ACCESS_KEY ??
        '',
    };
  }

  protected missingVars(env = this.resolveEnv()): string[] {
    const missing: string[] = [];
    if (!env.endpoint) {
      missing.push(
        'EVE_APP_STORAGE_PUBLIC_ENDPOINT or EVE_APP_STORAGE_ENDPOINT ' +
        '(or EVE_STORAGE_PUBLIC_ENDPOINT / EVE_STORAGE_ENDPOINT)',
      );
    }
    if (!env.region) missing.push('EVE_APP_STORAGE_REGION or EVE_STORAGE_REGION');
    if (!env.accessKeyId || !env.secretAccessKey) {
      missing.push(
        'EVE_APP_STORAGE_ACCESS_KEY_ID / EVE_APP_STORAGE_SECRET_ACCESS_KEY ' +
        '(or EVE_STORAGE_ACCESS_KEY_ID / EVE_STORAGE_SECRET_ACCESS_KEY for local MinIO)',
      );
    }
    return missing;
  }

  /**
   * Changes when the credentials change, so a rotated key rolls the pods
   * that read it from the Secret (secretKeyRef is resolved at container start).
   */
  protected hashBinding(
    scope: AppObjectStoreScope,
    physicalBucketNames: string[],
    envVars: AppObjectStoreEnvVar[],
    credentials: Record<string, string>,
  ): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({
        mode: this.mode,
        namespace: scope.namespace,
        buckets: [...physicalBucketNames].sort(),
        envVars: envVars.map((entry) => entry.name).sort(),
        credentials: crypto.createHash('sha256').update(JSON.stringify(credentials)).digest('hex'),
      }))
      .digest('hex')
      .slice(0, 16);
  }
}
