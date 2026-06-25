import type { BucketProvisioner } from '../bucket-provisioner';
import { AwsIrsaAppCredentialProvisioner } from './aws-irsa';
import { MinioStaticKeyAppCredentialProvisioner } from './minio-static-key';
import { SharedKeyAppCredentialProvisioner } from './shared-key';
import type { AppCredentialProvisioner } from './types';

export function createAppCredentialProvisioners(
  bucketProvisioner: Pick<BucketProvisioner, 'backend'>,
): AppCredentialProvisioner[] {
  return [
    new AwsIrsaAppCredentialProvisioner(),
    new MinioStaticKeyAppCredentialProvisioner(bucketProvisioner.backend),
    new SharedKeyAppCredentialProvisioner(),
  ];
}

export * from './types';
