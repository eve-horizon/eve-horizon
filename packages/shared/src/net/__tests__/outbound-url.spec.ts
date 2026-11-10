import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPublicAddress, OutboundUrlError, vetOutboundUrl } from '../outbound-url.js';

// A resolver that behaves like a pod's: a name without a trailing dot is
// tried with the cluster search path first, so a two-label name such as
// `eve-api.eve` comes back as a cluster service address. An absolute name
// (trailing dot) gets no search suffix.
const dns = vi.hoisted(() => ({
  answers: new Map<string, string[]>(),
  asked: [] as string[],
}));

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn(async (host: string, options?: { all?: boolean }) => {
    dns.asked.push(host);
    const addresses = dns.answers.get(host);
    if (!addresses) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    }
    const answers = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    return options?.all ? answers : answers[0];
  });
  return { lookup, default: { lookup } };
});

const CLUSTER_SERVICE = '34.118.224.10';
const PUBLIC = '93.184.216.34';

describe('vetOutboundUrl name resolution and cluster ranges', () => {
  beforeEach(() => {
    dns.answers.clear();
    dns.asked.length = 0;
    // Search-path expansion of a two-label name (GKE's default service range).
    dns.answers.set('eve-api.eve', [CLUSTER_SERVICE]);
    dns.answers.set('hooks.example.com', [PUBLIC]);
    dns.answers.set('hooks.example.com.', [PUBLIC]);
    dns.answers.set('gke-svc.example.com', ['34.118.230.5']);
    dns.answers.set('gke-svc.example.com.', ['34.118.230.5']);
    vi.stubEnv('EVE_CLUSTER_PRIVATE_CIDRS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const refusal = (url: string) => vetOutboundUrl(url).then(() => null, (err: unknown) => err);

  it('refuses a two-label name that only resolves through the search path', async () => {
    expect(await refusal('http://eve-api.eve/system/config')).toBeInstanceOf(OutboundUrlError);
  });

  it('resolves a public name as an absolute name', async () => {
    await expect(vetOutboundUrl('https://hooks.example.com/hook')).resolves.toMatchObject({ address: PUBLIC });
    expect(dns.asked).toEqual(['hooks.example.com.']);
  });

  it('treats addresses in EVE_CLUSTER_PRIVATE_CIDRS as private', async () => {
    vi.stubEnv('EVE_CLUSTER_PRIVATE_CIDRS', '34.118.224.0/20, 2600:1900:4000::/44');

    expect(await refusal(`http://${CLUSTER_SERVICE}/`)).toBeInstanceOf(OutboundUrlError);
    expect(await refusal('https://gke-svc.example.com/hook')).toBeInstanceOf(OutboundUrlError);
    expect(await refusal('http://[2600:1900:4001::1]/')).toBeInstanceOf(OutboundUrlError);
    expect(isPublicAddress(CLUSTER_SERVICE)).toBe(false);
    expect(isPublicAddress(`::ffff:${CLUSTER_SERVICE}`)).toBe(false);
    await expect(vetOutboundUrl('https://hooks.example.com/hook')).resolves.toMatchObject({ address: PUBLIC });
  });

  it('leaves those addresses public when the setting is empty', async () => {
    await expect(vetOutboundUrl(`http://${CLUSTER_SERVICE}/`)).resolves.toMatchObject({ address: CLUSTER_SERVICE });
  });

  it('refuses every URL when the setting has an entry it cannot read', async () => {
    vi.stubEnv('EVE_CLUSTER_PRIVATE_CIDRS', '34.118.224.0/20,not-a-range');

    expect(await refusal('https://hooks.example.com/hook')).toBeInstanceOf(OutboundUrlError);
  });
});
