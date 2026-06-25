import { Inject, Injectable, MessageEvent } from '@nestjs/common';
import type { Db } from '@eve/db';
import { orgFsSyncQueries, orgFsObjectQueries, orgQueries, orgFsIndexQueueQueries, orgFsShareQueries, orgFsPublicPathQueries, type OrgFsShareRow, type OrgFsPublicPathRow } from '@eve/db'; // orgFsIndexQueueQueries exported by parallel agent
import {
  ORG_FS_MARKDOWN_DEFAULT_EXCLUDES,
  ORG_FS_MARKDOWN_DEFAULT_INCLUDES,
  generateOrgFsConflictId,
  generateOrgFsEventId,
  generateOrgFsIndexQueueItemId,
  generateOrgFsObjectId,
  generateOrgFsShareId,
  generateOrgFsPublicPathId,
  generateOrgSyncDeviceId,
  generateOrgSyncLinkId,
  loadConfig,
  type OrgFsCreateLinkRequest,
  type OrgFsCreateLinkResponse,
  type OrgFsCreateShareRequest,
  type OrgFsDeleteLinkResponse,
  type OrgFsDownloadUrlResponse,
  type OrgFsEnrollDeviceRequest,
  type OrgFsEnrollDeviceResponse,
  type OrgFsEvent,
  type OrgFsEventListResponse,
  type OrgFsInternalHeartbeatRequest,
  type OrgFsInternalIngestEventRequest,
  type OrgFsInternalMetricsRequest,
  type OrgFsListConflictsResponse,
  type OrgFsListLinksResponse,
  type OrgFsObjectListResponse,
  type OrgFsCreatePublicPathRequest,
  type OrgFsPublicPath,
  type OrgFsPublicPathListResponse,
  type OrgFsResolveConflictRequest,
  type OrgFsResolveConflictResponse,
  type OrgFsShare,
  type OrgFsShareListResponse,
  type OrgFsStatusResponse,
  type OrgFsUpdateLinkRequest,
  type OrgFsUploadUrlResponse,
} from '@eve/shared';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { from, timer, type Observable, switchMap, concatMap, share } from 'rxjs';
import { buildApiError } from '../system/api-errors.js';
import { StorageService } from '../storage/storage.service.js';

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const STREAM_BATCH_LIMIT = 200;
const STREAM_INTERVAL_MS = 1000;
export const ORG_FS_INTERNAL_TOKEN_HEADER = 'x-eve-internal-token';

type LinkOwnerPrincipal = {
  type: 'user' | 'service_principal' | 'system';
  id: string | null;
};

type OrgFsGatewayTokenClaims = {
  v: 1;
  org_id: string;
  link_id: string;
  mode: 'two_way' | 'push_only' | 'pull_only';
  allow_prefixes: string[];
  iat: number;
  exp: number;
  jti: string;
};

