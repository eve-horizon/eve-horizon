import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, requestRaw } from '../lib/client';
import { outputJson } from '../lib/output';

interface CustomDomain {
  id: string;
  hostname: string;
  project_id: string;
  environment_id: string | null;
  environment_name: string | null;
  owner_env: { id: string; name: string } | null;
  service_name: string;
  status: string;
  dns_state: 'pending' | 'verified' | 'error' | 'unknown';
  cert_state: 'not_requested' | 'provisioning' | 'active' | 'error' | 'unknown';
  last_verified_at: string | null;
  ingress_name: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DomainListResponse {
  data: CustomDomain[];
}

interface DomainVerifyResponse extends CustomDomain {
  platform_ingress?: {
    ips?: string[];
    hostname?: string;
  };
  dns_result?: {
    verified: boolean;
    resolved_to?: string;
  };
  instructions?: string;
  warnings?: string[];
}

interface DomainTransferResponse {
  hostname: string;
  previous_environment_id: string | null;
  previous_environment_name: string | null;
  new_environment_id: string;
  new_environment_name: string;
  unchanged: boolean;
  next_steps: string;
}

interface DomainUnbindResponse {
  hostname: string;
  previous_environment_id: string | null;
  previous_environment_name: string | null;
  unchanged: boolean;
  next_steps: string;
}

interface DomainRegisterResponse extends CustomDomain {
  unchanged?: boolean;
  next_steps?: string;
}

export async function handleDomain(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'list':
      return handleList(flags, context, json);
    case 'register':
      return handleRegister(positionals, flags, context, json);
    case 'verify':
      return handleVerify(positionals, flags, context, json);
    case 'status':
      return handleStatus(positionals, flags, context, json);
    case 'transfer':
      return handleTransfer(positionals, flags, context, json);
    case 'unbind':
      return handleUnbind(positionals, flags, context, json);
    case 'remove':
      return handleRemove(positionals, flags, context, json);
    default:
      throw new Error(
        'Usage: eve domain <list|register|verify|status|transfer|unbind|remove>\n' +
        '  list [--env <name>] [--project <id>] [--json]              - list custom domains (optionally scoped to an env)\n' +
        '  register <hostname> --project <id> --service <svc> [--env <env>] [--json] - register a custom domain\n' +
        '  verify <hostname> [--project <id>]                         - check DNS and show activation status\n' +
        '  status <hostname> [--project <id>]                         - show domain status and owning env\n' +
        '  transfer <hostname> --to <env> [--project <id>] [--json]   - move ownership between envs in the same project\n' +
        '  unbind <hostname> [--project <id>] [--json]                - clear env binding so the next deploy claims it\n' +
        '  remove <hostname> [--project <id>] [--json]                - remove a custom domain entirely\n'
      );
  }
}

async function handleList(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Project ID required. Use --project <id> or set project context.');
  }
  const envFilter = getStringFlag(flags, ['env']);

  const result = await requestJson<DomainListResponse>(context, `/projects/${projectId}/domains`);

  const data = envFilter
    ? result.data.filter((d) => d.environment_name === envFilter || d.environment_id === envFilter)
    : result.data;

  if (json) {
    outputJson({ data }, json);
    return;
  }

  if (data.length === 0) {
    console.log(envFilter
      ? `No custom domains bound to env "${envFilter}".`
      : 'No custom domains configured.');
    console.log('\nTo add domains, declare them in services.<svc>.x-eve.ingress.domains or environments.<env>.overrides.services.<svc>.x-eve.ingress.domains, then run eve project sync.');
    console.log('For imperative reservations, run eve domain register <hostname> --project <id> --service <svc> [--env <env>].');
    return;
  }

  // Table output with owning env
  const header = 'HOSTNAME                         SERVICE    ENV         STATUS             VERIFIED';
  console.log(header);
  for (const d of data) {
    const hostname = d.hostname.padEnd(33);
    const service = d.service_name.padEnd(11);
    const env = (d.environment_name ?? (d.environment_id ? d.environment_id.slice(0, 10) : 'unbound')).padEnd(12);
    const status = d.status.padEnd(19);
    const verified = d.verified_at ? d.verified_at.split('T')[0] : '-';
    console.log(`${hostname}${service}${env}${status}${verified}`);
  }
}

