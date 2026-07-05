import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Inject,
  Logger,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiOkResponse } from '@nestjs/swagger';
import {
  type Db,
  accessRequestQueries,
  type AccessRequest,
  userQueries,
  identityQueries,
  membershipQueries,
  orgQueries,
} from '@eve/db';
import {
  generateAccessRequestId,
  generateUserId,
  generateIdentityId,
  generateOrgId,
  OrgSlugSchema,
  AccessRequestListResponseSchema,
  type AccessRequestResponse,
  type AccessRequestListResponse,
} from '@eve/shared';
import { Public } from './auth.decorator.js';
import { RequirePermission } from './permission.decorator.js';
import { fingerprintPublicKey } from './providers/index.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from './auth.types.js';

type PostgresLikeError = {
  code?: string;
  constraint?: string;
};

function toResponse(r: AccessRequest): AccessRequestResponse {
  return {
    id: r.id,
    provider: r.provider,
    fingerprint: r.fingerprint,
    email: r.email,
    desired_org_name: r.desired_org_name,
    desired_org_slug: r.desired_org_slug,
    status: r.status,
    reviewed_at: r.reviewed_at?.toISOString() ?? null,
    review_notes: r.review_notes,
    user_id: r.user_id,
    org_id: r.org_id,
    created_at: r.created_at.toISOString(),
  };
}

// ---- Controller ----