@Injectable()
export class OrgFsSyncService {
  private orgs: ReturnType<typeof orgQueries>;
  private sync: ReturnType<typeof orgFsSyncQueries>;
  private fsObjects: ReturnType<typeof orgFsObjectQueries>;
  private indexQueue: ReturnType<typeof orgFsIndexQueueQueries>;
  private shares: ReturnType<typeof orgFsShareQueries>;
  private publicPaths: ReturnType<typeof orgFsPublicPathQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly storage: StorageService,
  ) {
    this.orgs = orgQueries(db);
    this.sync = orgFsSyncQueries(db);
    this.fsObjects = orgFsObjectQueries(db);
    this.indexQueue = orgFsIndexQueueQueries(db);
    this.shares = orgFsShareQueries(db);
    this.publicPaths = orgFsPublicPathQueries(db);
  }

  private async resolveOrgId(orgIdOrSlug: string): Promise<string> {
    const byId = await this.orgs.findById(orgIdOrSlug);
    if (byId) return byId.id;
    const bySlug = await this.orgs.findBySlug(orgIdOrSlug);
    if (bySlug) return bySlug.id;
    throw buildApiError(404, 'resource_not_found', `Organization ${orgIdOrSlug} not found`);
  }

  private normalizePath(path: string, requestId?: string): string {
    const value = path.trim();
    if (!value) {
      throw buildApiError(400, 'fs_path_invalid', 'Path cannot be empty', { requestId });
    }
    const normalized = value.startsWith('/') ? value : `/${value}`;
    const parts = normalized.split('/');
    if (parts.includes('..')) {
      throw buildApiError(400, 'fs_path_out_of_scope', 'Path cannot traverse outside org root', {
        requestId,
        details: { path: normalized },
      });
    }
    return normalized;
  }

  private defaultAllowPrefix(remotePath: string): string {
    if (remotePath === '/') {
      return '/**';
    }
    return `${remotePath.replace(/\/+$/, '')}/**`;
  }

  private scopePrefixBasePath(prefix: string): string {
    if (prefix === '/**') {
      return '/';
    }
    if (prefix.endsWith('/**')) {
      const base = prefix.slice(0, -3).replace(/\/+$/, '');
      return base || '/';
    }
    return prefix;
  }

  private isPathWithinRemotePath(candidatePath: string, remotePath: string): boolean {
    if (remotePath === '/') {
      return true;
    }
    const normalizedCandidate = candidatePath.replace(/\/+$/, '') || '/';
    const normalizedRemote = remotePath.replace(/\/+$/, '') || '/';
    return normalizedCandidate === normalizedRemote || normalizedCandidate.startsWith(`${normalizedRemote}/`);
  }

  private isPathAllowedByScope(pathValue: string, allowPrefixes: string[]): boolean {
    for (const prefix of allowPrefixes) {
      if (prefix === '/**') {
        return true;
      }
      if (prefix.endsWith('/**')) {
        const base = this.scopePrefixBasePath(prefix);
        if (pathValue === base || pathValue.startsWith(`${base}/`)) {
          return true;
        }
        continue;
      }
      if (pathValue === prefix) {
        return true;
      }
    }
    return false;
  }

  private normalizeAllowPrefixes(
    rawPrefixes: string[] | undefined,
    fallbackRemotePath: string,
    requestId?: string,
  ): string[] {
    const source = rawPrefixes && rawPrefixes.length > 0
      ? rawPrefixes
      : [this.defaultAllowPrefix(fallbackRemotePath)];
    const normalized = new Set<string>();
    for (const raw of source) {
      const value = raw.trim();
      if (!value) {
        throw buildApiError(400, 'fs_scope_invalid', 'Scope prefix cannot be empty', {
          requestId,
          details: { prefix: raw },
        });
      }
      const wildcard = value === '/**' || value.endsWith('/**');
      const base = wildcard ? value.replace(/\/\*\*$/, '') || '/' : value;
      const normalizedBase = this.normalizePath(base, requestId);
      if (wildcard) {
        const normalizedPrefix = normalizedBase === '/' ? '/**' : `${normalizedBase.replace(/\/+$/, '')}/**`;
        if (!this.isPathWithinRemotePath(this.scopePrefixBasePath(normalizedPrefix), fallbackRemotePath)) {
          throw buildApiError(400, 'fs_scope_out_of_root', 'Scope prefix must stay under remote_path', {
            requestId,
            details: { remote_path: fallbackRemotePath, prefix: normalizedPrefix },
          });
        }
        normalized.add(normalizedPrefix);
      } else {
        if (!this.isPathWithinRemotePath(normalizedBase, fallbackRemotePath)) {
          throw buildApiError(400, 'fs_scope_out_of_root', 'Scope prefix must stay under remote_path', {
            requestId,
            details: { remote_path: fallbackRemotePath, prefix: normalizedBase },
          });
        }
        normalized.add(normalizedBase);
      }
    }
    if (normalized.size === 0) {
      normalized.add(this.defaultAllowPrefix(fallbackRemotePath));
    }
    return [...normalized];
  }

  private normalizeLinkScope(scope: unknown, remotePath: string): { allow_prefixes: string[]; read_only_prefixes?: string[] } {
    const record = scope && typeof scope === 'object'
      ? (scope as Record<string, unknown>)
      : {};
    const rawAllow = Array.isArray(record.allow_prefixes)
      ? record.allow_prefixes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const rawReadOnly = Array.isArray(record.read_only_prefixes)
      ? record.read_only_prefixes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    return {
      allow_prefixes: rawAllow.length > 0 ? rawAllow : [this.defaultAllowPrefix(remotePath)],
      ...(rawReadOnly.length > 0 ? { read_only_prefixes: rawReadOnly } : {}),
    };
  }

  private getGatewayTokenSecret(requestId?: string): string {
    const config = loadConfig();
    const secret = config.EVE_ORG_FS_LINK_TOKEN_SECRET ?? config.EVE_INTERNAL_API_KEY;
    if (!secret) {
      throw buildApiError(
        500,
        'fs_gateway_token_secret_missing',
        'Missing EVE_ORG_FS_LINK_TOKEN_SECRET or EVE_INTERNAL_API_KEY',
        { requestId },
      );
    }
    return secret;
  }

  private encodeTokenSegment(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private decodeTokenSegment<T>(segment: string, requestId?: string): T {
    try {
      return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
    } catch {
      throw buildApiError(401, 'fs_gateway_token_invalid', 'Invalid token payload', { requestId });
    }
  }

  private signGatewayToken(claims: OrgFsGatewayTokenClaims, requestId?: string): string {
    const header = this.encodeTokenSegment({ alg: 'HS256', typ: 'EVE_FS_LINK' });
    const payload = this.encodeTokenSegment(claims);
    const signingInput = `${header}.${payload}`;
    const signature = createHmac('sha256', this.getGatewayTokenSecret(requestId))
      .update(signingInput)
      .digest('base64url');
    return `${signingInput}.${signature}`;
  }

  private verifyGatewayToken(token: string, requestId?: string): OrgFsGatewayTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw buildApiError(401, 'fs_gateway_token_invalid', 'Invalid gateway token format', { requestId });
    }
    const [headerRaw, payloadRaw, signatureRaw] = parts;
    const signingInput = `${headerRaw}.${payloadRaw}`;
    const expected = createHmac('sha256', this.getGatewayTokenSecret(requestId))
      .update(signingInput)
      .digest();
    const received = Buffer.from(signatureRaw, 'base64url');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw buildApiError(401, 'fs_gateway_token_invalid', 'Invalid gateway token signature', { requestId });
    }
    const header = this.decodeTokenSegment<Record<string, unknown>>(headerRaw, requestId);
    if (header.alg !== 'HS256') {
      throw buildApiError(401, 'fs_gateway_token_invalid', 'Unsupported gateway token algorithm', { requestId });
    }
    const payload = this.decodeTokenSegment<Record<string, unknown>>(payloadRaw, requestId);
    const mode = payload.mode;
    if (mode !== 'two_way' && mode !== 'push_only' && mode !== 'pull_only') {
      throw buildApiError(401, 'fs_gateway_token_invalid', 'Invalid gateway token mode', { requestId });
    }
    const allowPrefixes = Array.isArray(payload.allow_prefixes)
      ? payload.allow_prefixes.filter((item): item is string => typeof item === 'string')
      : [];
    if (allowPrefixes.length === 0) {
      throw buildApiError(401, 'fs_gateway_token_invalid', 'Gateway token missing allow_prefixes', { requestId });
    }
    const claims: OrgFsGatewayTokenClaims = {
      v: payload.v === 1 ? 1 : 1,
      org_id: String(payload.org_id ?? ''),
      link_id: String(payload.link_id ?? ''),
      mode,
      allow_prefixes: allowPrefixes,
      iat: Number(payload.iat ?? 0),
      exp: Number(payload.exp ?? 0),
      jti: String(payload.jti ?? ''),
    };
    if (!claims.org_id || !claims.link_id || !Number.isFinite(claims.exp)) {
      throw buildApiError(401, 'fs_gateway_token_invalid', 'Gateway token missing required claims', { requestId });
    }
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now) {
      throw buildApiError(401, 'fs_gateway_token_expired', 'Gateway token expired', { requestId });
    }
    return claims;
  }

  private issueGatewayToken(link: Awaited<ReturnType<typeof this.sync.upsertLink>>, requestId?: string): OrgFsCreateLinkResponse['runtime']['gateway'] {
    const config = loadConfig();
    const ttlSeconds = Math.max(60, config.EVE_ORG_FS_LINK_TOKEN_TTL_SECONDS);
    const now = Math.floor(Date.now() / 1000);
    const scope = this.normalizeLinkScope(link.scope_json, link.remote_path);
    const claims: OrgFsGatewayTokenClaims = {
      v: 1,
      org_id: link.org_id,
      link_id: link.id,
      mode: link.mode,
      allow_prefixes: scope.allow_prefixes,
      iat: now,
      exp: now + ttlSeconds,
      jti: randomUUID(),
    };
    return {
      token: this.signGatewayToken(claims, requestId),
      expires_at: new Date(claims.exp * 1000).toISOString(),
      header: ORG_FS_INTERNAL_TOKEN_HEADER,
      link_id: link.id,
      mode: link.mode,
      allow_prefixes: scope.allow_prefixes,
    };
  }

  private toDeviceResponse(row: Awaited<ReturnType<typeof this.sync.upsertDevice>>): OrgFsEnrollDeviceResponse['device'] {
    return {
      id: row.id,
      org_id: row.org_id,
      device_name: row.device_name,
      platform: row.platform,
      client_version: row.client_version,
      public_key: row.public_key,
      status: row.status,
      last_seen_at: row.last_seen_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  private toLinkResponse(row: Awaited<ReturnType<typeof this.sync.upsertLink>>): OrgFsCreateLinkResponse['link'] {
    const scope = this.normalizeLinkScope(row.scope_json, row.remote_path);
    return {
      id: row.id,
      org_id: row.org_id,
      device_id: row.device_id,
      owner_principal_type: row.owner_principal_type,
      owner_principal_id: row.owner_principal_id,
      mode: row.mode,
      status: row.status,
      local_path: row.local_path,
      remote_path: row.remote_path,
      scope_json: scope,
      includes: row.includes_json ?? [],
      excludes: row.excludes_json ?? [],
      last_cursor: Number(row.last_cursor ?? 0),
      lag_ms: row.lag_ms ?? null,
      backlog: row.backlog ?? 0,
      last_synced_at: row.last_synced_at?.toISOString() ?? null,
      last_heartbeat_at: row.last_heartbeat_at?.toISOString() ?? null,
      updated_at: row.updated_at.toISOString(),
      created_at: row.created_at.toISOString(),
    };
  }

  private toEventResponse(row: Awaited<ReturnType<typeof this.sync.createEvent>>, downloadUrl?: string): OrgFsEvent {
    return {
      seq: Number(row.seq),
      event_id: row.id,
      org_id: row.org_id,
      link_id: row.link_id ?? null,
      device_id: row.device_id ?? null,
      event_type: row.event_type,
      path: row.path,
      content_hash: row.content_hash ?? null,
      size_bytes: row.size_bytes ?? null,
      source_side: row.source_side,
      metadata: row.metadata ?? {},
      storage_key: row.storage_key ?? undefined,
      download_url: downloadUrl ?? undefined,
      created_at: row.created_at.toISOString(),
    };
  }

  private toConflictResponse(row: Awaited<ReturnType<typeof this.sync.createConflict>>): OrgFsResolveConflictResponse['conflict'] {
    return {
      id: row.id,
      org_id: row.org_id,
      link_id: row.link_id ?? null,
      path: row.path,
      local_hash: row.local_hash ?? null,
      remote_hash: row.remote_hash ?? null,
      status: row.status,
      resolution: row.resolution ?? null,
      resolved_by: row.resolved_by ?? null,
      resolved_at: row.resolved_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
    };
  }

  async enrollDevice(
    orgIdOrSlug: string,
    body: OrgFsEnrollDeviceRequest,
    actorId?: string,
    requestId?: string,
  ): Promise<OrgFsEnrollDeviceResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    await this.sync.deleteExpiredEnrollmentTokens(orgId);

    const publicKey = body.public_key?.trim() || `pk_${randomUUID().replace(/-/g, '')}`;
    const device = await this.sync.upsertDevice({
      id: generateOrgSyncDeviceId(),
      org_id: orgId,
      device_name: body.device_name.trim(),
      platform: body.platform?.trim() || null,
      client_version: body.client_version?.trim() || null,
      public_key: publicKey,
      created_by: actorId ?? null,
    });

    const token = `efs_enroll_${randomUUID().replace(/-/g, '')}`;
    const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
    await this.sync.createEnrollmentToken(orgId, device.id, token, expiresAt);

    const config = loadConfig();
    const apiBase = (config.EVE_PUBLIC_API_URL ?? config.EVE_API_URL).replace(/\/+$/, '');

    return {
      device: this.toDeviceResponse(device),
      enrollment: {
        token,
        expires_at: expiresAt.toISOString(),
        gateway_url: `${apiBase}/orgs/${orgId}/fs/gateway`,
      },
    };
  }

  async createLink(
    orgIdOrSlug: string,
    body: OrgFsCreateLinkRequest,
    actor: LinkOwnerPrincipal,
    actorId?: string,
    requestId?: string,
  ): Promise<OrgFsCreateLinkResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const device = await this.sync.findDeviceById(orgId, body.device_id);
    if (!device) {
      throw buildApiError(404, 'fs_device_not_found', `Device ${body.device_id} not found`, {
        requestId,
        details: { device_id: body.device_id },
      });
    }

    if (device.status !== 'active') {
      throw buildApiError(409, 'fs_device_not_found', `Device ${body.device_id} is revoked`, {
        requestId,
        details: { device_id: body.device_id, status: device.status },
      });
    }

    const remotePath = this.normalizePath(body.remote_path, requestId);
    const allowPrefixes = this.normalizeAllowPrefixes(body.allow_prefixes, remotePath, requestId);
    const link = await this.sync.upsertLink({
      id: generateOrgSyncLinkId(),
      org_id: orgId,
      device_id: body.device_id,
      owner_principal_type: actor.type,
      owner_principal_id: actor.id,
      mode: body.mode,
      status: 'active',
      local_path: body.local_path,
      remote_path: remotePath,
      scope_json: {
        allow_prefixes: allowPrefixes,
      },
      includes_json: body.includes && body.includes.length > 0
        ? body.includes
        : [...ORG_FS_MARKDOWN_DEFAULT_INCLUDES],
      excludes_json: body.excludes && body.excludes.length > 0
        ? body.excludes
        : [...ORG_FS_MARKDOWN_DEFAULT_EXCLUDES],
      created_by: actorId ?? null,
    });

    return {
      link: this.toLinkResponse(link),
      runtime: {
        sync_engine: 'syncthing',
        profile: 'markdown_default',
        gateway: this.issueGatewayToken(link, requestId),
      },
    };
  }

  async rotateLinkGatewayToken(
    orgIdOrSlug: string,
    linkId: string,
    requestId?: string,
  ): Promise<{ gateway: OrgFsCreateLinkResponse['runtime']['gateway'] }> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const link = await this.sync.findLinkById(orgId, linkId);
    if (!link) {
      throw buildApiError(404, 'fs_link_not_found', `Link ${linkId} not found`, {
        requestId,
        details: { link_id: linkId },
      });
    }
    return {
      gateway: this.issueGatewayToken(link, requestId),
    };
  }

  async authorizeInternalGatewayTokenForLink(
    orgIdOrSlug: string,
    linkId: string,
    token: string | undefined,
    requestId?: string,
  ): Promise<{ org_id: string; link_id: string; allow_prefixes: string[]; mode: 'two_way' | 'push_only' | 'pull_only' }> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    if (!token) {
      throw buildApiError(401, 'fs_gateway_token_missing', 'Missing gateway token', { requestId });
    }
    const claims = this.verifyGatewayToken(token, requestId);
    if (claims.org_id !== orgId || claims.link_id !== linkId) {
      throw buildApiError(401, 'fs_gateway_token_invalid', 'Gateway token does not match org/link target', {
        requestId,
        details: { token_org_id: claims.org_id, token_link_id: claims.link_id, org_id: orgId, link_id: linkId },
      });
    }

    const link = await this.sync.findLinkById(orgId, linkId);
    if (!link) {
      throw buildApiError(404, 'fs_link_not_found', `Link ${linkId} not found`, {
        requestId,
        details: { link_id: linkId },
      });
    }
    if (link.status === 'revoked') {
      throw buildApiError(409, 'fs_link_revoked', `Link ${linkId} is revoked`, {
        requestId,
        details: { link_id: linkId },
      });
    }

    const currentScope = this.normalizeLinkScope(link.scope_json, link.remote_path);
    return {
      org_id: orgId,
      link_id: link.id,
      allow_prefixes: currentScope.allow_prefixes,
      mode: link.mode,
    };
  }

  // Authorize a gateway token for org-level operations (no specific link required).
  // Used by upload-url endpoint where the token's link_id is trusted from the claims.
  async authorizeInternalGatewayToken(
    orgIdOrSlug: string,
    token: string | undefined,
    requestId?: string,
  ): Promise<{ org_id: string; link_id: string; allow_prefixes: string[] }> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    if (!token) {
      throw buildApiError(401, 'fs_gateway_token_missing', 'Missing gateway token', { requestId });
    }
    const claims = this.verifyGatewayToken(token, requestId);
    if (claims.org_id !== orgId) {
      throw buildApiError(401, 'fs_gateway_token_invalid', 'Gateway token does not match target org', {
        requestId,
        details: { token_org_id: claims.org_id, org_id: orgId },
      });
    }
    // Verify the link still exists and is active
    const link = await this.sync.findLinkById(orgId, claims.link_id);
    if (!link) {
      throw buildApiError(404, 'fs_link_not_found', `Link ${claims.link_id} not found`, {
        requestId,
        details: { link_id: claims.link_id },
      });
    }
    if (link.status === 'revoked') {
      throw buildApiError(409, 'fs_link_revoked', `Link ${claims.link_id} is revoked`, {
        requestId,
        details: { link_id: claims.link_id },
      });
    }
    // Mode must permit uploads (two_way or push_only)
    if (link.mode === 'pull_only') {
      throw buildApiError(403, 'fs_link_read_only', 'Link is pull-only; uploads are not permitted', {
        requestId,
        details: { link_id: claims.link_id, mode: link.mode },
      });
    }
    return {
      org_id: orgId,
      link_id: claims.link_id,
      allow_prefixes: claims.allow_prefixes,
    };
  }

  async listLinks(orgIdOrSlug: string): Promise<OrgFsListLinksResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const links = await this.sync.listLinks(orgId);
    return { data: links.map((link) => this.toLinkResponse(link)) };
  }

  async getLinkRemotePath(orgIdOrSlug: string, linkId: string): Promise<string | null> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const link = await this.sync.findLinkById(orgId, linkId);
    return link?.remote_path ?? null;
  }

  async updateLink(
    orgIdOrSlug: string,
    linkId: string,
    body: OrgFsUpdateLinkRequest,
    requestId?: string,
  ): Promise<OrgFsCreateLinkResponse['link']> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const existing = await this.sync.findLinkById(orgId, linkId);
    if (!existing) {
      throw buildApiError(404, 'fs_link_not_found', `Link ${linkId} not found`, {
        requestId,
        details: { link_id: linkId },
      });
    }

    const updated = await this.sync.updateLink(orgId, linkId, {
      mode: body.mode,
      status: body.status,
      scope_json: body.allow_prefixes
        ? {
            ...this.normalizeLinkScope(existing.scope_json, existing.remote_path),
            allow_prefixes: this.normalizeAllowPrefixes(body.allow_prefixes, existing.remote_path, requestId),
          }
        : undefined,
      includes_json: body.includes,
      excludes_json: body.excludes,
    });
    if (!updated) {
      throw buildApiError(404, 'fs_link_not_found', `Link ${linkId} not found`, {
        requestId,
        details: { link_id: linkId },
      });
    }

    if (body.status && body.status !== existing.status) {
      const eventType = body.status === 'paused'
        ? 'link.paused'
        : body.status === 'active'
          ? 'link.resumed'
          : 'link.revoked';
      await this.sync.createEvent({
        id: generateOrgFsEventId(),
        org_id: orgId,
        link_id: linkId,
        device_id: existing.device_id,
        event_type: eventType,
        path: existing.remote_path,
        source_side: 'system',
        metadata: {
          previous_status: existing.status,
          next_status: body.status,
        },
      });
    }

    return this.toLinkResponse(updated);
  }

  async deleteLink(orgIdOrSlug: string, linkId: string, requestId?: string): Promise<OrgFsDeleteLinkResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const deleted = await this.sync.deleteLink(orgId, linkId);
    if (!deleted) {
      throw buildApiError(404, 'fs_link_not_found', `Link ${linkId} not found`, {
        requestId,
        details: { link_id: linkId },
      });
    }
    return { success: true };
  }

  async getStatus(orgIdOrSlug: string): Promise<OrgFsStatusResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const [counts, latestSeq, links] = await Promise.all([
      this.sync.countLinksByStatus(orgId),
      this.sync.getLatestSeq(orgId),
      this.sync.listLinks(orgId),
    ]);

    const latestHeartbeat = links
      .map((link) => link.last_heartbeat_at?.getTime() ?? 0)
      .reduce((max, value) => Math.max(max, value), 0);
    const activeLinks = links.filter((link) => link.status === 'active').length;
    const staleMs = Date.now() - latestHeartbeat;
    const gatewayStatus = activeLinks === 0
      ? 'healthy'
      : latestHeartbeat === 0
        ? 'degraded'
        : staleMs > 120_000
          ? 'degraded'
          : 'healthy';

    return {
      org_id: orgId,
      gateway: {
        status: gatewayStatus,
        last_heartbeat_at: latestHeartbeat > 0 ? new Date(latestHeartbeat).toISOString() : null,
      },
      links: counts,
      events: {
        latest_seq: latestSeq,
      },
    };
  }

  async listEvents(orgIdOrSlug: string, afterSeq = 0, limit = 100): Promise<OrgFsEventListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    if (afterSeq < 0 || !Number.isFinite(afterSeq)) {
      throw buildApiError(400, 'fs_cursor_invalid', `Invalid after_seq value: ${afterSeq}`);
    }
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const events = await this.sync.listEvents(orgId, afterSeq, boundedLimit);
    const next = events.length > 0 ? Number(events[events.length - 1].seq) : null;
    return {
      data: events.map((event) => this.toEventResponse(event)),
      pagination: {
        limit: boundedLimit,
        next_after_seq: next,
      },
    };
  }

  streamEvents(orgIdOrSlug: string, afterSeq = 0): Observable<MessageEvent> {
    let cursor = afterSeq;
    return timer(0, STREAM_INTERVAL_MS).pipe(
      switchMap(() => from(this.listEvents(orgIdOrSlug, cursor, STREAM_BATCH_LIMIT))),
      concatMap((batch) => {
        const messages: MessageEvent[] = [];
        for (const event of batch.data) {
          cursor = event.seq;
          messages.push({
            type: 'fs_event',
            data: event,
          });
        }
        if (messages.length === 0) {
          messages.push({
            type: 'fs_checkpoint',
            data: { cursor, at: new Date().toISOString() },
          });
        }
        return from(messages);
      }),
      share(),
    );
  }

  async listConflicts(orgIdOrSlug: string, openOnly = false): Promise<OrgFsListConflictsResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const conflicts = await this.sync.listConflicts(orgId, openOnly ? 'open' : undefined);
    return { data: conflicts.map((conflict) => this.toConflictResponse(conflict)) };
  }

  async getConflictPath(orgIdOrSlug: string, conflictId: string): Promise<string | null> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const conflict = await this.sync.findConflictById(orgId, conflictId);
    return conflict?.path ?? null;
  }

  async resolveConflict(
    orgIdOrSlug: string,
    conflictId: string,
    body: OrgFsResolveConflictRequest,
    actorId?: string,
    requestId?: string,
  ): Promise<OrgFsResolveConflictResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const conflict = await this.sync.findConflictById(orgId, conflictId);
    if (!conflict) {
      throw buildApiError(404, 'fs_conflict_not_found', `Conflict ${conflictId} not found`, {
        requestId,
        details: { conflict_id: conflictId },
      });
    }

    if (body.strategy === 'manual' && !body.merged_content) {
      throw buildApiError(400, 'fs_conflict_resolution_invalid', 'manual strategy requires merged_content', {
        requestId,
        details: { conflict_id: conflictId },
      });
    }

    const updated = await this.sync.resolveConflict(orgId, conflictId, body.strategy, actorId ?? null);
    if (!updated) {
      throw buildApiError(404, 'fs_conflict_not_found', `Conflict ${conflictId} not found`, {
        requestId,
        details: { conflict_id: conflictId },
      });
    }

    await this.sync.createEvent({
      id: generateOrgFsEventId(),
      org_id: orgId,
      link_id: updated.link_id,
      event_type: 'conflict.resolved',
      path: updated.path,
      source_side: 'system',
      metadata: {
        conflict_id: updated.id,
        strategy: body.strategy,
      },
    });

    return { conflict: this.toConflictResponse(updated) };
  }

  // --- Storage helpers ---

  private requireStorageConfigured(requestId?: string): void {
    if (!this.storage.isConfigured) {
      throw buildApiError(
        503,
        'fs_storage_not_configured',
        'Object storage is not configured on this platform. Set EVE_STORAGE_BACKEND to enable.',
        { requestId },
      );
    }
  }

  private async getOrgSlug(orgId: string, requestId?: string): Promise<string> {
    const org = await this.orgs.findById(orgId);
    if (!org) {
      throw buildApiError(404, 'resource_not_found', `Organization ${orgId} not found`, { requestId });
    }
    return org.slug;
  }

  private storageKeyForPath(path: string): string {
    // path is already normalized to start with '/'; storage key is 'fs/...'
    // e.g. /docs/report.md → fs/docs/report.md
    return `fs${path}`;
  }

  private isIndexableTextFile(mimeType: string, sizeBytes: number): boolean {
    const INDEXABLE_MIME_TYPES = new Set([
      'text/markdown',
      'text/plain',
      'text/yaml',
      'application/yaml',
      'application/json',
      'text/x-yaml',
    ]);
    return sizeBytes <= 524_288 && INDEXABLE_MIME_TYPES.has(mimeType);
  }

  private async upsertFsObject(
    orgId: string,
    path: string,
    storageKey: string,
    contentHash: string,
    sizeBytes: number,
    mimeType: string,
  ): Promise<void> {
    await this.fsObjects.upsert({
      id: generateOrgFsObjectId(),
      org_id: orgId,
      path,
      storage_key: storageKey,
      content_hash: contentHash,
      size_bytes: sizeBytes,
      mime_type: mimeType,
    });
  }

  // --- Public presigned URL methods ---

  async getUploadUrl(
    orgIdOrSlug: string,
    path: string,
    linkClaims: { org_id: string; link_id: string; allow_prefixes: string[] },
    requestId?: string,
  ): Promise<OrgFsUploadUrlResponse> {
    this.requireStorageConfigured(requestId);
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const normalizedPath = this.normalizePath(path, requestId);

    // Verify the token's org matches
    if (linkClaims.org_id !== orgId) {
      throw buildApiError(403, 'fs_gateway_token_invalid', 'Gateway token org_id does not match target org', {
        requestId,
        details: { token_org_id: linkClaims.org_id, org_id: orgId },
      });
    }

    // Verify path is within token's allowed prefixes
    if (!this.isPathAllowedByScope(normalizedPath, linkClaims.allow_prefixes)) {
      throw buildApiError(403, 'fs_path_out_of_scope', 'Path is outside token scope', {
        requestId,
        details: { path: normalizedPath },
      });
    }

    const orgSlug = await this.getOrgSlug(orgId, requestId);
    const bucketName = await this.storage.ensureOrgBucket(orgSlug);

    const storageKey = this.storageKeyForPath(normalizedPath);
    const TTL_SECONDS = 300;
    const MAX_BYTES = 524288000; // 500 MB

    const uploadUrl = await this.storage.getPresignedUploadUrl(bucketName, storageKey, {
      expiresInSeconds: TTL_SECONDS,
      maxBytes: MAX_BYTES,
    });

    return {
      upload_url: uploadUrl,
      storage_key: storageKey,
      method: 'PUT',
      expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
      max_bytes: MAX_BYTES,
    };
  }

  async getDownloadUrl(
    orgIdOrSlug: string,
    path: string,
    requestId?: string,
  ): Promise<OrgFsDownloadUrlResponse> {
    this.requireStorageConfigured(requestId);
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const normalizedPath = this.normalizePath(path, requestId);

    const obj = await this.fsObjects.findByPath(orgId, normalizedPath);
    if (!obj) {
      throw buildApiError(404, 'resource_not_found', `No stored object found at path ${normalizedPath}`, {
        requestId,
        details: { path: normalizedPath },
      });
    }

    const orgSlug = await this.getOrgSlug(orgId, requestId);
    const bucketName = this.storage.getOrgBucketName(orgSlug);

    const TTL_SECONDS = 300;
    const downloadUrl = await this.storage.getPresignedDownloadUrl(bucketName, obj.storage_key, TTL_SECONDS);

    return {
      download_url: downloadUrl,
      storage_key: obj.storage_key,
      content_hash: obj.content_hash,
      size_bytes: Number(obj.size_bytes),
      mime_type: obj.mime_type,
      expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
    };
  }

  async listObjects(
    orgIdOrSlug: string,
    opts?: { prefix?: string; limit?: number; after?: string },
  ): Promise<OrgFsObjectListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const boundedLimit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const objects = await this.fsObjects.list(orgId, {
      prefix: opts?.prefix,
      limit: boundedLimit,
      after: opts?.after,
    });

    return {
      data: objects.map((obj) => ({
        id: obj.id,
        path: obj.path,
        storage_key: obj.storage_key,
        content_hash: obj.content_hash,
        size_bytes: Number(obj.size_bytes),
        mime_type: obj.mime_type,
        deleted_at: obj.deleted_at?.toISOString() ?? null,
        updated_at: obj.updated_at.toISOString(),
        created_at: obj.created_at.toISOString(),
      })),
      pagination: {
        limit: boundedLimit,
        next_after: objects.length > 0 ? objects[objects.length - 1].path : null,
      },
    };
  }

  async ingestInternalEvent(
    orgIdOrSlug: string,
    body: OrgFsInternalIngestEventRequest,
    options?: { allow_prefixes?: string[]; requestId?: string },
  ): Promise<OrgFsEvent> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const normalizedPath = this.normalizePath(body.path, options?.requestId);
    const requestedAllowPrefixes = options?.allow_prefixes ?? [];

    if (body.link_id) {
      const link = await this.sync.findLinkById(orgId, body.link_id);
      if (!link) {
        throw buildApiError(404, 'fs_link_not_found', `Link ${body.link_id} not found`, {
          requestId: options?.requestId,
          details: { link_id: body.link_id },
        });
      }
      const linkScope = this.normalizeLinkScope(link.scope_json, link.remote_path);
      if (!this.isPathAllowedByScope(normalizedPath, linkScope.allow_prefixes)) {
        throw buildApiError(403, 'fs_path_out_of_scope', 'Path is outside link scope', {
          requestId: options?.requestId,
          details: { path: normalizedPath, link_id: body.link_id },
        });
      }
    }

    if (requestedAllowPrefixes.length > 0 && !this.isPathAllowedByScope(normalizedPath, requestedAllowPrefixes)) {
      throw buildApiError(403, 'fs_path_out_of_scope', 'Path is outside token scope', {
        requestId: options?.requestId,
        details: { path: normalizedPath },
      });
    }

    const event = await this.sync.createEvent({
      id: body.event_id || generateOrgFsEventId(),
      org_id: orgId,
      link_id: body.link_id ?? null,
      device_id: body.device_id ?? null,
      event_type: body.event_type,
      path: normalizedPath,
      content_hash: body.content_hash ?? null,
      size_bytes: body.size_bytes ?? null,
      source_side: body.source_side,
      metadata: body.metadata ?? {},
      storage_key: body.storage_key ?? null,
    });

    if (body.event_type === 'conflict.detected') {
      await this.sync.createConflict({
        id: generateOrgFsConflictId(),
        org_id: orgId,
        link_id: body.link_id ?? null,
        path: normalizedPath,
        local_hash: typeof body.metadata?.local_hash === 'string' ? body.metadata.local_hash : null,
        remote_hash: typeof body.metadata?.remote_hash === 'string' ? body.metadata.remote_hash : null,
      });
    }

    // Upsert org_fs_objects and generate a download URL for file create/update events
    let downloadUrl: string | undefined;
    if (body.storage_key && (body.event_type === 'file.created' || body.event_type === 'file.updated')) {
      const mimeType = body.mime_type ?? 'application/octet-stream';
      const sizeBytes = body.size_bytes ?? 0;

      await this.upsertFsObject(
        orgId,
        normalizedPath,
        body.storage_key,
        body.content_hash ?? '',
        sizeBytes,
        mimeType,
      );

      // Enqueue for document indexing if the file is a small, indexable text type
      if (this.isIndexableTextFile(mimeType, sizeBytes)) {
        try {
          await this.indexQueue.enqueue({
            id: generateOrgFsIndexQueueItemId(),
            org_id: orgId,
            path: normalizedPath,
            storage_key: body.storage_key,
            content_hash: body.content_hash ?? '',
            mime_type: mimeType,
          });
        } catch {
          // Non-fatal: indexing is best-effort and the processor will retry
        }
      }

      if (this.storage.isConfigured) {
        try {
          const orgSlug = await this.getOrgSlug(orgId, options?.requestId);
          const bucketName = this.storage.getOrgBucketName(orgSlug);
          downloadUrl = await this.storage.getPresignedDownloadUrl(bucketName, body.storage_key, 300);
        } catch {
          // Non-fatal: download_url is best-effort in the ingest response
        }
      }
    }

    return this.toEventResponse(event, downloadUrl);
  }

  async updateInternalHeartbeat(
    orgIdOrSlug: string,
    linkId: string,
    body: OrgFsInternalHeartbeatRequest,
    requestId?: string,
  ): Promise<OrgFsCreateLinkResponse['link']> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const updated = await this.sync.updateLinkHeartbeat(orgId, linkId, {
      cursor: body.cursor,
      backlog: body.backlog,
      lag_ms: body.lag_ms,
    });
    if (!updated) {
      throw buildApiError(404, 'fs_link_not_found', `Link ${linkId} not found`, {
        requestId,
        details: { link_id: linkId },
      });
    }
    return this.toLinkResponse(updated);
  }

  async updateInternalMetrics(
    orgIdOrSlug: string,
    linkId: string,
    body: OrgFsInternalMetricsRequest,
    requestId?: string,
  ): Promise<OrgFsCreateLinkResponse['link']> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const updated = await this.sync.updateLinkMetrics(orgId, linkId, body.metrics);
    if (!updated) {
      throw buildApiError(404, 'fs_link_not_found', `Link ${linkId} not found`, {
        requestId,
        details: { link_id: linkId },
      });
    }
    return this.toLinkResponse(updated);
  }

  // --- Share tokens ---

  private parseExpiry(expiresIn: string | undefined): Date | null {
    if (!expiresIn) return null;
    const match = /^(\d+)([smhd])$/.exec(expiresIn.trim().toLowerCase());
    if (!match) {
      throw buildApiError(400, 'invalid_expires_in', `Invalid expires_in value: ${expiresIn}. Use e.g. '7d', '24h', '30m', '3600s'`);
    }
    const n = parseInt(match[1], 10);
    const unit = match[2];
    const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
    return new Date(Date.now() + n * ms);
  }

  private sharePublicUrl(orgSlug: string, path: string, token: string): string {
    const config = loadConfig();
    const apiBase = (config.EVE_PUBLIC_API_URL ?? config.EVE_API_URL).replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    return `${apiBase}/orgs/${orgSlug}/fs/public/${normalizedPath}?token=${token}`;
  }

  private toShareResponse(row: OrgFsShareRow, orgSlug: string): OrgFsShare {
    return {
      id: row.id,
      org_id: row.org_id,
      path: row.path,
      label: row.label,
      url: this.sharePublicUrl(orgSlug, row.path, row.id),
      created_by: row.created_by,
      expires_at: row.expires_at?.toISOString() ?? null,
      accessed_at: row.accessed_at?.toISOString() ?? null,
      access_count: row.access_count,
      revoked_at: row.revoked_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
    };
  }

  async createShare(
    orgIdOrSlug: string,
    body: OrgFsCreateShareRequest,
    actorId: string,
    requestId?: string,
  ): Promise<OrgFsShare> {
    this.requireStorageConfigured(requestId);
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const normalizedPath = this.normalizePath(body.path, requestId);

    // Verify the object exists
    const obj = await this.fsObjects.findByPath(orgId, normalizedPath);
    if (!obj) {
      throw buildApiError(404, 'resource_not_found', `No stored object found at path ${normalizedPath}`, {
        requestId,
        details: { path: normalizedPath },
      });
    }

    const orgSlug = await this.getOrgSlug(orgId, requestId);
    const expiresAt = this.parseExpiry(body.expires_in);

    const row = await this.shares.insert({
      id: generateOrgFsShareId(),
      org_id: orgId,
      path: normalizedPath,
      label: body.label ?? null,
      created_by: actorId,
      expires_at: expiresAt,
    });

    return this.toShareResponse(row, orgSlug);
  }

  async listShares(orgIdOrSlug: string): Promise<OrgFsShareListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const orgSlug = await this.getOrgSlug(orgId);
    const rows = await this.shares.listActive(orgId);
    return { data: rows.map((r) => this.toShareResponse(r, orgSlug)) };
  }

  async revokeShare(orgIdOrSlug: string, token: string, requestId?: string): Promise<OrgFsShare> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const orgSlug = await this.getOrgSlug(orgId, requestId);
    const row = await this.shares.revoke(token, orgId);
    if (!row) {
      throw buildApiError(404, 'resource_not_found', `Share token ${token} not found or already revoked`, {
        requestId,
        details: { token },
      });
    }
    return this.toShareResponse(row, orgSlug);
  }

  /**
   * Resolve a share token to a presigned download URL.
   * Returns the presigned URL or throws (403/404) on invalid/expired/revoked token.
   */
  async resolveShare(
    orgIdOrSlug: string,
    path: string,
    token: string,
    requestId?: string,
  ): Promise<string> {
    this.requireStorageConfigured(requestId);
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const normalizedPath = this.normalizePath(path, requestId);

    const share = await this.shares.findById(token);
    if (!share || share.org_id !== orgId) {
      throw buildApiError(404, 'resource_not_found', 'Share token not found', { requestId });
    }
    if (share.revoked_at) {
      throw buildApiError(403, 'share_revoked', 'This share link has been revoked', { requestId });
    }
    if (share.expires_at && share.expires_at < new Date()) {
      throw buildApiError(403, 'share_expired', 'This share link has expired', { requestId });
    }
    if (share.path !== normalizedPath) {
      throw buildApiError(403, 'share_path_mismatch', 'Token does not match requested path', { requestId });
    }

    const obj = await this.fsObjects.findByPath(orgId, normalizedPath);
    if (!obj) {
      throw buildApiError(404, 'resource_not_found', `Object not found at path ${normalizedPath}`, { requestId });
    }

    const orgSlug = await this.getOrgSlug(orgId, requestId);
    const bucketName = this.storage.getOrgBucketName(orgSlug);
    const downloadUrl = await this.storage.getPresignedDownloadUrl(bucketName, obj.storage_key, 300);

    // Fire-and-forget access logging
    void this.shares.recordAccess(token);

    return downloadUrl;
  }

  // --- Public paths ---

  private toPublicPathResponse(row: OrgFsPublicPathRow): OrgFsPublicPath {
    return {
      id: row.id,
      org_id: row.org_id,
      path_prefix: row.path_prefix,
      label: row.label,
      created_by: row.created_by,
      created_at: row.created_at.toISOString(),
    };
  }

  async createPublicPath(
    orgIdOrSlug: string,
    body: OrgFsCreatePublicPathRequest,
    actorId: string,
    requestId?: string,
  ): Promise<OrgFsPublicPath> {
    this.requireStorageConfigured(requestId);
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const prefix = body.path_prefix.startsWith('/') ? body.path_prefix : `/${body.path_prefix}`;
    const row = await this.publicPaths.insert({
      id: generateOrgFsPublicPathId(),
      org_id: orgId,
      path_prefix: prefix,
      label: body.label ?? null,
      created_by: actorId,
    });
    return this.toPublicPathResponse(row);
  }

  async listPublicPaths(orgIdOrSlug: string): Promise<OrgFsPublicPathListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const rows = await this.publicPaths.listByOrg(orgId);
    return { data: rows.map((r) => this.toPublicPathResponse(r)) };
  }

  async deletePublicPath(orgIdOrSlug: string, id: string, requestId?: string): Promise<void> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const deleted = await this.publicPaths.deleteById(id, orgId);
    if (!deleted) {
      throw buildApiError(404, 'resource_not_found', `Public path ${id} not found`, { requestId, details: { id } });
    }
  }

  /**
   * Resolve a public path (no token required) to a presigned download URL.
   * Returns the presigned URL or throws 403 if path is not under any public prefix.
   */
  async resolvePublicPath(
    orgIdOrSlug: string,
    path: string,
    requestId?: string,
  ): Promise<string> {
    this.requireStorageConfigured(requestId);
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const normalizedPath = this.normalizePath(path, requestId);

    const publicPath = await this.publicPaths.resolveForPath(orgId, normalizedPath);
    if (!publicPath) {
      throw buildApiError(403, 'path_not_public', 'This path is not publicly accessible', { requestId });
    }

    const obj = await this.fsObjects.findByPath(orgId, normalizedPath);
    if (!obj) {
      throw buildApiError(404, 'resource_not_found', `Object not found at path ${normalizedPath}`, { requestId });
    }

    const orgSlug = await this.getOrgSlug(orgId, requestId);
    const bucketName = this.storage.getOrgBucketName(orgSlug);
    return this.storage.getPresignedDownloadUrl(bucketName, obj.storage_key, 300);
  }
}
