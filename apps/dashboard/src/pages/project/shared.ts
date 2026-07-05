// ---------------------------------------------------------------------------
// Types and normalizers shared by the project page shell and multiple tabs
// ---------------------------------------------------------------------------

export interface Agent {
  id: string;
  slug: string;
  alias?: string | null;
  name: string | null;
  description?: string | null;
  role?: string | null;
  workflow?: string | null;
  harness_profile?: string | null;
  policies?: Record<string, unknown> | null;
  access?: Record<string, unknown> | null;
  gateway_policy?: 'none' | 'discoverable' | 'routable';
  gateway_clients?: string[] | null;
  status?: string;
}

export interface AgentConfigResponse {
  project_id: string;
  policy?: Record<string, unknown> | null;
  manifest_defaults?: Record<string, unknown> | null;
  config_source?: 'agent_config' | 'database' | 'manifest' | 'none';
  synced_at?: string | null;
  agents?: Agent[];
  data?: Agent[];
}

export interface Route {
  id: string;
  match: string;
  target: string;
  permissions?: Record<string, unknown>;
}

export interface Pipeline {
  name: string;
  trigger?: string;
  steps?: PipelineStep[];
  created_at?: string;
}

export interface RawPipeline {
  name: string;
  trigger?: string;
  steps?: PipelineStep[];
  definition?: {
    steps?: PipelineStep[];
    trigger?: string | Record<string, unknown>;
  };
  created_at?: string;
}

export interface PipelineStep {
  name: string;
  action?: string | Record<string, unknown>;
  script?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  status?: string;
}

export function normalizeAgents(data: AgentConfigResponse | null | undefined): Agent[] {
  return (data?.agents ?? data?.data ?? []).map((agent) => ({
    ...agent,
    slug: agent.slug ?? agent.id,
    name: agent.name ?? agent.slug ?? agent.id,
  }));
}

export function normalizePipelines(data: { pipelines?: RawPipeline[]; data?: RawPipeline[] } | null | undefined): Pipeline[] {
  const pipelines = data?.pipelines ?? data?.data ?? [];
  return pipelines.map((pipeline) => ({
    name: pipeline.name,
    trigger:
      typeof pipeline.trigger === 'string'
        ? pipeline.trigger
        : typeof pipeline.definition?.trigger === 'string'
          ? pipeline.definition.trigger
          : undefined,
    steps: pipeline.steps ?? pipeline.definition?.steps ?? [],
    created_at: pipeline.created_at,
  }));
}
