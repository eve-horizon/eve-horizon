import {
  Controller,
  Get,
  Post,
  Headers,
  HttpCode,
  HttpStatus,
  Body,
  Query,
  UnauthorizedException,
  ServiceUnavailableException,
  BadRequestException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  type KeyObject,
} from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { loadConfig } from '@eve/shared';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';

const TOKEN_TTL_SECONDS = 300;

interface RegistryTokenRequest {
  scope: string | string[];
  service: string;
}

interface RegistryTokenResponse {
  token: string;
  expires_in: number;
  issued_at: string;
}

interface RegistryAccessEntry {
  type: string;
  name: string;
  actions: string[];
}

/**
 * Parse a single Docker registry scope string into a structured access entry.
 *
 * Format: `repository:<name>:<actions>` where actions are comma-separated.
 * Example: `repository:org/project/service:push,pull`
 */
function parseScopeEntry(scope: string): RegistryAccessEntry {
  const parts = scope.split(':');
  if (parts.length < 3) {
    throw new BadRequestException(
      `Invalid scope format: expected "type:name:actions", got "${scope}"`,
    );
  }

  // The name component may contain colons (e.g. in nested paths), so we
  // treat everything between the first and last colon as the name.
  const type = parts[0];
  const actions = parts[parts.length - 1];
  const name = parts.slice(1, -1).join(':');

  if (!type || !name || !actions) {
    throw new BadRequestException(
      `Invalid scope format: type, name, and actions are all required`,
    );
  }

  return {
    type,
    name,
    actions: actions.split(',').filter(Boolean),
  };
}

/**
 * Parse one or more Docker registry scope strings into access entries.
 *
 * The Docker v2 token auth spec allows multiple `scope` query parameters
 * in a single request (e.g. for cross-repo blob mounts). BuildKit uses
 * this when pushing an image whose layers already exist in another repo
 * on the same registry.
 */
export function parseScopes(scope: string | string[]): RegistryAccessEntry[] {
  const entries = Array.isArray(scope) ? scope : [scope];
  return entries.map(parseScopeEntry);
}

function encodeJwtSegment(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function computeRfc7638ThumbprintFromPrivateKey(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as JsonWebKey;
  if (jwk.kty !== 'RSA' || typeof jwk.e !== 'string' || typeof jwk.n !== 'string') {
    throw new Error('Registry signing key must be RSA');
  }
  const canonical = JSON.stringify({
    e: jwk.e,
    kty: jwk.kty,
    n: jwk.n,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

function signRegistryToken(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  keyId: string,
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
  const encodedHeader = encodeJwtSegment(header);
  const encodedPayload = encodeJwtSegment(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');

  return `${signingInput}.${signature}`;
}

/**
 * Load a PEM key value that may be provided inline or as a file path.
 * Mirrors the pattern from auth.service.ts loadKeyValue().
 */
function loadKeyValue(value: string): string {
  if (value.includes('-----BEGIN')) return value;
  if (existsSync(value)) {
    return readFileSync(value, 'utf8');
  }
  return value;
}

@ApiTags('internal')
@Controller('internal/registry')
export class RegistryTokenController {
  private readonly logger = new Logger(RegistryTokenController.name);

  /**
   * POST token endpoint — used by the Eve worker (internal x-eve-internal-token header).
   */
  @Public()
  @Post('token')
  @UseGuards(InternalTokenGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a scoped registry token (internal only)' })
  async issueToken(@Body() body: RegistryTokenRequest): Promise<RegistryTokenResponse> {
    const config = loadConfig();
    return this.buildScopedToken(config, body.scope, body.service);
  }

  /**
   * GET token endpoint — Docker v2 token auth flow.
   *
   * BuildKit and docker clients follow the registry's WWW-Authenticate challenge
   * by sending a GET request with scope/service as query params and Basic auth
   * credentials from the Docker config.
   */
  @Public()
  @Get('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Docker v2 token auth (GET with Basic auth)' })
  async issueTokenGet(
    @Headers('authorization') authorization: string | undefined,
    @Query('scope') scope: string | string[] | undefined,
    @Query('service') service: string | undefined,
  ): Promise<RegistryTokenResponse> {
    const config = loadConfig();

    // Validate Basic auth — password must be the internal API key
    const password = this.extractBasicAuthPassword(authorization);
    if (!config.EVE_INTERNAL_API_KEY || password !== config.EVE_INTERNAL_API_KEY) {
      throw new UnauthorizedException('Invalid registry credentials');
    }

    return this.buildScopedToken(config, scope, service);
  }

  private extractBasicAuthPassword(
    authorization: string | undefined,
  ): string | undefined {
    if (!authorization) return undefined;
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header.toLowerCase().startsWith('basic ')) return undefined;
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colonIndex = decoded.indexOf(':');
      return colonIndex >= 0 ? decoded.slice(colonIndex + 1) : undefined;
    } catch {
      return undefined;
    }
  }

  private buildScopedToken(
    config: { EVE_REGISTRY_SIGNING_KEY?: string },
    scope: string | string[] | undefined,
    service: string | undefined,
  ): RegistryTokenResponse {
    if (!config.EVE_REGISTRY_SIGNING_KEY) {
      throw new ServiceUnavailableException(
        'Registry signing key is not configured',
      );
    }

    // Docker login sends a scopeless request just to verify credentials.
    // Return a token with empty access so `docker login` succeeds.
    const access =
      !scope || (Array.isArray(scope) && scope.length === 0)
        ? []
        : parseScopes(scope);

    const keyPem = loadKeyValue(config.EVE_REGISTRY_SIGNING_KEY);
    const privateKey = createPrivateKey(keyPem);
    const keyId = computeRfc7638ThumbprintFromPrivateKey(privateKey);

    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      sub: 'eve-worker',
      aud: 'eve-registry',
      iss: 'eve-api',
      access,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    };

    const signedToken = signRegistryToken(payload, privateKey, keyId);

    const scopeDisplay = Array.isArray(scope) ? scope.join(' ') : scope;
    this.logger.debug(
      `Issued registry token for scope="${scopeDisplay}" service="${service}" (${access.length} access entries)`,
    );

    return {
      token: signedToken,
      expires_in: TOKEN_TTL_SECONDS,
      issued_at: new Date(now * 1000).toISOString(),
    };
  }
}
