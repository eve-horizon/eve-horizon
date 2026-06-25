import { SharedKeyAppCredentialProvisioner } from './shared-key';
import type { AppCredentialProvisionerAvailability, AppObjectStoreCredentialMode } from './types';

export class MinioStaticKeyAppCredentialProvisioner extends SharedKeyAppCredentialProvisioner {
  readonly mode: AppObjectStoreCredentialMode = 'minio-static-key';

  constructor(private readonly backend: string) {
    super(true);
  }

  availability(): AppCredentialProvisionerAvailability {
    if (this.backend !== 'minio') {
      return { available: false, reason: 'storage backend is not minio' };
    }
    return super.availability();
  }
}
