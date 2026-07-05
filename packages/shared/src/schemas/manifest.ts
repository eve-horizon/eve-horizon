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

// ---------------------------------------------------------------------------
// Accessor/derivation helpers and coherence analysis live in lib modules.
// Re-exported here so existing importers keep working unchanged.
// ---------------------------------------------------------------------------
export * from '../lib/manifest-accessors.js';
export * from '../lib/manifest-coherence.js';
