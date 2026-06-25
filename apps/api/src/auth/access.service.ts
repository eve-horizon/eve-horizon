import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  type Db,
  membershipQueries,
  projectQueries,
  servicePrincipalQueries,
  accessRoleQueries,
  accessGroupQueries,
  type AccessBindingWithRole,
} from '@eve/db';
import type {
  AccessCanResponse,
  AccessExplainResponse,
  AccessExplainGrant,
  AccessPrincipalMembershipsResponse,
  AccessBindingScope,
  AccessEffectiveScopeSummary,
} from '@eve/shared';
import { RbacService } from './rbac.service.js';
import { expandPermissions, allPermissions, type Permission } from './permissions.js';

type AccessPrincipalType = 'user' | 'service_principal' | 'group';
type AccessResourceType = 'orgfs' | 'orgdocs' | 'envdb' | 'cloud_fs';
type AccessResourceAction = 'read' | 'write' | 'admin';

type AccessResourceContext = {
  type: AccessResourceType;
  id: string;
  action: AccessResourceAction;
};

type RawGrant = {
  source: string;
  role?: string;
  permissions: string[];
  scope_json?: AccessBindingScope | null;
};

type ScopeEvaluation = {
  scope_required: boolean;
  scope_matched: boolean;
  reason?: string;
};

type PermissionEvaluation = {
  allowed: boolean;
  source: string;
  permissionMatched: boolean;
  scopeRequired: boolean;
  scopeMatched: boolean;
  deniedByScope: boolean;
  grants: AccessExplainGrant[];
};

@Injectable()
export class AccessService {
  private readonly membershipStore: ReturnType<typeof membershipQueries>;
  private readonly projects: ReturnType<typeof projectQueries>;
  private readonly spQueries: ReturnType<typeof servicePrincipalQueries>;
  private readonly accessRoles: ReturnType<typeof accessRoleQueries>;
  private readonly accessGroups: ReturnType<typeof accessGroupQueries>;

  constructor(
    private readonly rbacService: RbacService,
    @Inject('DB') private readonly db: Db,
  ) {
    this.membershipStore = membershipQueries(db);
    this.projects = projectQueries(db);
    this.spQueries = servicePrincipalQueries(db);
    this.accessRoles = accessRoleQueries(db);
    this.accessGroups = accessGroupQueries(db);
  }

  /**
   * Check if a principal can perform an action.
   */
  async can(params: {
    org_id: string;
    principal_type: AccessPrincipalType;
    principal_id: string;
    project_id?: string;
    permission: string;
    resource?: AccessResourceContext;
  }): Promise<AccessCanResponse> {
    this.validatePermission(params.permission);

    let evaluation: PermissionEvaluation;

    if (params.principal_type === 'service_principal') {
      evaluation = await this.canServicePrincipal(
        params.org_id,
        params.principal_id,
        params.permission,
        params.resource,
      );
    } else if (params.principal_type === 'group') {
      evaluation = await this.canGroup(
        params.org_id,
        params.principal_id,
        params.project_id,
        params.permission,
        params.resource,
      );
    } else {
      evaluation = await this.canUser(
        params.org_id,
        params.principal_id,
        params.project_id,
        params.permission,
        params.resource,
      );
    }

    const response: AccessCanResponse = {
      allowed: evaluation.allowed,
      source: evaluation.source,
    };

    if (params.resource) {
      response.resource = {
        type: params.resource.type,
        id: params.resource.id,
        action: params.resource.action,
        scope_required: evaluation.scopeRequired,
        scope_matched: evaluation.scopeMatched,
      };
    }

    return response;
  }

  /**
   * Explain the full permission resolution chain.
   */
  async explain(params: {
    org_id: string;
    principal_type: AccessPrincipalType;
    principal_id: string;
    project_id?: string;
    permission: string;
    resource?: AccessResourceContext;
  }): Promise<AccessExplainResponse> {
    this.validatePermission(params.permission);

    let response: AccessExplainResponse;

    if (params.principal_type === 'service_principal') {
      response = await this.explainServicePrincipal(
        params.org_id,
        params.principal_id,
        params.permission,
        params.resource,
      );
    } else if (params.principal_type === 'group') {
      response = await this.explainGroup(
        params.org_id,
        params.principal_id,
        params.project_id,
        params.permission,
        params.resource,
      );
    } else {
      response = await this.explainUser(
        params.org_id,
        params.principal_id,
        params.project_id,
        params.permission,
        params.resource,
      );
    }

    if (params.resource) {
      const scopeRequired = this.scopeRequiredForPermission(params.permission);
      const scopeMatched =
        scopeRequired
          ? response.grants.some((grant) => grant.has_permission && grant.scope_match === true)
          : response.result === 'ALLOWED';

      response.resource = {
        type: params.resource.type,
        id: params.resource.id,
        action: params.resource.action,
        scope_required: scopeRequired,
        scope_matched: scopeMatched,
      };
    }

    return response;
  }

