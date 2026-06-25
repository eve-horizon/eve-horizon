import { z } from 'zod';

export const AgentRuntimeHeartbeatRequestSchema = z.object({
  pod_name: z.string().min(1),
  status: z.string().min(1).default('healthy'),
  capacity: z.number().int().nonnegative().default(0),
});

export type AgentRuntimeHeartbeatRequest = z.infer<typeof AgentRuntimeHeartbeatRequestSchema>;

export const AgentRuntimePodSchema = z.object({
  org_id: z.string(),
  pod_name: z.string(),
  status: z.string(),
  capacity: z.number().int(),
  last_heartbeat_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  stale: z.boolean().optional(),
  active_jobs: z.number().int().optional(),
});

export type AgentRuntimePod = z.infer<typeof AgentRuntimePodSchema>;

export const AgentRuntimeStatusResponseSchema = z.object({
  pods: z.array(AgentRuntimePodSchema),
});

export type AgentRuntimeStatusResponse = z.infer<typeof AgentRuntimeStatusResponseSchema>;
