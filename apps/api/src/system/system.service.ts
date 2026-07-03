import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { Inject } from '@nestjs/common';
import type { Db } from '@eve/db';
import { systemSettingsQueries, userQueries, environmentHealthQueries } from '@eve/db';
import type { HealthStatus } from '@eve/db';

export interface SystemStatusResponse {
  api: {
    status: 'healthy';
    version: string;
  };
  agent_runtime?: {
    status: string;
    ready: boolean;
    replicas?: number;
  };
  orchestrator?: {
    status: string;
    ready: boolean;
    replicas?: number;
  };
  worker?: {
    status: string;
    ready: boolean;
    replicas?: number;
  };
  postgres?: {
    status: string;
    ready: boolean;
  };
}

export interface PodInfo {
  name: string;
  namespace: string;
  phase: string;
  ready: boolean;
  restarts: number;
  age: string;
  labels: Record<string, string>;
  component?: string;
  orgId?: string;
  projectId?: string;
  env?: string;
}

export interface EventInfo {
  type: string;
  reason: string;
  message: string;
  timestamp: string;
  involvedObject: {
    kind: string;
    name: string;
    namespace: string;
  };
}

export interface ConfigSummary {
  namespace: string;
  clusterVersion?: string;
  nodeCount?: number;
  deployments: string[];
}

export interface SystemEnvironment {
  id: string;
  project_id: string;
  name: string;
  type: string;
  namespace: string | null;
  current_release: string | null;
  created_at: string;
  updated_at: string;
}

export interface LogEntry {
  timestamp: string;
  line: string;
}

/**
 * System Service - Kubernetes debugging and monitoring
 *
 * Provides access to cluster state, logs, and events for debugging.
 * Enforces RBAC based on admin scopes:
 * - org_admin: Can only see resources for their org (eve.org_id label)
 * - system_admin: Full cluster visibility
 */
@Injectable()
export class SystemService {
  private kc?: k8s.KubeConfig;
  private k8sApi?: k8s.CoreV1Api;
  private k8sAppsApi?: k8s.AppsV1Api;
  private k8sNetworkingApi?: k8s.NetworkingV1Api;
  private k8sAvailable = false;
  private readonly healthChecks;

  constructor(@Inject('DB') private readonly db: Db) {
    this.healthChecks = environmentHealthQueries(db);
    // Try to load config (in-cluster or kubeconfig)
    try {
      this.kc = new k8s.KubeConfig();
      this.kc.loadFromDefault();
      this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
      this.k8sAppsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      this.k8sNetworkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
      this.k8sAvailable = true;
    } catch (error) {
      // If no k8s config available, service will throw NotFound on all operations
      this.k8sAvailable = false;
    }
  }

  /**
   * Get system status (API + k8s components)
   */
  async getStatus(userRole?: string, orgId?: string): Promise<SystemStatusResponse> {
    const response: SystemStatusResponse = {
      api: {
        status: 'healthy',
        version: process.env.EVE_VERSION || 'dev',
      },
    };

    // If not in k8s, return minimal status
    if (!this.isK8sAvailable()) {
      return response;
    }

    try {
      // Get namespace (default: 'eve')
      const namespace = process.env.EVE_K8S_NAMESPACE || process.env.EVE_NAMESPACE || 'eve';

      // Get orchestrator deployment
      try {
        const orchestratorDep = await this.k8sAppsApi!.readNamespacedDeployment({ name: 'eve-orchestrator', namespace });
        response.orchestrator = {
          status: orchestratorDep.status?.conditions?.find((c: any) => c.type === 'Available')?.status === 'True' ? 'running' : 'degraded',
          ready: (orchestratorDep.status?.readyReplicas ?? 0) > 0,
          replicas: orchestratorDep.status?.replicas,
        };
      } catch {
        response.orchestrator = { status: 'unknown', ready: false };
      }

      // Get agent runtime statefulset
      try {
        const agentRuntimeSts = await this.k8sAppsApi!.readNamespacedStatefulSet({ name: 'eve-agent-runtime', namespace });
        response.agent_runtime = {
          status: agentRuntimeSts.status?.readyReplicas === agentRuntimeSts.status?.replicas ? 'running' : 'degraded',
          ready: (agentRuntimeSts.status?.readyReplicas ?? 0) > 0,
          replicas: agentRuntimeSts.status?.replicas,
        };
      } catch {
        response.agent_runtime = { status: 'unknown', ready: false };
      }

      // Get worker deployment
      try {
        const workerDep = await this.k8sAppsApi!.readNamespacedDeployment({ name: 'eve-worker', namespace });
        response.worker = {
          status: workerDep.status?.conditions?.find((c: any) => c.type === 'Available')?.status === 'True' ? 'running' : 'degraded',
          ready: (workerDep.status?.readyReplicas ?? 0) > 0,
          replicas: workerDep.status?.replicas,
        };
      } catch {
        response.worker = { status: 'unknown', ready: false };
      }

      // Get postgres statefulset (name is "postgres" in k8s manifests)
      try {
        let pgSts;
        try {
          pgSts = await this.k8sAppsApi!.readNamespacedStatefulSet({ name: 'postgres', namespace });
        } catch {
          pgSts = await this.k8sAppsApi!.readNamespacedStatefulSet({ name: 'eve-postgres', namespace });
        }
        response.postgres = {
          status: pgSts.status?.readyReplicas === pgSts.status?.replicas ? 'running' : 'degraded',
          ready: (pgSts.status?.readyReplicas ?? 0) > 0,
        };
      } catch {
        response.postgres = { status: 'unknown', ready: false };
      }
    } catch (error) {
      // If any k8s API call fails, return partial response
      console.error('Failed to get k8s status:', error);
    }

    return response;
  }