  async memberships(params: {
    org_id: string;
    principal_type: AccessPrincipalType;
    principal_id: string;
  }): Promise<AccessPrincipalMembershipsResponse> {
    if (params.principal_type === 'service_principal') {
      return this.membershipsForServicePrincipal(params.org_id, params.principal_id);
    }

    if (params.principal_type === 'group') {
      return this.membershipsForGroup(params.org_id, params.principal_id);
    }

    return this.membershipsForUser(params.org_id, params.principal_id);
  }

  // ── User resolution ──────────────────────────────────────────────────

  private async canUser(
    orgId: string,
    userId: string,
    projectId: string | undefined,
    permission: string,
    resource?: AccessResourceContext,
  ): Promise<PermissionEvaluation> {
    const grants = await this.collectUserGrants(orgId, userId, projectId);
    return this.evaluatePermission(permission, grants, resource);
  }

  private async explainUser(
    orgId: string,
    userId: string,
    projectId: string | undefined,
    permission: string,
    resource?: AccessResourceContext,
  ): Promise<AccessExplainResponse> {
    const grants = await this.collectUserGrants(orgId, userId, projectId);
    const evaluated = this.evaluatePermission(permission, grants, resource);

    const result = evaluated.allowed ? 'ALLOWED' : 'DENIED';
    let missingReason: string | undefined;
    if (!evaluated.allowed) {
      if (evaluated.permissionMatched && evaluated.deniedByScope) {
        missingReason = this.scopeMissingReason(permission, resource);
      } else {
        missingReason = this.suggestRequiredRole(permission);
      }
    }

    return {
      permission,
      result,
      grants: evaluated.grants,
      missing_reason: missingReason,
    };
  }

  private async collectUserGrants(
    orgId: string,
    userId: string,
    projectId?: string,
  ): Promise<RawGrant[]> {
    const grants: RawGrant[] = [];

    if (projectId) {
      const project = await this.resolveProject(projectId);
      if (project && project.org_id === orgId) {
        const projectMembership = await this.membershipStore.findProjectMembership(userId, project.id);
        if (projectMembership) {
          grants.push({
            source: `project membership (${project.id})`,
            role: projectMembership.role,
            permissions: [...expandPermissions(projectMembership.role)] as string[],
            scope_json: AccessService.BUILT_IN_ROLES.has(projectMembership.role)
              ? AccessService.BUILT_IN_ROLE_SCOPE
              : undefined,
          });
        }
      }
    }

    const orgMembership = await this.membershipStore.findOrgMembership(userId, orgId);
    if (orgMembership) {
      grants.push({
        source: `org membership (${orgId})`,
        role: orgMembership.role,
        permissions: [...expandPermissions(orgMembership.role)] as string[],
        scope_json: AccessService.BUILT_IN_ROLES.has(orgMembership.role)
          ? AccessService.BUILT_IN_ROLE_SCOPE
          : undefined,
      });
    }

    const bindings = await this.accessRoles.listApplicableBindings({
      orgId,
      principalType: 'user',
      principalId: userId,
      projectId,
    });

    for (const binding of bindings) {
      const scopeLabel = this.describeBindingScope(binding, orgId);
      grants.push({
        source: this.describeBindingSource(binding, scopeLabel),
        role: binding.role_name,
        permissions: binding.role_permissions,
        scope_json: this.asBindingScope(binding.scope_json),
      });
    }

    return grants;
  }

  // ── Service principal resolution ─────────────────────────────────────

  private async canServicePrincipal(
    orgId: string,
    principalId: string,
    permission: string,
    resource?: AccessResourceContext,
  ): Promise<PermissionEvaluation> {
    const sp = await this.spQueries.getServicePrincipal(orgId, principalId);
    if (!sp) {
      return {
        allowed: false,
        source: 'service principal not found',
        permissionMatched: false,
        scopeRequired: this.scopeRequiredForPermission(permission),
        scopeMatched: false,
        deniedByScope: false,
        grants: [],
      };
    }

    const grants = await this.collectServicePrincipalGrants(orgId, sp.id);
    return this.evaluatePermission(permission, grants, resource);
  }

