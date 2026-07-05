import { z } from 'zod';
import { ExecutionModeSchema } from './common.js';
import {
  JobGitSchema,
  JobWorkspaceSchema,
  ResolvedGitMetadataSchema,
} from './git-controls.js';
import { AccessBindingScopeSchema } from './access-scope.js';

const JobPhaseSchema = z.enum([
  'idea',
  'backlog',
  'ready',
  'active',
  'review',
  'done',
  'cancelled',
]);

const JobReviewRequiredSchema = z.enum(['none', 'human', 'agent']);
const JobReviewStatusSchema = z.enum(['pending', 'approved', 'rejected']);

const ReasoningEffortSchema = z.enum(['low', 'medium', 'high', 'x-high']);

const JobHarnessOptionsSchema = z
  .object({
    variant: z.string().optional(),
    model: z.string().optional(),
    reasoning_effort: ReasoningEffortSchema.optional(),
  })
  .passthrough();

export const InlineProfileBundleSchema = z
  .object({
    harness: z.string().min(1),
    model: z.string().optional(),
    reasoning_effort: ReasoningEffortSchema.optional(),
    variant: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

export type InlineProfileBundle = z.infer<typeof InlineProfileBundleSchema>;

// Env variables Eve reserves for its own runtime control — callers must not shadow.
const RESERVED_ENV_PREFIXES = ['EVE_'];
const RESERVED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'TMPDIR',
  'NODE_OPTIONS',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'PI_HOME',
]);

// Only ${secret.KEY} placeholders are permitted inside env override values.
// Match any ${...} and verify it starts with `secret.` with an uppercase identifier.
const EXPR_SCAN = /\$\{([^}]*)\}/g;
const SECRET_EXPR = /^secret\.[A-Z_][A-Z0-9_]*$/;

export function isReservedEnvKey(key: string): boolean {
  if (RESERVED_ENV_KEYS.has(key)) return true;
  return RESERVED_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

const EnvOverridesShape = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env key must be UPPER_SNAKE_CASE'),
  z.string().max(2048, 'env value exceeds 2048 chars'),
);

export const EnvOverridesSchema = EnvOverridesShape.superRefine((raw, ctx) => {
  if (JSON.stringify(raw).length > 4096) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'env_overrides exceeds 4KB' });
  }
  for (const [key, value] of Object.entries(raw)) {
    if (isReservedEnvKey(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `env key ${key} is reserved by Eve and cannot be overridden`,
      });
      continue;
    }
    let match: RegExpExecArray | null;
    EXPR_SCAN.lastIndex = 0;
    while ((match = EXPR_SCAN.exec(value)) !== null) {
      const expr = match[1];
      if (!SECRET_EXPR.test(expr)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `env value contains unsupported expression \${${expr}}; only \${secret.KEY} is allowed`,
        });
      }
    }
  }
});

export type EnvOverrides = z.infer<typeof EnvOverridesSchema>;

export function envOverridesReferenceSecrets(envOverrides: EnvOverrides | undefined): boolean {
  if (!envOverrides) return false;
  return Object.values(envOverrides).some((value) =>
    /\$\{secret\.[A-Z_][A-Z0-9_]*\}/.test(value),
  );
}

export function mergeEnvOverrides(
  workflowEnv: EnvOverrides | undefined,
  stepEnv: EnvOverrides | undefined,
  invocationEnv: EnvOverrides | undefined,
): EnvOverrides | null {
  const merged = {
    ...(workflowEnv ?? {}),
    ...(stepEnv ?? {}),
    ...(invocationEnv ?? {}),
  };
  if (Object.keys(merged).length === 0) return null;
  return EnvOverridesSchema.parse(merged);
}

export const HarnessProfileSourceSchema = z.enum([
  'agent_default',
  'string_ref',
  'inline_override',
  'workflow_template',
]);
export type HarnessProfileSource = z.infer<typeof HarnessProfileSourceSchema>;