  /**
   * Get recent logs for a service
   */
  async getLogs(
    service: 'api' | 'orchestrator' | 'worker' | 'agent-runtime' | 'postgres',
    userRole?: string,
    orgId?: string,
    tailLines: number = 100
  ): Promise<LogEntry[]> {
    this.ensureK8sAvailable();

    const namespace = process.env.EVE_K8S_NAMESPACE || process.env.EVE_NAMESPACE || 'eve';

    // Map service name to pod selector
    const selectorMap: Record<string, string> = {
      api: 'app=eve-api',
      orchestrator: 'app=eve-orchestrator',
      worker: 'app=eve-worker',
      'agent-runtime': 'app.kubernetes.io/name=eve-agent-runtime',
      postgres: 'app.kubernetes.io/name=postgres',
    };

    let selector = selectorMap[service];
    if (!selector) {
      throw new NotFoundException(`Unknown service: ${service}`);
    }

    if (userRole === 'org_admin' && orgId) {
      selector = `${selector},eve.org_id=${orgId}`;
    }

    try {
      // List pods matching selector
      const podsResponse = await this.k8sApi!.listNamespacedPod({
        namespace,
        labelSelector: selector,
      });

      if (podsResponse.items.length === 0) {
        return [];
      }

      // Get logs from the first pod
      const pod = podsResponse.items[0];
      const podName = pod.metadata?.name;

      if (!podName) {
        return [];
      }

      const logsResponse = await this.k8sApi!.readNamespacedPodLog({
        name: podName,
        namespace,
        tailLines,
      });

      // Parse logs into entries
      const logText = logsResponse;
      const lines = logText.split('\n').filter((line: string) => line.trim());

      return lines.map((line: string) => {
        // Try to extract timestamp from log line (basic heuristic)
        const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\s]*)/);
        return {
          timestamp: timestampMatch ? timestampMatch[1] : new Date().toISOString(),
          line: line,
        };
      });
    } catch (error) {
      throw new NotFoundException(`Failed to get logs for ${service}: ${error}`);
    }
  }

  async listEnvs(
    params: { orgId?: string; projectId?: string; limit?: number; offset?: number },
    userRole?: string,
    userOrgId?: string,
  ): Promise<{ environments: SystemEnvironment[]; total: number }> {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    let orgId = params.orgId;

    if (userRole === 'org_admin') {
      if (!userOrgId) {
        throw new ForbiddenException('Missing org scope for org_admin');
      }
      if (orgId && orgId !== userOrgId) {
        throw new ForbiddenException('org_admin can only access their own org');
      }
      orgId = userOrgId;
    }

    const conditions: string[] = [];
    const values: Array<string | number> = [];

    if (orgId) {
      values.push(orgId);
      conditions.push(`p.org_id = $${values.length}`);
    }

    if (params.projectId) {
      values.push(params.projectId);
      conditions.push(`e.project_id = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);
    const limitParam = `$${values.length - 1}`;
    const offsetParam = `$${values.length}`;

    const sql = `
      SELECT
        e.id,
        e.project_id,
        e.name,
        e.type,
        e.namespace,
        e.current_release_id,
        e.created_at,
        e.updated_at
      FROM environments e
      JOIN projects p ON p.id = e.project_id
      ${whereClause}
      ORDER BY e.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const rows = await this.db.unsafe(sql, values);

    return {
      environments: rows.map((row: any) => ({
        id: row.id,
        project_id: row.project_id,
        name: row.name,
        type: row.type,
        namespace: row.namespace,
        current_release: row.current_release_id,
        created_at: row.created_at?.toISOString?.() ?? String(row.created_at),
        updated_at: row.updated_at?.toISOString?.() ?? String(row.updated_at),
      })),
      total: rows.length,
    };
  }

  /**
   * Get list of pods with status
   */
  async getPods(userRole?: string, orgId?: string): Promise<PodInfo[]> {
    this.ensureK8sAvailable();

    try {
      const podsResponse = await this.k8sApi!.listPodForAllNamespaces({});
      let pods = podsResponse.items;

      // Filter by org_id for org_admin
      if (userRole === 'org_admin' && orgId) {
        pods = pods.filter((pod: any) => pod.metadata?.labels?.['eve.org_id'] === orgId);
      }

      return pods.map((pod: any) => {
        const labels = pod.metadata?.labels || {};
        const containerStatuses = pod.status?.containerStatuses || [];
        const ready = containerStatuses.every((cs: any) => cs.ready);
        const restarts = containerStatuses.reduce((sum: number, cs: any) => sum + (cs.restartCount || 0), 0);

        const creationTime = pod.metadata?.creationTimestamp;
        const age = creationTime ? this.getAge(new Date(creationTime)) : 'unknown';

        return {
          name: pod.metadata?.name || '',
          namespace: pod.metadata?.namespace || '',
          phase: pod.status?.phase || 'Unknown',
          ready,
          restarts,
          age,
          labels,
          component: labels['eve.component'],
          orgId: labels['eve.org_id'],
          projectId: labels['eve.project_id'],
          env: labels['eve.env'],
        };
      });
    } catch (error) {
      throw new NotFoundException(`Failed to list pods: ${error}`);
    }
  }

  /**
   * Get recent cluster events
   */
  async getEvents(userRole?: string, orgId?: string, limit: number = 50): Promise<EventInfo[]> {
    this.ensureK8sAvailable();

    try {
      const eventsResponse = await this.k8sApi!.listEventForAllNamespaces({});
      let events = eventsResponse.items;

      if (userRole === 'org_admin' && orgId) {
        const filtered = await Promise.all(
          events.map(async (event: any) => ({
            event,
            allowed: await this.eventMatchesOrg(event, orgId),
          }))
        );
        events = filtered.filter((entry) => entry.allowed).map((entry) => entry.event);
      }

      // Sort by timestamp (newest first)
      events.sort((a: any, b: any) => {
        const timeA = a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp || '';
        const timeB = b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp || '';
        return timeB.localeCompare(timeA);
      });

      // Take only the most recent events
      events = events.slice(0, limit);

      return events.map((event: any) => ({
        type: event.type || 'Normal',
        reason: event.reason || '',
        message: event.message || '',
        timestamp: event.lastTimestamp || event.eventTime || event.metadata?.creationTimestamp || '',
        involvedObject: {
          kind: event.involvedObject.kind || '',
          name: event.involvedObject.name || '',
          namespace: event.involvedObject.namespace || '',
        },
      }));
    } catch (error) {
      throw new NotFoundException(`Failed to list events: ${error}`);
    }
  }

  private async eventMatchesOrg(event: any, orgId: string): Promise<boolean> {
    const involved = event?.involvedObject;
    const kind = involved?.kind;
    const name = involved?.name;
    const namespace = involved?.namespace;

    if (!kind || !name || !namespace) {
      return false;
    }

    try {
      switch (kind) {
        case 'Pod': {
          const pod = await this.k8sApi!.readNamespacedPod({ name, namespace });
          return pod.metadata?.labels?.['eve.org_id'] === orgId;
        }
        case 'Service': {
          const service = await this.k8sApi!.readNamespacedService({ name, namespace });
          return service.metadata?.labels?.['eve.org_id'] === orgId;
        }
        case 'Deployment': {
          const deployment = await this.k8sAppsApi!.readNamespacedDeployment({ name, namespace });
          return deployment.metadata?.labels?.['eve.org_id'] === orgId;
        }
        case 'StatefulSet': {
          const statefulSet = await this.k8sAppsApi!.readNamespacedStatefulSet({ name, namespace });
          return statefulSet.metadata?.labels?.['eve.org_id'] === orgId;
        }
        case 'ReplicaSet': {
          const replicaSet = await this.k8sAppsApi!.readNamespacedReplicaSet({ name, namespace });
          return replicaSet.metadata?.labels?.['eve.org_id'] === orgId;
        }
        case 'Ingress': {
          const ingress = await this.k8sNetworkingApi!.readNamespacedIngress({ name, namespace });
          return ingress.metadata?.labels?.['eve.org_id'] === orgId;
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Get deployment config summary
   */
  async getConfig(userRole?: string, orgId?: string): Promise<ConfigSummary> {
    this.ensureK8sAvailable();

    // Only system_admin can view cluster config
    if (userRole === 'org_admin') {
      throw new ForbiddenException('org_admin cannot view cluster configuration');
    }

    const namespace = process.env.EVE_K8S_NAMESPACE || process.env.EVE_NAMESPACE || 'eve';

    try {
      // Get cluster version
      let clusterVersion: string | undefined;
      try {
        const versionInfo = await this.k8sApi!.getAPIResources();
        clusterVersion = versionInfo.groupVersion;
      } catch {
        clusterVersion = undefined;
      }

      // Get node count
      let nodeCount: number | undefined;
      try {
        const nodesResponse = await this.k8sApi!.listNode();
        nodeCount = nodesResponse.items.length;
      } catch {
        nodeCount = undefined;
      }

      // Get deployments
      const deploymentsResponse = await this.k8sAppsApi!.listNamespacedDeployment({ namespace });
      const deployments = deploymentsResponse.items.map((d: any) => d.metadata?.name || '').filter(Boolean);

      return {
        namespace,
        clusterVersion,
        nodeCount,
        deployments,
      };
    } catch (error) {
      throw new NotFoundException(`Failed to get config: ${error}`);
    }
  }

  /**
   * Check if k8s is available
   */
  private isK8sAvailable(): boolean {
    return this.k8sAvailable;
  }

  /**
   * Ensure k8s is available or throw
   */
  private ensureK8sAvailable(): void {
    if (!this.isK8sAvailable()) {
      throw new NotFoundException('Kubernetes API not available');
    }
  }

  /**
   * Calculate age from creation time
   */
  private getAge(createdAt: Date): string {
    const now = new Date();
    const diff = now.getTime() - createdAt.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  /**
   * Get environment health status across all orgs.
   * Returns a summary and list of environment health checks.
   */
  async getEnvHealth(opts?: {
    status?: HealthStatus;
    limit?: number;
    offset?: number;
  }) {
    const [summary, environments] = await Promise.all([
      this.healthChecks.summary(),
      this.healthChecks.listAll({
        status: opts?.status,
        limit: opts?.limit ?? 100,
        offset: opts?.offset ?? 0,
      }),
    ]);
    return { summary, environments };
  }

  /**
   * Get all system settings
   */
  async getSettings() {
    const settings = systemSettingsQueries(this.db);
    return settings.list();
  }

  /**
   * Get a specific system setting
   */
  async getSetting(key: string) {
    const settings = systemSettingsQueries(this.db);
    const setting = await settings.get(key);
    if (!setting) {
      throw new NotFoundException(`System setting '${key}' not found`);
    }
    return setting;
  }

  /**
   * Set a system setting
   */
  async setSetting(key: string, value: string, updatedBy: string, description?: string) {
    const settings = systemSettingsQueries(this.db);
    return settings.set(key, value, updatedBy, description);
  }


  /**
   * List all users with their org memberships (system_admin only)
   */
  async listUsers() {
    const users = userQueries(this.db);
    return users.listAllWithMemberships();
  }

}