  private async explainServicePrincipal(
    orgId: string,
    principalId: string,
    permission: string,
    resource?: AccessResourceContext,
  ): Promise<AccessExplainResponse> {
    const sp = await this.spQueries.getServicePrincipal(orgId, principalId);
    if (!sp) {
      return {
        permission,
        result: 'DENIED',
        grants: [],
        missing_reason: `service principal ${principalId} not found in org ${orgId}`,
      };
    }

    const grants = await this.collectServicePrincipalGrants(orgId, sp.id);
    const evaluated = this.evaluatePermission(permission, grants, resource);

    const result = evaluated.allowed ? 'ALLOWED' : 'DENIED';
    let missingReason: string | undefined;
    if (!evaluated.allowed) {
      if (evaluated.permissionMatched && evaluated.deniedByScope) {
        missingReason = this.scopeMissingReason(permission, resource);
      } else {
        missingReason =
          evaluated.grants.length === 0
            ? `no active tokens on service principal ${sp.name}`
            : `no active token or custom role includes ${permission}`;
      }
    }

    return {
      permission,
      result,
      grants: evaluated.grants,
      missing_reason: missingReason,
    };
  }

  private async collectServicePrincipalGrants(
    orgId: string,
    principalId: string,
  ): Promise<RawGrant[]> {
    const grants: RawGrant[] = [];
    const now = new Date();

    const tokens = await this.spQueries.listTokens(principalId);
    for (const token of tokens) {
      if (token.expires_at <= now) {
        continue;
      }
      grants.push({
        source: `token ${token.id} (expires ${token.expires_at.toISOString()})`,
        permissions: token.scopes,
      });
    }

    const bindings = await this.accessRoles.listApplicableBindings({
      orgId,
      principalType: 'service_principal',
      principalId,
    });

    for (const binding of bindings) {
      const scopeLabel = this.describeBindingScope(binding, orgId);
      grants.push({
        source: this.describeBindingSource(binding, scopeLabel),
        role: binding.role_name,
        permissions: binding.role_permissions,
        scope_json: this.asBindingScope(binding.scope_json),
      });
    }

    return grants;
  }

  // ── Group resolution ─────────────────────────────────────────────────

  private async canGroup(
    orgId: string,
    groupInput: string,
    projectId: string | undefined,
    permission: string,
    resource?: AccessResourceContext,
  ): Promise<PermissionEvaluation> {
    const group = await this.resolveGroup(orgId, groupInput);
    if (!group) {
      return {
        allowed: false,
        source: 'group not found',
        permissionMatched: false,
        scopeRequired: this.scopeRequiredForPermission(permission),
        scopeMatched: false,
        deniedByScope: false,
        grants: [],
      };
    }

    const grants = await this.collectGroupGrants(orgId, group.id, projectId);
    return this.evaluatePermission(permission, grants, resource);
  }

  private async explainGroup(
    orgId: string,
    groupInput: string,
    projectId: string | undefined,
    permission: string,
    resource?: AccessResourceContext,
  ): Promise<AccessExplainResponse> {
    const group = await this.resolveGroup(orgId, groupInput);
    if (!group) {
      return {
        permission,
        result: 'DENIED',
        grants: [],
        missing_reason: `group ${groupInput} not found in org ${orgId}`,
      };
    }

    const grants = await this.collectGroupGrants(orgId, group.id, projectId);
    const evaluated = this.evaluatePermission(permission, grants, resource);

    let missingReason: string | undefined;
    if (!evaluated.allowed) {
      missingReason = evaluated.permissionMatched && evaluated.deniedByScope
        ? this.scopeMissingReason(permission, resource)
        : `group ${group.id} is missing ${permission}`;
    }

    return {
      permission,
      result: evaluated.allowed ? 'ALLOWED' : 'DENIED',
      grants: evaluated.grants,
      missing_reason: missingReason,
    };
  }

