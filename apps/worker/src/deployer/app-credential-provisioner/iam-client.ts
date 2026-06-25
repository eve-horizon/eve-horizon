import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  IAMClient,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  TagRoleCommand,
  UpdateAssumeRolePolicyCommand,
  type Tag,
} from '@aws-sdk/client-iam';

export interface EnsureIamRoleInput {
  roleName: string;
  assumeRolePolicyDocument: Record<string, unknown>;
  inlinePolicyName: string;
  inlinePolicyDocument: Record<string, unknown>;
  tags: Record<string, string>;
}

export class IamAppBucketClient {
  private readonly client: IAMClient;

  constructor(region = process.env.AWS_REGION ?? process.env.EVE_STORAGE_REGION ?? 'us-east-1') {
    this.client = new IAMClient({ region });
  }

  async ensureRole(input: EnsureIamRoleInput): Promise<{ roleArn: string }> {
    const assumeRolePolicyDocument = JSON.stringify(input.assumeRolePolicyDocument);
    const tags = Object.entries(input.tags).map(([Key, Value]) => ({ Key, Value })) satisfies Tag[];

    const current = await this.getRole(input.roleName);
    let roleArn = current?.Arn;

    if (current) {
      await this.client.send(new UpdateAssumeRolePolicyCommand({
        RoleName: input.roleName,
        PolicyDocument: assumeRolePolicyDocument,
      }));
      if (tags.length > 0) {
        await this.client.send(new TagRoleCommand({
          RoleName: input.roleName,
          Tags: tags,
        }));
      }
    } else {
      const created = await this.client.send(new CreateRoleCommand({
        RoleName: input.roleName,
        AssumeRolePolicyDocument: assumeRolePolicyDocument,
        Description: 'Eve app object bucket access role',
        Tags: tags,
      }));
      roleArn = created.Role?.Arn;
    }

    if (!roleArn) {
      throw new Error(`IAM role ${input.roleName} did not return an ARN`);
    }

    await this.client.send(new PutRolePolicyCommand({
      RoleName: input.roleName,
      PolicyName: input.inlinePolicyName,
      PolicyDocument: JSON.stringify(input.inlinePolicyDocument),
    }));

    return { roleArn };
  }

  async deleteRole(roleName: string): Promise<void> {
    const current = await this.getRole(roleName);
    if (!current) {
      return;
    }

    let marker: string | undefined;
    do {
      const result = await this.client.send(new ListRolePoliciesCommand({
        RoleName: roleName,
        Marker: marker,
      }));
      for (const policyName of result.PolicyNames ?? []) {
        await this.client.send(new DeleteRolePolicyCommand({
          RoleName: roleName,
          PolicyName: policyName,
        }));
      }
      marker = result.IsTruncated ? result.Marker : undefined;
    } while (marker);

    try {
      await this.client.send(new DeleteRoleCommand({ RoleName: roleName }));
    } catch (error) {
      if (!isNoSuchEntity(error)) {
        throw error;
      }
    }
  }

  private async getRole(roleName: string) {
    try {
      const result = await this.client.send(new GetRoleCommand({ RoleName: roleName }));
      return result.Role ?? null;
    } catch (error) {
      if (isNoSuchEntity(error)) {
        return null;
      }
      throw error;
    }
  }
}

function isNoSuchEntity(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name ?? '') : '';
  const code = '$metadata' in error
    ? String((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? '')
    : '';
  return name === 'NoSuchEntity' || name === 'NoSuchEntityException' || code === '404';
}
