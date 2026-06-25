import * as crypto from 'crypto';
import type {
  AppCredentialProvisioner,
  AppCredentialProvisionerAvailability,
  AppObjectStoreBinding,
  AppObjectStoreScope,
} from './types';
import { IamAppBucketClient } from './iam-client';

const APP_SERVICE_ACCOUNT_NAME = 'eve-app';
const INLINE_POLICY_NAME = 'app-bucket-access';

export class AwsIrsaAppCredentialProvisioner implements AppCredentialProvisioner {
  readonly mode = 'irsa' as const;

  constructor(private readonly iam = new IamAppBucketClient()) {}

  availability(): AppCredentialProvisionerAvailability {
    const authMode = process.env.EVE_APP_BUCKET_AUTH_MODE?.trim().toLowerCase();
    if (authMode && !['auto', 'irsa'].includes(authMode)) {
      return {
        available: false,
        reason: authMode === 'shared'
          ? 'EVE_APP_BUCKET_AUTH_MODE=shared'
          : `unsupported EVE_APP_BUCKET_AUTH_MODE=${process.env.EVE_APP_BUCKET_AUTH_MODE}`,
      };
    }

    const missing: string[] = [];
    if (!process.env.EVE_OIDC_PROVIDER_ARN) missing.push('EVE_OIDC_PROVIDER_ARN');
    if (!process.env.EVE_OIDC_PROVIDER_URL) missing.push('EVE_OIDC_PROVIDER_URL');
    if (!this.resolveEndpoint()) {
      missing.push(
        'EVE_APP_STORAGE_PUBLIC_ENDPOINT or EVE_APP_STORAGE_ENDPOINT ' +
        '(or EVE_STORAGE_PUBLIC_ENDPOINT / EVE_STORAGE_ENDPOINT)',
      );
    }

    const prefix = this.resolveRoleNamePrefix();
    if (!prefix) {
      missing.push('EVE_APP_BUCKET_ROLE_PREFIX or EVE_STORAGE_APP_BUCKET_PREFIX');
    } else {
      try {
        this.validateRoleNamePrefix(prefix);
      } catch (error) {
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return missing.length === 0
      ? { available: true }
      : { available: false, reason: `missing ${missing.join(', ')}` };
  }

  async ensureForEnv(
    scope: AppObjectStoreScope,
    physicalBucketNames: string[],
  ): Promise<AppObjectStoreBinding> {
    const availability = this.availability();
    if (!availability.available) {
      throw new Error(`isolation mode 'irsa' not available on this cluster: ${availability.reason}`);
    }

    const roleName = this.buildRoleName(scope);
    const serviceAccount = {
      name: APP_SERVICE_ACCOUNT_NAME,
      namespace: scope.namespace,
      annotations: {} as Record<string, string>,
    };
    const oidcProviderArn = process.env.EVE_OIDC_PROVIDER_ARN!;
    const oidcIssuer = stripHttps(process.env.EVE_OIDC_PROVIDER_URL!);
    const subject = `system:serviceaccount:${scope.namespace}:${APP_SERVICE_ACCOUNT_NAME}`;
    const region = this.resolveRegion();
    const sortedBuckets = [...new Set(physicalBucketNames)].sort();

    const { roleArn } = await this.iam.ensureRole({
      roleName,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Federated: oidcProviderArn },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                [`${oidcIssuer}:aud`]: 'sts.amazonaws.com',
                [`${oidcIssuer}:sub`]: subject,
              },
            },
          },
        ],
      },
      inlinePolicyName: INLINE_POLICY_NAME,
      inlinePolicyDocument: this.buildBucketPolicy(sortedBuckets),
      tags: {
        'eve:org': scope.orgSlug,
        'eve:project': scope.projectSlug,
        'eve:env': scope.envName,
        'eve:managed-by': 'eve-worker',
      },
    });

    serviceAccount.annotations['eks.amazonaws.com/role-arn'] = roleArn;

    const bindingHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        mode: this.mode,
        roleArn,
        roleName,
        serviceAccount,
        buckets: sortedBuckets,
      }))
      .digest('hex')
      .slice(0, 16);

    return {
      mode: this.mode,
      envVars: [
        { name: 'STORAGE_ENDPOINT', value: this.resolveEndpoint() },
        { name: 'STORAGE_REGION', value: region },
        { name: 'STORAGE_AUTH_MODE', value: 'irsa' },
        { name: 'AWS_REGION', value: region },
      ],
      bindingHash,
      iamRoleArn: roleArn,
      iamRoleName: roleName,
      serviceAccount,
    };
  }

  async removeForEnv(scope: AppObjectStoreScope): Promise<void> {
    await this.iam.deleteRole(this.buildRoleName(scope));
  }

  private buildBucketPolicy(physicalBucketNames: string[]): Record<string, unknown> {
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AppBucketObjects',
          Effect: 'Allow',
          Action: [
            's3:GetObject',
            's3:PutObject',
            's3:DeleteObject',
            's3:AbortMultipartUpload',
            's3:ListMultipartUploadParts',
          ],
          Resource: physicalBucketNames.map((bucket) => `arn:aws:s3:::${bucket}/*`),
        },
        {
          Sid: 'AppBucketList',
          Effect: 'Allow',
          Action: [
            's3:ListBucket',
            's3:GetBucketLocation',
            's3:ListBucketMultipartUploads',
          ],
          Resource: physicalBucketNames.map((bucket) => `arn:aws:s3:::${bucket}`),
        },
      ],
    };
  }

  private buildRoleName(scope: AppObjectStoreScope): string {
    const prefix = this.resolveRoleNamePrefix();
    this.validateRoleNamePrefix(prefix);

    const suffix = [
      scope.orgSlug,
      scope.projectSlug,
      scope.envName,
    ].map((part) => sanitizeIamRoleSegment(part)).join('-');
    const fullName = `${prefix}-app-${suffix}`;
    if (fullName.length <= 64) {
      return fullName;
    }

    const hash = crypto
      .createHash('sha256')
      .update(`${scope.orgSlug}:${scope.projectSlug}:${scope.envName}`)
      .digest('hex')
      .slice(0, 16);
    return `${prefix}-app-${hash}`;
  }

  private resolveRoleNamePrefix(): string {
    const explicit = process.env.EVE_APP_BUCKET_ROLE_PREFIX?.trim();
    if (explicit) return explicit;

    const appBucketPrefix = process.env.EVE_STORAGE_APP_BUCKET_PREFIX?.trim();
    if (appBucketPrefix?.endsWith('-eve-app')) {
      return appBucketPrefix.slice(0, -'-eve-app'.length);
    }
    if (appBucketPrefix) return appBucketPrefix;

    return process.env.EVE_DEPLOYMENT_ID?.trim() || 'eve';
  }

  private validateRoleNamePrefix(prefix: string): void {
    if (!/^[A-Za-z0-9+=,.@_-]+$/.test(prefix)) {
      throw new Error(`invalid app bucket IAM role prefix "${prefix}"`);
    }
    if (`${prefix}-app-0000000000000000`.length > 64) {
      throw new Error(`app bucket IAM role prefix "${prefix}" is too long for hashed role names`);
    }
  }

  private resolveEndpoint(): string {
    return (
      process.env.EVE_APP_STORAGE_PUBLIC_ENDPOINT ??
      process.env.EVE_APP_STORAGE_ENDPOINT ??
      process.env.EVE_STORAGE_PUBLIC_ENDPOINT ??
      process.env.EVE_STORAGE_ENDPOINT ??
      ''
    );
  }

  private resolveRegion(): string {
    return (
      process.env.EVE_APP_STORAGE_REGION ??
      process.env.EVE_STORAGE_REGION ??
      process.env.AWS_REGION ??
      'us-east-1'
    );
  }
}

function stripHttps(value: string): string {
  return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function sanitizeIamRoleSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9+=,.@_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'env';
}