  private async collectGroupGrants(
    orgId: string,
    groupId: string,
    projectId?: string,
  ): Promise<RawGrant[]> {
    const bindings = await this.accessRoles.listApplicableBindings({
      orgId,
      principalType: 'group',
      principalId: groupId,
      projectId,
    });

    return bindings.map((binding) => {
      const scopeLabel = this.describeBindingScope(binding, orgId);
      return {
        source: this.describeBindingSource(binding, scopeLabel),
        role: binding.role_name,
        permissions: binding.role_permissions,
        scope_json: this.asBindingScope(binding.scope_json),
      } as RawGrant;
    });
  }

  // ── Membership introspection ─────────────────────────────────────────

  private async membershipsForUser(
    orgId: string,
    userId: string,
  ): Promise<AccessPrincipalMembershipsResponse> {
    const [orgMembership, projectMemberships, groups, directBindings, effectiveBindings] = await Promise.all([
      this.membershipStore.findOrgMembership(userId, orgId),
      this.membershipStore.listProjectMembershipsForUser(userId, { org_id: orgId }),
      this.accessGroups.listGroupsForPrincipal(orgId, 'user', userId),
      this.accessRoles.listBindings({ orgId, principalType: 'user', principalId: userId }),
      this.accessRoles.listApplicableBindings({ orgId, principalType: 'user', principalId: userId }),
    ]);

    const effectivePermissions = new Set<string>();

    if (orgMembership) {
      for (const perm of expandPermissions(orgMembership.role)) {
        effectivePermissions.add(perm);
      }
    }

    for (const projectMembership of projectMemberships) {
      for (const perm of expandPermissions(projectMembership.role)) {
        effectivePermissions.add(perm);
      }
    }

    for (const binding of effectiveBindings) {
      for (const perm of binding.role_permissions) {
        effectivePermissions.add(perm);
      }
    }

    return {
      org_id: orgId,
      principal_type: 'user',
      principal_id: userId,
      base: {
        org_role: orgMembership?.role ?? null,
        project_roles: projectMemberships.map((membership) => ({
          project_id: membership.project_id,
          role: membership.role,
        })),
        token_scopes: [],
      },
      groups: groups.map((group) => ({
        id: group.group_id,
        slug: group.group_slug,
        name: group.group_name,
      })),
      direct_bindings: directBindings.map((binding) => this.toBindingResponse(binding)),
      effective_bindings: effectiveBindings.map((binding) => this.toResolvedBindingResponse(binding)),
      effective_permissions: [...effectivePermissions].sort(),
      effective_scopes: this.summarizeScopes(effectiveBindings),
    };
  }

  private async membershipsForServicePrincipal(
    orgId: string,
    principalId: string,
  ): Promise<AccessPrincipalMembershipsResponse> {
    const principal = await this.spQueries.getServicePrincipal(orgId, principalId);
    if (!principal) {
      throw new NotFoundException(`Service principal ${principalId} not found in org ${orgId}`);
    }

    const [tokens, groups, directBindings, effectiveBindings] = await Promise.all([
      this.spQueries.listTokens(principal.id),
      this.accessGroups.listGroupsForPrincipal(orgId, 'service_principal', principal.id),
      this.accessRoles.listBindings({
        orgId,
        principalType: 'service_principal',
        principalId: principal.id,
      }),
      this.accessRoles.listApplicableBindings({
        orgId,
        principalType: 'service_principal',
        principalId: principal.id,
      }),
    ]);

    const now = new Date();
    const tokenScopes = new Set<string>();
    for (const token of tokens) {
      if (token.expires_at <= now) {
        continue;
      }
      for (const scope of token.scopes) {
        tokenScopes.add(scope);
      }
    }

    const effectivePermissions = new Set<string>(tokenScopes);
    for (const binding of effectiveBindings) {
      for (const perm of binding.role_permissions) {
        effectivePermissions.add(perm);
      }
    }

    return {
      org_id: orgId,
      principal_type: 'service_principal',
      principal_id: principal.id,
      base: {
        org_role: null,
        project_roles: [],
        token_scopes: [...tokenScopes].sort(),
      },
      groups: groups.map((group) => ({
        id: group.group_id,
        slug: group.group_slug,
        name: group.group_name,
      })),
      direct_bindings: directBindings.map((binding) => this.toBindingResponse(binding)),
      effective_bindings: effectiveBindings.map((binding) => this.toResolvedBindingResponse(binding)),
      effective_permissions: [...effectivePermissions].sort(),
      effective_scopes: this.summarizeScopes(effectiveBindings),
    };
  }

