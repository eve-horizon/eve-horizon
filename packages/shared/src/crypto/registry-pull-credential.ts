import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Environment-bound pull credentials for the Eve-native registry.
 *
 * The deployer writes one into the `eve-registry` image pull secret of each
 * app namespace instead of the platform's internal API key. Kubelet presents
 * it as the Basic-auth password when it follows the registry's token
 * challenge. The API's token endpoint verifies the signature, then checks the
 * claims against the database: the environment must still exist, belong to
 * the project, not be terminated, and carry the same pull epoch (the deployer
 * bumps the epoch every time it rewrites the secret, so a redeploy retires the
 * previous credential).
 *
 * Format: `evepull1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`. The
 * MAC key is derived from `EVE_INTERNAL_API_KEY` with HKDF under a label used
 * nowhere else, so the credential never reveals the key, and rotating the key
 * revokes every credential at once.
 */

const PREFIX = 'evepull1';
const HKDF_INFO = 'eve-registry-pull-credential/v1';

/** Basic-auth username the deployer pairs with a pull credential. */
export const REGISTRY_PULL_USERNAME = 'eve-pull';

export interface RegistryPullCredentialClaims {
  /** Project whose repositories the holder may pull. */
  projectId: string;
  /** Environment the credential was written for. */
  environmentId: string;
  /** Namespace the credential was written to (recorded for audit). */
  namespace: string;
  /** The environment's pull epoch when the credential was minted. */
  epoch: number;
}

function macKey(internalKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', internalKey, Buffer.alloc(0), HKDF_INFO, 32));
}

function sign(body: string, internalKey: string): Buffer {
  return createHmac('sha256', macKey(internalKey)).update(body, 'utf8').digest();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function mintRegistryPullCredential(
  claims: RegistryPullCredentialClaims,
  internalKey: string | undefined,
): string {
  if (!internalKey) {
    throw new Error('EVE_INTERNAL_API_KEY is required to mint a registry pull credential');
  }
  if (
    !claims.projectId ||
    !claims.environmentId ||
    !claims.namespace ||
    !Number.isSafeInteger(claims.epoch) ||
    claims.epoch < 0
  ) {
    throw new Error('A registry pull credential needs a project, an environment, a namespace and an epoch');
  }
  const payload = Buffer.from(
    JSON.stringify({ p: claims.projectId, e: claims.environmentId, ns: claims.namespace, n: claims.epoch }),
    'utf8',
  ).toString('base64url');
  const body = `${PREFIX}.${payload}`;
  return `${body}.${sign(body, internalKey).toString('base64url')}`;
}

/**
 * Verify a pull credential's signature and shape. Returns its claims, or null
 * when the value is not a pull credential, was signed with another key, or
 * has been tampered with. The caller must still check the claims against the
 * environment (`isPullCredentialCurrent` in the API).
 */
export function verifyRegistryPullCredential(
  credential: unknown,
  internalKey: string | undefined,
): RegistryPullCredentialClaims | null {
  if (!internalKey || typeof credential !== 'string') return null;
  const parts = credential.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null;

  const expected = sign(`${parts[0]}.${parts[1]}`, internalKey);
  const presented = Buffer.from(parts[2], 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      !isNonEmptyString(claims.p) ||
      !isNonEmptyString(claims.e) ||
      !isNonEmptyString(claims.ns) ||
      typeof claims.n !== 'number' ||
      !Number.isSafeInteger(claims.n)
    ) {
      return null;
    }
    return { projectId: claims.p, environmentId: claims.e, namespace: claims.ns, epoch: claims.n };
  } catch {
    return null;
  }
}
