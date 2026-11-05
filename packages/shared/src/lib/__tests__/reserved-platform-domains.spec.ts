import { describe, expect, it } from 'vitest';
import {
  findReservedPlatformDomain,
  getReservedPlatformDomains,
  isPlatformDomainHostname,
} from '../manifest-accessors.js';

const platform = {
  EVE_API_URL: 'http://eve-api.eve.svc.cluster.local:4701',
  EVE_PUBLIC_API_URL: 'https://api.example.com',
  EVE_SSO_URL: 'https://sso.example.com/',
  SUPABASE_AUTH_EXTERNAL_URL: 'https://auth.example.com',
  EVE_REGISTRY_HOST: 'registry.example.com',
  EVE_PLATFORM_INGRESS_HOSTNAME: 'ingress.example.com',
};

describe('getReservedPlatformDomains', () => {
  it('always reserves the platform hosts named by its URLs and hostnames', () => {
    expect(getReservedPlatformDomains(platform).sort()).toEqual([
      'api.example.com',
      'auth.example.com',
      'eve-api.eve.svc.cluster.local',
      'ingress.example.com',
      'registry.example.com',
      'sso.example.com',
    ]);
  });

  it('adds the EVE_RESERVED_DOMAINS list, normalising case, wildcards, trailing dots and blanks', () => {
    const reserved = getReservedPlatformDomains({
      EVE_RESERVED_DOMAINS: ' Example.COM., *.ops.example.net ,, ',
    });
    expect(reserved.sort()).toEqual(['example.com', 'ops.example.net']);
  });

  it('ignores unset and unparseable values', () => {
    expect(getReservedPlatformDomains({})).toEqual([]);
    expect(getReservedPlatformDomains({ EVE_REGISTRY_HOST: '  ', EVE_SSO_URL: 'http://' })).toEqual([]);
  });

  it('accepts a registry host with a port', () => {
    expect(getReservedPlatformDomains({ EVE_REGISTRY_HOST: 'registry.example.com:5000' })).toEqual([
      'registry.example.com',
    ]);
  });
});

describe('findReservedPlatformDomain', () => {
  const hostsOnly = getReservedPlatformDomains(platform);
  const withParent = getReservedPlatformDomains({ ...platform, EVE_RESERVED_DOMAINS: 'example.com' });

  it.each([
    ['api.example.com', 'api.example.com'],
    ['REGISTRY.example.com', 'registry.example.com'],
    ['sso.example.com.', 'sso.example.com'],
    ['auth.example.com', 'auth.example.com'],
    ['ingress.example.com', 'ingress.example.com'],
    ['v2.api.example.com', 'api.example.com'],
  ])('rejects the platform host %s even without EVE_RESERVED_DOMAINS', (hostname, match) => {
    expect(findReservedPlatformDomain(hostname, hostsOnly)).toBe(match);
  });

  it.each(['example.com', 'dashboard.example.com', 'anything.apps.example.com'])(
    'rejects %s once the parent domain is reserved',
    (hostname) => {
      expect(findReservedPlatformDomain(hostname, withParent)).toBe('example.com');
    },
  );

  it.each([
    'www.customer.io',
    'app.example.org',
    'myexample.com',
    'api.example.com.evil.net',
    'example.com.customer.io',
  ])('lets the external domain %s through', (hostname) => {
    expect(findReservedPlatformDomain(hostname, withParent)).toBeNull();
  });

  it('lets other hosts under the parent through while only the platform hosts are reserved', () => {
    expect(findReservedPlatformDomain('shop.example.com', hostsOnly)).toBeNull();
  });

  it('returns null for an empty hostname', () => {
    expect(findReservedPlatformDomain('  ', withParent)).toBeNull();
  });
});

describe('isPlatformDomainHostname (unchanged)', () => {
  it('matches the default app domain and its subdomains only', () => {
    expect(isPlatformDomainHostname('web.apps.example.com', 'apps.example.com')).toBe(true);
    expect(isPlatformDomainHostname('api.example.com', 'apps.example.com')).toBe(false);
  });
});