  private async membershipsForGroup(
    orgId: string,
    groupInput: string,
  ): Promise<AccessPrincipalMembershipsResponse> {
    const group = await this.resolveGroup(orgId, groupInput);
    if (!group) {
      throw new NotFoundException(`Access group ${groupInput} not found in org ${orgId}`);
    }

    const [directBindings, effectiveBindings] = await Promise.all([
      this.accessRoles.listBindings({ orgId, principalType: 'group', principalId: group.id }),
      this.accessRoles.listApplicableBindings({ orgId, principalType: 'group', principalId: group.id }),
    ]);

    const effectivePermissions = new Set<string>();
    for (const binding of effectiveBindings) {
      for (const perm of binding.role_permissions) {
        effectivePermissions.add(perm);
      }
    }

    return {
      org_id: orgId,
      principal_type: 'group',
      principal_id: group.id,
      base: {
        org_role: null,
        project_roles: [],
        token_scopes: [],
      },
      groups: [],
      direct_bindings: directBindings.map((binding) => this.toBindingResponse(binding)),
      effective_bindings: effectiveBindings.map((binding) => this.toResolvedBindingResponse(binding)),
      effective_permissions: [...effectivePermissions].sort(),
      effective_scopes: this.summarizeScopes(effectiveBindings),
    };
  }

  // ── Built-in role scope ───────────────────────────────────────────────

  /**
   * Built-in roles (owner, admin, member) include scoped permissions like
   * envdb:read/write, but org/project membership grants have no scope_json.
   * Without a scope, the evaluator rejects the permission even though the
   * role explicitly includes it.
   *
   * This constant provides wildcard scope for all scoped resource types,
   * applied only to built-in role grants. The permission set still gates
   * what operations (read/write/admin) are allowed.
   */
  private static readonly BUILT_IN_ROLE_SCOPE: AccessBindingScope = {
    envdb: { schemas: ['*'], tables: ['*'] },
    orgfs: { allow_prefixes: ['*'] },
    orgdocs: { allow_prefixes: ['*'] },
    cloud_fs: { allow_mount_ids: ['*'] },
  };

  private static readonly BUILT_IN_ROLES = new Set(['owner', 'admin', 'member']);

  // ── Evaluator helpers ────────────────────────────────────────────────

  private evaluatePermission(
    permission: string,
    grants: RawGrant[],
    resource?: AccessResourceContext,
  ): PermissionEvaluation {
    const scopeRequired = this.scopeRequiredForPermission(permission);
    let allowed = false;
    let source = 'no grant found';
    let permissionMatched = false;
    let scopeMatched = !scopeRequired;
    let deniedByScope = false;

    const explainGrants: AccessExplainGrant[] = [];

    for (const grant of grants) {
      const hasPermission = grant.permissions.includes(permission);
      let scopeEval: ScopeEvaluation | null = null;

      if (hasPermission) {
        permissionMatched = true;
        scopeEval = this.evaluateScope(grant.scope_json, permission, resource);

        if (!scopeEval.scope_required || scopeEval.scope_matched) {
          if (!allowed) {
            source = grant.source;
          }
          allowed = true;
          if (scopeEval.scope_required) {
            scopeMatched = true;
          }
        } else {
          deniedByScope = true;
          if (!allowed) {
            source = 'permission grant found but resource scope denied';
          }
        }
      }

      const explainedGrant: AccessExplainGrant = {
        source: grant.source,
        role: grant.role,
        permissions: grant.permissions,
        has_permission: hasPermission,
      };

      if (grant.scope_json !== undefined) {
        explainedGrant.scope_json = grant.scope_json;
      }

      if (hasPermission && scopeEval?.scope_required) {
        explainedGrant.scope_json = grant.scope_json ?? null;
        explainedGrant.scope_match = scopeEval.scope_matched;
        explainedGrant.scope_reason = scopeEval.reason;
      }

      explainGrants.push(explainedGrant);
    }

    if (!permissionMatched) {
      source = 'no grant found';
      scopeMatched = false;
    }

    if (!scopeRequired) {
      scopeMatched = allowed;
    }

    return {
      allowed,
      source,
      permissionMatched,
      scopeRequired,
      scopeMatched,
      deniedByScope,
      grants: explainGrants,
    };
  }

