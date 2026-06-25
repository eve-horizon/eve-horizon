import type { HarnessInvocation } from '../../types/harness.js';
import type { HarnessName } from '../registry.js';

export type PermissionPolicy = 'default' | 'auto_edit' | 'never' | 'yolo';

export type EveAgentCliOptions = {
  harness: HarnessName;
  permission: PermissionPolicy;
  variant?: string;
  model?: string;
  reasoning?: string;
  env?: Record<string, string | undefined>;
};

export type HarnessAuthResolution = {
  env: Record<string, string | undefined>;
  configDir?: string;
};

export type HarnessHelpers = {
  resolveMclaudeAuth: (options?: {
    configDir?: string;
    harness?: 'claude' | 'mclaude';
    variant?: string;
  }) => Promise<HarnessAuthResolution>;
  resolveCodeAuth: (options?: { configDir?: string }) => Promise<HarnessAuthResolution>;
};

export type HarnessContext = {
  invocation: HarnessInvocation;
  harness: HarnessName;
  permission: PermissionPolicy;
  repoPath: string;
  helpers: HarnessHelpers;
  /** Resolved secrets from project/org/user/system merged with process.env */
  env: Record<string, string | undefined>;
};

export type HarnessAdapter = {
  name: HarnessName;
  aliases?: HarnessName[];
  buildOptions: (ctx: HarnessContext) => Promise<EveAgentCliOptions>;
};
