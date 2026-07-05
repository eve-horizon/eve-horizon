import { z } from 'zod';
import {
  DEFAULT_INGRESS_MAX_BODY_SIZE,
  DEFAULT_INGRESS_TIMEOUT,
  IngressByteSizeSchema,
  IngressDurationSchema,
} from '../schemas/ingress-units.js';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  if (typeof value === 'boolean') return value;
  return value;
}, z.boolean());

const workspaceRootFromEnv = z.preprocess((value) => {
  // If WORKSPACE_ROOT is explicitly set, use it
  if (value !== undefined) return value;
  // Otherwise, fall back to EVE_WORKSPACE_ROOT if set
  return process.env.EVE_WORKSPACE_ROOT;
}, z.string().default('/tmp/eve/workspaces'));

// Millisecond interval parsed exactly like the orchestrator worker client's
// historical resolvePollIntervalMs: missing/malformed values or anything below
// 100ms fall back to the default.
const boundedMsFromEnv = (fallbackMs: number) =>
  z.preprocess((value) => {
    const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10);
    return !Number.isFinite(parsed) || parsed < 100 ? fallbackMs : parsed;
  }, z.number().int());

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  // Default ports match _config.sh: base_port (4800) + offset
  API_PORT: z.coerce.number().default(4801),
  ORCHESTRATOR_PORT: z.coerce.number().default(4802),
  // Max concurrent jobs the orchestrator can process per replica (default: half of ORCH_CONCURRENCY_MAX)
  ORCH_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  // Main orchestrator claim/dispatch loop cadence (milliseconds)
  ORCH_LOOP_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  // Phase 3: Auto-tuner configuration
  ORCH_CONCURRENCY_MIN: z.coerce.number().int().min(1).default(1), // Minimum concurrency for auto-tuner
  ORCH_CONCURRENCY_MAX: z.coerce.number().int().min(1).default(8), // Maximum concurrency for auto-tuner
  ORCH_TUNER_ENABLED: booleanFromEnv.default(true), // Cgroup-based auto-tuning (scales between MIN and MAX based on resource pressure)
  ORCH_TUNER_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000), // How often the tuner checks metrics (milliseconds)
  ORCH_TUNER_CPU_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8), // CPU usage fraction above which to decrease concurrency
  ORCH_TUNER_MEMORY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85), // Memory usage fraction above which to decrease concurrency
  WORKER_IMAGE: z.string().default('default-worker'),

  // ── Orchestrator hot-path routing/dispatch config (ORC-6) ──────────────────
  // Agent-runtime routing target. When set, ALL agent jobs route to the agent
  // runtime (see loop.service / worker.client); when unset they fall back to
  // the worker's harness invoke path.
  EVE_AGENT_RUNTIME_URL: z.string().optional(),
  // Comma-separated name=url mapping of agent-runtime pods (sharded runtimes).
  EVE_AGENT_RUNTIME_URLS: z.string().default(''),
  // Comma-separated name=url mapping of worker deployments.
  EVE_WORKER_URLS: z.string().default(''),
  // Fallback worker URL. Empty string falls back to the default, preserving
  // the original `process.env.WORKER_URL || '...'` semantics.
  WORKER_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().default('http://localhost:4749'),
  ),
  // Worker/agent-runtime completion-poll timeout. Exact-preserving port of
  // `parseInt(process.env.WORKER_TIMEOUT_MS || '1800000', 10)`: empty/unset
  // falls back to 30 minutes; a malformed value still parses to NaN (which
  // degrades to an immediate poll timeout) instead of failing config parse.
  WORKER_TIMEOUT_MS: z.preprocess(
    (value) => Number.parseInt(typeof value === 'string' && value !== '' ? value : '1800000', 10),
    z.number().or(z.nan()),
  ),
  // Completion-event poll cadences and the worker submit timeout (all ms).
  EVE_WORKER_POLL_INTERVAL_MS: boundedMsFromEnv(5000),
  EVE_AGENT_RUNTIME_POLL_INTERVAL_MS: boundedMsFromEnv(250),
  EVE_WORKER_SUBMIT_TIMEOUT_MS: boundedMsFromEnv(30_000),
  // Orchestrator loop cadences, in ticks of ORCH_LOOP_INTERVAL_MS. Kept as raw
  // strings because their defaults are computed from the loop interval (or
  // parsed with `?? '1'`) at the single call site in loop.service.
  EVE_ORCH_RECOVERY_INTERVAL_TICKS: z.string().optional(),
  EVE_ORCH_STALE_RECOVERY_INTERVAL_TICKS: z.string().optional(),
  EVE_ORCH_PIPELINE_RECONCILE_INTERVAL_TICKS: z.string().optional(),
  EVE_ORCH_WAKE_ON_INTERVAL_TICKS: z.string().optional(),

  EVE_WORKSPACE_ROOT: z.string().default('/opt/eve/workspaces'),
  WORKSPACE_ROOT: workspaceRootFromEnv,
  EVE_API_URL: z.string().url().default('http://localhost:4701'),
  EVE_PUBLIC_API_URL: z.string().url().optional(), // Public ingress URL for browser-facing apps (e.g., https://api.eve.example.com)
  EVE_CLEANUP_WORKSPACE_ON_SUCCESS: booleanFromEnv.default(true),
  EVE_CLEANUP_WORKSPACE_ON_FAILURE: booleanFromEnv.default(true),
  EVE_AUTH_ENABLED: booleanFromEnv.default(true),
  EVE_AUTH_JWT_SECRET: z.string().optional(),
  EVE_AUTH_PRIVATE_KEY: z.string().optional(),
  EVE_AUTH_PUBLIC_KEY: z.string().optional(),
  EVE_AUTH_PUBLIC_KEY_OLD: z.string().optional(),
  EVE_AUTH_KEY_ID: z.string().default('key-1'),
  EVE_AUTH_KEY_ID_OLD: z.string().default('key-0'),
  EVE_AUTH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(1),
  EVE_AUTH_ORGS_CLAIM_LIMIT: z.coerce.number().int().min(1).default(50),
  EVE_BOOTSTRAP_TOKEN: z.string().optional(),
  EVE_BOOTSTRAP_TRIGGER_FILE: z.string().default('/tmp/eve-bootstrap-enable'),
  EVE_BOOTSTRAP_WINDOW_MINUTES: z.coerce.number().default(10),
  EVE_AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().default(300),
  EVE_SUPABASE_URL: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_AUTH_URL: z.string().url().optional(), // GoTrue (Supabase Auth) internal URL (e.g., http://supabase-auth.eve.svc.cluster.local:9999)
  SUPABASE_AUTH_EXTERNAL_URL: z.string().url().optional(), // GoTrue public URL for browser clients (e.g., http://auth.eve.lvh.me)
  SUPABASE_AUTH_SERVICE_KEY: z.string().optional(), // HS256 JWT with service_role claim, signed with SUPABASE_JWT_SECRET
  SUPABASE_ANON_KEY: z.string().optional(), // HS256 JWT with anon claim, signed with SUPABASE_JWT_SECRET
  EVE_SSO_URL: z.string().url().optional(), // Public SSO URL (e.g., http://sso.eve.lvh.me)
  EVE_AUTH_ADMIN_PASSWORD: z.string().optional(), // GoTrue DB role password
  EVE_GITHUB_WEBHOOK_SECRET: z.string().optional(),
  EVE_GITHUB_TOKEN: z.string().optional(),
  // Per-org OAuth app credentials are stored in the oauth_app_configs table.
  // The following cluster-level vars have been removed:
  // - EVE_SLACK_SIGNING_SECRET, EVE_SLACK_CLIENT_ID, EVE_SLACK_CLIENT_SECRET
  // - EVE_GOOGLE_CLIENT_ID, EVE_GOOGLE_CLIENT_SECRET
  EVE_INTERNAL_API_KEY: z.string().optional(),
  EVE_GATEWAY_URL: z.string().url().optional(), // Internal gateway URL for outbound delivery (e.g., http://eve-gateway.eve.svc.cluster.local:4820)
  EVE_ORG_FS_LINK_TOKEN_SECRET: z.string().optional(),
  EVE_ORG_FS_LINK_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  EVE_SECRETS_MASTER_KEY: z.string().optional(),
  EVE_DEFAULT_DOMAIN: z.string().optional(), // Cluster-level default domain for Ingress (e.g., lvh.me, apps.example.com)
  EVE_DEFAULT_INGRESS_CLASS: z.string().optional(), // Default ingressClassName for app ingresses (e.g., traefik)
  EVE_DEFAULT_INGRESS_TIMEOUT: IngressDurationSchema.default(DEFAULT_INGRESS_TIMEOUT), // Default L7 request/response timeout for app ingresses
  EVE_DEFAULT_INGRESS_MAX_BODY_SIZE: IngressByteSizeSchema.default(DEFAULT_INGRESS_MAX_BODY_SIZE), // Default request body limit for app ingresses
  EVE_DEFAULT_TLS_CLUSTER_ISSUER: z.string().optional(), // cert-manager ClusterIssuer for app ingresses
  EVE_DEFAULT_TLS_SECRET: z.string().optional(), // Optional fixed TLS secret name (use with wildcard certs)
  EVE_PLATFORM_INGRESS_IP: z.string().optional(), // Platform ingress IP for custom domain DNS verification
  EVE_PLATFORM_INGRESS_HOSTNAME: z.string().optional(), // Platform ingress hostname for CNAME verification
  EVE_MAX_CUSTOM_DOMAINS_PER_PROJECT: z.coerce.number().int().min(1).default(10), // Max custom domains per project
  EVE_REGISTRY_HOST: z.string().optional(), // Eve-native container registry host (e.g., registry.eve.example.com)
  EVE_REGISTRY_SIGNING_KEY: z.string().optional(), // RSA private key (PEM) for signing registry JWTs
  EVE_CORS_ORIGIN: z.string().default('*'), // CORS origin: '*' (any), 'true' (reflect), or specific URL
  Z_AI_API_KEY: z.string().optional(),
  ZAI_MODEL: z.string().optional(),
  EVE_STORAGE_BACKEND: z.string().optional(),
  EVE_STORAGE_ENDPOINT: z.string().optional(),
  EVE_STORAGE_PUBLIC_ENDPOINT: z.string().optional(),
  EVE_STORAGE_REGION: z.string().optional(),
  EVE_STORAGE_ACCESS_KEY_ID: z.string().optional(),
  EVE_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  EVE_STORAGE_ORG_BUCKET_PREFIX: z.string().optional(),
  EVE_STORAGE_APP_BUCKET_PREFIX: z.string().optional(),
  EVE_STORAGE_INTERNAL_BUCKET: z.string().optional(),
  EVE_APP_STORAGE_ENDPOINT: z.string().optional(),
  EVE_APP_STORAGE_PUBLIC_ENDPOINT: z.string().optional(),
  EVE_APP_STORAGE_REGION: z.string().optional(),
  EVE_APP_STORAGE_ACCESS_KEY_ID: z.string().optional(),
  EVE_APP_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),

  // SES mailer hardening. See docs/plans/magic-link-email-silent-drop-plan.md.
  // 'auto' = enabled when GOTRUE_SMTP_HOST is *.amazonaws.com. 'true'/'false' override.
  EVE_MAILER_CHECK_SUPPRESSION: z.enum(['auto', 'true', 'false']).default('auto'),
  // SES region for GetSuppressedDestination. Defaults to the region parsed from GOTRUE_SMTP_HOST.
  EVE_MAILER_SES_REGION: z.string().optional(),
  // SES configuration set passed as X-SES-CONFIGURATION-SET on outbound SMTP so events route
  // to the bounce/complaint SNS topic configured by the deployment instance.
  EVE_SES_CONFIGURATION_SET: z.string().optional(),
  // SNS topic ARN allowed to publish to POST /webhooks/ses-feedback. Used to reject spoofed messages.
  EVE_SES_FEEDBACK_TOPIC_ARN: z.string().optional(),

  // Compute model for the cluster the deployer is targeting. Drives compute-class
  // and stable-egress branching. The worker overlay sets this for managed clusters.
  EVE_COMPUTE_MODEL: z.enum(['k3s', 'gke', 'eks', 'aks', 'ecs']).default('k3s'),
  EVE_TCP_INGRESS_PROVIDER: z.enum(['none', 'aws-nlb', 'klipper']).default('none'),
  EVE_TCP_INGRESS_HOSTED_ZONE: z.string().optional(),

  // Stable-egress node group convention. Defaults match the eks-egress-pool
  // Terraform module so platform and infra agree without per-cluster wiring.
  EVE_STABLE_EGRESS_NODE_LABEL_KEY: z.string().default('eve.io/egress-pool'),
  EVE_STABLE_EGRESS_NODE_LABEL_VALUE: z.string().default('stable'),
  EVE_STABLE_EGRESS_TAINT_KEY: z.string().default('eve.io/egress-pool'),
  EVE_STABLE_EGRESS_TAINT_VALUE: z.string().default('stable'),
  EVE_STABLE_EGRESS_TAINT_EFFECT: z.enum(['NoSchedule', 'PreferNoSchedule', 'NoExecute']).default('NoSchedule'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse(process.env);
}
