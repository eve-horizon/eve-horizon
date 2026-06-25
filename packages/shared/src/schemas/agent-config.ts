import { z } from 'zod';
import { GatewayPolicySchema } from './pack.js';

const AgentPolicySchema = z.object({
  permission_policy: z.enum(['auto_edit', 'never', 'yolo']).optional(),
  git: z.object({
    commit: z.enum(['never', 'manual', 'auto', 'required']).optional(),
    push: z.enum(['never', 'on_success', 'required']).optional(),
  }).optional(),
}).passthrough();

const AgentAccessSchema = z.object({
  envs: z.array(z.string()).optional(),
  services: z.array(z.string()).optional(),
  api_specs: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
}).passthrough();

const AgentScheduleSchema = z.object({
  heartbeat_cron: z.string().optional(),
}).passthrough();

const AgentSlugSchema = z.string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric with optional dashes');

const AgentGatewaySchema = z.object({
  policy: GatewayPolicySchema.optional(),
  clients: z.array(z.string()).optional(),
}).optional();

const AgentContextMemorySchema = z.object({
  categories: z.array(z.enum(['learnings', 'decisions', 'runbooks', 'context', 'conventions', 'user'])).optional(),
  max_items: z.number().int().min(1).optional(),
  max_age: z.string().optional(),
  agent: z.string().optional(),
}).passthrough();

const AgentContextDocsSchema = z.array(z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional(),
}).passthrough()).optional();

const AgentContextParentAttachmentsSchema = z.object({
  names: z.array(z.string().min(1)).optional(),
}).passthrough();

const AgentContextThreadsSchema = z.object({
  coordination: z.boolean().optional(),
  max_messages: z.number().int().min(1).optional(),
}).passthrough();

const AgentContextSchema = z.object({
  memory: AgentContextMemorySchema.optional(),
  docs: AgentContextDocsSchema,
  parent_attachments: AgentContextParentAttachmentsSchema.optional(),
  threads: AgentContextThreadsSchema.optional(),
}).passthrough();

export const VALID_TOOLCHAINS = ['python', 'media', 'rust', 'java', 'kotlin'] as const;
export type Toolchain = typeof VALID_TOOLCHAINS[number];
export const ToolchainsSchema = z.array(z.enum(VALID_TOOLCHAINS));

const AgentWithApiSchema = z.object({
  service: z.string().min(1),
  description: z.string().optional(),
}).passthrough();

const AgentEntrySchema = z.object({
  name: z.string().optional(),
  slug: AgentSlugSchema.optional(),
  alias: AgentSlugSchema.optional(),
  description: z.string().optional(),
  role: z.string().optional(),
  skill: z.string().min(1),
  workflow: z.string().optional(),
  harness_profile: z.string().optional(),
  toolchains: ToolchainsSchema.optional(),
  with_apis: z.array(AgentWithApiSchema).optional(),
  context: AgentContextSchema.optional(),
  access: AgentAccessSchema.optional(),
  policies: AgentPolicySchema.optional(),
  schedule: AgentScheduleSchema.optional(),
  gateway: AgentGatewaySchema,
}).passthrough();

export const AgentsYamlSchema = z.object({
  version: z.number().int().min(1),
  agents: z.record(AgentEntrySchema),
}).passthrough();

const TeamDispatchSchema = z.object({
  mode: z.enum(['fanout', 'council', 'relay']).optional(),
  staged: z.boolean().optional(),
  max_parallel: z.number().int().min(1).optional(),
  merge_strategy: z.string().optional(),
  lead_timeout: z.number().int().positive().optional(),
  member_timeout: z.number().int().positive().optional(),
}).passthrough()
  .superRefine((dispatch, ctx) => {
    if (dispatch.staged === true && dispatch.mode !== 'council') {
      ctx.addIssue({
        code: 'custom',
        path: ['staged'],
        message: "dispatch.staged=true is only valid when dispatch.mode is 'council'",
      });
    }
  });

const TeamEntrySchema = z.object({
  lead: z.string().min(1),
  members: z.array(z.string()).optional(),
  dispatch: TeamDispatchSchema.optional(),
}).passthrough();

export const TeamsYamlSchema = z.object({
  version: z.number().int().min(1),
  teams: z.record(TeamEntrySchema),
}).passthrough();

const RoutePermissionsSchema = z.object({
  project_roles: z.array(z.string()).optional(),
  envs: z.array(z.string()).optional(),
}).passthrough();

const RouteEntrySchema = z.object({
  id: z.string().min(1),
  match: z.string().min(1),
  target: z.string().min(1),
  providers: z.array(z.string().min(1)).optional(),
  account_ids: z.array(z.string().min(1)).optional(),
  permissions: RoutePermissionsSchema.optional(),
}).passthrough();

export const ChatYamlSchema = z.object({
  version: z.number().int().min(1),
  default_route: z.string().optional(),
  routes: z.array(RouteEntrySchema).optional(),
}).passthrough();

export type AgentsYaml = z.infer<typeof AgentsYamlSchema>;
export type TeamsYaml = z.infer<typeof TeamsYamlSchema>;
export type ChatYaml = z.infer<typeof ChatYamlSchema>;

const PackRefSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  ref: z.string().min(1),
});

export const AgentsSyncRequestSchema = z.object({
  agents_yaml: z.string().min(1, 'agents yaml cannot be empty'),
  teams_yaml: z.string().min(1, 'teams yaml cannot be empty'),
  chat_yaml: z.string().min(1, 'chat yaml cannot be empty'),
  x_eve_yaml: z.string().optional(),
  pack_refs: z.array(PackRefSchema).optional(),
  git_sha: z.string().optional(),
  branch: z.string().optional(),
  git_ref: z.string().optional(),
});

export type AgentsSyncRequest = z.infer<typeof AgentsSyncRequestSchema>;

export const AgentsSyncResponseSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parsed_agents: z.record(z.unknown()).nullable(),
  parsed_teams: z.record(z.unknown()).nullable(),
  parsed_routes: z.array(z.unknown()).nullable(),
  pack_refs: z.array(PackRefSchema).nullable().optional(),
  git_sha: z.string().nullable(),
  branch: z.string().nullable(),
  git_ref: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AgentsSyncResponse = z.infer<typeof AgentsSyncResponseSchema>;

export const RESERVED_AGENT_ALIASES = new Set([
  'agents', 'help', 'status', 'eve', 'admin', 'system', 'health',
]);

export function isReservedAgentAlias(alias: string): boolean {
  return RESERVED_AGENT_ALIASES.has(alias.trim().toLowerCase());
}
