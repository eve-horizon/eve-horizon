import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { GitShaSchema } from './common.js';
import { PackEntrySchema } from './pack.js';
import { PipelineDefinitionSchema } from './pipeline.js';
import { WorkflowDefinitionSchema } from './workflow.js';
import { SecretValidationResultSchema } from './secret.js';
import {
  ManifestGitDefaultsSchema,
  ManifestWorkspaceDefaultsSchema,
} from './git-controls.js';
import {
  getManagedDbExtensionValidationError,
  normalizeManagedDbExtensions,
} from '../managed-db/extensions.js';
import { IngressByteSizeSchema, IngressDurationSchema } from './ingress-units.js';

export const SyncManifestRequestSchema = z.object({
  yaml: z.string().min(1, 'manifest yaml cannot be empty'),
  git_sha: GitShaSchema.optional(),
  branch: z.string().optional(),
  validate_secrets: z.boolean().optional(),
  strict: z.boolean().optional(),
  local_cli_registry: z.string().optional(),
  local_cli_images: z.record(z.string()).optional(),
});

export type SyncManifestRequest = z.infer<typeof SyncManifestRequestSchema>;

export const ManifestResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  manifest_hash: z.string(),
  git_sha: z.string().nullable(),
  branch: z.string().nullable(),
  parsed_defaults: z.record(z.unknown()).nullable(),
  parsed_agents: z.record(z.unknown()).nullable().optional(),
  services: z.record(z.unknown()).nullable().optional(),
  environments: z.record(z.unknown()).nullable().optional(),
  secret_validation: SecretValidationResultSchema.optional(),
  warnings: z.array(z.string()).optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ManifestResponse = z.infer<typeof ManifestResponseSchema>;

export const ManifestValidateRequestSchema = z.object({
  manifest_yaml: z.string().optional(),
  validate_secrets: z.boolean().optional(),
  strict: z.boolean().optional(),
});

export type ManifestValidateRequest = z.infer<typeof ManifestValidateRequestSchema>;

export const ManifestValidateResponseSchema = z.object({
  valid: z.boolean(),
  manifest_hash: z.string().optional(),
  parsed_defaults: z.record(z.unknown()).nullable().optional(),
  parsed_agents: z.record(z.unknown()).nullable().optional(),
  secret_validation: SecretValidationResultSchema.optional(),
  warnings: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
});

export type ManifestValidateResponse = z.infer<typeof ManifestValidateResponseSchema>;

export const HealthcheckSchema = z.object({
  test: z.union([z.string(), z.array(z.string())]),
  interval: z.string().optional(),      // e.g., "5s"
  timeout: z.string().optional(),       // e.g., "3s"
  retries: z.number().optional(),       // default 3
  start_period: z.string().optional(),  // e.g., "10s"
});

export type Healthcheck = z.infer<typeof HealthcheckSchema>;

export const ApiSpecSchema = z.object({
  type: z.enum(['openapi', 'postgrest', 'graphql']).default('openapi'),
  spec_url: z.string().optional(),
  spec_path: z.string().optional(),
  on_deploy: z.boolean().default(true),
  auth: z.enum(['eve', 'none']).default('eve'),
  name: z.string().optional(),
});

export type ApiSpec = z.infer<typeof ApiSpecSchema>;

export const CliSpecSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, 'CLI name must be lowercase alphanumeric with hyphens'),
  bin: z.string().min(1),
  image: z.string().optional(),
  description: z.string().optional(),
});

export type CliSpec = z.infer<typeof CliSpecSchema>;

export function getDefaultSpecUrl(type: ApiSpec['type']): string {
  switch (type) {
    case 'openapi': return '/openapi.json';
    case 'postgrest': return '/';
    case 'graphql': return '/graphql';
  }
}

// v2 Service Model Schemas

export const ServiceDependencySchema = z.object({
  condition: z.enum(['service_started', 'service_healthy', 'started', 'healthy']).default('service_started'),
});

export type ServiceDependency = z.infer<typeof ServiceDependencySchema>;

export const ServiceFilesEntrySchema = z.object({
  source: z.string().min(1),  // Relative path in repo
  target: z.string().min(1),  // Absolute path in container
});

export type ServiceFilesEntry = z.infer<typeof ServiceFilesEntrySchema>;

export const ServiceStorageSchema = z.object({
  mount_path: z.string().min(1).optional(),
  size: z.string().optional(),
  access_mode: z.enum(['ReadWriteOnce', 'ReadWriteMany', 'ReadOnlyMany']).optional(),
  storage_class: z.string().optional(),
  name: z.string().optional(),
}).passthrough();

export type ServiceStorage = z.infer<typeof ServiceStorageSchema>;

export const ManagedDbBackupConfigSchema = z.object({
  schedule: z.union([z.string(), z.literal(false)]).optional(),  // cron expression or false to disable
  retention: z.string().regex(/^\s*\d+\s*d\s*$/, 'Retention must be in days, e.g. "30d"').optional(), // e.g., '30d', '90d'
  snapshot_on_delete: z.boolean().optional(),
  snapshot_on_reset: z.boolean().optional(),
});

export type ManagedDbBackupConfig = z.infer<typeof ManagedDbBackupConfigSchema>;

