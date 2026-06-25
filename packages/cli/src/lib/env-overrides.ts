import type { EnvOverrides } from '@eve/shared';
import { EnvOverridesSchema } from '@eve/shared';
import type { FlagValue } from './args';

export function collectEnvOverrideFlags(flags: Record<string, FlagValue>): string[] {
  return [flags['env-override'], flags.env_override].flatMap((value) => {
    if (Array.isArray(value)) return value as string[];
    return typeof value === 'string' ? [value] : [];
  });
}

export function parseEnvOverrideFlags(flags: Record<string, FlagValue>): EnvOverrides | undefined {
  const entries = collectEnvOverrideFlags(flags);
  if (entries.length === 0) return undefined;
  return parseEnvOverrideEntries(entries);
}

export function parseEnvOverrideEntries(entries: string[]): EnvOverrides {
  const envOverrides: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq < 1) {
      throw new Error(`--env-override expects KEY=VALUE (got "${entry}")`);
    }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`--env-override key ${key} must be UPPER_SNAKE_CASE`);
    }
    envOverrides[key] = value;
  }
  const parsed = parseEnvOverridesObject(envOverrides, '--env-override');
  if (!parsed) {
    throw new Error('Invalid --env-override: expected KEY=VALUE entries');
  }
  return parsed;
}

export function parseEnvOverridesObject(value: unknown, label = 'env_overrides'): EnvOverrides | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = EnvOverridesSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid ${label}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function mergeEnvOverrides(
  workflowEnv: EnvOverrides | undefined,
  stepEnv: EnvOverrides | undefined,
  invocationEnv: EnvOverrides | undefined,
): EnvOverrides | undefined {
  const merged = {
    ...(workflowEnv ?? {}),
    ...(stepEnv ?? {}),
    ...(invocationEnv ?? {}),
  };
  if (Object.keys(merged).length === 0) return undefined;
  return parseEnvOverridesObject(merged, 'merged env_overrides');
}
