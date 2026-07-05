// ---------------------------------------------------------------------------
// Architecture tab — SVG topology / graph-layout engine (pure TS, no JSX)
// ---------------------------------------------------------------------------

import type { Agent } from './shared';

export interface ManifestService {
  image?: string;
  type?: string;
  [key: string]: unknown;
}

export interface ManifestSnapshot {
  id?: string;
  updated_at?: string;
  warnings?: string[];
  services?: Record<string, ManifestService> | null;
  environments?: Record<string, Record<string, unknown>> | null;
}

export interface EnvHealthData {
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

export interface TopoNode {
  id: string;
  label: string;
  type: 'ingress' | 'service' | 'platform' | 'data' | 'agent';
  status: string;
  replicas?: number;
  readyReplicas?: number;
  pods?: Array<{ name: string; status: string; ready: boolean; restarts?: number }>;
}

export interface TopoEdge {
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

export function buildTopology(
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

export const NODE_W = 150;
export const NODE_H = 48;
export const LAYER_GAP = 72;
export const NODE_GAP = 16;

export const typeColors: Record<string, string> = {
  ingress: 'var(--green)',
  service: 'var(--blue)',
  platform: 'var(--amber)',
  data: 'var(--cyan)',
  agent: 'var(--purple)',
};