async function handleRegister(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const hostname = positionals[0];
  if (!hostname) {
    throw new Error('Usage: eve domain register <hostname> --project <id> --service <service> [--env <env>]');
  }

  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Project ID required. Use --project <id> or set project context.');
  }

  const serviceName = getStringFlag(flags, ['service']);
  if (!serviceName) {
    throw new Error('Usage: eve domain register <hostname> --project <id> --service <service> [--env <env>]');
  }

  const envName = getStringFlag(flags, ['env']);
  const result = await requestJson<DomainRegisterResponse>(
    context,
    `/projects/${projectId}/domains`,
    {
      method: 'POST',
      body: {
        hostname,
        service_name: serviceName,
        ...(envName ? { environment: envName } : {}),
      },
    },
  );

  if (json) {
    outputJson(result, json);
    return;
  }

  console.log(`${result.unchanged ? 'Reused' : 'Registered'} custom domain: ${result.hostname}`);
  console.log(`Service:   ${result.service_name}`);
  console.log(`Owner env: ${formatOwnerEnv(result)}`);
  console.log(`Status:    ${result.status}`);
  console.log(`DNS:       ${result.dns_state}`);
  console.log(`Cert:      ${result.cert_state}`);
  if (result.next_steps) {
    console.log(`\n  ${result.next_steps}`);
  }
  if (!envName && !result.environment_id) {
    console.log(`  This row is unbound. The next deploy or sync that declares "${result.hostname}" can claim it.`);
  }
}

async function handleVerify(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const hostname = positionals[0];
  if (!hostname) {
    throw new Error('Usage: eve domain verify <hostname> [--project <id>]');
  }

  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Project ID required. Use --project <id> or set project context.');
  }

  const result = await requestJson<DomainVerifyResponse>(
    context,
    `/projects/${projectId}/domains/${encodeURIComponent(hostname)}/verify`,
    { method: 'POST' },
  );

  if (json) {
    outputJson(result, json);
    return;
  }

  console.log(`Domain: ${result.hostname}`);
  console.log(`Status: ${result.status}`);
  console.log(`Service: ${result.service_name}`);
  console.log(`Owner env: ${result.environment_name ?? (result.environment_id ?? 'unbound')}`);

  if (result.verified_at) {
    console.log(`Verified: ${result.verified_at}`);
  }

  if (result.status === 'active') {
    console.log(`\n  Domain is active and serving traffic`);
    console.log(`  URL: https://${result.hostname}`);
  } else if (result.status === 'cert_provisioning') {
    console.log(`\n  DNS verified — certificate provisioning in progress`);
    console.log(`  Run this command again in a minute to check certificate status.`);
  } else if (result.status === 'dns_verified') {
    console.log(`\n  DNS verified!`);
    if (result.dns_result?.resolved_to) {
      console.log(`  Resolved: ${result.dns_result.resolved_to}`);
    }
    console.log(`\n  Redeploy to activate: eve env deploy`);
  } else if (result.status === 'pending_dns') {
    console.log(`\n  DNS not yet pointing to platform.`);
    if (result.instructions) {
      console.log(`\n  ${result.instructions}`);
    }
    console.log(`\n  After updating DNS, run: eve domain verify ${hostname}`);
  } else {
    console.log(`\n  Status: ${result.status}`);
    if (result.instructions) {
      console.log(`  ${result.instructions}`);
    }
  }

  if (result.warnings?.length) {
    for (const w of result.warnings) {
      console.log(`\n  Warning: ${w}`);
    }
  }
}

