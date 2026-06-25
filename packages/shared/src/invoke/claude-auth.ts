import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { SecretResolveItem } from '../schemas/secret.js';

export type ClaudeTokenClass = 'setup-token' | 'oauth' | 'api-key';
export type SecretScope = 'project' | 'org' | 'user' | 'system' | 'unknown';

export type ClaudeAuthDecision = {
  source: 'eve-secret';
  secretKey: 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN';
  scopeType: SecretScope;
  scopeId?: string;
  tokenClass: ClaudeTokenClass;
  tokenValue: string;
  env: Record<string, string | undefined>;
  scrub: string[];
  warnings?: string[];
};

export type RedactedClaudeAuthDecision = {
  selected: boolean;
  source: 'eve-secret' | 'none';
  secret_key: string | null;
  scope_type: SecretScope | null;
  scope_id: string | null;
  token_class: ClaudeTokenClass | null;
  token_length?: number;
  token_fingerprint?: string;
  env_keys?: string[];
  scrub?: string[];
  warnings?: string[];
};

export type ClaudeRuntimeConfig = {
  configDir: string;
  sourceConfigDir: string;
  credentialsPath: string;
  copiedConfig: boolean;
};

export type ClaudeCredentialMaterialization = {
  written: boolean;
  path: string;
  warning?: string;
};

export const CLAUDE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_OAUTH_EXPIRES_AT',
] as const;

const CLAUDE_CREDENTIAL_FILENAMES = new Set(['.credentials.json', 'credentials.json']);
const MILLIS_365_DAYS = 365 * 24 * 60 * 60 * 1000;

const SCOPE_RANK: Record<SecretScope, number> = {
  project: 4,
  org: 3,
  user: 2,
  system: 1,
  unknown: 0,
};

const TOKEN_RANK: Record<ClaudeTokenClass, number> = {
  'api-key': 3,
  'setup-token': 2,
  oauth: 1,
};

export function classifyClaudeToken(
  token: string,
  secretKey?: string,
): ClaudeTokenClass {
  if (secretKey === 'ANTHROPIC_API_KEY') return 'api-key';
  if (token.startsWith('sk-ant-api')) return 'api-key';
  if (token.startsWith('sk-ant-oat01-')) return 'setup-token';
  return 'oauth';
}

export function selectClaudeAuth(secrets: SecretResolveItem[]): ClaudeAuthDecision | null {
  type Candidate = {
    index: number;
    secret: SecretResolveItem;
    tokenClass: ClaudeTokenClass;
    value: string;
    scopeType: SecretScope;
  };

  const candidates: Candidate[] = [];

  secrets.forEach((secret, index) => {
    if (secret.key !== 'ANTHROPIC_API_KEY' && secret.key !== 'CLAUDE_CODE_OAUTH_TOKEN') {
      return;
    }
    const value = secret.value.trim();
    if (!value) return;
    const tokenClass = classifyClaudeToken(value, secret.key);
    candidates.push({
      index,
      secret,
      tokenClass,
      value,
      scopeType: normalizeSecretScope(secret.scope_type),
    });
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const scopeDelta = SCOPE_RANK[b.scopeType] - SCOPE_RANK[a.scopeType];
    if (scopeDelta !== 0) return scopeDelta;
    const tokenDelta = TOKEN_RANK[b.tokenClass] - TOKEN_RANK[a.tokenClass];
    if (tokenDelta !== 0) return tokenDelta;
    return a.index - b.index;
  });

  const selected = candidates[0];
  const warnings =
    selected.tokenClass === 'oauth'
      ? ['Selected a short-lived Claude OAuth token; prefer a long-lived setup-token from `claude setup-token`.']
      : undefined;

  if (selected.tokenClass === 'api-key') {
    return {
      source: 'eve-secret',
      secretKey: 'ANTHROPIC_API_KEY',
      scopeType: selected.scopeType,
      scopeId: selected.secret.scope_id,
      tokenClass: selected.tokenClass,
      tokenValue: selected.value,
      env: { ANTHROPIC_API_KEY: selected.value },
      scrub: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_OAUTH_EXPIRES_AT', 'ANTHROPIC_AUTH_TOKEN'],
      warnings,
    };
  }

  return {
    source: 'eve-secret',
    secretKey: 'CLAUDE_CODE_OAUTH_TOKEN',
    scopeType: selected.scopeType,
    scopeId: selected.secret.scope_id,
    tokenClass: selected.tokenClass,
    tokenValue: selected.value,
    env: selected.tokenClass === 'oauth' ? { CLAUDE_CODE_OAUTH_TOKEN: selected.value } : {},
    scrub: selected.tokenClass === 'setup-token'
      ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_OAUTH_EXPIRES_AT']
      : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    warnings,
  };
}

export function scrubClaudeAuthEnv(
  env: Record<string, string | undefined>,
  decision: ClaudeAuthDecision | null,
): { env: Record<string, string | undefined>; scrubbedKeys: string[] } {
  const scrubbed = new Set<string>();
  const remove = (key: string) => {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      scrubbed.add(key);
    }
  };

  for (const key of CLAUDE_AUTH_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length === 0) {
      remove(key);
    }
  }

  for (const key of decision?.scrub ?? []) {
    remove(key);
  }

  return {
    env,
    scrubbedKeys: CLAUDE_AUTH_ENV_KEYS.filter((key) => scrubbed.has(key)),
  };
}