export const ManagedDbExtensionsSchema = z.array(z.string())
  .default([])
  .superRefine((extensions, ctx) => {
    const seen = new Set<string>();
    for (const [index, extension] of extensions.entries()) {
      if (seen.has(extension)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Duplicate managed DB extension "${extension}"`,
        });
      }
      seen.add(extension);
      const validationError = getManagedDbExtensionValidationError(extension);
      if (validationError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: validationError,
        });
      }
    }
  })
  .transform((extensions) => normalizeManagedDbExtensions(extensions));

export const ManagedDbConfigSchema = z.object({
  class: z.string().min(1),           // e.g., 'db.p1'
  engine: z.literal('postgres').default('postgres'),
  engine_version: z.string().optional(), // e.g., '16'
  backup: ManagedDbBackupConfigSchema.optional(),
  extensions: ManagedDbExtensionsSchema,
});

export type ManagedDbConfig = z.infer<typeof ManagedDbConfigSchema>;

export const IngressAliasPattern = /^[a-z][a-z0-9-]*[a-z0-9]$/;

export const CustomDomainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

export const IngressConfigSchema = z.object({
  public: z.boolean().optional(),
  port: z.number().optional(),
  alias: z.string().min(3).max(63).regex(IngressAliasPattern).optional(),
  domains: z.array(
    z.string()
      .min(4)
      .max(253)
      .regex(CustomDomainPattern)
      .transform((v) => v.toLowerCase())
  ).max(10).optional(),
  timeout: IngressDurationSchema.optional(),
  max_body_size: IngressByteSizeSchema.optional(),
}).passthrough();

export type IngressConfig = z.infer<typeof IngressConfigSchema>;

export const TcpIngressListenerSchema = z.object({
  name: z.string()
    .min(1)
    .max(63)
    .regex(/^[a-z]([a-z0-9-]*[a-z0-9])?$/, 'listener name must be lowercase alphanumeric with hyphens'),
  port: z.number().int().min(1).max(65535),
}).strict();

export type TcpIngressListener = z.infer<typeof TcpIngressListenerSchema>;

export const TcpIngressConfigSchema = z.object({
  listeners: z.array(TcpIngressListenerSchema).min(1).max(20),
  allow_cidrs: z.array(z.string().min(1)).optional(),
  hostname: z.string().min(3).max(63).regex(IngressAliasPattern).optional(),
}).strict();

export type TcpIngressConfig = z.infer<typeof TcpIngressConfigSchema>;

export const ObjectStoreBucketSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, 'Bucket name must be lowercase alphanumeric with hyphens'),
  visibility: z.enum(['private', 'public']).default('private'),
  cors: z.object({
    origins: z.array(z.string()).optional(),
    methods: z.array(z.string()).optional(),
    max_age_seconds: z.number().optional(),
  }).optional(),
}).passthrough();

export type ObjectStoreBucket = z.infer<typeof ObjectStoreBucketSchema>;

export const ObjectStoreIsolationSchema = z.enum(['auto', 'irsa', 'shared']);
export type ObjectStoreIsolation = z.infer<typeof ObjectStoreIsolationSchema>;

export const ObjectStoreConfigSchema = z.object({
  buckets: z.array(ObjectStoreBucketSchema).optional(),
  isolation: ObjectStoreIsolationSchema.optional(),
}).passthrough();

export type ObjectStoreConfig = z.infer<typeof ObjectStoreConfigSchema>;

/**
 * Per-service networking config. Today the only knob is `egress`:
 *   - 'nat'    (default): pod egress goes through the cluster NAT gateway.
 *   - 'stable': pod is scheduled on the public stable-egress node group with
 *     hostNetwork: true, so traffic exits through the node's own IGW path.
 *     See docs/plans/app-stable-egress-v2-plan.md.
 */
export const ServiceNetworkingSchema = z.object({
  egress: z.enum(['nat', 'stable']).default('nat'),
}).passthrough();

export type ServiceNetworking = z.infer<typeof ServiceNetworkingSchema>;

export const ServiceXeveSchema: z.ZodTypeAny = z.object({
  role: z.string().optional(),
  ingress: IngressConfigSchema.optional(),
  tcp_ingress: TcpIngressConfigSchema.optional(),
  api_spec: ApiSpecSchema.optional(),
  api_specs: z.array(ApiSpecSchema).optional(),
  cli: CliSpecSchema.optional(),
  external: z.boolean().optional(),
  connection_url: z.string().optional(),
  worker_type: z.string().optional(),
  files: z.array(ServiceFilesEntrySchema).optional(),
  storage: ServiceStorageSchema.optional(),
  managed: ManagedDbConfigSchema.optional(),
  object_store: ObjectStoreConfigSchema.optional(),
  networking: ServiceNetworkingSchema.optional(),
  audit_log_table: z.string().optional(),
  request_id_column: z.string().optional(),
  /** Additional permissions for the auto-injected service token (merged with read-only defaults). */
  permissions: z.array(z.string()).optional(),
}).passthrough();

export type ServiceXeve = z.infer<typeof ServiceXeveSchema>;

export const ServiceSchema = z.object({
  image: z.string().optional(),
  build: z.object({
    context: z.string(),
    dockerfile: z.string().optional(),
    args: z.record(z.string()).optional(),
  }).optional(),
  environment: z.record(z.string()).optional(),
  ports: z.array(z.union([z.string(), z.number()])).optional(),
  healthcheck: HealthcheckSchema.optional(),
  depends_on: z.record(ServiceDependencySchema).optional(),
  x_eve: ServiceXeveSchema.optional(),
  // Allow alternate key naming in YAML
  'x-eve': ServiceXeveSchema.optional(),
}).passthrough();

export type Service = z.infer<typeof ServiceSchema>;

export const ManifestDefaultsSchema = z
  .object({
    harness_preference: z.array(z.string()).optional(),
    git: ManifestGitDefaultsSchema.optional(),
    workspace: ManifestWorkspaceDefaultsSchema.optional(),
  })
  .passthrough();

export type ManifestDefaults = z.infer<typeof ManifestDefaultsSchema>;

const AppLinkNameSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[a-z]([a-z0-9-]*[a-z0-9])?$/, 'App link names must be lowercase alphanumeric with hyphens');

const AppLinkProjectRefSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^(proj_[a-zA-Z0-9]+|[A-Za-z][A-Za-z0-9-]*)$/, 'Project ref must be a project ID or project slug');

const AppLinkScopeSchema = z.string().min(1).max(200);
const AppLinkEventTypeSchema = z.string().min(1).max(200);
const AppLinkEnvNameSchema = z.string().min(1).max(100);

export const AppLinkApiGrantConsumerSchema = z.object({
  project: AppLinkProjectRefSchema,
  scopes: z.array(AppLinkScopeSchema).default([]),
  envs: z.array(AppLinkEnvNameSchema).default([]),
}).strict();

export type AppLinkApiGrantConsumer = z.infer<typeof AppLinkApiGrantConsumerSchema>;

export const AppLinkEventGrantConsumerSchema = z.object({
  project: AppLinkProjectRefSchema,
  types: z.array(AppLinkEventTypeSchema).optional(),
}).strict();

export type AppLinkEventGrantConsumer = z.infer<typeof AppLinkEventGrantConsumerSchema>;

export const AppLinkApiExportSchema = z.object({
  service: z.string().min(1).max(100),
  cli: z.string().min(1).max(100).optional(),
  scopes: z.array(AppLinkScopeSchema).default([]),
  consumers: z.array(AppLinkApiGrantConsumerSchema).default([]),
}).strict();

export type AppLinkApiExport = z.infer<typeof AppLinkApiExportSchema>;

export const AppLinkEventExportSchema = z.object({
  types: z.array(AppLinkEventTypeSchema).default([]),
  consumers: z.array(AppLinkEventGrantConsumerSchema).default([]),
}).strict();

export type AppLinkEventExport = z.infer<typeof AppLinkEventExportSchema>;

export const AppLinksExportsSchema = z.object({
  apis: z.record(AppLinkNameSchema, AppLinkApiExportSchema).default({}),
  events: z.record(AppLinkNameSchema, AppLinkEventExportSchema).default({}),
}).strict();

export type AppLinksExports = z.infer<typeof AppLinksExportsSchema>;

export const AppLinkConsumeEventsSchema = z.object({
  feed: AppLinkNameSchema,
  types: z.array(AppLinkEventTypeSchema).default([]),
}).strict();

export type AppLinkConsumeEvents = z.infer<typeof AppLinkConsumeEventsSchema>;

export const AppLinkInjectIntoSchema = z.object({
  services: z.array(z.string().min(1).max(100)).default([]),
  jobs: z.boolean().default(false),
}).strict();

export type AppLinkInjectInto = z.infer<typeof AppLinkInjectIntoSchema>;

export const AppLinkConsumeSchema = z.object({
  project: AppLinkProjectRefSchema,
  api: AppLinkNameSchema.optional(),
  environment: z.string().min(1).max(100).default('same'),
  scopes: z.array(AppLinkScopeSchema).default([]),
  events: AppLinkConsumeEventsSchema.optional(),
  inject_into: AppLinkInjectIntoSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.api && !value.events) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A consumed app link must reference api or events',
      path: ['api'],
    });
  }
});

export type AppLinkConsume = z.infer<typeof AppLinkConsumeSchema>;

export const AppLinksConsumesSchema = z.record(AppLinkNameSchema, AppLinkConsumeSchema);

export type AppLinksConsumes = z.infer<typeof AppLinksConsumesSchema>;

export const AppLinksSchema = z.object({
  exports: AppLinksExportsSchema.optional(),
  consumes: AppLinksConsumesSchema.optional(),
}).strict();

export type AppLinks = z.infer<typeof AppLinksSchema>;

export const ManifestRequiresSchema = z.object({
  secrets: z.array(z.string()).optional(),
}).passthrough();

export const ManifestSkillModeSchema = z.object({
  pack_set: z.enum(['runtime']).optional(),
  packs: z.union([z.literal('runtime'), z.array(PackEntrySchema)]).optional(),
  include_skills_txt: z.boolean().optional(),
  extra_packs: z.array(PackEntrySchema).optional(),
  install_agents: z.array(z.string()).optional(),
}).passthrough();

export type ManifestSkillMode = z.infer<typeof ManifestSkillModeSchema>;

const noHeaderNewlines = (value: string) => !/[\r\n]/.test(value);

export const ProjectBrandingSchema = z.object({
  app_name: z.string().trim().min(1).max(60).refine(noHeaderNewlines, 'must not contain newline characters'),
  app_logo_url: z.string().trim().url().optional(),
  primary_color: z.string().trim().regex(/^#[0-9a-f]{6}$/i).optional(),
  email_from_name: z.string().trim().max(60).refine(noHeaderNewlines, 'must not contain newline characters').optional(),
  reply_to_email: z.string().trim().email().optional(),
  support_email: z.string().trim().email().optional(),
  support_url: z.string().trim().url().optional(),
}).strict();

export type ProjectBranding = z.infer<typeof ProjectBrandingSchema>;

export const AppInvitePolicySchema = z.object({
  enabled: z.boolean().default(false),
  admin_roles: z.array(z.enum(['admin', 'owner'])).default(['admin', 'owner']),
  invited_role: z.literal('member').default('member'),
}).strict().default({});

export type AppInvitePolicy = z.infer<typeof AppInvitePolicySchema>;

const EMAIL_DOMAIN_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Email domain entry for `domain_signup.domains`. Lowercased, IDN-normalized
 * to ASCII (punycode), and validated against a permissive hostname grammar.
 * Wildcard support: a leading `*.` matches any number of subdomain labels
 * (so `*.acme.com` matches `eu.acme.com` and `sub.eu.acme.com`, but NOT the
 * bare `acme.com` — declare both if both should match).
 */
export const EmailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value, ctx) => {
    const wildcard = value.startsWith('*.');
    const host = wildcard ? value.slice(2) : value;
    const normalized = domainToASCII(host);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid domain: ${value}` });
      return z.NEVER;
    }
    const final = wildcard ? `*.${normalized}` : normalized;
    if (!EMAIL_DOMAIN_RE.test(final)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid email domain: ${value}` });
      return z.NEVER;
    }
    return final;
  });

/**
 * One pre-approved email-domain rule. Maps a domain pattern to a single
 * target org. Multiple rules can appear in `domain_signup.domains`; the
 * lookup is **first-match in declaration order** (no implicit longest-match),
 * so declare more-specific entries (apex, narrow subdomains) before broader
 * wildcards if the order matters.
 */
export const AppDomainSignupRuleSchema = z
  .object({
    /** Email-domain pattern. Lowercased, IDN-normalized, optional leading `*.`. */
    domain: EmailDomainSchema,
    /** Org ID or slug for first-login auto-attach. Manifest sync resolves to canonical org_id. */
    target_org: z.string().trim().min(1),
    /** Forward-compat hook. v2 only accepts 'member'. */
    role: z.literal('member').default('member'),
  })
  .strict();

export type AppDomainSignupRule = z.infer<typeof AppDomainSignupRuleSchema>;

/**
 * Pre-approved email-domain auto-signup config (v2). When enabled, anyone
 * whose email matches one of `domains[].domain` can request a magic-link
 * login on the app even without a prior invite; first successful login
 * auto-attaches them to the matching rule's `target_org` as `role`.
 *
 * v2 breaking change (2026-05-12): `domains` is now a list of rule objects.
 * The v1 list-of-strings + block-level `target_org` shape is no longer
 * accepted — sync rejects on first sight.
 */
export const AppDomainSignupConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    domains: z.array(AppDomainSignupRuleSchema).default([]),
  })
  .strict()
  .default({})
  .superRefine((value, ctx) => {
    if (value.enabled && value.domains.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['domains'],
        message: 'domain_signup.enabled requires at least one domain',
      });
    }
    // Reject duplicate domain patterns within one block — ambiguous routing.
    const seen = new Map<string, number>();
    for (let i = 0; i < value.domains.length; i++) {
      const d = value.domains[i].domain;
      const prev = seen.get(d);
      if (prev !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['domains', i, 'domain'],
          message: `Duplicate domain_signup entry for "${d}" (also at index ${prev})`,
        });
      } else {
        seen.set(d, i);
      }
    }
  });

export type AppDomainSignupConfig = z.infer<typeof AppDomainSignupConfigSchema>;

export const AppOrgAccessConfigSchema = z.object({
  mode: z.enum(['project_org', 'allowlist']).default('project_org'),
  allowed_orgs: z.array(z.string().trim().min(1)).default([]),
  invite: AppInvitePolicySchema,
  domain_signup: AppDomainSignupConfigSchema,
}).strict().default({});

export type AppOrgAccessConfig = z.infer<typeof AppOrgAccessConfigSchema>;

/**
 * Free-email providers (consumer mail). Declaring these in `domain_signup`
 * is almost always an authoring mistake — it lets anyone in the world
 * onboard into `target_org`. We emit a coherence warning, not a hard reject,
 * so operators can still do it deliberately (e.g. a public-test sandbox).
 */
export const FREE_EMAIL_PROVIDERS = new Set<string>([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'protonmail.com',
  'proton.me',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'fastmail.com',
  'fastmail.fm',
  'zoho.com',
  'gmx.com',
  'yandex.com',
  'mail.com',
]);

export function isFreeEmailDomain(domain: string): boolean {
  const lower = domain.trim().toLowerCase();
  const bare = lower.startsWith('*.') ? lower.slice(2) : lower;
  return FREE_EMAIL_PROVIDERS.has(bare);
}

const LOCAL_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Returns true if the URL is allowed to use http:// — local hostnames only
 * (localhost, loopback IPs, *.lvh.me). All other origins must be https://.
 */
export function isLocalHttpOrigin(parsed: URL): boolean {
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (LOCAL_HTTP_HOSTNAMES.has(host)) return true;
  if (host === 'lvh.me' || host.endsWith('.lvh.me')) return true;
  return false;
}

/**
 * Redirect target origin (scheme://host[:port]). Accepts https:// for any
 * hostname; permits http:// only for local hostnames (localhost, loopback,
 * *.lvh.me). Rejects paths, query strings, fragments, and userinfo. Stored
 * value is normalized through `new URL(value).origin`.
 */
export const RedirectOriginSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid URL: ${value}`,
      });
      return z.NEVER;
    }
    if (parsed.protocol !== 'https:' && !isLocalHttpOrigin(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Redirect origin must use https:// (got ${value}). http:// is only allowed for localhost and *.lvh.me.`,
      });
      return z.NEVER;
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Redirect origin must not contain userinfo: ${value}`,
      });
      return z.NEVER;
    }
    // Reject anything beyond scheme://host[:port]. Paths "/" alone get
    // normalized away by URL.origin, but explicit non-root paths, queries,
    // or fragments are an authoring mistake worth flagging clearly.
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Redirect origin must be just scheme://host[:port], not a full URL: ${value}`,
      });
      return z.NEVER;
    }
    return parsed.origin;
  });

