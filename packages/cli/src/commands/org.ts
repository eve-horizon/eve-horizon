import type { FlagValue } from '../lib/args';
import { toBoolean, getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, requestRaw } from '../lib/client';
import { outputJson } from '../lib/output';
import { buildQuery, parseSinceValue } from '../lib/format';

const DEFAULT_ORG_NAME = process.env.EVE_ORG_NAME || 'default-test-org';
const DEFAULT_ORG_ID = process.env.EVE_ORG_ID || 'org_defaulttestorg';

export async function handleOrg(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'ensure': {
      let orgId = getStringFlag(flags, ['id']) ?? '';
      let orgName = getStringFlag(flags, ['name']) ?? '';
      let orgSlug = getStringFlag(flags, ['slug']) ?? '';
      const nameOrId = positionals[0];

      if (!orgId && nameOrId) {
        if (/^org_[a-zA-Z0-9]+$/.test(nameOrId)) {
          orgId = nameOrId;
          orgName = orgName || nameOrId;
        } else {
          orgName = orgName || nameOrId;
          orgId = normalizeOrgId(nameOrId);
        }
      }

      orgId = orgId || context.orgId || DEFAULT_ORG_ID;
      orgName = orgName || DEFAULT_ORG_NAME;

      const body = { id: orgId, name: orgName, ...(orgSlug ? { slug: orgSlug } : {}) };
      const org = await requestJson<{ id: string; name: string; slug: string }>(context, '/orgs/ensure', {
        method: 'POST',
        body,
      });
      outputJson(org, json, `✓ Organization ready: ${org.id} (${org.name})`);
      return;
    }
    case 'list': {
      const includeDeletedFlag = flags.include_deleted ?? flags['include-deleted'];
      const query = buildQuery({
        limit: getStringFlag(flags, ['limit']),
        offset: getStringFlag(flags, ['offset']),
        include_deleted: toBoolean(includeDeletedFlag) ? 'true' : undefined,
        name: getStringFlag(flags, ['name']),
      });
      const response = await requestJson(context, `/orgs${query}`);
      outputJson(response, json);
      return;
    }
    case 'get': {
      const orgId = positionals[0];
      if (!orgId) throw new Error('Usage: eve org get <org_id>');
      const includeDeletedFlag = flags.include_deleted ?? flags['include-deleted'];
      const query = buildQuery({
        include_deleted: toBoolean(includeDeletedFlag) ? 'true' : undefined,
      });
      const response = await requestJson(context, `/orgs/${orgId}${query}`);
      outputJson(response, json);
      return;
    }
    case 'spend': {
      const orgId = positionals[0] ?? (getStringFlag(flags, ['org']) ?? context.orgId);
      if (!orgId) {
        throw new Error('Usage: eve org spend <org_id> [--since 7d] [--until <iso>] [--currency usd] [--json]');
      }

      const sinceRaw = getStringFlag(flags, ['since']) ?? '7d';
      const untilRaw = getStringFlag(flags, ['until']);
      const currency = getStringFlag(flags, ['currency']);

      const query = buildQuery({
        since: sinceRaw ? parseSinceValue(sinceRaw) : undefined,
        until: untilRaw ? parseSinceValue(untilRaw) : undefined,
        currency,
      });

      const response = await requestJson<any>(context, `/orgs/${orgId}/spend${query}`);
      if (json) {
        outputJson(response, json);
        return;
      }

      console.log(`Org spend: ${response.org_id ?? orgId}`);
      const summary = response.summary ?? {};
      console.log(`  Window: ${summary.since ?? 'all-time'} → ${summary.until ?? 'now'}`);
      console.log(`  Attempts: ${summary.attempts ?? 0}`);
      console.log(`  Base total (usd): ${summary.base_total_usd ?? '0'}`);
      console.log(`  Billed total (${summary.billed_currency ?? currency ?? 'usd'}): ${summary.billed_total ?? '0'}`);
      return;
    }
    case 'update': {
      const orgId = positionals[0];
      if (!orgId) {
        throw new Error('Usage: eve org update <org_id> [--name <name>] [--deleted <bool>] [--default-agent <slug>]');
      }
      const body: Record<string, unknown> = {};
      if (typeof flags.name === 'string') body.name = flags.name;
      const deleted = toBoolean(flags.deleted);
      if (deleted !== undefined) body.deleted = deleted;
      if (typeof flags['default-agent'] === 'string') {
        const value = flags['default-agent'].trim();
        body.default_agent_slug = (value === '' || value === 'none' || value === 'null') ? null : value;
      }
      const billingConfigRaw = typeof flags['billing-config'] === 'string'
        ? flags['billing-config']
        : (getStringFlag(flags, ['billing_config']));
      if (billingConfigRaw !== undefined) {
        try {
          body.billing_config = billingConfigRaw.trim() ? JSON.parse(billingConfigRaw) : null;
        } catch (err) {
          throw new Error(`Invalid --billing-config JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const response = await requestJson(context, `/orgs/${orgId}`, { method: 'PATCH', body });
      outputJson(response, json);
      return;
    }
    case 'delete': {
      const orgId = positionals[0];
      if (!orgId) throw new Error('Usage: eve org delete <org_id> [--hard] [--force]');
      const hard = toBoolean(flags.hard) ?? false;
      const force = toBoolean(flags.force) ?? false;
      const query = buildQuery({ hard: hard ? 'true' : undefined, force: force ? 'true' : undefined });
      await requestRaw(context, `/orgs/${orgId}${query}`, { method: 'DELETE' });
      const mode = hard ? 'hard-deleted' : 'soft-deleted';
      outputJson({ org_id: orgId, deleted: true, mode }, json, `✓ Organization ${orgId} ${mode}`);
      return;
    }
    case 'members': {
      const action = positionals[0]; // list | add | remove
      const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      switch (action) {
        case 'add': {
          const email = getStringFlag(flags, ['email']) ?? positionals[1];
          const role = getStringFlag(flags, ['role']) ?? 'member';
          if (!email) {
            throw new Error('Usage: eve org members add <email> [--role member|admin|owner]');
          }
          const response = await requestJson(context, `/orgs/${orgId}/members`, {
            method: 'POST',
            body: { email, role },
          });
          outputJson(response, json, `✓ Member added to org ${orgId}`);
          return;
        }
        case 'remove': {
          const userId = positionals[1];
          if (!userId) {
            throw new Error('Usage: eve org members remove <user_id>');
          }
          await requestRaw(context, `/orgs/${orgId}/members/${userId}`, { method: 'DELETE' });
          outputJson({ org_id: orgId, user_id: userId, removed: true }, json, `✓ Member ${userId} removed from org ${orgId}`);
          return;
        }
        case 'list':
        default: {
          const response = await requestJson(context, `/orgs/${orgId}/members`);
          outputJson(response, json);
          return;
        }
      }
    }
    case 'invite': {
      const email = getStringFlag(flags, ['email']) ?? positionals[0];
      const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
      const role = getStringFlag(flags, ['role']) ?? 'member';
      const projectId = getStringFlag(flags, ['project', 'project-id', 'project_id']);
      const redirectTo = getStringFlag(flags, ['redirect-to', 'redirect_to']);
      const sendEmail = !(toBoolean(flags['no-email']) ?? toBoolean(flags.no_email) ?? false);

      if (!email || !orgId) {
        throw new Error('Usage: eve org invite <email> --org <org_id> [--project <project_id>] [--role member|admin|owner] [--redirect-to <url>] [--no-email]');
      }
      if (!['owner', 'admin', 'member'].includes(role)) {
        throw new Error(`Invalid role: ${role}. Must be one of: owner, admin, member`);
      }

      const body: Record<string, unknown> = {
        email,
        role,
        send_email: sendEmail,
      };
      if (projectId) body.project_id = projectId;
      if (redirectTo) body.redirect_to = redirectTo;

      const response = await requestJson<{
        id: string;
        org_id: string;
        identity_hint: string | null;
        role: string;
        redirect_to?: string | null;
        app_context?: Record<string, unknown> | null;
      }>(context, `/orgs/${orgId}/invites`, {
        method: 'POST',
        body,
      });
      outputJson(
        response,
        json,
        `✓ Invite created for ${email}${projectId ? ` using project ${projectId}` : ''}${sendEmail ? ' and email sent' : ''}`,
      );
      return;
    }
    case 'membership-requests': {
      const action = positionals[0]; // list | approve | deny
      const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      switch (action) {
        case 'approve': {
          const requestId = positionals[1];
          if (!requestId) {
            throw new Error('Usage: eve org membership-requests approve <request_id> [--role member|admin]');
          }
          const role = getStringFlag(flags, ['role']) ?? 'member';
          const email = getStringFlag(flags, ['email']);
          const body: Record<string, unknown> = { role };
          if (email) body.email = email;
          const response = await requestJson(context, `/orgs/${orgId}/membership-requests/${requestId}/approve`, {
            method: 'POST',
            body,
          });
          outputJson(response, json, `✓ Membership request ${requestId} approved`);
          return;
        }
        case 'deny': {
          const requestId = positionals[1];
          if (!requestId) {
            throw new Error('Usage: eve org membership-requests deny <request_id>');
          }
          const response = await requestJson(context, `/orgs/${orgId}/membership-requests/${requestId}/deny`, {
            method: 'POST',
          });
          outputJson(response, json, `✓ Membership request ${requestId} denied`);
          return;
        }
        case 'list':
        default: {
          const status = getStringFlag(flags, ['status']);
          const query = status ? `?status=${status}` : '';
          const response = await requestJson(context, `/orgs/${orgId}/membership-requests${query}`);
          outputJson(response, json);
          return;
        }
      }
    }
    default:
      throw new Error('Usage: eve org <ensure|list|get|spend|update|delete|members|invite|membership-requests>');
  }
}

function normalizeOrgId(raw: string): string {
  if (/^org_[a-zA-Z0-9]+$/.test(raw)) {
    return raw;
  }
  const stripped = raw.replace(/[^a-zA-Z0-9]/g, '');
  if (!stripped) {
    throw new Error('Organization id must contain alphanumeric characters');
  }
  return `org_${stripped}`;
}
