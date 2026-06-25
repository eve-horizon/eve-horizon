import { execSync } from 'node:child_process';
import type { FlagValue } from '../lib/args';
import { getStringFlag, getBooleanFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

export async function handleGithub(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;

  if (!projectId) {
    throw new Error('Missing --project flag or profile default project.');
  }

  switch (subcommand) {
    case 'setup':
      await setupGithub(projectId, flags, json, context);
      return;
    case 'status':
      await statusGithub(projectId, json, context);
      return;
    case 'test':
      await testGithub(projectId, json, context);
      return;
    default:
      throw new Error('Usage: eve github <setup|status|test> [--project <id>]');
  }
}

async function setupGithub(
  projectId: string,
  flags: Record<string, FlagValue>,
  json: boolean,
  context: ResolvedContext,
): Promise<void> {
  const regenerate = getBooleanFlag(flags, ['regenerate']) ?? false;

  const result = await requestJson<{
    webhook_url: string;
    secret: string;
    project_id: string;
    repo_url: string;
    events: string[];
  }>(context, `/projects/${projectId}/github/setup`, {
    method: 'POST',
    body: { regenerate },
  });

  if (json) {
    outputJson(result, true);
    return;
  }

  // Try to auto-create webhook via gh CLI
  const ownerRepo = extractOwnerRepo(result.repo_url);
  if (!ownerRepo) {
    printManualInstructions(result);
    return;
  }

  if (tryGhWebhook(ownerRepo, result.webhook_url, result.secret, result.events)) {
    console.log(`Webhook created on ${ownerRepo}!`);
    console.log('');
    console.log(`  Events: ${result.events.join(', ')}`);
    console.log(`  URL:    ${result.webhook_url}`);
    console.log('');
    console.log('GitHub will now send push and pull_request events to Eve.');
    console.log('Run "eve github test" to verify the pipeline trigger fires.');
  } else {
    printManualInstructions(result);
  }
}

async function statusGithub(
  projectId: string,
  json: boolean,
  context: ResolvedContext,
): Promise<void> {
  const result = await requestJson<{
    configured: boolean;
    webhook_url: string;
    project_id: string;
  }>(context, `/projects/${projectId}/github/status`);

  if (json) {
    outputJson(result, true);
    return;
  }

  if (result.configured) {
    console.log('GitHub webhook: configured');
  } else {
    console.log('GitHub webhook: not configured');
    console.log('Run "eve github setup" to configure.');
  }
  console.log(`  Webhook URL: ${result.webhook_url}`);
}

async function testGithub(
  projectId: string,
  json: boolean,
  context: ResolvedContext,
): Promise<void> {
  const result = await requestJson<{
    ok: boolean;
    event_id: string;
  }>(context, `/projects/${projectId}/github/test`, {
    method: 'POST',
  });

  if (json) {
    outputJson(result, true);
    return;
  }

  console.log(`Test event created: ${result.event_id}`);
  console.log('');
  console.log('If you have a pipeline with a github.push trigger, it should fire now.');
  console.log('Check with: eve event list --project ' + projectId);
}

/**
 * Extract owner/repo from a GitHub URL.
 * Handles https://github.com/org/repo(.git) and git@github.com:org/repo(.git)
 */
function extractOwnerRepo(repoUrl: string): string | null {
  // HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
  const httpsMatch = repoUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  // SSH: git@github.com:owner/repo.git
  const sshMatch = repoUrl.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  return null;
}

/**
 * Try to create a GitHub webhook using the gh CLI.
 * Returns true on success, false if gh is unavailable or fails.
 */
function tryGhWebhook(
  ownerRepo: string,
  webhookUrl: string,
  secret: string,
  events: string[],
): boolean {
  // Check if gh CLI is available and authenticated
  try {
    execSync('gh auth status', { stdio: 'pipe', timeout: 10000 });
  } catch {
    return false;
  }

  // Check for existing Eve webhook to avoid duplicates
  try {
    const existing = execSync(
      `gh api repos/${ownerRepo}/hooks --jq '[.[] | select(.config.url == "${webhookUrl}")] | length'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 },
    ).trim();
    if (existing !== '0') {
      // Update existing webhook
      const hookId = execSync(
        `gh api repos/${ownerRepo}/hooks --jq '[.[] | select(.config.url == "${webhookUrl}")][0].id'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 },
      ).trim();
      if (hookId) {
        execSync(
          `gh api repos/${ownerRepo}/hooks/${hookId} -X PATCH ` +
            `-f config[url]="${webhookUrl}" ` +
            `-f config[content_type]=json ` +
            `-f config[secret]="${secret}" ` +
            `-f config[insecure_ssl]=0 ` +
            events.map((e) => `-f events[]=${e}`).join(' ') +
            ` -f active=true`,
          { stdio: 'pipe', timeout: 15000 },
        );
        return true;
      }
    }
  } catch {
    // Can't check existing hooks — try creating
  }

  // Create new webhook
  try {
    execSync(
      `gh api repos/${ownerRepo}/hooks -X POST ` +
        `-f name=web ` +
        `-f config[url]="${webhookUrl}" ` +
        `-f config[content_type]=json ` +
        `-f config[secret]="${secret}" ` +
        `-f config[insecure_ssl]=0 ` +
        events.map((e) => `-f events[]=${e}`).join(' ') +
        ` -f active=true`,
      { stdio: 'pipe', timeout: 15000 },
    );
    return true;
  } catch {
    return false;
  }
}

function printManualInstructions(result: {
  webhook_url: string;
  secret: string;
  repo_url: string;
  events: string[];
}): void {
  const ownerRepo = extractOwnerRepo(result.repo_url);

  console.log('GitHub webhook setup');
  console.log('');
  console.log(`  Webhook URL:    ${result.webhook_url}`);
  console.log(`  Secret:         ${result.secret}`);
  console.log(`  Content type:   application/json`);
  console.log(`  Events:         ${result.events.join(', ')}`);
  console.log('');

  if (ownerRepo) {
    console.log('Auto-setup with gh CLI (install from https://cli.github.com):');
    console.log('');
    console.log(`  gh api repos/${ownerRepo}/hooks -X POST \\`);
    console.log(`    -f name=web \\`);
    console.log(`    -f config[url]="${result.webhook_url}" \\`);
    console.log(`    -f config[content_type]=json \\`);
    console.log(`    -f config[secret]="${result.secret}" \\`);
    result.events.forEach((e) => {
      console.log(`    -f events[]=${e} \\`);
    });
    console.log(`    -f active=true`);
    console.log('');
  }

  console.log('Or configure manually:');
  if (ownerRepo) {
    console.log(`  1. Go to https://github.com/${ownerRepo}/settings/hooks/new`);
  } else {
    console.log('  1. Go to your repo Settings > Webhooks > Add webhook');
  }
  console.log('  2. Payload URL: ' + result.webhook_url);
  console.log('  3. Content type: application/json');
  console.log('  4. Secret: ' + result.secret);
  console.log('  5. Events: "push" and "pull_request"');
  console.log('  6. Click "Add webhook"');
}
