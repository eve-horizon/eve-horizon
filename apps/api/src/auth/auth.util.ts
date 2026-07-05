import { UnauthorizedException, type Logger } from '@nestjs/common';
import {
  createHash,
  createHmac,
  timingSafeEqual,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject,
} from 'crypto';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  loadConfig,
  ProjectAuthConfigSchema,
  ProjectBrandingSchema,
  type ProjectAuthConfig,
  type ProjectBranding,
} from '@eve/shared';

export type JwtHeader = { alg?: string; kid?: string } & Record<string, unknown>;
export type JwtPayload = {
  sub?: string;
  email?: string;
  role?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  type?: string;
} & Record<string, unknown>;

export type KeyEntry = {
  kid: string;
  publicKey: KeyObject;
  privateKey?: KeyObject;
};

/** Truncated SHA-256 of a lowercased email. Used in audit/log payloads so
 *  PII isn't broadcast at INFO level while preserving deterministic match. */
export function hashEmail(email: string): string {
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex');
  return `sha256:${digest.slice(0, 12)}`;
}

export function parseProjectBranding(logger: Logger, value: Record<string, unknown> | null): ProjectBranding | null {
  if (!value) return null;
  const parsed = ProjectBrandingSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn(`Ignoring invalid stored project branding: ${parsed.error.message}`);
    return null;
  }
  return parsed.data;
}

export function parseProjectAuthConfig(logger: Logger, value: Record<string, unknown> | null): ProjectAuthConfig | null {
  if (!value) return null;
  const parsed = ProjectAuthConfigSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn(`Ignoring invalid stored project auth config: ${parsed.error.message}`);
    return null;
  }
  return parsed.data;
}

export function loadKeyRing(config: ReturnType<typeof loadConfig>): KeyEntry[] {
  const keys: KeyEntry[] = [];
  const privateKeyPem = loadKeyValue(config.EVE_AUTH_PRIVATE_KEY);
  const publicKeyPem = loadKeyValue(config.EVE_AUTH_PUBLIC_KEY);
  const oldPublicKeyPem = loadKeyValue(config.EVE_AUTH_PUBLIC_KEY_OLD);

  if (privateKeyPem) {
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = publicKeyPem ? createPublicKey(publicKeyPem) : createPublicKey(privateKey);
    keys.push({ kid: config.EVE_AUTH_KEY_ID, privateKey, publicKey });
  } else if (publicKeyPem) {
    keys.push({ kid: config.EVE_AUTH_KEY_ID, publicKey: createPublicKey(publicKeyPem) });
  }

  if (oldPublicKeyPem) {
    keys.push({ kid: config.EVE_AUTH_KEY_ID_OLD, publicKey: createPublicKey(oldPublicKeyPem) });
  }

  return keys;
}

export function loadKeyValue(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.includes('-----BEGIN')) return value;
  if (existsSync(value)) {
    return readFileSync(value, 'utf8');
  }
  return value;
}

export function createJwtRs256(payload: Record<string, unknown>, key: KeyEntry): string {
  const header: JwtHeader = { alg: 'RS256', typ: 'JWT', kid: key.kid };
  const encodedHeader = encodeJwtSegment(header);
  const encodedPayload = encodeJwtSegment(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key.privateKey as KeyObject).toString('base64url');
  return `${signingInput}.${signature}`;
}

export function verifyJwtRs256(token: string, keys: KeyEntry[]): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedException('Invalid token format');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtSegment<JwtHeader>(encodedHeader, 'Invalid token header');
  if (header.alg !== 'RS256') {
    throw new UnauthorizedException('Unsupported token algorithm');
  }

  const candidates = header.kid
    ? keys.filter((key) => key.kid === header.kid)
    : keys;

  if (candidates.length === 0) {
    throw new UnauthorizedException('No matching key for token');
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = Buffer.from(encodedSignature, 'base64url');

  let verified = false;
  for (const candidate of candidates) {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();
    if (verifier.verify(candidate.publicKey, signature)) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    throw new UnauthorizedException('Invalid token signature');
  }

  const payload = decodeJwtSegment<JwtPayload>(encodedPayload, 'Invalid token payload');
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new UnauthorizedException('Token expired');
  }

  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw new UnauthorizedException('Token not active');
  }

  return payload;
}

export function verifyJwtHs256(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedException('Invalid token format');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtSegment<JwtHeader>(encodedHeader, 'Invalid token header');
  if (header.alg !== 'HS256') {
    throw new UnauthorizedException('Unsupported token algorithm');
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');

  if (!safeEqual(encodedSignature, expectedSignature)) {
    throw new UnauthorizedException('Invalid token signature');
  }

  const payload = decodeJwtSegment<JwtPayload>(encodedPayload, 'Invalid token payload');
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new UnauthorizedException('Token expired');
  }

  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw new UnauthorizedException('Token not active');
  }

  return payload;
}

export function encodeJwtSegment(value: Record<string, unknown>): string {
  const json = JSON.stringify(value);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeJwtSegment<T>(segment: string, errorMessage: string): T {
  try {
    return JSON.parse(base64UrlDecode(segment)) as T;
  } catch {
    throw new UnauthorizedException(errorMessage);
  }
}

/** Decode JWT payload without signature verification — used only to peek at token type. */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as JwtPayload;
  } catch {
    return null;
  }
}

export function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function fingerprintPublicKey(publicKey: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'eve-auth-'));
  const keyPath = join(tmpDir, 'key.pub');
  try {
    writeFileSync(keyPath, publicKey, { mode: 0o600 });
    const result = spawnSync('ssh-keygen', ['-lf', keyPath], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) {
      throw new Error(`ssh-keygen failed: ${result.stderr || 'unknown error'}`);
    }
    const parts = result.stdout.trim().split(' ');
    if (parts.length < 2) {
      throw new Error('Failed to parse ssh-keygen output');
    }
    return parts[1];
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function verifySshSignature(publicKey: string, nonce: string, signature: string, principal: string): boolean {
  const tmpDir = mkdtempSync(join(tmpdir(), 'eve-ssh-'));
  const allowedSignersPath = join(tmpDir, 'allowed_signers');
  const signaturePath = join(tmpDir, 'signature');

  try {
    writeFileSync(allowedSignersPath, `${principal} ${publicKey}\n`, { mode: 0o600 });
    writeFileSync(signaturePath, signature, { mode: 0o600 });

    // ssh-keygen -Y verify reads the message from stdin, not as a positional argument
    const result = spawnSync(
      'ssh-keygen',
      ['-Y', 'verify', '-f', allowedSignersPath, '-I', principal, '-n', 'eve-auth', '-s', signaturePath],
      { input: nonce, encoding: 'utf8' },
    );

    return result.status === 0;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

