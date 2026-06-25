import { Injectable, Inject, NotFoundException, ForbiddenException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { userQueries, membershipQueries, type UserWithMemberships } from '@eve/db';

@Injectable()
export class UsersService {
  private users: ReturnType<typeof userQueries>;
  private memberships: ReturnType<typeof membershipQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.users = userQueries(db);
    this.memberships = membershipQueries(db);
  }

  async show(targetUserId: string, callerId: string | undefined, isAdmin: boolean) {
    const user = await this.users.findByIdWithMemberships(targetUserId);
    if (!user) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    // System admins see everything
    if (isAdmin) {
      return this.toResponse(user);
    }

    // Non-admins can only see users who share an org
    if (!callerId) {
      throw new ForbiddenException('Authentication required');
    }

    if (callerId === targetUserId) {
      return this.toResponse(user);
    }

    // Check if caller shares any org with the target user
    const callerOrgMemberships = await this.memberships.listOrgMembershipsForUser(callerId);
    const callerOrgIds = new Set(callerOrgMemberships.map((m) => m.org_id));
    const sharedOrgs = user.memberships.filter((m) => callerOrgIds.has(m.org_id));

    if (sharedOrgs.length === 0) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    // Filter memberships to only shared orgs
    const sharedOrgIds = new Set(sharedOrgs.map((m) => m.org_id));
    return this.toResponse({
      ...user,
      memberships: user.memberships.filter((m) => sharedOrgIds.has(m.org_id)),
      project_memberships: user.project_memberships.filter((pm) => {
        // Find the org for this project via the org_slug on the project membership
        const orgMatch = user.memberships.find((om) => om.org_slug === pm.org_slug);
        return orgMatch && sharedOrgIds.has(orgMatch.org_id);
      }),
    });
  }

  private toResponse(user: UserWithMemberships) {
    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      is_admin: user.is_admin,
      created_at: user.created_at instanceof Date ? user.created_at.toISOString() : user.created_at,
      memberships: user.memberships,
      project_memberships: user.project_memberships,
    };
  }
}
