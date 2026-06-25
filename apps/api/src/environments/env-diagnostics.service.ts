import { Inject, Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import type { Db } from '@eve/db';
import {
  environmentQueries,
  orgQueries,
  projectManifestQueries,
  projectQueries,
  releaseQueries,
  storageBucketQueries,
} from '@eve/db';
import type {
  EnvDiagnoseResponse,
  EnvDeploymentSummary,
  EnvHealthResponse,
  EnvHttpIngressInfo,
  EnvLogEntry,
  EnvRequestDiagnoseResponse,
  EnvTcpIngressInfo,
  Service,
} from '@eve/shared';
import {
  DEFAULT_INGRESS_MAX_BODY_SIZE,
  DEFAULT_INGRESS_TIMEOUT,
  getServicesFromManifest,
  loadConfig,
  parseIngressDuration,
  resolveTcpIngressConfig,
  type Manifest,
} from '@eve/shared';
import * as yaml from 'yaml';
import { isK8sNotFound, wrapK8sError } from './k8s-error.js';
import { EnvLogsService } from './env-logs.service.js';
import { EnvDbService } from './env-db.service.js';
import { TracesService } from '../traces/traces.service.js';
import { EmailDeliveryService } from '../mailer/email-delivery.service.js';

@Injectable()
export class EnvDiagnosticsService {
  private kc?: k8s.KubeConfig;
  private coreApi?: k8s.CoreV1Api;
  private appsApi?: k8s.AppsV1Api;
  private networkingApi?: k8s.NetworkingV1Api;
  private k8sAvailable = false;
  private environments: ReturnType<typeof environmentQueries>;
  private releases: ReturnType<typeof releaseQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private storageBuckets: ReturnType<typeof storageBucketQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private orgs: ReturnType<typeof orgQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly envLogsService: EnvLogsService,
    private readonly envDbService: EnvDbService,
    private readonly tracesService: TracesService,
    private readonly emailDeliveryService: EmailDeliveryService,
  ) {
    this.environments = environmentQueries(db);
    this.releases = releaseQueries(db);
    this.manifests = projectManifestQueries(db);
    this.storageBuckets = storageBucketQueries(db);
    this.projects = projectQueries(db);
    this.orgs = orgQueries(db);
    try {
      this.kc = new k8s.KubeConfig();
      this.kc.loadFromDefault();
      this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
      this.k8sAvailable = true;
    } catch {
      this.k8sAvailable = false;
    }
  }

  async getHealth(
    projectId: string,
    envName: string,
    namespace: string,
  ): Promise<EnvHealthResponse> {
    const checkedAt = new Date().toISOString();
    if (!this.k8sAvailable || !this.appsApi) {
      return {
        project_id: projectId,
        env_name: envName,
        namespace,
        status: 'unknown',
        ready: false,
        warnings: ['Kubernetes API not available'],
        checked_at: checkedAt,
        k8s_available: false,
      };
    }

    const warnings: string[] = [];
    let deploymentSummary: EnvHealthResponse['deployment'] = null;

    try {
      const selector = this.buildEnvSelector(projectId, envName);
      const deployments = await this.appsApi.listNamespacedDeployment({
        namespace,
        labelSelector: selector,
      });
      const items = deployments.items ?? [];

      if (items.length === 0) {
        warnings.push('No deployments found in namespace');
        return {
          project_id: projectId,
          env_name: envName,
          namespace,
          status: 'degraded',
          ready: false,
          deployment: deploymentSummary,
          warnings,
          checked_at: checkedAt,
          k8s_available: true,
        };
      }

      const desiredReplicas = items.reduce((sum, d) => sum + (d.spec?.replicas ?? 0), 0);
      const availableReplicas = items.reduce((sum, d) => sum + (d.status?.availableReplicas ?? 0), 0);
      const ready = desiredReplicas === 0 ? true : availableReplicas >= desiredReplicas;
      const conditions = items
        .flatMap((d) => d.status?.conditions ?? [])
        .map((condition) => ({
          type: condition.type ?? 'Unknown',
          status: condition.status ?? 'Unknown',
          message: condition.message ?? undefined,
        }));

      deploymentSummary = {
        ready,
        available_replicas: availableReplicas,
        desired_replicas: desiredReplicas,
        conditions,
      };

      if (!ready) {
        warnings.push(`Deployments not ready (${availableReplicas}/${desiredReplicas} available)`);
      }

      return {
        project_id: projectId,
        env_name: envName,
        namespace,
        status: ready ? 'ready' : 'deploying',
        ready,
        deployment: deploymentSummary,
        warnings: warnings.length > 0 ? warnings : undefined,
        checked_at: checkedAt,
        k8s_available: true,
      };
    } catch (error) {
      const wrapped = wrapK8sError(error, 'list', { kind: 'Deployment', namespace });
      warnings.push(`Failed to query deployment status: ${wrapped.message}`);
      return {
        project_id: projectId,
        env_name: envName,
        namespace,
        status: 'unknown',
        ready: false,
        deployment: deploymentSummary,
        warnings,
        checked_at: checkedAt,
        k8s_available: true,
      };
    }
  }

  async diagnose(
    projectId: string,
    envName: string,
    namespace: string,
    options?: { eventLimit?: number | undefined },
  ): Promise<EnvDiagnoseResponse> {
    const checkedAt = new Date().toISOString();
    const warnings: string[] = [];
    const storageBuckets = await this.listStorageBuckets(projectId, envName, warnings);
    const httpIngress = await this.listHttpIngress(projectId, envName, namespace, warnings);
    const tcpIngress = await this.listTcpIngress(projectId, envName, namespace, warnings);
    if (!this.k8sAvailable || !this.coreApi || !this.appsApi) {
      return {
        project_id: projectId,
        env_name: envName,
        namespace,
        status: 'unknown',
        ready: false,
        k8s_available: false,
        deployments: [],
        pods: [],
        events: [],
        storage_buckets: storageBuckets,
        http_ingress: httpIngress,
        tcp_ingress: tcpIngress,
        warnings: ['Kubernetes API not available', ...warnings],
        checked_at: checkedAt,
      };
    }

    const selector = this.buildEnvSelector(projectId, envName);

    const deployments: EnvDeploymentSummary[] = [];
    try {
      const deploymentsResponse = await this.appsApi.listNamespacedDeployment({
        namespace,
        labelSelector: selector,
      });
      const items = deploymentsResponse.items ?? [];
      for (const deployment of items) {
        const desiredReplicas = deployment.spec?.replicas ?? 0;
        const availableReplicas = deployment.status?.availableReplicas ?? 0;
        const ready = desiredReplicas === 0 ? true : availableReplicas >= desiredReplicas;
        const conditions = (deployment.status?.conditions ?? []).map((condition) => ({
          type: condition.type ?? 'Unknown',
          status: condition.status ?? 'Unknown',
          message: condition.message ?? undefined,
        }));
        deployments.push({
          name: deployment.metadata?.name ?? 'unknown',
          ready,
          available_replicas: availableReplicas,
          desired_replicas: desiredReplicas,
          conditions,
        });
        if (!ready) {
          warnings.push(`Deployment ${deployment.metadata?.name ?? 'unknown'} not ready (${availableReplicas}/${desiredReplicas})`);
        }
      }
      if (items.length === 0) {
        warnings.push('No deployments found in namespace');
      }
    } catch (error) {
      const wrapped = wrapK8sError(error, 'list', { kind: 'Deployment', namespace });
      warnings.push(`Failed to query deployments: ${wrapped.message}`);
    }

    const pods = [];
    try {
      const podsResponse = await this.coreApi.listNamespacedPod({
        namespace,
        labelSelector: selector,
      });
      const items = podsResponse.items ?? [];
      for (const pod of items) {
        const containerStatuses = pod.status?.containerStatuses ?? [];
        const ready = containerStatuses.length === 0
          ? false
          : containerStatuses.every((status) => status.ready);
        const restarts = containerStatuses.reduce(
          (sum, status) => sum + (status.restartCount ?? 0),
          0,
        );
        const creationTime = pod.metadata?.creationTimestamp;
        const age = creationTime ? this.getAge(new Date(creationTime)) : 'unknown';
        const labels = pod.metadata?.labels ?? {};
        const containers = containerStatuses.map((status) => {
          const state = status.state ?? {};
          const lastState = status.lastState ?? {};
          const running = state.running;
          const waiting = state.waiting;
          const terminated = state.terminated;

          let stateName: 'running' | 'waiting' | 'terminated' | 'unknown' = 'unknown';
          if (running) stateName = 'running';
          else if (waiting) stateName = 'waiting';
          else if (terminated) stateName = 'terminated';

          let reason: string | undefined;
          if (waiting?.reason) {
            reason = waiting.reason;
          } else if (terminated?.reason) {
            reason = terminated.reason;
          } else if (running) {
            reason = 'Running';
          }
          const message = waiting?.message ?? terminated?.message;
          const lastTerminated = lastState.terminated;

          return {
            name: status.name,
            ready: status.ready,
            restart_count: status.restartCount ?? 0,
            image: status.image ?? null,
            image_id: status.imageID ?? null,
            state: stateName,
            reason: reason ?? null,
            message: message ?? null,
            last_terminated_reason: lastTerminated?.reason ?? null,
            last_terminated_exit_code: lastTerminated?.exitCode ?? null,
          };
        });

        pods.push({
          name: pod.metadata?.name ?? '',
          namespace: pod.metadata?.namespace ?? '',
          phase: pod.status?.phase ?? 'Unknown',
          ready,
          restarts,
          age,
          labels,
          pod_ip: pod.status?.podIP ?? null,
          node_name: pod.spec?.nodeName ?? null,
          containers,
        });

        const isSucceededJob = (pod.status?.phase ?? '').toLowerCase() === 'succeeded';
        if (!ready && !isSucceededJob) {
          warnings.push(`Pod ${pod.metadata?.name ?? 'unknown'} not ready (${pod.status?.phase ?? 'Unknown'})`);
        }
      }
      if (items.length === 0) {
        warnings.push('No pods found in namespace');
      }
    } catch (error) {
      const wrapped = wrapK8sError(error, 'list', { kind: 'Pod', namespace });
      warnings.push(`Failed to query pods: ${wrapped.message}`);
    }

    const events = [];
    try {
      const eventsResponse = await this.coreApi.listNamespacedEvent({ namespace });
      const items = eventsResponse.items ?? [];
      const normalized = items
        .map((event) => ({
          type: event.type ?? 'Normal',
          reason: event.reason ?? null,
          message: event.message ?? null,
          timestamp: event.lastTimestamp?.toISOString?.()
            ?? event.eventTime?.toISOString?.()
            ?? event.firstTimestamp?.toISOString?.()
            ?? null,
          involved_object: {
            kind: event.involvedObject?.kind ?? 'Unknown',
            name: event.involvedObject?.name ?? 'unknown',
            namespace: event.involvedObject?.namespace ?? namespace,
          },
        }))
        .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));

      const limit = options?.eventLimit ?? 50;
      events.push(...normalized.slice(0, limit));
    } catch (error) {
      const wrapped = wrapK8sError(error, 'list', { kind: 'Event', namespace });
      warnings.push(`Failed to query events: ${wrapped.message}`);
    }

    const ready = deployments.length > 0 && deployments.every((deployment) => deployment.ready);
    const status = ready ? 'ready' : (deployments.length === 0 ? 'degraded' : 'deploying');

    const recentEmailEvents = await this.loadRecentEmailDeliveryEvents(projectId, warnings);

    return {
      project_id: projectId,
      env_name: envName,
      namespace,
      status,
      ready,
      k8s_available: true,
      deployments,
      pods,
      events,
      storage_buckets: storageBuckets,
      http_ingress: httpIngress,
      tcp_ingress: tcpIngress,
      recent_email_delivery_events: recentEmailEvents,
      warnings: warnings.length > 0 ? Array.from(new Set(warnings)) : undefined,
      checked_at: checkedAt,
    };
  }

  private async loadRecentEmailDeliveryEvents(
    projectId: string,
    warnings: string[],
  ): Promise<EnvDiagnoseResponse['recent_email_delivery_events']> {
    try {
      const project = await this.projects.findById(projectId, { include_deleted: true });
      if (!project) return [];
      const events = await this.emailDeliveryService.listForOrgMembers(project.org_id, 20);
      return events;
    } catch (err) {
      warnings.push(
        `Failed to load recent email delivery events: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  async diagnoseRequest(
    projectId: string,
    envName: string,
    namespace: string,
    requestId: string,
    options?: { windowSeconds?: number },
  ): Promise<EnvRequestDiagnoseResponse> {
    const checkedAt = new Date().toISOString();
    const windowSeconds = Math.min(Math.max(options?.windowSeconds ?? 60, 1), 600);
    const warnings: string[] = [];
    const { services, manifest } = await this.resolveDiagnosticServices(projectId);
    const logs: Array<EnvLogEntry & { service: string }> = [];

    await Promise.all(services.map(async (serviceName) => {
      try {
        const response = await this.envLogsService.getServiceLogs(projectId, envName, serviceName, {
          namespace,
          sinceSeconds: windowSeconds,
          grep: requestId,
          allPods: true,
        });
        logs.push(
          ...response.logs
            .filter((entry) => this.isRequestLogEntry(entry, requestId))
            .map((entry) => ({ ...entry, service: serviceName })),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Logs unavailable for service ${serviceName}: ${message}`);
      }
    }));

    logs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const firstSeen = logs[0]?.timestamp ?? null;
    const lastSeen = logs.at(-1)?.timestamp ?? null;
    const traceId = this.findTraceId(logs);
    const env = await this.environments.findByProjectAndName(projectId, envName);
    const release = env?.current_release_id ? await this.releases.findById(env.current_release_id) : null;
    const baseDiagnostics = await this.diagnose(projectId, envName, namespace, { eventLimit: 100 });
    const eventWindow = this.resolveEventWindow(firstSeen, lastSeen, windowSeconds);
    const k8sEvents = baseDiagnostics.events.filter((event) => {
      if (!event.timestamp) {
        return false;
      }
      const ts = new Date(event.timestamp).getTime();
      return ts >= eventWindow.start.getTime() && ts <= eventWindow.end.getTime();
    });

    const traceResponse = await this.tracesService.query({
      projectId,
      requestId,
      traceId: traceId ?? undefined,
      sinceSeconds: windowSeconds,
      limit: 50,
    });
    if (traceResponse.warnings?.length) {
      warnings.push(...traceResponse.warnings);
    }

    const audit = await this.queryAuditRows(projectId, envName, manifest, requestId, warnings);

    return {
      project_id: projectId,
      env_name: envName,
      namespace,
      request_id: requestId,
      request_window: {
        first_seen: firstSeen,
        last_seen: lastSeen,
        searched_seconds: windowSeconds,
      },
      deploy_at_request_time: release
        ? {
            release_id: release.id,
            git_sha: release.git_sha,
            manifest_hash: release.manifest_hash,
            deployed_at: release.created_at.toISOString(),
          }
        : null,
      logs,
      k8s_events: k8sEvents,
      traces: {
        trace_id: traceId ?? traceResponse.traces[0]?.trace_id ?? null,
        available: traceResponse.backend_available && traceResponse.traces.length > 0,
        store: traceResponse.backend,
        hint: traceResponse.backend_available
          ? undefined
          : 'Trace backend unavailable or no matching spans were returned.',
        spans: traceResponse.traces.flatMap((trace) => trace.spans),
      },
      audit_log_entries: audit,
      warnings: warnings.length > 0 ? Array.from(new Set(warnings)) : undefined,
      checked_at: checkedAt,
    };
  }

  private buildEnvSelector(projectId: string, envName: string): string {
    const envLabel = this.normalizeLabelValue(envName, 'env');
    return `eve.project_id=${projectId},eve.env=${envLabel}`;
  }

  private async listStorageBuckets(
    projectId: string,
    envName: string,
    warnings: string[],
  ): Promise<EnvDiagnoseResponse['storage_buckets']> {
    try {
      const buckets = await this.storageBuckets.listByEnv(projectId, envName);
      return buckets.map((bucket) => ({
        service_name: bucket.service_name,
        name: bucket.name,
        physical_name: bucket.physical_name,
        visibility: bucket.visibility,
        cors_json: this.normalizeJsonRecord(bucket.cors_json),
        isolation_mode: bucket.isolation_mode,
        iam_role_arn: bucket.iam_role_arn,
        iam_role_name: bucket.iam_role_name,
        service_account: bucket.service_account_name || bucket.service_account_namespace
          ? {
              name: bucket.service_account_name,
              namespace: bucket.service_account_namespace,
            }
          : null,
      }));
    } catch (error) {
      warnings.push(
        `Failed to query storage buckets: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private async listHttpIngress(
    projectId: string,
    envName: string,
    namespace: string,
    warnings: string[],
  ): Promise<EnvHttpIngressInfo[]> {
    let manifest: Manifest | null = null;
    try {
      const manifestRecord = await this.manifests.findLatestByProject(projectId);
      if (!manifestRecord) {
        return [];
      }
      manifest = yaml.parse(manifestRecord.manifest_yaml) as Manifest;
    } catch (error) {
      warnings.push(`Failed to parse manifest for HTTP ingress diagnostics: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }

    const platformConfig = loadConfig();
    const domain = (platformConfig.EVE_DEFAULT_DOMAIN ?? '').trim().toLowerCase();
    if (!domain) {
      return [];
    }

    const configuredControllerFlavor = this.resolveIngressFlavor(platformConfig.EVE_DEFAULT_INGRESS_CLASS);
    const defaultTimeout = platformConfig.EVE_DEFAULT_INGRESS_TIMEOUT ?? DEFAULT_INGRESS_TIMEOUT;
    const defaultMaxBodySize = platformConfig.EVE_DEFAULT_INGRESS_MAX_BODY_SIZE ?? DEFAULT_INGRESS_MAX_BODY_SIZE;
    const services = getServicesFromManifest(manifest) ?? {};
    const project = await this.projects.findById(projectId, { include_deleted: true });
    const org = project ? await this.orgs.findById(project.org_id) : null;
    const envSlug = this.toK8sName(envName, 'env');
    const orgSlug = this.toK8sName(org?.slug ?? 'unknown-org', 'org');
    const projectSlug = this.toK8sName(project?.slug ?? 'unknown-project', 'project');

    const liveIngressesByComponent = new Map<string, k8s.V1Ingress[]>();
    if (this.k8sAvailable && this.networkingApi) {
      try {
        const response = await this.networkingApi.listNamespacedIngress({
          namespace,
          labelSelector: this.buildEnvSelector(projectId, envName),
        });
        for (const ingress of response.items ?? []) {
          const component = ingress.metadata?.labels?.['eve.component'];
          if (!component) continue;
          const existing = liveIngressesByComponent.get(component) ?? [];
          existing.push(ingress);
          liveIngressesByComponent.set(component, existing);
        }
      } catch (error) {
        const wrapped = wrapK8sError(error, 'list', { kind: 'Ingress', namespace });
        warnings.push(`Failed to query HTTP ingresses: ${wrapped.message}`);
      }
    }

    const result: EnvHttpIngressInfo[] = [];
    for (const [serviceName, service] of Object.entries(services)) {
      const ingressConfig = this.resolveHttpIngressConfig(service);
      const ports = this.parseServicePorts(service.ports);
      if (!ingressConfig && ports.length === 0) {
        continue;
      }

      const isPublic = ingressConfig
        ? Boolean((ingressConfig as Record<string, unknown>).public)
        : true;
      if (!isPublic) {
        continue;
      }

      const componentSlug = this.toK8sName(serviceName, 'component');
      const componentLabel = this.normalizeLabelValue(serviceName, 'component');
      const expectedHosts = [
        `${componentSlug}.${orgSlug}-${projectSlug}-${envSlug}.${domain}`,
        ...this.resolveHttpIngressDomains(ingressConfig),
      ];
      const alias = this.resolveHttpIngressAlias(ingressConfig);
      if (alias) {
        expectedHosts.push(`${alias}.${domain}`);
      }

      const liveIngresses = liveIngressesByComponent.get(componentLabel) ?? [];
      const liveHosts = liveIngresses.flatMap((ingress) =>
        (ingress.spec?.rules ?? [])
          .map((rule) => rule.host)
          .filter((host): host is string => typeof host === 'string' && host.length > 0)
      );
      const annotations = this.pickHttpIngressAnnotations(liveIngresses);
      const controllerFlavor = this.resolveHttpIngressFlavor(configuredControllerFlavor, liveIngresses);
      const explicitTimeout = typeof ingressConfig?.timeout === 'string';
      const explicitMaxBodySize = typeof ingressConfig?.max_body_size === 'string';
      const requestedTimeout = explicitTimeout ? ingressConfig.timeout as string : defaultTimeout;
      const requestedMaxBodySize = explicitMaxBodySize ? ingressConfig.max_body_size as string : defaultMaxBodySize;
      const missing = liveIngresses.length === 0;
      const unsupported = controllerFlavor !== 'nginx';

      result.push({
        service: serviceName,
        hosts: Array.from(new Set([...expectedHosts, ...liveHosts])),
        controller_flavor: controllerFlavor,
        requested_timeout_seconds: parseIngressDuration(requestedTimeout),
        requested_max_body_size: requestedMaxBodySize,
        effective_timeout_seconds: this.parseNginxTimeoutAnnotation(annotations),
        effective_max_body_size: annotations?.['nginx.ingress.kubernetes.io/proxy-body-size'] ?? null,
        timeout_source: missing ? 'missing' : unsupported ? 'unsupported_controller' : explicitTimeout ? 'manifest' : 'platform_default',
        max_body_size_source: missing ? 'missing' : unsupported ? 'unsupported_controller' : explicitMaxBodySize ? 'manifest' : 'platform_default',
      });
    }

    return result;
  }

  private async listTcpIngress(
    projectId: string,
    envName: string,
    namespace: string,
    warnings: string[],
  ): Promise<EnvTcpIngressInfo[]> {
    let manifest: Manifest | null = null;
    try {
      const manifestRecord = await this.manifests.findLatestByProject(projectId);
      if (!manifestRecord) {
        return [];
      }
      manifest = yaml.parse(manifestRecord.manifest_yaml) as Manifest;
    } catch (error) {
      warnings.push(`Failed to parse manifest for TCP ingress diagnostics: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }

    const services = getServicesFromManifest(manifest) ?? {};
    const entries = Object.entries(services)
      .map(([serviceName, service]) => ({ serviceName, service, config: resolveTcpIngressConfig(service) }))
      .filter((entry) => entry.config !== null);

    if (entries.length === 0) {
      return [];
    }

    const platformConfig = loadConfig();
    const project = await this.projects.findById(projectId, { include_deleted: true });
    const org = project ? await this.orgs.findById(project.org_id) : null;
    const envSlug = this.toK8sName(envName, 'env');
    const orgSlug = this.toK8sName(org?.slug ?? 'unknown-org', 'org');
    const projectSlug = this.toK8sName(project?.slug ?? 'unknown-project', 'project');
    const hostedZone = (platformConfig.EVE_TCP_INGRESS_HOSTED_ZONE ?? platformConfig.EVE_DEFAULT_DOMAIN ?? '').trim().toLowerCase();

    const result: EnvTcpIngressInfo[] = [];
    for (const { serviceName, config } of entries) {
      if (!config) continue;
      const componentSlug = this.toK8sName(serviceName, 'component');
      const resourceName = this.combineK8sName(envSlug, componentSlug, 'resource');
      const tcpServiceName = this.appendK8sSuffix(resourceName, 'tcp', 'tcp ingress service');
      const advertisedHost = hostedZone
        ? (config.hostname
            ? `${config.hostname}.${hostedZone}`
            : `${componentSlug}.${orgSlug}-${projectSlug}-${envSlug}.${hostedZone}`)
        : null;

      let service: k8s.V1Service | null = null;
      if (this.k8sAvailable && this.coreApi) {
        try {
          const response = await this.coreApi.readNamespacedService({ name: tcpServiceName, namespace });
          service = response;
        } catch (error) {
          if (!isK8sNotFound(error)) {
            const wrapped = wrapK8sError(error, 'read', { kind: 'Service', name: tcpServiceName, namespace });
            warnings.push(`Failed to query TCP ingress Service ${tcpServiceName}: ${wrapped.message}`);
          }
        }
      }

      const ingress = service?.status?.loadBalancer?.ingress?.[0];
      const externalHostname = ingress?.hostname ?? null;
      const externalIp = ingress?.ip ?? null;
      const state = !service
        ? 'pending'
        : (externalHostname || externalIp)
          ? 'ready'
          : 'provisioning';
      const portNodePorts = new Map<number, number>();
      for (const port of service?.spec?.ports ?? []) {
        if (typeof port.port === 'number' && typeof port.nodePort === 'number') {
          portNodePorts.set(port.port, port.nodePort);
        }
      }

      result.push({
        service: serviceName,
        provider: service?.metadata?.annotations?.['eve.io/tcp-ingress-provider'] ?? platformConfig.EVE_TCP_INGRESS_PROVIDER,
        hostname: service?.metadata?.annotations?.['eve.io/tcp-ingress-host'] ?? advertisedHost,
        external_hostname: externalHostname,
        external_ip: externalIp,
        listeners: config.listeners.map((listener) => ({
          name: listener.name,
          port: listener.port,
          state,
          node_target_port: portNodePorts.get(listener.port) ?? null,
        })),
      });
    }

    return result;
  }

  private normalizeJsonRecord(value: unknown): Record<string, unknown> {
    if (!value) {
      return {};
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        return {};
      }
    }
    return typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private async resolveDiagnosticServices(projectId: string): Promise<{
    services: string[];
    manifest: Manifest | null;
  }> {
    const manifestRecord = await this.manifests.findLatestByProject(projectId);
    if (!manifestRecord) {
      return { services: [], manifest: null };
    }
    const manifest = yaml.parse(manifestRecord.manifest_yaml) as Manifest;
    const services = Object.entries(getServicesFromManifest(manifest) ?? {})
      .filter(([, service]) => {
        const xEve = this.getXeve(service);
        return xEve.role !== 'managed_db' && xEve.role !== 'job' && xEve.external !== true;
      })
      .map(([name]) => name);
    return { services, manifest };
  }

  private isRequestLogEntry(entry: EnvLogEntry, requestId: string): boolean {
    const fields = entry.fields;
    if (fields) {
      for (const key of ['req_id', 'request_id', 'correlation_id']) {
        const value = fields[key];
        if (String(value) === requestId) {
          return true;
        }
      }
    }
    return entry.line.includes(requestId);
  }

  private findTraceId(logs: Array<EnvLogEntry & { service: string }>): string | null {
    for (const entry of logs) {
      const traceId = entry.fields?.trace_id;
      if (typeof traceId === 'string' && traceId.length > 0) {
        return traceId;
      }
    }
    return null;
  }

  private resolveEventWindow(firstSeen: string | null, lastSeen: string | null, windowSeconds: number): {
    start: Date;
    end: Date;
  } {
    if (firstSeen && lastSeen) {
      return {
        start: new Date(new Date(firstSeen).getTime() - windowSeconds * 1000),
        end: new Date(new Date(lastSeen).getTime() + windowSeconds * 1000),
      };
    }
    const end = new Date();
    return {
      start: new Date(end.getTime() - windowSeconds * 1000),
      end,
    };
  }

  private async queryAuditRows(
    projectId: string,
    envName: string,
    manifest: Manifest | null,
    requestId: string,
    warnings: string[],
  ): Promise<Record<string, unknown>[] | undefined> {
    if (!manifest) {
      return undefined;
    }
    const auditConfig = Object.values(getServicesFromManifest(manifest) ?? {})
      .map((service) => this.getXeve(service))
      .find((xEve) => typeof xEve.audit_log_table === 'string' && xEve.audit_log_table.length > 0);
    if (!auditConfig?.audit_log_table) {
      return undefined;
    }

    const requestIdColumn = auditConfig.request_id_column ?? 'request_id';
    try {
      const table = this.quoteIdentifierPath(auditConfig.audit_log_table);
      const column = this.quoteIdentifierPath(requestIdColumn);
      const result = await this.envDbService.executeSql(
        projectId,
        envName,
        `SELECT * FROM ${table} WHERE ${column} = $1 ORDER BY 1 DESC LIMIT 100`,
        [requestId],
        false,
        { project_id: projectId, env_name: envName, permissions: ['envdb:read'] },
      );
      return result.rows as Record<string, unknown>[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Audit log query skipped: ${message}`);
      return [];
    }
  }

  private quoteIdentifierPath(identifier: string): string {
    return identifier
      .split('.')
      .map((part) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
          throw new Error(`Invalid SQL identifier: ${identifier}`);
        }
        return `"${part.replace(/"/g, '""')}"`;
      })
      .join('.');
  }

  private getXeve(service: Service): Record<string, any> {
    return (service['x-eve'] ?? service.x_eve ?? {}) as Record<string, any>;
  }

  private resolveHttpIngressConfig(service: Service): Record<string, unknown> | null {
    const ingress = this.getXeve(service).ingress;
    return ingress && typeof ingress === 'object' ? ingress as Record<string, unknown> : null;
  }

  private resolveIngressFlavor(ingressClassName: string | undefined): 'nginx' | 'traefik' | 'unknown' {
    const normalized = (ingressClassName ?? '').trim().toLowerCase();
    if (normalized === 'nginx' || normalized === 'nginx-ingress') return 'nginx';
    if (normalized === 'traefik') return 'traefik';
    return 'unknown';
  }

  private resolveHttpIngressFlavor(
    configured: 'nginx' | 'traefik' | 'unknown',
    ingresses: k8s.V1Ingress[],
  ): 'nginx' | 'traefik' | 'unknown' {
    if (configured !== 'unknown') {
      return configured;
    }
    for (const ingress of ingresses) {
      const liveFlavor = this.resolveIngressFlavor(ingress.spec?.ingressClassName);
      if (liveFlavor !== 'unknown') {
        return liveFlavor;
      }
    }
    return 'unknown';
  }

  private resolveHttpIngressAlias(ingress: Record<string, unknown> | null): string | null {
    if (!ingress || typeof ingress.alias !== 'string') {
      return null;
    }
    const alias = ingress.alias.trim().toLowerCase();
    return alias.length > 0 ? alias : null;
  }

  private resolveHttpIngressDomains(ingress: Record<string, unknown> | null): string[] {
    if (!ingress || !Array.isArray(ingress.domains)) {
      return [];
    }
    return (ingress.domains as unknown[])
      .filter((domain): domain is string => typeof domain === 'string')
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain.length > 0);
  }

  private parseServicePorts(ports?: Array<string | number>): number[] {
    if (!Array.isArray(ports)) return [];
    const parsed: number[] = [];
    for (const entry of ports) {
      const raw = typeof entry === 'number' ? String(entry) : entry;
      const candidate = raw.trim().split(':').at(-1);
      const port = candidate ? Number.parseInt(candidate, 10) : NaN;
      if (Number.isFinite(port)) {
        parsed.push(port);
      }
    }
    return parsed;
  }

  private pickHttpIngressAnnotations(ingresses: k8s.V1Ingress[]): Record<string, string> | null {
    const withNginxAnnotations = ingresses.find((ingress) =>
      Boolean(ingress.metadata?.annotations?.['nginx.ingress.kubernetes.io/proxy-read-timeout'])
      || Boolean(ingress.metadata?.annotations?.['nginx.ingress.kubernetes.io/proxy-body-size'])
    );
    return withNginxAnnotations?.metadata?.annotations ?? ingresses[0]?.metadata?.annotations ?? null;
  }

  private parseNginxTimeoutAnnotation(annotations: Record<string, string> | null): number | null {
    const raw = annotations?.['nginx.ingress.kubernetes.io/proxy-read-timeout'];
    if (!raw) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toK8sName(value: string, label: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .replace(/--+/g, '-');

    if (!normalized) {
      throw new Error(`Invalid ${label} name: ${value}`);
    }

    return normalized.length > 63 ? normalized.slice(0, 63).replace(/-+$/, '') : normalized;
  }

  private combineK8sName(envSlug: string, componentSlug: string, label: string): string {
    const combined = `${envSlug}-${componentSlug}`;
    if (combined.length <= 63) {
      return combined;
    }

    const maxEnv = 31;
    const maxComponent = 31;
    const trimmedEnv = envSlug.slice(0, maxEnv).replace(/-+$/, '');
    const trimmedComponent = componentSlug.slice(0, maxComponent).replace(/-+$/, '');
    const trimmed = `${trimmedEnv}-${trimmedComponent}`.replace(/-+$/, '');

    if (!trimmed) {
      throw new Error(`Invalid ${label} name from ${envSlug}-${componentSlug}`);
    }

    return trimmed;
  }

  private appendK8sSuffix(base: string, suffix: string, label: string): string {
    const normalizedSuffix = this.toK8sName(suffix, label);
    const maxBaseLength = 63 - normalizedSuffix.length - 1;
    const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/, '');
    const combined = `${trimmedBase}-${normalizedSuffix}`;
    if (!trimmedBase || combined.length > 63) {
      throw new Error(`Invalid ${label} name from ${base}-${suffix}`);
    }
    return combined;
  }

  private normalizeLabelValue(value: string, label: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-_.]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '')
      .replace(/-+$/, '');

    if (!normalized) {
      throw new Error(`Invalid ${label} label value: ${value}`);
    }

    return normalized.length > 63 ? normalized.slice(0, 63).replace(/[-_.]+$/, '') : normalized;
  }

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
}
