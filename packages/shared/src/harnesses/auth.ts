import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import type { HarnessCanonicalName, HarnessName } from './registry.js';
import { resolveHarnessName } from './registry.js';

export type HarnessAuthStatus = {
  available: boolean;
  reason: string;
  instructions: string[];
};

export type HarnessAuthStatusWithName = HarnessAuthStatus & {
  name: HarnessCanonicalName;
};

type EnvLike = Record<string, string | undefined>;
type AuthCheck = (env: EnvLike) => HarnessAuthStatus;

/**
 * Build auth checks that use a merged environment (resolved secrets + process.env).
 * Resolved secrets take precedence over process.env.
 */
function createAuthChecks(): Record<HarnessCanonicalName, AuthCheck> {
  const checks: Record<HarnessCanonicalName, AuthCheck> = {
    mclaude: (env) => {
      if (env.ANTHROPIC_API_KEY) {
        return ready('using ANTHROPIC_API_KEY', instructionsClaude());
      }
      if (env.CLAUDE_CODE_OAUTH_TOKEN) {
        return ready('using CLAUDE_CODE_OAUTH_TOKEN', instructionsClaude());
      }
      if (checkHostCredentials('.claude/.credentials.json', ['claudeAiOauth', 'accessToken'])) {
        return ready('using ~/.claude/.credentials.json', instructionsClaude());
      }
      if (checkMacOSKeychain('Claude Code-credentials')) {
        return ready('using macOS Keychain', instructionsClaude());
      }
      return missing('missing ANTHROPIC_API_KEY or Claude OAuth', instructionsClaude());
    },
    claude: (env) => checks.mclaude(env),
    zai: (env) => {
      if (env.Z_AI_API_KEY || env.ZAI_API_KEY) {
        return ready('using Z_AI_API_KEY', instructionsZai());
      }
      return missing('missing Z_AI_API_KEY', instructionsZai());
    },
    gemini: (env) => {
      if (env.GOOGLE_API_KEY) {
        return ready('using GOOGLE_API_KEY', instructionsGemini());
      }
      if (env.GEMINI_API_KEY) {
        return ready('using GEMINI_API_KEY', instructionsGemini());
      }
      return missing('missing GOOGLE_API_KEY or GEMINI_API_KEY', instructionsGemini());
    },
    code: (env) => {
      if (env.OPENAI_API_KEY) {
        return ready('using OPENAI_API_KEY', instructionsOpenAi());
      }
      if (env.CODEX_AUTH_JSON) {
        return ready('using CODEX_AUTH_JSON', instructionsOpenAi());
      }
      if (env.CODEX_OAUTH_ACCESS_TOKEN) {
        return ready('using CODEX_OAUTH_ACCESS_TOKEN', instructionsOpenAi());
      }
      if (checkHostCredentials('.code/auth.json', ['OPENAI_API_KEY'])) {
        return ready('using ~/.code/auth.json (API key)', instructionsOpenAi());
      }
      if (checkHostCredentials('.code/auth.json', ['tokens', 'access_token'])) {
        return ready('using ~/.code/auth.json (OAuth)', instructionsOpenAi());
      }
      if (checkHostCredentials('.codex/auth.json', ['OPENAI_API_KEY'])) {
        return ready('using ~/.codex/auth.json (API key)', instructionsOpenAi());
      }
      if (checkHostCredentials('.codex/auth.json', ['tokens', 'access_token'])) {
        return ready('using ~/.codex/auth.json (OAuth)', instructionsOpenAi());
      }
      return missing('missing OPENAI_API_KEY or Codex OAuth', instructionsOpenAi());
    },
    codex: (env) => checks.code(env),
    pi: (env) => {
      const hasAnyKey = [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'Z_AI_API_KEY',
        'ZAI_API_KEY',
        'MISTRAL_API_KEY',
        'XAI_API_KEY',
        'GROQ_API_KEY',
        'OPENROUTER_API_KEY',
        'PI_MODELS_JSON_B64',
      ].some(k => !!env[k]);
      return {
        available: hasAnyKey,
        reason: hasAnyKey ? 'using provider credentials' : 'missing pi provider credentials',
        instructions: hasAnyKey
          ? []
          : ['Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, Z_AI_API_KEY, or ZAI_API_KEY.'],
      };
    },
  };
  return checks;
}

const HARNESS_AUTH_CHECKS = createAuthChecks();

/**
 * Get auth status for a harness, optionally using resolved secrets.
 * @param name - Harness name (canonical or alias)
 * @param env - Optional resolved secrets to merge with process.env (takes precedence)
 */
export function getHarnessAuthStatus(
  name: HarnessName,
  env?: Record<string, string | undefined>,
): HarnessAuthStatus {
  const canonical = resolveHarnessName(name) ?? 'code';
  // Merge: resolved secrets take precedence over process.env
  const mergedEnv = { ...process.env, ...env };
  return HARNESS_AUTH_CHECKS[canonical](mergedEnv);
}

/**
 * List auth status for all harnesses, optionally using resolved secrets.
 * @param env - Optional resolved secrets to merge with process.env (takes precedence)
 */
export function listHarnessAuthStatuses(
  env?: Record<string, string | undefined>,
): HarnessAuthStatusWithName[] {
  const mergedEnv = { ...process.env, ...env };
  return Object.keys(HARNESS_AUTH_CHECKS).map((name) =>
    ({
      name: name as HarnessCanonicalName,
      ...HARNESS_AUTH_CHECKS[name as HarnessCanonicalName](mergedEnv),
    }),
  );
}

function ready(reason: string, instructions: string[]): HarnessAuthStatus {
  return { available: true, reason, instructions };
}

function missing(reason: string, instructions: string[]): HarnessAuthStatus {
  return { available: false, reason, instructions };
}

function checkHostCredentials(relativePath: string, jsonPath: string[]): boolean {
  const fullPath = path.join(homedir(), relativePath);
  if (!existsSync(fullPath)) return false;
  try {
    const content = JSON.parse(readFileSync(fullPath, 'utf-8')) as Record<string, unknown>;
    let value: unknown = content;
    for (const key of jsonPath) {
      value = (value as Record<string, unknown> | undefined)?.[key];
    }
    return Boolean(value);
  } catch {
    return false;
  }
}

function checkMacOSKeychain(service: string): boolean {
  if (platform() !== 'darwin') return false;
  try {
    execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function instructionsClaude(): string[] {
  return [
    'Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.',
    'Or run Claude Code login to populate ~/.claude/.credentials.json or Keychain.',
  ];
}

function instructionsZai(): string[] {
  return ['Set Z_AI_API_KEY (or ZAI_API_KEY).'];
}

function instructionsGemini(): string[] {
  return ['Set GOOGLE_API_KEY or GEMINI_API_KEY.'];
}

function instructionsOpenAi(): string[] {
  return [
    'Set OPENAI_API_KEY.',
    'Or set CODEX_AUTH_JSON / CODEX_OAUTH_ACCESS_TOKEN.',
    'Or run the Code/Codex CLI login to populate ~/.code/auth.json or ~/.codex/auth.json.',
  ];
}
