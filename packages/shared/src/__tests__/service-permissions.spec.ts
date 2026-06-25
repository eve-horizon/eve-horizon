import { describe, it, expect } from 'vitest';
import { DEFAULT_SERVICE_PERMISSIONS, PERMISSION_SET } from '../permissions.js';
import { getServicePermissions, type Service } from '../schemas/manifest.js';

describe('DEFAULT_SERVICE_PERMISSIONS', () => {
  it('contains only read-only permissions', () => {
    for (const perm of DEFAULT_SERVICE_PERMISSIONS) {
      expect(perm).toMatch(/:read$/);
    }
  });

  it('all entries are recognised permissions', () => {
    for (const perm of DEFAULT_SERVICE_PERMISSIONS) {
      expect(PERMISSION_SET.has(perm)).toBe(true);
    }
  });
});

describe('getServicePermissions', () => {
  it('returns empty array when no x-eve block', () => {
    const service: Service = { image: 'myapp' };
    expect(getServicePermissions(service)).toEqual([]);
  });

  it('returns empty array when x-eve has no permissions', () => {
    const service: Service = {
      image: 'myapp',
      'x-eve': { role: 'service' },
    };
    expect(getServicePermissions(service)).toEqual([]);
  });

  it('returns declared permissions from x-eve', () => {
    const service: Service = {
      image: 'myapp',
      'x-eve': {
        permissions: ['jobs:write', 'events:write'],
      },
    };
    expect(getServicePermissions(service)).toEqual(['jobs:write', 'events:write']);
  });

  it('works with x_eve key variant', () => {
    const service: Service = {
      image: 'myapp',
      x_eve: {
        permissions: ['threads:write'],
      },
    };
    expect(getServicePermissions(service)).toEqual(['threads:write']);
  });
});
