import type { ManagedDbTrustProvider } from '../types.js';
import { fetchPemBundle, readPemOverride } from './utils.js';

const GCP_CLOUDSQL_BUNDLE_URL = 'https://storage.googleapis.com/cloudsql-ca-bundles/global.pem';
const GCP_CLOUDSQL_OVERRIDE_PREFIX = 'EVE_MANAGED_DB_GCP_CLOUDSQL_CA_BUNDLE';

export const gcpCloudSqlManagedDbTrustProvider: ManagedDbTrustProvider = {
  name: 'gcp-cloudsql',
  async getCaBundle() {
    return (await readPemOverride(GCP_CLOUDSQL_OVERRIDE_PREFIX)) ?? fetchPemBundle(GCP_CLOUDSQL_BUNDLE_URL);
  },
  defaultSslMode() {
    return 'verify-full';
  },
};
