import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare,
  Send,
  ExternalLink,
  Clock,
  Calendar,
  Users,
  GitBranch,
  Zap,
  Workflow,
  Link2,
  Package,
  Bot,
} from 'lucide-react';
import { HealthDot } from '@/components/health-dot';
import { SlideOver } from '@/components/slide-over';
import { useProjectEnvs } from '@/hooks/use-environments';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { LayoutContext } from '@/components/layout';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Agent {
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

interface AgentConfigResponse {
  project_id: string;
  policy?: Record<string, unknown> | null;
  manifest_defaults?: Record<string, unknown> | null;
  config_source?: 'agent_config' | 'database' | 'manifest' | 'none';
  synced_at?: string | null;
  agents?: Agent[];
  data?: Agent[];
}

interface Team {
  id: string;
  lead_agent_id?: string | null;
  dispatch?: Record<string, unknown> | null;
  members: string[];
}

interface Route {
  id: string;
  match: string;
  target: string;
  permissions?: Record<string, unknown>;
}

interface Thread {
  id: string;
  key: string;
  summary?: string | null;
  workspace_key?: string | null;
  created_at: string;
  updated_at: string;
}

interface ThreadMessage {
  id: string;
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  direction?: 'inbound' | 'outbound';
  actor_type?: string | null;
  body?: string;
  created_at: string;
}

interface Pipeline {
  name: string;
  trigger?: string;
  steps?: PipelineStep[];
  created_at?: string;
}

interface RawPipeline {
  name: string;
  trigger?: string;
  steps?: PipelineStep[];
  definition?: {
    steps?: PipelineStep[];
    trigger?: string | Record<string, unknown>;
  };
  created_at?: string;
}

interface PipelineStep {
  name: string;
  action?: string | Record<string, unknown>;
  script?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  status?: string;
}

interface PipelineRun {
  id: string;
  status: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  steps?: Array<{ name: string; status: string }>;
}

interface WorkflowDef {
  id?: string;
  name: string;
  trigger_label?: string | null;
  steps?: Array<{ name: string; agent?: string; condition?: string }>;
  permission_mode?: string;
  last_triggered_at?: string;
  daily_run_count?: number;
  timeout_seconds?: number;
  api_count?: number;
  created_at?: string;
}

interface RawWorkflowDef {
  id?: string;
  name: string;
  trigger_event?: string;
  steps?: Array<{ name: string; agent?: string; condition?: string }>;
  permission_mode?: string;
  last_triggered_at?: string;
  daily_run_count?: number;
  created_at?: string;
  definition?: {
    trigger?: Record<string, unknown>;
    steps?: Array<{
      name?: string;
      agent?: string | { name?: string };
      condition?: string;
    }>;
    hints?: {
      permission_policy?: string;
      timeout_seconds?: number;
    };
    with_apis?: Array<{ service: string; description?: string }>;
  };
}

interface Integration {
  id: string;
  provider?: string;
  type?: string;
  account_id?: string;
  name?: string;
  status?: string;
  config?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface ProjectMember {
  project_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  role: 'owner' | 'admin' | 'member';
  created_at: string;
  updated_at: string;
}

interface Release {
  id: string;
  tag: string;
  git_sha?: string;
  environment?: string;
  created_by?: string;
  is_active?: boolean;
  created_at: string;
}

interface Schedule {
  id: string;
  name?: string;
  cron: string;
  event_type?: string;
  next_run_at?: string;
  last_run_at?: string;
  status?: string;
  enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface ManifestService {
  image?: string;
  type?: string;
  [key: string]: unknown;
}

interface ManifestSnapshot {
  id?: string;
  updated_at?: string;
  warnings?: string[];
  services?: Record<string, ManifestService> | null;
  environments?: Record<string, Record<string, unknown>> | null;
}

interface EnvHealthData {
  services?: Array<{
    name: string;
    status: string;
    replicas?: number;
    ready_replicas?: number;
    pods?: Array<{ name: string; status: string; ready: boolean; restarts?: number }>;
  }>;
  databases?: Array<{ name: string; status: string }>;
  status?: string;
  warnings?: string[];
}

interface RuntimeStatus {
  status?: string;
  org_id?: string;
  warm_agents?: string[];
}

// ---------------------------------------------------------------------------
// Tab definition
// ---------------------------------------------------------------------------

type TabId = 'architecture' | 'agents' | 'pipelines' | 'workflows' | 'integrations' | 'releases' | 'schedules' | 'members';

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof Bot;
  badgeKey?: 'agents' | 'pipelines';
}

const TABS: TabDef[] = [
  { id: 'architecture', label: 'Architecture', icon: Zap },
  { id: 'agents', label: 'Agents', icon: Bot, badgeKey: 'agents' },
  { id: 'pipelines', label: 'Pipelines', icon: GitBranch, badgeKey: 'pipelines' },
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  { id: 'integrations', label: 'Integrations', icon: Link2 },
  { id: 'releases', label: 'Releases', icon: Package },
  { id: 'schedules', label: 'Schedules', icon: Calendar },
  { id: 'members', label: 'Members', icon: Users },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Translate a cron expression into a human-readable string */
function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (min === '*' && hour === '*') return 'Every minute';
  if (hour === '*' && min !== '*') return `Every hour at :${min!.padStart(2, '0')}`;

  const dayNames: Record<string, string> = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun' };

  let timeStr = '';
  if (hour !== '*' && min !== '*') {
    timeStr = `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
  }

  if (dow !== '*' && dow !== '?') {
    const days = dow!.split(',').map((d) => dayNames[d] ?? d).join(', ');
    return timeStr ? `${days} at ${timeStr}` : `${days}`;
  }
  if (dom !== '*' && dom !== '?') {
    return timeStr ? `Day ${dom} at ${timeStr}` : `Day ${dom}`;
  }
  return timeStr ? `Daily at ${timeStr}` : cron;
}

/** Format a date for table display */
function formatDate(d: string | undefined | null): string {
  if (!d) return '\u2014';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '\u2014';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Truncate a git SHA */
function shortSha(sha: string | undefined | null): string {
  if (!sha) return '\u2014';
  return sha.slice(0, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeAgents(data: AgentConfigResponse | null | undefined): Agent[] {
  return (data?.agents ?? data?.data ?? []).map((agent) => ({
    ...agent,
    slug: agent.slug ?? agent.id,
    name: agent.name ?? agent.slug ?? agent.id,
  }));
}

function workflowTriggerLabel(trigger: unknown): string | null {
  if (!isRecord(trigger)) return null;

  const appTrigger = isRecord(trigger.app) ? trigger.app : null;
  if (appTrigger && typeof appTrigger.event === 'string') {
    return `app:${appTrigger.event}`;
  }
  const systemTrigger = isRecord(trigger.system) ? trigger.system : null;
  if (systemTrigger && typeof systemTrigger.event === 'string') {
    return `system:${systemTrigger.event}`;
  }
  if (typeof trigger.event === 'string') {
    return trigger.event;
  }

  return null;
}

function normalizePipelines(data: { pipelines?: RawPipeline[]; data?: RawPipeline[] } | null | undefined): Pipeline[] {
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

function normalizeWorkflows(data: { workflows?: RawWorkflowDef[]; data?: RawWorkflowDef[] } | null | undefined): WorkflowDef[] {
  const workflows = data?.workflows ?? data?.data ?? [];
  return workflows.map((workflow, index) => {
    const steps = workflow.steps
      ?? workflow.definition?.steps?.map((step, stepIndex) => ({
        name: step.name ?? `step-${stepIndex + 1}`,
        agent:
          typeof step.agent === 'string'
            ? step.agent
            : isRecord(step.agent) && typeof step.agent.name === 'string'
              ? step.agent.name
              : undefined,
        condition: typeof step.condition === 'string' ? step.condition : undefined,
      }))
      ?? [];

    return {
      id: workflow.id ?? workflow.name ?? String(index),
      name: workflow.name,
      trigger_label: workflow.trigger_event ?? workflowTriggerLabel(workflow.definition?.trigger) ?? null,
      steps,
      permission_mode: workflow.permission_mode ?? workflow.definition?.hints?.permission_policy,
      last_triggered_at: workflow.last_triggered_at,
      daily_run_count: workflow.daily_run_count,
      timeout_seconds: workflow.definition?.hints?.timeout_seconds,
      api_count: workflow.definition?.with_apis?.length ?? 0,
      created_at: workflow.created_at,
    };
  });
}

function getMessageBody(message: ThreadMessage): string {
  return message.content ?? message.body ?? '';
}

function isUserMessage(message: ThreadMessage): boolean {
  if (message.role) {
    return message.role === 'user';
  }
  return message.direction === 'inbound' && message.actor_type !== 'agent';
}

function readableRouteTarget(target: string): string {
  const [kind, id] = target.split(':', 2);
  if (!kind || !id) return target;
  return `${kind[0]!.toUpperCase()}${kind.slice(1)} · ${id}`;
}

function gatewayPolicyLabel(agent: Agent): string {
  if (agent.gateway_policy === 'routable') return 'Routable';
  if (agent.gateway_policy === 'discoverable') return 'Discoverable';
  return 'Internal';
}

function permissionPolicyLabel(agent: Agent): string | null {
  const policy = agent.policies?.permission_policy;
  return typeof policy === 'string' ? policy : null;
}

// ---------------------------------------------------------------------------
// Reusable card / table primitives
// ---------------------------------------------------------------------------

function Card({ children, accent, onClick, className = '' }: { children: ReactNode; accent?: string; onClick?: () => void; className?: string }) {
  return (
    <div
      onClick={onClick}
      className={`bg-[var(--bg-1)] rounded-lg border border-[var(--border)] overflow-hidden ${onClick ? 'cursor-pointer hover:border-[var(--border-bright)] transition-colors' : ''} ${className}`}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
    >
      {children}
    </div>
  );
}

function Badge({ children, color = 'var(--bg-3)', textColor = 'var(--text-secondary)' }: { children: ReactNode; color?: string; textColor?: string }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-label font-medium"
      style={{ background: color, color: textColor }}
    >
      {children}
    </span>
  );
}

function EmptyState({ icon: Icon, title, subtitle }: { icon: typeof Bot; title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-xl bg-[var(--bg-3)] flex items-center justify-center mb-4">
        <Icon size={24} className="text-[var(--text-muted)]" />
      </div>
      <div className="text-body font-medium text-[var(--text-secondary)] mb-1">{title}</div>
      {subtitle && <div className="text-label text-[var(--text-muted)] max-w-xs">{subtitle}</div>}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="text-label text-[var(--text-muted)]">Loading...</div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="text-label" style={{ color: 'var(--red)' }}>{message}</div>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-emphasis font-medium text-[var(--text-primary)] mb-3">{children}</h3>;
}

// ---------------------------------------------------------------------------
// Architecture Tab — SVG Topology
// ---------------------------------------------------------------------------

interface TopoNode {
  id: string;
  label: string;
  type: 'ingress' | 'service' | 'platform' | 'data' | 'agent';
  status: string;
  replicas?: number;
  readyReplicas?: number;
  pods?: Array<{ name: string; status: string; ready: boolean; restarts?: number }>;
}

interface TopoEdge {
  from: string;
  to: string;
}

function classifyConfiguredServiceType(name: string, service: ManifestService | undefined): TopoNode['type'] {
  const lowerName = name.toLowerCase();
  const image = typeof service?.image === 'string' ? service.image.toLowerCase() : '';
  const type = typeof service?.type === 'string' ? service.type.toLowerCase() : '';

  if (
    lowerName === 'db'
    || lowerName.includes('postgres')
    || lowerName.includes('redis')
    || type.includes('postgres')
    || type.includes('mysql')
    || image.includes('postgres')
    || image.includes('mysql')
    || image.includes('redis')
  ) {
    return 'data';
  }

  if (['nats', 'buildkit', 'registry'].some((keyword) => lowerName.includes(keyword) || image.includes(keyword))) {
    return 'platform';
  }

  return 'service';
}

function connectTopologyLayers(nodes: TopoNode[], edges: TopoEdge[]) {
  const services = nodes.filter((node) => node.type === 'service');
  const platforms = nodes.filter((node) => node.type === 'platform');
  const datas = nodes.filter((node) => node.type === 'data');

  for (const service of services) {
    for (const platform of platforms) {
      edges.push({ from: service.id, to: platform.id });
    }
    if (platforms.length === 0) {
      for (const data of datas) {
        edges.push({ from: service.id, to: data.id });
      }
    }
  }

  for (const platform of platforms) {
    for (const data of datas) {
      edges.push({ from: platform.id, to: data.id });
    }
  }
}

function buildTopology(
  healthData: EnvHealthData | null,
  agents: Agent[],
  manifestServices: Record<string, ManifestService>,
): { nodes: TopoNode[]; edges: TopoEdge[] } {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const renderedNodes = new Set<string>();
  const configuredServiceEntries = Object.entries(manifestServices);

  if (!healthData?.services?.length && configuredServiceEntries.length === 0 && agents.length === 0) {
    return { nodes, edges };
  }

  // Classify services into layers
  const platformNames = new Set(['postgres', 'redis', 'nats', 'buildkit', 'registry']);
  const dataNames = new Set(['postgres', 'redis']);

  // Add ingress node
  if (healthData?.services?.length || configuredServiceEntries.length > 0) {
    nodes.push({ id: 'ingress', label: 'Ingress', type: 'ingress', status: 'healthy' });
    renderedNodes.add('ingress');
  }

  if (healthData?.services) {
    for (const svc of healthData.services) {
      const isData = dataNames.has(svc.name.toLowerCase());
      const isPlatform = platformNames.has(svc.name.toLowerCase()) && !isData;
      const type: TopoNode['type'] = isData ? 'data' : isPlatform ? 'platform' : 'service';

      nodes.push({
        id: svc.name,
        label: svc.name,
        type,
        status: svc.status,
        replicas: svc.replicas,
        readyReplicas: svc.ready_replicas,
        pods: svc.pods,
      });
      renderedNodes.add(svc.name);

      // Edge from ingress to services
      if (type === 'service') {
        edges.push({ from: 'ingress', to: svc.name });
      }
    }
  }

  for (const [serviceName, service] of configuredServiceEntries) {
    if (renderedNodes.has(serviceName)) continue;

    const type = classifyConfiguredServiceType(serviceName, service);
    nodes.push({
      id: serviceName,
      label: serviceName,
      type,
      status: 'configured',
    });
    renderedNodes.add(serviceName);

    if (type === 'service' && renderedNodes.has('ingress')) {
      edges.push({ from: 'ingress', to: serviceName });
    }
  }

  // Add databases from health
  if (healthData?.databases) {
    for (const db of healthData.databases) {
      if (!nodes.find((n) => n.id === db.name)) {
        nodes.push({ id: db.name, label: db.name, type: 'data', status: db.status });
      }
    }
  }

  // Agents as sidebar nodes
  for (const agent of agents) {
    nodes.push({
      id: `agent-${agent.slug}`,
      label: agent.name || agent.slug,
      type: 'agent',
      status: agent.status === 'warm' ? 'healthy' : 'unknown',
    });
  }

  connectTopologyLayers(nodes, edges);

  return { nodes, edges };
}

const NODE_W = 150;
const NODE_H = 48;
const LAYER_GAP = 72;
const NODE_GAP = 16;

const typeColors: Record<string, string> = {
  ingress: 'var(--green)',
  service: 'var(--blue)',
  platform: 'var(--amber)',
  data: 'var(--cyan)',
  agent: 'var(--purple)',
};

function ArchitectureTab({
  projectId,
  envName,
}: {
  projectId: string;
  envName: string | null;
}) {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<TopoNode | null>(null);

  const { data: envsData, isLoading: envsLoading } = useProjectEnvs(projectId);
  const availableEnvs = envsData?.data ?? [];
  const { data: manifestData, isLoading: manifestLoading } = useQuery({
    queryKey: ['project-manifest', projectId],
    queryFn: () => api<ManifestSnapshot | null>(`/projects/${projectId}/manifest`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const configuredEnvs = Object.keys(manifestData?.environments ?? {});
  const effectiveEnv = envName ?? availableEnvs[0]?.name ?? configuredEnvs[0] ?? null;
  const hasLiveEnv = !!effectiveEnv && availableEnvs.some((env) => env.name === effectiveEnv);

  const { data: healthData, isLoading: healthLoading } = useQuery({
    queryKey: ['env-health-detail', projectId, effectiveEnv],
    queryFn: () => api<EnvHealthData>(`/projects/${projectId}/envs/${effectiveEnv!}/health`),
    enabled: !!projectId && !!effectiveEnv && hasLiveEnv,
    refetchInterval: 10_000,
    retry: 1,
  });

  const { data: agentsData } = useQuery({
    queryKey: ['project-agents', projectId],
    queryFn: () => api<AgentConfigResponse>(`/projects/${projectId}/agents`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: routesData } = useQuery({
    queryKey: ['project-routes', projectId],
    queryFn: () => api<{ routes?: Route[]; data?: Route[] }>(`/projects/${projectId}/routes`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const agents = normalizeAgents(agentsData);
  const manifestServices = manifestData?.services ?? {};
  const routes = routesData?.routes ?? routesData?.data ?? [];
  const { nodes, edges } = useMemo(
    () => buildTopology(healthData ?? null, agents, manifestServices),
    [healthData, agents, manifestServices],
  );
  const usingConfiguredTopology = (!healthData?.services || healthData.services.length === 0) && Object.keys(manifestServices).length > 0;
  const syncTimestamp = agentsData?.synced_at ?? manifestData?.updated_at ?? null;
  const topologyWarnings = healthData?.warnings ?? [];

  if (!envName && envsLoading && manifestLoading && !effectiveEnv) return <LoadingState />;
  if (healthLoading) return <LoadingState />;
  if (!effectiveEnv) {
    return (
      <EmptyState
        icon={Zap}
        title="No environments configured"
        subtitle="Sync a project manifest with environments to see its architecture anatomy."
      />
    );
  }

  if (nodes.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="Project anatomy not available yet"
        subtitle={`Sync the project manifest and agents config to see services and agents for "${effectiveEnv}".`}
      />
    );
  }

  // Layout nodes by layer
  const layers: Record<string, TopoNode[]> = { ingress: [], service: [], platform: [], data: [] };
  const agentNodes: TopoNode[] = [];

  for (const node of nodes) {
    if (node.type === 'agent') {
      agentNodes.push(node);
    } else {
      (layers[node.type] ??= []).push(node);
    }
  }

  const layerOrder = ['ingress', 'service', 'platform', 'data'].filter((l) => (layers[l]?.length ?? 0) > 0);
  const maxNodesInLayer = Math.max(...layerOrder.map((l) => layers[l]!.length), 1);
  const mainWidth = maxNodesInLayer * (NODE_W + NODE_GAP) - NODE_GAP;
  const agentColWidth = agentNodes.length > 0 ? NODE_W + 60 : 0;
  const svgW = Math.max(mainWidth, 400) + agentColWidth + 80;
  const svgH = layerOrder.length * (NODE_H + LAYER_GAP) - LAYER_GAP + 80;

  // Compute node positions
  const positions: Record<string, { x: number; y: number }> = {};
  for (let li = 0; li < layerOrder.length; li++) {
    const layer = layers[layerOrder[li]!]!;
    const layerWidth = layer.length * (NODE_W + NODE_GAP) - NODE_GAP;
    const xOffset = (mainWidth - layerWidth) / 2 + 40;
    for (let ni = 0; ni < layer.length; ni++) {
      positions[layer[ni]!.id] = {
        x: xOffset + ni * (NODE_W + NODE_GAP),
        y: 40 + li * (NODE_H + LAYER_GAP),
      };
    }
  }
  // Agent sidebar
  for (let ai = 0; ai < agentNodes.length; ai++) {
    positions[agentNodes[ai]!.id] = {
      x: mainWidth + 80,
      y: 40 + ai * (NODE_H + NODE_GAP),
    };
  }

  // Connected set for hover dimming
  const connectedTo = new Set<string>();
  if (hoveredNode) {
    connectedTo.add(hoveredNode);
    for (const e of edges) {
      if (e.from === hoveredNode) connectedTo.add(e.to);
      if (e.to === hoveredNode) connectedTo.add(e.from);
    }
  }

  // Stat pills
  const serviceNodes = nodes.filter((n) => n.type === 'service');
  const healthyCount = serviceNodes.filter((n) => n.status === 'healthy' || n.status === 'running' || n.status === 'ready').length;
  const degradedCount = serviceNodes.filter((n) => n.status === 'degraded' || n.status === 'warning').length;
  const dataCount = nodes.filter((n) => n.type === 'data').length;

  return (
    <div>
      {(usingConfiguredTopology || topologyWarnings.length > 0) && (
        <div
          className="mb-4 rounded-lg border px-4 py-3"
          style={{
            borderColor: topologyWarnings.length > 0 ? 'var(--amber)' : 'var(--border)',
            background: topologyWarnings.length > 0 ? 'var(--amber-dim)' : 'var(--bg-1)',
          }}
        >
          {usingConfiguredTopology && (
            <div className="text-body font-medium text-[var(--text-primary)]">
              Showing configured topology from the latest repo sync because "{effectiveEnv}" has no active deployment.
            </div>
          )}
          {topologyWarnings.length > 0 && (
            <div className={`text-label ${usingConfiguredTopology ? 'mt-1' : ''}`} style={{ color: 'var(--text-secondary)' }}>
              {topologyWarnings.join(' ')}
            </div>
          )}
          {syncTimestamp && (
            <div className={`text-label text-[var(--text-muted)] ${usingConfiguredTopology || topologyWarnings.length > 0 ? 'mt-1' : ''}`}>
              Latest config sync {timeAgo(syncTimestamp)}
            </div>
          )}
        </div>
      )}

      {/* Stat pills */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <StatPill label="Services" value={serviceNodes.length} />
        <StatPill label="Healthy" value={healthyCount} color="var(--green)" />
        {degradedCount > 0 && <StatPill label="Degraded" value={degradedCount} color="var(--amber)" />}
        <StatPill label="Databases" value={dataCount} />
        <StatPill label="Agents" value={agentNodes.length} />
        <StatPill label="Routes" value={routes.length} />
        <StatPill label="Envs" value={Math.max(availableEnvs.length, configuredEnvs.length)} />
      </div>

      {/* SVG Topology */}
      <div className="bg-[var(--bg-1)] rounded-lg border border-[var(--border)] overflow-x-auto">
        <svg
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="w-full"
          style={{ minWidth: svgW, maxHeight: 480 }}
        >
          {/* Edges */}
          {edges.map((edge, i) => {
            const from = positions[edge.from];
            const to = positions[edge.to];
            if (!from || !to) return null;
            const dimmed = hoveredNode && (!connectedTo.has(edge.from) || !connectedTo.has(edge.to));
            return (
              <line
                key={i}
                x1={from.x + NODE_W / 2}
                y1={from.y + NODE_H}
                x2={to.x + NODE_W / 2}
                y2={to.y}
                stroke="var(--border-bright)"
                strokeWidth={1.5}
                opacity={dimmed ? 0.15 : 0.5}
                style={{ transition: 'opacity 0.2s' }}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const pos = positions[node.id];
            if (!pos) return null;
            const dimmed = hoveredNode && !connectedTo.has(node.id);
            const color = typeColors[node.type] ?? 'var(--text-muted)';
            const isSelected = selectedNode?.id === node.id;

            return (
              <g
                key={node.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                opacity={dimmed ? 0.2 : 1}
                style={{ transition: 'opacity 0.2s', cursor: 'pointer' }}
                onMouseEnter={() => setHoveredNode(node.id)}
                onMouseLeave={() => setHoveredNode(null)}
                onClick={() => setSelectedNode(isSelected ? null : node)}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  fill="var(--bg-2)"
                  stroke={isSelected ? color : 'var(--border)'}
                  strokeWidth={isSelected ? 2 : 1}
                />
                {/* Left accent bar */}
                <rect x={0} y={8} width={3} height={NODE_H - 16} rx={1.5} fill={color} />
                {/* Health dot */}
                <circle
                  cx={16}
                  cy={NODE_H / 2}
                  r={4}
                  fill={
                    node.status === 'healthy' || node.status === 'running' || node.status === 'ready'
                      ? 'var(--green)'
                      : node.status === 'configured'
                        ? 'var(--blue)'
                      : node.status === 'degraded' || node.status === 'warning'
                        ? 'var(--amber)'
                        : node.status === 'down' || node.status === 'failed'
                          ? 'var(--red)'
                          : 'var(--text-muted)'
                  }
                />
                {/* Label */}
                <text
                  x={28}
                  y={NODE_H / 2 - 2}
                  dominantBaseline="middle"
                  fill="var(--text-primary)"
                  fontSize={12}
                  fontWeight={500}
                  fontFamily="IBM Plex Sans, system-ui"
                >
                  {node.label.length > 14 ? node.label.slice(0, 13) + '\u2026' : node.label}
                </text>
                {/* Replica count */}
                {node.replicas != null && (
                  <text
                    x={NODE_W - 12}
                    y={NODE_H / 2 - 2}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill="var(--text-muted)"
                    fontSize={11}
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {node.readyReplicas ?? node.replicas}/{node.replicas}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Detail panel when a node is selected */}
      {selectedNode && (
        <div className="mt-4 bg-[var(--bg-1)] rounded-lg border border-[var(--border)] p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full" style={{ background: typeColors[selectedNode.type] }} />
              <span className="text-emphasis font-medium">{selectedNode.label}</span>
              <Badge
                color={
                  selectedNode.status === 'healthy' || selectedNode.status === 'running'
                    ? 'var(--green-dim)'
                    : selectedNode.status === 'configured'
                      ? 'var(--blue-dim)'
                    : selectedNode.status === 'degraded'
                      ? 'var(--amber-dim)'
                      : 'var(--bg-3)'
                }
                textColor={
                  selectedNode.status === 'healthy' || selectedNode.status === 'running'
                    ? 'var(--green)'
                    : selectedNode.status === 'configured'
                      ? 'var(--blue)'
                    : selectedNode.status === 'degraded'
                      ? 'var(--amber)'
                      : 'var(--text-secondary)'
                }
              >
                {selectedNode.status}
              </Badge>
            </div>
            {selectedNode.replicas != null && (
              <span className="text-label text-[var(--text-muted)]">
                {selectedNode.readyReplicas ?? selectedNode.replicas}/{selectedNode.replicas} replicas
              </span>
            )}
          </div>

          {selectedNode.pods && selectedNode.pods.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-label text-[var(--text-muted)] uppercase tracking-wide mb-1">Pods</div>
              {selectedNode.pods.map((pod) => (
                <div key={pod.name} className="flex items-center justify-between text-body py-1 px-2 rounded bg-[var(--bg-2)]">
                  <div className="flex items-center gap-2">
                    <HealthDot status={pod.ready ? 'healthy' : pod.status === 'Running' ? 'warning' : 'failed'} />
                    <span className="font-mono text-label">{pod.name}</span>
                  </div>
                  <div className="flex items-center gap-4 text-label text-[var(--text-muted)]">
                    <span>{pod.status}</span>
                    {(pod.restarts ?? 0) > 0 && (
                      <span style={{ color: 'var(--amber)' }}>{pod.restarts} restart{pod.restarts! > 1 ? 's' : ''}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {(!selectedNode.pods || selectedNode.pods.length === 0) && selectedNode.type !== 'agent' && (
            <div className="text-label text-[var(--text-muted)]">
              {selectedNode.status === 'configured'
                ? 'This component is configured in the repo but not running in the selected environment yet.'
                : 'No pod details available'}
            </div>
          )}
          {selectedNode.type === 'agent' && (
            <div className="text-label text-[var(--text-muted)]">Agent runtime managed. Use the Agents tab for details.</div>
          )}
        </div>
      )}
    </div>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-label text-[var(--text-secondary)] bg-[var(--bg-1)] border border-[var(--border)] rounded-full px-3 py-1">
      <span className="font-semibold" style={color ? { color } : undefined}>{value}</span>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Agents Tab
// ---------------------------------------------------------------------------

function AgentsTab({ projectId, orgId }: { projectId: string; orgId: string }) {
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);

  const { data: agentsData, isLoading, error } = useQuery({
    queryKey: ['project-agents', projectId],
    queryFn: () => api<AgentConfigResponse>(`/projects/${projectId}/agents`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: threadsData } = useQuery({
    queryKey: ['project-threads', projectId],
    queryFn: () => api<{ threads?: Thread[]; data?: Thread[] }>(`/projects/${projectId}/threads`),
    enabled: !!projectId,
    staleTime: 15_000,
    retry: 1,
  });

  const { data: teamsData } = useQuery({
    queryKey: ['project-teams', projectId],
    queryFn: () => api<{ teams?: Team[]; data?: Team[] }>(`/projects/${projectId}/teams`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: routesData } = useQuery({
    queryKey: ['project-routes', projectId],
    queryFn: () => api<{ routes?: Route[]; data?: Route[] }>(`/projects/${projectId}/routes`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: runtimeData } = useQuery({
    queryKey: ['agent-runtime-status', orgId],
    queryFn: () => api<RuntimeStatus>(`/orgs/${orgId}/agent-runtime/status`),
    enabled: !!orgId,
    staleTime: 10_000,
    retry: 1,
  });

  const agents = normalizeAgents(agentsData);
  const threads = threadsData?.threads ?? threadsData?.data ?? [];
  const teams = teamsData?.teams ?? teamsData?.data ?? [];
  const routes = routesData?.routes ?? routesData?.data ?? [];
  const warmAgents = new Set(runtimeData?.warm_agents ?? []);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load agents" />;

  if (agents.length === 0) {
    const title = agentsData?.config_source === 'manifest'
      ? 'No repo-synced agents yet'
      : 'No agents synced for this project';
    const subtitle = agentsData?.config_source === 'manifest'
      ? 'This project has agent policy, but no concrete agents/teams have been synced from the repo yet.'
      : 'Sync the project repo to load agent definitions, teams, and chat routes.';
    return (
      <EmptyState
        icon={Bot}
        title={title}
        subtitle={subtitle}
      />
    );
  }

  const recentThreads = [...threads]
    .sort((a, b) => new Date(b.updated_at ?? b.created_at).getTime() - new Date(a.updated_at ?? a.created_at).getTime())
    .slice(0, 8);
  const warmCount = agents.filter((agent) => warmAgents.has(agent.slug) || agent.status === 'warm').length;
  const routableCount = agents.filter((agent) => agent.gateway_policy === 'routable').length;

  return (
    <div>
      {agentsData?.synced_at && (
        <div className="mb-4 text-label text-[var(--text-muted)]">
          Agent config synced {timeAgo(agentsData.synced_at)}
        </div>
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <StatPill label="Agents" value={agents.length} color="var(--purple)" />
        <StatPill label="Warm" value={warmCount} color="var(--green)" />
        <StatPill label="Routable" value={routableCount} color="var(--blue)" />
        <StatPill label="Teams" value={teams.length} />
        <StatPill label="Routes" value={routes.length} />
      </div>

      {/* Agent cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
        {agents.map((agent) => {
          const isWarm = warmAgents.has(agent.slug) || agent.status === 'warm';
          const permissionPolicy = permissionPolicyLabel(agent);

          return (
            <Card key={agent.id || agent.slug} accent="var(--purple)">
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${isWarm ? 'bg-[var(--green)]' : 'bg-[var(--text-muted)]'}`} />
                    <span className="text-body font-medium text-[var(--text-primary)]">{agent.name || agent.slug}</span>
                  </div>
                  {agent.harness_profile && (
                    <span className="font-mono text-label px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)]">
                      {agent.harness_profile}
                    </span>
                  )}
                </div>

                {agent.description && (
                  <p className="text-label text-[var(--text-secondary)] mb-3 line-clamp-2" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {agent.description}
                  </p>
                )}

                <div className="flex flex-wrap gap-2 mb-4">
                  <Badge color="var(--bg-3)" textColor="var(--text-secondary)">{gatewayPolicyLabel(agent)}</Badge>
                  {agent.workflow && (
                    <Badge color="var(--blue-dim)" textColor="var(--blue)">{agent.workflow}</Badge>
                  )}
                  {permissionPolicy && (
                    <Badge color="var(--amber-dim)" textColor="var(--amber)">{permissionPolicy}</Badge>
                  )}
                </div>

                <div className="flex items-center justify-between mt-auto">
                  <div className="text-label text-[var(--text-muted)]">
                    {agent.role ?? agent.slug}
                  </div>
                  <button
                    onClick={() => setChatAgent(agent)}
                    className="flex items-center gap-1.5 text-label font-medium px-2.5 py-1 rounded-md transition-colors"
                    style={{ color: 'var(--blue)', background: 'var(--blue-dim)' }}
                  >
                    <MessageSquare size={12} />
                    Thread
                  </button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {(teams.length > 0 || routes.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
          {teams.length > 0 && (
            <Card>
              <div className="p-4">
                <SectionHeading>Teams</SectionHeading>
                <div className="space-y-3">
                  {teams.map((team) => {
                    const lead = team.lead_agent_id ? agentsById.get(team.lead_agent_id) : null;
                    return (
                      <div key={team.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-3">
                        <div className="flex items-center justify-between gap-3 mb-1">
                          <div className="text-body font-medium text-[var(--text-primary)]">{team.id}</div>
                          <div className="text-label text-[var(--text-muted)]">{team.members.length} members</div>
                        </div>
                        <div className="text-label text-[var(--text-secondary)]">
                          Lead: {lead?.name ?? team.lead_agent_id ?? 'Unassigned'}
                        </div>
                        {team.dispatch && (
                          <div className="text-label text-[var(--text-muted)] mt-1">
                            Mode: {typeof team.dispatch.mode === 'string' ? team.dispatch.mode : 'custom'}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>
          )}

          {routes.length > 0 && (
            <Card>
              <div className="p-4">
                <SectionHeading>Chat Routes</SectionHeading>
                <div className="space-y-3">
                  {routes.map((route) => (
                    <div key={route.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-3">
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <div className="text-body font-medium text-[var(--text-primary)]">{route.id}</div>
                        <Badge color="var(--blue-dim)" textColor="var(--blue)">{readableRouteTarget(route.target)}</Badge>
                      </div>
                      <div className="font-mono text-label text-[var(--text-muted)] break-all">{route.match}</div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Recent Threads */}
      {recentThreads.length > 0 && (
        <div>
          <SectionHeading>Recent Threads</SectionHeading>
          <div className="bg-[var(--bg-1)] rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
            {recentThreads.map((thread) => {
              const title = thread.summary || thread.workspace_key || thread.key || `Thread ${thread.id.slice(0, 8)}`;
              return (
                <div key={thread.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Bot size={14} className="text-[var(--purple)] flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-body text-[var(--text-primary)] truncate">{title}</div>
                      <div className="text-label text-[var(--text-muted)] truncate">{thread.key}</div>
                    </div>
                  </div>
                  <span className="text-label text-[var(--text-muted)] flex-shrink-0 ml-4">
                    {timeAgo(thread.updated_at ?? thread.created_at)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chat slide-over */}
      <ChatSlideOver agent={chatAgent} orgId={orgId} onClose={() => setChatAgent(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat Slide-Over
// ---------------------------------------------------------------------------

function ChatSlideOver({ agent, orgId, onClose }: { agent: Agent | null; orgId: string; onClose: () => void }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Reset thread when agent changes
  useEffect(() => {
    setThreadId(null);
    setMessageText('');
  }, [agent?.id]);

  useEffect(() => {
    let cancelled = false;

    if (!agent || !orgId) {
      return () => { cancelled = true; };
    }

    const ensureThread = async () => {
      try {
        const thread = await api<{ id: string }>(`/orgs/${orgId}/threads`, {
          method: 'POST',
          body: JSON.stringify({ key: `agents:${agent.slug}` }),
        });
        if (!cancelled) {
          setThreadId(thread.id);
        }
      } catch (err) {
        console.error('Failed to ensure agent thread:', err);
      }
    };

    ensureThread();

    return () => {
      cancelled = true;
    };
  }, [agent, orgId]);

  // Fetch messages when we have a thread
  const { data: messagesData } = useQuery({
    queryKey: ['thread-messages', threadId],
    queryFn: () => api<{ messages?: ThreadMessage[]; data?: ThreadMessage[] }>(`/orgs/${orgId}/threads/${threadId}/messages`),
    enabled: !!threadId,
    refetchInterval: 3000,
  });

  const messages = messagesData?.messages ?? messagesData?.data ?? [];

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const sendMessage = useCallback(async () => {
    if (!messageText.trim() || !agent || sending) return;
    setSending(true);

    try {
      if (!threadId) {
        console.error('Failed to create thread');
        return;
      }

      await api(`/orgs/${orgId}/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: messageText,
          direction: 'inbound',
          actor_type: 'user',
        }),
      });

      setMessageText('');
      queryClient.invalidateQueries({ queryKey: ['thread-messages', threadId] });
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  }, [messageText, agent, threadId, orgId, sending, queryClient]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  return (
    <SlideOver
      open={!!agent}
      onClose={onClose}
      title={agent?.name ?? agent?.slug ?? 'Chat'}
      subtitle={agent?.harness_profile ? `${agent.harness_profile} profile` : undefined}
      width="w-[540px] max-w-[90vw]"
    >
      {/* Messages area */}
      <div className="flex flex-col h-[calc(100vh-200px)]">
        <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-label text-[var(--text-muted)]">
          This is the agent thread record for direct dashboard messages. Routed delivery still depends on the project's chat wiring.
        </div>

        <div className="flex-1 overflow-y-auto space-y-3 pb-4">
          {messages.length === 0 && !threadId && (
            <div className="text-center py-12">
              <Bot size={32} className="mx-auto mb-3 text-[var(--text-muted)]" />
              <div className="text-body text-[var(--text-secondary)]">Start a conversation with {agent?.name ?? 'this agent'}</div>
            </div>
          )}
          {messages.length === 0 && threadId && (
            <div className="text-center py-8 text-label text-[var(--text-muted)]">Waiting for response...</div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${isUserMessage(msg) ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className="max-w-[80%] rounded-lg px-3 py-2 text-body"
                style={{
                  background: isUserMessage(msg) ? 'var(--blue)' : 'var(--bg-2)',
                  color: isUserMessage(msg) ? '#fff' : 'var(--text-primary)',
                }}
              >
                <div className="whitespace-pre-wrap break-words">{getMessageBody(msg)}</div>
                <div
                  className="text-label mt-1"
                  style={{ opacity: 0.6 }}
                >
                  {timeAgo(msg.created_at)}
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex items-end gap-2 pt-3 border-t border-[var(--border)]">
          <textarea
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 bg-[var(--bg-2)] rounded-lg px-3 py-2 text-body outline-none resize-none border border-[var(--border)] focus:border-[var(--blue)] transition-colors"
            style={{ maxHeight: 120, minHeight: 36, color: 'var(--text-primary)' }}
          />
          <button
            onClick={sendMessage}
            disabled={!messageText.trim() || sending}
            className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors disabled:opacity-40"
            style={{ background: 'var(--blue)', color: '#fff' }}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </SlideOver>
  );
}

// ---------------------------------------------------------------------------
// Pipelines Tab
// ---------------------------------------------------------------------------

function PipelinesTab({ projectId }: { projectId: string }) {
  const [expandedPipeline, setExpandedPipeline] = useState<string | null>(null);

  const { data: pipelinesData, isLoading, error } = useQuery({
    queryKey: ['project-pipelines', projectId],
    queryFn: () => api<{ pipelines?: RawPipeline[]; data?: RawPipeline[] }>(`/projects/${projectId}/pipelines`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const pipelines = normalizePipelines(pipelinesData);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load pipelines" />;

  if (pipelines.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No pipelines configured"
        subtitle="Define pipelines in your .eve/manifest.yaml to see them here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {pipelines.map((pipeline) => {
        const isExpanded = expandedPipeline === pipeline.name;
        return (
          <Card key={pipeline.name}>
            <div
              className="p-4 cursor-pointer"
              onClick={() => setExpandedPipeline(isExpanded ? null : pipeline.name)}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <GitBranch size={16} className="text-[var(--blue)]" />
                  <span className="text-body font-medium text-[var(--text-primary)]">{pipeline.name}</span>
                </div>
                {pipeline.trigger && (
                  <Badge color="var(--blue-dim)" textColor="var(--blue)">{pipeline.trigger}</Badge>
                )}
              </div>

              {/* Step visualization */}
              {pipeline.steps && pipeline.steps.length > 0 && (
                <div className="flex items-center gap-1 mt-3">
                  {pipeline.steps.map((step, i) => (
                    <div key={i} className="flex items-center gap-1">
                      {i > 0 && <div className="w-4 h-px bg-[var(--border-bright)]" />}
                      <StepIndicator name={step.name} status={step.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {isExpanded && (
              <div className="border-t border-[var(--border)] px-4 py-3">
                <PipelineRuns projectId={projectId} pipelineName={pipeline.name} />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function StepIndicator({ name, status }: { name: string; status?: string }) {
  const bg =
    status === 'done' || status === 'completed' || status === 'success'
      ? 'var(--green)'
      : status === 'running' || status === 'active'
        ? 'var(--blue)'
        : status === 'failed' || status === 'error'
          ? 'var(--red)'
          : 'var(--text-muted)';
  const symbol =
    status === 'done' || status === 'completed' || status === 'success'
      ? '\u2713'
      : status === 'running' || status === 'active'
        ? '\u25CF'
        : status === 'failed' || status === 'error'
          ? '\u2717'
          : '\u2014';

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded-full text-label font-bold"
        style={{ background: bg, color: '#fff', fontSize: 10 }}
      >
        {symbol}
      </span>
      <span className="text-label text-[var(--text-secondary)]">{name}</span>
    </div>
  );
}

function PipelineRuns({ projectId, pipelineName }: { projectId: string; pipelineName: string }) {
  const { data: runsData, isLoading } = useQuery({
    queryKey: ['pipeline-runs', projectId, pipelineName],
    queryFn: () => api<{ runs?: PipelineRun[]; data?: PipelineRun[] }>(`/projects/${projectId}/pipelines/${encodeURIComponent(pipelineName)}/runs`),
    enabled: !!projectId,
    staleTime: 15_000,
    retry: 1,
  });

  const runs = runsData?.runs ?? runsData?.data ?? [];

  if (isLoading) return <div className="text-label text-[var(--text-muted)] py-2">Loading runs...</div>;
  if (runs.length === 0) return <div className="text-label text-[var(--text-muted)] py-2">No runs yet</div>;

  return (
    <div className="space-y-1.5">
      <div className="text-label text-[var(--text-muted)] uppercase tracking-wide mb-1">Recent Runs</div>
      {runs.slice(0, 5).map((run) => (
        <div key={run.id} className="flex items-center justify-between py-1.5 text-body">
          <div className="flex items-center gap-2">
            <HealthDot status={run.status === 'completed' || run.status === 'success' ? 'healthy' : run.status === 'failed' ? 'failed' : run.status === 'running' ? 'deploying' : 'unknown'} />
            <span className="font-mono text-label text-[var(--text-secondary)]">{run.id.slice(0, 10)}</span>
          </div>
          <span className="text-label text-[var(--text-muted)]">
            {timeAgo(run.completed_at ?? run.started_at ?? run.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflows Tab
// ---------------------------------------------------------------------------

function WorkflowsTab({ projectId }: { projectId: string }) {
  const { data: workflowsData, isLoading, error } = useQuery({
    queryKey: ['project-workflows', projectId],
    queryFn: () => api<{ workflows?: RawWorkflowDef[]; data?: RawWorkflowDef[] }>(`/projects/${projectId}/workflows`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const workflows = normalizeWorkflows(workflowsData);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load workflows" />;

  if (workflows.length === 0) {
    return (
      <EmptyState
        icon={Workflow}
        title="No workflows configured"
        subtitle="Define workflows in your .eve/manifest.yaml to automate multi-step processes."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {workflows.map((wf, i) => (
        <Card key={wf.id ?? wf.name ?? i}>
          <div className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-body font-medium text-[var(--text-primary)]">{wf.name}</span>
              {wf.trigger_label && (
                <Badge color="var(--amber-dim)" textColor="var(--amber)">{wf.trigger_label}</Badge>
              )}
            </div>

            {/* Step sequence */}
            {wf.steps && wf.steps.length > 0 && (
              <div className="space-y-1 mt-3 mb-3">
                {wf.steps.map((step, si) => (
                  <div key={si} className="flex items-center gap-2 text-label">
                    <span className="w-5 h-5 rounded-full bg-[var(--bg-3)] text-[var(--text-muted)] flex items-center justify-center text-label font-mono" style={{ fontSize: 10 }}>
                      {si + 1}
                    </span>
                    <span className="text-[var(--text-secondary)]">{step.name}</span>
                    {step.agent && (
                      <span className="text-[var(--purple)] font-mono text-label">@{step.agent}</span>
                    )}
                    {step.condition && (
                      <span className="text-[var(--text-muted)] italic">if {step.condition}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-4 text-label text-[var(--text-muted)] mt-2">
              {wf.permission_mode && (
                <span>Mode: {wf.permission_mode}</span>
              )}
              {wf.timeout_seconds != null && (
                <span>{wf.timeout_seconds}s timeout</span>
              )}
              {wf.api_count != null && wf.api_count > 0 && (
                <span>{wf.api_count} API{wf.api_count > 1 ? 's' : ''}</span>
              )}
              {wf.last_triggered_at && (
                <span>Last: {timeAgo(wf.last_triggered_at)}</span>
              )}
              {wf.daily_run_count != null && (
                <span>{wf.daily_run_count} runs today</span>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integrations Tab
// ---------------------------------------------------------------------------

function IntegrationsTab({ orgId }: { orgId: string }) {
  const { data: intData, isLoading, error } = useQuery({
    queryKey: ['org-integrations', orgId],
    queryFn: () => api<{ integrations?: Integration[]; data?: Integration[] }>(`/orgs/${orgId}/integrations`),
    enabled: !!orgId,
    staleTime: 30_000,
    retry: 1,
  });

  const integrations = intData?.integrations ?? intData?.data ?? [];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load integrations" />;

  const providerNames: Record<string, string> = {
    github: 'GitHub',
    google_drive: 'Google Drive',
    'google-drive': 'Google Drive',
    slack: 'Slack',
    nostr: 'Nostr',
    webhook: 'Webhook',
  };

  if (integrations.length === 0) {
    return (
      <EmptyState
        icon={Link2}
        title="No integrations configured"
        subtitle="Connect GitHub, Slack, or other services to enable event-driven workflows."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {integrations.map((integ) => {
        const provider = integ.provider ?? integ.type ?? 'integration';
        const label = providerNames[provider] ?? provider.replace(/[_-]/g, ' ');
        const isConnected = integ.status === 'connected' || integ.status === 'active';
        return (
          <Card key={integ.id}>
            <div className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-[var(--bg-3)] border border-[var(--border)] flex items-center justify-center text-label font-semibold text-[var(--text-secondary)] uppercase">
                  {label.slice(0, 2)}
                </div>
                <div>
                  <div className="text-body font-medium text-[var(--text-primary)]">{integ.name ?? label}</div>
                  <div className="text-label text-[var(--text-muted)]">{integ.account_id ?? provider}</div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[var(--green)]' : 'bg-[var(--text-muted)]'}`} />
                  <span className="text-label text-[var(--text-secondary)]">
                    {isConnected ? 'Connected' : integ.status ?? 'Disconnected'}
                  </span>
                </div>
                <span className="text-label text-[var(--text-muted)]">
                  {timeAgo(integ.updated_at ?? integ.created_at ?? new Date().toISOString())}
                </span>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Releases Tab
// ---------------------------------------------------------------------------

function ReleasesTab({ projectId }: { projectId: string }) {
  const { data: relData, isLoading, error } = useQuery({
    queryKey: ['project-releases', projectId],
    queryFn: () => api<{ releases?: Release[]; data?: Release[] }>(`/projects/${projectId}/releases?limit=20`),
    enabled: !!projectId,
    staleTime: 15_000,
    retry: 1,
  });

  const releases = relData?.releases ?? relData?.data ?? [];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load releases" />;

  if (releases.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No releases yet"
        subtitle="Create a release by running a pipeline or using eve release create."
      />
    );
  }

  return (
    <div className="bg-[var(--bg-1)] rounded-lg border border-[var(--border)] overflow-hidden">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Tag</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">SHA</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Environment</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Created By</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Date</th>
            <th className="w-12"></th>
          </tr>
        </thead>
        <tbody>
          {releases.map((rel) => (
            <tr key={rel.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-2)] transition-colors">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[var(--text-primary)]">{rel.tag}</span>
                  {rel.is_active && (
                    <Badge color="var(--green-dim)" textColor="var(--green)">active</Badge>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 font-mono text-label text-[var(--text-secondary)]">{shortSha(rel.git_sha)}</td>
              <td className="px-4 py-3 text-[var(--text-secondary)]">{rel.environment ?? '\u2014'}</td>
              <td className="px-4 py-3 text-[var(--text-secondary)]">{rel.created_by ?? '\u2014'}</td>
              <td className="px-4 py-3 text-label text-[var(--text-muted)]">{formatDate(rel.created_at)}</td>
              <td className="px-4 py-3">
                <ExternalLink size={14} className="text-[var(--text-muted)]" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedules Tab
// ---------------------------------------------------------------------------

function SchedulesTab({ projectId }: { projectId: string }) {
  const { data: schedData, isLoading, error } = useQuery({
    queryKey: ['project-schedules', projectId],
    queryFn: () => api<{ schedules?: Schedule[]; data?: Schedule[] }>(`/projects/${projectId}/schedules?limit=20`),
    enabled: !!projectId,
    staleTime: 15_000,
    retry: 1,
  });

  const schedules = schedData?.schedules ?? schedData?.data ?? [];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load schedules" />;

  if (schedules.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="No schedules configured"
        subtitle="Define cron schedules in your manifest or via eve schedule create."
      />
    );
  }

  return (
    <div className="bg-[var(--bg-1)] rounded-lg border border-[var(--border)] overflow-hidden">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Name</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Cron</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Human</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Next Run</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Last Run</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Status</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((sched) => {
            const isActive = sched.status === 'active' || sched.enabled !== false;
            const name = sched.name ?? sched.event_type ?? sched.id;
            return (
              <tr key={sched.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-2)] transition-colors">
                <td className="px-4 py-3 text-[var(--text-primary)] font-medium">{name}</td>
                <td className="px-4 py-3 font-mono text-label text-[var(--text-secondary)]">{sched.cron}</td>
                <td className="px-4 py-3 text-label text-[var(--text-secondary)]">{cronToHuman(sched.cron)}</td>
                <td className="px-4 py-3 text-label text-[var(--text-muted)]">{formatDate(sched.next_run_at)}</td>
                <td className="px-4 py-3 text-label text-[var(--text-muted)]">{sched.last_run_at ? timeAgo(sched.last_run_at) : '\u2014'}</td>
                <td className="px-4 py-3">
                  <Badge
                    color={isActive ? 'var(--green-dim)' : 'var(--bg-3)'}
                    textColor={isActive ? 'var(--green)' : 'var(--text-muted)'}
                  >
                    {isActive ? 'Active' : 'Paused'}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members Tab
// ---------------------------------------------------------------------------

function MembersTab({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<{ data: ProjectMember[] }>(`/projects/${projectId}/members`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const members = data?.data ?? [];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load project members" />;

  if (members.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No explicit project members"
        subtitle="This project currently inherits access from org membership only."
      />
    );
  }

  const roleCounts = {
    owner: members.filter((member) => member.role === 'owner').length,
    admin: members.filter((member) => member.role === 'admin').length,
    member: members.filter((member) => member.role === 'member').length,
  };

  const roleStyles: Record<ProjectMember['role'], { bg: string; fg: string }> = {
    owner: { bg: 'var(--purple-dim)', fg: 'var(--purple)' },
    admin: { bg: 'var(--blue-dim)', fg: 'var(--blue)' },
    member: { bg: 'var(--bg-3)', fg: 'var(--text-secondary)' },
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <StatPill label="Owners" value={roleCounts.owner} color="var(--purple)" />
        <StatPill label="Admins" value={roleCounts.admin} color="var(--blue)" />
        <StatPill label="Members" value={roleCounts.member} />
      </div>

      <div className="bg-[var(--bg-1)] rounded-lg border border-[var(--border)] overflow-hidden">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Person</th>
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Role</th>
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">User ID</th>
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Added</th>
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Updated</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const roleStyle = roleStyles[member.role];
              const initials = (member.display_name ?? member.email).slice(0, 2).toUpperCase();

              return (
                <tr key={member.user_id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-2)] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-full bg-[var(--bg-3)] border border-[var(--border)] flex items-center justify-center text-label font-semibold text-[var(--text-secondary)] flex-shrink-0">
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <div className="text-body font-medium text-[var(--text-primary)] truncate">
                          {member.display_name ?? member.email}
                        </div>
                        <div className="text-label text-[var(--text-muted)] truncate">{member.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={roleStyle.bg} textColor={roleStyle.fg}>{member.role}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-label text-[var(--text-secondary)]">{member.user_id}</td>
                  <td className="px-4 py-3 text-label text-[var(--text-secondary)]">{formatDate(member.created_at)}</td>
                  <td className="px-4 py-3 text-label text-[var(--text-muted)]">{timeAgo(member.updated_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-label text-[var(--text-muted)]">
        Shows explicit project memberships. Org-wide membership may still grant broader read access outside this table.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ProjectPage
// ---------------------------------------------------------------------------

export function ProjectPage() {
  const { selectedProject, activeOrg, selectedEnv } = useOutletContext<LayoutContext>();
  const [activeTab, setActiveTab] = useState<TabId>('architecture');

  // Fetch agent and pipeline counts for tab badges
  const projectId = selectedProject?.id ?? null;
  const orgId = activeOrg?.id ?? '';

  const { data: agentsData } = useQuery({
    queryKey: ['project-agents', projectId],
    queryFn: () => api<AgentConfigResponse>(`/projects/${projectId}/agents`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: pipelinesData } = useQuery({
    queryKey: ['project-pipelines', projectId],
    queryFn: () => api<{ pipelines?: RawPipeline[]; data?: RawPipeline[] }>(`/projects/${projectId}/pipelines`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const agentCount = normalizeAgents(agentsData).length;
  const pipelineCount = normalizePipelines(pipelinesData).length;

  const badgeCounts: Record<string, number> = {
    agents: agentCount,
    pipelines: pipelineCount,
  };

  // No project selected
  if (!selectedProject) {
    return (
      <div className="page">
        <div className="page-inner">
          <h1 className="page-title mb-4">App detail</h1>
          <div className="card card-pad py-14 text-center">
            <div className="w-12 h-12 rounded-xl bg-[var(--bg-3)] flex items-center justify-center mx-auto mb-4">
              <Zap size={24} className="text-[var(--text-muted)]" />
            </div>
            <div className="text-body text-[var(--text-secondary)]">
              Pick an app from the Apps page (or the top bar) to see its anatomy
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="px-4 sm:px-6 pt-5 pb-0 flex-shrink-0">
        <h1 className="page-title mb-1">{selectedProject.name}</h1>
        {selectedProject.repo_url && (
          <a
            href={selectedProject.repo_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-label text-[var(--text-muted)] hover:text-[var(--blue)] transition-colors"
          >
            <ExternalLink size={11} />
            {selectedProject.repo_url.replace(/^https?:\/\//, '').replace(/\.git$/, '')}
          </a>
        )}
      </div>

      {/* Tab bar */}
      <div className="px-4 sm:px-6 flex-shrink-0">
        <div className="chip-row border-b mt-3" style={{ borderColor: 'var(--border)' }}>
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const count = tab.badgeKey ? badgeCounts[tab.badgeKey] : undefined;

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="relative flex items-center gap-1.5 px-3 py-2.5 text-body transition-colors whitespace-nowrap flex-shrink-0"
                style={{
                  color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {tab.label}
                {count != null && count > 0 && (
                  <span
                    className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-label px-1"
                    style={{
                      background: isActive ? 'var(--blue-dim)' : 'var(--bg-3)',
                      color: isActive ? 'var(--blue)' : 'var(--text-muted)',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {count}
                  </span>
                )}
                {/* Active underline */}
                {isActive && (
                  <span
                    className="absolute bottom-0 left-2 right-2 h-[2.5px] rounded-t horizon-bar"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        {activeTab === 'architecture' && (
          <ArchitectureTab projectId={selectedProject.id} envName={selectedEnv} />
        )}
        {activeTab === 'agents' && (
          <AgentsTab projectId={selectedProject.id} orgId={orgId} />
        )}
        {activeTab === 'pipelines' && (
          <PipelinesTab projectId={selectedProject.id} />
        )}
        {activeTab === 'workflows' && (
          <WorkflowsTab projectId={selectedProject.id} />
        )}
        {activeTab === 'integrations' && (
          <IntegrationsTab orgId={orgId} />
        )}
        {activeTab === 'releases' && (
          <ReleasesTab projectId={selectedProject.id} />
        )}
        {activeTab === 'schedules' && (
          <SchedulesTab projectId={selectedProject.id} />
        )}
        {activeTab === 'members' && (
          <MembersTab projectId={selectedProject.id} />
        )}
      </div>
    </div>
  );
}
