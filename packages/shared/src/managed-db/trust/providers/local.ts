import type { ManagedDbTrustProvider } from '../types.js';

export const localManagedDbTrustProvider: ManagedDbTrustProvider = {
  name: 'local',
  async getCaBundle() {
    return null;
  },
  defaultSslMode() {
    return 'disable';
  },
};