@ApiTags('auth')
@Controller()
export class AuthAccessRequestsController {
  private readonly logger = new Logger(AuthAccessRequestsController.name);
  private readonly accessRequests: ReturnType<typeof accessRequestQueries>;
  private readonly users: ReturnType<typeof userQueries>;
  private readonly identities: ReturnType<typeof identityQueries>;
  private readonly memberships: ReturnType<typeof membershipQueries>;
  private readonly orgs: ReturnType<typeof orgQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.accessRequests = accessRequestQueries(db);
    this.users = userQueries(db);
    this.identities = identityQueries(db);
    this.memberships = membershipQueries(db);
    this.orgs = orgQueries(db);
  }

  // ============================================================
  // Unauthenticated — agent-facing
  // ============================================================

  @Post('auth/request-access')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit an access request (unauthenticated)' })
  async submitRequest(
    @Body() body: {
      provider: string;
      public_key: string;
      email?: string;
      desired_org_name: string;
      desired_org_slug?: string;
    },
  ): Promise<AccessRequestResponse> {
    if (!body.provider || !body.public_key || !body.desired_org_name) {
      throw new BadRequestException('provider, public_key, and desired_org_name are required');
    }

    if (!['github_ssh', 'nostr'].includes(body.provider)) {
      throw new BadRequestException('provider must be github_ssh or nostr');
    }

    // Compute fingerprint from the public key
    let fingerprint: string;
    if (body.provider === 'nostr') {
      fingerprint = body.public_key.toLowerCase();
    } else {
      fingerprint = fingerprintPublicKey(body.public_key);
    }

    // Check for existing pending request with the same fingerprint
    const existing = await this.accessRequests.findPendingByFingerprint(fingerprint);
    if (existing) {
      // Return existing request (idempotent)
      return toResponse(existing);
    }

    // Validate slug if provided
    if (body.desired_org_slug) {
      const parsed = OrgSlugSchema.safeParse(body.desired_org_slug);
      if (!parsed.success) {
        throw new BadRequestException(`Invalid org slug: ${parsed.error.issues.map(i => i.message).join('; ')}`);
      }
    }

    const id = generateAccessRequestId();
    const request = await this.accessRequests.create({
      id,
      provider: body.provider,
      public_key: body.public_key,
      fingerprint,
      email: body.email,
      desired_org_name: body.desired_org_name,
      desired_org_slug: body.desired_org_slug,
    });

    this.logger.log(`Access request created: ${id} (${body.provider}, org=${body.desired_org_name})`);
    return toResponse(request);
  }

  @Get('auth/request-access/:id')
  @Public()
  @ApiOperation({ summary: 'Poll access request status (unauthenticated)' })
  async pollRequest(@Param('id') id: string): Promise<AccessRequestResponse> {
    const request = await this.accessRequests.findById(id);
    if (!request) {
      throw new NotFoundException('Access request not found');
    }
    return toResponse(request);
  }

  // ============================================================
  // Admin — authenticated
  // ============================================================

  @Get('admin/access-requests')
  @RequirePermission('system:admin')
  @ApiOperation({ summary: 'List pending access requests (admin)' })
  @ApiOkResponse({
    description: 'Pending access requests',
    schema: zodSchemaToOpenApi(AccessRequestListResponseSchema, 'AccessRequestListResponse'),
  })
  async listRequests(): Promise<AccessRequestListResponse> {
    const requests = await this.accessRequests.listPending();
    return { data: requests.map(toResponse) };
  }

  @Post('admin/access-requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('system:admin')
  @ApiOperation({ summary: 'Approve an access request and provision org + user' })
  async approveRequest(
    @Param('id') id: string,
    @Body() body: { notes?: string } | undefined,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<AccessRequestResponse> {
    const adminUserId = caller?.user_id;
    if (!adminUserId) {
      throw new UnauthorizedException('Authorization required');
    }

    try {
      const updated = await this.db.begin(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const txAccessRequests = accessRequestQueries(tx);
        const txUsers = userQueries(tx);
        const txIdentities = identityQueries(tx);
        const txMemberships = membershipQueries(tx);
        const txOrgs = orgQueries(tx);
        const [accessReq] = await tx<AccessRequest[]>`
          SELECT * FROM access_requests
          WHERE id = ${id}
          FOR UPDATE
        `;

        if (!accessReq) {
          throw new NotFoundException('Access request not found');
        }
        if (accessReq.status === 'approved') {
          return accessReq;
        }
        if (accessReq.status !== 'pending') {
          throw new ConflictException(`Access request is already ${accessReq.status}`);
        }

        const orgSlug = accessReq.desired_org_slug ?? this.deriveSlug(accessReq.desired_org_name);

        // Recover safely from legacy partial failures where org was created but request stayed pending.
        const existingOrg = await txOrgs.findBySlug(orgSlug);
        let orgId: string;
        if (existingOrg) {
          if (existingOrg.name.toLowerCase() !== accessReq.desired_org_name.toLowerCase()) {
            throw new ConflictException(`Organization slug "${orgSlug}" already exists`);
          }
          orgId = existingOrg.id;
        } else {
          const org = await txOrgs.create({
            id: generateOrgId(),
            name: accessReq.desired_org_name,
            slug: orgSlug,
          });
          orgId = org.id;
        }

        // Reuse existing identity owner when fingerprint is already registered.
        let userId: string;
        let reusedIdentity = false;
        const existingIdentity = await txIdentities.findByFingerprint(accessReq.provider, accessReq.fingerprint);
        if (existingIdentity) {
          reusedIdentity = true;
          userId = existingIdentity.user_id;
          const identityUser = await txUsers.findById(userId);
          if (!identityUser) {
            throw new ConflictException('Identity points to a missing user');
          }
          if (accessReq.email && identityUser.email.toLowerCase() !== accessReq.email.toLowerCase()) {
            const emailOwner = await txUsers.findByEmail(accessReq.email);
            if (!emailOwner || emailOwner.id === identityUser.id) {
              await txUsers.update(identityUser.id, { email: accessReq.email });
            }
          }
        } else {
          const email = accessReq.email ?? `${orgSlug}@eve.local`;
          const user = await txUsers.create({
            id: generateUserId(),
            email,
            display_name: accessReq.desired_org_name,
            is_admin: false,
          });
          userId = user.id;
          await txIdentities.create({
            id: generateIdentityId(),
            user_id: userId,
            provider: accessReq.provider,
            public_key: accessReq.public_key,
            fingerprint: accessReq.fingerprint,
            label: 'access-request',
          });
        }

        // Preserve owner role and only promote non-owners to admin.
        const membership = await txMemberships.findOrgMembership(userId, orgId);
        const desiredRole = membership?.role === 'owner' ? 'owner' : 'admin';
        await txMemberships.upsertOrgMembership(orgId, userId, desiredRole);

        const notes = this.combineReviewNotes(
          body?.notes,
          existingOrg ? 'reused existing org' : null,
          reusedIdentity ? 'reused existing identity owner' : null,
        );
        const approved = await txAccessRequests.approve(id, adminUserId, userId, orgId, notes);
        if (!approved) {
          throw new ConflictException('Access request state changed, please retry');
        }

        return approved;
      });

      this.logger.log(`Access request approved: ${id} → user=${updated.user_id}, org=${updated.org_id}`);
      return toResponse(updated);
    } catch (error) {
      this.rethrowKnownApprovalErrors(error);
      throw error;
    }
  }

  @Post('admin/access-requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('system:admin')
  @ApiOperation({ summary: 'Reject an access request' })
  async rejectRequest(
    @Param('id') id: string,
    @Body() body: { notes?: string } | undefined,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<AccessRequestResponse> {
    const adminUserId = caller?.user_id;
    if (!adminUserId) {
      throw new UnauthorizedException('Authorization required');
    }

    const accessReq = await this.accessRequests.findById(id);
    if (!accessReq) {
      throw new NotFoundException('Access request not found');
    }
    if (accessReq.status !== 'pending') {
      throw new ConflictException(`Access request is already ${accessReq.status}`);
    }

    const updated = await this.accessRequests.reject(id, adminUserId, body?.notes);
    this.logger.log(`Access request rejected: ${id}`);
    return toResponse(updated!);
  }

  // ---- Helpers ----

  private deriveSlug(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 12);
    if (slug.length < 2 || !/^[a-z]/.test(slug)) {
      return `org${slug}`.slice(0, 12);
    }
    return slug;
  }

  private combineReviewNotes(...notes: Array<string | null | undefined>): string | null {
    const clean = notes
      .map((note) => note?.trim())
      .filter((note): note is string => Boolean(note));
    if (clean.length === 0) {
      return null;
    }
    return clean.join('; ');
  }

  private rethrowKnownApprovalErrors(error: unknown): void {
    if (!(error instanceof Error)) {
      return;
    }
    if (
      error instanceof NotFoundException ||
      error instanceof ConflictException ||
      error instanceof UnauthorizedException
    ) {
      throw error;
    }
    const pgError = error as PostgresLikeError;
    if (pgError.code === '23505' && pgError.constraint === 'identities_provider_fingerprint_key') {
      throw new ConflictException('Identity fingerprint is already registered');
    }
    if (pgError.code === '23505' && pgError.constraint === 'orgs_slug_key') {
      throw new ConflictException('Organization slug already exists');
    }
    if (pgError.code === '23505' && pgError.constraint === 'users_email_key') {
      throw new ConflictException('User email already exists');
    }
  }
}