export const ProjectAuthConfigSchema = z.object({
  login_method: z.enum([
    'password_or_magic_link',
    'password',
    'magic_link',
  ]).default('password_or_magic_link'),
  self_signup: z.boolean().default(false),
  invite_requires_password: z.boolean().default(true),
  org_access: AppOrgAccessConfigSchema,
  /**
   * Explicit allowlist of redirect target origins for post-auth navigation.
   * The SSO broker consults this list (plus auto-derived custom domains) when
   * validating `redirect_to` after callback / invite redemption. Entries are
   * origin-only — paths are caller-controlled.
   */
  allowed_redirect_origins: z.array(RedirectOriginSchema).default([]).transform((origins) => {
    // Order-independent set semantics; dedupe while preserving first-seen order.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const origin of origins) {
      if (!seen.has(origin)) {
        seen.add(origin);
        out.push(origin);
      }
    }
    return out;
  }),
}).strict().superRefine((value, ctx) => {
  // Domain signup needs a magic-link send path. Password-only projects
  // have no way to deliver the link, so reject the combination at validate time.
  if (value.org_access.domain_signup.enabled && value.login_method === 'password') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['org_access', 'domain_signup', 'enabled'],
      message: 'domain_signup cannot be enabled with login_method: password (requires magic_link or password_or_magic_link)',
    });
  }
});

