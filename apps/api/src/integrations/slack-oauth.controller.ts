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
import { IntegrationsService } from './integrations.service.js';
import { createJsonLogger, loadConfig } from '@eve/shared';

const logger = createJsonLogger('api');

const SLACK_SCOPES = [
  'app_mentions:read', 'chat:write', 'chat:write.public',
  'channels:history', 'channels:read',
  'groups:history', 'groups:read',
  'im:history', 'im:read', 'im:write',
  'users:read', 'users:read.email',
  'reactions:read', 'files:read',
].join(',');

/**
 * Slack OAuth Install Flow (per-org BYOA credentials)
 *
 * Admins register their own Slack app via
 * POST /orgs/:org_id/integrations/providers/slack/config,
 * then initiate from GET /orgs/:org_id/integrations/slack/authorize.
 * Slack redirects back to GET /integrations/slack/oauth/callback
 * with a code we exchange using the org's credentials.
 */
@ApiTags('integrations')
@Controller()
export class SlackOAuthController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @RequirePermission('integrations:write')
  @Get('orgs/:org_id/integrations/slack/authorize')
  @Redirect()
  @ApiOperation({ summary: 'Redirect to Slack OAuth for workspace install' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  async authorize(@Param('org_id') orgId: string): Promise<{ url: string }> {
    const appConfig = await this.integrationsService.getOAuthAppConfig(orgId, 'slack');
    if (!appConfig) {
      throw new BadRequestException(
        'No Slack OAuth app configured for this org. ' +
        'Register credentials first: eve integrations configure slack --client-id "..." --client-secret "..." --signing-secret "..."',
      );
    }

    const state = this.integrationsService.generateOAuthState(orgId);
    const redirectUri = buildRedirectUri();

    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', appConfig.client_id);
    url.searchParams.set('scope', SLACK_SCOPES);
    url.searchParams.set('state', state);
    if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);

    return { url: url.toString() };
  }

  @Public()
  @Get('integrations/slack/install')
  @Redirect()
  @ApiOperation({ summary: 'Public Slack install via signed token (no Eve auth required)' })
  async install(@Query('token') token: string | undefined): Promise<{ url: string }> {
    if (!token) {
      throw new BadRequestException('Missing token parameter');
    }

    const result = this.integrationsService.validateSlackInstallToken(token);
    if (!result) {
      throw new BadRequestException('Invalid, expired, or already-used install token');
    }

    const appConfig = await this.integrationsService.getOAuthAppConfig(result.orgId, 'slack');
    if (!appConfig) {
      throw new BadRequestException('No Slack OAuth app configured for this org');
    }

    const state = this.integrationsService.generateOAuthState(result.orgId);
    const redirectUri = buildRedirectUri();

    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', appConfig.client_id);
    url.searchParams.set('scope', SLACK_SCOPES);
    url.searchParams.set('state', state);
    if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);

    return { url: url.toString() };
  }

  @Public()
  @Get('integrations/slack/oauth/callback')
  @ApiOperation({ summary: 'Handle Slack OAuth callback' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
  ): Promise<{ ok: boolean; integration_id?: string; team_id?: string }> {
    if (error) {
      logger.warn({ event: 'slack.oauth.error', error });
      throw new HttpException({ ok: false, error: `Slack OAuth error: ${error}` }, HttpStatus.BAD_REQUEST);
    }

    if (!code || !state) {
      throw new BadRequestException('Missing code or state parameter');
    }

    const orgId = this.integrationsService.validateOAuthState(state);
    if (!orgId) {
      throw new BadRequestException('Invalid or expired state token');
    }

    // Look up per-org OAuth app credentials
    const appConfig = await this.integrationsService.getOAuthAppConfig(orgId, 'slack');
    if (!appConfig) {
      throw new InternalServerErrorException('Slack OAuth app not configured for this org');
    }

    try {
      const redirectUri = buildRedirectUri();
      const params: Record<string, string> = {
        client_id: appConfig.client_id,
        client_secret: appConfig.client_secret,
        code,
      };
      if (redirectUri) params.redirect_uri = redirectUri;

      const tokenResp = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });

      const tokenData = await tokenResp.json() as {
        ok?: boolean;
        error?: string;
        team?: { id: string; name?: string };
        access_token?: string;
        bot_user_id?: string;
        authed_user?: { id: string; access_token?: string };
      };

      if (!tokenData.ok || !tokenData.team?.id) {
        logger.warn({ event: 'slack.oauth.token_exchange_failed', error: tokenData.error });
        throw new BadRequestException(`Slack token exchange failed: ${tokenData.error ?? 'unknown'}`);
      }

      const integration = await this.integrationsService.connectSlack(orgId, {
        team_id: tokenData.team.id,
        tokens_json: {
          access_token: tokenData.access_token,
          bot_user_id: tokenData.bot_user_id,
          team_id: tokenData.team.id,
          team_name: tokenData.team.name,
          authed_user: tokenData.authed_user,
        },
        status: 'active',
      });

      logger.log({
        event: 'slack.oauth.connected',
        orgId,
        teamId: tokenData.team.id,
        integrationId: integration.id,
      });

      return { ok: true, integration_id: integration.id, team_id: tokenData.team.id };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      logger.warn({
        event: 'slack.oauth.callback_error',
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
  return `${apiUrl}/integrations/slack/oauth/callback`;
}
