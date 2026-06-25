#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from './lib/args';
import { loadCredentials } from './lib/config';
import { resolveContext } from './lib/context';
import { showMainHelp, showCommandHelp, showSubcommandHelp } from './lib/help';
import { handleOrg } from './commands/org';
import { handleProject } from './commands/project';
import { handleJob } from './commands/job';
import { handleProfile } from './commands/profile';
import { handleAuth } from './commands/auth';
import { handleHarness } from './commands/harness';
import { handleProviders } from './commands/providers';
import { handleSecrets } from './commands/secrets';
import { handleSystem } from './commands/system';
import { handleEnv } from './commands/env';
import { handlePipeline } from './commands/pipeline';
import { handleWorkflow } from './commands/workflow';
import { handleApi } from './commands/api';
import { handleAppLinks } from './commands/app-links';
import { handleDb } from './commands/db';
import { handleEvent } from './commands/event';
import { handleSkills } from './commands/skills';
import { handleAdmin } from './commands/admin';
import { handleAgents } from './commands/agents';
import { handleInit } from './commands/init';
import { handleRelease } from './commands/release';
import { handleManifest } from './commands/manifest';
import { handlePacks } from './commands/packs';
import { handleBuild } from './commands/build';
import { handleIntegrations } from './commands/integrations';
import { handleChat } from './commands/chat';
import { handleThread } from './commands/thread';
import { handleSupervise } from './commands/supervise';
import { handleMigrate } from './commands/migrate';

import { handleAccess } from './commands/access';
import { handleDomain } from './commands/domain';
import { handleDocs } from './commands/docs';
import { handleMemory } from './commands/memory';
import { handleKv } from './commands/kv';
import { handleSearch } from './commands/search';
import { handleResources } from './commands/resources';
import { handleWebhooks } from './commands/webhooks';
import { handleAnalytics } from './commands/analytics';

import { handleIngest } from './commands/ingest';
import { handleFs } from './commands/fs';
import { handleLocal } from './commands/local';
import { handleGithub } from './commands/github';
import { handleIdentity } from './commands/identity';
import { handleUser } from './commands/user';
import { handleEndpoint } from './commands/endpoint';
import { handleCloudFs } from './commands/cloud-fs';
import { handleTraces } from './commands/traces';
import { handleNotifications } from './commands/notifications';
import { handleTcpIngress } from './commands/tcp-ingress';

function getCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

type PlatformVersionInfo = { version: string; gitSha: string; buildTime: string };

async function showVersion(json: boolean, apiUrl?: string): Promise<void> {
  const cliVersion = getCliVersion();

  // Try to fetch platform version
  let platformInfo: PlatformVersionInfo | null = null;
  if (apiUrl) {
    try {
      const res = await fetch(`${apiUrl}/health/version`);
      if (res.ok) {
        platformInfo = await res.json() as PlatformVersionInfo;
      }
    } catch {
      // API not reachable — just show CLI version
    }
  }

  if (json) {
    const result: Record<string, unknown> = { cli: cliVersion };
    if (platformInfo) {
      result.platform = platformInfo;
    }
    if (apiUrl) {
      result.apiUrl = apiUrl;
    }
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`eve v${cliVersion}`);
    if (platformInfo) {
      const sha = platformInfo.gitSha !== 'unknown' ? ` (${platformInfo.gitSha.slice(0, 7)})` : '';
      console.log(`platform v${platformInfo.version}${sha}`);
    }
  }
}

