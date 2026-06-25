import type { FlagValue } from '../lib/args';
import { getStringFlag, getBooleanFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, unwrapListResponse } from '../lib/client';
import { outputJson } from '../lib/output';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_BILLING_DEFAULTS_V1,
  DEFAULT_RATE_CARD_EFFECTIVE_AT,
  DEFAULT_RATE_CARD_NAME,
  DEFAULT_RATE_CARD_V1,
  DEFAULT_RATE_CARD_VERSION,
  DEFAULT_RESOURCE_CLASSES_V1,
} from '@eve/shared';

type IdentityResponse = {
  id: string;
  user_id: string;
  provider: string;
  fingerprint: string;
  label: string | null;
  created_at: string;
  updated_at: string;
};

type MemberResponse = {
  org_id: string;
  user_id: string;
  role: string;
  created_at: string;
  updated_at: string;
};

export async function handleAdmin(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'users': {
      return handleUsers(flags, context, json);
    }
    case 'invite': {
      const githubUsername = getStringFlag(flags, ['github']);
      const sshKeyPath = getStringFlag(flags, ['ssh-key']);
      const email = getStringFlag(flags, ['email']);
      const role = getStringFlag(flags, ['role']) ?? 'member';
      const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
      const web = getBooleanFlag(flags, ['web']) ?? false;
      const redirectTo = getStringFlag(flags, ['redirect-to']);

      if (!email) {
        throw new Error('Usage: eve admin invite --email <email> [--github <username>] [--ssh-key <path>] [--role <role>] [--org <org_id>] [--web] [--redirect-to <url>]');
      }

      if (!['owner', 'admin', 'member'].includes(role)) {
        throw new Error(`Invalid role: ${role}. Must be one of: owner, admin, member`);
      }

      if (!orgId) {
        throw new Error('No org specified. Use --org <org_id> or set a default org in your profile.');
      }

      const results: {
        keys_registered: number;
        identities: IdentityResponse[];
        membership?: MemberResponse;
        web_invite_sent?: boolean;
      } = {
        keys_registered: 0,
        identities: [],
      };

      // Add user to org first - this creates the user if they don't exist
      if (orgId) {
        const membership = await requestJson<MemberResponse>(context, `/orgs/${orgId}/members`, {
          method: 'POST',
          body: {
            email,
            role,
          },
        });
        results.membership = membership;
      }

      // Fetch and register GitHub SSH keys if username provided
      // Now that user exists (created via org membership), identity registration will work
      if (githubUsername) {
        const keys = await fetchGitHubKeys(githubUsername);

        if (keys.length === 0) {
          throw new Error(`No SSH keys found for GitHub user: ${githubUsername}`);
        }

        for (const publicKey of keys) {
          const identity = await requestJson<IdentityResponse>(context, '/auth/identities', {
            method: 'POST',
            body: {
              email,
              public_key: publicKey,
              label: `github-${githubUsername}`,
            },
          });
          results.identities.push(identity);
          results.keys_registered += 1;
        }
      }

      // Register SSH public key from file if --ssh-key provided
      if (sshKeyPath) {
        if (!existsSync(sshKeyPath)) {
          throw new Error(`SSH public key not found: ${sshKeyPath}`);
        }
        const publicKey = readFileSync(sshKeyPath, 'utf8').trim();
        if (!publicKey.startsWith('ssh-')) {
          throw new Error(`File does not look like an SSH public key: ${sshKeyPath}`);
        }
        const identity = await requestJson<IdentityResponse>(context, '/auth/identities', {
          method: 'POST',
          body: {
            email,
            public_key: publicKey,
            label: `ssh-key`,
          },
        });
        results.identities.push(identity);
        results.keys_registered += 1;
      }

      // Warn if no auth method was provided
      if (!githubUsername && !sshKeyPath && !web) {
        console.warn('Warning: No auth method specified (--github, --ssh-key, or --web). User won\'t be able to log in.');
        console.warn('Tip: The user can self-register via: eve auth request-access --org "<org>" --ssh-key ~/.ssh/id_ed25519.pub --wait');
      }

      // Send Supabase Auth invite email if --web flag is set
      if (web) {
        const body: Record<string, string> = { email };
        if (redirectTo) {
          body.redirect_to = redirectTo;
        }
        await requestJson<{ email: string; invited: boolean }>(context, '/auth/supabase/invite', {
          method: 'POST',
          body,
        });
        results.web_invite_sent = true;
      }

      const summary = [
        `Invited ${email}`,
        results.keys_registered > 0 ? `${results.keys_registered} SSH key(s) registered` : null,
        results.membership ? `Added to ${orgId} as ${role}` : null,
        results.web_invite_sent ? 'Web invite email sent' : null,
      ].filter(Boolean).join(', ');

      outputJson(results, json, `+ ${summary}`);
      return;
    }
    case 'pricing': {
      const action = positionals[0];

      switch (action) {
        case 'seed-defaults': {
          const results: {
            rate_card: { created: boolean; id?: string; name: string; version: number };
            billing_defaults: { created: boolean; key: string };
            resource_classes: { created: boolean; key: string };
          } = {
            rate_card: { created: false, name: DEFAULT_RATE_CARD_NAME, version: DEFAULT_RATE_CARD_VERSION },
            billing_defaults: { created: false, key: 'billing.defaults' },
            resource_classes: { created: false, key: 'resource_classes' },
          };

          // 1) Seed the default rate card (idempotent)
          const existing = await requestJson<any[]>(
            context,
            `/admin/pricing/rate-cards?name=${encodeURIComponent(DEFAULT_RATE_CARD_NAME)}`,
          );
          if (!Array.isArray(existing) || existing.length === 0) {
            const created = await requestJson<any>(context, '/admin/pricing/rate-cards', {
              method: 'POST',
              body: {
                name: DEFAULT_RATE_CARD_NAME,
                version: DEFAULT_RATE_CARD_VERSION,
                effective_at: DEFAULT_RATE_CARD_EFFECTIVE_AT,
                rates_json: DEFAULT_RATE_CARD_V1 as any,
              },
            });
            results.rate_card.created = true;
            results.rate_card.id = created?.id;
          }

          // 2) Seed system billing defaults (idempotent)
          try {
            await requestJson<any>(context, '/system/settings/billing.defaults');
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!message.includes('HTTP 404')) {
              throw err;
            }
            await requestJson<any>(context, '/system/settings/billing.defaults', {
              method: 'PUT',
              body: {
                value: JSON.stringify(DEFAULT_BILLING_DEFAULTS_V1),
                description: 'Default billing config (currency, markup, rate card)',
              },
            });
            results.billing_defaults.created = true;
          }

          // 3) Seed system resource classes (idempotent)
          try {
            await requestJson<any>(context, '/system/settings/resource_classes');
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!message.includes('HTTP 404')) {
              throw err;
            }
            await requestJson<any>(context, '/system/settings/resource_classes', {
              method: 'PUT',
              body: {
                value: JSON.stringify(DEFAULT_RESOURCE_CLASSES_V1),
                description: 'Default resource classes (job SKUs for compute sizing)',
              },
            });
            results.resource_classes.created = true;
          }

          const summaryParts = [
            results.rate_card.created ? 'Seeded default rate card' : 'Default rate card already present',
            results.billing_defaults.created ? 'Seeded billing.defaults' : 'billing.defaults already present',
            results.resource_classes.created ? 'Seeded resource_classes' : 'resource_classes already present',
          ];

          outputJson(results, json, `+ ${summaryParts.join('; ')}`);
          return;
        }
        case 'refresh-openrouter': {
          const dryRun = Boolean(flags['dry-run'] ?? flags.dry_run);
          const name = getStringFlag(flags, ['name']) ?? 'default';
          const effectiveAt = getStringFlag(flags, ['effective-at', 'effective_at']);

          const body: Record<string, unknown> = {
            dry_run: dryRun,
            name,
            ...(effectiveAt ? { effective_at: effectiveAt } : {}),
          };

          type RefreshResponse = {
            diff: {
              new_models: { provider: string; model: string; input_per_million_usd: string; output_per_million_usd: string }[];
              changed_prices: { provider: string; model: string; current: { input: string; output: string }; proposed: { input: string; output: string } }[];
              unchanged: number;
            };
            dry_run: boolean;
            rate_card: { id: string; name: string; version: number; effective_at: string };
          };

          const response = await requestJson<RefreshResponse>(context, '/admin/pricing/refresh-openrouter', {
            method: 'POST',
            body,
          });

          if (json) {
            outputJson(response, true);
            return;
          }

          const { diff } = response;

          // New models
          if (diff.new_models.length > 0) {
            console.log(`\n  New models (${diff.new_models.length}):`);
            for (const m of diff.new_models) {
              console.log(`    + ${m.provider}/${m.model}  in=$${m.input_per_million_usd}  out=$${m.output_per_million_usd}`);
            }
          }

          // Changed prices
          if (diff.changed_prices.length > 0) {
            console.log(`\n  Changed prices (${diff.changed_prices.length}):`);
            for (const c of diff.changed_prices) {
              console.log(`    ~ ${c.provider}/${c.model}`);
              console.log(`        in:  $${c.current.input} -> $${c.proposed.input}`);
              console.log(`        out: $${c.current.output} -> $${c.proposed.output}`);
            }
          }

          // Unchanged
          console.log(`\n  Unchanged: ${diff.unchanged}`);

          // Summary
          if (response.dry_run) {
            console.log(`\n  (dry run — no changes applied)`);
          } else {
            const rc = response.rate_card;
            console.log(`\n  Rate card updated: ${rc.name} v${rc.version} (${rc.id})`);
            console.log(`  Effective at: ${rc.effective_at}`);
          }

          return;
        }
        default:
          throw new Error('Usage: eve admin pricing <seed-defaults|refresh-openrouter> [--json]');
      }
    }
    case 'receipts': {
      const action = positionals[0];
      if (action !== 'recompute') {
        throw new Error('Usage: eve admin receipts recompute --since <iso|7d> [--project proj_xxx] [--dry-run] [--force] [--json]');
      }

      const sinceRaw = getStringFlag(flags, ['since']);
      const since = sinceRaw ? parseSinceValue(sinceRaw) : undefined;
      const projectId = getStringFlag(flags, ['project']);
      const dryRun = Boolean(flags['dry-run'] ?? flags.dry_run);
      const force = Boolean(flags.force);

      const body: Record<string, unknown> = {
        ...(since ? { since } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        ...(dryRun ? { dry_run: true } : {}),
        ...(force ? { force: true } : {}),
      };

      const response = await requestJson<any>(context, '/admin/receipts/recompute', {
        method: 'POST',
        body,
      });

      const summaryParts = [
        `scanned=${response.scanned_attempts ?? 0}`,
        `updated=${response.updated_attempts ?? 0}`,
        `skipped=${response.skipped_attempts ?? 0}`,
        response.dry_run ? 'dry-run' : null,
        response.force ? 'force' : null,
      ].filter(Boolean);

      outputJson(response, json, `+ Receipts recompute: ${summaryParts.join(' ')}`);
      return;
    }
    case 'balance': {
      const action = positionals[0];
      const orgId = positionals[1] ?? getStringFlag(flags, ['org']) ?? context.orgId;

      if (!orgId) {
        throw new Error('No org specified. Provide org ID as argument or use --org <org_id>.');
      }

      switch (action) {
        case 'show': {
          const response = await requestJson<any>(context, `/admin/orgs/${orgId}/balance`);
          outputJson(response, json, formatBalanceSummary(response));
          return;
        }
        case 'credit': {
          const amount = getStringFlag(flags, ['amount']);
          const currency = getStringFlag(flags, ['currency']) ?? 'usd';
          const reason = getStringFlag(flags, ['reason']);
          const sourceType = getStringFlag(flags, ['source-type', 'source_type']);

          if (!amount) {
            throw new Error('Usage: eve admin balance credit <org> --amount <n> --currency <c> --reason <r>');
          }

          const body: Record<string, unknown> = {
            amount,
            currency,
            ...(reason ? { reason } : {}),
            ...(sourceType ? { source_type: sourceType } : {}),
          };

          const response = await requestJson<any>(context, `/admin/orgs/${orgId}/balance/credit`, {
            method: 'POST',
            body,
          });

          outputJson(response, json, `+ Credit: ${response.amount} ${response.currency} to ${orgId} (${response.id})`);
          return;
        }
        case 'transactions': {
          const sinceRaw = getStringFlag(flags, ['since']);
          const untilRaw = getStringFlag(flags, ['until']);
          const limit = getStringFlag(flags, ['limit']);

          const params = new URLSearchParams();
          if (sinceRaw) params.set('since', parseSinceValue(sinceRaw));
          if (untilRaw) params.set('until', untilRaw);
          if (limit) params.set('limit', limit);

          const qs = params.toString();
          const path = `/admin/orgs/${orgId}/balance/transactions${qs ? `?${qs}` : ''}`;
          const response = await requestJson<any[]>(context, path);

          if (json) {
            outputJson(response, true);
          } else {
            if (!Array.isArray(response) || response.length === 0) {
              console.log('No transactions found.');
            } else {
              for (const tx of response) {
                const sign = tx.type === 'charge' ? '-' : '+';
                const desc = tx.description ? ` (${tx.description})` : '';
                console.log(`  ${tx.created_at}  ${sign}${tx.amount} ${tx.currency}  ${tx.type}/${tx.source_type}${desc}`);
              }
              console.log(`\n${response.length} transaction(s)`);
            }
          }
          return;
        }
        default:
          throw new Error('Usage: eve admin balance <show|credit|transactions> <org> [options]');
      }
    }
    case 'usage': {
      const action = positionals[0];
      const orgId = getStringFlag(flags, ['org']) ?? context.orgId;

      if (!orgId) {
        throw new Error('No org specified. Use --org <org_id> or set a default org in your profile.');
      }

      switch (action) {
        case 'list': {
          const sinceRaw = getStringFlag(flags, ['since']);
          const untilRaw = getStringFlag(flags, ['until']);
          const limit = getStringFlag(flags, ['limit']);

          const params = new URLSearchParams();
          if (sinceRaw) params.set('since', parseSinceValue(sinceRaw));
          if (untilRaw) params.set('until', untilRaw);
          if (limit) params.set('limit', limit);

          const qs = params.toString();
          const path = `/admin/orgs/${orgId}/usage${qs ? `?${qs}` : ''}`;
          const response = await requestJson<any[]>(context, path);

          if (json) {
            outputJson(response, true);
          } else {
            if (!Array.isArray(response) || response.length === 0) {
              console.log('No usage records found.');
            } else {
              for (const r of response) {
                const env = r.env_id ? ` env=${r.env_id}` : '';
                console.log(`  ${r.started_at}  ${r.quantity} ${r.unit}  ${r.resource_type}${env}  [${r.source_type}]`);
              }
              console.log(`\n${response.length} record(s)`);
            }
          }
          return;
        }
        case 'summary': {
          const sinceRaw = getStringFlag(flags, ['since']);
          const untilRaw = getStringFlag(flags, ['until']);

          const params = new URLSearchParams();
          if (sinceRaw) params.set('since', parseSinceValue(sinceRaw));
          if (untilRaw) params.set('until', untilRaw);

          const qs = params.toString();
          const path = `/admin/orgs/${orgId}/usage/summary${qs ? `?${qs}` : ''}`;
          const response = await requestJson<any>(context, path);

          if (json) {
            outputJson(response, true);
          } else {
            const aggregates = response.aggregates ?? [];
            if (aggregates.length === 0) {
              console.log(`No usage data for ${orgId}.`);
            } else {
              console.log(`Usage summary for ${orgId}:`);
              for (const a of aggregates) {
                console.log(`  ${a.resource_type}: ${a.total_quantity} ${a.unit}`);
              }
            }
          }
          return;
        }
        default:
          throw new Error('Usage: eve admin usage <list|summary> --org <orgId> [--since] [--until] [--limit] [--json]');
      }
    }
    case 'ingress-aliases': {
      const action = positionals[0] ?? 'list';

      switch (action) {
        case 'list': {
          const params = new URLSearchParams();
          const alias = getStringFlag(flags, ['alias']);
          const projectId = getStringFlag(flags, ['project', 'project_id']);
          const environmentId = getStringFlag(flags, ['environment', 'env', 'environment_id']);
          const limit = getStringFlag(flags, ['limit']);
          const offset = getStringFlag(flags, ['offset']);

          if (alias) params.set('alias', alias);
          if (projectId) params.set('project_id', projectId);
          if (environmentId) params.set('environment_id', environmentId);
          if (limit) params.set('limit', limit);
          if (offset) params.set('offset', offset);

          const query = params.toString();
          const path = `/admin/ingress-aliases${query ? `?${query}` : ''}`;
          const response = await requestJson<{ data: Array<{
            id: string;
            alias: string;
            project_id: string;
            environment_id: string | null;
            service_name: string;
            created_at: string;
            updated_at: string;
          }> }>(context, path);

          if (json) {
            outputJson(response, true);
            return;
          }

          const rows = Array.isArray(response.data) ? response.data : [];
          if (rows.length === 0) {
            console.log('No ingress aliases found.');
            return;
          }

          for (const row of rows) {
            console.log(`${row.alias}  project=${row.project_id}  env=${row.environment_id ?? '(reserved)'}  service=${row.service_name}`);
          }
          console.log(`\n${rows.length} alias(es)`);
          return;
        }
        case 'reclaim': {
          const alias = positionals[1] ?? getStringFlag(flags, ['alias']);
          const reason = getStringFlag(flags, ['reason']);
          if (!alias || !reason) {
            throw new Error('Usage: eve admin ingress-aliases reclaim <alias> --reason "<text>"');
          }

          const response = await requestJson<{
            alias: string;
            project_id: string;
            environment_id: string | null;
            service_name: string;
            reclaimed: boolean;
            reason: string;
          }>(context, `/admin/ingress-aliases/${encodeURIComponent(alias)}/reclaim`, {
            method: 'POST',
            body: { reason },
          });

          outputJson(
            response,
            json,
            `+ Reclaimed ${response.alias} (project=${response.project_id}, env=${response.environment_id ?? '(reserved)'})`,
          );
          return;
        }
        default:
          throw new Error('Usage: eve admin ingress-aliases <list|reclaim> [options]');
      }
    }
    case 'access-requests': {
      const action = positionals[0];

      type AccessRequestResponse = {
        id: string;
        provider: string;
        fingerprint: string;
        email: string | null;
        desired_org_name: string;
        desired_org_slug: string | null;
        status: string;
        reviewed_at: string | null;
        review_notes: string | null;
        user_id: string | null;
        org_id: string | null;
        created_at: string;
      };

      switch (action) {
        case 'approve': {
          const requestId = positionals[1];
          if (!requestId) {
            throw new Error('Usage: eve admin access-requests approve <request_id>');
          }
          const reason = getStringFlag(flags, ['reason']);
          const response = await requestJson<AccessRequestResponse>(
            context,
            `/admin/access-requests/${requestId}/approve`,
            { method: 'POST', body: reason ? { notes: reason } : {} },
          );
          outputJson(response, json, `Approved ${response.id} → user=${response.user_id}, org=${response.org_id}`);
          return;
        }
        case 'reject': {
          const requestId = positionals[1];
          if (!requestId) {
            throw new Error('Usage: eve admin access-requests reject <request_id> [--reason "..."]');
          }
          const reason = getStringFlag(flags, ['reason']);
          const response = await requestJson<AccessRequestResponse>(
            context,
            `/admin/access-requests/${requestId}/reject`,
            { method: 'POST', body: reason ? { notes: reason } : {} },
          );
          outputJson(response, json, `Rejected ${response.id}`);
          return;
        }
        default: {
          // List pending
          const requestsResponse = await requestJson<{ data: AccessRequestResponse[] } | AccessRequestResponse[]>(
            context,
            '/admin/access-requests',
          );
          const requests = unwrapListResponse(requestsResponse);

          if (json) {
            outputJson({ data: requests }, true);
            return;
          }

          if (requests.length === 0) {
            console.log('No pending access requests.');
            return;
          }

          console.log(`${requests.length} pending access request(s):\n`);
          for (const r of requests) {
            console.log(`  ${r.id}`);
            console.log(`    Provider: ${r.provider} (${r.fingerprint.substring(0, 20)}...)`);
            console.log(`    Org:      ${r.desired_org_name}${r.desired_org_slug ? ` (${r.desired_org_slug})` : ''}`);
            if (r.email) console.log(`    Email:    ${r.email}`);
            console.log(`    Created:  ${r.created_at}`);
            console.log('');
          }
          console.log(`Approve: eve admin access-requests approve <id>`);
          console.log(`Reject:  eve admin access-requests reject <id> --reason "..."`);
          console.log('');
          console.log(`Tip: Users can self-register with: eve auth request-access --org "Org Name" --ssh-key ~/.ssh/id_ed25519.pub --wait`);
          return;
        }
      }
    }
    case 'email': {
      const action = positionals[0];
      const subAction = positionals[1];
      if (action === 'bounces' && (subAction === 'list' || subAction === undefined)) {
        const recipient = getStringFlag(flags, ['recipient']);
        const eventType = getStringFlag(flags, ['event-type']);
        const limit = getStringFlag(flags, ['limit']);
        const params = new URLSearchParams();
        if (recipient) params.set('recipient', recipient);
        if (eventType) params.set('event_type', eventType);
        if (limit) params.set('limit', limit);
        const query = params.toString();
        const response = await requestJson<{ events: EmailDeliveryEventCli[] }>(
          context,
          `/admin/email-bounces${query ? `?${query}` : ''}`,
        );
        if (json) {
          outputJson(response, true);
          return;
        }
        if (response.events.length === 0) {
          console.log('No recent email delivery events.');
          return;
        }
        console.log(`${response.events.length} email delivery event(s):\n`);
        for (const ev of response.events) {
          const detail = [
            ev.bounce_type ?? null,
            ev.bounce_subtype ?? null,
            ev.diagnostic ? ev.diagnostic.split('\n')[0].slice(0, 120) : null,
          ]
            .filter(Boolean)
            .join(' / ');
          console.log(`  ${ev.received_at}  ${ev.event_type.padEnd(10)}  ${ev.recipient}`);
          if (detail) console.log(`    ${detail}`);
          if (ev.ses_message_id) console.log(`    ses_message_id=${ev.ses_message_id}`);
        }
        return;
      }
      throw new Error('Usage: eve admin email bounces list [--recipient <addr>] [--event-type <Bounce|Complaint|Delivery|Reject>] [--limit <n>] [--json]');
    }
    default:
      throw new Error('Usage: eve admin <users|invite|pricing|receipts|balance|usage|ingress-aliases|access-requests|email>');
  }
}

