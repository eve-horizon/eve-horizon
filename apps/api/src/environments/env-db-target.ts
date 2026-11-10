import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { describeConnectionTarget } from '@eve/db';

const LOOPBACK = 'loopback';

/**
 * True when `candidateUrl` reaches the same Postgres database as
 * `referenceUrl`: the same database name, on a server with the same port and
 * the same host. Hosts match by name (ignoring case and a trailing dot), by
 * any address they both resolve to, or by both being loopback. Credentials
 * play no part, so another role on the same database still matches, while
 * another database on the same server does not.
 */
export async function isSameDatabase(candidateUrl: string, referenceUrl: string): Promise<boolean> {
  const candidate = describeConnectionTarget(candidateUrl);
  const reference = describeConnectionTarget(referenceUrl);

  if (!sameDatabaseName(candidate.database, reference.database)) {
    return false;
  }

  const identities = new Map<string, Promise<Set<string>>>();
  const identify = (host: string) => {
    let pending = identities.get(host);
    if (!pending) {
      pending = hostIdentities(host);
      identities.set(host, pending);
    }
    return pending;
  };

  for (const a of candidate.endpoints) {
    for (const b of reference.endpoints) {
      if (a.port !== b.port) continue;
      const [left, right] = await Promise.all([identify(a.host), identify(b.host)]);
      for (const token of left) {
        if (right.has(token)) return true;
      }
    }
  }
  return false;
}

function sameDatabaseName(a: string, b: string): boolean {
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

/** The host's normalised name plus every address it resolves to. */
async function hostIdentities(host: string): Promise<Set<string>> {
  const name = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '');
  const tokens = new Set<string>([normaliseAddress(name)]);
  if (name === 'localhost' || name.endsWith('.localhost')) {
    tokens.add(LOOPBACK);
  }
  if (isIP(name) || name.includes('/') || name.length === 0) {
    return tokens;
  }
  try {
    for (const entry of await lookup(name, { all: true })) {
      tokens.add(normaliseAddress(entry.address));
    }
  } catch {
    // An unresolvable host can only match by name.
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
