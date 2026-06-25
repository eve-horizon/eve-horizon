import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Param,
  Query,
  Redirect,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { Public } from '../auth/auth.decorator.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { createJsonLogger, loadConfig } from '@eve/shared';

const logger = createJsonLogger('api');

/**
 * Google Drive OAuth Flow (per-org BYOA credentials)
 *
 * Admins register their own GCP OAuth app via
 * POST /orgs/:org_id/integrations/providers/google_drive/config,
 * then initiate from GET /orgs/:org_id/integrations/google-drive/authorize.
 * Google redirects back to GET /integrations/google-drive/oauth/callback
 * with a code we exchange using the org's credentials.
 */
@ApiTags('integrations')
@Controller()
export class GoogleDriveOAuthController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @RequirePermission('integrations:write')
  @Get('orgs/:org_id/integrations/google-drive/authorize')
  @Redirect()
  @ApiOperation({ summary: 'Redirect to Google OAuth for Drive access' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  async authorize(@Param('org_id') orgId: string): Promise<{ url: string }> {
    const appConfig = await this.integrationsService.getOAuthAppConfig(orgId, 'google_drive');
    if (!appConfig) {
      throw new BadRequestException(
        'No Google Drive OAuth app configured for this org. ' +
        'Register credentials first: eve integrations configure google-drive --client-id "..." --client-secret "..."',
      );
    }

    const state = this.integrationsService.generateOAuthState(orgId);
    const redirectUri = buildRedirectUri();

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', appConfig.client_id);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/drive');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);

    return { url: url.toString() };
  }

  @Public()
  @Get('integrations/google-drive/oauth/callback')
  @ApiOperation({ summary: 'Handle Google OAuth callback' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
  ): Promise<{ ok: boolean; integration_id?: string; account_id?: string }> {
    if (error) {
      logger.warn({ event: 'google_drive.oauth.error', error });
      throw new HttpException(
        { ok: false, error: `Google OAuth error: ${error}` },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!code || !state) {
      throw new BadRequestException('Missing code or state parameter');
    }

    const orgId = this.integrationsService.validateOAuthState(state);
    if (!orgId) {
      throw new BadRequestException('Invalid or expired state token');
    }

    // Look up per-org OAuth app credentials
    const appConfig = await this.integrationsService.getOAuthAppConfig(orgId, 'google_drive');
    if (!appConfig) {
      throw new InternalServerErrorException('Google Drive OAuth app not configured for this org');
    }

    try {
      const redirectUri = buildRedirectUri();

      // Exchange authorization code for tokens using org's credentials
      const tokenParams: Record<string, string> = {
        client_id: appConfig.client_id,
        client_secret: appConfig.client_secret,
        code,
        grant_type: 'authorization_code',
      };
      if (redirectUri) tokenParams.redirect_uri = redirectUri;

      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(tokenParams),
      });

      const tokenData = (await tokenResp.json()) as {
        access_token?: string;
        refresh_token?: string;
        token_type?: string;
        expires_in?: number;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        logger.warn({
          event: 'google_drive.oauth.token_exchange_failed',
          error: tokenData.error,
          description: tokenData.error_description,
        });
        throw new BadRequestException(
          `Google token exchange failed: ${tokenData.error_description ?? tokenData.error ?? 'unknown'}`,
        );
      }

      // Fetch user info from Google Drive to get account identifier
      const aboutResp = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user',
        { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
      );

      if (!aboutResp.ok) {
        const body = await aboutResp.text().catch(() => '<unreadable>');
        logger.warn({ event: 'google_drive.oauth.about_failed', status: aboutResp.status, body });
        throw new InternalServerErrorException('Failed to fetch Google Drive user info');
      }

      const aboutData = (await aboutResp.json()) as {
        user?: { emailAddress?: string; displayName?: string; permissionId?: string };
      };

      const accountId = aboutData.user?.emailAddress ?? aboutData.user?.permissionId ?? 'unknown';

      // Store as integration via the generic provider connect method
      const tokensJson = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expiry_date: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
        scope: tokenData.scope,
        email: aboutData.user?.emailAddress,
        display_name: aboutData.user?.displayName,
      };

      const integration = await this.integrationsService.connectProvider(
        orgId,
        'google_drive',
        accountId,
        tokensJson,
      );

      logger.log({
        event: 'google_drive.oauth.connected',
        orgId,
        accountId,
        integrationId: integration.id,
      });

      return { ok: true, integration_id: integration.id, account_id: accountId };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      logger.warn({
        event: 'google_drive.oauth.callback_error',
        error: err instanceof Error ? err.message : String(err),
      });
      throw new InternalServerErrorException('Internal error during OAuth callback');
    }
  }
}

function buildRedirectUri(): string | undefined {
  const config = loadConfig();
  const apiUrl = config.EVE_API_URL ?? process.env.EVE_API_URL;
  if (!apiUrl) return undefined;
  return `${apiUrl}/integrations/google-drive/oauth/callback`;
}
