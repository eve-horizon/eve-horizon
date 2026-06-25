import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import yaml from 'yaml';
import { PassThrough } from 'node:stream';
import { K8sOperationError, isK8sConflict, isK8sNotFound, wrapK8sError } from './k8s-error.js';

type K8sObject = k8s.KubernetesObject & {
  metadata: { name: string; namespace?: string };
  spec?: Record<string, unknown>;
};

@Injectable()
export class K8sService {
  private readonly logger = new Logger(K8sService.name);
  private kc?: k8s.KubeConfig;
  private coreApi?: k8s.CoreV1Api;
  private appsApi?: k8s.AppsV1Api;
  private batchApi?: k8s.BatchV1Api;
  private networkingApi?: k8s.NetworkingV1Api;
  private objectApi?: k8s.KubernetesObjectApi;
  private available = false;

  constructor() {
    try {
      this.kc = new k8s.KubeConfig();
      this.kc.loadFromDefault();
      this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
      this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
      this.objectApi = k8s.KubernetesObjectApi.makeApiClient(this.kc);
      this.available = true;
    } catch (error) {
      this.available = false;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Kubernetes client unavailable: ${message}`);
    }
  }

  async createNamespace(name: string, labels?: Record<string, string>): Promise<void> {
    this.ensureAvailable();
    try {
      const existing = await this.coreApi!.readNamespace(name);
      if (labels && Object.keys(labels).length > 0) {
        const current = existing.body.metadata?.labels ?? {};
        const merged = { ...current, ...labels };
        const body = existing.body as k8s.V1Namespace;
        body.metadata = body.metadata ?? {};
        body.metadata.labels = merged;
        try {
          await this.coreApi!.replaceNamespace(name, body);
        } catch (err) {
          throw wrapK8sError(err, 'replace', { kind: 'Namespace', name });
        }
      }
      return;
    } catch (err) {
      if (err instanceof K8sOperationError) throw err;
      // Fall through: readNamespace failed, try to create
    }

    this.logger.log(`Creating namespace ${name}`);
    try {
      await this.coreApi!.createNamespace({
        metadata: { name, labels },
      });
    } catch (err) {
      if (isK8sConflict(err)) return;
      throw wrapK8sError(err, 'create', { kind: 'Namespace', name });
    }
  }

  async getServiceClusterIP(namespace: string, serviceName: string): Promise<string | null> {
    this.ensureAvailable();
    try {
      const response = await this.coreApi!.readNamespacedService(serviceName, namespace);
      return response.body.spec?.clusterIP ?? null;
    } catch (err) {
      if (isK8sNotFound(err)) return null;
      throw wrapK8sError(err, 'read', { kind: 'Service', name: serviceName, namespace });
    }
  }

  async applyManifest(namespace: string, manifest: string): Promise<void> {
    this.ensureAvailable();
    const docs = yaml.parseAllDocuments(manifest);
    const objects = docs
      .map((doc) => doc.toJSON())
      .filter((obj): obj is K8sObject => !!obj && typeof obj === 'object');

    for (const obj of objects) {
      if (!obj.metadata || !obj.metadata.name) {
        continue;
      }

      const isNamespace = obj.kind === 'Namespace';
      if (!isNamespace && !obj.metadata.namespace) {
        obj.metadata.namespace = namespace;
      }

      await this.applyObject(obj);
    }
  }

  async getDeploymentStatus(namespace: string, deploymentName?: string): Promise<{
    ready: boolean;
    availableReplicas: number;
    desiredReplicas: number;
    conditions: Array<{ type: string; status: string; message?: string }>;
  }> {
    this.ensureAvailable();

    // If specific deployment requested, check just that one
    if (deploymentName) {
      try {
        const deployment = await this.appsApi!.readNamespacedDeployment(deploymentName, namespace);
        const d = deployment.body;
        const desiredReplicas = d.spec?.replicas ?? 0;
        const availableReplicas = d.status?.availableReplicas ?? 0;
        const ready = desiredReplicas === 0 ? true : availableReplicas >= desiredReplicas;

        const conditions = (d.status?.conditions ?? []).map((condition) => ({
          type: condition.type ?? 'Unknown',
          status: condition.status ?? 'Unknown',
          message: condition.message ?? undefined,
        }));

        return { ready, availableReplicas, desiredReplicas, conditions };
      } catch (err) {
        if (isK8sNotFound(err)) {
          return {
            ready: false,
            availableReplicas: 0,
            desiredReplicas: 0,
            conditions: [{ type: 'Available', status: 'False', message: `Deployment ${deploymentName} not found` }],
          };
        }
        throw wrapK8sError(err, 'read', { kind: 'Deployment', name: deploymentName, namespace });
      }
    }

    // Otherwise check all deployments in namespace
    let deployments: { body: { items?: k8s.V1Deployment[] } };
    try {
      deployments = await this.appsApi!.listNamespacedDeployment(namespace);
    } catch (err) {
      throw wrapK8sError(err, 'list', { kind: 'Deployment', namespace });
    }
    const items = deployments.body.items ?? [];

    if (items.length === 0) {
      return {
        ready: false,
        availableReplicas: 0,
        desiredReplicas: 0,
        conditions: [{ type: 'Available', status: 'False', message: 'No deployments found' }],
      };
    }

    const desiredReplicas = items.reduce((sum: number, d: k8s.V1Deployment) => sum + (d.spec?.replicas ?? 0), 0);
    const availableReplicas = items.reduce((sum: number, d: k8s.V1Deployment) => sum + (d.status?.availableReplicas ?? 0), 0);
    const ready = desiredReplicas === 0 ? true : availableReplicas >= desiredReplicas;

    const conditions = items
      .flatMap((d: k8s.V1Deployment) => d.status?.conditions ?? [])
      .map((condition) => ({
        type: condition.type ?? 'Unknown',
        status: condition.status ?? 'Unknown',
        message: condition.message ?? undefined,
      }));

    return {
      ready,
      availableReplicas,
      desiredReplicas,
      conditions,
    };
  }

  async deploymentExists(namespace: string, name: string): Promise<boolean> {
    this.ensureAvailable();
    try {
      await this.appsApi!.readNamespacedDeployment(name, namespace);
      return true;
    } catch (err) {
      if (isK8sNotFound(err)) return false;
      throw wrapK8sError(err, 'read', { kind: 'Deployment', name, namespace });
    }
  }

  async deleteNamespace(namespace: string): Promise<void> {
    this.ensureAvailable();
    this.logger.log(`Deleting namespace ${namespace}`);
    try {
      await this.coreApi!.deleteNamespace(namespace);
    } catch (err) {
      if (isK8sNotFound(err)) {
        this.logger.log(`Namespace ${namespace} not found, skipping delete`);
        return;
      }
      throw wrapK8sError(err, 'delete', { kind: 'Namespace', name: namespace });
    }
  }

  async listAliasIngresses(
    namespace: string,
  ): Promise<Array<{ name: string; alias: string | null }>> {
    this.ensureAvailable();
    let response: { body: { items?: k8s.V1Ingress[] } };
    try {
      response = await this.networkingApi!.listNamespacedIngress(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'eve.ingress_alias=true',
      );
    } catch (err) {
      throw wrapK8sError(err, 'list', { kind: 'Ingress', namespace });
    }

    return (response.body.items ?? [])
      .map((item) => ({
        name: item.metadata?.name ?? '',
        alias: item.metadata?.labels?.['eve.alias'] ?? null,
      }))
      .filter((item) => item.name.length > 0);
  }

  async listPodsWithLabel(
    namespace: string,
    labelSelector: string,
  ): Promise<k8s.V1Pod[]> {
    this.ensureAvailable();
    try {
      const response = await this.coreApi!.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector,
      );
      return response.body.items ?? [];
    } catch (err) {
      throw wrapK8sError(err, 'list', { kind: 'Pod', namespace });
    }
  }

  async listRecentWarningEvents(
    namespace: string,
    limit: number = 50,
  ): Promise<Array<{ type: string; reason: string | null; message: string | null; timestamp: string | null; involvedObject: { kind?: string; name?: string } }>> {
    this.ensureAvailable();
    try {
      const response = await this.coreApi!.listNamespacedEvent(namespace);
      const items = response.body.items ?? [];
      return items
        .filter((ev) => (ev.type ?? 'Normal') === 'Warning')
        .map((ev) => ({
          type: ev.type ?? 'Warning',
          reason: ev.reason ?? null,
          message: ev.message ?? null,
          timestamp:
            ev.lastTimestamp?.toISOString?.() ??
            ev.eventTime?.toISOString?.() ??
            ev.firstTimestamp?.toISOString?.() ??
            null,
          involvedObject: {
            kind: ev.involvedObject?.kind ?? undefined,
            name: ev.involvedObject?.name ?? undefined,
          },
        }))
        .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
        .slice(0, limit);
    } catch (err) {
      throw wrapK8sError(err, 'list', { kind: 'Event', namespace });
    }
  }

  async listCustomDomainIngresses(
    namespace: string,
  ): Promise<Array<{ name: string; hostname: string | null }>> {
    this.ensureAvailable();
    let response: { body: { items?: k8s.V1Ingress[] } };
    try {
      response = await this.networkingApi!.listNamespacedIngress(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'eve.custom_domain=true',
      );
    } catch (err) {
      throw wrapK8sError(err, 'list', { kind: 'Ingress', namespace });
    }

    return (response.body.items ?? [])
      .map((item) => ({
        name: item.metadata?.name ?? '',
        hostname: item.metadata?.labels?.['eve.domain_hostname'] ?? null,
      }))
      .filter((item) => item.name.length > 0);
  }

  async listTcpIngressServices(
    namespace: string,
  ): Promise<Array<{ name: string; component: string | null }>> {
    this.ensureAvailable();
    let response: { body: { items?: k8s.V1Service[] } };
    try {
      response = await this.coreApi!.listNamespacedService(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'eve.tcp_ingress=true',
      );
    } catch (err) {
      throw wrapK8sError(err, 'list', { kind: 'Service', namespace });
    }

    return (response.body.items ?? [])
      .map((item) => ({
        name: item.metadata?.name ?? '',
        component: item.metadata?.labels?.['eve.component'] ?? null,
      }))
      .filter((item) => item.name.length > 0);
  }

  async deleteService(namespace: string, name: string): Promise<void> {
    this.ensureAvailable();
    try {
      await this.coreApi!.deleteNamespacedService(name, namespace);
      this.logger.log(`Deleted Service ${name} from namespace ${namespace}`);
    } catch (err) {
      if (isK8sNotFound(err)) return;
      throw wrapK8sError(err, 'delete', { kind: 'Service', name, namespace });
    }
  }

  async deleteIngress(namespace: string, name: string): Promise<void> {
    this.ensureAvailable();
    try {
      await this.networkingApi!.deleteNamespacedIngress(name, namespace);
      this.logger.log(`Deleted Ingress ${name} from namespace ${namespace}`);
    } catch (err) {
      if (isK8sNotFound(err)) return;
      throw wrapK8sError(err, 'delete', { kind: 'Ingress', name, namespace });
    }
  }

  async createConfigMap(
    namespace: string,
    name: string,
    data: Record<string, string>,
  ): Promise<void> {
    this.ensureAvailable();

    const configMap: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name,
        namespace,
      },
      data,
    };

    try {
      await this.coreApi!.readNamespacedConfigMap(name, namespace);
    } catch (err) {
      if (isK8sNotFound(err)) {
        try {
          await this.coreApi!.createNamespacedConfigMap(namespace, configMap);
          this.logger.log(`Created ConfigMap ${name} in namespace ${namespace}`);
        } catch (createErr) {
          if (isK8sConflict(createErr)) return;
          throw wrapK8sError(createErr, 'create', { kind: 'ConfigMap', name, namespace });
        }
        return;
      }
      throw wrapK8sError(err, 'read', { kind: 'ConfigMap', name, namespace });
    }

    // ConfigMap exists, replace it
    try {
      await this.coreApi!.replaceNamespacedConfigMap(name, namespace, configMap);
      this.logger.log(`Updated ConfigMap ${name} in namespace ${namespace}`);
    } catch (err) {
      throw wrapK8sError(err, 'replace', { kind: 'ConfigMap', name, namespace });
    }
  }

  async createPersistentVolumeClaim(
    namespace: string,
    claim: k8s.V1PersistentVolumeClaim,
  ): Promise<void> {
    this.ensureAvailable();

    const name = claim.metadata?.name;
    if (!name) {
      throw new Error('PersistentVolumeClaim name is required');
    }

    const pvc: k8s.V1PersistentVolumeClaim = {
      ...claim,
      metadata: {
        ...(claim.metadata ?? {}),
        namespace,
      },
    };

    try {
      await this.coreApi!.readNamespacedPersistentVolumeClaim(name, namespace);
      this.logger.log(`PersistentVolumeClaim ${name} already exists in namespace ${namespace}`);
      return;
    } catch (err) {
      if (!isK8sNotFound(err)) {
        throw wrapK8sError(err, 'read', { kind: 'PersistentVolumeClaim', name, namespace });
      }
    }

    try {
      await this.coreApi!.createNamespacedPersistentVolumeClaim(namespace, pvc);
      this.logger.log(`Created PersistentVolumeClaim ${name} in namespace ${namespace}`);
    } catch (createErr) {
      if (isK8sConflict(createErr)) {
        this.logger.log(`PersistentVolumeClaim ${name} already exists in namespace ${namespace}`);
        return;
      }
      throw wrapK8sError(createErr, 'create', { kind: 'PersistentVolumeClaim', name, namespace });
    }
  }

  async deleteConfigMap(namespace: string, name: string): Promise<void> {
    this.ensureAvailable();
    try {
      await this.coreApi!.deleteNamespacedConfigMap(name, namespace);
      this.logger.log(`Deleted ConfigMap ${name} from namespace ${namespace}`);
    } catch (err) {
      if (isK8sNotFound(err)) return;
      throw wrapK8sError(err, 'delete', { kind: 'ConfigMap', name, namespace });
    }
  }

  async createSecret(
    namespace: string,
    name: string,
    stringData: Record<string, string>,
  ): Promise<void> {
    this.ensureAvailable();

    const secret: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name,
        namespace,
      },
      stringData,
    };

    try {
      await this.coreApi!.readNamespacedSecret(name, namespace);
    } catch (err) {
      if (isK8sNotFound(err)) {
        try {
          await this.coreApi!.createNamespacedSecret(namespace, secret);
          this.logger.log(`Created Secret ${name} in namespace ${namespace}`);
          return;
        } catch (createErr) {
          if (isK8sConflict(createErr)) return;
          throw wrapK8sError(createErr, 'create', { kind: 'Secret', name, namespace });
        }
      }
      throw wrapK8sError(err, 'read', { kind: 'Secret', name, namespace });
    }

    try {
      await this.coreApi!.replaceNamespacedSecret(name, namespace, secret);
      this.logger.log(`Updated Secret ${name} in namespace ${namespace}`);
    } catch (err) {
      throw wrapK8sError(err, 'replace', { kind: 'Secret', name, namespace });
    }
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.ensureAvailable();
    try {
      await this.coreApi!.deleteNamespacedSecret(name, namespace);
      this.logger.log(`Deleted Secret ${name} from namespace ${namespace}`);
    } catch (err) {
      if (isK8sNotFound(err)) return;
      throw wrapK8sError(err, 'delete', { kind: 'Secret', name, namespace });
    }
  }

  async getPodLogs(namespace: string, podName: string, containerName?: string): Promise<string> {
    this.ensureAvailable();
    try {
      const response = await this.coreApi!.readNamespacedPodLog(
        podName,
        namespace,
        containerName,
        undefined, // follow
        undefined, // insecureSkipTLSVerifyBackend
        undefined, // limitBytes
        undefined, // pretty
        undefined, // previous
        undefined, // sinceSeconds
        200,        // tailLines
      );
      return response.body;
    } catch (err) {
      throw wrapK8sError(err, 'readLog', { kind: 'Pod', name: podName, namespace });
    }
  }

  async runJob(
    namespace: string,
    job: k8s.V1Job,
    timeoutMs: number,
    options?: { onLog?: (line: string) => void },
  ): Promise<{ jobName: string; success: boolean; exitCode: number; logs: string | null }> {
    this.ensureAvailable();
    const jobName = job.metadata?.name;
    if (!jobName) {
      throw new Error('Job metadata.name is required');
    }

    try {
      await this.batchApi!.createNamespacedJob(namespace, job);
    } catch (err) {
      throw wrapK8sError(err, 'create', { kind: 'Job', name: jobName, namespace });
    }

    let logStream: { stop: () => void } | null = null;
    if (options?.onLog) {
      try {
        logStream = await this.startJobLogStream(
          namespace,
          jobName,
          options.onLog,
          timeoutMs,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to stream logs for job ${jobName}: ${message}`);
      }
    }

    const status = await this.waitForJobCompletion(namespace, jobName, timeoutMs);

    let logs: string | null = null;
    let exitCode: number | null = null;

    // Wait for job pod to reach terminal phase before reading logs
    const maxLogRetries = 6;
    for (let attempt = 0; attempt <= maxLogRetries; attempt++) {
      try {
        const jobLogs = await this.getJobLogs(namespace, jobName);
        logs = jobLogs.logs;
        exitCode = jobLogs.exitCode;
        if (logs !== null) break;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (attempt < maxLogRetries) {
          this.logger.debug(`Log retrieval for job ${jobName} not ready (attempt ${attempt + 1}): ${errMsg}`);
        } else {
          this.logger.warn(`Failed to retrieve logs for job ${jobName} after ${attempt + 1} attempts: ${errMsg}`);
        }
      }
      if (attempt < maxLogRetries) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    if (logStream) {
      logStream.stop();
    }

    return {
      jobName,
      success: status.success,
      exitCode: status.success ? 0 : (exitCode ?? 1),
      logs,
    };
  }

  private async applyObject(obj: K8sObject): Promise<void> {
    this.ensureAvailable();
    let existingBody: K8sObject | undefined;
    try {
      const existing = await this.objectApi!.read(obj);
      existingBody = existing?.body as K8sObject | undefined;
      obj.metadata.resourceVersion = existingBody?.metadata?.resourceVersion;
      if (obj.kind === 'Service' && existingBody?.spec && obj.spec) {
        obj.spec.clusterIP = existingBody.spec.clusterIP;
        obj.spec.clusterIPs = existingBody.spec.clusterIPs;
        obj.spec.ipFamilies = existingBody.spec.ipFamilies;
        obj.spec.ipFamilyPolicy = existingBody.spec.ipFamilyPolicy;
        const desiredType = typeof obj.spec.type === 'string' ? obj.spec.type : '';
        if (desiredType === 'LoadBalancer') {
          obj.spec.healthCheckNodePort = existingBody.spec.healthCheckNodePort;
        }
        if (desiredType === 'LoadBalancer' || desiredType === 'NodePort') {
          this.preserveServiceNodePorts(obj.spec, existingBody.spec);
        }
      }
    } catch (err) {
      if (isK8sNotFound(err)) {
        try {
          await this.objectApi!.create(obj);
          return;
        } catch (createErr) {
          throw wrapK8sError(createErr, 'create', {
            kind: obj.kind,
            name: obj.metadata.name,
            namespace: obj.metadata.namespace,
          });
        }
      }
      throw wrapK8sError(err, 'read', {
        kind: obj.kind,
        name: obj.metadata.name,
        namespace: obj.metadata.namespace,
      });
    }

    try {
      await this.objectApi!.replace(obj);
    } catch (err) {
      throw wrapK8sError(err, 'replace', {
        kind: obj.kind,
        name: obj.metadata.name,
        namespace: obj.metadata.namespace,
      });
    }
  }

  private preserveServiceNodePorts(
    desiredSpec: Record<string, unknown>,
    existingSpec: Record<string, unknown>,
  ): void {
    const desiredPorts = Array.isArray(desiredSpec.ports) ? desiredSpec.ports : [];
    const existingPorts = Array.isArray(existingSpec.ports) ? existingSpec.ports : [];
    if (desiredPorts.length === 0 || existingPorts.length === 0) return;

    const byName = new Map<string, Record<string, unknown>>();
    const byPort = new Map<string, Record<string, unknown>>();
    for (const port of existingPorts) {
      if (!port || typeof port !== 'object') continue;
      const record = port as Record<string, unknown>;
      if (typeof record.name === 'string') {
        byName.set(record.name, record);
      }
      if (typeof record.port === 'number') {
        byPort.set(this.servicePortKey(record), record);
      }
    }

    desiredSpec.ports = desiredPorts.map((port) => {
      if (!port || typeof port !== 'object') return port;
      const record = { ...(port as Record<string, unknown>) };
      if (record.nodePort !== undefined) return record;
      const existing = (typeof record.name === 'string' ? byName.get(record.name) : undefined)
        ?? byPort.get(this.servicePortKey(record));
      if (typeof existing?.nodePort === 'number') {
        record.nodePort = existing.nodePort;
      }
      return record;
    });
  }

  private servicePortKey(port: Record<string, unknown>): string {
    const protocol = typeof port.protocol === 'string' ? port.protocol : 'TCP';
    const servicePort = typeof port.port === 'number' ? port.port : '';
    return `${protocol}:${servicePort}`;
  }

  private async waitForJobCompletion(
    namespace: string,
    jobName: string,
    timeoutMs: number,
  ): Promise<{ success: boolean }> {
    const start = Date.now();
    let consecutiveErrors = 0;
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await this.batchApi!.readNamespacedJob(jobName, namespace);
        const status = response.body.status;
        const succeeded = status?.succeeded ?? 0;
        const failed = status?.failed ?? 0;
        consecutiveErrors = 0;
        if (succeeded > 0) {
          return { success: true };
        }
        if (failed > 0) {
          return { success: false };
        }
      } catch (error) {
        consecutiveErrors++;
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to poll job ${jobName} status (attempt ${consecutiveErrors}): ${errMsg}`,
        );
        if (consecutiveErrors >= 5) {
          throw wrapK8sError(error, 'read', { kind: 'Job', name: jobName, namespace });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(`Job ${jobName} did not complete within ${timeoutMs}ms`);
  }

  private async getJobLogs(
    namespace: string,
    jobName: string,
  ): Promise<{ logs: string | null; exitCode: number | null }> {
    let pods: { body: { items: k8s.V1Pod[] } };
    try {
      pods = await this.coreApi!.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `job-name=${jobName}`,
      );
    } catch (err) {
      throw wrapK8sError(err, 'list', { kind: 'Pod', namespace });
    }

    // Prefer pods in terminal phase; skip pods still in Pending
    const pod = pods.body.items.find((item) => item.status?.phase === 'Succeeded')
      ?? pods.body.items.find((item) => item.status?.phase === 'Failed')
      ?? pods.body.items[0];
    const podName = pod?.metadata?.name;
    if (!podName) {
      return { logs: null, exitCode: null };
    }

    // Don't attempt log retrieval if the pod is still Pending (no container running yet)
    const phase = pod.status?.phase;
    if (phase === 'Pending') {
      return { logs: null, exitCode: null };
    }

    const containerName = pod.spec?.containers?.[0]?.name ?? 'main';
    const logs = await this.getPodLogs(namespace, podName, containerName);
    const termination = pod.status?.containerStatuses?.[0]?.state?.terminated;
    const exitCode = termination?.exitCode ?? null;

    return { logs, exitCode };
  }

  private async startJobLogStream(
    namespace: string,
    jobName: string,
    onLog: (line: string) => void,
    timeoutMs: number,
  ): Promise<{ stop: () => void }> {
    this.ensureAvailable();
    const pod = await this.waitForJobPod(namespace, jobName, timeoutMs);
    if (!pod?.metadata?.name) {
      throw new Error(`No pod found for job ${jobName}`);
    }

    const podName = pod.metadata.name;
    const containerName = pod.spec?.containers?.[0]?.name ?? 'main';
    const log = new k8s.Log(this.kc!);
    const stream = new PassThrough();
    const buffer = this.createLineBuffer(onLog);

    stream.on('data', (chunk) => buffer.push(chunk.toString()));

    const req = await log.log(
      namespace,
      podName,
      containerName,
      stream,
      { follow: true, pretty: false, timestamps: false },
    );

    return {
      stop: () => {
        try {
          req.abort();
        } catch {
          // ignore
        }
        stream.end();
        buffer.flush();
      },
    };
  }

  private async waitForJobPod(
    namespace: string,
    jobName: string,
    timeoutMs: number,
  ): Promise<k8s.V1Pod | null> {
    const deadline = Date.now() + Math.min(timeoutMs, 60_000);
    while (Date.now() < deadline) {
      let pods: { body: { items: k8s.V1Pod[] } };
      try {
        pods = await this.coreApi!.listNamespacedPod(
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `job-name=${jobName}`,
        );
      } catch (err) {
        throw wrapK8sError(err, 'list', { kind: 'Pod', namespace });
      }
      const pod = pods.body.items[0];
      if (pod) {
        return pod;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return null;
  }

  private createLineBuffer(onLine: (line: string) => void) {
    let buffer = '';
    return {
      push: (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line) {
            onLine(line);
          }
          index = buffer.indexOf('\n');
        }
      },
      flush: () => {
        const line = buffer.replace(/\r$/, '');
        if (line) {
          onLine(line);
        }
        buffer = '';
      },
    };
  }

  private ensureAvailable(): void {
    if (!this.available) {
      throw new Error('Kubernetes client not available (no active cluster)');
    }
  }
}
