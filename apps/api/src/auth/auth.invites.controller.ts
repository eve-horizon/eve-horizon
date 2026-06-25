import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiOkResponse } from '@nestjs/swagger';
import { randomBytes } from 'crypto';
import { type Db, orgInviteQueries, type OrgInvite } from '@eve/db';
import {
  OrgInviteListResponseSchema,
  OrgInviteResponseSchema,
  type OrgInviteResponse,
  type OrgInviteListResponse,
} from '@eve/shared';
import { RequirePermission } from './permission.decorator.js';
import { RbacService } from './rbac.service.js';
import { zodSchemaToOpenApi } from '../openapi.js';

interface InviteRequest {
  org_id: string;
  provider_hint?: string;
  identity_hint?: string;
  role?: 'owner' | 'admin' | 'member';
  expires_in_hours?: number;
}

function toResponse(invite: OrgInvite): OrgInviteResponse {
  return {
    id: invite.id,
    org_id: invite.org_id,
    invite_code: invite.invite_code,
    provider_hint: invite.provider_hint,
    identity_hint: invite.identity_hint,
    role: invite.role,
    expires_at: invite.expires_at?.toISOString() ?? null,
    used_at: invite.used_at?.toISOString() ?? null,
    created_at: invite.created_at.toISOString(),
  };
}

@ApiTags('auth')
@Controller('auth/invites')
export class AuthInvitesController {
  private readonly orgInvites: ReturnType<typeof orgInviteQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly rbacService: RbacService,
  ) {
    this.orgInvites = orgInviteQueries(db);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Create an org invite (admin only)' })
  @ApiOkResponse({
    description: 'Org invite created',
    schema: zodSchemaToOpenApi(OrgInviteResponseSchema, 'OrgInviteResponse'),
  })
  async createInvite(
    @Body() body: InviteRequest,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<OrgInviteResponse> {
    const user = request.user;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, body.org_id, 'admin');
    }

    const inviteCode = randomBytes(24).toString('base64url');
    const expiresAt = body.expires_in_hours
      ? new Date(Date.now() + body.expires_in_hours * 60 * 60 * 1000)
      : null;

    const invite = await this.orgInvites.create({
      org_id: body.org_id,
      created_by: user.user_id,
      invite_code: inviteCode,
      provider_hint: body.provider_hint ?? null,
      identity_hint: body.identity_hint ?? null,
      role: body.role ?? 'member',
      expires_at: expiresAt,
    });

    return toResponse(invite);
  }

  @Get(':org_id')
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'List invites for an org' })
  @ApiOkResponse({
    description: 'Org invite list',
    schema: zodSchemaToOpenApi(OrgInviteListResponseSchema, 'OrgInviteListResponse'),
  })
  async listInvites(
    @Param('org_id') orgId: string,
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
  ): Promise<OrgInviteListResponse> {
    const user = request.user;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    const invites = await this.orgInvites.listByOrg(orgId, { includeUsed: true });
    return { data: invites.map(toResponse) };
  }
}
