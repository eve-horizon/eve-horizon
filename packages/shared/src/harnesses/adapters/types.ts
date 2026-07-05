import type { HarnessInvocation } from '../../types/harness.js';
import type { HarnessCanonicalName, HarnessName } from '../registry.js';
import type { HarnessCapability } from '../capabilities.js';
import type { ReasoningMode } from './reasoning.js';

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

/**
 * Self-describing harness adapter: carries the per-harness knowledge
 * (aliases, description, capabilities, reasoning mode) alongside the
 * invocation-option builder. The registry, name lists, and capability
 * table are all derived from the adapter list.
 */
export type HarnessAdapter = {
  name: HarnessCanonicalName;
  aliases?: HarnessName[];
  description: string;
  capabilities: HarnessCapability;
  reasoningMode: ReasoningMode;
  buildOptions: (ctx: HarnessContext) => Promise<EveAgentCliOptions>;
};