  evaluateScope(
    scope: AccessBindingScope | null | undefined,
    permission: string,
    resource?: AccessResourceContext,
  ): ScopeEvaluation {
    const resourceType = this.permissionResourceType(permission);
    if (!resourceType) {
      return {
        scope_required: false,
        scope_matched: true,
      };
    }

    if (!scope) {
      return {
        scope_required: true,
        scope_matched: false,
        reason: `missing ${resourceType} scope on grant`,
      };
    }

    if (resourceType === 'orgfs' || resourceType === 'orgdocs') {
      return this.evaluatePrefixScope(resourceType, scope[resourceType], resource);
    }

    if (resourceType === 'envdb') {
      return this.evaluateEnvDbScope(scope.envdb, resource);
    }

    return this.evaluateCloudFsScope(scope.cloud_fs, resource);
  }

  private evaluatePrefixScope(
    resourceType: 'orgfs' | 'orgdocs',
    scope: AccessBindingScope['orgfs'] | AccessBindingScope['orgdocs'] | undefined,
    resource?: AccessResourceContext,
  ): ScopeEvaluation {
    const allowPrefixes = scope?.allow_prefixes ?? [];
    const readOnlyPrefixes = scope?.read_only_prefixes ?? [];

    if (allowPrefixes.length === 0 && readOnlyPrefixes.length === 0) {
      return {
        scope_required: true,
        scope_matched: false,
        reason: `missing ${resourceType} scope prefixes`,
      };
    }

    if (!resource) {
      return {
        scope_required: true,
        scope_matched: true,
        reason: `${resourceType} scope present`,
      };
    }

    if (resource.type !== resourceType) {
      return {
        scope_required: true,
        scope_matched: false,
        reason: `resource type ${resource.type} does not match required ${resourceType}`,
      };
    }

    const resourcePath = this.normalizeScopedPath(resource.id);
    const matchesAllow = allowPrefixes.some((pattern) => this.matchesPathPattern(pattern, resourcePath));
    const matchesReadOnly = readOnlyPrefixes.some((pattern) => this.matchesPathPattern(pattern, resourcePath));

    if (resource.action === 'read') {
      if (matchesAllow || matchesReadOnly) {
        return {
          scope_required: true,
          scope_matched: true,
          reason: `resource path ${resourcePath} is in allowed scope`,
        };
      }

      return {
        scope_required: true,
        scope_matched: false,
        reason: `resource path ${resourcePath} is outside allowed scope`,
      };
    }

    if (matchesAllow) {
      return {
        scope_required: true,
        scope_matched: true,
        reason: `resource path ${resourcePath} is writable in scope`,
      };
    }

    if (matchesReadOnly) {
      return {
        scope_required: true,
        scope_matched: false,
        reason: `resource path ${resourcePath} is read-only`,
      };
    }

    return {
      scope_required: true,
      scope_matched: false,
      reason: `resource path ${resourcePath} is outside writable scope`,
    };
  }

  private evaluateEnvDbScope(
    scope: AccessBindingScope['envdb'] | undefined,
    resource?: AccessResourceContext,
  ): ScopeEvaluation {
    const schemas = scope?.schemas ?? [];
    const tables = scope?.tables ?? [];

    if (schemas.length === 0 && tables.length === 0) {
      return {
        scope_required: true,
        scope_matched: false,
        reason: 'missing envdb schema/table scope',
      };
    }

    if (!resource) {
      return {
        scope_required: true,
        scope_matched: true,
        reason: 'envdb scope present',
      };
    }

    if (resource.type !== 'envdb') {
      return {
        scope_required: true,
        scope_matched: false,
        reason: `resource type ${resource.type} does not match required envdb`,
      };
    }

    const identifier = resource.id.trim();
    if (!identifier) {
      return {
        scope_required: true,
        scope_matched: false,
        reason: 'envdb resource id cannot be empty',
      };
    }

    const [schemaPart, ...tableParts] = identifier.split('.');
    const schema = schemaPart.trim();
    const tableName = tableParts.join('.').trim();

    const schemaMatched = schemas.some((pattern) => this.matchesIdentifierPattern(pattern, schema));

    if (!tableName) {
      return {
        scope_required: true,
        scope_matched: schemaMatched,
        reason: schemaMatched
          ? `schema ${schema} is in envdb scope`
          : `schema ${schema} is outside envdb scope`,
      };
    }

    const tableIdentifier = `${schema}.${tableName}`;
    const tableMatched = tables.some((pattern) => this.matchesIdentifierPattern(pattern, tableIdentifier));

    if (schemaMatched || tableMatched) {
      return {
        scope_required: true,
        scope_matched: true,
        reason: `table ${tableIdentifier} is in envdb scope`,
      };
    }

    return {
      scope_required: true,
      scope_matched: false,
      reason: `table ${tableIdentifier} is outside envdb scope`,
    };
  }

