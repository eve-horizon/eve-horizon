import { Controller, Get, Headers, Post, Body, HttpCode, HttpStatus, Req, UnauthorizedException, BadRequestException, ForbiddenException, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthStatusResponseSchema,
  AuthChallengeRequestSchema,
  AuthChallengeResponseSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema,
  AuthBootstrapRequestSchema,
  AuthBootstrapResponseSchema,
  AuthBootstrapStatusResponseSchema,
  AuthIdentityRequestSchema,
  AuthIdentityResponseSchema,
  AuthMintRequestSchema,
  AuthMintResponseSchema,
  AppAuthContextResponseSchema,
  AppAuthContextAdminResponseSchema,
  AppAccessResponseSchema,
  AppInviteRequestSchema,
  AppInviteResponseSchema,
  MagicLinkRequestSchema,
  MagicLinkResponseSchema,
  AuthTokenVerifyResponseSchema,
  AuthExchangeResponseSchema,
  type AuthStatusResponse,
  type AuthTokenVerifyResponse,
  type AuthChallengeRequest,
  type AuthChallengeResponse,
  type AuthVerifyRequest,
  type AuthVerifyResponse,
  type AuthBootstrapRequest,
  type AuthBootstrapResponse,
  type AuthBootstrapStatusResponse,
  type AuthIdentityRequest,
  type AuthIdentityResponse,
  type AuthMintRequest,
  type AuthMintResponse,
  type AuthExchangeResponse,
  type AppAuthContextResponse,
  type AppAuthContextAdminResponse,
  type AppAccessResponse,
  type AppInviteRequest,
  type AppInviteResponse,
  type MagicLinkRequest,
  type MagicLinkResponse,
} from '@eve/shared';
import { loadConfig } from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { Public } from './auth.decorator.js';
import { AuthService } from './auth.service.js';
import { RbacService } from './rbac.service.js';
import { permissionMatrix, expandPermissions } from './permissions.js';
import { MailerService } from '../mailer/mailer.service.js';
import { renderInviteEmail } from '../mailer/templates/invite.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rbacService: RbacService,
    private readonly mailerService: MailerService,
  ) {}

  @Get('me')
  @Public()
  @ApiOperation({ summary: 'Get current auth status' })
  @ApiOkResponse({
    description: 'Auth status',
    schema: zodSchemaToOpenApi(AuthStatusResponseSchema, 'AuthStatusResponse'),
  })
  async me(
    @Headers('authorization') authorization?: string | string[],
    @Headers('x-eve-project-id') projectIdHeader?: string | string[],
  ): Promise<AuthStatusResponse> {
    if (!this.authService.isEnabled()) {
      return { auth_enabled: false, authenticated: false };
    }

    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header) {
      return { auth_enabled: true, authenticated: false };
    }

    const user = await this.authService.verifyAuthorizationHeader(header);
    const type = user.is_job_token
      ? 'job'
      : user.is_service_token
        ? 'service'
        : user.is_app_link_token
          ? 'app_link'
          : user.is_service_principal
            ? 'service_principal'
            : 'user';
    const permissionSet = new Set<string>();
    if (type === 'user' && user.memberships?.length) {
      for (const membership of user.memberships) {
        for (const permission of expandPermissions(membership.role)) {
          permissionSet.add(permission);
        }
      }
    } else if (type === 'user' && user.role) {
      for (const permission of expandPermissions(user.role)) {
        permissionSet.add(permission);
      }
    }

    const permissions = type === 'user'
      ? [...permissionSet]
      : [...(user.permissions ?? [])];

    // Resolve project-level role when X-Eve-Project-Id header is provided
    const projectId = Array.isArray(projectIdHeader) ? projectIdHeader[0] : projectIdHeader;
    let project_role: 'owner' | 'admin' | 'member' | null = null;
    if (projectId && type === 'user' && user.user_id) {
      project_role = await this.authService.resolveProjectRole(user.user_id, projectId);
    }

    return {
      auth_enabled: true,
      authenticated: true,
      type,
      user_id: user.user_id,
      email: user.email,
      org_id: user.org_id ?? null,
      project_id: user.project_id,
      job_id: user.job_id,
      service_name: user.service_name,
      env_name: user.env_name,
      subscription_id: user.subscription_id,
      consumer_project_id: user.consumer_project_id,
      producer_project_id: user.producer_project_id,
      consumer_principal: user.consumer_principal,
      consumer_env: user.consumer_env,
      producer_env: user.producer_env,
      api_name: user.api_name,
      role: user.role,
      is_admin: user.is_admin,
      is_job_token: user.is_job_token,
      is_service_token: user.is_service_token,
      is_service_principal: user.is_service_principal,
      is_app_link_token: user.is_app_link_token,
      permissions,
      memberships: user.memberships,
      ...(projectId ? { project_role } : {}),
    };
  }

  @Get('token/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a Bearer token and return its claims' })
  @ApiOkResponse({
    description: 'Token claims',
    schema: zodSchemaToOpenApi(AuthTokenVerifyResponseSchema, 'AuthTokenVerifyResponse'),
  })
  async tokenVerify(@Headers('authorization') authorization?: string | string[]): Promise<AuthTokenVerifyResponse> {
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header) {
      throw new UnauthorizedException('Authorization header required');
    }

    try {
      const user = await this.authService.verifyAuthorizationHeader(header);

      const response: AuthTokenVerifyResponse = {
        valid: true,
        type: user.is_job_token
          ? 'job'
          : user.is_service_token
            ? 'service'
            : user.is_app_link_token
              ? 'app_link'
              : user.is_service_principal
                ? 'service_principal'
                : 'user',
        user_id: user.user_id,
      };

      if (user.email) response.email = user.email;
      if (user.org_id !== undefined) response.org_id = user.org_id ?? null;
      if (user.project_id) response.project_id = user.project_id;
      if (user.job_id) response.job_id = user.job_id;
      if (user.agent_slug) response.agent_slug = user.agent_slug;
      if (user.service_name) response.service_name = user.service_name;
      if (user.env_name) response.env_name = user.env_name;
      if (user.subscription_id) response.subscription_id = user.subscription_id;
      if (user.consumer_project_id) response.consumer_project_id = user.consumer_project_id;
      if (user.producer_project_id) response.producer_project_id = user.producer_project_id;
      if (user.consumer_principal) response.consumer_principal = user.consumer_principal;
      if (user.consumer_env !== undefined) response.consumer_env = user.consumer_env;
      if (user.producer_env) response.producer_env = user.producer_env;
      if (user.api_name) response.api_name = user.api_name;
      if (user.permissions) response.permissions = user.permissions;
      if (user.is_admin !== undefined) response.is_admin = user.is_admin;
      if (user.role) response.role = user.role;

      return response;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  @Get('permissions')
  @Public()
  @ApiOperation({ summary: 'Get the permission matrix (role → permissions)' })
  async permissions(): Promise<{ matrix: Array<{ permission: string; member: boolean; admin: boolean; owner: boolean }> }> {
    return { matrix: permissionMatrix() };
  }

  @Get('bootstrap/status')
  @Public()
  @ApiOperation({ summary: 'Get bootstrap status and window information' })
  @ApiOkResponse({
    description: 'Bootstrap status',
    schema: zodSchemaToOpenApi(AuthBootstrapStatusResponseSchema, 'AuthBootstrapStatusResponse'),
  })
  async bootstrapStatus(): Promise<AuthBootstrapStatusResponse> {
    const status = await this.authService.getBootstrapStatus();
    return {
      completed: status.completed,
      window_open: status.windowOpen,
      window_closes_at: status.windowClosesAt?.toISOString() ?? null,
      requires_token: status.requiresToken,
      mode: status.mode,
    };
  }

  @Post('bootstrap')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Bootstrap the first admin user' })
  @ApiBody({ schema: zodSchemaToOpenApi(AuthBootstrapRequestSchema, 'AuthBootstrapRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(AuthBootstrapResponseSchema, 'AuthBootstrapResponse') })
  async bootstrap(
    @Body(new ZodValidationPipe(AuthBootstrapRequestSchema)) body: AuthBootstrapRequest,
  ): Promise<AuthBootstrapResponse> {
    return this.authService.bootstrapAdmin(body);
  }

  @Post('challenge')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request an SSH challenge for GitHub login' })
  @ApiBody({ schema: zodSchemaToOpenApi(AuthChallengeRequestSchema, 'AuthChallengeRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(AuthChallengeResponseSchema, 'AuthChallengeResponse') })
  async challenge(
    @Body(new ZodValidationPipe(AuthChallengeRequestSchema)) body: AuthChallengeRequest,
  ): Promise<AuthChallengeResponse> {
    return this.authService.createChallenge(body);
  }

  @Post('verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an SSH challenge and issue a token' })
  @ApiBody({ schema: zodSchemaToOpenApi(AuthVerifyRequestSchema, 'AuthVerifyRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(AuthVerifyResponseSchema, 'AuthVerifyResponse') })
  async verify(
    @Body(new ZodValidationPipe(AuthVerifyRequestSchema)) body: AuthVerifyRequest,
  ): Promise<AuthVerifyResponse> {
    return this.authService.verifyChallenge(body);
  }

  @Post('exchange')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a Supabase token for an Eve RS256 token',
    description:
      'Accepts a Supabase HS256 access token in the Authorization header, ' +
      'verifies it, resolves or creates the corresponding Eve user (linking by ' +
      'identity fingerprint or email match), and returns a freshly minted Eve RS256 token. ' +
      'This endpoint is public because the caller authenticates via the Supabase token itself.',
  })
  @ApiOkResponse({
    description: 'Eve RS256 token',
    schema: zodSchemaToOpenApi(AuthExchangeResponseSchema, 'AuthExchangeResponse'),
  })
  async exchange(
    @Headers('authorization') authorization?: string | string[],
  ): Promise<AuthExchangeResponse> {
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token required');
    }

    const supabaseToken = header.slice(7);

    // Verify the Supabase HS256 token and resolve/link the Eve user
    const authUser = await this.authService.resolveSupabaseTokenForExchange(supabaseToken);

    // Mint a fresh Eve RS256 token for the resolved user
    const eveToken = await this.authService.mintUserToken(authUser.user_id, authUser.email);

    return {
      access_token: eveToken.access_token,
      token_type: 'bearer',
      expires_at: eveToken.expires_at,
      user_id: authUser.user_id,
      ...(authUser.invite_redirect_to ? { invite_redirect_to: authUser.invite_redirect_to } : {}),
      ...(authUser.invite_org_id ? { invite_org_id: authUser.invite_org_id } : {}),
      ...(authUser.invite_app_context ? { invite_app_context: authUser.invite_app_context } : {}),
    };
  }

  @Post('identities')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register a GitHub SSH public key' })
  @ApiBody({ schema: zodSchemaToOpenApi(AuthIdentityRequestSchema, 'AuthIdentityRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(AuthIdentityResponseSchema, 'AuthIdentityResponse') })
  async registerIdentity(
    @Body(new ZodValidationPipe(AuthIdentityRequestSchema)) body: AuthIdentityRequest,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<AuthIdentityResponse> {
    const user = request.user;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }
    const identity = await this.authService.registerIdentity(body, {
      user_id: user.user_id,
      is_admin: user.is_admin,
    });
    return {
      id: identity.id,
      user_id: identity.user_id,
      provider: identity.provider as 'github_ssh',
      fingerprint: identity.fingerprint,
      label: identity.label,
      created_at: identity.created_at.toISOString(),
      updated_at: identity.updated_at.toISOString(),
    };
  }

  @Post('mint')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mint a user token (admin only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(AuthMintRequestSchema, 'AuthMintRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(AuthMintResponseSchema, 'AuthMintResponse') })
  async mint(
    @Body(new ZodValidationPipe(AuthMintRequestSchema)) body: AuthMintRequest,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<AuthMintResponse> {
    const user = request.user;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      if (body.project_id) {
        await this.rbacService.requireProjectRole(user.user_id, body.project_id, 'admin');
      } else if (body.org_id) {
        await this.rbacService.requireOrgRole(user.user_id, body.org_id, 'admin');
      } else {
        throw new BadRequestException('org_id or project_id is required');
      }
    }

    return this.authService.mintUserTokenForAdmin(body);
  }

  /**
   * Public endpoint for auth configuration discovery.
   *
   * Returns the Supabase Auth URL and anon key so that browser clients (and
   * the CLI) can discover the auth provider without hardcoding configuration.
   * No auth required — the values are public by design.
   */
  @Get('config')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get auth configuration for clients',
    description:
      'Returns the public Supabase Auth URL, anon key, and SSO URL so that ' +
      'browser apps and CLI tools can discover the auth provider dynamically.',
  })
  async getAuthConfig(): Promise<{
    supabase_url: string | null;
    anon_key: string | null;
    sso_url: string | null;
  }> {
    const config = loadConfig();
    return {
      supabase_url: config.SUPABASE_AUTH_EXTERNAL_URL ?? config.SUPABASE_AUTH_URL ?? null,
      anon_key: config.SUPABASE_ANON_KEY ?? null,
      sso_url: config.EVE_SSO_URL ?? null,
    };
  }

  @Get('app-context')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get public app auth context',
    description:
      'Returns safe project branding and app auth policy for SSO rendering. ' +
      'No secrets, membership data, or raw manifest content are exposed.',
  })
  @ApiOkResponse({
    description: 'Public app auth context',
    schema: zodSchemaToOpenApi(AppAuthContextResponseSchema, 'AppAuthContextResponse'),
  })
  async getAppContext(@Query('project_id') projectId?: string): Promise<AppAuthContextResponse> {
    if (!projectId) {
      throw new BadRequestException('project_id is required');
    }
    return this.authService.getAppAuthContext(projectId);
  }

  @Get('app-context/admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get full app auth context (project admin only)',
    description:
      'Reveals the complete resolved app auth policy, including the configured ' +
      'domain_signup domain list and target_org. Requires project-admin or system-admin. ' +
      'Never exposed via the public /app-context endpoint.',
  })
  @ApiOkResponse({
    description: 'Admin app auth context',
    schema: zodSchemaToOpenApi(AppAuthContextAdminResponseSchema, 'AppAuthContextAdminResponse'),
  })
  async getAppContextAdmin(
    @Query('project_id') projectId: string | undefined,
    @Req() req: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<AppAuthContextAdminResponse> {
    if (!projectId) {
      throw new BadRequestException('project_id is required');
    }
    if (!req.user?.user_id) {
      throw new UnauthorizedException('User context required');
    }
    if (!req.user.is_admin) {
      // PermissionGuard.extractProjectId only resolves path params, so this
      // query-string route does its own check rather than relying on a
      // declarative @RequirePermission('projects:admin').
      await this.rbacService.requireProjectRole(req.user.user_id, projectId, 'admin');
    }
    return this.authService.getAppAuthContextAdmin(projectId);
  }

  @Get('app-access')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get authenticated app org access',
    description:
      'Returns the orgs the current user can enter for a project and which of those orgs ' +
      'can invite regular members through the app-scoped invite flow.',
  })
  @ApiOkResponse({
    description: 'Authenticated app access context',
    schema: zodSchemaToOpenApi(AppAccessResponseSchema, 'AppAccessResponse'),
  })
  async getAppAccess(
    @Query('project_id') projectId: string | undefined,
    @Req() req: { user?: { user_id?: string } },
  ): Promise<AppAccessResponse> {
    if (!projectId) {
      throw new BadRequestException('project_id is required');
    }
    if (!req.user?.user_id) {
      throw new UnauthorizedException('User context required');
    }
    return this.authService.getAppAccess(projectId, req.user.user_id);
  }

  @Post('app-invites')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an app-scoped org member invite',
    description:
      'Lets an org admin invite a regular member into an app-allowed org. ' +
      'The target role is always member and the email uses project branding.',
  })
  @ApiBody({ schema: zodSchemaToOpenApi(AppInviteRequestSchema, 'AppInviteRequest') })
  @ApiOkResponse({
    description: 'App invite result',
    schema: zodSchemaToOpenApi(AppInviteResponseSchema, 'AppInviteResponse'),
  })
  async createAppInvite(
    @Body(new ZodValidationPipe(AppInviteRequestSchema)) body: AppInviteRequest,
    @Req() req: { user?: { user_id?: string } },
  ): Promise<AppInviteResponse> {
    if (!req.user?.user_id) {
      throw new UnauthorizedException('User context required');
    }
    return this.authService.createAppInvite(body, { user_id: req.user.user_id });
  }

  @Post('magic-link')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send an app-branded magic-link login email',
    description:
      'Generates a GoTrue magic-link action URL after Eve verifies the app auth policy ' +
      'and recipient eligibility, then sends the email with project branding.',
  })
  @ApiBody({ schema: zodSchemaToOpenApi(MagicLinkRequestSchema, 'MagicLinkRequest') })
  @ApiOkResponse({
    description: 'Generic magic-link send result',
    schema: zodSchemaToOpenApi(MagicLinkResponseSchema, 'MagicLinkResponse'),
  })
  async sendMagicLink(
    @Body(new ZodValidationPipe(MagicLinkRequestSchema)) body: MagicLinkRequest,
  ): Promise<MagicLinkResponse> {
    return this.authService.sendAppMagicLink(body);
  }

  /**
   * Backwards-compatible admin invite endpoint.
   *
   * GoTrue still generates the one-time invite link, but Eve renders and
   * sends the default branded email through the shared SMTP mailer.
   */
  @Post('supabase/invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a default-branded Supabase Auth invite email (admin only)',
    description:
      'Generates a GoTrue invite link and sends it through Eve SMTP with ' +
      'default Eve Horizon branding. Requires system admin privileges.',
  })
  async sendSupabaseInvite(
    @Body() body: { email: string; redirect_to?: string },
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<{ email: string; invited: boolean }> {
    const user = request.user;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      throw new ForbiddenException('System admin required to send Supabase invites');
    }

    if (!body.email) {
      throw new BadRequestException('email is required');
    }

    const actionLink = await this.authService.generateWrappedInviteLink({
      email: body.email,
      redirectTo: body.redirect_to ?? null,
      projectId: null,
      orgId: null,
    });
    const email = renderInviteEmail({
      branding: null,
      actionLink,
      expiresAt: null,
    });
    await this.mailerService.send({
      to: body.email,
      ...email,
    });
    return { email: body.email, invited: true };
  }
}
