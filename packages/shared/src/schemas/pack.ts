import { z } from 'zod';

// --- Gateway policy values ---

export const GatewayPolicySchema = z.enum(['none', 'discoverable', 'routable']);
export type GatewayPolicy = z.infer<typeof GatewayPolicySchema>;

// --- pack.yaml schema (lives inside a pack repo at eve/pack.yaml) ---

export const PackYamlSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Pack ID must be lowercase alphanumeric with hyphens'),
  imports: z.object({
    agents: z.string().min(1),
    teams: z.string().min(1).optional(),
    workflows: z.string().min(1).optional(),
    chat: z.string().min(1).optional(),
    x_eve: z.string().min(1).optional(),
  }),
  gateway: z.object({
    default_policy: GatewayPolicySchema.default('none'),
  }).optional(),
});

export type PackYaml = z.infer<typeof PackYamlSchema>;

// --- Manifest x-eve.packs entry schema ---

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const PackEntrySchema = z.object({
  source: z.string().min(1),
  ref: z.string().regex(GIT_SHA_PATTERN, 'Pack ref must be a 40-character git SHA').optional(),
  install_agents: z.array(z.string()).optional(),
  import: z.union([z.literal(false), z.undefined()]).optional(),
}).refine(
  (data) => {
    // ref is required for remote sources
    const isRemote = data.source.startsWith('http') ||
      data.source.startsWith('git@') ||
      data.source.startsWith('github:') ||
      (!data.source.startsWith('./') && !data.source.startsWith('../') && !data.source.startsWith('/') && data.source.includes('/'));
    return !isRemote || !!data.ref;
  },
  { message: 'ref (40-char SHA) is required for remote pack sources' }
);

export type PackEntry = z.infer<typeof PackEntrySchema>;

// --- Lockfile schema (.eve/packs.lock.yaml) ---

export const PackLockEntrySchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  ref: z.string().regex(GIT_SHA_PATTERN),
  pack_version: z.number().int(),
});

export type PackLockEntry = z.infer<typeof PackLockEntrySchema>;

export const PackLockSchema = z.object({
  resolved_at: z.string().datetime(),
  project_slug: z.string().min(1),
  packs: z.array(PackLockEntrySchema),
  effective: z.object({
    agents_count: z.number().int().nonnegative(),
    teams_count: z.number().int().nonnegative(),
    routes_count: z.number().int().nonnegative(),
    profiles_count: z.number().int().nonnegative(),
    agents_hash: z.string().min(1),
    teams_hash: z.string().min(1),
    chat_hash: z.string().min(1),
  }),
});

export type PackLock = z.infer<typeof PackLockSchema>;

// --- Resolved pack (runtime type, not persisted) ---

export interface ResolvedPack {
  id: string;
  source: string;
  ref: string;
  rootPath: string;
  agents: Record<string, unknown>;
  teams: Record<string, unknown>;
  workflows: Record<string, unknown> | null;
  chat: Record<string, unknown> | null;
  xEve: Record<string, unknown> | null;
  skillPaths: string[];
}
