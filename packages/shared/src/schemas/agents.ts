import { z } from 'zod';
import { HarnessListResponseSchema } from './harnesses.js';
import { GatewayPolicySchema } from './pack.js';

export const AgentSummarySchema = z.object({
  id: z.string(),
  slug: z.string().nullable().optional(),
  alias: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  workflow: z.string().nullable().optional(),
  harness_profile: z.string().nullable().optional(),
  policies: z.record(z.unknown()).nullable().optional(),
  access: z.record(z.unknown()).nullable().optional(),
  gateway_policy: GatewayPolicySchema.optional(),
  gateway_clients: z.array(z.string()).nullable().optional(),
});

export const AgentsConfigResponseSchema = z.object({
  project_id: z.string(),
  policy: z.record(z.unknown()).nullable(),
  manifest_defaults: z.record(z.unknown()).nullable().optional(),
  config_source: z.enum(['agent_config', 'database', 'manifest', 'none']).optional(),
  synced_at: z.string().nullable().optional(),
  agents: z.array(AgentSummarySchema).optional(),
  harnesses: HarnessListResponseSchema.optional(),
});

export type AgentsConfigResponse = z.infer<typeof AgentsConfigResponseSchema>;

export const OrgAgentDirectoryItemSchema = z.object({
  project_id: z.string(),
  project_slug: z.string(),
  project_name: z.string(),
  agent_id: z.string(),
  agent_slug: z.string().nullable(),
  agent_alias: z.string().nullable().optional(),
  agent_name: z.string().nullable().optional(),
  agent_description: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  workflow: z.string().nullable().optional(),
  gateway_policy: GatewayPolicySchema.optional(),
});

export const OrgAgentDirectoryResponseSchema = z.object({
  org_id: z.string(),
  default_agent_slug: z.string().nullable().optional(),
  agents: z.array(OrgAgentDirectoryItemSchema),
});

export type OrgAgentDirectoryResponse = z.infer<typeof OrgAgentDirectoryResponseSchema>;