type EmailDeliveryEventCli = {
  id: string;
  recipient: string;
  ses_message_id: string | null;
  rfc_message_id: string | null;
  event_type: string;
  bounce_type: string | null;
  bounce_subtype: string | null;
  diagnostic: string | null;
  received_at: string;
};

type UserWithMemberships = {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  created_at: string;
  memberships: Array<{
    org_id: string;
    org_name: string;
    org_slug: string;
    role: string;
  }>;
  project_memberships: Array<{
    project_id: string;
    project_name: string;
    project_slug: string;
    org_slug: string;
    role: string;
  }>;
};

async function handleUsers(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const users = await requestJson<UserWithMemberships[]>(context, '/system/users');

  if (json) {
    outputJson(users, true);
    return;
  }

  if (users.length === 0) {
    console.log('No users found.');
    return;
  }

  // Build flat rows: one row per user-membership pair (org or project)
  type Row = { email: string; name: string; admin: string; scope: string; target: string; role: string; created: string };
  const rows: Row[] = [];

  for (const user of users) {
    const base = {
      email: user.email,
      name: user.display_name ?? '-',
      admin: user.is_admin ? 'yes' : '',
      created: user.created_at?.split('T')[0] ?? '',
    };

    const hasOrg = user.memberships.length > 0;
    const hasProj = (user.project_memberships ?? []).length > 0;

    if (!hasOrg && !hasProj) {
      rows.push({ ...base, scope: '-', target: '-', role: '-' });
    } else {
      for (const m of user.memberships) {
        rows.push({ ...base, scope: 'org', target: m.org_slug || m.org_name, role: m.role });
      }
      for (const pm of (user.project_memberships ?? [])) {
        rows.push({ ...base, scope: 'project', target: `${pm.org_slug}/${pm.project_slug}`, role: pm.role });
      }
    }
  }

  // Column widths
  const col = (key: keyof Row, header: string) => Math.max(header.length, ...rows.map(r => r[key].length));
  const w = {
    email: col('email', 'Email'),
    name: col('name', 'Name'),
    admin: col('admin', 'Admin'),
    scope: col('scope', 'Scope'),
    target: col('target', 'Target'),
    role: col('role', 'Role'),
    created: col('created', 'Created'),
  };

  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));

  const header = [
    pad('Email', w.email),
    pad('Name', w.name),
    pad('Admin', w.admin),
    pad('Scope', w.scope),
    pad('Target', w.target),
    pad('Role', w.role),
    pad('Created', w.created),
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    console.log([
      pad(row.email, w.email),
      pad(row.name, w.name),
      pad(row.admin, w.admin),
      pad(row.scope, w.scope),
      pad(row.target, w.target),
      pad(row.role, w.role),
      pad(row.created, w.created),
    ].join('  '));
  }

  console.log('');
  console.log(`${users.length} user(s)`);
}