export type ProjectAuthConfig = z.infer<typeof ProjectAuthConfigSchema>;

export const ManifestXeveSchema = z.object({
  defaults: ManifestDefaultsSchema.optional(),
  requires: ManifestRequiresSchema.optional(),
  branding: ProjectBrandingSchema.optional(),
  auth: ProjectAuthConfigSchema.optional(),
  agents: z.record(z.unknown()).optional(),
  install_agents: z.array(z.string()).optional(),
  packs: z.array(PackEntrySchema).optional(),
  skill_modes: z.record(ManifestSkillModeSchema).optional(),
  app_links: AppLinksSchema.optional(),
}).passthrough();

export type ManifestXeve = z.infer<typeof ManifestXeveSchema>;

export const EnvironmentSchema = z.object({
  pipeline: z.string().optional(),
  approval: z.string().optional(),
  overrides: z.record(z.unknown()).optional(),
  workers: z.array(z.record(z.unknown())).optional(),
  pipeline_inputs: z.record(z.unknown()).optional(),
}).passthrough();

export type Environment = z.infer<typeof EnvironmentSchema>;

// Full manifest schema for validation
export const ManifestSchema = z.object({
  schema: z.string().optional(),
  name: z.string().optional(),
  project: z.string().optional(),
  registry: z.union([z.literal('eve'), z.literal('none'), z.record(z.unknown())]).optional(),
  services: z.record(ServiceSchema).optional(),
  environments: z.record(EnvironmentSchema).optional(),
  pipelines: z.record(PipelineDefinitionSchema).optional(),
  workflows: z.record(WorkflowDefinitionSchema).optional(),
  versioning: z.record(z.unknown()).optional(),
  x_eve: ManifestXeveSchema.optional(),
  // Allow alternate key naming in YAML
  'x-eve': ManifestXeveSchema.optional(),
}).passthrough();  // Allow unknown fields for forward compatibility

export type Manifest = z.infer<typeof ManifestSchema>;

function getXeveDefaults(manifest: Manifest): Record<string, unknown> | null {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && 'defaults' in xEve) {
    return (xEve as ManifestXeve).defaults ?? null;
  }
  return null;
}

function getXeveAgents(manifest: Manifest): Record<string, unknown> | null {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && 'agents' in xEve) {
    return (xEve as ManifestXeve).agents ?? null;
  }
  return null;
}

function getXeveBranding(manifest: Manifest): ProjectBranding | null {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && 'branding' in xEve) {
    return (xEve as ManifestXeve).branding ?? null;
  }
  return null;
}

function getXeveAuthConfig(manifest: Manifest): ProjectAuthConfig | null {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && 'auth' in xEve) {
    return (xEve as ManifestXeve).auth ?? null;
  }
  return null;
}

function getXeveAppLinks(manifest: Manifest): AppLinks | null {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && 'app_links' in xEve) {
    return (xEve as ManifestXeve).app_links ?? null;
  }
  return null;
}

export function getManifestDefaults(manifest: Manifest): Record<string, unknown> | null {
  return getXeveDefaults(manifest);
}

export function getManifestAgents(manifest: Manifest): Record<string, unknown> | null {
  return getXeveAgents(manifest);
}

export function getManifestBranding(manifest: Manifest): ProjectBranding | null {
  return getXeveBranding(manifest);
}

export function getManifestAuthConfig(manifest: Manifest): ProjectAuthConfig | null {
  return getXeveAuthConfig(manifest);
}

export function getManifestAppLinks(manifest: Manifest): AppLinks | null {
  return getXeveAppLinks(manifest);
}

export function getServicesFromManifest(manifest: Manifest): Record<string, Service> | null {
  return manifest.services ?? null;
}

const INGRESS_DUPLICATES_KEY = '__duplicates';

export const RESERVED_ALIASES = new Set([
  'api',
  'eve',
  'www',
  'status',
  'admin',
  'health',
  'sso',
  'registry',
]);

type IngressAliasMapWithMeta = Map<string, string> & {
  [INGRESS_DUPLICATES_KEY]?: string[];
};

/**
 * Extract alias -> serviceName mappings from service x-eve ingress config.
 * Duplicate aliases are tracked for downstream validation.
 */
export function getManifestIngressAliases(manifest: Manifest): Map<string, string> {
  const aliases = new Map<string, string>();
  const duplicateAliases = new Set<string>();
  const services = manifest.services ?? {};

  for (const [serviceName, service] of Object.entries(services)) {
    const xEve = service['x-eve'] ?? service.x_eve;
    const ingress = xEve?.ingress;
    if (!ingress || typeof ingress !== 'object') {
      continue;
    }

    const parsed = IngressConfigSchema.safeParse(ingress);
    if (!parsed.success) {
      continue;
    }

    const alias = parsed.data.alias?.trim().toLowerCase();
    if (!alias) {
      continue;
    }

    const existing = aliases.get(alias);
    if (existing && existing !== serviceName) {
      duplicateAliases.add(alias);
      continue;
    }

    aliases.set(alias, serviceName);
  }

  if (duplicateAliases.size > 0) {
    (aliases as IngressAliasMapWithMeta)[INGRESS_DUPLICATES_KEY] = Array.from(duplicateAliases.values());
  }

  return aliases;
}