  private evaluateCloudFsScope(
    scope: AccessBindingScope['cloud_fs'] | undefined,
    resource?: AccessResourceContext,
  ): ScopeEvaluation {
    const allow = scope?.allow_mount_ids ?? [];

    if (allow.length === 0) {
      return {
        scope_required: true,
        scope_matched: false,
        reason: 'missing cloud_fs.allow_mount_ids',
      };
    }

    if (!resource) {
      return {
        scope_required: true,
        scope_matched: true,
        reason: 'cloud_fs scope present',
      };
    }

    if (resource.type !== 'cloud_fs') {
      return {
        scope_required: true,
        scope_matched: false,
        reason: `resource type ${resource.type} does not match required cloud_fs`,
      };
    }

    if (allow.includes('*') || allow.includes(resource.id)) {
      return {
        scope_required: true,
        scope_matched: true,
        reason: `mount ${resource.id} is in cloud_fs scope`,
      };
    }

    return {
      scope_required: true,
      scope_matched: false,
      reason: `mount ${resource.id} is outside cloud_fs scope`,
    };
  }

  private permissionResourceType(permission: string): AccessResourceType | null {
    if (permission.startsWith('orgfs:')) return 'orgfs';
    if (permission.startsWith('orgdocs:')) return 'orgdocs';
    if (permission.startsWith('envdb:')) return 'envdb';
    if (permission.startsWith('cloud_fs:')) return 'cloud_fs';
    return null;
  }

  private scopeRequiredForPermission(permission: string): boolean {
    return this.permissionResourceType(permission) !== null;
  }

  private scopeMissingReason(permission: string, resource?: AccessResourceContext): string {
    const resourceType = this.permissionResourceType(permission);
    if (!resourceType) {
      return `missing required permission ${permission}`;
    }

    if (resource) {
      return `${permission} grant found but resource '${resource.id}' is outside ${resourceType} scope`;
    }

    return `${permission} requires an explicit ${resourceType} scoped grant`;
  }

