import { existsSync, readFileSync } from 'fs';
import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

interface AppLinkGrant {
  id: string;
  producer_project_id: string;
  export_kind: 'api' | 'events';
  export_name: string;
  consumer_project_id: string;
  api_scopes: string[];
  event_types: string[];
  envs: string[];
  service_name: string | null;
  cli_name: string | null;
  revoked_at: string | null;
}

interface AppLinkSubscription {
  id: string;
  consumer_project_id: string;
  local_alias: string;
  api_grant_id: string | null;
  event_grant_id: string | null;
  requested_scopes: string[];
  event_types: string[];
  environment_strategy: 'same' | 'fixed';
  producer_env_name: string | null;
  inject_into_services: string[];
  inject_into_jobs: boolean;
  last_token_minted_at: string | null;
}

interface AppLinksListResponse {
  project_id: string;
  exports: AppLinkGrant[];
  consumes: AppLinkSubscription[];
  grants_to_project: AppLinkGrant[];
}

interface AppLinkDiagnostic {
  level: 'ok' | 'warning' | 'error';
  message: string;
}

interface AppLinksExplainResponse {
  status: 'OK' | 'MISSING' | 'REVOKED' | 'INVALID';
  diagnostics: AppLinkDiagnostic[];
  grant: AppLinkGrant | null;
  subscription: AppLinkSubscription | null;
}

interface AppLinksPlanResponse {
  valid: boolean;
  diagnostics: AppLinkDiagnostic[];
}

export async function handleAppLinks(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'list':
      return handleList(positionals, flags, context, json);
    case 'explain':
      return handleExplain(flags, context, json);
    case 'plan':
      return handlePlan(flags, context, json);
    default:
      throw new Error(
        'Usage: eve app-links <list|plan|explain>\n' +
        '  list [project]                       - list app link grants and subscriptions\n' +
        '  plan --project <id> [--file <path>]  - dry-run consumer links in a manifest\n' +
        '  explain --alias <name>               - explain a subscription by local alias',
      );
  }
}

async function handleList(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Usage: eve app-links list [project] [--project <id>]');
  }

  const response = await requestJson<AppLinksListResponse>(context, `/projects/${projectId}/app-links`);
  if (json) {
    outputJson(response, json);
    return;
  }
  formatList(response);
}

async function handleExplain(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const consumer = getStringFlag(flags, ['consumer', 'project']) ?? context.projectId;
  if (!consumer) {
    throw new Error('Usage: eve app-links explain --consumer <project> (--alias <name> | --producer <project> --api <name>)');
  }

  const body: Record<string, unknown> = {
    consumer_project: getStringFlag(flags, ['consumer']),
    producer_project: getStringFlag(flags, ['producer']),
    api: getStringFlag(flags, ['api']),
    events: getStringFlag(flags, ['events', 'feed']),
    alias: getStringFlag(flags, ['alias']),
    env: getStringFlag(flags, ['env']),
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }

  const response = await requestJson<AppLinksExplainResponse>(
    context,
    `/projects/${consumer}/app-links/explain`,
    { method: 'POST', body },
  );
  if (json) {
    outputJson(response, json);
    return;
  }
  formatExplain(response);
}

async function handlePlan(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Usage: eve app-links plan --project <id> [--file .eve/manifest.yaml] [--env <env>]');
  }

  const file = getStringFlag(flags, ['file']);
  let manifestYaml: string | undefined;
  if (file) {
    manifestYaml = readFileSync(file, 'utf-8');
  } else if (existsSync('.eve/manifest.yaml')) {
    manifestYaml = readFileSync('.eve/manifest.yaml', 'utf-8');
  }

  const response = await requestJson<AppLinksPlanResponse>(
    context,
    `/projects/${projectId}/app-links/plan`,
    {
      method: 'POST',
      body: {
        ...(manifestYaml ? { manifest_yaml: manifestYaml } : {}),
        ...(getStringFlag(flags, ['env']) ? { env: getStringFlag(flags, ['env']) } : {}),
      },
    },
  );
  if (json) {
    outputJson(response, json);
    return;
  }
  formatPlan(response);
}

function formatList(response: AppLinksListResponse): void {
  console.log(`Project: ${response.project_id}`);
  console.log('');
  console.log('Exports:');
  if (response.exports.length === 0) {
    console.log('  (none)');
  } else {
    for (const grant of response.exports) {
      const revoked = grant.revoked_at ? ` revoked=${grant.revoked_at}` : '';
      const scopes = grant.export_kind === 'api' ? grant.api_scopes.join(',') : grant.event_types.join(',');
      console.log(`  ${grant.export_kind}/${grant.export_name} -> ${grant.consumer_project_id} [${scopes || 'all'}]${revoked}`);
    }
  }

  console.log('');
  console.log('Consumes:');
  if (response.consumes.length === 0) {
    console.log('  (none)');
  } else {
    for (const sub of response.consumes) {
      const env = sub.environment_strategy === 'same' ? 'same' : sub.producer_env_name;
      const inject = [
        sub.inject_into_services.length > 0 ? `services=${sub.inject_into_services.join(',')}` : null,
        sub.inject_into_jobs ? 'jobs=true' : null,
      ].filter(Boolean).join(' ');
      console.log(`  ${sub.local_alias} env=${env}${inject ? ` ${inject}` : ''}`);
    }
  }

  if (response.grants_to_project.length > 0) {
    console.log('');
    console.log('Grants to this project:');
    for (const grant of response.grants_to_project) {
      console.log(`  ${grant.producer_project_id}/${grant.export_kind}/${grant.export_name}`);
    }
  }
}

function formatExplain(response: AppLinksExplainResponse): void {
  console.log(`Status: ${response.status}`);
  for (const diagnostic of response.diagnostics) {
    const marker = diagnostic.level === 'ok' ? '[ok]' : diagnostic.level === 'warning' ? '[warn]' : '[error]';
    console.log(`  ${marker} ${diagnostic.message}`);
  }
  if (response.grant) {
    console.log(`Grant: ${response.grant.producer_project_id}/${response.grant.export_kind}/${response.grant.export_name}`);
  }
  if (response.subscription) {
    console.log(`Subscription: ${response.subscription.local_alias}`);
  }
}

function formatPlan(response: AppLinksPlanResponse): void {
  console.log(response.valid ? 'App links plan: valid' : 'App links plan: invalid');
  for (const diagnostic of response.diagnostics) {
    const marker = diagnostic.level === 'ok' ? '[ok]' : diagnostic.level === 'warning' ? '[warn]' : '[error]';
    console.log(`  ${marker} ${diagnostic.message}`);
  }
}