/**
 * Extract TCP hostname alias -> serviceName mappings from service x-eve
 * tcp_ingress config. Duplicate aliases are tracked for downstream validation.
 */
export function getManifestTcpIngressAliases(manifest: Manifest): Map<string, string> {
  const aliases = new Map<string, string>();
  const duplicateAliases = new Set<string>();
  const services = manifest.services ?? {};

  for (const [serviceName, service] of Object.entries(services)) {
    const xEve = service['x-eve'] ?? service.x_eve;
    const tcpIngress = xEve?.tcp_ingress;
    if (!tcpIngress || typeof tcpIngress !== 'object') {
      continue;
    }

    const parsed = TcpIngressConfigSchema.safeParse(tcpIngress);
    if (!parsed.success) {
      continue;
    }

    const alias = parsed.data.hostname?.trim().toLowerCase();
    if (!alias) {
      continue;
    }

    const existing = aliases.get(alias);
    if (existing && existing !== serviceName) {
      duplicateAliases.add(alias);
      continue;
    }

    aliases.set(alias, serviceName);
  }

  if (duplicateAliases.size > 0) {
    (aliases as IngressAliasMapWithMeta)[INGRESS_DUPLICATES_KEY] = Array.from(duplicateAliases.values());
  }

  return aliases;
}

/**
 * Ensure aliases within one manifest are unique across services.
 */
export function assertUniqueManifestIngressAliases(aliases: Map<string, string>): void {
  const duplicates = (aliases as IngressAliasMapWithMeta)[INGRESS_DUPLICATES_KEY] ?? [];
  if (duplicates.length > 0) {
    throw new Error(`Duplicate ingress alias values in manifest: ${duplicates.join(', ')}`);
  }
}

const CUSTOM_DOMAIN_DUPLICATES_KEY = '__cd_duplicates';

type CustomDomainMapWithMeta = Map<string, string> & {
  [CUSTOM_DOMAIN_DUPLICATES_KEY]?: string[];
};

type CustomDomainDeclarationsWithMeta = ManifestCustomDomainDeclaration[] & {
  [CUSTOM_DOMAIN_DUPLICATES_KEY]?: string[];
};

export type ManifestCustomDomainScope = 'project' | 'environment';

export interface ManifestCustomDomainDeclaration {
  hostname: string;
  service_name: string;
  scope: ManifestCustomDomainScope;
  env_name: string | null;
  origin_path: string;
}

export interface ManifestCustomDomainDesiredState {
  hostname: string;
  service_name: string;
  env_names: string[];
  has_project_scope: boolean;
  origin_paths: string[];
}

function getIngressDomainsFromService(service: unknown): string[] {
  if (!service || typeof service !== 'object') {
    return [];
  }

  const candidate = service as {
    x_eve?: { ingress?: unknown };
    'x-eve'?: { ingress?: unknown };
  };
  const xEve = candidate['x-eve'] ?? candidate.x_eve;
  const ingress = xEve?.ingress;
  if (!ingress || typeof ingress !== 'object') {
    return [];
  }

  const parsed = IngressConfigSchema.safeParse(ingress);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.domains ?? [];
}

function getEnvironmentOverrideServices(envConfig: Environment): Record<string, unknown> {
  const overrides = envConfig.overrides;
  if (!overrides || typeof overrides !== 'object') {
    return {};
  }
  const services = (overrides as Record<string, unknown>).services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    return {};
  }
  return services as Record<string, unknown>;
}

/**
 * Extract custom domain declarations from top-level services and environment
 * service overrides. Duplicate hostnames across different services are tracked
 * for downstream validation.
 */
export function getManifestCustomDomainDeclarations(manifest: Manifest): ManifestCustomDomainDeclaration[] {
  const declarations = [] as CustomDomainDeclarationsWithMeta;
  const servicesByHostname = new Map<string, string>();
  const duplicateDomains = new Set<string>();

  const addDeclaration = (declaration: ManifestCustomDomainDeclaration) => {
    const existingService = servicesByHostname.get(declaration.hostname);
    if (existingService && existingService !== declaration.service_name) {
      duplicateDomains.add(declaration.hostname);
    } else {
      servicesByHostname.set(declaration.hostname, declaration.service_name);
    }
    declarations.push(declaration);
  };

  const services = manifest.services ?? {};

  for (const [serviceName, service] of Object.entries(services)) {
    for (const hostname of getIngressDomainsFromService(service)) {
      const normalized = hostname.trim().toLowerCase();
      addDeclaration({
        hostname: normalized,
        service_name: serviceName,
        scope: 'project',
        env_name: null,
        origin_path: `services.${serviceName}.x-eve.ingress.domains`,
      });
    }
  }

  for (const [envName, envConfig] of Object.entries(manifest.environments ?? {})) {
    const overrideServices = getEnvironmentOverrideServices(envConfig);
    for (const [serviceName, service] of Object.entries(overrideServices)) {
      for (const hostname of getIngressDomainsFromService(service)) {
        const normalized = hostname.trim().toLowerCase();
        addDeclaration({
          hostname: normalized,
          service_name: serviceName,
          scope: 'environment',
          env_name: envName,
          origin_path: `environments.${envName}.overrides.services.${serviceName}.x-eve.ingress.domains`,
        });
      }
    }
  }

  if (duplicateDomains.size > 0) {
    declarations[CUSTOM_DOMAIN_DUPLICATES_KEY] = Array.from(duplicateDomains.values());
  }

  return declarations;
}

/**
 * Extract hostname -> serviceName mappings from service x-eve ingress config.
 * Duplicate hostnames are tracked for downstream validation.
 */
export function getManifestCustomDomains(manifest: Manifest): Map<string, string> {
  const declarations = getManifestCustomDomainDeclarations(manifest) as CustomDomainDeclarationsWithMeta;
  const domains = new Map<string, string>() as CustomDomainMapWithMeta;

  for (const declaration of declarations) {
    if (!domains.has(declaration.hostname)) {
      domains.set(declaration.hostname, declaration.service_name);
    }
  }

  const duplicates = declarations[CUSTOM_DOMAIN_DUPLICATES_KEY];
  if (duplicates && duplicates.length > 0) {
    domains[CUSTOM_DOMAIN_DUPLICATES_KEY] = duplicates;
  }
  return domains;
}

export function getManifestCustomDomainDesiredState(manifest: Manifest): Map<string, ManifestCustomDomainDesiredState> {
  const desired = new Map<string, ManifestCustomDomainDesiredState>();
  for (const declaration of getManifestCustomDomainDeclarations(manifest)) {
    const existing = desired.get(declaration.hostname);
    if (!existing) {
      desired.set(declaration.hostname, {
        hostname: declaration.hostname,
        service_name: declaration.service_name,
        env_names: declaration.env_name ? [declaration.env_name] : [],
        has_project_scope: declaration.scope === 'project',
        origin_paths: [declaration.origin_path],
      });
      continue;
    }

    if (declaration.env_name && !existing.env_names.includes(declaration.env_name)) {
      existing.env_names.push(declaration.env_name);
    }
    if (declaration.scope === 'project') {
      existing.has_project_scope = true;
    }
    if (!existing.origin_paths.includes(declaration.origin_path)) {
      existing.origin_paths.push(declaration.origin_path);
    }
  }
  return desired;
}