const JobHintsSchema = z
  .object({
    worker_type: z.string().optional(),
    // Note: 'default' is deprecated (treated as 'yolo' since interactive prompts don't work in streaming mode)
    permission_policy: z.enum(['yolo', 'auto_edit', 'never', 'default']).optional(),
    timeout_seconds: z.number().int().positive().optional(),
    db_access: z.enum(['read_only', 'read_write']).optional(),
    // Phase 5: compute SKU selection
    resource_class: z.string().optional(),
    // Phase 7: per-job budgets
    max_cost: z.object({ currency: z.string(), amount: z.number() }).optional(),
    max_tokens: z.number().int().positive().optional(),
    // Phase 7: admission control annotations (job remains ready)
    budget_blocked: z.boolean().optional(),
    budget_blocked_reason: z.string().optional(),
    // Runtime probe jobs can skip optional workspace adornments that are not
    // needed to verify harness auth.
    auth_probe: z.boolean().optional(),
    skip_workspace_skills: z.boolean().optional(),
    // Team coordination
    supervising: z.boolean().optional(),
    skill_mode: z.string().optional(),
    coordination: z.object({
      thread_id: z.string(),
      dispatch_mode: z.string().optional(),
    }).optional(),
    gates: z.array(z.string()).optional(),
    // App API awareness: names of project APIs the agent should have access to
    app_apis: z.array(z.string()).optional(),
    // Cross-project app-link aliases the agent should have access to
    app_links: z.array(z.string()).optional(),
  })
  .passthrough();

export type JobHints = z.infer<typeof JobHintsSchema>;

export const JobTargetSchema = z.object({
  agent_slug: z.string().optional(),
  team: z.string().optional(),
  workflow: z.string().optional(),
}).refine(
  data => data.agent_slug || data.team || data.workflow,
  { message: 'At least one of agent_slug, team, or workflow must be specified' }
);

export type JobTarget = z.infer<typeof JobTargetSchema>;

export const ResourceRefSchema = z.object({
  name: z.string().optional(),
  uri: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  mount_path: z.string().optional(),
  mime_type: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ResourceRef = z.infer<typeof ResourceRefSchema>;

export const CreateJobRequestSchema = z.object({
  description: z.string().min(1),
  title: z.string().max(500).optional(),
  issue_type: z.enum(['task', 'bug', 'feature', 'epic', 'chore']).optional(),
  labels: z.array(z.string()).optional(),
  phase: JobPhaseSchema.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assignee: z.string().nullable().optional(),
  review_required: JobReviewRequiredSchema.optional(),
  parent_id: z.string().nullable().optional(),
  defer_until: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  harness: z.string().optional(),
  harness_profile: z.string().optional(),
  harness_options: JobHarnessOptionsSchema.optional(),
  harness_profile_override: InlineProfileBundleSchema.optional(),
  env_overrides: EnvOverridesSchema.optional(),
  hints: JobHintsSchema.optional(),
  git: JobGitSchema.optional(),
  workspace: JobWorkspaceSchema.optional(),
  env_name: z.string().nullable().optional(),
  execution_mode: ExecutionModeSchema.optional(),
  target: JobTargetSchema.optional(),
  resource_refs: z.array(ResourceRefSchema).optional(),
});

export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const UpdateJobRequestSchema = z.object({
  title: z.string().max(500).optional(),
  description: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  phase: JobPhaseSchema.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assignee: z.string().nullable().optional(),
  review_required: JobReviewRequiredSchema.optional(),
  defer_until: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  close_reason: z.string().nullable().optional(),
  harness: z.string().nullable().optional(),
  harness_profile: z.string().nullable().optional(),
  harness_options: JobHarnessOptionsSchema.nullable().optional(),
  hints: JobHintsSchema.optional(),
  git: JobGitSchema.optional(),
  workspace: JobWorkspaceSchema.optional(),
  env_name: z.string().nullable().optional(),
  execution_mode: ExecutionModeSchema.optional(),
});

export type UpdateJobRequest = z.infer<typeof UpdateJobRequestSchema>;

export const JobResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_id: z.string().nullable().optional(),
  depth: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  issue_type: z.string(),
  labels: z.array(z.string()),
  phase: JobPhaseSchema,
  priority: z.number().int(),
  assignee: z.string().nullable().optional(),
  review_required: JobReviewRequiredSchema,
  review_status: JobReviewStatusSchema.nullable().optional(),
  reviewer: z.string().nullable().optional(),
  defer_until: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  // The last time the job entered the `ready` phase (used for queue wait receipts).
  ready_at: z.string().nullable().optional(),
  harness: z.string().nullable().optional(),
  harness_profile: z.string().nullable().optional(),
  harness_options: JobHarnessOptionsSchema.nullable().optional(),
  harness_profile_override: InlineProfileBundleSchema.nullable().optional(),
  env_overrides: z.record(z.string()).nullable().optional(),
  token_scope: AccessBindingScopeSchema.nullable().optional(),
  token_permissions: z.array(z.string()).nullable().optional(),
  harness_profile_source: HarnessProfileSourceSchema.nullable().optional(),
  harness_profile_hash: z.string().nullable().optional(),
  hints: JobHintsSchema.optional(),
  git: JobGitSchema.optional(),
  resolved_git: ResolvedGitMetadataSchema.optional(),
  workspace: JobWorkspaceSchema.optional(),
  blocked_on_gates: z.array(z.string()),
  env_name: z.string().nullable().optional(),
  execution_mode: ExecutionModeSchema,
  execution_type: z.enum(['agent', 'script', 'action']),
  run_id: z.string().nullable().optional(),
  step_name: z.string().nullable().optional(),
  action_type: z.string().nullable().optional(),
  action_input: z.record(z.unknown()).nullable().optional(),
  script_command: z.string().nullable().optional(),
  script_timeout_seconds: z.number().int().nullable().optional(),
  target: JobTargetSchema.nullable().optional(),
  resource_refs: z.array(ResourceRefSchema).optional(),
  content_hash: z.string().nullable().optional(),
  actor_user_id: z.string().nullable().optional(),
  failure_disposition: z.enum(['cancelled', 'failed', 'upstream_failed']).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable().optional(),
  close_reason: z.string().nullable().optional(),
});

