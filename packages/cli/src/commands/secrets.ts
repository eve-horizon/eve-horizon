import { readFileSync } from 'node:fs';
import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';
import { buildQuery } from '../lib/format';

type Scope = { scopeType: 'project' | 'org' | 'user' | 'system'; scopeId: string };

export async function handleSecrets(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'set': {
      const scope = resolveScope(flags, context);
      const key = positionals[0] ?? (getStringFlag(flags, ['key']));
      const value = positionals[1] ?? (getStringFlag(flags, ['value']));
      const type = getStringFlag(flags, ['type']);
      if (!key || !value) {
        throw new Error('Usage: eve secrets set <key> <value> [--project <id>|--org <id>|--user <id>|--system] [--type <type>]');
      }
      const body: Record<string, unknown> = { key, value };
      if (type) body.type = type;
      const response = await requestJson(context, `${scopeBasePath(scope)}`, {
        method: 'POST',
        body,
      });
      outputJson(response, json, `✓ Secret set: ${key}`);
      return;
    }
    case 'list': {
      const scope = resolveScope(flags, context);
      const query = buildQuery({
        limit: getStringFlag(flags, ['limit']),
        offset: getStringFlag(flags, ['offset']),
      });
      const response = await requestJson(context, `${scopeBasePath(scope)}${query}`);
      outputJson(response, json);
      return;
    }
    case 'show': {
      const scope = resolveScope(flags, context);
      const key = positionals[0] ?? (getStringFlag(flags, ['key']));
      if (!key) {
        throw new Error('Usage: eve secrets show <key> [--project <id>|--org <id>|--user <id>|--system]');
      }
      const response = await requestJson(context, `${scopeBasePath(scope)}/${encodeURIComponent(key)}`);
      outputJson(response, json);
      return;
    }
    case 'delete': {
      const scope = resolveScope(flags, context);
      const key = positionals[0] ?? (getStringFlag(flags, ['key']));
      if (!key) {
        throw new Error('Usage: eve secrets delete <key> [--project <id>|--org <id>|--user <id>|--system]');
      }
      await requestJson(context, `${scopeBasePath(scope)}/${encodeURIComponent(key)}`, { method: 'DELETE' });
      outputJson({ ok: true }, json, `✓ Secret deleted: ${key}`);
      return;
    }
    case 'import': {
      const scope = resolveScope(flags, context);
      const filePath = getStringFlag(flags, ['file']) ?? '.env';
      const fileContents = readFileSync(filePath, 'utf8');
      const entries = parseEnvFile(fileContents);
      if (entries.length === 0) {
        throw new Error(`No entries found in ${filePath}`);
      }
      for (const [key, value] of entries) {
        await requestJson(context, `${scopeBasePath(scope)}`, {
          method: 'POST',
          body: { key, value },
        });
      }
      outputJson({ imported: entries.length }, json, `✓ Imported ${entries.length} secrets`);
      return;
    }
    case 'validate': {
      const projectId = resolveProjectScope(flags, context);
      const keys = parseKeys(positionals, flags);
      const body: Record<string, unknown> = {};
      if (keys.length > 0) body.keys = keys;
      const response = await requestJson<{ missing: Array<{ key: string; hints: string[] }> }>(
        context,
        `/projects/${projectId}/secrets/validate`,
        {
          method: 'POST',
          body,
        },
      );
      if (json) {
        outputJson(response, json);
      } else if (response.missing.length === 0) {
        console.log('✓ All required secrets are present');
      } else {
        console.log('Missing secrets:');
        response.missing.forEach((item) => {
          console.log(`- ${item.key}`);
          item.hints.forEach((hint) => console.log(`  ${hint}`));
        });
      }
      return;
    }
    case 'ensure': {
      const projectId = resolveProjectScope(flags, context);
      const keys = parseKeys(positionals, flags);
      if (keys.length === 0) {
        throw new Error('Usage: eve secrets ensure --project <id> --keys <key1,key2>');
      }
      const response = await requestJson<{ created: string[]; existing: string[] }>(
        context,
        `/projects/${projectId}/secrets/ensure`,
        {
          method: 'POST',
          body: { keys },
        },
      );
      outputJson(response, json, `✓ Secrets ensured (${response.created.length} created)`);
      return;
    }
    case 'export': {
      const projectId = resolveProjectScope(flags, context);
      const keys = parseKeys(positionals, flags);
      if (keys.length === 0) {
        throw new Error('Usage: eve secrets export --project <id> --keys <key1,key2>');
      }
      const response = await requestJson<{ data: Array<{ key: string; value: string }> }>(
        context,
        `/projects/${projectId}/secrets/export`,
        {
          method: 'POST',
          body: { keys },
        },
      );
      if (json) {
        outputJson(response, json);
      } else {
        console.log('Exported secrets (handle carefully):');
        response.data.forEach((item) => {
          console.log(`${item.key}=${item.value}`);
        });
      }
      return;
    }
    default:
      throw new Error('Usage: eve secrets <set|list|show|delete|import|validate|ensure|export>');
  }
}

function resolveScope(flags: Record<string, FlagValue>, context: ResolvedContext): Scope {
  // Explicit flags take priority in the order: system > project > org > user
  const explicitSystem = Boolean(flags.system);
  const explicitProject = getStringFlag(flags, ['project']);
  const explicitOrg = getStringFlag(flags, ['org']);
  const explicitUser = getStringFlag(flags, ['user']);

  // Check for mutual exclusivity
  const explicitFlags = [explicitSystem, explicitProject, explicitOrg, explicitUser].filter(Boolean);
  if (explicitFlags.length > 1) {
    throw new Error('Cannot specify multiple scope flags. Use only one of: --system, --project, --org, or --user');
  }

  // If explicit flags are provided, use them in priority order
  if (explicitSystem) return { scopeType: 'system', scopeId: 'system' };
  if (explicitProject) return { scopeType: 'project', scopeId: explicitProject };
  if (explicitOrg) return { scopeType: 'org', scopeId: explicitOrg };
  if (explicitUser) return { scopeType: 'user', scopeId: explicitUser };

  // Fall back to profile defaults
  if (context.projectId) return { scopeType: 'project', scopeId: context.projectId };
  if (context.orgId) return { scopeType: 'org', scopeId: context.orgId };

  throw new Error('Missing scope. Provide --system, --project, --org, or --user (or set profile defaults).');
}

function scopeBasePath(scope: Scope): string {
  switch (scope.scopeType) {
    case 'system':
      return `/system/secrets`;
    case 'project':
      return `/projects/${scope.scopeId}/secrets`;
    case 'org':
      return `/orgs/${scope.scopeId}/secrets`;
    case 'user':
      return `/users/${scope.scopeId}/secrets`;
  }
}

function resolveProjectScope(flags: Record<string, FlagValue>, context: ResolvedContext): string {
  const scope = resolveScope(flags, context);
  if (scope.scopeType !== 'project') {
    throw new Error('This command requires --project (or a project default profile).');
  }
  return scope.scopeId;
}

function parseEnvFile(contents: string): Array<[string, string]> {
  const lines = contents.split(/\r?\n/);
  const entries: Array<[string, string]> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!key) continue;
    entries.push([key, value]);
  }
  return entries;
}

function parseKeys(positionals: string[], flags: Record<string, FlagValue>): string[] {
  const positionalKeys = positionals.filter((value) => typeof value === 'string' && value.length > 0);
  const flagKeys = typeof flags.keys === 'string'
    ? flags.keys.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  return Array.from(new Set([...positionalKeys, ...flagKeys]));
}
