import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { Badge } from '@/components/badge';
import { EmptyState } from '@/components/empty-state';
import { HealthDot } from '@/components/health-dot';
import { LoadingState } from '@/components/loading-state';
import { StatPill } from '@/components/stat-pill';
import { useProjectEnvs } from '@/hooks/use-environments';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { normalizeAgents, type AgentConfigResponse, type Route } from '../shared';
import {
  buildTopology,
  NODE_W,
  NODE_H,
  LAYER_GAP,
  NODE_GAP,
  typeColors,
  type TopoNode,
  type ManifestSnapshot,
  type EnvHealthData,
} from '../topology';

// ---------------------------------------------------------------------------
// Architecture Tab — SVG Topology
// ---------------------------------------------------------------------------

export function ArchitectureTab({
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