  private normalizeScopedPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) {
      return '/';
    }

    const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return normalized.replace(/\/+/g, '/');
  }

  private matchesPathPattern(pattern: string, value: string): boolean {
    const normalizedPattern = this.normalizeScopedPath(pattern);
    const normalizedValue = this.normalizeScopedPath(value);

    if (!normalizedPattern.includes('*')) {
      if (normalizedValue === normalizedPattern) {
        return true;
      }
      const prefix = normalizedPattern.endsWith('/')
        ? normalizedPattern
        : `${normalizedPattern}/`;
      return normalizedValue.startsWith(prefix);
    }

    const patternSource = this.wildcardPathToRegExpSource(normalizedPattern);
    return new RegExp(`^${patternSource}$`).test(normalizedValue);
  }

  private matchesIdentifierPattern(pattern: string, value: string): boolean {
    if (pattern === '*') {
      return true;
    }

    const source = pattern
      .split('*')
      .map((segment) => this.escapeRegExp(segment))
      .join('.*');
    return new RegExp(`^${source}$`).test(value);
  }

  private wildcardPathToRegExpSource(pattern: string): string {
    let source = '';
    for (let i = 0; i < pattern.length; i += 1) {
      const char = pattern[i];
      if (char === '*') {
        if (pattern[i + 1] === '*') {
          source += '.*';
          i += 1;
        } else {
          source += '[^/]*';
        }
        continue;
      }
      source += this.escapeRegExp(char);
    }
    return source;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private summarizeScopes(bindings: AccessBindingWithRole[]): AccessEffectiveScopeSummary {
    const orgfsAllow = new Set<string>();
    const orgfsReadOnly = new Set<string>();
    const orgdocsAllow = new Set<string>();
    const orgdocsReadOnly = new Set<string>();
    const envdbSchemas = new Set<string>();
    const envdbTables = new Set<string>();

    for (const binding of bindings) {
      const scope = this.asBindingScope(binding.scope_json);
      if (!scope) {
        continue;
      }

      for (const prefix of scope.orgfs?.allow_prefixes ?? []) {
        orgfsAllow.add(prefix);
      }
      for (const prefix of scope.orgfs?.read_only_prefixes ?? []) {
        orgfsReadOnly.add(prefix);
      }
      for (const prefix of scope.orgdocs?.allow_prefixes ?? []) {
        orgdocsAllow.add(prefix);
      }
      for (const prefix of scope.orgdocs?.read_only_prefixes ?? []) {
        orgdocsReadOnly.add(prefix);
      }
      for (const schema of scope.envdb?.schemas ?? []) {
        envdbSchemas.add(schema);
      }
      for (const table of scope.envdb?.tables ?? []) {
        envdbTables.add(table);
      }
    }

    return {
      orgfs: {
        allow_prefixes: [...orgfsAllow].sort(),
        read_only_prefixes: [...orgfsReadOnly].sort(),
      },
      orgdocs: {
        allow_prefixes: [...orgdocsAllow].sort(),
        read_only_prefixes: [...orgdocsReadOnly].sort(),
      },
      envdb: {
        schemas: [...envdbSchemas].sort(),
        tables: [...envdbTables].sort(),
      },
    };
  }

  private asBindingScope(scope: unknown): AccessBindingScope | null {
    if (!scope || typeof scope !== 'object') {
      return null;
    }
    return scope as AccessBindingScope;
  }

  private toBindingResponse(binding: AccessBindingWithRole) {
    return {
      id: binding.id,
      role_id: binding.role_id,
      role_name: binding.role_name,
      principal_type: binding.principal_type,
      principal_id: binding.principal_id,
      project_id: binding.project_id,
      scope_json: this.asBindingScope(binding.scope_json),
      created_by: binding.created_by,
      created_at: binding.created_at.toISOString(),
    };
  }

  private toResolvedBindingResponse(binding: AccessBindingWithRole) {
    return {
      ...this.toBindingResponse(binding),
      role_permissions: binding.role_permissions,
      matched_via: binding.matched_via,
      matched_group_id: binding.matched_group_id ?? null,
      matched_group_slug: binding.matched_group_slug ?? null,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private validatePermission(permission: string): void {
    const known = new Set<string>(allPermissions());
    if (!known.has(permission)) {
      throw new BadRequestException(
        `Unknown permission: ${permission}. Valid permissions: ${allPermissions().join(', ')}`,
      );
    }
  }

  /**
   * Suggest which role a user would need to have a given permission.
   */
  private suggestRequiredRole(permission: string): string {
    const roles = ['member', 'admin', 'owner'] as const;
    for (const role of roles) {
      const perms = expandPermissions(role);
      if (perms.has(permission as Permission)) {
        return `${permission} requires ${role} role or higher`;
      }
    }
    return `${permission} is not granted by any standard role`;
  }

  private async resolveProject(projectInput: string): Promise<{ id: string; org_id: string } | null> {
    if (projectInput.startsWith('proj_')) {
      const project = await this.projects.findById(projectInput, { include_deleted: false });
      return project ?? null;
    }

    const [row] = await this.db<{ id: string; org_id: string }[]>`
      SELECT id, org_id FROM projects WHERE slug = ${projectInput} AND deleted_at IS NULL LIMIT 1
    `;
    return row ?? null;
  }

  private async resolveGroup(
    orgId: string,
    groupInput: string,
  ): Promise<{ id: string; slug: string; name: string } | null> {
    const byId = await this.accessGroups.findGroupById(orgId, groupInput);
    if (byId) {
      return {
        id: byId.id,
        slug: byId.slug,
        name: byId.name,
      };
    }

    const bySlug = await this.accessGroups.findGroupBySlug(orgId, groupInput);
    if (bySlug) {
      return {
        id: bySlug.id,
        slug: bySlug.slug,
        name: bySlug.name,
      };
    }

    return null;
  }

  private describeBindingScope(
    binding: { project_id: string | null },
    orgId: string,
  ): string {
    return binding.project_id
      ? `on project ${binding.project_id}`
      : `on org ${orgId}`;
  }

  private describeBindingSource(
    binding: {
      role_name: string;
      matched_via?: 'direct' | 'group';
      matched_group_slug?: string | null;
      matched_group_id?: string | null;
    },
    scopeLabel: string,
  ): string {
    if (binding.matched_via === 'group') {
      const groupRef = binding.matched_group_slug ?? binding.matched_group_id ?? 'group';
      return `custom role '${binding.role_name}' via group '${groupRef}' ${scopeLabel}`;
    }
    return `custom role '${binding.role_name}' ${scopeLabel}`;
  }
}
