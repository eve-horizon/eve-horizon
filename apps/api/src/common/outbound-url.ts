import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Outbound HTTP to tenant-supplied URLs: check that a URL reaches only the
 * public internet, then send to exactly the address that was checked.
 */

export class OutboundUrlError extends Error {}

export type VettedUrl = {
  url: URL;
  /** The address the request must connect to. */
  address: string;
  family: 4 | 6;
};

const NON_PUBLIC_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  NON_PUBLIC_V4.addSubnet(network, prefix, 'ipv4');
}

const NON_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const) {
  NON_PUBLIC_V6.addSubnet(network, prefix, 'ipv6');
}

const INTERNAL_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.svc', '.home.arpa'];

/** True only for a globally routable unicast address. */
export function isPublicAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const family = isIP(value);
  if (family === 4) {
    return !NON_PUBLIC_V4.check(value, 'ipv4');
  }
  if (family !== 6) {
    return false;
  }
  // Canonical form, so ::ffff:127.0.0.1 and ::ffff:7f00:1 read the same.
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return !NON_PUBLIC_V6.check(canonical, 'ipv6');
}

/** Names that only mean something inside a host, cluster or private network. */
function isInternalName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, '');
  if (!name.includes('.')) {
    // localhost, and single labels that cluster search domains would expand.
    return true;
  }
  return INTERNAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Check an http(s) URL and choose the address to connect to. Unless
 * `allowPrivate` is set, the host must be a public address or a public name
 * whose every DNS answer is a public address.
 */
export async function vetOutboundUrl(
  rawUrl: string,
  options: { allowPrivate?: boolean } = {},
): Promise<VettedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundUrlError('the URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundUrlError('the URL must use http or https');
  }

  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const literal = isIP(host);
  if (literal) {
    if (!options.allowPrivate && !isPublicAddress(host)) {
      throw new OutboundUrlError(`${host} is not a public internet address`);
    }
    return { url, address: host, family: literal === 6 ? 6 : 4 };
  }

  if (!options.allowPrivate && isInternalName(host)) {
    throw new OutboundUrlError(`${host} is not a public host name`);
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookup(host, { all: true });
  } catch {
    throw new OutboundUrlError(`${host} does not resolve`);
  }
  if (answers.length === 0) {
    throw new OutboundUrlError(`${host} does not resolve`);
  }
  if (!options.allowPrivate && answers.some((answer) => !isPublicAddress(answer.address))) {
    throw new OutboundUrlError(`${host} resolves to an address that is not on the public internet`);
  }
  return { url, address: answers[0].address, family: answers[0].family === 6 ? 6 : 4 };
}

/**
 * POST to a vetted URL. The connection goes to `target.address` only (the
 * name is still used for the Host header, TLS SNI and certificate checks),
 * and redirects are returned as-is, never followed.
 */
export function postToVettedUrl(
  target: VettedUrl,
  request: {
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    maxResponseBytes: number;
  },
): Promise<{ status: number; body: string }> {
  const { url, address, family } = target;
  const pinnedLookup = ((_hostname, lookupOptions, callback) => {
    if ((lookupOptions as { all?: boolean } | undefined)?.all) {
      (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(
        null,
        [{ address, family }],
      );
    } else {
      callback(null, address, family);
    }
  }) as LookupFunction;

  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      {
        hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...request.headers, 'Content-Length': String(Buffer.byteLength(request.body)) },
        lookup: pinnedLookup,
        signal: AbortSignal.timeout(request.timeoutMs),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        };
        res.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          const room = request.maxResponseBytes - size;
          chunks.push(buffer.subarray(0, Math.max(room, 0)));
          size += buffer.length;
          if (size >= request.maxResponseBytes) {
            finish();
            res.destroy();
          }
        });
        res.on('end', finish);
        res.on('error', (err) => (settled ? undefined : reject(err)));
      },
    );
    req.on('error', reject);
    req.end(request.body);
  });
}
