/**
 * Shared invoke module — single source of truth for agent-execution logic.
 *
 * Both `apps/agent-runtime` and `apps/worker` import from this module.
 * New agent-execution features go here, never duplicated across services.
 */

// Types
// NOTE: LogEntry and GitAuth are intentionally NOT re-exported here to avoid
// name collisions with ./schemas/index.js (LogEntry) and ./git/index.js (GitAuth).
// They remain defined in ./types.ts for internal use within the invoke module.
export type {
  ExtractedResult,
  LogSink,
  LifecycleLogger,
  BudgetConfig,
  LlmUsageEntry,
  BudgetState,
  ResourceHydrationEventType,
  ChatDeliveryContext,
  ThreadMessageRow,
  CoordinationDb,
  OrgDocumentRow,
  JobAttachmentRow,
  CarryoverContextDb,
  RelayDb,
  BudgetDb,
  UpdateAttemptGitMetaFn,
} from './types.js';
export {
  readPositiveInt,
  readPositiveNumber,
  readMaxCostHint,
  parseDurationToMs,
} from './types.js';

// Result extraction
export {
  extractResultText,
  extractResultJson,
  extractTokenUsage,
  extractErrorMessage,
  extractResults,
} from './result-extraction.js';

// Git utilities
export {
  runGit,
  getLocalRepoPath,
  redactRepoUrl,
  updateAttemptGitMeta,
} from './git-utils.js';

// Eve CLI credentials (absorbed from harnesses/invoke-utils)
// NOTE: writeEveCredentials is intentionally NOT re-exported here — it is
// still exported from the harnesses barrel (via invoke-utils.ts) for backwards
// compatibility. Internal invoke modules import directly from './eve-credentials.js'.
export {
  getInvocationJobToken,
  resolveInvocationJobToken,
} from './eve-credentials.js';

// Coordination
export {
  writeCoordinationInbox,
  writeThreadContext,
} from './coordination.js';

// Carryover context
export { writeCarryoverContext } from './carryover-context.js';

// Security policy
export {
  writeSecurityClaudeMd,
  buildSecurityPolicyPreamble,
  buildSecurityClaudeMd,
} from './security-policy.js';

// Workspace hooks
export {
  runHook,
  runAcquireHooks,
  runReleaseHook,
} from './workspace-hooks.js';

// Skill materialization bridge
export { materializeWorkspaceSkills } from './skill-bridge.js';

// Workspace secrets
export {
  resolveSecrets,
  prepareGitAuth,
  materializeSecrets,
  cleanupWorkspaceSecretArtifacts,
  extractSecretRefs,
  interpolateEnvOverrides,
} from './workspace-secrets.js';

// Per-job env_overrides application
export {
  applyEnvOverrides,
  MissingSecretOverrideError,
  type ApplyEnvOverridesOptions,
  type ApplyEnvOverridesResult,
} from './env-overrides.js';

// Claude auth selection/materialization
export {
  CLAUDE_AUTH_ENV_KEYS,
  classifyClaudeToken,
  selectClaudeAuth,
  scrubClaudeAuthEnv,
  prepareClaudeRuntimeConfig,
  materializeClaudeCredentials,
  redactAuthDecision,
  readClaudeApiKeySource,
  detectClaudeAuthFailure,
  type ClaudeTokenClass,
  type SecretScope,
  type ClaudeAuthDecision,
  type RedactedClaudeAuthDecision,
  type ClaudeRuntimeConfig,
  type ClaudeCredentialMaterialization,
} from './claude-auth.js';

// Harness lifecycle events
export {
  logHarnessStart,
  logHarnessEnd,
} from './harness-lifecycle.js';

// Eve message relay
export {
  EveMessageRelay,
  deliverProvisioningError,
  EVE_MESSAGE_COORD_RATE_LIMIT_MS,
  EVE_MESSAGE_CHAT_RATE_LIMIT_MS,
  EVE_MESSAGE_CHAT_MAX_PER_JOB,
  EVE_MESSAGE_MAX_SIZE,
} from './eve-message-relay.js';

// Codex auth write-back
export { writeBackCodexAuth } from './codex-auth.js';

// Resource hydration events
export { emitResourceHydrationEvent } from './resource-hydration.js';

// Budget enforcement
export {
  resolveBudgetEnforcementConfig,
  calculateBudgetTokenBreakdown,
  BudgetEnforcer,
} from './budget-enforcement.js';

// Per-job user home (Phase 2 secret isolation)
export {
  createJobUserHome,
  cleanupJobUserHome,
} from './job-user-home.js';

// Toolchain provisioning for deterministic script/action-run jobs.
export {
  ensureToolchains,
  ToolchainProvisionError,
  type EnsureToolchainsOptions,
  type ToolchainCacheEvent,
  type ToolchainProvisionResult,
} from './toolchain-cache.js';