export type JobResponse = z.infer<typeof JobResponseSchema>;

export const CreateJobResponseSchema = JobResponseSchema;
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

export const JobListResponseSchema = z.object({
  jobs: z.array(JobResponseSchema),
  total: z.number().int().optional(),
});

export type JobListResponse = z.infer<typeof JobListResponseSchema>;

// --------------------------------------------------------------------------
// Job execution and review schemas
// --------------------------------------------------------------------------

export const JobAttemptResponseSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  attempt_number: z.number().int(),
  status: z.string(),
  trigger_type: z.string(),
  harness: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  started_at: z.string(),
  execution_started_at: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
  result_summary: z.string().nullable().optional(),
  runtime_meta: z.record(z.unknown()).optional(),
  git: ResolvedGitMetadataSchema.optional(),
  exit_code: z.number().int().nullable().optional(),
  result_text: z.string().nullable().optional(),
  result_json: z.record(z.unknown()).nullable().optional(),
  duration_ms: z.number().int().nullable().optional(),
  token_input: z.number().int().nullable().optional(),
  token_output: z.number().int().nullable().optional(),
  error_message: z.string().nullable().optional(),
  harness_profile_source: HarnessProfileSourceSchema.nullable().optional(),
  harness_profile_hash: z.string().nullable().optional(),
});

export type JobAttemptResponse = z.infer<typeof JobAttemptResponseSchema>;

export const JobAttemptListResponseSchema = z.object({
  attempts: z.array(JobAttemptResponseSchema),
});

export type JobAttemptListResponse = z.infer<typeof JobAttemptListResponseSchema>;

export const JobResultResponseSchema = z.object({
  jobId: z.string().optional(),
  attemptId: z.string().optional(),
  attemptNumber: z.number().int().optional(),
  status: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  resultText: z.string().nullable().optional(),
  resultJson: z.record(z.unknown()).nullable().optional(),
  git: ResolvedGitMetadataSchema.optional(),
  durationMs: z.number().int().nullable().optional(),
  tokenUsage: z
    .object({
      input: z.number().int().nullable(),
      output: z.number().int().nullable(),
    })
    .nullable()
    .optional(),
  errorMessage: z.string().nullable().optional(),
});