/**
 * Ensure custom domain hostnames within one manifest are unique across services.
 */
export function assertUniqueManifestCustomDomains(domains: Map<string, string>): void {
  const duplicates = (domains as CustomDomainMapWithMeta)[CUSTOM_DOMAIN_DUPLICATES_KEY] ?? [];
  if (duplicates.length > 0) {
    throw new Error(`Duplicate custom domain hostnames in manifest: ${duplicates.join(', ')}`);
  }
}

export function assertUniqueManifestCustomDomainDeclarations(declarations: ManifestCustomDomainDeclaration[]): void {
  const duplicates = (declarations as CustomDomainDeclarationsWithMeta)[CUSTOM_DOMAIN_DUPLICATES_KEY] ?? [];
  if (duplicates.length > 0) {
    throw new Error(`Duplicate custom domain hostnames in manifest: ${duplicates.join(', ')}`);
  }
}

/**
 * Check if a hostname conflicts with the platform domain (should use alias instead).
 */
export function isPlatformDomainHostname(hostname: string, platformDomain: string): boolean {
  if (!platformDomain) return false;
  const normalized = hostname.trim().toLowerCase();
  const pd = platformDomain.trim().toLowerCase();
  return normalized.endsWith(`.${pd}`) || normalized === pd;
}

export function isReservedAlias(alias: string): boolean {
  return RESERVED_ALIASES.has(alias.trim().toLowerCase());
}

export function getManifestRequiredSecrets(manifest: Manifest): string[] {
  const required = new Set<string>();
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  const manifestRequires = xEve && typeof xEve === 'object' && 'requires' in xEve
    ? (xEve as ManifestXeve).requires
    : undefined;

  for (const key of manifestRequires?.secrets ?? []) {
    if (typeof key === 'string' && key.length > 0) {
      required.add(key);
    }
  }

  const collectEnvOverrideSecrets = (envOverrides?: Record<string, string>) => {
    if (!envOverrides) return;
    const secretRefPattern = /\$\{secret\.([A-Z_][A-Z0-9_]*)\}/g;
    for (const value of Object.values(envOverrides)) {
      secretRefPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = secretRefPattern.exec(value)) !== null) {
        required.add(match[1]);
      }
    }
  };

  const collectPipelineSecrets = (pipelines?: Record<string, {
    env_overrides?: Record<string, string>;
    steps?: Array<{ requires?: { secrets?: string[] }; env_overrides?: Record<string, string> }>;
  }>) => {
    if (!pipelines) return;
    for (const pipeline of Object.values(pipelines)) {
      collectEnvOverrideSecrets(pipeline.env_overrides);
      for (const step of pipeline.steps ?? []) {
        for (const key of step.requires?.secrets ?? []) {
          if (typeof key === 'string' && key.length > 0) {
            required.add(key);
          }
        }
        collectEnvOverrideSecrets(step.env_overrides);
      }
    }
  };

  collectPipelineSecrets(manifest.pipelines);
  collectPipelineSecrets(manifest.workflows);

  return Array.from(required.values());
}

/**
 * Returns services that need container image builds.
 * A service is buildable if it has both `build` config and `image` field,
 * and is not marked as external via x-eve.
 */
export function getBuildableServices(manifest: Manifest): Record<string, Service> {
  const services = manifest.services ?? {};
  const result: Record<string, Service> = {};
  for (const [name, service] of Object.entries(services)) {
    if (!service.build || !service.image) continue;
    const xEve = service['x-eve'] ?? service.x_eve;
    if (xEve?.external) continue;
    result[name] = service;
  }
  return result;
}

/**
 * Returns services with `build` config but no `image` field.
 */
export function getServicesWithBuildButNoImage(manifest: Manifest): Record<string, Service> {
  const services = manifest.services ?? {};
  const result: Record<string, Service> = {};
  for (const [name, service] of Object.entries(services)) {
    if (!service.build || service.image) continue;
    const xEve = service['x-eve'] ?? service.x_eve;
    if (xEve?.external) continue;
    result[name] = service;
  }
  return result;
}

/**
 * Returns true if the manifest has a registry that can receive images.
 */
export function hasUsableRegistry(manifest: Manifest): boolean {
  if (isEveRegistry(manifest)) return true;
  if (isRegistryNone(manifest)) return false;
  return getRegistryConfig(manifest)?.host != null;
}

/**
 * Superset of getBuildableServices that auto-derives image names.
 * Services with `build` but no `image` get `image: <serviceName>`
 * when a usable registry is configured.
 */
export function getBuildableServicesWithDefaults(manifest: Manifest): Record<string, Service> {
  const explicit = getBuildableServices(manifest);
  if (!hasUsableRegistry(manifest)) return explicit;

  const missing = getServicesWithBuildButNoImage(manifest);
  const result = { ...explicit };
  for (const [name, service] of Object.entries(missing)) {
    result[name] = { ...service, image: name };
  }
  return result;
}

export interface ManifestCoherenceWarning {
  code: string;
  message: string;
  severity: 'warning' | 'error';
}

// Valid trigger type keys (top-level keys within a trigger definition)
const VALID_TRIGGER_TYPES = ['github', 'slack', 'system', 'cron', 'app', 'app_link', 'event', 'manual'] as const;

// GitHub event types that the trigger matcher recognizes
const VALID_GITHUB_EVENTS = ['push', 'pull_request'] as const;

// System event types that the platform actually emits (without the "system." prefix).
// This list is advisory — custom system events may exist, so unknown values produce
// warnings, not errors.
const KNOWN_SYSTEM_EVENTS = [
  'job.failed',
  'job.attempt.completed',
  'pipeline.failed',
  'doc.ingest',
  'doc.created',
  'doc.updated',
  'doc.deleted',
  'thread.distilled',
  'resource.hydration.started',
  'resource.hydration.completed',
  'resource.hydration.failed',
] as const;

/**
 * Analyze manifest for structural issues that would cause runtime failures.
 */