async function handleStatus(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const hostname = positionals[0];
  if (!hostname) {
    throw new Error('Usage: eve domain status <hostname> [--project <id>]');
  }

  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Project ID required. Use --project <id> or set project context.');
  }

  const response = await requestRaw(context, `/projects/${projectId}/domains/${encodeURIComponent(hostname)}`, {
    allowError: true,
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Domain "${hostname}" is not registered for this project.\n\n` +
        `If it is declared in the manifest, run: eve project sync --dir .\n` +
        `For imperative registration, run: eve domain register ${hostname} --project ${projectId} --service <svc> --env <env>\n` +
        `After registration, run: eve domain verify ${hostname}`,
      );
    }
    const detail = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);
    throw new Error(`HTTP ${response.status}: while calling GET /projects/${projectId}/domains/${hostname}: ${detail}`);
  }

  const result = response.data as CustomDomain;

  if (json) {
    outputJson(result, json);
    return;
  }

  console.log(`Domain:      ${result.hostname}`);
  console.log(`Status:      ${result.status}`);
  console.log(`Service:     ${result.service_name}`);
  console.log(`Project:     ${result.project_id}`);
  console.log(`Owner env:   ${formatOwnerEnv(result)}`);
  console.log(`DNS:         ${result.dns_state}`);
  console.log(`Cert:        ${result.cert_state}`);
  console.log(`Ingress:     ${result.ingress_name ?? '-'}`);
  console.log(`Last verified: ${result.last_verified_at ?? result.verified_at ?? '-'}`);
  console.log(`Created:     ${result.created_at}`);
}

function formatOwnerEnv(domain: Pick<CustomDomain, 'owner_env' | 'environment_name' | 'environment_id'>): string {
  if (domain.owner_env) {
    return `${domain.owner_env.name} (${domain.owner_env.id})`;
  }
  if (domain.environment_name) {
    return domain.environment_id
      ? `${domain.environment_name} (${domain.environment_id})`
      : domain.environment_name;
  }
  return domain.environment_id ?? 'unbound';
}

async function handleTransfer(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const hostname = positionals[0];
  if (!hostname) {
    throw new Error('Usage: eve domain transfer <hostname> --to <env> [--project <id>]');
  }
  const target = getStringFlag(flags, ['to']);
  if (!target) {
    throw new Error('Usage: eve domain transfer <hostname> --to <env> [--project <id>]');
  }
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Project ID required. Use --project <id> or set project context.');
  }

  const result = await requestJson<DomainTransferResponse>(
    context,
    `/projects/${projectId}/domains/${encodeURIComponent(hostname)}/transfer`,
    { method: 'POST', body: { to_environment: target } },
  );

  if (json) {
    outputJson(result, json);
    return;
  }

  if (result.unchanged) {
    console.log(`${result.hostname} is already bound to "${result.new_environment_name}" — no change.`);
    return;
  }

  const from = result.previous_environment_name ?? result.previous_environment_id ?? 'unbound';
  console.log(`Transferred ${result.hostname} from "${from}" to "${result.new_environment_name}"`);
  console.log(`\n  ${result.next_steps}`);
}

async function handleUnbind(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const hostname = positionals[0];
  if (!hostname) {
    throw new Error('Usage: eve domain unbind <hostname> [--project <id>]');
  }
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Project ID required. Use --project <id> or set project context.');
  }

  const result = await requestJson<DomainUnbindResponse>(
    context,
    `/projects/${projectId}/domains/${encodeURIComponent(hostname)}/unbind`,
    { method: 'POST' },
  );

  if (json) {
    outputJson(result, json);
    return;
  }

  if (result.unchanged) {
    console.log(`${result.hostname} was already unbound — no change.`);
    return;
  }

  const from = result.previous_environment_name ?? result.previous_environment_id ?? '<unknown>';
  console.log(`Unbound ${result.hostname} from "${from}"`);
  console.log(`\n  ${result.next_steps}`);
}

async function handleRemove(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const hostname = positionals[0];
  if (!hostname) {
    throw new Error('Usage: eve domain remove <hostname> [--project <id>]');
  }

  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Project ID required. Use --project <id> or set project context.');
  }

  const result = await requestJson<{ hostname: string; removed: boolean }>(
    context,
    `/projects/${projectId}/domains/${encodeURIComponent(hostname)}`,
    { method: 'DELETE' },
  );

  if (json) {
    outputJson(result, json);
    return;
  }

  console.log(`Removed custom domain: ${result.hostname}`);
  console.log('  Note: K8s Ingress will be garbage-collected on next deploy.');
}
