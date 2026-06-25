import type { ManagedDbTrustProvider } from '../types.js';
import { fetchPemBundle, readPemOverride } from './utils.js';

const AWS_RDS_BUNDLE_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
const AWS_RDS_OVERRIDE_PREFIX = 'EVE_MANAGED_DB_AWS_RDS_CA_BUNDLE';

export const awsRdsManagedDbTrustProvider: ManagedDbTrustProvider = {
  name: 'aws-rds',
  async getCaBundle() {
    return (await readPemOverride(AWS_RDS_OVERRIDE_PREFIX)) ?? fetchPemBundle(AWS_RDS_BUNDLE_URL);
  },
  defaultSslMode() {
    return 'verify-full';
  },
};