async function main(): Promise<void> {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const command = positionals[0];
  const subcommand = positionals[1];
  const rest = positionals.slice(2);

  // Version: eve --version, eve -v, eve version
  if (flags.version || command === '-v' || command === 'version') {
    const json = Boolean(flags.json);
    let apiUrl: string | undefined;
    try {
      const credentials = loadCredentials();
      const context = resolveContext(flags, credentials);
      apiUrl = context.apiUrl;
    } catch {
      // Can't resolve context — still show CLI version
    }
    await showVersion(json, apiUrl);
    return;
  }

  // Top-level help: no command or explicit --help without command
  if (!command || command === '-h' || command === '--help') {
    showMainHelp();
    return;
  }

  // Command-level help: "eve profile --help" or "eve profile" with no subcommand
  // flags.help means --help appeared somewhere; without subcommand = command help
  if (flags.help && !subcommand) {
    showCommandHelp(command);
    return;
  }

  // Subcommand-level help: "eve profile set --help"
  if (flags.help && subcommand) {
    showSubcommandHelp(command, subcommand);
    return;
  }

  const credentials = loadCredentials();
  const context = resolveContext(flags, credentials);

  switch (command) {
    case 'org':
      await handleOrg(subcommand, rest, flags, context);
      return;
    case 'project':
      await handleProject(subcommand, rest, flags, context);
      return;
    case 'job':
      await handleJob(subcommand, rest, flags, context);
      return;
    case 'profile':
      handleProfile(subcommand, rest, flags);
      return;
    case 'auth':
      await handleAuth(subcommand, flags, context, credentials);
      return;
    case 'harness':
      await handleHarness(subcommand, rest, flags, context);
      return;
    case 'providers':
      await handleProviders(subcommand, rest, flags, context);
      return;
    case 'secrets':
      await handleSecrets(subcommand, rest, flags, context);
      return;
    case 'system':
      await handleSystem(subcommand, rest, flags, context);
      return;
    case 'env':
      await handleEnv(subcommand, rest, flags, context);
      return;
    case 'pipeline':
      await handlePipeline(subcommand, rest, flags, context);
      return;
    case 'workflow':
      await handleWorkflow(subcommand, rest, flags, context);
      return;
    case 'api':
      await handleApi(subcommand, rest, flags, context);
      return;
    case 'app-links':
      await handleAppLinks(subcommand, rest, flags, context);
      return;
    case 'db':
      await handleDb(subcommand, rest, flags, context);
      return;
    case 'event':
      await handleEvent(subcommand, rest, flags, context);
      return;
    case 'skills':
      await handleSkills(subcommand, rest, flags);
      return;
    case 'agents':
      await handleAgents(subcommand, rest, flags, context);
      return;
    case 'admin':
      await handleAdmin(subcommand, rest, flags, context);
      return;
    case 'init':
      // init doesn't use subcommands - first positional is directory name
      await handleInit(subcommand ? [subcommand, ...rest] : rest, flags);
      return;
    case 'release':
      await handleRelease(subcommand, rest, flags, context);
      return;
    case 'manifest':
      await handleManifest(subcommand, rest, flags, context);
      return;
    case 'packs':
      await handlePacks(subcommand, rest, flags, context);
      return;
    case 'build':
      await handleBuild(subcommand, rest, flags, context);
      return;
    case 'integrations':
      await handleIntegrations(subcommand, rest, flags, context);
      return;
    case 'chat':
      await handleChat(subcommand, rest, flags, context);
      return;
    case 'thread':
      await handleThread(subcommand, rest, flags, context);
      return;
    case 'supervise':
      await handleSupervise(subcommand ? [subcommand, ...rest] : rest, flags, context);
      return;
    case 'migrate':
      await handleMigrate(subcommand, rest, flags);
      return;

    case 'access':
      await handleAccess(subcommand, rest, flags, context);
      return;
    case 'domain':
      await handleDomain(subcommand, rest, flags, context);
      return;
    case 'docs':
      await handleDocs(subcommand, rest, flags, context);
      return;
    case 'memory':
      await handleMemory(subcommand, rest, flags, context);
      return;
    case 'kv':
      await handleKv(subcommand, rest, flags, context);
      return;
    case 'search': {
      const searchPositionals = subcommand ? [subcommand, ...rest] : rest;
      await handleSearch(searchPositionals, flags, context);
      return;
    }
    case 'resources':
      await handleResources(subcommand, rest, flags, context);
      return;
    case 'webhooks':
      await handleWebhooks(subcommand, rest, flags, context);
      return;
    case 'analytics':
      await handleAnalytics(subcommand, rest, flags, context);
      return;

    case 'ingest':
      await handleIngest(subcommand, rest, flags, context);
      return;
    case 'fs':
      await handleFs(subcommand, rest, flags, context);
      return;
    case 'local':
      await handleLocal(subcommand, rest, flags, context);
      return;
    case 'github':
      await handleGithub(subcommand, rest, flags, context);
      return;
    case 'identity':
      await handleIdentity(subcommand, rest, flags, context);
      return;
    case 'user':
      await handleUser(subcommand, rest, flags, context);
      return;
    case 'endpoint':
      await handleEndpoint(subcommand, rest, flags, context);
      return;
    case 'tcp-ingress':
      await handleTcpIngress(subcommand, rest, flags, context);
      return;
    case 'cloud-fs':
      await handleCloudFs(subcommand, rest, flags, context);
      return;
    case 'traces':
      await handleTraces(subcommand, rest, flags, context);
      return;
    case 'notifications':
      await handleNotifications(subcommand, rest, flags, context);
      return;
    default:
      showMainHelp();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