function formatBalanceSummary(data: any): string {
  if (!data.currency) {
    return `Balance: (no balance record) for ${data.org_id}`;
  }
  return [
    `Balance: ${data.balance} ${data.currency}`,
    `  Lifetime in:  ${data.lifetime_in} ${data.currency}`,
    `  Lifetime out: ${data.lifetime_out} ${data.currency}`,
    data.updated_at ? `  Updated:      ${data.updated_at}` : null,
  ].filter(Boolean).join('\n');
}

function parseSinceValue(since: string): string {
  if (since.includes('T') || since.includes('-')) {
    return since;
  }

  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid --since format: "${since}". Use formats like "10m", "2h", "7d", or ISO timestamp.`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const now = new Date();
  switch (unit) {
    case 's':
      now.setSeconds(now.getSeconds() - value);
      break;
    case 'm':
      now.setMinutes(now.getMinutes() - value);
      break;
    case 'h':
      now.setHours(now.getHours() - value);
      break;
    case 'd':
      now.setDate(now.getDate() - value);
      break;
  }

  return now.toISOString();
}

async function fetchGitHubKeys(username: string): Promise<string[]> {
  const response = await fetch(`https://github.com/${username}.keys`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`GitHub user not found: ${username}`);
    }
    throw new Error(`Failed to fetch GitHub keys: HTTP ${response.status}`);
  }

  const text = await response.text();
  return text.trim().split('\n').filter(k => k.length > 0);
}
