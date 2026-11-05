import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Registry credentials for the Eve-native registry: environment-bound pull
 * credentials (below) and short-lived project push credentials (end of file).
 *
 * Pull credentials:
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
const PUSH_PREFIX = 'evepush1';
const PUSH_HKDF_INFO = 'eve-registry-push-credential/v1';

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

function macKey(internalKey: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', internalKey, Buffer.alloc(0), info, 32));
}

function sign(body: string, internalKey: string, info = HKDF_INFO): Buffer {
  return createHmac('sha256', macKey(internalKey, info)).update(body, 'utf8').digest();
}

/** Check `<prefix>.<payload>.<mac>` and return the decoded JSON payload, or null. */
function openSigned(
  credential: unknown,
  internalKey: string | undefined,
  prefix: string,
  info: string,
): Record<string, unknown> | null {
  if (!internalKey || typeof credential !== 'string') return null;
  const parts = credential.split('.');
  if (parts.length !== 3 || parts[0] !== prefix || !parts[1] || !parts[2]) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`, internalKey, info);
  const presented = Buffer.from(parts[2], 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function seal(payload: Record<string, unknown>, internalKey: string, prefix: string, info: string): string {
  const body = `${prefix}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  return `${body}.${sign(body, internalKey, info).toString('base64url')}`;
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
  return seal(
    { p: claims.projectId, e: claims.environmentId, ns: claims.namespace, n: claims.epoch },
    internalKey,
    PREFIX,
    HKDF_INFO,
  );
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
  const claims = openSigned(credential, internalKey, PREFIX, HKDF_INFO);
  if (
    !claims ||
    !isNonEmptyString(claims.p) ||
    !isNonEmptyString(claims.e) ||
    !isNonEmptyString(claims.ns) ||
    typeof claims.n !== 'number' ||
    !Number.isSafeInteger(claims.n)
  ) {
    return null;
  }
  return { projectId: claims.p, environmentId: claims.e, namespace: claims.ns, epoch: claims.n };
}

/*
 * Push credentials.
 *
 * A build gets one in place of the internal API key: BuildKit (or Kaniko)
 * presents it as the Basic-auth password, and the token endpoint grants pull
 * and push on the project's repository prefix only. It expires, so one that
 * leaks from a build (for example to a Dockerfile RUN step under Kaniko) is
 * short-lived and only reaches the project's own repositories.
 *
 * Format: `evepush1.<base64url({"p":"<project id>","exp":<unix seconds>})>.<HMAC>`,
 * under its own HKDF label, so a pull credential can never pass as one.
 */

/** Basic-auth username a build pairs with a push credential. */
export const REGISTRY_PUSH_USERNAME = 'eve-push';

/** Lifetime of a push credential: longer than any single build. */
export const REGISTRY_PUSH_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;

export interface RegistryPushCredentialClaims {
  /** Project whose repository prefix the holder may push to and pull from. */
  projectId: string;
  /** Expiry, in Unix seconds. */
  expiresAt: number;
}

export function mintRegistryPushCredential(
  projectId: string,
  internalKey: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  if (!internalKey) {
    throw new Error('EVE_INTERNAL_API_KEY is required to mint a registry push credential');
  }
  if (!projectId) {
    throw new Error('A registry push credential needs a project');
  }
  return seal(
    { p: projectId, exp: nowSeconds + REGISTRY_PUSH_CREDENTIAL_TTL_SECONDS },
    internalKey,
    PUSH_PREFIX,
    PUSH_HKDF_INFO,
  );
}

/** Verify a push credential; null when invalid, tampered with or expired. */
export function verifyRegistryPushCredential(
  credential: unknown,
  internalKey: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): RegistryPushCredentialClaims | null {
  const claims = openSigned(credential, internalKey, PUSH_PREFIX, PUSH_HKDF_INFO);
  if (
    !claims ||
    !isNonEmptyString(claims.p) ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= nowSeconds
  ) {
    return null;
  }
  return { projectId: claims.p, expiresAt: claims.exp };
}
