import * as crypto from 'crypto';
import type {
  AppCredentialProvisioner,
  AppCredentialProvisionerAvailability,
  AppObjectStoreBinding,
  AppObjectStoreCredentialMode,
  AppObjectStoreScope,
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

    const envVars: Array<{ name: string; value: string }> = [
      { name: 'STORAGE_ENDPOINT', value: env.endpoint },
      { name: 'STORAGE_REGION', value: env.region },
      { name: 'STORAGE_ACCESS_KEY_ID', value: env.accessKeyId },
      { name: 'STORAGE_SECRET_ACCESS_KEY', value: env.secretAccessKey },
    ];

    if (this.forcePathStyle) {
      envVars.push({ name: 'STORAGE_FORCE_PATH_STYLE', value: 'true' });
    }

    return {
      mode: this.mode,
      envVars,
      bindingHash: this.hashBinding(scope, physicalBucketNames, envVars),
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

  protected hashBinding(
    scope: AppObjectStoreScope,
    physicalBucketNames: string[],
    envVars: Array<{ name: string; value: string }>,
  ): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({
        mode: this.mode,
        namespace: scope.namespace,
        buckets: [...physicalBucketNames].sort(),
        envVars: envVars.map((entry) => entry.name).sort(),
      }))
      .digest('hex')
      .slice(0, 16);
  }
}
