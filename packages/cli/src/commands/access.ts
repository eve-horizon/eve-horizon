import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as readline from 'node:readline/promises';
import { parse as parseYaml } from 'yaml';
import type { FlagValue } from '../lib/args';
import { getStringFlag, getBooleanFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, unwrapListResponse } from '../lib/client';
import { outputJson } from '../lib/output';
import { AccessYamlSchema } from '@eve/shared';
import type {
  AccessBindingScope,
  AccessYaml,
  AccessYamlRole,
  AccessYamlBinding,
  AccessYamlGroup,
  AccessYamlGroupMember,
} from '@eve/shared';
import { PERMISSION_SET } from '@eve/shared';

// ── Response types ─────────────────────────────────────────────────────────

type AccessCanResponse = {
  allowed: boolean;
  source: string;
  resource?: {
    type: 'orgfs' | 'orgdocs' | 'envdb';
    id: string;
    action: 'read' | 'write' | 'admin';
    scope_required: boolean;
    scope_matched: boolean;
  };
};

type AccessExplainGrant = {
  source: string;
  role?: string;
  permissions: string[];
  has_permission: boolean;
  scope_json?: unknown;
  scope_match?: boolean;
  scope_reason?: string;
};

type AccessExplainResponse = {
  permission: string;
  result: 'ALLOWED' | 'DENIED';
  grants: AccessExplainGrant[];
  missing_reason?: string;
  resource?: {
    type: 'orgfs' | 'orgdocs' | 'envdb';
    id: string;
    action: 'read' | 'write' | 'admin';
    scope_required: boolean;
    scope_matched: boolean;
  };
};