export async function prepareClaudeRuntimeConfig(
  repoPath: string,
  sourceConfigDir: string,
  jobUserHome: string,
  attemptId: string,
  harness: 'claude' | 'mclaude',
  variant?: string,
): Promise<ClaudeRuntimeConfig> {
  const configDir = path.join(
    jobUserHome,
    '.claude-runtime',
    harness,
    sanitizePathSegment(variant ?? 'default'),
  );
  assertOutsideRepo(repoPath, configDir, 'CLAUDE_CONFIG_DIR');

  await fs.mkdir(configDir, { recursive: true });

  let copiedConfig = false;
  const resolvedSource = path.resolve(sourceConfigDir);
  const resolvedTarget = path.resolve(configDir);
  if (resolvedSource !== resolvedTarget) {
    try {
      await fs.cp(resolvedSource, resolvedTarget, {
        recursive: true,
        force: true,
        filter: (src) => !CLAUDE_CREDENTIAL_FILENAMES.has(path.basename(src)),
      });
      copiedConfig = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return {
    configDir,
    sourceConfigDir,
    credentialsPath: path.join(configDir, '.credentials.json'),
    copiedConfig,
  };
}

export async function materializeClaudeCredentials(
  configDir: string,
  decision: ClaudeAuthDecision | null,
  now: Date = new Date(),
): Promise<ClaudeCredentialMaterialization> {
  const credentialsPath = path.join(configDir, '.credentials.json');
  if (!decision) {
    return { written: false, path: credentialsPath };
  }

  if (decision.tokenClass !== 'setup-token') {
    return {
      written: false,
      path: credentialsPath,
      warning: decision.tokenClass === 'oauth'
        ? 'OAuth token selected; using CLAUDE_CODE_OAUTH_TOKEN env instead of writing credentials.'
        : undefined,
    };
  }

  await fs.mkdir(configDir, { recursive: true });
  const payload = {
    claudeAiOauth: {
      accessToken: decision.tokenValue,
      expiresAt: now.getTime() + MILLIS_365_DAYS,
      scopes: ['user:inference'],
      subscriptionType: 'unknown',
    },
  };
  await fs.writeFile(credentialsPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(credentialsPath, 0o600);
  return { written: true, path: credentialsPath };
}

export function redactAuthDecision(
  decision: ClaudeAuthDecision | null,
): RedactedClaudeAuthDecision {
  if (!decision) {
    return {
      selected: false,
      source: 'none',
      secret_key: null,
      scope_type: null,
      scope_id: null,
      token_class: null,
    };
  }

  return {
    selected: true,
    source: decision.source,
    secret_key: decision.secretKey,
    scope_type: decision.scopeType,
    scope_id: decision.scopeId ?? null,
    token_class: decision.tokenClass,
    token_length: decision.tokenValue.length,
    token_fingerprint: fingerprintToken(decision.tokenValue),
    env_keys: Object.keys(decision.env).sort(),
    scrub: [...decision.scrub],
    warnings: decision.warnings,
  };
}

function asClaudeEventRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const raw = record.raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return record;
}

export function readClaudeApiKeySource(parsed: unknown): string | null {
  const record = asClaudeEventRecord(parsed);
  if (!record) return null;
  if (record.type !== 'system' || record.subtype !== 'init') return null;
  return typeof record.apiKeySource === 'string' ? record.apiKeySource : null;
}

const CLAUDE_AUTH_ERROR_RE =
  /\b401\b|invalid authentication credentials|oauth token has expired|authentication_error|invalid x-api-key|invalid api[\s_-]?key|api[\s_-]?key (?:is )?(?:invalid|missing|required|expired|not (?:found|provided))|no api[\s_-]?key (?:found|provided)|could not (?:find|resolve) (?:an? )?api[\s_-]?key/i;

function isErrorBearingClaudeEvent(input: unknown): boolean {
  const record = asClaudeEventRecord(input);
  if (!record) return false;
  const type = record.type;
  if (type === 'result' && record.is_error === true) return true;
  if (type === 'error') return true;
  if (type === 'system_error' || type === 'spawn_error' || type === 'stderr') return true;
  return false;
}

export function detectClaudeAuthFailure(
  input: unknown,
  options?: { stream?: 'stdout' | 'stderr' | 'error' },
): { reason: string; apiKeySource?: string } | null {
  const apiKeySource = readClaudeApiKeySource(input);
  if (apiKeySource === 'none') {
    return { reason: 'apiKeySource=none', apiKeySource };
  }

  const text = typeof input === 'string'
    ? options?.stream === 'stdout'
      ? ''
      : input
    : isErrorBearingClaudeEvent(input)
      ? JSON.stringify(input)
      : '';
  if (CLAUDE_AUTH_ERROR_RE.test(text)) {
    return { reason: 'claude_auth_error_text', apiKeySource: apiKeySource ?? undefined };
  }

  return null;
}

function normalizeSecretScope(scope: SecretResolveItem['scope_type'] | undefined): SecretScope {
  return scope === 'project' || scope === 'org' || scope === 'user' || scope === 'system'
    ? scope
    : 'unknown';
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, 'default');
  return sanitized.length > 0 ? sanitized : 'default';
}

function assertOutsideRepo(repoPath: string, candidate: string, label: string): void {
  const repo = path.resolve(repoPath);
  const target = path.resolve(candidate);
  const relative = path.relative(repo, target);
  if (relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be outside repoPath`);
  }
}

function fingerprintToken(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
