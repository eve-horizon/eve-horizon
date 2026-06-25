import { z } from 'zod';
import { PaginationSchema } from './common.js';

const EnvironmentTypeSchema = z.enum(['persistent', 'temporary']);
const EnvironmentKindSchema = z.enum(['standard', 'preview']);
export const EnvironmentStatusSchema = z.enum(['active', 'suspended', 'terminated']);
export type EnvironmentStatus = z.infer<typeof EnvironmentStatusSchema>;

export const DeployStatusSchema = z.enum(['unknown', 'deployed', 'undeployed', 'deploying', 'undeploying', 'failed']);
export type DeployStatus = z.infer<typeof DeployStatusSchema>;

export type EnvironmentKind = z.infer<typeof EnvironmentKindSchema>;

/**
 * Labels schema for environment metadata.
 * Used by PR preview environments to store PR-specific information:
 * - pr_number: The PR number (e.g., "123")
 * - pr_branch: The source branch name
 * - pr_sha: The commit SHA being deployed
 * - pr_url: Full URL to the PR
 * - base_branch: The target branch (e.g., "main")
 * - repo: The repository full name (e.g., "org/repo")
 */
const EnvironmentLabelsSchema = z.record(z.string(), z.string());

export const CreateEnvironmentRequestSchema = z.object({
  name: z.string().min(1),
  type: EnvironmentTypeSchema,
  kind: EnvironmentKindSchema.optional().default('standard'),
  namespace: z.string().optional().nullable(),
  db_ref: z.string().optional().nullable(),
  overrides: z.record(z.unknown()).optional().nullable(),
  labels: EnvironmentLabelsSchema.optional().nullable(),
});

export type CreateEnvironmentRequest = z.infer<typeof CreateEnvironmentRequestSchema>;

export const UpdateEnvironmentRequestSchema = z.object({
  namespace: z.string().optional().nullable(),
  db_ref: z.string().optional().nullable(),
  overrides: z.record(z.unknown()).optional().nullable(),
  labels: EnvironmentLabelsSchema.optional().nullable(),
  current_release_id: z.string().optional().nullable(),
  last_failed_release_id: z.string().optional().nullable(),
});

export type UpdateEnvironmentRequest = z.infer<typeof UpdateEnvironmentRequestSchema>;

export const EnvironmentResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  type: EnvironmentTypeSchema,
  kind: EnvironmentKindSchema,
  namespace: z.string().nullable(),
  db_ref: z.string().nullable(),
  overrides: z.record(z.unknown()).nullable(),
  labels: EnvironmentLabelsSchema.nullable(),
  current_release_id: z.string().nullable(),
  last_failed_release_id: z.string().nullable(),
  last_applied_release_id: z.string().nullable(),
  last_deploy_failure: z
    .object({
      kind: z.string(),
      service: z.string().optional(),
      pod: z.string().optional(),
      message: z.string().optional(),
      namespace: z.string().optional(),
      at: z.string().optional(),
    })
    .passthrough()
    .nullable(),
  ingress_aliases: z.array(z.object({
    alias: z.string(),
    service_name: z.string(),
  })).optional(),
  deploy_status: DeployStatusSchema,
  status: EnvironmentStatusSchema,
  suspended_at: z.string().nullable(),
  suspension_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type EnvironmentResponse = z.infer<typeof EnvironmentResponseSchema>;

export const EnvironmentListResponseSchema = z.object({
  data: z.array(EnvironmentResponseSchema),
  pagination: PaginationSchema,
});

export type EnvironmentListResponse = z.infer<typeof EnvironmentListResponseSchema>;

export const DeleteEnvironmentRequestSchema = z.object({
  force: z.boolean().optional(),
}).optional().default({});

export type DeleteEnvironmentRequest = z.infer<typeof DeleteEnvironmentRequestSchema>;

export const UndeployEnvironmentRequestSchema = z.object({
  force: z.boolean().optional(),
}).optional().default({});

export type UndeployEnvironmentRequest = z.infer<typeof UndeployEnvironmentRequestSchema>;

export const EnvLogEntrySchema = z.object({
  timestamp: z.string(),
  line: z.string(),
  pod: z.string().optional(),
  container: z.string().optional(),
  fields: z.record(z.unknown()).optional(),
});

export type EnvLogEntry = z.infer<typeof EnvLogEntrySchema>;

export const EnvLogsResponseSchema = z.object({
  logs: z.array(EnvLogEntrySchema),
});

export type EnvLogsResponse = z.infer<typeof EnvLogsResponseSchema>;

export const EnvDeploymentConditionSchema = z.object({
  type: z.string(),
  status: z.string(),
  message: z.string().optional(),
});

