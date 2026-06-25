import { Inject, Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import type { Db } from '@eve/db';
import { orgQueries, privateEndpointQueries } from '@eve/db';
import {
  generatePrivateEndpointId,
  type CreatePrivateEndpointRequest,
  type PrivateEndpointResponse,
  type PrivateEndpointListResponse,
  type PrivateEndpointHealth,
  type PrivateEndpointDiagnose,
} from '@eve/shared';

const EVE_TUNNELS_NS = 'eve-tunnels';

@Injectable()
export class PrivateEndpointsService {
  private orgs: ReturnType<typeof orgQueries>;
  private endpoints: ReturnType<typeof privateEndpointQueries>;
  private coreApi?: k8s.CoreV1Api;
  private appsApi?: k8s.AppsV1Api;
  private k8sAvailable = false;

  constructor(@Inject('DB') private readonly db: Db) {
    this.orgs = orgQueries(db);
    this.endpoints = privateEndpointQueries(db);

    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
      this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
      this.k8sAvailable = true;
    } catch {
      this.k8sAvailable = false;
    }
  }

  // ── Org resolution ────────────────────────────────────────────────────

  private async resolveOrg(orgIdOrSlug: string): Promise<{ id: string; slug: string }> {
    const byId = await this.orgs.findById(orgIdOrSlug);
    if (byId) return { id: byId.id, slug: byId.slug };
    const bySlug = await this.orgs.findBySlug(orgIdOrSlug);
    if (bySlug) return { id: bySlug.id, slug: bySlug.slug };
    throw new NotFoundException(`Organization ${orgIdOrSlug} not found`);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  async create(orgIdOrSlug: string, data: CreatePrivateEndpointRequest): Promise<PrivateEndpointResponse> {
    const org = await this.resolveOrg(orgIdOrSlug);

    // Idempotent: if same name+org already exists, return existing
    const existing = await this.endpoints.findByNameAndOrg(data.name, org.id);
    if (existing) {
      return this.toResponse(existing);
    }

    const k8sSvcName = `${org.slug}-${data.name}`;
    const k8sDns = `${k8sSvcName}.${EVE_TUNNELS_NS}.svc.cluster.local`;
    const id = generatePrivateEndpointId();

    const ep = await this.endpoints.create({
      id,
      name: data.name,
      org_id: org.id,
      provider: data.provider ?? 'tailscale',
      hostname: data.hostname,
      port: data.port,
      protocol: 'TCP',
      status: 'pending',
      status_msg: null,
      k8s_svc_name: k8sSvcName,
      k8s_namespace: EVE_TUNNELS_NS,
      k8s_dns: k8sDns,
      health_path: data.health_path ?? '/v1/models',
      metadata: data.metadata ?? null,
    });

    // Try to create the K8s ExternalName Service
    if (this.k8sAvailable && this.coreApi) {
      try {
        const nsExists = await this.checkNamespaceExists();
        if (!nsExists) {
          throw new Error(`Namespace '${EVE_TUNNELS_NS}' not found. Deploy the eve-tunnels namespace first (part of base k8s manifests).`);
        }
        await this.createK8sService(ep.k8s_svc_name, data.hostname, org.id, data.name);
        await this.endpoints.updateStatus(id, 'ready', null);
        ep.status = 'ready';
        ep.status_msg = null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.endpoints.updateStatus(id, 'error', msg);
        ep.status = 'error';
        ep.status_msg = msg;
      }
    } else {
      await this.endpoints.updateStatus(id, 'error', 'Kubernetes API not available. Tailscale operator cannot be configured.');
      ep.status = 'error';
      ep.status_msg = 'Kubernetes API not available';
    }

    return this.toResponse(ep);
  }

  async list(orgIdOrSlug: string, limit = 100, offset = 0): Promise<PrivateEndpointListResponse> {
    const org = await this.resolveOrg(orgIdOrSlug);
    const [items, total] = await Promise.all([
      this.endpoints.listByOrg(org.id, limit, offset),
      this.endpoints.countByOrg(org.id),
    ]);

    return {
      data: items.map((ep) => this.toResponse(ep)),
      pagination: { count: total, limit, offset },
    };
  }

  async show(orgIdOrSlug: string, name: string): Promise<PrivateEndpointResponse> {
    const org = await this.resolveOrg(orgIdOrSlug);
    const ep = await this.endpoints.findByNameAndOrg(name, org.id);
    if (!ep) throw new NotFoundException(`Endpoint '${name}' not found`);
    return this.toResponse(ep);
  }

  async remove(orgIdOrSlug: string, name: string): Promise<void> {
    const org = await this.resolveOrg(orgIdOrSlug);
    const ep = await this.endpoints.findByNameAndOrg(name, org.id);
    if (!ep) throw new NotFoundException(`Endpoint '${name}' not found`);

    // Delete the K8s Service
    if (this.k8sAvailable && this.coreApi) {
      try {
        await this.coreApi.deleteNamespacedService({
          name: ep.k8s_svc_name,
          namespace: ep.k8s_namespace,
        });
      } catch {
        // Service may not exist — proceed with DB cleanup
      }
    }

    await this.endpoints.deleteByNameAndOrg(name, org.id);
  }

  // ── Health check ──────────────────────────────────────────────────────

  async healthCheck(orgIdOrSlug: string, name: string): Promise<PrivateEndpointHealth> {
    const org = await this.resolveOrg(orgIdOrSlug);
    const ep = await this.endpoints.findByNameAndOrg(name, org.id);
    if (!ep) throw new NotFoundException(`Endpoint '${name}' not found`);

    const checkedAt = new Date().toISOString();
    const clusterUrl = this.buildClusterUrl(ep);

    if (!clusterUrl || !ep.health_path) {
      return {
        endpoint: this.toResponse(ep),
        health: {
          checked_at: checkedAt,
          reachable: false,
          http_status: null,
          response_time_ms: null,
          error: ep.health_path ? 'No cluster URL available' : 'Health checks disabled (no health_path)',
        },
      };
    }

    const probeUrl = `${clusterUrl}${ep.health_path}`;
    const start = Date.now();
    try {
      const res = await fetch(probeUrl, { signal: AbortSignal.timeout(5000) });
      const elapsed = Date.now() - start;
      const reachable = res.ok;

      if (reachable && ep.status !== 'ready') {
        await this.endpoints.updateStatus(ep.id, 'ready', null);
      } else if (!reachable && ep.status === 'ready') {
        await this.endpoints.updateStatus(ep.id, 'error', `HTTP ${res.status}`);
      }

      return {
        endpoint: this.toResponse(ep),
        health: {
          checked_at: checkedAt,
          reachable,
          http_status: res.status,
          response_time_ms: elapsed,
          error: reachable ? null : `HTTP ${res.status}`,
        },
      };
    } catch (err) {
      const elapsed = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (ep.status === 'ready') {
        await this.endpoints.updateStatus(ep.id, 'error', errorMsg);
      }

      return {
        endpoint: this.toResponse(ep),
        health: {
          checked_at: checkedAt,
          reachable: false,
          http_status: null,
          response_time_ms: elapsed,
          error: errorMsg,
        },
      };
    }
  }

  // ── Diagnose ──────────────────────────────────────────────────────────

  async diagnose(orgIdOrSlug: string, name: string): Promise<PrivateEndpointDiagnose> {
    const org = await this.resolveOrg(orgIdOrSlug);
    const ep = await this.endpoints.findByNameAndOrg(name, org.id);
    if (!ep) throw new NotFoundException(`Endpoint '${name}' not found`);

    const checks: Array<{ name: string; passed: boolean; detail: string | null }> = [];

    // Check 1: K8s available
    checks.push({
      name: 'Kubernetes API reachable',
      passed: this.k8sAvailable,
      detail: this.k8sAvailable ? null : 'Cannot connect to Kubernetes API',
    });

    if (!this.k8sAvailable || !this.coreApi || !this.appsApi) {
      return { endpoint: this.toResponse(ep), checks };
    }

    // Check 2: eve-tunnels namespace exists
    let nsExists = false;
    try {
      await this.coreApi.readNamespace({ name: EVE_TUNNELS_NS });
      nsExists = true;
      checks.push({ name: `Namespace '${EVE_TUNNELS_NS}' exists`, passed: true, detail: null });
    } catch {
      checks.push({ name: `Namespace '${EVE_TUNNELS_NS}' exists`, passed: false, detail: 'Namespace not found' });
    }

    if (!nsExists) {
      return { endpoint: this.toResponse(ep), checks };
    }

    // Check 3: K8s Service exists
    let svcExists = false;
    try {
      await this.coreApi.readNamespacedService({ name: ep.k8s_svc_name, namespace: EVE_TUNNELS_NS });
      svcExists = true;
      checks.push({ name: `Service '${ep.k8s_svc_name}' exists`, passed: true, detail: null });
    } catch {
      checks.push({ name: `Service '${ep.k8s_svc_name}' exists`, passed: false, detail: 'Service not found in eve-tunnels namespace' });
    }

    // Check 4: Tailscale operator running
    try {
      const deps = await this.appsApi.listNamespacedDeployment({
        namespace: EVE_TUNNELS_NS,
        labelSelector: 'app.kubernetes.io/name=tailscale-operator',
      });
      const running = (deps.items ?? []).length > 0;
      checks.push({
        name: 'Tailscale operator running',
        passed: running,
        detail: running ? null : 'No Tailscale operator deployment found in eve-tunnels',
      });
    } catch {
      checks.push({
        name: 'Tailscale operator running',
        passed: false,
        detail: 'Could not query deployments',
      });
    }

    // Check 5: Health probe (if service exists and health_path set)
    if (svcExists && ep.health_path) {
      const clusterUrl = this.buildClusterUrl(ep);
      if (clusterUrl) {
        try {
          const res = await fetch(`${clusterUrl}${ep.health_path}`, { signal: AbortSignal.timeout(5000) });
          checks.push({
            name: `Health probe ${ep.health_path}`,
            passed: res.ok,
            detail: res.ok ? `HTTP ${res.status} OK` : `HTTP ${res.status}`,
          });
        } catch (err) {
          checks.push({
            name: `Health probe ${ep.health_path}`,
            passed: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { endpoint: this.toResponse(ep), checks };
  }

  // ── K8s helpers ───────────────────────────────────────────────────────

  private async checkNamespaceExists(): Promise<boolean> {
    if (!this.coreApi) return false;
    try {
      await this.coreApi.readNamespace({ name: EVE_TUNNELS_NS });
      return true;
    } catch {
      return false;
    }
  }

  private async createK8sService(
    svcName: string,
    tailscaleHostname: string,
    orgId: string,
    endpointName: string,
  ): Promise<void> {
    if (!this.coreApi) return;

    const svcBody: k8s.V1Service = {
      metadata: {
        name: svcName,
        namespace: EVE_TUNNELS_NS,
        labels: {
          'eve.io/endpoint': 'true',
          'eve.io/org-id': orgId,
          'eve.io/endpoint-name': endpointName,
        },
        annotations: {
          'tailscale.com/tailnet-fqdn': tailscaleHostname,
          'eve.io/private-endpoint': 'true',
        },
      },
      spec: {
        type: 'ExternalName',
        externalName: 'placeholder',
      },
    };

    try {
      await this.coreApi.createNamespacedService({
        namespace: EVE_TUNNELS_NS,
        body: svcBody,
      });
    } catch (err: unknown) {
      // If service already exists (409), update it
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 409) {
        await this.coreApi.replaceNamespacedService({
          name: svcName,
          namespace: EVE_TUNNELS_NS,
          body: svcBody,
        });
      } else {
        throw err;
      }
    }
  }

  // ── Serialization ─────────────────────────────────────────────────────

  private buildClusterUrl(ep: { k8s_dns: string | null; port: number }): string | null {
    if (!ep.k8s_dns) return null;
    return `http://${ep.k8s_dns}:${ep.port}`;
  }

  private toResponse(ep: {
    id: string;
    name: string;
    org_id: string;
    provider: string;
    hostname: string;
    port: number;
    protocol: string;
    status: string;
    status_msg: string | null;
    k8s_svc_name: string;
    k8s_namespace: string;
    k8s_dns: string | null;
    health_path: string | null;
    created_at: Date;
    updated_at: Date;
  }): PrivateEndpointResponse {
    return {
      id: ep.id,
      name: ep.name,
      org_id: ep.org_id,
      provider: ep.provider,
      hostname: ep.hostname,
      port: ep.port,
      protocol: ep.protocol,
      status: ep.status as 'pending' | 'ready' | 'error',
      status_msg: ep.status_msg,
      k8s_svc_name: ep.k8s_svc_name,
      k8s_namespace: ep.k8s_namespace,
      k8s_dns: ep.k8s_dns,
      health_path: ep.health_path,
      cluster_url: this.buildClusterUrl(ep),
      created_at: ep.created_at.toISOString(),
      updated_at: ep.updated_at.toISOString(),
    };
  }
}
