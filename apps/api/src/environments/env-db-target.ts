import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { describeConnectionTarget } from '@eve/db';

const LOOPBACK = 'loopback';

/** The platform database host is a name that does not resolve right now. */
export class PlatformHostUnresolvedError extends Error {}

export type PlatformComparison = {
  /** Same host (by name, shared address or loopback) and port as the platform database. */
  onPlatformServer: boolean;
  /** On the platform server and naming the platform's own database. */
  sameDatabase: boolean;
  /** On the platform server and logging in as the platform's own role. */
  sameUser: boolean;
};

/**
 * Compare where `candidateUrl` points with the platform database
 * (`platformUrl`). Hosts match by name (ignoring case and a trailing dot), by
 * any address they both resolve to, or by both being loopback; ports must be
 * equal. Throws PlatformHostUnresolvedError when the platform host is a name
 * that cannot be resolved, so callers refuse rather than match by name only.
 */
export async function compareWithPlatformDatabase(
  candidateUrl: string,
  platformUrl: string,
): Promise<PlatformComparison> {
  const candidate = describeConnectionTarget(candidateUrl);
  const platform = describeConnectionTarget(platformUrl);

  const platformIdentities = new Map<string, Set<string>>();
  for (const endpoint of platform.endpoints) {
    if (!platformIdentities.has(endpoint.host)) {
      platformIdentities.set(endpoint.host, await hostIdentities(endpoint.host, { required: true }));
    }
  }

  let onPlatformServer = false;
  for (const a of candidate.endpoints) {
    const matchingPorts = platform.endpoints.filter((b) => b.port === a.port);
    if (matchingPorts.length === 0) continue;
    const left = await hostIdentities(a.host, { required: false });
    if (matchingPorts.some((b) => [...left].some((token) => platformIdentities.get(b.host)!.has(token)))) {
      onPlatformServer = true;
      break;
    }
  }

  return {
    onPlatformServer,
    sameDatabase: onPlatformServer && sameName(candidate.database, platform.database),
    sameUser: onPlatformServer && sameName(candidate.user, platform.user),
  };
}

/** Case-insensitive, and a percent-encoded spelling counts as the same name. */
function sameName(a: string, b: string): boolean {
  const names = (value: string) => {
    const set = new Set([value.toLowerCase()]);
    try {
      set.add(decodeURIComponent(value).toLowerCase());
    } catch {
      // Keep the raw spelling only.
    }
    return set;
  };
  const right = names(b);
  return [...names(a)].some((name) => right.has(name));
}

/**
 * The host's normalised name plus every address it resolves to. With
 * `required`, a name that does not resolve is an error instead of matching
 * by name only.
 */
async function hostIdentities(host: string, options: { required: boolean }): Promise<Set<string>> {
  const name = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '');
  const tokens = new Set<string>([normaliseAddress(name)]);
  if (name === 'localhost' || name.endsWith('.localhost')) {
    tokens.add(LOOPBACK);
    return tokens;
  }
  if (isIP(name) || name.includes('/') || name.length === 0) {
    return tokens;
  }
  let answers: Array<{ address: string }> = [];
  try {
    answers = await lookup(name, { all: true });
  } catch {
    answers = [];
  }
  if (answers.length === 0 && options.required) {
    throw new PlatformHostUnresolvedError(`${name} did not resolve`);
  }
  // An unresolvable candidate host can only match by name.
  for (const entry of answers) {
    tokens.add(normaliseAddress(entry.address));
  }
  return tokens;
}

function normaliseAddress(value: string): string {
  let address = value.toLowerCase();
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) {
    address = address.slice(7);
  }
  if (isIP(address) === 4 && (address.startsWith('127.') || address === '0.0.0.0')) {
    return LOOPBACK;
  }
  if (address === '::1' || address === '::') {
    return LOOPBACK;
  }
  return address;
}
