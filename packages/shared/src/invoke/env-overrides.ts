import type { SecretResolveItem } from '../schemas/secret.js';
import { isReservedEnvKey } from '../schemas/job.js';
import { interpolateEnvOverrides } from './workspace-secrets.js';

export interface ApplyEnvOverridesOptions {
  envOverrides: Record<string, string> | null | undefined;
  resolvedSecrets: SecretResolveItem[];
  baseEnv: NodeJS.ProcessEnv;
  onMissingSecrets?: (missing: string[]) => Promise<void>;
}

export interface ApplyEnvOverridesResult {
  env: NodeJS.ProcessEnv;
  appliedKeys: string[];
  strippedKeys: string[];
}

export class MissingSecretOverrideError extends Error {
  readonly code = 'missing_secret_override';

  constructor(readonly missing: string[]) {
    super(`missing_secret_override: env_overrides reference unresolved secret(s): ${missing.join(', ')}`);
    this.name = 'MissingSecretOverrideError';
  }
}

export async function applyEnvOverrides(
  opts: ApplyEnvOverridesOptions,
): Promise<ApplyEnvOverridesResult> {
  const env: NodeJS.ProcessEnv = { ...opts.baseEnv };
  const envOverrides = opts.envOverrides;
  if (!envOverrides || Object.keys(envOverrides).length === 0) {
    return { env, appliedKeys: [], strippedKeys: [] };
  }

  const { resolved, missing } = interpolateEnvOverrides(envOverrides, opts.resolvedSecrets);
  if (missing.length > 0) {
    await opts.onMissingSecrets?.(missing);
    throw new MissingSecretOverrideError(missing);
  }

  const appliedKeys: string[] = [];
  const strippedKeys: string[] = [];
  for (const [key, value] of Object.entries(resolved)) {
    if (isReservedEnvKey(key)) {
      strippedKeys.push(key);
      continue;
    }
    env[key] = value;
    appliedKeys.push(key);
  }

  return { env, appliedKeys, strippedKeys };
}