export type EnvDeploymentCondition = z.infer<typeof EnvDeploymentConditionSchema>;

export const EnvDeploymentStatusSchema = z.object({
  ready: z.boolean(),
  available_replicas: z.number(),
  desired_replicas: z.number(),
  conditions: z.array(EnvDeploymentConditionSchema),
});

export type EnvDeploymentStatus = z.infer<typeof EnvDeploymentStatusSchema>;

export const EnvDeploymentSummarySchema = EnvDeploymentStatusSchema.extend({
  name: z.string(),
});

export type EnvDeploymentSummary = z.infer<typeof EnvDeploymentSummarySchema>;

export const EnvHealthStatusSchema = z.enum(['ready', 'deploying', 'degraded', 'unknown']);

export type EnvHealthStatus = z.infer<typeof EnvHealthStatusSchema>;

export const EnvHealthResponseSchema = z.object({
  project_id: z.string(),
  env_name: z.string(),
  namespace: z.string().nullable(),
  status: EnvHealthStatusSchema,
  ready: z.boolean(),
  deployment: EnvDeploymentStatusSchema.nullable().optional(),
  warnings: z.array(z.string()).optional(),
  checked_at: z.string(),
  k8s_available: z.boolean(),
  active_pipeline_run: z.object({
    id: z.string(),
    pipeline_name: z.string(),
    status: z.string(),
    git_sha: z.string().nullable(),
    created_at: z.string(),
  }).nullable().optional(),
});

export type EnvHealthResponse = z.infer<typeof EnvHealthResponseSchema>;

export const EnvPodInfoSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  phase: z.string(),
  ready: z.boolean(),
  restarts: z.number(),
  age: z.string(),
  labels: z.record(z.string()),
  pod_ip: z.string().nullable().optional(),
  node_name: z.string().nullable().optional(),
  containers: z.array(z.object({
    name: z.string(),
    ready: z.boolean(),
    restart_count: z.number(),
    image: z.string().nullable().optional(),
    image_id: z.string().nullable().optional(),
    state: z.enum(['running', 'waiting', 'terminated', 'unknown']),
    reason: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
    last_terminated_reason: z.string().nullable().optional(),
    last_terminated_exit_code: z.number().nullable().optional(),
  })).optional(),
});

export type EnvPodInfo = z.infer<typeof EnvPodInfoSchema>;

export const EnvEventInfoSchema = z.object({
  type: z.string(),
  reason: z.string().nullable(),
  message: z.string().nullable(),
  timestamp: z.string().nullable(),
  involved_object: z.object({
    kind: z.string(),
    name: z.string(),
    namespace: z.string(),
  }),
});

export type EnvEventInfo = z.infer<typeof EnvEventInfoSchema>;

export const EnvStorageBucketInfoSchema = z.object({
  service_name: z.string(),
  name: z.string(),
  physical_name: z.string(),
  visibility: z.enum(['private', 'public']),
  cors_json: z.record(z.unknown()).optional(),
  isolation_mode: z.string().nullable().optional(),
  iam_role_arn: z.string().nullable().optional(),
  iam_role_name: z.string().nullable().optional(),
  service_account: z.object({
    name: z.string().nullable().optional(),
    namespace: z.string().nullable().optional(),
  }).nullable().optional(),
});

export type EnvStorageBucketInfo = z.infer<typeof EnvStorageBucketInfoSchema>;

export const EnvEmailDeliveryEventSchema = z.object({
  id: z.string(),
  recipient: z.string(),
  ses_message_id: z.string().nullable(),
  rfc_message_id: z.string().nullable(),
  event_type: z.string(),
  bounce_type: z.string().nullable(),
  bounce_subtype: z.string().nullable(),
  diagnostic: z.string().nullable(),
  received_at: z.string(),
});

export type EnvEmailDeliveryEvent = z.infer<typeof EnvEmailDeliveryEventSchema>;

export const EnvTcpIngressListenerSchema = z.object({
  name: z.string(),
  port: z.number(),
  state: z.enum(['pending', 'provisioning', 'ready']).or(z.string()),
  node_target_port: z.number().nullable().optional(),
});

export type EnvTcpIngressListener = z.infer<typeof EnvTcpIngressListenerSchema>;

export const EnvTcpIngressInfoSchema = z.object({
  service: z.string(),
  provider: z.enum(['none', 'aws-nlb', 'klipper']).or(z.string()),
  hostname: z.string().nullable().optional(),
  external_hostname: z.string().nullable().optional(),
  external_ip: z.string().nullable().optional(),
  listeners: z.array(EnvTcpIngressListenerSchema),
});