export type JobResultResponse = z.infer<typeof JobResultResponseSchema>;

export const WaitTimeoutResponseSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  phase: z.string(),
  elapsed: z.number().int(),
  message: z.string(),
});

export type WaitTimeoutResponse = z.infer<typeof WaitTimeoutResponseSchema>;

export const ClaimRequestSchema = z.object({
  agent_id: z.string(),
  harness: z.string().optional(),
});

export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

export const ClaimResponseSchema = z.object({
  attempt: JobAttemptResponseSchema,
});

export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

export const ReleaseRequestSchema = z.object({
  agent_id: z.string(),
  reason: z.string().optional(),
});

export type ReleaseRequest = z.infer<typeof ReleaseRequestSchema>;

export const JobReleaseResponseSchema = z.object({
  job: JobResponseSchema,
});

export type JobReleaseResponse = z.infer<typeof JobReleaseResponseSchema>;

export const SubmitRequestSchema = z.object({
  summary: z.string(),
  agent_id: z.string().optional(),
});

export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

export const ApproveRequestSchema = z.object({
  reviewer_id: z.string(),
  comment: z.string().optional(),
});

export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

export const RejectRequestSchema = z.object({
  reviewer_id: z.string(),
  reason: z.string(),
});

export type RejectRequest = z.infer<typeof RejectRequestSchema>;

export const AddDependencyRequestSchema = z.object({
  related_job_id: z.string(),
  relation_type: z.string().optional(),
});

export type AddDependencyRequest = z.infer<typeof AddDependencyRequestSchema>;

export const DependenciesResponseSchema = z.object({
  dependencies: z.array(JobResponseSchema.extend({ relation_type: z.string() })),
  dependents: z.array(JobResponseSchema.extend({ relation_type: z.string() })),
  blocking: z.array(JobResponseSchema.extend({ relation_type: z.string() })),
});

export type DependenciesResponse = z.infer<typeof DependenciesResponseSchema>;

export const JobTreeNodeSchema: z.ZodTypeAny = z.lazy(() =>
  JobResponseSchema.extend({
    children: z.array(JobTreeNodeSchema).optional(),
  }),
);

export type JobTreeNode = z.infer<typeof JobTreeNodeSchema>;

const SiblingInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  phase: z.string(),
  assignee: z.string().nullable(),
  effective_phase: z.string(),
  result_summary: z.string().nullable(),
});

export const JobContextResponseSchema = z.object({
  job: JobResponseSchema,
  parent: JobResponseSchema.nullable(),
  children: z.array(JobResponseSchema),
  siblings: z.array(SiblingInfoSchema).optional(),
  relations: DependenciesResponseSchema,
  latest_attempt: z
    .object({
      id: z.string(),
      attempt_number: z.number().int(),
      status: z.string(),
      result_summary: z.string().nullable().optional(),
      result_json: z.record(z.unknown()).nullable().optional(),
      git: ResolvedGitMetadataSchema.optional(),
    })
    .nullable(),
  latest_rejection_reason: z.string().nullable().optional(),
  blocked: z.boolean(),
  waiting: z.boolean(),
  effective_phase: z.string(),
  dispatch_thread_id: z.string().nullable().optional(),
  dispatch_mode: z.string().nullable().optional(),
});

export type JobContextResponse = z.infer<typeof JobContextResponseSchema>;

export const JobLogsResponseSchema = z.object({
  logs: z.array(
    z.object({
      sequence: z.number().int(),
      timestamp: z.string(),
      type: z.string(),
      line: z.record(z.unknown()),
    }),
  ),
});

export type JobLogsResponse = z.infer<typeof JobLogsResponseSchema>;

export const SuccessMessageSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type SuccessMessage = z.infer<typeof SuccessMessageSchema>;