type AccessRoleResponse = {
  id: string;
  org_id: string;
  name: string;
  scope: string;
  permissions: string[];
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type AccessBindingResponse = {
  id: string;
  role_id: string;
  role_name: string;
  principal_type: string;
  principal_id: string;
  project_id: string | null;
  scope_json?: unknown;
  created_by: string | null;
  created_at: string;
};

type AccessGroupResponse = {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type AccessGroupMemberResponse = {
  group_id: string;
  principal_type: 'user' | 'service_principal';
  principal_id: string;
  added_by: string | null;
  created_at: string;
};

type AccessPrincipalMembershipsResponse = {
  org_id: string;
  principal_type: 'user' | 'service_principal' | 'group';
  principal_id: string;
  base: {
    org_role: 'owner' | 'admin' | 'member' | null;
    project_roles: Array<{ project_id: string; role: 'owner' | 'admin' | 'member' }>;
    token_scopes: string[];
  };
  groups: Array<{ id: string; slug: string; name: string }>;
  direct_bindings: AccessBindingResponse[];
  effective_bindings: Array<AccessBindingResponse & {
    role_permissions: string[];
    matched_via?: 'direct' | 'group';
    matched_group_id?: string | null;
    matched_group_slug?: string | null;
  }>;
  effective_permissions: string[];
  effective_scopes: {
    orgfs: { allow_prefixes: string[]; read_only_prefixes: string[] };
    orgdocs: { allow_prefixes: string[]; read_only_prefixes: string[] };
    envdb: { schemas: string[]; tables: string[] };
  };
};

type PrincipalSelection = {
  principalType: 'user' | 'service_principal' | 'group';
  principalId: string;
};

function resolvePrincipalSelection(
  flags: Record<string, FlagValue>,
  options?: { allowGroup?: boolean },
): PrincipalSelection {
  const userId = getStringFlag(flags, ['user']);
  const spId = getStringFlag(flags, ['service-principal', 'sp']);
  const groupId = options?.allowGroup ? getStringFlag(flags, ['group']) : undefined;

  const selected = [
    userId ? 'user' : null,
    spId ? 'service_principal' : null,
    groupId ? 'group' : null,
  ].filter(Boolean);

  if (selected.length === 0) {
    const groupHint = options?.allowGroup ? ' or --group <group_id>' : '';
    throw new Error(`--user <user_id> or --service-principal <sp_id>${groupHint} is required`);
  }

  if (selected.length > 1) {
    throw new Error('Specify exactly one principal selector: --user, --service-principal, or --group');
  }

  if (userId) {
    return { principalType: 'user', principalId: userId };
  }
  if (spId) {
    return { principalType: 'service_principal', principalId: spId };
  }
  return { principalType: 'group', principalId: groupId! };
}

function parseScopeJsonFlag(flags: Record<string, FlagValue>): Record<string, unknown> | undefined {
  const raw = getStringFlag(flags, ['scope-json']);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --scope-json: ${message}`);
  }
}

function normalizeBindingScope(scope: AccessBindingScope | undefined | null): AccessBindingScope | undefined {
  if (!scope) {
    return undefined;
  }

  const normalized: AccessBindingScope = {};

  if (scope.orgfs) {
    const allow = [...new Set(scope.orgfs.allow_prefixes ?? [])].sort();
    const readOnly = [...new Set(scope.orgfs.read_only_prefixes ?? [])].sort();
    if (allow.length > 0 || readOnly.length > 0) {
      normalized.orgfs = {};
      if (allow.length > 0) normalized.orgfs.allow_prefixes = allow;
      if (readOnly.length > 0) normalized.orgfs.read_only_prefixes = readOnly;
    }
  }

  if (scope.orgdocs) {
    const allow = [...new Set(scope.orgdocs.allow_prefixes ?? [])].sort();
    const readOnly = [...new Set(scope.orgdocs.read_only_prefixes ?? [])].sort();
    if (allow.length > 0 || readOnly.length > 0) {
      normalized.orgdocs = {};
      if (allow.length > 0) normalized.orgdocs.allow_prefixes = allow;
      if (readOnly.length > 0) normalized.orgdocs.read_only_prefixes = readOnly;
    }
  }

  if (scope.envdb) {
    const schemas = [...new Set(scope.envdb.schemas ?? [])].sort();
    const tables = [...new Set(scope.envdb.tables ?? [])].sort();
    if (schemas.length > 0 || tables.length > 0) {
      normalized.envdb = {};
      if (schemas.length > 0) normalized.envdb.schemas = schemas;
      if (tables.length > 0) normalized.envdb.tables = tables;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function scopeEquals(
  left: AccessBindingScope | undefined | null,
  right: AccessBindingScope | undefined | null,
): boolean {
  const normalizedLeft = normalizeBindingScope(left);
  const normalizedRight = normalizeBindingScope(right);
  return JSON.stringify(normalizedLeft ?? null) === JSON.stringify(normalizedRight ?? null);
}

// ── Router ─────────────────────────────────────────────────────────────────

export async function handleAccess(
  subcommand: string | undefined,
  rest: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'can':
      return handleCan(flags, context, json);

    case 'explain':
      return handleExplain(flags, context, json);

    case 'roles':
      return handleRoles(rest[0], rest.slice(1), flags, context, json);

    case 'bind':
      return handleBind(flags, context, json);

    case 'unbind':
      return handleUnbind(flags, context, json);

    case 'bindings':
      return handleBindings(rest[0], flags, context, json);

    case 'groups':
      return handleGroups(rest[0], rest.slice(1), flags, context, json);

    case 'memberships':
      return handleMemberships(flags, context, json);

    case 'validate':
      return handleValidate(flags, json);

    case 'plan':
      return handlePlan(flags, context, json);

    case 'sync':
      return handleSync(flags, context, json);

    default:
      throw new Error(
        'Usage: eve access <subcommand> [flags]\n\n' +
        'Commands:\n' +
        '  can        Check if a principal can perform an action\n' +
        '  explain    Explain permission resolution chain\n' +
        '  roles      Manage custom access roles (create|list|show|update|delete)\n' +
        '  bind       Bind a custom role to a principal\n' +
        '  unbind     Remove a role binding from a principal\n' +
        '  bindings   List access bindings\n' +
        '  groups     Manage access groups and members\n' +
        '  memberships Inspect principal memberships and effective scopes\n' +
        '  validate   Validate an .eve/access.yaml file\n' +
        '  plan       Show changes needed to sync access.yaml to an org\n' +
        '  sync       Apply access.yaml to an org (create/update/prune)',
      );
  }
}

// ── can ─────────────────────────────────────────────────────────────────────

async function handleCan(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const permission = getStringFlag(flags, ['permission']);
  const resourceType = getStringFlag(flags, ['resource-type']);
  const resourceId = getStringFlag(flags, ['resource', 'resource-id']);
  const action = getStringFlag(flags, ['action']);

  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  if (!permission) {
    throw new Error('--permission is required');
  }

  const principal = resolvePrincipalSelection(flags, { allowGroup: true });

  if ((resourceType || action) && !resourceId) {
    throw new Error('--resource is required when --resource-type or --action is provided');
  }

  const params = new URLSearchParams({
    principal_type: principal.principalType,
    principal_id: principal.principalId,
    permission,
  });
  if (projectId) {
    params.set('project_id', projectId);
  }
  if (resourceType) {
    params.set('resource_type', resourceType);
  }
  if (resourceId) {
    params.set('resource_id', resourceId);
  }
  if (action) {
    params.set('action', action);
  }

  const response = await requestJson<AccessCanResponse>(
    context,
    `/orgs/${orgId}/access/can?${params.toString()}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  const label = response.allowed ? 'ALLOWED' : 'DENIED';
  console.log(`${label} (source: ${response.source})`);
  if (response.resource) {
    const resourceStatus = response.resource.scope_matched ? 'scope match' : 'scope denied';
    console.log(
      `Resource: ${response.resource.type}:${response.resource.id} [${response.resource.action}] (${resourceStatus})`,
    );
  }
}

// ── explain ─────────────────────────────────────────────────────────────────

async function handleExplain(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const permission = getStringFlag(flags, ['permission']);
  const resourceType = getStringFlag(flags, ['resource-type']);
  const resourceId = getStringFlag(flags, ['resource', 'resource-id']);
  const action = getStringFlag(flags, ['action']);

  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  if (!permission) {
    throw new Error('--permission is required');
  }

  const principal = resolvePrincipalSelection(flags, { allowGroup: true });
  if ((resourceType || action) && !resourceId) {
    throw new Error('--resource is required when --resource-type or --action is provided');
  }

  const params = new URLSearchParams({
    principal_type: principal.principalType,
    principal_id: principal.principalId,
    permission,
  });
  if (projectId) {
    params.set('project_id', projectId);
  }
  if (resourceType) {
    params.set('resource_type', resourceType);
  }
  if (resourceId) {
    params.set('resource_id', resourceId);
  }
  if (action) {
    params.set('action', action);
  }

  const response = await requestJson<AccessExplainResponse>(
    context,
    `/orgs/${orgId}/access/explain?${params.toString()}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  console.log(`Permission: ${response.permission}`);
  console.log(`Result: ${response.result}`);
  if (response.resource) {
    const resourceStatus = response.resource.scope_matched ? 'scope match' : 'scope denied';
    console.log(
      `Resource: ${response.resource.type}:${response.resource.id} [${response.resource.action}] (${resourceStatus})`,
    );
  }

  if (response.grants.length > 0) {
    console.log('Grants found:');
    for (const grant of response.grants) {
      const roleLabel = grant.role ? `: ${grant.role}` : '';
      const permCount = grant.permissions.length;
      const status = grant.has_permission ? 'has permission' : `missing ${response.permission}`;
      const scopeSuffix = grant.scope_match === undefined
        ? ''
        : grant.scope_match
          ? ' [scope:match]'
          : ` [scope:deny${grant.scope_reason ? `: ${grant.scope_reason}` : ''}]`;
      console.log(`  - ${grant.source}${roleLabel} -> [${permCount} permissions] (${status})${scopeSuffix}`);
    }
  } else {
    console.log('Grants found: none');
  }

  if (response.missing_reason) {
    console.log(`Missing: ${response.missing_reason}`);
  }
}

// ── roles ───────────────────────────────────────────────────────────────────

async function handleRoles(
  action: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;

  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  switch (action) {
    case 'create': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      const scope = getStringFlag(flags, ['scope']);
      const permissionsStr = getStringFlag(flags, ['permissions']);
      const description = getStringFlag(flags, ['description']);

      if (!name) {
        throw new Error('Role name is required: eve access roles create <name> --scope <org|project> --permissions <perm1,perm2>');
      }

      if (!scope || (scope !== 'org' && scope !== 'project')) {
        throw new Error('--scope is required (org or project)');
      }

      if (!permissionsStr) {
        throw new Error('--permissions is required (comma-separated list)');
      }

      const permissions = permissionsStr.split(',').map((p) => p.trim()).filter(Boolean);

      const response = await requestJson<AccessRoleResponse>(
        context,
        `/orgs/${orgId}/access/roles`,
        {
          method: 'POST',
          body: { name, scope, permissions, description },
        },
      );

      if (json) {
        outputJson(response, json);
        return;
      }

      console.log(`Created role '${response.name}' (${response.id})`);
      console.log(`  Scope: ${response.scope}`);
      console.log(`  Permissions: ${response.permissions.join(', ')}`);
      if (response.description) {
        console.log(`  Description: ${response.description}`);
      }
      return;
    }

    case 'list': {
      const rolesResponse = await requestJson<{ data: AccessRoleResponse[] } | AccessRoleResponse[]>(
        context,
        `/orgs/${orgId}/access/roles`,
      );
      const roles = unwrapListResponse(rolesResponse);

      if (json) {
        outputJson({ data: roles }, json);
        return;
      }

      if (roles.length === 0) {
        console.log('No custom roles defined.');
        return;
      }

      for (const role of roles) {
        const desc = role.description ? ` - ${role.description}` : '';
        console.log(`${role.name} (${role.scope}) [${role.permissions.length} permissions]${desc}`);
      }
      return;
    }

    case 'show': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      if (!name) {
        throw new Error('Role name is required: eve access roles show <name> --org <org_id>');
      }

      // List roles and find by name (the API supports lookup by ID, but CLI uses names)
      const rolesResponse = await requestJson<{ data: AccessRoleResponse[] } | AccessRoleResponse[]>(
        context,
        `/orgs/${orgId}/access/roles`,
      );
      const roles = unwrapListResponse(rolesResponse);
      const role = roles.find((r) => r.name === name);

      if (!role) {
        throw new Error(`Role '${name}' not found in this org`);
      }

      if (json) {
        outputJson(role, json);
        return;
      }

      console.log(`Name: ${role.name}`);
      console.log(`ID: ${role.id}`);
      console.log(`Scope: ${role.scope}`);
      console.log(`Permissions: ${role.permissions.join(', ')}`);
      if (role.description) {
        console.log(`Description: ${role.description}`);
      }
      console.log(`Created: ${role.created_at}`);
      console.log(`Updated: ${role.updated_at}`);
      return;
    }

    case 'update': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      if (!name) {
        throw new Error('Role name is required: eve access roles update <name> --org <org_id> [--permissions <perms>] [--add-permissions <perms>] [--description <desc>]');
      }

      // Resolve role ID by name
      const rolesResponse = await requestJson<{ data: AccessRoleResponse[] } | AccessRoleResponse[]>(
        context,
        `/orgs/${orgId}/access/roles`,
      );
      const roles = unwrapListResponse(rolesResponse);
      const role = roles.find((r) => r.name === name);
      if (!role) {
        throw new Error(`Role '${name}' not found in this org`);
      }

      const body: { permissions?: string[]; description?: string } = {};

      const addPermissionsStr = getStringFlag(flags, ['add-permissions']);
      const setPermissionsStr = getStringFlag(flags, ['permissions']);
      const description = getStringFlag(flags, ['description']);

      if (setPermissionsStr) {
        body.permissions = setPermissionsStr.split(',').map((p) => p.trim()).filter(Boolean);
      } else if (addPermissionsStr) {
        const toAdd = addPermissionsStr.split(',').map((p) => p.trim()).filter(Boolean);
        const merged = new Set([...role.permissions, ...toAdd]);
        body.permissions = [...merged];
      }

      if (description !== undefined) {
        body.description = description;
      }

      if (!body.permissions && body.description === undefined) {
        throw new Error('Nothing to update. Use --permissions, --add-permissions, or --description');
      }

      const updated = await requestJson<AccessRoleResponse>(
        context,
        `/orgs/${orgId}/access/roles/${role.id}`,
        { method: 'PATCH', body },
      );

      if (json) {
        outputJson(updated, json);
        return;
      }

      console.log(`Updated role '${updated.name}'`);
      console.log(`  Permissions: ${updated.permissions.join(', ')}`);
      if (updated.description) {
        console.log(`  Description: ${updated.description}`);
      }
      return;
    }

    case 'delete': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      if (!name) {
        throw new Error('Role name is required: eve access roles delete <name> --org <org_id>');
      }

      // Resolve role ID by name
      const rolesResponse = await requestJson<{ data: AccessRoleResponse[] } | AccessRoleResponse[]>(
        context,
        `/orgs/${orgId}/access/roles`,
      );
      const roles = unwrapListResponse(rolesResponse);
      const role = roles.find((r) => r.name === name);
      if (!role) {
        throw new Error(`Role '${name}' not found in this org`);
      }

      await requestJson<void>(
        context,
        `/orgs/${orgId}/access/roles/${role.id}`,
        { method: 'DELETE' },
      );

      if (json) {
        outputJson({ deleted: true, name, id: role.id }, json);
        return;
      }

      console.log(`Deleted role '${name}' (${role.id})`);
      return;
    }

    default:
      throw new Error(
        'Usage: eve access roles <create|list|show|update|delete> [name] [flags]\n\n' +
        'Commands:\n' +
        '  create  Create a custom role\n' +
        '  list    List custom roles\n' +
        '  show    Show details of a custom role\n' +
        '  update  Update a custom role\n' +
        '  delete  Delete a custom role',
      );
  }
}

// ── bind ────────────────────────────────────────────────────────────────────

async function handleBind(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  // Require explicit --project for binding creation to avoid silently scoping
  // bindings to a default project from the user's profile.
  const projectId = getStringFlag(flags, ['project']);
  const roleName = getStringFlag(flags, ['role']);
  const scopeJson = parseScopeJsonFlag(flags);

  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  if (!roleName) {
    throw new Error('--role <role_name> is required');
  }

  const principal = resolvePrincipalSelection(flags, { allowGroup: true });

  const body: Record<string, unknown> = {
    role_name: roleName,
    principal_type: principal.principalType,
    principal_id: principal.principalId,
  };
  if (projectId) {
    body.project_id = projectId;
  }
  if (scopeJson) {
    body.scope_json = scopeJson;
  }

  const response = await requestJson<AccessBindingResponse>(
    context,
    `/orgs/${orgId}/access/bindings`,
    { method: 'POST', body },
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  const scopeLabel = response.project_id ? `project ${response.project_id}` : `org ${orgId}`;
  console.log(`Bound role '${response.role_name}' to ${principal.principalType} ${principal.principalId} on ${scopeLabel}`);
}

// ── unbind ──────────────────────────────────────────────────────────────────

async function handleUnbind(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const roleName = getStringFlag(flags, ['role']);

  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  if (!roleName) {
    throw new Error('--role <role_name> is required');
  }

  const principal = resolvePrincipalSelection(flags, { allowGroup: true });

  // List bindings and find the matching one to get the binding ID
  const params = new URLSearchParams({
    principal_type: principal.principalType,
    principal_id: principal.principalId,
  });
  if (projectId) {
    params.set('project_id', projectId);
  }

  const bindingsResponse = await requestJson<{ data: AccessBindingResponse[] } | AccessBindingResponse[]>(
    context,
    `/orgs/${orgId}/access/bindings?${params.toString()}`,
  );
  const bindings = unwrapListResponse(bindingsResponse);

  const matching = bindings.find((b) => {
    if (b.role_name !== roleName) return false;
    if (b.principal_type !== principal.principalType) return false;
    if (b.principal_id !== principal.principalId) return false;
    // Match project scope
    if (projectId) return b.project_id === projectId;
    return b.project_id === null;
  });

  if (!matching) {
    throw new Error(
      `No binding found for role '${roleName}' on ${principal.principalType} ${principal.principalId}` +
      (projectId ? ` in project ${projectId}` : ' at org level'),
    );
  }

  await requestJson<void>(
    context,
    `/orgs/${orgId}/access/bindings/${matching.id}`,
    { method: 'DELETE' },
  );

  if (json) {
    outputJson({ deleted: true, binding_id: matching.id }, json);
    return;
  }

  const scopeLabel = projectId ? `project ${projectId}` : `org ${orgId}`;
  console.log(`Unbound role '${roleName}' from ${principal.principalType} ${principal.principalId} on ${scopeLabel}`);
}

// ── bindings list ───────────────────────────────────────────────────────────

async function handleBindings(
  action: string | undefined,
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  if (action && action !== 'list') {
    throw new Error('Usage: eve access bindings list --org <org_id> [--project <project_id>]');
  }

  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;

  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  const params = new URLSearchParams();
  if (projectId) {
    params.set('project_id', projectId);
  }

  const queryString = params.toString();
  const path = queryString
    ? `/orgs/${orgId}/access/bindings?${queryString}`
    : `/orgs/${orgId}/access/bindings`;

  const bindingsResponse = await requestJson<{ data: AccessBindingResponse[] } | AccessBindingResponse[]>(context, path);
  const bindings = unwrapListResponse(bindingsResponse);

  if (json) {
    outputJson({ data: bindings }, json);
    return;
  }

  if (bindings.length === 0) {
    console.log('No bindings found.');
    return;
  }

  for (const b of bindings) {
    const scope = b.project_id ? `project ${b.project_id}` : 'org-wide';
    console.log(`${b.role_name} -> ${b.principal_type} ${b.principal_id} (${scope})`);
  }
}

// ── groups ──────────────────────────────────────────────────────────────────

async function handleGroups(
  action: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  if (action === 'members') {
    return handleGroupMembers(positionals[0], positionals.slice(1), flags, context, json);
  }

  switch (action) {
    case 'create': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      const slug = getStringFlag(flags, ['slug']);
      const description = getStringFlag(flags, ['description']);
      if (!name) {
        throw new Error('Usage: eve access groups create <name> --org <org_id> [--slug <slug>] [--description <text>]');
      }

      const response = await requestJson<AccessGroupResponse>(context, `/orgs/${orgId}/access/groups`, {
        method: 'POST',
        body: { name, slug, description },
      });

      if (json) {
        outputJson(response, json);
        return;
      }

      console.log(`Created group '${response.name}' (${response.id})`);
      console.log(`  Slug: ${response.slug}`);
      if (response.description) {
        console.log(`  Description: ${response.description}`);
      }
      return;
    }

    case 'list': {
      const listResponse = await requestJson<{ data: AccessGroupResponse[] } | AccessGroupResponse[]>(
        context,
        `/orgs/${orgId}/access/groups`,
      );
      const groups = unwrapListResponse(listResponse);
      if (json) {
        outputJson({ data: groups }, json);
        return;
      }

      if (groups.length === 0) {
        console.log('No access groups found.');
        return;
      }

      for (const group of groups) {
        const desc = group.description ? ` - ${group.description}` : '';
        console.log(`${group.slug} (${group.id})${desc}`);
      }
      return;
    }

    case 'show': {
      const group = positionals[0] ?? getStringFlag(flags, ['group']);
      if (!group) {
        throw new Error('Usage: eve access groups show <group_id_or_slug> --org <org_id>');
      }

      const response = await requestJson<AccessGroupResponse>(
        context,
        `/orgs/${orgId}/access/groups/${encodeURIComponent(group)}`,
      );

      if (json) {
        outputJson(response, json);
        return;
      }

      console.log(`Name: ${response.name}`);
      console.log(`ID: ${response.id}`);
      console.log(`Slug: ${response.slug}`);
      if (response.description) {
        console.log(`Description: ${response.description}`);
      }
      console.log(`Created: ${response.created_at}`);
      console.log(`Updated: ${response.updated_at}`);
      return;
    }

    case 'update': {
      const group = positionals[0] ?? getStringFlag(flags, ['group']);
      if (!group) {
        throw new Error('Usage: eve access groups update <group_id_or_slug> --org <org_id> [--name <name>] [--slug <slug>] [--description <text>]');
      }

      const name = getStringFlag(flags, ['name']);
      const slug = getStringFlag(flags, ['slug']);
      const description = getStringFlag(flags, ['description']);

      if (name === undefined && slug === undefined && description === undefined) {
        throw new Error('Nothing to update. Use --name, --slug, or --description');
      }

      const response = await requestJson<AccessGroupResponse>(
        context,
        `/orgs/${orgId}/access/groups/${encodeURIComponent(group)}`,
        {
          method: 'PATCH',
          body: {
            name,
            slug,
            description,
          },
        },
      );

      if (json) {
        outputJson(response, json);
        return;
      }

      console.log(`Updated group '${response.name}' (${response.id})`);
      console.log(`  Slug: ${response.slug}`);
      if (response.description) {
        console.log(`  Description: ${response.description}`);
      }
      return;
    }

    case 'delete': {
      const group = positionals[0] ?? getStringFlag(flags, ['group']);
      if (!group) {
        throw new Error('Usage: eve access groups delete <group_id_or_slug> --org <org_id>');
      }

      await requestJson<void>(context, `/orgs/${orgId}/access/groups/${encodeURIComponent(group)}`, {
        method: 'DELETE',
      });

      if (json) {
        outputJson({ deleted: true, group }, json);
        return;
      }

      console.log(`Deleted group '${group}'`);
      return;
    }

    default:
      throw new Error(
        'Usage: eve access groups <create|list|show|update|delete|members> [args] [flags]\n\n' +
        'Examples:\n' +
        '  eve access groups create \"Product Management\" --org org_xxx\n' +
        '  eve access groups list --org org_xxx\n' +
        '  eve access groups members list pm-team --org org_xxx',
      );
  }
}

async function handleGroupMembers(
  action: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  switch (action) {
    case 'add': {
      const group = positionals[0] ?? getStringFlag(flags, ['group']);
      if (!group) {
        throw new Error('Usage: eve access groups members add <group> --org <org_id> (--user <user_id> | --service-principal <sp_id>)');
      }
      const principal = resolvePrincipalSelection(flags);

      const response = await requestJson<AccessGroupMemberResponse>(
        context,
        `/orgs/${orgId}/access/groups/${encodeURIComponent(group)}/members`,
        {
          method: 'POST',
          body: {
            principal_type: principal.principalType,
            principal_id: principal.principalId,
          },
        },
      );

      if (json) {
        outputJson(response, json);
        return;
      }

      console.log(`Added ${response.principal_type} ${response.principal_id} to group ${group}`);
      return;
    }

    case 'list': {
      const group = positionals[0] ?? getStringFlag(flags, ['group']);
      if (!group) {
        throw new Error('Usage: eve access groups members list <group> --org <org_id>');
      }

      const membersResponse = await requestJson<{ data: AccessGroupMemberResponse[] } | AccessGroupMemberResponse[]>(
        context,
        `/orgs/${orgId}/access/groups/${encodeURIComponent(group)}/members`,
      );
      const members = unwrapListResponse(membersResponse);

      if (json) {
        outputJson({ data: members }, json);
        return;
      }

      if (members.length === 0) {
        console.log('No group members found.');
        return;
      }

      for (const member of members) {
        console.log(`${member.principal_type} ${member.principal_id}`);
      }
      return;
    }

    case 'remove': {
      const group = positionals[0] ?? getStringFlag(flags, ['group']);
      if (!group) {
        throw new Error('Usage: eve access groups members remove <group> --org <org_id> (--user <user_id> | --service-principal <sp_id>)');
      }
      const principal = resolvePrincipalSelection(flags);

      await requestJson<void>(
        context,
        `/orgs/${orgId}/access/groups/${encodeURIComponent(group)}/members/${principal.principalType}/${principal.principalId}`,
        { method: 'DELETE' },
      );

      if (json) {
        outputJson({ removed: true, group, principal: principal.principalId }, json);
        return;
      }

      console.log(`Removed ${principal.principalType} ${principal.principalId} from group ${group}`);
      return;
    }

    default:
      throw new Error(
        'Usage: eve access groups members <add|list|remove> <group> --org <org_id> [--user <id> | --service-principal <id>]',
      );
  }
}

// ── memberships ──────────────────────────────────────────────────────────────

async function handleMemberships(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  const principal = resolvePrincipalSelection(flags, { allowGroup: true });
  const response = await requestJson<AccessPrincipalMembershipsResponse>(
    context,
    `/orgs/${orgId}/access/principals/${principal.principalType}/${principal.principalId}/memberships`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  console.log(`Principal: ${response.principal_type} ${response.principal_id}`);
  if (response.base.org_role) {
    console.log(`Org role: ${response.base.org_role}`);
  }
  if (response.base.project_roles.length > 0) {
    console.log(`Project roles: ${response.base.project_roles.length}`);
  }
  if (response.groups.length > 0) {
    console.log(`Groups: ${response.groups.map((group) => group.slug).join(', ')}`);
  } else {
    console.log('Groups: none');
  }

  console.log(`Effective permissions: ${response.effective_permissions.length}`);
  if (response.effective_scopes.orgfs.allow_prefixes.length > 0) {
    console.log(`orgfs allow: ${response.effective_scopes.orgfs.allow_prefixes.join(', ')}`);
  }
  if (response.effective_scopes.orgdocs.allow_prefixes.length > 0) {
    console.log(`orgdocs allow: ${response.effective_scopes.orgdocs.allow_prefixes.join(', ')}`);
  }
  if (response.effective_scopes.envdb.schemas.length > 0 || response.effective_scopes.envdb.tables.length > 0) {
    const schemas = response.effective_scopes.envdb.schemas.join(', ') || '-';
    const tables = response.effective_scopes.envdb.tables.join(', ') || '-';
    console.log(`envdb schemas: ${schemas}`);
    console.log(`envdb tables: ${tables}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Policy-as-Code: validate / plan / sync
// ═══════════════════════════════════════════════════════════════════════════

// ── YAML loading ────────────────────────────────────────────────────────────

const DEFAULT_ACCESS_YAML = '.eve/access.yaml';

function resolveFilePath(flags: Record<string, FlagValue>): string {
  const filePath = getStringFlag(flags, ['file', 'f']) ?? DEFAULT_ACCESS_YAML;
  return resolve(process.cwd(), filePath);
}

function loadAccessYaml(filePath: string): AccessYaml {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`YAML parse error in ${filePath}: ${msg}`);
  }

  const result = AccessYamlSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  - ${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Schema validation failed for ${filePath}:\n${issues.join('\n')}`);
  }

  return result.data;
}

// ── Semantic validation ─────────────────────────────────────────────────────

type ValidationError = { path: string; message: string };

type DataPlaneScopeType = 'orgfs' | 'orgdocs' | 'envdb';

function permissionScopeType(permission: string): DataPlaneScopeType | null {
  if (permission.startsWith('orgfs:')) return 'orgfs';
  if (permission.startsWith('orgdocs:')) return 'orgdocs';
  if (permission.startsWith('envdb:')) return 'envdb';
  return null;
}

function hasPrefixScope(
  scope: AccessBindingScope | undefined,
  resourceType: 'orgfs' | 'orgdocs',
  requireWritable: boolean,
): boolean {
  const resourceScope = scope?.[resourceType];
  if (!resourceScope) {
    return false;
  }

  const allowCount = resourceScope.allow_prefixes?.length ?? 0;
  const readOnlyCount = resourceScope.read_only_prefixes?.length ?? 0;

  if (requireWritable) {
    return allowCount > 0;
  }

  return allowCount > 0 || readOnlyCount > 0;
}

function hasEnvDbScope(scope: AccessBindingScope | undefined): boolean {
  const envdb = scope?.envdb;
  if (!envdb) {
    return false;
  }
  return (envdb.schemas?.length ?? 0) > 0 || (envdb.tables?.length ?? 0) > 0;
}

function groupDefaultName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function declaredMemberKey(member: AccessYamlGroupMember): string {
  return `${member.type}:${member.id}`;
}

function apiMemberKey(member: AccessGroupMemberResponse): string {
  return `${member.principal_type}:${member.principal_id}`;
}

function bindingIdentityKey(
  roleName: string,
  principalType: string,
  principalId: string,
  projectId: string | null | undefined,
): string {
  const scope = projectId ?? 'org';
  return `${roleName}|${principalType}|${principalId}|${scope}`;
}

function bindingMatchKey(
  roleName: string,
  principalType: string,
  principalId: string,
  projectId: string | null | undefined,
  scope: AccessBindingScope | undefined | null,
): string {
  const normalizedScope = normalizeBindingScope(scope);
  return `${bindingIdentityKey(roleName, principalType, principalId, projectId)}|${JSON.stringify(normalizedScope ?? null)}`;
}

function formatBindingScope(scope: AccessBindingScope | undefined | null): string {
  const normalized = normalizeBindingScope(scope);
  if (!normalized) {
    return '(none)';
  }
  return JSON.stringify(normalized);
}

function semanticValidate(yaml: AccessYaml): ValidationError[] {
  const errors: ValidationError[] = [];
  const roles = yaml.access.roles ?? {};
  const groups = yaml.access.groups ?? {};
  const roleNames = new Set(Object.keys(roles));
  const groupSlugs = new Set(Object.keys(groups));

  // Validate role permissions
  for (const [name, role] of Object.entries(roles)) {
    for (const perm of role.permissions) {
      if (!PERMISSION_SET.has(perm)) {
        errors.push({
          path: `access.roles.${name}.permissions`,
          message: `Unknown permission '${perm}'`,
        });
      }
    }
  }

  // Validate group membership lists
  for (const [slug, group] of Object.entries(groups)) {
    const seenMembers = new Set<string>();
    const members = group.members ?? [];
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const key = declaredMemberKey(member);
      if (seenMembers.has(key)) {
        errors.push({
          path: `access.groups.${slug}.members[${i}]`,
          message: `Duplicate group member '${key}'`,
        });
        continue;
      }
      seenMembers.add(key);
    }
  }

  // Validate bindings
  const seenBindingKeys = new Set<string>();
  const bindings = yaml.access.bindings ?? [];
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];

    // Check that referenced roles exist in this file
    for (const roleName of binding.roles) {
      if (!roleNames.has(roleName)) {
        errors.push({
          path: `access.bindings[${i}].roles`,
          message: `Role '${roleName}' is not defined in this file`,
        });
      }
    }

    if (binding.project_id !== undefined && binding.project_id.trim() === '') {
      errors.push({
        path: `access.bindings[${i}].project_id`,
        message: 'project_id cannot be empty when provided',
      });
    }

    if (binding.subject.type === 'group' && !groupSlugs.has(binding.subject.id)) {
      errors.push({
        path: `access.bindings[${i}].subject.id`,
        message: `Group '${binding.subject.id}' is not defined in access.groups`,
      });
    }

    const normalizedScope = normalizeBindingScope(binding.scope);
    const requiredScopeTypes = new Set<DataPlaneScopeType>();
    let needsWritableOrgFsScope = false;
    let needsWritableOrgDocsScope = false;

    for (const roleName of binding.roles) {
      const role = roles[roleName];
      if (!role) continue;
      for (const permission of role.permissions) {
        const scopeType = permissionScopeType(permission);
        if (scopeType) {
          requiredScopeTypes.add(scopeType);
        }
        if (permission === 'orgfs:write' || permission === 'orgfs:admin') {
          needsWritableOrgFsScope = true;
        }
        if (permission === 'orgdocs:write' || permission === 'orgdocs:admin') {
          needsWritableOrgDocsScope = true;
        }
      }
    }

    if (requiredScopeTypes.has('orgfs') && !hasPrefixScope(normalizedScope, 'orgfs', needsWritableOrgFsScope)) {
      errors.push({
        path: `access.bindings[${i}].scope`,
        message: needsWritableOrgFsScope
          ? 'Binding includes orgfs write/admin permissions but scope.orgfs.allow_prefixes is missing'
          : 'Binding includes orgfs permissions but scope.orgfs prefixes are missing',
      });
    }

    if (requiredScopeTypes.has('orgdocs') && !hasPrefixScope(normalizedScope, 'orgdocs', needsWritableOrgDocsScope)) {
      errors.push({
        path: `access.bindings[${i}].scope`,
        message: needsWritableOrgDocsScope
          ? 'Binding includes orgdocs write/admin permissions but scope.orgdocs.allow_prefixes is missing'
          : 'Binding includes orgdocs permissions but scope.orgdocs prefixes are missing',
      });
    }

    if (requiredScopeTypes.has('envdb') && !hasEnvDbScope(normalizedScope)) {
      errors.push({
        path: `access.bindings[${i}].scope`,
        message: 'Binding includes envdb permissions but scope.envdb.schemas/tables is missing',
      });
    }

    for (const roleName of binding.roles) {
      const dedupeKey = bindingMatchKey(
        roleName,
        binding.subject.type,
        binding.subject.id,
        binding.project_id ?? null,
        normalizedScope,
      );
      if (seenBindingKeys.has(dedupeKey)) {
        errors.push({
          path: `access.bindings[${i}]`,
          message: `Duplicate binding tuple for role '${roleName}' and subject '${binding.subject.type}:${binding.subject.id}'`,
        });
      } else {
        seenBindingKeys.add(dedupeKey);
      }
    }
  }

  return errors;
}

// ── validate ────────────────────────────────────────────────────────────────

async function handleValidate(
  flags: Record<string, FlagValue>,
  json: boolean,
): Promise<void> {
  const filePath = resolveFilePath(flags);
  const yaml = loadAccessYaml(filePath);
  const errors = semanticValidate(yaml);

  if (json) {
    outputJson({
      valid: errors.length === 0,
      file: filePath,
      errors,
      groups: Object.keys(yaml.access.groups ?? {}).length,
      roles: Object.keys(yaml.access.roles ?? {}).length,
      members: Object.values(yaml.access.groups ?? {}).reduce((acc, group) => acc + (group.members?.length ?? 0), 0),
      bindings: (yaml.access.bindings ?? []).length,
    }, json);
    return;
  }

  if (errors.length > 0) {
    console.log(`Validation failed for ${filePath}:\n`);
    for (const err of errors) {
      console.log(`  ${err.path}: ${err.message}`);
    }
    process.exit(1);
  }

  const groupCount = Object.keys(yaml.access.groups ?? {}).length;
  const roleCount = Object.keys(yaml.access.roles ?? {}).length;
  const memberCount = Object.values(yaml.access.groups ?? {}).reduce((acc, group) => acc + (group.members?.length ?? 0), 0);
  const bindingCount = (yaml.access.bindings ?? []).length;
  console.log(`Valid (${groupCount} groups, ${memberCount} members, ${roleCount} roles, ${bindingCount} bindings)`);
}

// ── Plan types ──────────────────────────────────────────────────────────────

type GroupAction =
  | { action: 'create'; slug: string; group: AccessYamlGroup }
  | { action: 'update'; slug: string; id: string; group: AccessYamlGroup; changes: string[] }
  | { action: 'prune'; slug: string; id: string };

type RoleAction =
  | { action: 'create'; name: string; role: AccessYamlRole }
  | { action: 'update'; name: string; id: string; changes: string[] }
  | { action: 'prune'; name: string; id: string };

type GroupMemberAction =
  | { action: 'add'; groupSlug: string; member: AccessYamlGroupMember }
  | { action: 'remove'; groupSlug: string; groupId: string; member: AccessGroupMemberResponse };

type BindingAction =
  | { action: 'create'; binding: AccessYamlBinding; roleName: string; principalIdHint: string }
  | { action: 'replace'; existing: AccessBindingResponse; binding: AccessYamlBinding; roleName: string; principalIdHint: string; changes: string[] }
  | { action: 'prune'; binding: AccessBindingResponse };

type AccessPlan = {
  groups: GroupAction[];
  group_members: GroupMemberAction[];
  roles: RoleAction[];
  bindings: BindingAction[];
  unchanged_groups: number;
  unchanged_group_members: number;
  unchanged_roles: number;
  unchanged_bindings: number;
};

// ── Plan computation ────────────────────────────────────────────────────────

function resolveGroupPrincipalId(
  groupRef: string,
  groupsById: Map<string, AccessGroupResponse>,
  groupsBySlug: Map<string, AccessGroupResponse>,
): string | null {
  if (groupsById.has(groupRef)) {
    return groupRef;
  }
  return groupsBySlug.get(groupRef)?.id ?? null;
}

async function computePlan(
  yaml: AccessYaml,
  orgId: string,
  context: ResolvedContext,
): Promise<AccessPlan> {
  // Fetch current state from the API
  const [apiGroupsResponse, apiRolesResponse, apiBindingsResponse] = await Promise.all([
    requestJson<{ data: AccessGroupResponse[] } | AccessGroupResponse[]>(context, `/orgs/${orgId}/access/groups`),
    requestJson<{ data: AccessRoleResponse[] } | AccessRoleResponse[]>(context, `/orgs/${orgId}/access/roles`),
    requestJson<{ data: AccessBindingResponse[] } | AccessBindingResponse[]>(context, `/orgs/${orgId}/access/bindings`),
  ]);
  const apiGroups = unwrapListResponse(apiGroupsResponse);
  const apiRoles = unwrapListResponse(apiRolesResponse);
  const apiBindings = unwrapListResponse(apiBindingsResponse);

  const groupMemberEntries = await Promise.all(
    apiGroups.map(async (group) => {
      const membersResponse = await requestJson<{ data: AccessGroupMemberResponse[] } | AccessGroupMemberResponse[]>(
        context,
        `/orgs/${orgId}/access/groups/${encodeURIComponent(group.id)}/members`,
      );
      return [group.id, unwrapListResponse(membersResponse)] as const;
    }),
  );
  const membersByGroupId = new Map<string, AccessGroupMemberResponse[]>(
    groupMemberEntries.map(([groupId, members]) => [groupId, members]),
  );

  const groupsBySlug = new Map(apiGroups.map((group) => [group.slug, group]));
  const groupsById = new Map(apiGroups.map((group) => [group.id, group]));

  const rolesByName = new Map(apiRoles.map((r) => [r.name, r]));
  const plan: AccessPlan = {
    groups: [],
    group_members: [],
    roles: [],
    bindings: [],
    unchanged_groups: 0,
    unchanged_group_members: 0,
    unchanged_roles: 0,
    unchanged_bindings: 0,
  };

  // ── Groups + members ───────────────────────────────────────────────────

  const declaredGroupSlugs = new Set<string>();
  for (const [slug, declaredGroup] of Object.entries(yaml.access.groups ?? {})) {
    declaredGroupSlugs.add(slug);
    const existing = groupsBySlug.get(slug);
    const desiredMembers = declaredGroup.members ?? [];

    if (!existing) {
      plan.groups.push({ action: 'create', slug, group: declaredGroup });
      for (const member of desiredMembers) {
        plan.group_members.push({
          action: 'add',
          groupSlug: slug,
          member,
        });
      }
      continue;
    }

    const changes: string[] = [];
    const desiredName = declaredGroup.name ?? groupDefaultName(slug);
    const desiredDescription = declaredGroup.description ?? null;
    if (desiredName !== existing.name) {
      changes.push(`name: "${existing.name}" -> "${desiredName}"`);
    }
    if (desiredDescription !== (existing.description ?? null)) {
      changes.push(`description: "${existing.description ?? '(none)'}" -> "${desiredDescription ?? '(none)'}"`);
    }
    if (changes.length > 0) {
      plan.groups.push({
        action: 'update',
        slug,
        id: existing.id,
        group: declaredGroup,
        changes,
      });
    } else {
      plan.unchanged_groups++;
    }

    const existingMembers = membersByGroupId.get(existing.id) ?? [];
    const existingMemberKeys = new Set(existingMembers.map(apiMemberKey));
    const desiredMemberKeys = new Set(desiredMembers.map(declaredMemberKey));

    for (const member of desiredMembers) {
      const key = declaredMemberKey(member);
      if (existingMemberKeys.has(key)) {
        plan.unchanged_group_members++;
      } else {
        plan.group_members.push({
          action: 'add',
          groupSlug: slug,
          member,
        });
      }
    }

    for (const member of existingMembers) {
      const key = apiMemberKey(member);
      if (!desiredMemberKeys.has(key)) {
        plan.group_members.push({
          action: 'remove',
          groupSlug: slug,
          groupId: existing.id,
          member,
        });
      }
    }
  }

  for (const apiGroup of apiGroups) {
    if (!declaredGroupSlugs.has(apiGroup.slug)) {
      plan.groups.push({
        action: 'prune',
        slug: apiGroup.slug,
        id: apiGroup.id,
      });
    }
  }

  // ── Roles ──────────────────────────────────────────────────────────────

  const declaredRoleNames = new Set<string>();

  for (const [name, declaredRole] of Object.entries(yaml.access.roles ?? {})) {
    declaredRoleNames.add(name);
    const existing = rolesByName.get(name);

    if (!existing) {
      plan.roles.push({ action: 'create', name, role: declaredRole });
      continue;
    }

    // Compare: scope change not supported (would require delete+recreate), so
    // we only detect permission and description diffs.
    const changes: string[] = [];

    const declaredPerms = [...declaredRole.permissions].sort();
    const existingPerms = [...existing.permissions].sort();
    if (declaredPerms.join(',') !== existingPerms.join(',')) {
      const added = declaredPerms.filter((p) => !existing.permissions.includes(p));
      const removed = existingPerms.filter((p) => !declaredRole.permissions.includes(p));
      if (added.length > 0) changes.push(`add ${added.join(', ')}`);
      if (removed.length > 0) changes.push(`remove ${removed.join(', ')}`);
    }

    const declaredDesc = declaredRole.description ?? null;
    const existingDesc = existing.description ?? null;
    if (declaredDesc !== existingDesc) {
      changes.push(`description: "${existingDesc ?? '(none)'}" -> "${declaredDesc ?? '(none)'}"`);
    }

    if (declaredRole.scope !== existing.scope) {
      changes.push(`scope: ${existing.scope} -> ${declaredRole.scope} (requires delete+recreate)`);
    }

    if (changes.length > 0) {
      plan.roles.push({ action: 'update', name, id: existing.id, changes });
    } else {
      plan.unchanged_roles++;
    }
  }

  // Undeclared roles (only shown, applied with --prune)
  for (const apiRole of apiRoles) {
    if (!declaredRoleNames.has(apiRole.name)) {
      plan.roles.push({ action: 'prune', name: apiRole.name, id: apiRole.id });
    }
  }

  // ── Bindings ───────────────────────────────────────────────────────────

  const existingBindingByMatchKey = new Map<string, AccessBindingResponse>();
  const existingBindingByIdentityKey = new Map<string, AccessBindingResponse>();
  for (const ab of apiBindings) {
    const identityKey = bindingIdentityKey(ab.role_name, ab.principal_type, ab.principal_id, ab.project_id);
    existingBindingByIdentityKey.set(identityKey, ab);
    const matchKey = bindingMatchKey(
      ab.role_name,
      ab.principal_type,
      ab.principal_id,
      ab.project_id,
      ab.scope_json as AccessBindingScope | undefined | null,
    );
    existingBindingByMatchKey.set(matchKey, ab);
  }

  const matchedApiBindingIds = new Set<string>();
  const groupsMarkedForPrune = new Set(
    plan.groups
      .filter((group): group is Extract<GroupAction, { action: 'prune' }> => group.action === 'prune')
      .map((group) => group.id),
  );

  for (const declaredBinding of yaml.access.bindings ?? []) {
    const normalizedDeclaredScope = normalizeBindingScope(declaredBinding.scope);
    const principalType = declaredBinding.subject.type;

    let principalIdHint = declaredBinding.subject.id;
    if (principalType === 'group') {
      const resolvedGroupId = resolveGroupPrincipalId(declaredBinding.subject.id, groupsById, groupsBySlug);
      if (resolvedGroupId) {
        principalIdHint = resolvedGroupId;
      }
    }

    for (const roleName of [...new Set(declaredBinding.roles)]) {
      const identityKey = bindingIdentityKey(
        roleName,
        principalType,
        principalIdHint,
        declaredBinding.project_id ?? null,
      );
      const matchKey = bindingMatchKey(
        roleName,
        principalType,
        principalIdHint,
        declaredBinding.project_id ?? null,
        normalizedDeclaredScope,
      );

      const exactMatch = existingBindingByMatchKey.get(matchKey);
      if (exactMatch) {
        matchedApiBindingIds.add(exactMatch.id);
        plan.unchanged_bindings++;
        continue;
      }

      const identityMatch = existingBindingByIdentityKey.get(identityKey);
      if (identityMatch) {
        matchedApiBindingIds.add(identityMatch.id);
        const changes: string[] = [];
        if (!scopeEquals(identityMatch.scope_json as AccessBindingScope | undefined | null, normalizedDeclaredScope)) {
          changes.push(
            `scope: ${formatBindingScope(identityMatch.scope_json as AccessBindingScope | undefined | null)} -> ${formatBindingScope(normalizedDeclaredScope)}`,
          );
        }
        plan.bindings.push({
          action: 'replace',
          existing: identityMatch,
          binding: declaredBinding,
          roleName,
          principalIdHint,
          changes,
        });
        continue;
      }

      plan.bindings.push({
        action: 'create',
        binding: declaredBinding,
        roleName,
        principalIdHint,
      });
    }
  }

  for (const ab of apiBindings) {
    if (matchedApiBindingIds.has(ab.id)) {
      continue;
    }

    if (ab.principal_type === 'group' && groupsMarkedForPrune.has(ab.principal_id)) {
      continue;
    }

    plan.bindings.push({ action: 'prune', binding: ab });
  }

  return plan;
}

// ── Plan display ────────────────────────────────────────────────────────────

function hasChanges(plan: AccessPlan, prune: boolean): boolean {
  const groupChanges = plan.groups.filter((g) =>
    g.action === 'create' || g.action === 'update' || (g.action === 'prune' && prune),
  );
  const memberChanges = plan.group_members.filter((m) =>
    m.action === 'add' || m.action === 'remove',
  );
  const roleChanges = plan.roles.filter((r) =>
    r.action === 'create' || r.action === 'update' || (r.action === 'prune' && prune),
  );
  const bindingChanges = plan.bindings.filter((b) =>
    b.action === 'create' || b.action === 'replace' || (b.action === 'prune' && prune),
  );
  return groupChanges.length > 0 || memberChanges.length > 0 || roleChanges.length > 0 || bindingChanges.length > 0;
}

function printPlan(plan: AccessPlan, orgId: string, prune: boolean): void {
  console.log(`\nAccess Plan for ${orgId}:\n`);

  // Groups
  const groupCreates = plan.groups.filter((g) => g.action === 'create') as Array<Extract<GroupAction, { action: 'create' }>>;
  const groupUpdates = plan.groups.filter((g) => g.action === 'update') as Array<Extract<GroupAction, { action: 'update' }>>;
  const groupPrunes = plan.groups.filter((g) => g.action === 'prune') as Array<Extract<GroupAction, { action: 'prune' }>>;

  if (groupCreates.length > 0 || groupUpdates.length > 0 || groupPrunes.length > 0) {
    console.log('Groups:');
    for (const group of groupCreates) {
      const name = group.group.name ?? groupDefaultName(group.slug);
      console.log(`  + CREATE ${group.slug} (${name})`);
    }
    for (const group of groupUpdates) {
      console.log(`  ~ UPDATE ${group.slug}: ${group.changes.join('; ')}`);
    }
    if (groupPrunes.length > 0) {
      if (prune) {
        for (const group of groupPrunes) {
          console.log(`  - DELETE ${group.slug} (${group.id})`);
        }
      } else {
        console.log(`  ? Undeclared (not pruned): ${groupPrunes.map((group) => group.slug).join(', ')}`);
      }
    }
    console.log('');
  }

  // Group members
  const memberAdds = plan.group_members.filter((m) => m.action === 'add') as Array<Extract<GroupMemberAction, { action: 'add' }>>;
  const memberRemoves = plan.group_members.filter((m) => m.action === 'remove') as Array<Extract<GroupMemberAction, { action: 'remove' }>>;
  if (memberAdds.length > 0 || memberRemoves.length > 0) {
    console.log('Group Memberships:');
    for (const member of memberAdds) {
      console.log(`  + ADD ${member.member.type}:${member.member.id} -> ${member.groupSlug}`);
    }
    for (const member of memberRemoves) {
      console.log(`  - REMOVE ${member.member.principal_type}:${member.member.principal_id} -> ${member.groupSlug}`);
    }
    console.log('');
  }

  // Roles
  const roleCreates = plan.roles.filter((r) => r.action === 'create') as Array<Extract<RoleAction, { action: 'create' }>>;
  const roleUpdates = plan.roles.filter((r) => r.action === 'update') as Array<Extract<RoleAction, { action: 'update' }>>;
  const rolePrunes = plan.roles.filter((r) => r.action === 'prune') as Array<Extract<RoleAction, { action: 'prune' }>>;

  if (roleCreates.length > 0 || roleUpdates.length > 0 || rolePrunes.length > 0) {
    console.log('Roles:');
    for (const r of roleCreates) {
      console.log(`  + CREATE ${r.name} (${r.role.scope}): ${r.role.permissions.join(', ')}`);
    }
    for (const r of roleUpdates) {
      console.log(`  ~ UPDATE ${r.name}: ${r.changes.join('; ')}`);
    }
    if (rolePrunes.length > 0) {
      if (prune) {
        for (const r of rolePrunes) {
          console.log(`  - DELETE ${r.name} (${r.id})`);
        }
      } else {
        console.log(`  ? Undeclared (not pruned): ${rolePrunes.map((r) => r.name).join(', ')}`);
      }
    }
    console.log('');
  }

  // Bindings
  const bindingCreates = plan.bindings.filter((b) => b.action === 'create') as Array<Extract<BindingAction, { action: 'create' }>>;
  const bindingReplaces = plan.bindings.filter((b) => b.action === 'replace') as Array<Extract<BindingAction, { action: 'replace' }>>;
  const bindingPrunes = plan.bindings.filter((b) => b.action === 'prune') as Array<Extract<BindingAction, { action: 'prune' }>>;

  if (bindingCreates.length > 0 || bindingReplaces.length > 0 || bindingPrunes.length > 0) {
    console.log('Bindings:');
    for (const b of bindingCreates) {
      const scopeLabel = b.binding.project_id
        ? `project: ${b.binding.project_id}`
        : 'org-wide';
      console.log(
        `  + BIND ${b.roleName} -> ${b.binding.subject.type}:${b.binding.subject.id} (${scopeLabel}, scope=${formatBindingScope(b.binding.scope)})`,
      );
    }
    for (const b of bindingReplaces) {
      const scopeLabel = b.binding.project_id
        ? `project: ${b.binding.project_id}`
        : 'org-wide';
      console.log(
        `  ~ REPLACE ${b.roleName} -> ${b.binding.subject.type}:${b.binding.subject.id} (${scopeLabel}): ${b.changes.join('; ')}`,
      );
    }
    if (bindingPrunes.length > 0) {
      if (prune) {
        for (const b of bindingPrunes) {
          const scopeLabel = b.binding.project_id
            ? `project: ${b.binding.project_id}`
            : 'org-wide';
          console.log(`  - UNBIND ${b.binding.role_name} -> ${b.binding.principal_type}:${b.binding.principal_id} (${scopeLabel})`);
        }
      } else {
        console.log(`  ? Undeclared (not pruned): ${bindingPrunes.length} binding(s)`);
      }
    }
    console.log('');
  }

  // Summary
  const totalUnchanged = plan.unchanged_groups
    + plan.unchanged_group_members
    + plan.unchanged_roles
    + plan.unchanged_bindings;
  if (totalUnchanged > 0) {
    console.log(
      `Unchanged: ${plan.unchanged_groups} group(s), ${plan.unchanged_group_members} member(s), ${plan.unchanged_roles} role(s), ${plan.unchanged_bindings} binding(s)`,
    );
  }

  if (!hasChanges(plan, prune)) {
    console.log('No changes needed.');
  }
}

function planToJson(plan: AccessPlan, orgId: string): unknown {
  return {
    org_id: orgId,
    groups: {
      create: plan.groups
        .filter((group) => group.action === 'create')
        .map((group) => {
          const create = group as Extract<GroupAction, { action: 'create' }>;
          return {
            slug: create.slug,
            name: create.group.name ?? groupDefaultName(create.slug),
            description: create.group.description ?? null,
          };
        }),
      update: plan.groups
        .filter((group) => group.action === 'update')
        .map((group) => {
          const update = group as Extract<GroupAction, { action: 'update' }>;
          return {
            slug: update.slug,
            id: update.id,
            changes: update.changes,
          };
        }),
      prune: plan.groups
        .filter((group) => group.action === 'prune')
        .map((group) => {
          const prune = group as Extract<GroupAction, { action: 'prune' }>;
          return {
            slug: prune.slug,
            id: prune.id,
          };
        }),
      unchanged: plan.unchanged_groups,
    },
    group_members: {
      add: plan.group_members
        .filter((member) => member.action === 'add')
        .map((member) => {
          const add = member as Extract<GroupMemberAction, { action: 'add' }>;
          return {
            group_slug: add.groupSlug,
            principal_type: add.member.type,
            principal_id: add.member.id,
          };
        }),
      remove: plan.group_members
        .filter((member) => member.action === 'remove')
        .map((member) => {
          const remove = member as Extract<GroupMemberAction, { action: 'remove' }>;
          return {
            group_slug: remove.groupSlug,
            group_id: remove.groupId,
            principal_type: remove.member.principal_type,
            principal_id: remove.member.principal_id,
          };
        }),
      unchanged: plan.unchanged_group_members,
    },
    roles: {
      create: plan.roles
        .filter((r) => r.action === 'create')
        .map((r) => {
          const cr = r as Extract<RoleAction, { action: 'create' }>;
          return { name: cr.name, scope: cr.role.scope, permissions: cr.role.permissions };
        }),
      update: plan.roles
        .filter((r) => r.action === 'update')
        .map((r) => {
          const ur = r as Extract<RoleAction, { action: 'update' }>;
          return { name: ur.name, id: ur.id, changes: ur.changes };
        }),
      prune: plan.roles
        .filter((r) => r.action === 'prune')
        .map((r) => {
          const pr = r as Extract<RoleAction, { action: 'prune' }>;
          return { name: pr.name, id: pr.id };
        }),
      unchanged: plan.unchanged_roles,
    },
    bindings: {
      create: plan.bindings
        .filter((b) => b.action === 'create')
        .map((b) => {
          const cb = b as Extract<BindingAction, { action: 'create' }>;
          return {
            role: cb.roleName,
            subject_type: cb.binding.subject.type,
            subject_id: cb.binding.subject.id,
            scope: normalizeBindingScope(cb.binding.scope) ?? null,
            project_id: cb.binding.project_id,
          };
        }),
      replace: plan.bindings
        .filter((b) => b.action === 'replace')
        .map((b) => {
          const rb = b as Extract<BindingAction, { action: 'replace' }>;
          return {
            id: rb.existing.id,
            role: rb.roleName,
            subject_type: rb.binding.subject.type,
            subject_id: rb.binding.subject.id,
            scope: normalizeBindingScope(rb.binding.scope) ?? null,
            project_id: rb.binding.project_id,
            changes: rb.changes,
          };
        }),
      prune: plan.bindings
        .filter((b) => b.action === 'prune')
        .map((b) => {
          const pb = b as Extract<BindingAction, { action: 'prune' }>;
          return {
            id: pb.binding.id,
            role: pb.binding.role_name,
            subject_type: pb.binding.principal_type,
            subject_id: pb.binding.principal_id,
            project_id: pb.binding.project_id,
          };
        }),
      unchanged: plan.unchanged_bindings,
    },
  };
}

// ── plan ────────────────────────────────────────────────────────────────────

async function handlePlan(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  const filePath = resolveFilePath(flags);
  const yaml = loadAccessYaml(filePath);
  const errors = semanticValidate(yaml);
  if (errors.length > 0) {
    const lines = errors.map((e) => `  ${e.path}: ${e.message}`);
    throw new Error(`Validation failed:\n${lines.join('\n')}`);
  }

  const plan = await computePlan(yaml, orgId, context);

  if (json) {
    outputJson(planToJson(plan, orgId), json);
    return;
  }

  printPlan(plan, orgId, false);
}

// ── sync ────────────────────────────────────────────────────────────────────

async function fetchOrgGroups(
  orgId: string,
  context: ResolvedContext,
): Promise<AccessGroupResponse[]> {
  const groupsResponse = await requestJson<{ data: AccessGroupResponse[] } | AccessGroupResponse[]>(
    context,
    `/orgs/${orgId}/access/groups`,
  );
  return unwrapListResponse(groupsResponse);
}

function resolveBindingPrincipalIdForApply(
  principalType: 'user' | 'service_principal' | 'group',
  principalIdHint: string,
  groupIdsBySlug: Map<string, string>,
  groupIds: Set<string>,
): string {
  if (principalType !== 'group') {
    return principalIdHint;
  }

  if (groupIds.has(principalIdHint)) {
    return principalIdHint;
  }

  const fromSlug = groupIdsBySlug.get(principalIdHint);
  if (fromSlug) {
    return fromSlug;
  }

  throw new Error(`Group '${principalIdHint}' does not exist in the target org`);
}

async function handleSync(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
  if (!orgId) {
    throw new Error('--org is required (or set a default org in your profile)');
  }

  const filePath = resolveFilePath(flags);
  const yaml = loadAccessYaml(filePath);
  const errors = semanticValidate(yaml);
  if (errors.length > 0) {
    const lines = errors.map((e) => `  ${e.path}: ${e.message}`);
    throw new Error(`Validation failed:\n${lines.join('\n')}`);
  }

  const prune = getBooleanFlag(flags, ['prune']) ?? false;
  const yes = getBooleanFlag(flags, ['yes', 'y']) ?? false;

  const plan = await computePlan(yaml, orgId, context);

  if (!hasChanges(plan, prune)) {
    if (json) {
      outputJson({ applied: false, reason: 'no_changes', org_id: orgId }, json);
      return;
    }
    console.log('No changes needed. Access policies are in sync.');
    return;
  }

  // Show the plan and optionally prompt
  if (!yes) {
    printPlan(plan, orgId, prune);
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('Apply these changes? [y/N]: ');
      if (!answer || !['y', 'yes'].includes(answer.toLowerCase())) {
        console.log('Aborted.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  // ── Apply changes ──────────────────────────────────────────────────────

  const applied = {
    groups_created: 0,
    groups_updated: 0,
    groups_deleted: 0,
    group_members_added: 0,
    group_members_removed: 0,
    roles_created: 0,
    roles_updated: 0,
    roles_deleted: 0,
    bindings_created: 0,
    bindings_replaced: 0,
    bindings_deleted: 0,
  };

  // 1. Create roles first (bindings reference them by name)
  for (const ra of plan.roles) {
    if (ra.action === 'create') {
      await requestJson<AccessRoleResponse>(
        context,
        `/orgs/${orgId}/access/roles`,
        {
          method: 'POST',
          body: {
            name: ra.name,
            scope: ra.role.scope,
            permissions: ra.role.permissions,
            description: ra.role.description,
          },
        },
      );
      applied.roles_created++;
      if (!json) console.log(`  + Created role '${ra.name}'`);
    }
  }

  // 2. Update existing roles
  for (const ra of plan.roles) {
    if (ra.action === 'update') {
      // Look up the declared role from YAML to get the desired state
      const declaredRole = (yaml.access.roles ?? {})[ra.name];
      if (!declaredRole) continue;

      const body: { permissions?: string[]; description?: string } = {};
      body.permissions = declaredRole.permissions;
      if (declaredRole.description !== undefined) {
        body.description = declaredRole.description;
      }

      await requestJson<AccessRoleResponse>(
        context,
        `/orgs/${orgId}/access/roles/${ra.id}`,
        { method: 'PATCH', body },
      );
      applied.roles_updated++;
      if (!json) console.log(`  ~ Updated role '${ra.name}'`);
    }
  }

  // 3. Create and update groups
  for (const ga of plan.groups) {
    if (ga.action === 'create') {
      const payload = {
        name: ga.group.name ?? groupDefaultName(ga.slug),
        slug: ga.slug,
        description: ga.group.description,
      };
      await requestJson<AccessGroupResponse>(
        context,
        `/orgs/${orgId}/access/groups`,
        {
          method: 'POST',
          body: payload,
        },
      );
      applied.groups_created++;
      if (!json) console.log(`  + Created group '${ga.slug}'`);
      continue;
    }

    if (ga.action === 'update') {
      const payload: Record<string, unknown> = {
        name: ga.group.name ?? groupDefaultName(ga.slug),
        description: ga.group.description ?? null,
      };
      await requestJson<AccessGroupResponse>(
        context,
        `/orgs/${orgId}/access/groups/${encodeURIComponent(ga.id)}`,
        {
          method: 'PATCH',
          body: payload,
        },
      );
      applied.groups_updated++;
      if (!json) console.log(`  ~ Updated group '${ga.slug}'`);
    }
  }

  // Refresh group ID maps after group creates/updates.
  const groupsAfterCreateUpdate = await fetchOrgGroups(orgId, context);
  const groupIdsBySlug = new Map(groupsAfterCreateUpdate.map((group) => [group.slug, group.id]));
  const groupIds = new Set(groupsAfterCreateUpdate.map((group) => group.id));

  // 4. Sync group memberships
  for (const ma of plan.group_members) {
    if (ma.action === 'add') {
      const groupId = groupIdsBySlug.get(ma.groupSlug);
      if (!groupId) {
        throw new Error(`Cannot add member: group '${ma.groupSlug}' does not exist in org '${orgId}'`);
      }

      await requestJson<AccessGroupMemberResponse>(
        context,
        `/orgs/${orgId}/access/groups/${encodeURIComponent(groupId)}/members`,
        {
          method: 'POST',
          body: {
            principal_type: ma.member.type,
            principal_id: ma.member.id,
          },
        },
      );
      applied.group_members_added++;
      if (!json) console.log(`  + Added ${ma.member.type}:${ma.member.id} to group '${ma.groupSlug}'`);
      continue;
    }

    const groupId = groupIdsBySlug.get(ma.groupSlug) ?? ma.groupId;
    await requestJson<void>(
      context,
      `/orgs/${orgId}/access/groups/${encodeURIComponent(groupId)}/members/${ma.member.principal_type}/${encodeURIComponent(ma.member.principal_id)}`,
      { method: 'DELETE' },
    );
    applied.group_members_removed++;
    if (!json) console.log(`  - Removed ${ma.member.principal_type}:${ma.member.principal_id} from group '${ma.groupSlug}'`);
  }

  // 5. Create and replace bindings
  for (const ba of plan.bindings) {
    if (ba.action !== 'create' && ba.action !== 'replace') {
      continue;
    }

    const principalId = resolveBindingPrincipalIdForApply(
      ba.binding.subject.type,
      ba.principalIdHint,
      groupIdsBySlug,
      groupIds,
    );

    if (ba.action === 'replace') {
      await requestJson<void>(
        context,
        `/orgs/${orgId}/access/bindings/${ba.existing.id}`,
        { method: 'DELETE' },
      );
    }

    const body: Record<string, unknown> = {
      role_name: ba.roleName,
      principal_type: ba.binding.subject.type,
      principal_id: principalId,
    };

    if (ba.binding.project_id) {
      body.project_id = ba.binding.project_id;
    }

    const normalizedScope = normalizeBindingScope(ba.binding.scope);
    if (normalizedScope) {
      body.scope_json = normalizedScope;
    }

    await requestJson<AccessBindingResponse>(
      context,
      `/orgs/${orgId}/access/bindings`,
      { method: 'POST', body },
    );

    const scopeLabel = ba.binding.project_id
      ? `project: ${ba.binding.project_id}`
      : 'org-wide';

    if (ba.action === 'create') {
      applied.bindings_created++;
      if (!json) {
        console.log(
          `  + Bound ${ba.roleName} -> ${ba.binding.subject.type}:${principalId} (${scopeLabel}, scope=${formatBindingScope(ba.binding.scope)})`,
        );
      }
    } else {
      applied.bindings_replaced++;
      if (!json) {
        console.log(
          `  ~ Rebound ${ba.roleName} -> ${ba.binding.subject.type}:${principalId} (${scopeLabel}, scope=${formatBindingScope(ba.binding.scope)})`,
        );
      }
    }
  }

  // 6. Prune (only if --prune)
  if (prune) {
    // Delete bindings first (they reference roles)
    for (const ba of plan.bindings) {
      if (ba.action === 'prune') {
        await requestJson<void>(
          context,
          `/orgs/${orgId}/access/bindings/${ba.binding.id}`,
          { method: 'DELETE' },
        );
        applied.bindings_deleted++;
        if (!json) {
          const scopeLabel = ba.binding.project_id
            ? `project: ${ba.binding.project_id}`
            : 'org-wide';
          console.log(`  - Unbound ${ba.binding.role_name} from ${ba.binding.principal_type}:${ba.binding.principal_id} (${scopeLabel})`);
        }
      }
    }

    // Then delete undeclared groups (group delete also removes group-principal bindings)
    for (const ga of plan.groups) {
      if (ga.action === 'prune') {
        await requestJson<void>(
          context,
          `/orgs/${orgId}/access/groups/${encodeURIComponent(ga.id)}`,
          { method: 'DELETE' },
        );
        applied.groups_deleted++;
        if (!json) console.log(`  - Deleted group '${ga.slug}'`);
      }
    }

    // Then delete roles
    for (const ra of plan.roles) {
      if (ra.action === 'prune') {
        await requestJson<void>(
          context,
          `/orgs/${orgId}/access/roles/${ra.id}`,
          { method: 'DELETE' },
        );
        applied.roles_deleted++;
        if (!json) console.log(`  - Deleted role '${ra.name}'`);
      }
    }
  }

  // Summary
  if (json) {
    outputJson({ applied: true, org_id: orgId, ...applied }, json);
    return;
  }

  const parts: string[] = [];
  if (applied.groups_created > 0) parts.push(`${applied.groups_created} group(s) created`);
  if (applied.groups_updated > 0) parts.push(`${applied.groups_updated} group(s) updated`);
  if (applied.groups_deleted > 0) parts.push(`${applied.groups_deleted} group(s) deleted`);
  if (applied.group_members_added > 0) parts.push(`${applied.group_members_added} group member(s) added`);
  if (applied.group_members_removed > 0) parts.push(`${applied.group_members_removed} group member(s) removed`);
  if (applied.roles_created > 0) parts.push(`${applied.roles_created} role(s) created`);
  if (applied.roles_updated > 0) parts.push(`${applied.roles_updated} role(s) updated`);
  if (applied.roles_deleted > 0) parts.push(`${applied.roles_deleted} role(s) deleted`);
  if (applied.bindings_created > 0) parts.push(`${applied.bindings_created} binding(s) created`);
  if (applied.bindings_replaced > 0) parts.push(`${applied.bindings_replaced} binding(s) replaced`);
  if (applied.bindings_deleted > 0) parts.push(`${applied.bindings_deleted} binding(s) deleted`);
  console.log(`\nSync complete: ${parts.join(', ')}`);
}