export type EnvTcpIngressInfo = z.infer<typeof EnvTcpIngressInfoSchema>;

export const EnvHttpIngressInfoSchema = z.object({
  service: z.string(),
  hosts: z.array(z.string()),
  controller_flavor: z.enum(['nginx', 'traefik', 'unknown']).or(z.string()),
  requested_timeout_seconds: z.number().nullable(),
  requested_max_body_size: z.string().nullable(),
  effective_timeout_seconds: z.number().nullable(),
  effective_max_body_size: z.string().nullable(),
  timeout_source: z.enum(['manifest', 'platform_default', 'unsupported_controller', 'missing']).or(z.string()),
  max_body_size_source: z.enum(['manifest', 'platform_default', 'unsupported_controller', 'missing']).or(z.string()),
});

export type EnvHttpIngressInfo = z.infer<typeof EnvHttpIngressInfoSchema>;

export const EnvDiagnoseResponseSchema = z.object({
  project_id: z.string(),
  env_name: z.string(),
  namespace: z.string().nullable(),
  status: EnvHealthStatusSchema,
  ready: z.boolean(),
  k8s_available: z.boolean(),
  deployments: z.array(EnvDeploymentSummarySchema),
  pods: z.array(EnvPodInfoSchema),
  events: z.array(EnvEventInfoSchema),
  storage_buckets: z.array(EnvStorageBucketInfoSchema).optional(),
  http_ingress: z.array(EnvHttpIngressInfoSchema).optional(),
  tcp_ingress: z.array(EnvTcpIngressInfoSchema).optional(),
  /** Recent SES delivery events (bounces/complaints/etc.) for recipients
   *  who are members of an org/project tied to this env. Capped at ~20 most
   *  recent. Empty array when none. Always present so CLIs can render a
   *  stable shape. */
  recent_email_delivery_events: z.array(EnvEmailDeliveryEventSchema).optional(),
  warnings: z.array(z.string()).optional(),
  checked_at: z.string(),
});

export type EnvDiagnoseResponse = z.infer<typeof EnvDiagnoseResponseSchema>;

export const EnvRequestLogEntrySchema = EnvLogEntrySchema.extend({
  service: z.string(),
});

export const EnvRequestDeployMetadataSchema = z.object({
  release_id: z.string().nullable(),
  git_sha: z.string().nullable(),
  manifest_hash: z.string().nullable(),
  deployed_at: z.string().nullable(),
});

export const EnvRequestTraceSummarySchema = z.object({
  trace_id: z.string().nullable().optional(),
  available: z.boolean(),
  store: z.string().optional(),
  hint: z.string().optional(),
  spans: z.array(z.record(z.unknown())).optional(),
});

export const EnvRequestDiagnoseResponseSchema = z.object({
  project_id: z.string(),
  env_name: z.string(),
  namespace: z.string().nullable(),
  request_id: z.string(),
  request_window: z.object({
    first_seen: z.string().nullable(),
    last_seen: z.string().nullable(),
    searched_seconds: z.number(),
  }),
  deploy_at_request_time: EnvRequestDeployMetadataSchema.nullable(),
  logs: z.array(EnvRequestLogEntrySchema),
  k8s_events: z.array(EnvEventInfoSchema),
  traces: EnvRequestTraceSummarySchema,
  audit_log_entries: z.array(z.record(z.unknown())).optional(),
  warnings: z.array(z.string()).optional(),
  checked_at: z.string(),
});

export type EnvRequestDiagnoseResponse = z.infer<typeof EnvRequestDiagnoseResponseSchema>;

// ---------------------------------------------------------------------------
// Environment Suspension (Phase 11 schemas, combined with Phase 10)
// ---------------------------------------------------------------------------

export const SuspendEnvironmentRequestSchema = z.object({
  reason: z.string().min(1, 'Suspension reason is required'),
});

export type SuspendEnvironmentRequest = z.infer<typeof SuspendEnvironmentRequestSchema>;

export const ResumeEnvironmentRequestSchema = z.object({}).optional();

export type ResumeEnvironmentRequest = z.infer<typeof ResumeEnvironmentRequestSchema>;

export const SuspendEnvironmentResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: EnvironmentStatusSchema,
  suspended_at: z.string().nullable(),
  suspension_reason: z.string().nullable(),
});

export type SuspendEnvironmentResponse = z.infer<typeof SuspendEnvironmentResponseSchema>;

export const ResumeEnvironmentResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: EnvironmentStatusSchema,
  suspended_at: z.string().nullable(),
  suspension_reason: z.string().nullable(),
});

export type ResumeEnvironmentResponse = z.infer<typeof ResumeEnvironmentResponseSchema>;
