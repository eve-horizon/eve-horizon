import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { loadConfig, DEFAULT_SERVICE_PERMISSIONS, AccessBindingScopeSchema, type AccessBindingScope } from '@eve/shared';
import { type Db, appLinkSubscriptionQueries, jobQueries, projectQueries } from '@eve/db';
import { Public } from './auth.decorator.js';
import { AuthService } from './auth.service.js';

const INTERNAL_HEADER = 'x-eve-internal-token';

function validateInternalToken(token: string | undefined): void {
  const config = loadConfig();
  if (!config.EVE_INTERNAL_API_KEY || token !== config.EVE_INTERNAL_API_KEY) {
    throw new UnauthorizedException('Invalid internal token');
  }
}

@ApiTags('internal')
@Controller('internal/auth')
export class AuthInternalController {
  private jobs: ReturnType<typeof jobQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private appLinkSubscriptions: ReturnType<typeof appLinkSubscriptionQueries>;

  constructor(
    private readonly authService: AuthService,
    @Inject('DB') private readonly db: Db,
  ) {
    this.jobs = jobQueries(db);
    this.projects = projectQueries(db);
    this.appLinkSubscriptions = appLinkSubscriptionQueries(db);
  }

  @Public()
  @Post('mint-job-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mint a job token with explicit permissions for agent CLI access (internal only)' })
  async mintJobToken(
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body() body: { job_id: string; permissions?: string[]; scopes?: string[]; scope?: unknown; ttl_seconds?: number },
  ): Promise<{ access_token: string; token_type: string; expires_at: number }> {
    validateInternalToken(token);

    const job = await this.jobs.findById(body.job_id);
    if (!job) {
      throw new NotFoundException(`Job ${body.job_id} not found`);
    }

    const project = await this.projects.findById(job.project_id);
    if (!project) {
      throw new NotFoundException(`Project ${job.project_id} not found`);
    }

    // Accept both 'permissions' (new) and 'scopes' (legacy) in request body
    const permissions = body.permissions ?? body.scopes ?? [];
    let scope: AccessBindingScope | undefined;
    if (body.scope !== undefined) {
      const parsedScope = AccessBindingScopeSchema.safeParse(body.scope);
      if (!parsedScope.success) {
        throw new UnauthorizedException('Invalid job token scope');
      }
      scope = parsedScope.data;
    }

    const agentSlug = (job.target as { agent_slug?: string } | null)?.agent_slug;

    const accessToken = this.authService.mintJobToken({
      userId: job.actor_user_id ?? 'system',
      orgId: project.org_id,
      projectId: job.project_id,
      jobId: job.id,
      permissions,
      scope,
      ttlSeconds: body.ttl_seconds,
      agentSlug: agentSlug ?? undefined,
    });

    // Decode the exp claim for the response
    const parts = accessToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_at: payload.exp,
    };
  }

  @Public()
  @Post('magic-link-wrap/inspect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Inspect a magic-link wrap (read-only with telemetry bump)',
    description:
      'Returns the metadata needed to render the SSO confirmation interstitial: kind, project_id, org_id, redirect_to, expiry/consumed flags, and the running get_count so scanner pre-fetches are visible. Increments get_count and last_get_at on every call — used by both HEAD and GET handlers on the SSO. Never reveals the underlying GoTrue action_link.',
  })
  async inspectMagicLinkWrap(
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body() body: { wrap_token?: string },
  ): Promise<
    | {
        found: true;
        kind: 'magic_link' | 'invite';
        project_id: string | null;
        org_id: string | null;
        redirect_to: string | null;
        expires_at: string;
        expired: boolean;
        consumed: boolean;
        get_count: number;
      }
    | { found: false }
  > {
    validateInternalToken(token);
    const id = (body.wrap_token ?? '').trim();
    if (!id) {
      return { found: false };
    }
    const inspected = await this.authService.inspectMagicLinkWrap(id);
    if (!inspected.found) {
      return { found: false };
    }
    return {
      found: true,
      kind: inspected.kind,
      project_id: inspected.project_id,
      org_id: inspected.org_id,
      redirect_to: inspected.redirect_to,
      expires_at: inspected.expires_at.toISOString(),
      expired: inspected.expired,
      consumed: inspected.consumed,
      get_count: inspected.get_count,
    };
  }

  @Public()
  @Post('magic-link-wrap/consume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consume a magic-link wrap and reveal the GoTrue action_link',
    description:
      'Atomically marks the wrap consumed. On success returns the stored GoTrue action_link (the SSO 302-redirects the browser there). On failure returns {status: expired | already_consumed | unknown} so the SSO can render the right "can\'t be used" page.',
  })
  async consumeMagicLinkWrap(
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body() body: { wrap_token?: string },
  ): Promise<
    | { status: 'ok'; gotrue_action_link: string; kind: 'magic_link' | 'invite'; project_id: string | null; org_id: string | null }
    | { status: 'expired' | 'already_consumed' | 'unknown' }
  > {
    validateInternalToken(token);
    const id = (body.wrap_token ?? '').trim();
    if (!id) {
      return { status: 'unknown' };
    }
    const result = await this.authService.consumeMagicLinkWrap(id);
    if (result.status !== 'ok') {
      return { status: result.status };
    }
    return {
      status: 'ok',
      gotrue_action_link: result.gotrue_action_link,
      kind: result.kind,
      project_id: result.project_id,
      org_id: result.org_id,
    };
  }

  @Public()
  @Post('mint-service-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mint a service token for deployed app services (internal only)' })
  async mintServiceToken(
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body() body: {
      project_id: string;
      org_id: string;
      env_name: string;
      service_name: string;
      permissions?: string[];
      ttl_seconds?: number;
    },
  ): Promise<{ access_token: string; token_type: string; expires_at: number }> {
    validateInternalToken(token);

    const accessToken = this.authService.mintServiceToken({
      projectId: body.project_id,
      orgId: body.org_id,
      envName: body.env_name,
      serviceName: body.service_name,
      permissions: body.permissions ?? [...DEFAULT_SERVICE_PERMISSIONS],
      ttlSeconds: body.ttl_seconds,
    });

    const parts = accessToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_at: payload.exp,
    };
  }

  @Public()
  @Post('mint-app-link-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mint an app-link token for cross-project API access (internal only)' })
  async mintAppLinkToken(
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body() body: {
      subscription_id: string;
      consumer_principal: string;
      consumer_env?: string | null;
      producer_env?: string | null;
      ttl_seconds?: number;
    },
  ): Promise<{ access_token: string; token_type: string; expires_at: number }> {
    validateInternalToken(token);

    const subscription = await this.appLinkSubscriptions.findWithGrantsById(body.subscription_id);
    if (!subscription || !subscription.api_grant) {
      throw new NotFoundException(`App-link subscription ${body.subscription_id} not found`);
    }
    const grant = subscription.api_grant;
    if (grant.revoked_at) {
      throw new UnauthorizedException('App-link grant is revoked');
    }

    const consumerProject = await this.projects.findById(subscription.consumer_project_id);
    if (!consumerProject) {
      throw new NotFoundException(`Project ${subscription.consumer_project_id} not found`);
    }

    const producerEnv = body.producer_env
      ?? subscription.producer_env_name
      ?? body.consumer_env
      ?? null;
    if (!producerEnv) {
      throw new UnauthorizedException('producer_env is required for app-link token minting');
    }
    if (grant.envs.length > 0 && !grant.envs.includes(producerEnv)) {
      throw new UnauthorizedException(`Producer env ${producerEnv} is not allowed by this app-link grant`);
    }

    const accessToken = this.authService.mintAppLinkToken({
      subscriptionId: subscription.id,
      consumerProjectId: subscription.consumer_project_id,
      consumerOrgId: consumerProject.org_id,
      consumerPrincipal: body.consumer_principal,
      consumerEnv: body.consumer_env ?? null,
      producerProjectId: grant.producer_project_id,
      producerEnv,
      apiName: grant.export_name,
      scopes: subscription.requested_scopes,
      ttlSeconds: body.ttl_seconds,
    });

    const parts = accessToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    await this.appLinkSubscriptions.recordTokenMint({
      subscription_id: subscription.id,
      principal: body.consumer_principal,
      audience: `project:${grant.producer_project_id}`,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_at: payload.exp,
    };
  }
}