export function analyzeManifestCoherence(manifest: Manifest): ManifestCoherenceWarning[] {
  const warnings: ManifestCoherenceWarning[] = [];

  // 1. Services with build but no image and no usable registry
  const orphans = getServicesWithBuildButNoImage(manifest);
  if (Object.keys(orphans).length > 0 && !hasUsableRegistry(manifest)) {
    for (const name of Object.keys(orphans)) {
      warnings.push({
        code: 'build_no_image',
        message: `Service "${name}" has \`build\` config but no \`image\` field and no registry configured. Add an \`image\` field or configure a \`registry\`.`,
        severity: 'error',
      });
    }
  }

  // 2. Pipeline has deploy step with no upstream build/release
  const allPipelines = { ...(manifest.pipelines ?? {}), ...(manifest.workflows ?? {}) };
  for (const [pipelineName, pipeline] of Object.entries(allPipelines)) {
    if (!pipeline || typeof pipeline !== 'object') continue;
    const steps = (pipeline as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) continue;

    const stepTypes = new Set<string>();
    for (const step of steps) {
      if (step && typeof step === 'object' && 'action' in step) {
        const action = (step as Record<string, unknown>).action;
        if (action && typeof action === 'object' && 'type' in action) {
          stepTypes.add((action as Record<string, string>).type);
        }
      }
    }

    if (stepTypes.has('deploy') && !stepTypes.has('build') && !stepTypes.has('release')) {
      const buildableCount = Object.keys(getBuildableServicesWithDefaults(manifest)).length;
      if (buildableCount > 0) {
        warnings.push({
          code: 'deploy_without_build',
          message: `Pipeline "${pipelineName}" has a deploy step but no build or release steps. ${buildableCount} service(s) have build config. Add build and release steps, or use --direct for pre-built images.`,
          severity: 'warning',
        });
      }
    }
  }

  // 3. Environment references nonexistent pipeline
  const pipelineNames = new Set(Object.keys(manifest.pipelines ?? {}));
  for (const [envName, envConfig] of Object.entries(manifest.environments ?? {})) {
    if (envConfig && typeof envConfig === 'object' && 'pipeline' in envConfig) {
      const pipelineName = (envConfig as Record<string, unknown>).pipeline as string | undefined;
      if (pipelineName && !pipelineNames.has(pipelineName)) {
        warnings.push({
          code: 'missing_pipeline',
          message: `Environment "${envName}" references pipeline "${pipelineName}" which is not defined in the manifest.`,
          severity: 'error',
        });
      }
    }
  }

  // 4. Workflow dependency graph validation
  const allWorkflowsAndPipelines = { ...(manifest.pipelines ?? {}), ...(manifest.workflows ?? {}) };
  for (const [name, def] of Object.entries(allWorkflowsAndPipelines)) {
    if (!def || typeof def !== 'object') continue;
    const steps = (def as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) continue;

    // 4a. Duplicate step names
    const stepNames = new Set<string>();
    for (const [i, step] of (steps as Array<Record<string, unknown>>).entries()) {
      const stepName = (step.name as string) || `step-${i + 1}`;
      if (stepNames.has(stepName)) {
        warnings.push({
          code: 'workflow_duplicate_step',
          message: `Workflow "${name}" has duplicate step name "${stepName}".`,
          severity: 'error',
        });
      }
      stepNames.add(stepName);
    }

    // 4b. Invalid depends_on references
    for (const [i, step] of (steps as Array<Record<string, unknown>>).entries()) {
      const stepName = (step.name as string) || `step-${i + 1}`;
      const deps = step.depends_on as string[] | undefined;
      if (!Array.isArray(deps)) continue;
      for (const dep of deps) {
        if (!stepNames.has(dep)) {
          warnings.push({
            code: 'workflow_invalid_dep',
            message: `Workflow "${name}" step "${stepName}" depends on nonexistent step "${dep}".`,
            severity: 'error',
          });
        }
      }
    }

    // 4c. Cycle detection
    const depMap = new Map<string, string[]>();
    const allStepNames: string[] = [];
    for (const [i, step] of (steps as Array<Record<string, unknown>>).entries()) {
      const stepName = (step.name as string) || `step-${i + 1}`;
      allStepNames.push(stepName);
      const deps = step.depends_on as string[] | undefined;
      depMap.set(stepName, Array.isArray(deps) ? deps : []);
    }

    const cycle = detectManifestCycle(allStepNames, depMap);
    if (cycle) {
      warnings.push({
        code: 'workflow_cycle',
        message: `Workflow "${name}" has a dependency cycle: ${cycle.join(' -> ')}.`,
        severity: 'error',
      });
    }

    // 4d. Condition validation
    for (const [i, step] of (steps as Array<Record<string, unknown>>).entries()) {
      const stepName = (step.name as string) || `step-${i + 1}`;
      const condition = step.condition;
      if (typeof condition !== 'string') continue;

      // Validate condition format: step_name.status == 'value' or step_name.status != 'value'
      const condMatch = condition.match(
        /^(\w[\w-]*)\s*\.\s*status\s*(==|!=)\s*['"]([^'"]*)['"]\s*$/,
      );
      if (!condMatch) {
        warnings.push({
          code: 'workflow_invalid_condition',
          message: `Workflow "${name}" step "${stepName}" has invalid condition "${condition}". Expected format: step_name.status == 'value' or step_name.status != 'value'.`,
          severity: 'error',
        });
        continue;
      }

      const refStepName = condMatch[1];

      // Referenced step must exist
      if (!stepNames.has(refStepName)) {
        warnings.push({
          code: 'workflow_condition_unknown_step',
          message: `Workflow "${name}" step "${stepName}" condition references nonexistent step "${refStepName}".`,
          severity: 'error',
        });
        continue;
      }

      // Referenced step must be in depends_on
      const deps = step.depends_on as string[] | undefined;
      if (!Array.isArray(deps) || !deps.includes(refStepName)) {
        warnings.push({
          code: 'workflow_condition_not_dependency',
          message: `Workflow "${name}" step "${stepName}" condition references step "${refStepName}" which is not in its depends_on list. The condition step must be a dependency.`,
          severity: 'error',
        });
      }
    }
  }

  // 5. Trigger definition validation
  for (const [name, def] of Object.entries(allPipelines)) {
    if (!def || typeof def !== 'object') continue;
    const trigger = (def as Record<string, unknown>).trigger;
    if (!trigger || typeof trigger !== 'object') continue;

    const triggerObj = trigger as Record<string, unknown>;
    const triggerKeys = Object.keys(triggerObj);

    // 5a. Trigger has at least one recognized trigger type
    const recognizedKeys = triggerKeys.filter(k =>
      (VALID_TRIGGER_TYPES as readonly string[]).includes(k),
    );
    if (recognizedKeys.length === 0) {
      warnings.push({
        code: 'trigger_no_recognized_type',
        message: `Pipeline/workflow "${name}" trigger has no recognized type. Valid types: ${VALID_TRIGGER_TYPES.join(', ')}.`,
        severity: 'warning',
      });
    }

    // 5b. GitHub trigger event type validation
    if (triggerObj.github && typeof triggerObj.github === 'object') {
      const githubEvent = (triggerObj.github as Record<string, unknown>).event;
      if (typeof githubEvent === 'string' && !(VALID_GITHUB_EVENTS as readonly string[]).includes(githubEvent)) {
        warnings.push({
          code: 'trigger_invalid_github_event',
          message: `Pipeline/workflow "${name}" has unknown GitHub event "${githubEvent}". Valid events: ${VALID_GITHUB_EVENTS.join(', ')}.`,
          severity: 'warning',
        });
      }
    }

    // 5c. System trigger event type validation
    if (triggerObj.system && typeof triggerObj.system === 'object') {
      const systemEvent = (triggerObj.system as Record<string, unknown>).event;
      if (typeof systemEvent === 'string' && !(KNOWN_SYSTEM_EVENTS as readonly string[]).includes(systemEvent)) {
        warnings.push({
          code: 'trigger_unknown_system_event',
          message: `Pipeline/workflow "${name}" has unknown system event "${systemEvent}". Known events: ${KNOWN_SYSTEM_EVENTS.join(', ')}. If this is a custom event, you can ignore this warning.`,
          severity: 'warning',
        });
      }
    }

    // 5d. Cron trigger must have a schedule
    if (triggerObj.cron && typeof triggerObj.cron === 'object') {
      const cronSchedule = (triggerObj.cron as Record<string, unknown>).schedule;
      if (!cronSchedule || (typeof cronSchedule === 'string' && cronSchedule.trim() === '')) {
        warnings.push({
          code: 'trigger_cron_no_schedule',
          message: `Pipeline/workflow "${name}" has a cron trigger with no schedule. Add a \`schedule\` field (e.g., "0 */6 * * *").`,
          severity: 'warning',
        });
      }
    }
  }

  // 6. Domain-signup coherence
  const authConfig = getManifestAuthConfig(manifest);
  if (authConfig?.org_access.domain_signup.enabled) {
    const ds = authConfig.org_access.domain_signup;
    for (const rule of ds.domains) {
      if (isFreeEmailDomain(rule.domain)) {
        warnings.push({
          code: 'domain_signup_free_provider',
          message: `domain_signup includes free-email provider "${rule.domain}" (target_org=${rule.target_org}). Anyone with such an address worldwide could sign in. Confirm this is intentional.`,
          severity: 'warning',
        });
      }
    }
    if (ds.domains.length > 25) {
      warnings.push({
        code: 'domain_signup_too_many_domains',
        message: `domain_signup declares ${ds.domains.length} domains. The recommended soft cap is 25; consider splitting into multiple apps.`,
        severity: 'warning',
      });
    }
  }

  return warnings;
}

