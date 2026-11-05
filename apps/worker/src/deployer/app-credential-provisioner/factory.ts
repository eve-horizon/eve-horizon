import type { BucketProvisioner } from '../bucket-provisioner';
import { AwsIrsaAppCredentialProvisioner } from './aws-irsa';
import { GcpWorkloadIdentityAppCredentialProvisioner } from './gcp-workload-identity';
import { MinioStaticKeyAppCredentialProvisioner } from './minio-static-key';
import { SharedKeyAppCredentialProvisioner } from './shared-key';
import type { AppCredentialProvisioner } from './types';

export function createAppCredentialProvisioners(
  bucketProvisioner: Pick<
    BucketProvisioner,
    'backend' | 'supportsBucketIamMembers' | 'addBucketIamMember' | 'removeBucketIamMember'
  >,
): AppCredentialProvisioner[] {
  return [
    new AwsIrsaAppCredentialProvisioner(),
    new GcpWorkloadIdentityAppCredentialProvisioner(bucketProvisioner),
    new MinioStaticKeyAppCredentialProvisioner(bucketProvisioner.backend),
    new SharedKeyAppCredentialProvisioner(),
  ];
}

export * from './types';
