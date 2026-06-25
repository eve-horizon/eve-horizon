import { Inject, Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import type { Db } from '@eve/db';
import { integrationQueries, externalIdentityQueries, membershipRequestQueries, userQueries, membershipQueries, oauthAppConfigQueries } from '@eve/db';
import type { OAuthAppConfig } from '@eve/db';
import {
  generateIntegrationId,
  generateExternalIdentityId,
  generateMembershipRequestId,
  generateUserId,
  generateOAuthAppConfigId,
  loadConfig,
  createJsonLogger,
  type IntegrationResponse,
  type SlackConnectRequest,
  type MembershipRequestResponse,
  type OAuthAppConfigResponse,
  type CreateOAuthAppConfigRequest,
  type ProviderSetupInfoResponse,
} from '@eve/shared';

const logger = createJsonLogger('api');

@Injectable()
export class IntegrationsService {
  private integrations: ReturnType<typeof integrationQueries>;
  private externalIdentities: ReturnType<typeof externalIdentityQueries>;
  private membershipRequests: ReturnType<typeof membershipRequestQueries>;
  private users: ReturnType<typeof userQueries>;
  private memberships: ReturnType<typeof membershipQueries>;
  private oauthAppConfigs: ReturnType<typeof oauthAppConfigQueries>;

  /** Track redeemed link token JTIs (in-memory, sufficient for pre-MVP). */
  private redeemedJtis = new Set<string>();

  /** OAuth state tokens: state → { orgId, expiresAt } */
  private oauthStates = new Map<string, { orgId: string; expiresAt: number }>();

  constructor(@Inject('DB') private readonly db: Db) {
    this.integrations = integrationQueries(db);
    this.externalIdentities = externalIdentityQueries(db);
    this.membershipRequests = membershipRequestQueries(db);
    this.users = userQueries(db);
    this.memberships = membershipQueries(db);
    this.oauthAppConfigs = oauthAppConfigQueries(db);
  }

  // ---------------------------------------------------------------------------
  // Integration CRUD
  // ---------------------------------------------------------------------------

  async listByOrg(orgId: string): Promise<IntegrationResponse[]> {
    const rows = await this.integrations.listByOrg(orgId);
    return rows.map((row: {
      id: string;
      org_id: string;
      provider: string;
      account_id: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }) => this.toResponse(row));
  }

  async connectSlack(orgId: string, payload: SlackConnectRequest): Promise<IntegrationResponse> {
    const existing = await this.integrations.findByProviderAccount('slack', payload.team_id);
    if (existing) {
      if (existing.org_id !== orgId) {
        throw new NotFoundException('Slack integration belongs to a different org');
      }
      const nextTokens = payload.tokens_json === undefined ? existing.tokens_json : payload.tokens_json ?? null;
      const updated = await this.integrations.updateTokens(
        existing.id,
        nextTokens ?? null,
        payload.status ?? existing.status,
      );
      return this.toResponse(updated ?? existing);
    }

    const created = await this.integrations.insert({
      id: generateIntegrationId(),
      org_id: orgId,
      provider: 'slack',
      account_id: payload.team_id,
      tokens_json: payload.tokens_json ?? null,
      settings_json: {},
      status: payload.status ?? 'active',
    });

    return this.toResponse(created);
  }

  async connectProvider(
    orgId: string,
    provider: string,
    accountId: string,
    tokensJson: Record<string, unknown> | null,
    status: string = 'active',
  ): Promise<IntegrationResponse> {
    const existing = await this.integrations.findByProviderAccount(provider, accountId);
    if (existing) {
      if (existing.org_id !== orgId) {
        throw new NotFoundException(`${provider} integration belongs to a different org`);
      }
      const updated = await this.integrations.updateTokens(
        existing.id,
        tokensJson ?? existing.tokens_json ?? null,
        status,
      );
      return this.toResponse(updated ?? existing);
    }

    const created = await this.integrations.insert({
      id: generateIntegrationId(),
      org_id: orgId,
      provider,
      account_id: accountId,
      tokens_json: tokensJson,
      settings_json: {},
      status,
    });

    return this.toResponse(created);
  }

  async testIntegration(id: string, orgId: string): Promise<{ ok: boolean; detail?: string }> {
    const existing = await this.integrations.findById(id);
    if (!existing) {
      throw new NotFoundException(`Integration ${id} not found`);
    }
    if (existing.org_id !== orgId) {
      throw new NotFoundException(`Integration ${id} not found in org ${orgId}`);
    }

    // For Slack: verify the bot token is active via auth.test
    if (existing.provider === 'slack' && existing.tokens_json) {
      const tokens = existing.tokens_json as Record<string, unknown>;
      const token = (typeof tokens.access_token === 'string' && tokens.access_token)
        || (typeof tokens.bot_token === 'string' && tokens.bot_token);
      if (token) {
        try {
          const resp = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          });
          const data = await resp.json() as { ok?: boolean; error?: string; team?: string; user?: string };
          if (!data.ok) {
            return { ok: false, detail: `Slack auth.test failed: ${data.error ?? 'unknown'}` };
          }
          return { ok: true, detail: `Slack token active (team: ${data.team ?? 'unknown'})` };
        } catch (err) {
          return { ok: false, detail: `Slack auth.test error: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      return { ok: false, detail: 'No bot token found in integration tokens' };
    }

    return { ok: true };
  }

  async listActiveIntegrations(): Promise<Array<{
    id: string; org_id: string; provider: string;
    account_id: string; tokens_json: Record<string, unknown> | null;
    settings_json: Record<string, unknown>; status: string;
  }>> {
    const rows = await this.db<Array<{
      id: string; org_id: string; provider: string;
      account_id: string; tokens_json: Record<string, unknown> | null;
      settings_json: Record<string, unknown>; status: string;
    }>>`SELECT id, org_id, provider, account_id, tokens_json, settings_json, status FROM integrations WHERE status = 'active'`;

    // Enrich Slack integrations with the per-org signing secret from oauth_app_configs
    for (const row of rows) {
      if (row.provider === 'slack') {
        const appConfig = await this.oauthAppConfigs.findByOrgAndProvider(row.org_id, 'slack');
        if (appConfig?.config_json && (appConfig.config_json as Record<string, unknown>).signing_secret) {
          row.settings_json = {
            ...row.settings_json,
            signing_secret: (appConfig.config_json as Record<string, unknown>).signing_secret,
          };
        }
      }
    }

    return rows;
  }

  async resolveIntegration(provider: string, accountId: string): Promise<{ integration_id: string; org_id: string }> {
    const integration = await this.integrations.findByProviderAccount(provider, accountId);
    if (!integration) {
      throw new NotFoundException(`Integration not found for ${provider}:${accountId}`);
    }
    return { integration_id: integration.id, org_id: integration.org_id };
  }

  async getIntegrationTokens(integrationId: string): Promise<Record<string, unknown> | null> {
    const integration = await this.integrations.findById(integrationId);
    if (!integration) {
      throw new NotFoundException(`Integration ${integrationId} not found`);
    }
    return integration.tokens_json ?? null;
  }

  // ---------------------------------------------------------------------------
  // Integration settings
  // ---------------------------------------------------------------------------

  async updateSettings(integrationId: string, orgId: string, settings: Record<string, unknown>): Promise<IntegrationResponse> {
    const existing = await this.integrations.findById(integrationId);
    if (!existing || existing.org_id !== orgId) {
      throw new NotFoundException(`Integration ${integrationId} not found in org ${orgId}`);
    }
    const updated = await this.integrations.updateSettings(integrationId, settings);
    return this.toResponse(updated ?? existing);
  }

  async getSettings(integrationId: string): Promise<Record<string, unknown>> {
    const existing = await this.integrations.findById(integrationId);
    if (!existing) {
      throw new NotFoundException(`Integration ${integrationId} not found`);
    }
    return existing.settings_json ?? {};
  }

  // ---------------------------------------------------------------------------
  // External identity resolution (Tier 1: email auto-match)
  // ---------------------------------------------------------------------------

  async resolveExternalIdentity(
    orgId: string,
    provider: string,
    accountId: string,
    externalUserId: string,
    externalEmail?: string,
  ): Promise<{ external_identity_id: string; eve_user_id: string | null; membership_request_id: string | null }> {
    let identity = await this.externalIdentities.findByProviderAccountUser(provider, accountId, externalUserId);
    if (!identity) {
      identity = await this.externalIdentities.insert({
        id: generateExternalIdentityId(),
        provider,
        account_id: accountId,
        external_user_id: externalUserId,
        eve_user_id: null,
      });
    }

    if (identity.eve_user_id) {
      return {
        external_identity_id: identity.id,
        eve_user_id: identity.eve_user_id,
        membership_request_id: null,
      };
    }

    // Tier 1: Email auto-match — if caller provided an email, try to match
    if (externalEmail) {
      const eveUser = await this.users.findByEmail(externalEmail);
      if (eveUser) {
        const membership = await this.memberships.findOrgMembership(eveUser.id, orgId);
        if (membership) {
          await this.externalIdentities.updateEveUser(identity.id, eveUser.id);
          logger.log({
            event: 'identity.auto_matched',
            externalIdentityId: identity.id,
            eveUserId: eveUser.id,
            matchedBy: 'email',
          });
          return {
            external_identity_id: identity.id,
            eve_user_id: eveUser.id,
            membership_request_id: null,
          };
        }
        logger.log({
          event: 'identity.auto_match_skipped',
          externalIdentityId: identity.id,
          reason: 'email_matches_non_member',
          email: externalEmail,
        });
      }
    }

    const existingRequest = await this.membershipRequests.findPendingByIdentity(identity.id);
    if (existingRequest) {
      return {
        external_identity_id: identity.id,
        eve_user_id: null,
        membership_request_id: existingRequest.id,
      };
    }

    const request = await this.membershipRequests.insert({
      id: generateMembershipRequestId(),
      org_id: orgId,
      external_identity_id: identity.id,
      status: 'pending',
      approved_by: null,
      approved_at: null,
    });

    logger.log({
      event: 'identity.membership_requested',
      externalIdentityId: identity.id,
      membershipRequestId: request.id,
      orgId,
    });

    return {
      external_identity_id: identity.id,
      eve_user_id: null,
      membership_request_id: request.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Membership requests (Tier 3: admin approval)
  // ---------------------------------------------------------------------------

  async listMembershipRequests(orgId: string, status?: string): Promise<MembershipRequestResponse[]> {
    const rows = await this.membershipRequests.listByOrg(orgId, status);
    return rows.map((r) => this.toMembershipRequestResponse(r));
  }

  async approveMembershipRequest(
    requestId: string,
    orgId: string,
    approvedBy: string,
    role: string = 'member',
    email?: string,
  ): Promise<MembershipRequestResponse> {
    const request = await this.membershipRequests.findById(requestId);
    if (!request || request.org_id !== orgId) {
      throw new NotFoundException(`Membership request ${requestId} not found`);
    }
    if (request.status !== 'pending') {
      throw new ConflictException(`Membership request ${requestId} is already ${request.status}`);
    }

    // Look up the external identity to get the external user info
    const identity = await this.externalIdentities.findByProviderAccountUser(
      // We need the identity by ID, but we only have findByProviderAccountUser.
      // Use a direct lookup.
      '', '', '',
    ).catch(() => null);

    // Direct identity lookup by scanning (the identity id is on the request)
    // Since we don't have findById on external identities, find it via the request
    // Actually, let's look up the identity differently. We have the external_identity_id.
    // We need to add a findById to external identities. For now, do a direct DB query.
    const [identityRow] = await this.db<{ id: string; provider: string; account_id: string; external_user_id: string; eve_user_id: string | null }[]>`
      SELECT * FROM external_identities WHERE id = ${request.external_identity_id} LIMIT 1
    `;

    if (!identityRow) {
      throw new NotFoundException(`External identity not found for request ${requestId}`);
    }

    // Determine the email for user creation
    const userEmail = email ?? `${identityRow.external_user_id}@${identityRow.provider}.external`;

    // Find or create the Eve user
    let user = await this.users.findByEmail(userEmail);
    if (!user) {
      user = await this.users.create({
        id: generateUserId(),
        email: userEmail,
        display_name: null,
        is_admin: false,
      });
    }

    // Create org membership
    await this.memberships.upsertOrgMembership(orgId, user.id, role as 'admin' | 'member');

    // Bind the external identity
    await this.externalIdentities.updateEveUser(identityRow.id, user.id);

    // Mark request approved
    const updated = await this.membershipRequests.updateStatus(
      requestId, 'approved', approvedBy, new Date(),
    );

    logger.log({
      event: 'identity.membership_approved',
      requestId,
      eveUserId: user.id,
      orgId,
      approvedBy,
    });

    return this.toMembershipRequestResponse(updated ?? request);
  }

  async denyMembershipRequest(
    requestId: string,
    orgId: string,
    deniedBy: string,
  ): Promise<MembershipRequestResponse> {
    const request = await this.membershipRequests.findById(requestId);
    if (!request || request.org_id !== orgId) {
      throw new NotFoundException(`Membership request ${requestId} not found`);
    }
    if (request.status !== 'pending') {
      throw new ConflictException(`Membership request ${requestId} is already ${request.status}`);
    }

    const updated = await this.membershipRequests.updateStatus(
      requestId, 'denied', deniedBy, new Date(),
    );

    logger.log({
      event: 'identity.membership_denied',
      requestId,
      orgId,
      deniedBy,
    });

    return this.toMembershipRequestResponse(updated ?? request);
  }

  // ---------------------------------------------------------------------------
  // Identity link tokens (Tier 2: self-service CLI claim)
  // ---------------------------------------------------------------------------

  generateLinkToken(eveUserId: string, provider: string, orgId: string): { token: string; expiresIn: number } {
    const config = loadConfig();
    const secret = config.EVE_INTERNAL_API_KEY;
    if (!secret) {
      throw new BadRequestException('Internal API key not configured');
    }

    const jti = crypto.randomUUID();
    const expiresIn = 900; // 15 minutes
    const payload = {
      eve_user_id: eveUserId,
      provider,
      org_id: orgId,
      jti,
      exp: Math.floor(Date.now() / 1000) + expiresIn,
      iat: Math.floor(Date.now() / 1000),
    };

    // Simple HMAC-signed token (no JWT library dependency needed)
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    const token = `eve-link-${payloadB64}.${sig}`;

    return { token, expiresIn };
  }

  async redeemLinkToken(
    token: string,
    provider: string,
    accountId: string,
    externalUserId: string,
  ): Promise<{ ok: boolean; external_identity_id?: string; error?: string }> {
    const config = loadConfig();
    const secret = config.EVE_INTERNAL_API_KEY;
    if (!secret) {
      return { ok: false, error: 'Internal API key not configured' };
    }

    // Strip prefix and split
    const raw = token.startsWith('eve-link-') ? token.slice('eve-link-'.length) : token;
    const dotIdx = raw.lastIndexOf('.');
    if (dotIdx < 0) {
      return { ok: false, error: 'Invalid token format' };
    }

    const payloadB64 = raw.slice(0, dotIdx);
    const sig = raw.slice(dotIdx + 1);

    // Verify signature
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      return { ok: false, error: 'Invalid token signature' };
    }

    // Parse payload
    let payload: { eve_user_id: string; provider: string; org_id: string; jti: string; exp: number };
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, error: 'Invalid token payload' };
    }

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'Token expired' };
    }

    // Check single-use
    if (this.redeemedJtis.has(payload.jti)) {
      return { ok: false, error: 'Token already redeemed' };
    }

    // Check provider match
    if (payload.provider !== provider) {
      return { ok: false, error: `Token is for provider "${payload.provider}", not "${provider}"` };
    }

    // Find or create external identity
    let identity = await this.externalIdentities.findByProviderAccountUser(provider, accountId, externalUserId);
    if (!identity) {
      identity = await this.externalIdentities.insert({
        id: generateExternalIdentityId(),
        provider,
        account_id: accountId,
        external_user_id: externalUserId,
        eve_user_id: null,
      });
    }

    // Reject if already bound
    if (identity.eve_user_id) {
      return { ok: false, error: 'This external identity is already linked to an Eve account' };
    }

    // Bind
    await this.externalIdentities.updateEveUser(identity.id, payload.eve_user_id);
    this.redeemedJtis.add(payload.jti);

    // Clean up old JTIs after 1 hour
    setTimeout(() => this.redeemedJtis.delete(payload.jti), 3600_000);

    logger.log({
      event: 'identity.link_redeemed',
      externalIdentityId: identity.id,
      eveUserId: payload.eve_user_id,
      provider,
    });

    return { ok: true, external_identity_id: identity.id };
  }

  // ---------------------------------------------------------------------------
  // Response serialization
  // ---------------------------------------------------------------------------

  private toResponse(row: {
    id: string;
    org_id: string;
    provider: string;
    account_id: string;
    status: string;
    created_at: Date;
    updated_at: Date;
  }): IntegrationResponse {
    return {
      id: row.id,
      org_id: row.org_id,
      provider: row.provider,
      account_id: row.account_id,
      status: row.status,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  private toMembershipRequestResponse(row: {
    id: string;
    org_id: string;
    external_identity_id: string;
    status: string;
    approved_by: string | null;
    approved_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }): MembershipRequestResponse {
    return {
      id: row.id,
      org_id: row.org_id,
      external_identity_id: row.external_identity_id,
      status: row.status,
      approved_by: row.approved_by,
      approved_at: row.approved_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // OAuth app configs (per-org BYOA credentials)
  // ---------------------------------------------------------------------------

  async getOAuthAppConfig(orgId: string, provider: string): Promise<OAuthAppConfig | undefined> {
    return this.oauthAppConfigs.findByOrgAndProvider(orgId, provider);
  }

  async listOAuthAppConfigs(orgId: string): Promise<OAuthAppConfig[]> {
    return this.oauthAppConfigs.listByOrg(orgId);
  }

  async upsertOAuthAppConfig(
    orgId: string,
    provider: string,
    payload: CreateOAuthAppConfigRequest,
    createdBy?: string,
  ): Promise<OAuthAppConfigResponse> {
    const config = await this.oauthAppConfigs.upsert({
      id: generateOAuthAppConfigId(),
      org_id: orgId,
      provider,
      client_id: payload.client_id,
      client_secret: payload.client_secret,
      config_json: payload.config ?? {},
      label: payload.label ?? null,
      status: 'active',
      created_by: createdBy ?? null,
    });
    return this.toOAuthAppConfigResponse(config);
  }

  async removeOAuthAppConfig(orgId: string, provider: string): Promise<boolean> {
    return this.oauthAppConfigs.remove(orgId, provider);
  }

  getProviderSetupInfo(provider: string): ProviderSetupInfoResponse {
    const config = loadConfig();
    const apiUrl = config.EVE_API_URL ?? process.env.EVE_API_URL ?? '';

    switch (provider) {
      case 'google_drive':
        return {
          provider: 'google_drive',
          callback_url: `${apiUrl}/integrations/google-drive/oauth/callback`,
          webhook_url: null,
          required_scopes: ['https://www.googleapis.com/auth/drive'],
          setup_instructions: [
            '1. Go to https://console.cloud.google.com',
            '2. Create a new project (or select existing)',
            '3. Enable the Google Drive API (APIs & Services > Library)',
            '4. Configure OAuth consent screen (APIs & Services > OAuth consent screen)',
            '5. Create OAuth credentials (APIs & Services > Credentials > Create > OAuth client ID)',
            '6. Application type: Web application',
            `7. Authorized redirect URI: ${apiUrl}/integrations/google-drive/oauth/callback`,
            '8. Copy Client ID and Client Secret',
            '9. Run: eve integrations configure google-drive --client-id "..." --client-secret "..."',
          ].join('\n'),
        };
      case 'slack':
        return {
          provider: 'slack',
          callback_url: `${apiUrl}/integrations/slack/oauth/callback`,
          webhook_url: `${apiUrl}/gateway/providers/slack/webhook`,
          required_scopes: [
            'app_mentions:read', 'chat:write', 'chat:write.public',
            'channels:history', 'channels:read',
            'groups:history', 'groups:read',
            'im:history', 'im:read', 'im:write',
            'users:read', 'users:read.email',
            'reactions:read', 'files:read',
          ],
          setup_instructions: [
            '1. Go to https://api.slack.com/apps',
            '2. Click "Create New App" > "From scratch"',
            '3. Configure OAuth & Permissions: add bot scopes and redirect URL',
            `4. Redirect URL: ${apiUrl}/integrations/slack/oauth/callback`,
            '5. Configure Event Subscriptions if needed',
            '6. Copy App ID, Client ID, Client Secret, Signing Secret',
            '7. Run: eve integrations configure slack --client-id "..." --client-secret "..." --signing-secret "..."',
          ].join('\n'),
        };
      default:
        throw new NotFoundException(`Unknown provider: ${provider}`);
    }
  }

  private toOAuthAppConfigResponse(row: OAuthAppConfig): OAuthAppConfigResponse {
    return {
      id: row.id,
      org_id: row.org_id,
      provider: row.provider,
      client_id: row.client_id,
      label: row.label,
      status: row.status,
      has_signing_secret: !!(row.config_json as Record<string, unknown>)?.signing_secret,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  // ---------------------------------------------------------------------------
  // OAuth state management
  // ---------------------------------------------------------------------------

  private static OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  generateOAuthState(orgId: string): string {
    const state = crypto.randomBytes(32).toString('hex');
    this.oauthStates.set(state, {
      orgId,
      expiresAt: Date.now() + IntegrationsService.OAUTH_STATE_TTL_MS,
    });

    // Evict expired states
    const now = Date.now();
    for (const [key, val] of this.oauthStates) {
      if (val.expiresAt < now) this.oauthStates.delete(key);
    }

    return state;
  }

  validateOAuthState(state: string): string | null {
    const entry = this.oauthStates.get(state);
    if (!entry) return null;
    this.oauthStates.delete(state); // single-use

    if (Date.now() > entry.expiresAt) return null;
    return entry.orgId;
  }

  // ---------------------------------------------------------------------------
  // Signed Slack install tokens (shareable, no Eve auth needed to redeem)
  // ---------------------------------------------------------------------------

  private static DEFAULT_INSTALL_TTL_S = 86400; // 24 hours
  private static MAX_INSTALL_TTL_S = 7 * 86400; // 7 days

  generateSlackInstallToken(orgId: string, ttlSeconds?: number): { token: string; expiresAt: string } {
    const config = loadConfig();
    const secret = config.EVE_INTERNAL_API_KEY;
    if (!secret) {
      throw new BadRequestException('Internal API key not configured');
    }

    const ttl = Math.min(
      ttlSeconds ?? IntegrationsService.DEFAULT_INSTALL_TTL_S,
      IntegrationsService.MAX_INSTALL_TTL_S,
    );
    const jti = crypto.randomUUID();
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const payload = { org_id: orgId, jti, exp, iat: Math.floor(Date.now() / 1000) };

    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    const token = `eve-slack-install-${payloadB64}.${sig}`;

    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  validateSlackInstallToken(token: string): { orgId: string } | null {
    const config = loadConfig();
    const secret = config.EVE_INTERNAL_API_KEY;
    if (!secret) return null;

    const raw = token.startsWith('eve-slack-install-') ? token.slice('eve-slack-install-'.length) : token;
    const dotIdx = raw.lastIndexOf('.');
    if (dotIdx < 0) return null;

    const payloadB64 = raw.slice(0, dotIdx);
    const sig = raw.slice(dotIdx + 1);

    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

    let payload: { org_id: string; jti: string; exp: number };
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return null;
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    if (this.redeemedJtis.has(payload.jti)) return null;
    this.redeemedJtis.add(payload.jti);
    setTimeout(() => this.redeemedJtis.delete(payload.jti), (payload.exp - Math.floor(Date.now() / 1000)) * 1000);

    return { orgId: payload.org_id };
  }
}