/**
 * Detect cycles in a directed graph using DFS.
 * Returns the cycle path if found, null otherwise.
 */
function detectManifestCycle(
  nodes: string[],
  depMap: Map<string, string[]>,
): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): string[] | null {
    if (inStack.has(node)) return [...path, node];
    if (visited.has(node)) return null;
    visited.add(node);
    inStack.add(node);
    for (const dep of depMap.get(node) ?? []) {
      const cycle = dfs(dep, [...path, node]);
      if (cycle) return cycle;
    }
    inStack.delete(node);
    return null;
  }

  for (const name of nodes) {
    const cycle = dfs(name, []);
    if (cycle) return cycle;
  }
  return null;
}

export interface ManifestRegistryConfig {
  host: string;
  namespace?: string;
  auth?: {
    username_secret?: string;
    token_secret?: string;
  };
}

/**
 * Returns true if the manifest uses Eve-native registry (`registry: "eve"`).
 */
export function isEveRegistry(manifest: Manifest): boolean {
  return manifest.registry === 'eve';
}

/**
 * Returns true if registry is explicitly set to "none" (opt-out of any registry).
 */
export function isRegistryNone(manifest: Manifest): boolean {
  return manifest.registry === 'none';
}

/**
 * Extracts and validates registry configuration from a manifest.
 * Returns null if no registry is configured or if registry is "eve" (handled separately)
 * or "none" (no registry needed).
 */
export function getRegistryConfig(manifest: Manifest): ManifestRegistryConfig | null {
  const registry = manifest.registry;
  if (!registry || typeof registry === 'string') return null;

  const registryObj = registry as Record<string, unknown>;
  const host = registryObj.host as string | undefined;
  if (!host) return null;

  const auth = registryObj.auth as Record<string, unknown> | undefined;
  return {
    host,
    namespace: registryObj.namespace as string | undefined,
    auth: auth ? {
      username_secret: auth.username_secret as string | undefined,
      token_secret: auth.token_secret as string | undefined,
    } : undefined,
  };
}

export function getManifestPacks(manifest: Manifest): z.infer<typeof PackEntrySchema>[] {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && 'packs' in xEve) {
    return (xEve as ManifestXeve).packs ?? [];
  }
  return [];
}

export function getManifestInstallAgents(manifest: Manifest): string[] {
  const xEve = manifest['x-eve'] ?? manifest.x_eve;
  if (xEve && typeof xEve === 'object' && 'install_agents' in xEve) {
    return (xEve as ManifestXeve).install_agents ?? ['claude-code', 'codex', 'gemini-cli', 'pi'];
  }
  return ['claude-code', 'codex', 'gemini-cli', 'pi'];
}

/**
 * Returns services that are managed databases (role: managed_db).
 */
export function getManagedDbServices(manifest: Manifest): Record<string, Service> {
  const services = manifest.services ?? {};
  const result: Record<string, Service> = {};
  for (const [name, service] of Object.entries(services)) {
    const xEve = service['x-eve'] ?? service.x_eve;
    if (xEve?.role === 'managed_db') {
      result[name] = service;
    }
  }
  return result;
}

/**
 * Gets the managed DB config from a service's x-eve block.
 */
export function getManagedDbConfig(service: Service): ManagedDbConfig | null {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || xEve.role !== 'managed_db') return null;
  const managed = xEve.managed;
  if (!managed || typeof managed !== 'object') return null;
  const parsed = ManagedDbConfigSchema.safeParse(managed);
  return parsed.success ? parsed.data : null;
}

/**
 * Extract object store bucket declarations from a service's x-eve config.
 */
export function getServiceObjectStoreBuckets(service: Service): ObjectStoreBucket[] {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || typeof xEve !== 'object') return [];
  const parsed = ServiceXeveSchema.safeParse(xEve);
  if (!parsed.success) return [];
  return parsed.data.object_store?.buckets ?? [];
}

/**
 * Resolve the requested object store credential isolation for a service.
 * Missing values intentionally resolve here, not in the schema, so callers can
 * distinguish old manifests from explicit `auto` when needed.
 */
export function getServiceObjectStoreIsolation(service: Service): ObjectStoreIsolation {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || typeof xEve !== 'object') return 'auto';
  const parsed = ServiceXeveSchema.safeParse(xEve);
  if (!parsed.success) return 'auto';
  return parsed.data.object_store?.isolation ?? 'auto';
}

/**
 * Extract additional permissions declared in a service's x-eve config.
 * These are merged with the platform's read-only defaults when minting the service token.
 */
export function getServicePermissions(service: Service): string[] {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || typeof xEve !== 'object') return [];
  const parsed = ServiceXeveSchema.safeParse(xEve);
  if (!parsed.success) return [];
  return parsed.data.permissions ?? [];
}

/**
 * Resolve a service's networking config, applying defaults. Always returns a
 * concrete object so downstream code can read `.egress` without null checks.
 */
export function resolveServiceNetworking(service: Service): ServiceNetworking {
  const xEve = service['x-eve'] ?? service.x_eve;
  const raw = xEve && typeof xEve === 'object' ? (xEve as Record<string, unknown>).networking : undefined;
  const parsed = ServiceNetworkingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { egress: 'nat' };
}

/**
 * True when the service has opted into stable egress
 * (`x-eve.networking.egress: stable`).
 */
export function requiresStableEgress(service: Service): boolean {
  return resolveServiceNetworking(service).egress === 'stable';
}

export function resolveTcpIngressConfig(service: Service): TcpIngressConfig | null {
  const xEve = service['x-eve'] ?? service.x_eve;
  if (!xEve || typeof xEve !== 'object') return null;
  const raw = (xEve as Record<string, unknown>).tcp_ingress;
  if (!raw || typeof raw !== 'object') return null;
  const parsed = TcpIngressConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function requiresTcpIngress(service: Service): boolean {
  return resolveTcpIngressConfig(service) !== null;
}
