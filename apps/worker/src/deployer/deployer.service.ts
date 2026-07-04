import { Inject, Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import * as crypto from 'crypto';
import type { Db } from '@eve/db';
import {
  environmentQueries,
  releaseQueries,
  projectQueries,
  projectManifestQueries,
  orgQueries,
  managedDbQueries,
  ingressAliasQueries,
  customDomainQueries,
  storageBucketQueries,
  appLinkSubscriptionQueries,
} from '@eve/db';
import yaml from 'yaml';
import {
  loadConfig,
  type Healthcheck,
  type ManagedDbSslMode,
  type ManagedDbTrustInput,
  type Manifest,
  type Service,
  getServicesFromManifest,
  getManagedDbServices,
  getManagedDbConfig,
  ManifestSchema,
  redactLogData,
  generateManagedDbName,
  generateManagedDbUser,
  generateManagedDbTenantId,
  selectBestInstance,
  isEveRegistry,
  getRegistryConfig,
  resolveProjectSecrets,
  resolveBackupConfig,
  mintServiceToken,
  mintAppLinkToken,
  getServicePermissions,
  DEFAULT_SERVICE_PERMISSIONS,
  getManifestCustomDomains,
  isPlatformDomainHostname,
  generateCustomDomainId,
  resolveManagedDbTrustBundle,
  getServiceObjectStoreBuckets,
  getServiceObjectStoreIsolation,
  generateStorageBucketId,
  requiresStableEgress,
  normalizeManagedDbExtensions,
  DEFAULT_INGRESS_MAX_BODY_SIZE,
  DEFAULT_INGRESS_TIMEOUT,
  parseIngressDuration,
  toK8sName,
  toK8sLabelValue,
  combineK8sName,
  appendK8sSuffix,
  deriveNamespace,
  type ObjectStoreBucket,
  type ObjectStoreIsolation,
  type TcpIngressConfig,
} from '@eve/shared';
import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import { K8sService } from './k8s.service';
import { BucketProvisioner } from './bucket-provisioner';
import {
  createAppCredentialProvisioners,
  type AppCredentialProvisioner,
  type AppObjectStoreBinding,
  type AppObjectStoreCredentialMode,
  type AppObjectStoreScope,
} from './app-credential-provisioner/factory';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  classifyFromSnapshot,
  DeployFailureError,
  type ClusterSnapshot,
  type PodSnapshot,
} from './deploy-failure.js';

/**
 * K8s probe configuration for readiness/liveness checks
 */
interface K8sProbe {
  exec?: { command: string[] };
  httpGet?: { path: string; port: number; scheme?: 'HTTP' | 'HTTPS' };
  tcpSocket?: { port: number };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

type IngressFlavor = 'nginx' | 'traefik' | 'unknown';

const DEFAULT_APP_CPU_REQUEST = '25m';
const DEFAULT_APP_MEMORY_REQUEST = '64Mi';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readResourceList(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const resources: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record ?? {})) {
    if (key.trim().length === 0) {
      continue;
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      resources[key] = raw.trim();
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      resources[key] = String(raw);
    }
  }
  return resources;
}

/**
 * Deployment options for environment deployments
 */
export interface DeploymentOptions {
  /** Image tag to deploy */
  imageTag?: string;
  /** Skip release image preflight checks */
  skipPreflight?: boolean;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Number of replicas (default: 1) */
  replicas?: number;
  /** Resource requests/limits */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  /** Timeout for deployment to become ready (seconds) */
  timeout?: number;
}

/**
 * Deployment status response
 */
export interface DeploymentStatus {
  /** Environment ID */
  envId: string;
  /** Current release ID (if any) */
  currentReleaseId?: string;
  /** Deployment state */
  state: 'pending' | 'deploying' | 'ready' | 'failed' | 'unknown';
  /** Deployment message */
  message?: string;
  /** K8s namespace for this environment */
  namespace?: string;
  /** Detailed status from K8s */
  k8sStatus?: {
    ready: boolean;
    availableReplicas: number;
    desiredReplicas: number;
    conditions: Array<{ type: string; status: string; message?: string }>;
  };
}

export interface JobRunResult {
  jobName: string;
  success: boolean;
  exitCode: number;
  logs: string | null;
}

interface AliasIngressCandidate {
  alias: string;
  serviceName: string;
  ingressManifest: string;
}

interface CustomDomainIngressCandidate {
  hostname: string;
  serviceName: string;
  ingressManifest: string;
  ingressName: string;
  certSecretName: string;
}

interface RenderManifestResult {
  manifestYaml: string;
  services: Record<string, Service>;
  aliasIngresses: AliasIngressCandidate[];
  customDomainIngresses: CustomDomainIngressCandidate[];
  desiredTcpIngressServices: string[];
}

type ServiceStorageConfig = {
  mountPath: string;
  size: string;
  accessMode: 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany';
  storageClassName?: string;
  pvcName: string;
  volumeName: string;
};

interface ResolvedManagedDbContext {
  managedValues: Map<string, string>;
  trustInputs: ManagedDbTrustInput[];
}

interface ManagedDbTrustContext {
  enabled: boolean;
  checksum?: string;
  envEntries: k8s.V1EnvVar[];
  volumes: k8s.V1Volume[];
  volumeMounts: k8s.V1VolumeMount[];
}

interface ObjectStoreDesiredBucket {
  serviceName: string;
  bucket: ObjectStoreBucket;
  physicalName: string;
  envKey: string;
  requestedIsolation: ObjectStoreIsolation;
}

interface EnvObjectStorePlan {
  scope: AppObjectStoreScope;
  binding: AppObjectStoreBinding | null;
  bucketsByService: Map<string, ObjectStoreDesiredBucket[]>;
}

/**
 * Result of `planStableEgressInjection`. See the method for semantics.
 */
type StableEgressPlan =
  | null
  | { mode: 'noop' }
  | {
      mode: 'eks';
      nodeSelector: Record<string, string>;
      tolerations: Array<{ key: string; operator: 'Equal'; value: string; effect: string }>;
      hostNetwork: true;
      dnsPolicy: 'ClusterFirstWithHostNet';
      appEnv: { name: string; value: string };
    };

type TcpIngressPlan =
  | null
  | { mode: 'noop' }
  | {
      mode: 'aws-nlb' | 'klipper';
      serviceName: string;
      serviceManifest: Record<string, unknown>;
      envEntries: k8s.V1EnvVar[];
    };

const MANAGED_DB_TRUST_CONFIG_MAP_NAME = 'eve-db-trust';
const MANAGED_DB_TRUST_VOLUME_NAME = 'eve-db-trust';
const MANAGED_DB_TRUST_MOUNT_PATH = '/etc/eve/trust';
const MANAGED_DB_TRUST_BUNDLE_PATH = `${MANAGED_DB_TRUST_MOUNT_PATH}/ca-bundle.pem`;

/**
 * DeployerService - Handles environment deployments to K8s
 */
@Injectable()
export class DeployerService {
  private readonly logger = new Logger(DeployerService.name);
  private environments: ReturnType<typeof environmentQueries>;
  private releases: ReturnType<typeof releaseQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private managedDb: ReturnType<typeof managedDbQueries>;
  private ingressAliases: ReturnType<typeof ingressAliasQueries>;
  private customDomains: ReturnType<typeof customDomainQueries>;
  private appLinkSubscriptions: ReturnType<typeof appLinkSubscriptionQueries>;
  private storageBuckets: ReturnType<typeof storageBucketQueries>;
  private readonly registrySecretName = 'eve-registry';
  private readonly bucketProvisioner = new BucketProvisioner();
  private appCredentialProvisioners: AppCredentialProvisioner[] =
    createAppCredentialProvisioners(this.bucketProvisioner);

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly k8sService: K8sService
  ) {
    this.environments = environmentQueries(db);
    this.releases = releaseQueries(db);
    this.projects = projectQueries(db);
    this.manifests = projectManifestQueries(db);
    this.orgs = orgQueries(db);
    this.managedDb = managedDbQueries(db);
    this.ingressAliases = ingressAliasQueries(db);
    this.customDomains = customDomainQueries(db);
    this.appLinkSubscriptions = appLinkSubscriptionQueries(db);
    this.storageBuckets = storageBucketQueries(db);
  }

  /**
   * Deploy a release to an environment
   */
  async deploy(envId: string, releaseId: string, options?: DeploymentOptions): Promise<DeploymentStatus> {
    this.logger.log(`Deploying release ${releaseId} to environment ${envId}`);
    if (options) {
      this.logger.log(`Options: ${JSON.stringify(redactLogData(options))}`);
    }

    const environment = await this.environments.findById(envId);
    if (!environment) {
      throw new Error(`Environment ${envId} not found`);
    }

    const release = await this.releases.findById(releaseId);
    if (!release) {
      throw new Error(`Release ${releaseId} not found`);
    }

    if (release.project_id !== environment.project_id) {
      throw new Error(
        `Release ${releaseId} does not belong to environment project ${environment.project_id}`
      );
    }

    const project = await this.projects.findById(release.project_id, { include_deleted: true });
    if (!project) {
      throw new Error(`Project ${release.project_id} not found`);
    }

    const org = await this.orgs.findById(project.org_id);
    if (!org) {
      throw new Error(`Org ${project.org_id} not found for project ${project.id}`);
    }

    const manifest = await this.manifests.findByProjectAndHash(
      release.project_id,
      release.manifest_hash
    );
    if (!manifest) {
      throw new Error(`Manifest ${release.manifest_hash} not found for project ${release.project_id}`);
    }

    if (!options?.skipPreflight) {
      this.validateReleaseImageDigests(release.id, release.image_digests_json, manifest.manifest_yaml);
    }

    const namespace = deriveNamespace(org.slug, project.slug, environment.name, environment.namespace);

    await this.k8sService.createNamespace(namespace, {
      'eve.org_id': project.org_id,
      'eve.project_id': project.id,
      'eve.env_id': envId,
      'eve.env': toK8sLabelValue(environment.name, 'env'),
    });

    const imagePullSecret = await this.ensureImagePullSecret({
      namespace,
      projectId: project.id,
      manifestYaml: manifest.manifest_yaml,
    });

    // For file:// repo URLs, we can read local secrets directly
    const repoPath = this.extractLocalRepoPath(project.repo_url);
    if (repoPath) {
      this.logger.log(`Using local repo path for secrets: ${repoPath}`);
    }

    const renderResult = await this.renderManifest({
      manifestYaml: manifest.manifest_yaml,
      namespace,
      envId,
      envName: environment.name,
      projectSlug: project.slug,
      projectId: project.id,
      orgId: project.org_id,
      orgSlug: org.slug,
      releaseId,
      imageDigests: release.image_digests_json ?? undefined,
      imagePullSecret,
      imageTag: options?.imageTag,
      repoPath,
      envOverrides: environment.overrides_json ?? undefined,
    });

    const aliasDocuments: string[] = [];
    const desiredBoundAliases = new Set<string>();
    const newlyBoundAliases = new Set<string>();
    for (const candidate of renderResult.aliasIngresses) {
      const existingAlias = await this.ingressAliases.findByAlias(candidate.alias);
      const bound = await this.ingressAliases.bindToEnvironment(
        candidate.alias,
        project.id,
        envId,
        candidate.serviceName,
      );
      if (!bound) {
        if (existingAlias && existingAlias.project_id === project.id && existingAlias.environment_id && existingAlias.environment_id !== envId) {
          this.logger.warn(
            `Skipping vanity ingress ${candidate.alias}: alias already bound to environment ${existingAlias.environment_id}`,
          );
        } else {
          this.logger.warn(`Skipping vanity ingress ${candidate.alias}: alias claim unavailable`);
        }
        continue;
      }

      desiredBoundAliases.add(candidate.alias);
      aliasDocuments.push(candidate.ingressManifest);
      if (!existingAlias || existingAlias.environment_id !== envId) {
        newlyBoundAliases.add(candidate.alias);
      }
    }

    // Custom domain binding — first-bind-wins: the first env to deploy with a
    // hostname keeps ownership. Later envs that reference the same hostname
    // skip rendering the ingress (and log who owns it) rather than silently
    // stealing it.
    const customDomainDocuments: string[] = [];
    const desiredDomains = new Set<string>();
    const newlyBoundDomains = new Set<string>();

    for (const candidate of renderResult.customDomainIngresses) {
      // Ensure domain is registered before binding (handles case where sync didn't run).
      // claimOrUpdate only mutates service_name when the row is unbound — same-project
      // owned-by-other-env rows are returned unchanged, so we don't corrupt metadata
      // for a domain we're about to skip.
      const claimed = await this.customDomains.claimOrUpdate({
        id: generateCustomDomainId(),
        hostname: candidate.hostname,
        project_id: project.id,
        service_name: candidate.serviceName,
        source: 'manifest',
      });

      if (!claimed) {
        this.logger.warn(`Custom domain ${candidate.hostname} claimed by another project — skipping`);
        continue;
      }

      const wasAlreadyBoundToThisEnv = claimed.environment_id === envId;
      const bound = await this.customDomains.bindToEnvironment(
        candidate.hostname,
        project.id,
        envId,
        candidate.serviceName,
        'manifest',
      );

      if (!bound) {
        // Another env in this project owns the hostname. Look up its name so the
        // deploy log points at the actual owning environment, then skip — we do
        // NOT add it to desiredDomains and do NOT emit its ingress manifest, so
        // the ingress is never rendered into this namespace.
        const ownerName = await this.resolveOwningEnvName(candidate.hostname);
        this.logger.warn(
          `Custom domain ${candidate.hostname}: owned by environment "${ownerName ?? 'unknown'}" — skipping in this env. ` +
          `To move the domain, run: eve domain transfer ${candidate.hostname} --to ${environment.name}`,
        );
        continue;
      }

      desiredDomains.add(candidate.hostname);
      if (!wasAlreadyBoundToThisEnv) {
        newlyBoundDomains.add(candidate.hostname);
      }

      const dnsResult = await this.verifyCustomDomainDns(candidate.hostname);
      if (dnsResult.ok) {
        await this.customDomains.updateStatus(candidate.hostname, 'dns_verified', {
          ingress_name: candidate.ingressName,
          cert_secret_name: candidate.certSecretName,
        });
        customDomainDocuments.push(candidate.ingressManifest);
        await this.customDomains.updateStatus(candidate.hostname, 'cert_provisioning');
        this.logger.log(`Custom domain ${candidate.hostname}: DNS verified (${dnsResult.resolvedTo}), ingress created`);
      } else {
        const target = this.getPlatformIngressTarget();
        await this.customDomains.updateStatus(candidate.hostname, 'pending_dns', {
          ingress_name: candidate.ingressName,
          cert_secret_name: candidate.certSecretName,
        });
        this.logger.warn(
          `Custom domain ${candidate.hostname}: DNS not pointing to platform. ` +
          `Point to ${target.hostname || target.ips[0] || 'platform ingress'} and run: eve domain verify ${candidate.hostname}`
        );
      }
    }

    const allExtraDocuments = [...aliasDocuments, ...customDomainDocuments];
    const manifestToApply = allExtraDocuments.length > 0
      ? `${renderResult.manifestYaml}---\n${allExtraDocuments.join('---\n')}`
      : renderResult.manifestYaml;

    let applyStarted = false;
    try {
      await this.garbageCollectAliasIngresses(namespace, Array.from(desiredBoundAliases.values()));
      await this.garbageCollectCustomDomainIngresses(namespace, Array.from(desiredDomains.values()), envId);
      await this.garbageCollectTcpIngressServices(namespace, renderResult.desiredTcpIngressServices ?? []);

      for (const [serviceName, service] of Object.entries(renderResult.services)) {
        const storage = this.resolvePersistentStorage(service, serviceName);
        if (!storage) continue;
        const labelEnv = toK8sLabelValue(environment.name, 'env');
        const labelComponent = toK8sLabelValue(serviceName, 'component');
        const labels = {
          'eve.org_id': project.org_id,
          'eve.project_id': project.id,
          'eve.env_id': envId,
          'eve.env': labelEnv,
          'eve.component': labelComponent,
          'eve.release': releaseId,
        };
        await this.k8sService.createPersistentVolumeClaim(
          namespace,
          this.buildPersistentVolumeClaim(storage, labels),
        );
      }

      applyStarted = true;
      await this.k8sService.applyManifest(namespace, manifestToApply);

      const readinessTimeoutMs = options?.timeout ? options.timeout * 1000 : 120000;

      await this.waitForServiceDependencies({
        namespace,
        envName: environment.name,
        services: renderResult.services,
        timeoutMs: readinessTimeoutMs,
      });

      const k8sStatus = Object.keys(renderResult.services).length > 0
        ? await this.waitForDeploymentReadiness(namespace, readinessTimeoutMs)
        : await this.k8sService.getDeploymentStatus(namespace);

      return {
        envId,
        currentReleaseId: releaseId,
        state: k8sStatus.ready ? 'ready' : 'deploying',
        message: `Deployment ${k8sStatus.ready ? 'completed' : 'in progress'}`,
        namespace,
        k8sStatus,
      };
    } catch (error) {
      if (newlyBoundAliases.size > 0) {
        try {
          await this.ingressAliases.unbindAliasesForEnvironment(envId, Array.from(newlyBoundAliases.values()));
        } catch (unbindError) {
          const details = unbindError instanceof Error ? unbindError.message : String(unbindError);
          this.logger.warn(`Failed to unbind ingress aliases after deploy error: ${details}`);
        }
      }
      if (newlyBoundDomains.size > 0) {
        try {
          await this.customDomains.unbindDomainsForEnvironment(envId, Array.from(newlyBoundDomains.values()));
        } catch (unbindError) {
          const details = unbindError instanceof Error ? unbindError.message : String(unbindError);
          this.logger.warn(`Failed to unbind custom domains after deploy error: ${details}`);
        }
      }

      // Classify the failure using the post-apply cluster snapshot plus any
      // K8sOperationError carried by the underlying error. When we can
      // classify, rethrow a DeployFailureError so handleDeploy can persist the
      // structured payload and the CLI can render a "Next step" hint.
      try {
        const snapshot = await this.collectClusterSnapshot({
          namespace,
          projectId: project.id,
          envName: environment.name,
        });
        const failure = classifyFromSnapshot(snapshot, error);
        if (failure) {
          throw new DeployFailureError(failure, snapshot, {
            cause: error,
            manifestApplied: applyStarted,
          });
        }
      } catch (inner) {
        // A DeployFailureError we just created is what we want to propagate.
        if (inner instanceof DeployFailureError) {
          throw inner;
        }
        // Snapshot collection itself failed — fall back to the original error.
        this.logger.warn(
          `Cluster snapshot after deploy failure unavailable: ${
            inner instanceof Error ? inner.message : String(inner)
          }`,
        );
      }
      throw error;
    }
  }

  /**
   * Collect pod + container state for the env's namespace, ordered so pods
   * most likely to explain a failure sort first. Safe to call on success as
   * well — callers that only want state on failure guard the call site.
   */
  async collectClusterSnapshot(params: {
    namespace: string;
    projectId: string;
    envName: string;
  }): Promise<ClusterSnapshot> {
    const envLabel = toK8sLabelValue(params.envName, 'env');
    const selector = `eve.project_id=${params.projectId},eve.env=${envLabel}`;
    const pods = await this.k8sService.listPodsWithLabel(params.namespace, selector);

    const podSnaps: PodSnapshot[] = pods.map((p) => {
      const containerStatuses = p.status?.containerStatuses ?? [];
      const containers = containerStatuses.map((cs) => {
        const state = cs.state ?? {};
        const lastState = cs.lastState ?? {};
        const running = state.running;
        const waiting = state.waiting;
        const terminated = state.terminated;
        const lastTerminated = lastState.terminated;
        const stateName: 'running' | 'waiting' | 'terminated' | 'unknown' = running
          ? 'running'
          : waiting
            ? 'waiting'
            : terminated
              ? 'terminated'
              : 'unknown';
        return {
          name: cs.name,
          ready: cs.ready ?? false,
          restartCount: cs.restartCount ?? 0,
          image: cs.image ?? null,
          state: stateName,
          waitingReason: waiting?.reason ?? null,
          terminatedReason: terminated?.reason ?? null,
          terminatedExitCode: terminated?.exitCode ?? null,
          lastTerminatedReason: lastTerminated?.reason ?? null,
          lastTerminatedExitCode: lastTerminated?.exitCode ?? null,
        };
      });
      const ready = containerStatuses.length === 0 ? false : containerStatuses.every((c) => c.ready);
      const restartCount = containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
      return {
        name: p.metadata?.name ?? '',
        namespace: p.metadata?.namespace ?? params.namespace,
        phase: p.status?.phase ?? 'Unknown',
        ready,
        restartCount,
        service: p.metadata?.labels?.['eve.component'] ?? null,
        containers,
      };
    });

    // Sort failing pods first: CrashLoop/ImagePull reasons, then by not-ready
    // with highest restart count, then by creation time (newest first).
    const badReasons = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerError']);
    podSnaps.sort((a, b) => {
      const aBad = a.containers.some((c) => c.waitingReason && badReasons.has(c.waitingReason));
      const bBad = b.containers.some((c) => c.waitingReason && badReasons.has(c.waitingReason));
      if (aBad !== bBad) return aBad ? -1 : 1;
      if (a.ready !== b.ready) return a.ready ? 1 : -1;
      return b.restartCount - a.restartCount;
    });

    return {
      namespace: params.namespace,
      pods: podSnaps,
      capturedAt: new Date().toISOString(),
    };
  }

  async runJobService(params: {
    projectId: string;
    envName: string;
    manifestYaml: string;
    serviceName: string;
    attemptId: string;
    releaseId?: string | null;
    imageDigests?: Record<string, string>;
    imageTag?: string;
    timeoutSeconds?: number;
    repoPath?: string;
  }): Promise<JobRunResult> {
    const environment = await this.environments.findByProjectAndName(params.projectId, params.envName);
    if (!environment) {
      throw new Error(`Environment ${params.envName} not found for project ${params.projectId}`);
    }

    const project = await this.projects.findById(environment.project_id, { include_deleted: true });
    if (!project) {
      throw new Error(`Project ${environment.project_id} not found`);
    }

    const org = await this.orgs.findById(project.org_id);
    if (!org) {
      throw new Error(`Org ${project.org_id} not found for project ${project.id}`);
    }

    const namespace = deriveNamespace(org.slug, project.slug, environment.name, environment.namespace);

    await this.k8sService.createNamespace(namespace, {
      'eve.org_id': project.org_id,
      'eve.project_id': project.id,
      'eve.env_id': environment.id,
      'eve.env': toK8sLabelValue(environment.name, 'env'),
    });

    const imagePullSecret = await this.ensureImagePullSecret({
      namespace,
      projectId: project.id,
      manifestYaml: params.manifestYaml,
    });

    const repoPath = params.repoPath ?? this.extractLocalRepoPath(project.repo_url);
    const parsed = yaml.parse(params.manifestYaml);
    const validated = ManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Invalid manifest: ${this.formatZodIssues(validated.error.issues)}`);
    }
    const manifest = validated.data;
    const services = getServicesFromManifest(manifest) ?? {};

    const envConfig = this.getEnvConfig(manifest as Record<string, unknown>, params.envName);
    const envOverrides = this.getEnvOverrides(envConfig);
    const envWorkers = this.getEnvWorkers(envConfig);
    const dbOverrides = this.getDbOverrides(environment.overrides_json ?? undefined);
    const mergedServices = this.applyServiceOverrides(services, [envOverrides, dbOverrides]);

    const service = mergedServices[params.serviceName];
    if (!service) {
      throw new Error(`Service ${params.serviceName} not found in manifest`);
    }

    const xeve = this.resolveXeve(service);
    if (xeve?.role !== 'job') {
      throw new Error(`Service ${params.serviceName} is not marked as x-eve.role: job`);
    }

    await this.waitForJobDependencies({
      namespace,
      envName: params.envName,
      services: mergedServices,
      serviceName: params.serviceName,
      timeoutMs: (params.timeoutSeconds ?? 300) * 1000,
    });

    const secretsMap = new Map<string, string>();
    const secretResult = await resolveProjectSecrets(params.projectId);
    if (!secretResult.resolved) {
      this.logger.warn(`Cannot resolve secrets for job service: ${secretResult.error}`);
    }
    for (const secret of secretResult.secrets) {
      secretsMap.set(secret.key, secret.value);
    }

    if (repoPath) {
      const localSecrets = await this.loadLocalSecrets(repoPath, params.envName);
      for (const [key, value] of localSecrets.entries()) {
        secretsMap.set(key, value);
      }
    }

    // Resolve managed DB values for job service interpolation
    const managedDbContext = await this.resolveManagedDbTenants({
      manifest: validated.data,
      envId: environment.id,
      orgId: project.org_id,
      orgSlug: org.slug,
      projectId: params.projectId,
      projectSlug: project.slug,
      envName: params.envName,
    });
    const managedTrust = await this.ensureManagedDbTrustStore(namespace, managedDbContext.trustInputs);
    const objectStorePlan = await this.prepareObjectStorePlan({
      services: mergedServices,
      envWorkers,
      scope: {
        orgId: project.org_id,
        projectId: params.projectId,
        envName: params.envName,
        orgSlug: org.slug,
        projectSlug: project.slug,
        namespace,
      },
    });

    const interpolationContext = {
      envName: params.envName,
      projectId: params.projectId,
      orgId: project.org_id,
      orgSlug: org.slug,
      projectSlug: project.slug,
      componentName: params.serviceName,
      secrets: secretsMap,
      managedValues: managedDbContext.managedValues,
    };

    const envEntries = this.mergeEnvEntries(
      await this.resolveServiceEnvEntries(service, interpolationContext, objectStorePlan),
      managedTrust.envEntries,
    );
    const { command, args } = this.resolveServiceCommand(service);

    const envSlug = toK8sName(params.envName, 'environment');
    const serviceSlug = toK8sName(params.serviceName, 'service');
    const attemptSlug = toK8sName(params.attemptId.slice(-8), 'job');
    const jobSlug = toK8sName(`${serviceSlug}-${attemptSlug}`, 'job');
    const jobName = combineK8sName(envSlug, jobSlug, 'job');

    const labels = {
      'eve.org_id': project.org_id,
      'eve.project_id': project.id,
      'eve.env_id': environment.id,
      'eve.env': toK8sLabelValue(params.envName, 'env'),
      'eve.component': toK8sLabelValue(params.serviceName, 'component'),
      'eve.release': params.releaseId ?? 'unknown',
    };

    const storage = this.resolvePersistentStorage(service, params.serviceName);
    if (storage) {
      await this.k8sService.createPersistentVolumeClaim(
        namespace,
        this.buildPersistentVolumeClaim(storage, labels),
      );
    }

    const { volumes, volumeMounts } = this.resolveServiceVolumes(service, params.serviceName);

    // Handle x-eve.files - create ConfigMaps and add to volumes/mounts
    const { volumes: fileVolumes, volumeMounts: fileMounts, configMapNames } = await this.resolveXeveFiles(
      xeve,
      repoPath,
      namespace,
      jobName,
    );

    const allVolumes = this.mergeVolumes(
      [...volumes, ...fileVolumes],
      managedTrust.volumes,
    );
    const allVolumeMounts = this.mergeVolumeMounts(
      [...volumeMounts, ...fileMounts],
      managedTrust.volumeMounts,
    );

    const registryHost = this.resolveRegistryHost(manifest);
    const imageDigest = this.resolveServiceDigest(
      params.serviceName,
      service,
      services as Record<string, Service>,
      params.imageDigests,
    );
    // Auto-derive image from service key when build config exists but image is not explicit
    const derivedImage = service.image || (service.build ? params.serviceName : undefined);
    const prefixedImage = derivedImage ? this.prefixRegistryHost(derivedImage, registryHost) : undefined;
    const resolvedImage = this.resolveImageRef(
      prefixedImage,
      imageDigest,
      params.imageTag,
    );
    const image = await this.normalizeImageForKubelet(resolvedImage);
    if (!image || typeof image !== 'string') {
      throw new Error(`Service ${params.serviceName} missing image`);
    }

    const jobSpec: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        labels,
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: {
            labels,
            annotations: this.buildPodAnnotations({
              managedDbTrustHash: managedTrust.checksum,
              objectStorePlan,
              serviceName: params.serviceName,
            }),
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: this.resolveObjectStoreServiceAccountName(objectStorePlan, params.serviceName),
            imagePullSecrets: imagePullSecret ? [{ name: imagePullSecret }] : undefined,
            volumes: allVolumes.length > 0 ? allVolumes : undefined,
            containers: [
              {
                name: jobSlug,
                image,
                env: envEntries,
                command: command ?? undefined,
                args: args ?? undefined,
                volumeMounts: allVolumeMounts.length > 0 ? allVolumeMounts : undefined,
                workingDir: this.resolveServiceWorkingDir(service) ?? undefined,
              },
            ],
          },
        },
      },
    };

    const result = await this.k8sService.runJob(namespace, jobSpec, (params.timeoutSeconds ?? 300) * 1000);

    // Clean up ConfigMaps created for x-eve.files
    for (const cmName of configMapNames) {
      try {
        await this.k8sService.deleteConfigMap(namespace, cmName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to clean up ConfigMap ${cmName}: ${message}`);
      }
    }

    return {
      jobName: result.jobName,
      success: result.success,
      exitCode: result.exitCode,
      logs: result.logs,
    };
  }
  /**
   * Get deployment status for an environment
   */
  async getDeploymentStatus(envId: string): Promise<DeploymentStatus> {
    this.logger.log(`Getting deployment status for environment ${envId}`);
    const { namespace, environment } = await this.resolveEnvironmentScope(envId);
    const k8sStatus = await this.k8sService.getDeploymentStatus(namespace);

    const currentReleaseId = environment.current_release_id ?? undefined;
    const hasDesiredReplicas = k8sStatus.desiredReplicas > 0;
    const state = k8sStatus.ready
      ? 'ready'
      : hasDesiredReplicas
        ? 'deploying'
        : 'pending';
    const message = k8sStatus.ready
      ? 'Deployment ready'
      : hasDesiredReplicas
        ? `Deploying (${k8sStatus.availableReplicas}/${k8sStatus.desiredReplicas} replicas available)`
        : 'No deployments found';

    return {
      envId,
      currentReleaseId,
      state,
      message,
      namespace,
      k8sStatus,
    };
  }

  /**
   * Rollback an environment to a previous release
   */
  async rollback(envId: string, releaseId: string): Promise<DeploymentStatus> {
    this.logger.log(`Rolling back environment ${envId} to release ${releaseId}`);
    return this.deploy(envId, releaseId);
  }

  /**
   * Delete an environment deployment
   */
  async deleteEnvironment(envId: string): Promise<void> {
    this.logger.log(`Deleting environment ${envId}`);
    const { namespace, environment, project, org } = await this.resolveEnvironmentScope(envId);
    await this.removeObjectStoreBinding({
      orgId: project.org_id,
      projectId: project.id,
      envName: environment.name,
      orgSlug: org.slug,
      projectSlug: project.slug,
      namespace,
    });
    await this.storageBuckets.deleteByEnv(project.id, environment.name);
    await this.k8sService.deleteNamespace(namespace);
  }

  /**
   * Render a minimal K8s manifest from the Eve manifest.
   * Phase 1 supports services with image + optional port/env/replicas.
   */
  private async renderManifest(params: {
    manifestYaml: string;
    namespace: string;
    envId: string;
    envName: string;
    projectSlug: string;
    projectId: string;
    orgId: string;
    orgSlug: string;
    releaseId: string;
    imageDigests?: Record<string, string>;
    imagePullSecret?: string | null;
    imageTag?: string;
    repoPath?: string;
    envOverrides?: Record<string, unknown> | null;
  }): Promise<RenderManifestResult> {
    const parsed = yaml.parse(params.manifestYaml);
    const validated = ManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Invalid manifest: ${this.formatZodIssues(validated.error.issues)}`);
    }
    const manifest = validated.data;
    const services = getServicesFromManifest(manifest);

    if (!services || typeof services !== 'object') {
      throw new Error('Manifest missing services');
    }

    const envConfig = this.getEnvConfig(manifest as Record<string, unknown>, params.envName);
    const envOverrides = this.getEnvOverrides(envConfig);
    const dbOverrides = this.getDbOverrides(params.envOverrides);
    const mergedServices = this.applyServiceOverrides(services, [envOverrides, dbOverrides]);
    const envWorkers = this.getEnvWorkers(envConfig);

    // Resolve managed DB tenants before filtering (managed_db services get filtered out)
    const managedDbContext = await this.resolveManagedDbTenants({
      manifest,
      envId: params.envId,
      orgId: params.orgId,
      orgSlug: params.orgSlug,
      projectId: params.projectId,
      projectSlug: params.projectSlug,
      envName: params.envName,
    });
    const managedTrust = await this.ensureManagedDbTrustStore(params.namespace, managedDbContext.trustInputs);

    const deployableServices = this.filterDeployableServices(mergedServices, envWorkers);
    const objectStorePlan = await this.prepareObjectStorePlan({
      services: mergedServices,
      envWorkers,
      scope: {
        orgId: params.orgId,
        projectId: params.projectId,
        envName: params.envName,
        orgSlug: params.orgSlug,
        projectSlug: params.projectSlug,
        namespace: params.namespace,
      },
    });
    const registryHost = this.resolveRegistryHost(manifest);
    const config = loadConfig();
    const hasTcpIngress = Object.values(deployableServices).some((service) => this.resolveTcpIngressConfig(service));
    if (hasTcpIngress) {
      await this.assertTcpIngressProviderReady(config.EVE_TCP_INGRESS_PROVIDER);
    }

    // Collect secrets for interpolation
    const secretsMap = new Map<string, string>();

    // First, resolve secrets from API
    const secretResult = await resolveProjectSecrets(params.projectId);
    if (!secretResult.resolved) {
      this.logger.warn(`Cannot resolve secrets for manifest rendering: ${secretResult.error}`);
    }
    for (const secret of secretResult.secrets) {
      secretsMap.set(secret.key, secret.value);
    }

    // Then, load local secrets (these override API secrets for dev convenience)
    if (params.repoPath) {
      const localSecrets = await this.loadLocalSecrets(params.repoPath, params.envName);
      for (const [key, value] of localSecrets.entries()) {
        secretsMap.set(key, value);
      }
    }

    const documents: string[] = [];
    const aliasIngresses: AliasIngressCandidate[] = [];
    const customDomainIngresses: CustomDomainIngressCandidate[] = [];
    const desiredTcpIngressServices: string[] = [];
    const envSlug = toK8sName(params.envName, 'environment');

    const serviceAccount = this.buildObjectStoreServiceAccount(objectStorePlan);
    if (serviceAccount) {
      documents.push(yaml.stringify(serviceAccount));
    }

    // Sort services topologically so dependencies are deployed first
    const sortedServices = this.topologicalSort(deployableServices as Record<string, Service>);

    for (const { name, component: service } of sortedServices) {
      if (!service || typeof service !== 'object') {
        continue;
      }

      const componentSlug = toK8sName(name, 'component');
      const resourceName = combineK8sName(envSlug, componentSlug, 'resource');

      // Auto-derive image from service key when build config exists but image is not explicit
      const derivedImage = service.image || (service.build ? name : undefined);
      const baseImage = derivedImage ? this.prefixRegistryHost(derivedImage, registryHost) : undefined;
      const imageDigest = this.resolveServiceDigest(
        name,
        service,
        deployableServices as Record<string, Service>,
        params.imageDigests,
      );
      const resolvedImage = this.resolveImageRef(baseImage, imageDigest, params.imageTag);
      const image = await this.normalizeImageForKubelet(resolvedImage);
      if (!image || typeof image !== 'string') {
        throw new Error(`Service ${name} missing image`);
      }

      const replicas = this.resolveServiceReplicas(service, envWorkers, name);
      const isDatabase = this.isDatabaseRole(service);

      // Validate: RWO PVC with replicas > 1 is dangerous
      const storage = this.resolvePersistentStorage(service, name);
      if (storage && storage.accessMode === 'ReadWriteOnce' && replicas > 1) {
        throw new Error(
          `Service '${name}' has a ReadWriteOnce PVC but ${replicas} replicas. ` +
          `RWO volumes can only be mounted by a single pod. ` +
          `Set replicas to 1 or change access_mode to ReadWriteMany.`
        );
      }
      const ports = this.parseServicePorts(service.ports);

      // Plan stable-egress injection (no-op unless x-eve.networking.egress=stable
      // and the cluster compute model is EKS).
      const stableEgressPlan = this.planStableEgressInjection(service, name);
      if (stableEgressPlan && stableEgressPlan.mode !== 'noop') {
        this.validateStableEgressPhase1(name, replicas, ports);
      }

      const labelEnv = toK8sLabelValue(params.envName, 'env');
      const labelComponent = toK8sLabelValue(name, 'component');
      const labels = {
        'eve.org_id': params.orgId,
        'eve.project_id': params.projectId,
        'eve.env_id': params.envId,
        'eve.env': labelEnv,
        'eve.component': labelComponent,
        'eve.release': params.releaseId,
      };

      const tcpIngressPlan = this.planTcpIngressService({
        service,
        serviceName: name,
        ports,
        provider: config.EVE_TCP_INGRESS_PROVIDER,
        hostedZone: config.EVE_TCP_INGRESS_HOSTED_ZONE ?? config.EVE_DEFAULT_DOMAIN ?? '',
        resourceName,
        componentSlug,
        envSlug,
        orgSlug: toK8sName(params.orgSlug, 'org'),
        projectSlug: toK8sName(params.projectSlug, 'project'),
        labels,
        selector: {
          'eve.env': labelEnv,
          'eve.component': labelComponent,
        },
      });

      // Build interpolation context for this component
      const interpolationContext = {
        envName: params.envName,
        projectId: params.projectId,
        orgId: params.orgId,
        orgSlug: params.orgSlug,
        projectSlug: params.projectSlug,
        componentName: name,
        secrets: secretsMap,
        managedValues: managedDbContext.managedValues,
      };

      const baseEnvEntries = this.mergeEnvEntries(
        await this.resolveServiceEnvEntries(service, interpolationContext, objectStorePlan),
        managedTrust.envEntries,
      );
      const envEntries = stableEgressPlan && stableEgressPlan.mode === 'eks'
        ? this.mergeEnvEntries(baseEnvEntries, [stableEgressPlan.appEnv])
        : baseEnvEntries;
      const finalEnvEntries = tcpIngressPlan && tcpIngressPlan.mode !== 'noop'
        ? this.mergeEnvEntries(envEntries, tcpIngressPlan.envEntries)
        : envEntries;

      const { volumes, volumeMounts } = this.resolveServiceVolumes(service, name);
      const allVolumes = this.mergeVolumes(volumes, managedTrust.volumes);
      const allVolumeMounts = this.mergeVolumeMounts(volumeMounts, managedTrust.volumeMounts);


      // Database services need Recreate strategy (RWO PVCs can't be mounted by two pods)
      // and extra time for clean shutdown (WAL checkpoint + flush).
      //
      // Stable-egress services on EKS also need Recreate: the pod runs with
      // hostNetwork on a single-node egress pool, so RollingUpdate's default
      // maxSurge would create a new pod that can't schedule (the existing pod
      // already binds the container port on the node). Phase 1 already
      // enforces replicas=1, so killing-then-recreating is a brief gap, not
      // an availability hit.
      const isStableEgressEks = stableEgressPlan?.mode === 'eks';
      const strategy = (isDatabase || isStableEgressEks)
        ? { type: 'Recreate' }
        : undefined;

      const terminationGracePeriodSeconds = isDatabase ? 120 : undefined;

      // preStop hook gives the database process time to shut down cleanly
      // before SIGTERM is sent to PID 1
      const lifecycle = isDatabase
        ? {
            preStop: {
              exec: {
                command: [
                  '/bin/sh', '-c',
                  'pg_ctl stop -D /var/lib/postgresql/data -m fast 2>/dev/null || true',
                ],
              },
            },
          }
        : undefined;

      const deployment: Record<string, any> = {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: resourceName,
          labels,
        },
        spec: {
          replicas,
          strategy,
          selector: {
            matchLabels: {
              'eve.env': labelEnv,
              'eve.component': labelComponent,
            },
          },
          template: {
            metadata: {
              labels: {
                'eve.env': labelEnv,
                'eve.component': labelComponent,
                'eve.org_id': params.orgId,
                'eve.project_id': params.projectId,
                'eve.env_id': params.envId,
                'eve.release': params.releaseId,
              },
              annotations: this.buildPodAnnotations({
                managedDbTrustHash: managedTrust.checksum,
                objectStorePlan,
                serviceName: name,
              }),
            },
            spec: {
              imagePullSecrets: params.imagePullSecret ? [{ name: params.imagePullSecret }] : undefined,
              serviceAccountName: this.resolveObjectStoreServiceAccountName(objectStorePlan, name),
              terminationGracePeriodSeconds,
              volumes: allVolumes.length > 0 ? allVolumes : undefined,
              containers: [
                (() => {
                  const containerPorts = ports.map(port => ({ containerPort: port }));
                  const resources = this.resolveServiceResources(service);
                  const container: Record<string, any> = {
                    name,
                    image,
                    ports: containerPorts.length > 0 ? containerPorts : undefined,
                    env: finalEnvEntries.length > 0 ? finalEnvEntries : undefined,
                    volumeMounts: allVolumeMounts.length > 0 ? allVolumeMounts : undefined,
                    resources,
                    lifecycle,
                  };

                  // Add readiness/liveness probes from healthcheck config
                  const probe = this.healthcheckToK8sProbe(service.healthcheck);
                  if (probe) {
                    container.readinessProbe = probe;
                    container.livenessProbe = {
                      ...probe,
                      initialDelaySeconds: (probe.initialDelaySeconds ?? 0) + 30, // Start liveness after readiness
                    };
                  }

                  return container;
                })(),
              ],
            },
          },
        },
      };

      // Stable-egress injection: hostNetwork pod scheduled on the public
      // egress node group. See planStableEgressInjection for shape semantics
      // and docs/plans/app-stable-egress-v2-plan.md for the rationale.
      if (stableEgressPlan && stableEgressPlan.mode === 'eks') {
        const podSpec = deployment.spec.template.spec as Record<string, unknown>;
        podSpec.hostNetwork = stableEgressPlan.hostNetwork;
        podSpec.dnsPolicy = stableEgressPlan.dnsPolicy;
        podSpec.nodeSelector = {
          ...((podSpec.nodeSelector as Record<string, string> | undefined) ?? {}),
          ...stableEgressPlan.nodeSelector,
        };
        const existingTolerations = Array.isArray(podSpec.tolerations) ? podSpec.tolerations : [];
        podSpec.tolerations = [...existingTolerations, ...stableEgressPlan.tolerations];
      }

      documents.push(yaml.stringify(deployment));

      if (ports.length > 0) {
        const service = {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: {
            name: resourceName,
            labels,
          },
          spec: {
            type: 'ClusterIP',
            selector: {
              'eve.env': labelEnv,
              'eve.component': labelComponent,
            },
            ports: ports.map((port, index) => ({
              name: `port-${port}-${index}`,
              port,
              targetPort: port,
            })),
          },
        };

        documents.push(yaml.stringify(service));
      }

      if (tcpIngressPlan && tcpIngressPlan.mode !== 'noop') {
        documents.push(yaml.stringify(tcpIngressPlan.serviceManifest));
        desiredTcpIngressServices.push(tcpIngressPlan.serviceName);
      }
    }

    const domain = config.EVE_DEFAULT_DOMAIN ?? '';
    const ingressClassName = config.EVE_DEFAULT_INGRESS_CLASS;
    const ingressFlavor = this.resolveIngressFlavor(ingressClassName);
    const defaultIngressTimeout = config.EVE_DEFAULT_INGRESS_TIMEOUT ?? DEFAULT_INGRESS_TIMEOUT;
    const defaultIngressMaxBodySize = config.EVE_DEFAULT_INGRESS_MAX_BODY_SIZE ?? DEFAULT_INGRESS_MAX_BODY_SIZE;
    const tlsClusterIssuer = config.EVE_DEFAULT_TLS_CLUSTER_ISSUER;
    const tlsSecretOverride = config.EVE_DEFAULT_TLS_SECRET;
    const explicitIngressTuningRequested = Object.values(deployableServices).some((service) => {
      const ingress = this.resolveIngressConfig(service);
      return this.hasExplicitIngressTuning(ingress);
    });
    if (ingressFlavor !== 'nginx' && explicitIngressTuningRequested) {
      this.logger.warn(
        `ingress tuning requested but controller flavour is ${ingressFlavor}; annotations skipped ` +
        `(orgId=${params.orgId} projectId=${params.projectId} envName=${params.envName})`
      );
    }
    if (typeof domain === 'string' && domain.length > 0) {
      Object.entries(deployableServices).forEach(([name, service]) => {
        const ingressConfig = this.resolveIngressConfig(service);
        const ports = this.parseServicePorts(service.ports);
        const ingressPort = this.resolveIngressPort(ingressConfig, ports);

        if (!ingressConfig && ports.length === 0) {
          return;
        }

        const isPublic = ingressConfig
          ? Boolean((ingressConfig as Record<string, unknown>).public)
          : true;

        if (!isPublic || !ingressPort) {
          return;
        }

        const componentSlug = toK8sName(name, 'component');
        const resourceName = combineK8sName(envSlug, componentSlug, 'resource');
        const orgSlug = toK8sName(params.orgSlug, 'org');
        const projectSlug = toK8sName(params.projectSlug, 'project');

        // URL pattern: {component}.{orgSlug}-{project}-{env}.{domain}
        // Example: web.acme-fstack-test.lvh.me, api.acme-myapp-staging.apps.example.com
        const host = `${componentSlug}.${orgSlug}-${projectSlug}-${envSlug}.${domain}`;
        const labelEnv = toK8sLabelValue(params.envName, 'env');
        const labelComponent = toK8sLabelValue(name, 'component');
        const labels = {
          'eve.org_id': params.orgId,
          'eve.project_id': params.projectId,
          'eve.env_id': params.envId,
          'eve.env': labelEnv,
          'eve.component': labelComponent,
          'eve.release': params.releaseId,
        };

        const annotations = this.buildIngressAnnotations({
          ingress: ingressConfig,
          tlsClusterIssuer,
          ingressFlavor,
          defaultTimeout: defaultIngressTimeout,
          defaultMaxBodySize: defaultIngressMaxBodySize,
        });

        const tlsSecretName = tlsSecretOverride ?? `${resourceName}-tls`;

        const ingress = {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'Ingress',
          metadata: {
            name: resourceName,
            labels,
            annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
          },
          spec: {
            ingressClassName: ingressClassName || undefined,
            rules: [
              {
                host,
                http: {
                  paths: [
                    {
                      path: '/',
                      pathType: 'Prefix',
                      backend: {
                        service: {
                          name: resourceName,
                          port: { number: ingressPort },
                        },
                      },
                    },
                  ],
                },
              },
            ],
            tls: (tlsClusterIssuer || tlsSecretOverride)
              ? [{ hosts: [host], secretName: tlsSecretName }]
              : undefined,
          },
        };

        documents.push(yaml.stringify(ingress));

        // Custom domain ingresses (must be processed before alias early-return)
        const serviceDomains = this.resolveIngressDomains(ingressConfig);
        for (const hostname of serviceDomains) {
          const hostnameSlug = hostname.replace(/\./g, '-');
          const domainResourceName = toK8sName(
            `${resourceName}-cd-${hostnameSlug}`,
            'resource'
          );
          const domainCertSecretName = `${domainResourceName}-tls`;

          const domainAnnotations = this.buildIngressAnnotations({
            ingress: ingressConfig,
            tlsClusterIssuer,
            ingressFlavor,
            defaultTimeout: defaultIngressTimeout,
            defaultMaxBodySize: defaultIngressMaxBodySize,
          });

          const domainIngress = {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'Ingress',
            metadata: {
              name: domainResourceName,
              labels: {
                ...labels,
                'eve.custom_domain': 'true',
                'eve.domain_hostname': toK8sLabelValue(hostname, 'hostname'),
              },
              annotations: Object.keys(domainAnnotations).length > 0
                ? domainAnnotations : undefined,
            },
            spec: {
              ingressClassName: ingressClassName || undefined,
              rules: [{
                host: hostname,
                http: {
                  paths: [{
                    path: '/',
                    pathType: 'Prefix',
                    backend: {
                      service: { name: resourceName, port: { number: ingressPort } },
                    },
                  }],
                },
              }],
              tls: tlsClusterIssuer
                ? [{ hosts: [hostname], secretName: domainCertSecretName }]
                : undefined,
            },
          };

          customDomainIngresses.push({
            hostname,
            serviceName: name,
            ingressManifest: yaml.stringify(domainIngress),
            ingressName: domainResourceName,
            certSecretName: domainCertSecretName,
          });
        }

        const alias = this.resolveIngressAlias(ingressConfig);
        if (!alias) {
          return;
        }

        const aliasResourceName = toK8sName(`${resourceName}-alias-${alias}`, 'resource');
        const aliasHost = `${alias}.${domain}`;
        const aliasLabels = {
          ...labels,
          'eve.alias': alias,
          'eve.ingress_alias': 'true',
        };
        const aliasTlsSecretName = tlsSecretOverride ?? `${aliasResourceName}-tls`;
        const aliasIngress = {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'Ingress',
          metadata: {
            name: aliasResourceName,
            labels: aliasLabels,
            annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
          },
          spec: {
            ingressClassName: ingressClassName || undefined,
            rules: [
              {
                host: aliasHost,
                http: {
                  paths: [
                    {
                      path: '/',
                      pathType: 'Prefix',
                      backend: {
                        service: {
                          name: resourceName,
                          port: { number: ingressPort },
                        },
                      },
                    },
                  ],
                },
              },
            ],
            tls: (tlsClusterIssuer || tlsSecretOverride)
              ? [{ hosts: [aliasHost], secretName: aliasTlsSecretName }]
              : undefined,
          },
        };

        aliasIngresses.push({
          alias,
          serviceName: name,
          ingressManifest: yaml.stringify(aliasIngress),
        });
      });
    }

    return {
      manifestYaml: documents.join('---\n'),
      services: deployableServices,
      aliasIngresses,
      customDomainIngresses,
      desiredTcpIngressServices,
    };
  }

  private async garbageCollectAliasIngresses(namespace: string, desiredAliases: string[]): Promise<void> {
    const desired = new Set(desiredAliases.map((alias) => alias.toLowerCase()));
    const existing = await this.k8sService.listAliasIngresses(namespace);

    for (const ingress of existing) {
      const alias = ingress.alias?.toLowerCase();
      if (!alias || desired.has(alias)) {
        continue;
      }

      await this.k8sService.deleteIngress(namespace, ingress.name);
      this.logger.log(`Deleted stale alias ingress ${ingress.name} (${alias}) from ${namespace}`);
    }
  }

  private async garbageCollectCustomDomainIngresses(
    namespace: string,
    desiredHostnames: string[],
    currentEnvId: string,
  ): Promise<void> {
    const desired = new Set(desiredHostnames.map((h) => h.toLowerCase()));
    const existing = await this.k8sService.listCustomDomainIngresses(namespace);

    for (const ingress of existing) {
      const hostname = ingress.hostname?.toLowerCase();
      if (!hostname || desired.has(hostname)) {
        continue;
      }

      // Always safe to delete a stale ingress in *our* namespace — even if the
      // domain was transferred to another env (in which case we're just cleaning
      // up the ex-owner's ingress).
      await this.k8sService.deleteIngress(namespace, ingress.name);
      this.logger.log(`Deleted stale custom domain ingress ${ingress.name} (${hostname}) from ${namespace}`);

      // Only set status='removed' when this env still owns the DB row. If the
      // row is unbound or owned by another env, the domain is still alive
      // elsewhere — leave its status alone.
      try {
        const current = await this.customDomains.findByHostname(hostname);
        if (current && current.environment_id === currentEnvId) {
          await this.customDomains.updateStatus(hostname, 'removed');
        }
      } catch {
        // Domain may have been deleted already
      }
    }
  }

  private async garbageCollectTcpIngressServices(namespace: string, desiredServiceNames: string[]): Promise<void> {
    const k8sService = this.k8sService as K8sService & {
      listTcpIngressServices?: K8sService['listTcpIngressServices'];
      deleteService?: K8sService['deleteService'];
    };
    if (!k8sService.listTcpIngressServices || !k8sService.deleteService) {
      return;
    }
    const desired = new Set(desiredServiceNames);
    const existing = await k8sService.listTcpIngressServices(namespace);

    for (const service of existing) {
      if (desired.has(service.name)) {
        continue;
      }

      await k8sService.deleteService(namespace, service.name);
      this.logger.log(`Deleted stale TCP ingress Service ${service.name} from ${namespace}`);
    }
  }

  private async assertTcpIngressProviderReady(provider: 'none' | 'aws-nlb' | 'klipper'): Promise<void> {
    if (provider !== 'aws-nlb' || !this.k8sService) {
      return;
    }

    const k8sService = this.k8sService as K8sService & {
      deploymentExists?: K8sService['deploymentExists'];
    };
    if (!k8sService.deploymentExists) {
      return;
    }

    try {
      const exists = await k8sService.deploymentExists('kube-system', 'aws-load-balancer-controller');
      if (!exists) {
        throw new Error(
          'EVE_TCP_INGRESS_PROVIDER=aws-nlb requires deployment/aws-load-balancer-controller in kube-system',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Kubernetes client not available')) {
        return;
      }
      throw error;
    }
  }

  private planTcpIngressService(params: {
    service: Service;
    serviceName: string;
    ports: number[];
    provider: 'none' | 'aws-nlb' | 'klipper';
    hostedZone: string;
    resourceName: string;
    componentSlug: string;
    envSlug: string;
    orgSlug: string;
    projectSlug: string;
    labels: Record<string, string>;
    selector: Record<string, string>;
  }): TcpIngressPlan {
    const tcpIngress = this.resolveTcpIngressConfig(params.service);
    if (!tcpIngress) {
      return null;
    }

    this.validateTcpIngressConfig(tcpIngress, params.serviceName, params.ports);

    if (params.provider === 'none') {
      this.logger.warn(
        `Service '${params.serviceName}' declares x-eve.tcp_ingress but EVE_TCP_INGRESS_PROVIDER=none; ` +
        'skipping public TCP LoadBalancer Service.',
      );
      return { mode: 'noop' };
    }

    const hostedZone = params.hostedZone.trim().toLowerCase();
    if (!hostedZone) {
      throw new Error(
        `Service '${params.serviceName}' declares x-eve.tcp_ingress but no TCP ingress hosted zone is configured. ` +
        'Set EVE_TCP_INGRESS_HOSTED_ZONE or EVE_DEFAULT_DOMAIN.',
      );
    }

    const publicHost = tcpIngress.hostname
      ? `${tcpIngress.hostname}.${hostedZone}`
      : `${params.componentSlug}.${params.orgSlug}-${params.projectSlug}-${params.envSlug}.${hostedZone}`;
    const tcpServiceName = appendK8sSuffix(params.resourceName, 'tcp', 'tcp ingress service');
    const annotations = params.provider === 'aws-nlb'
      ? {
          'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
          'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'instance',
          'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
          'service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol': 'HTTP',
          'service.beta.kubernetes.io/aws-load-balancer-healthcheck-path': '/healthz',
          'service.beta.kubernetes.io/aws-load-balancer-attributes': 'load_balancing.cross_zone.enabled=true',
        }
      : undefined;

    const envEntries: k8s.V1EnvVar[] = [
      { name: 'EVE_TCP_PUBLIC_HOST', value: publicHost },
      ...tcpIngress.listeners.flatMap((listener) => {
        const suffix = listener.name.toUpperCase().replace(/-/g, '_');
        return [
          { name: `EVE_TCP_LISTENER_${suffix}_PORT`, value: String(listener.port) },
          { name: `EVE_TCP_LISTENER_${suffix}_HOST`, value: publicHost },
        ];
      }),
    ];

    const labels = {
      ...params.labels,
      'eve.tcp_ingress': 'true',
    };

    const serviceManifest: Record<string, unknown> = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: tcpServiceName,
        labels,
        annotations: {
          ...(annotations ?? {}),
          'eve.io/tcp-ingress-host': publicHost,
          'eve.io/tcp-ingress-provider': params.provider,
        },
      },
      spec: {
        type: 'LoadBalancer',
        externalTrafficPolicy: 'Local',
        loadBalancerSourceRanges: tcpIngress.allow_cidrs?.length ? tcpIngress.allow_cidrs : undefined,
        selector: params.selector,
        ports: tcpIngress.listeners.map((listener) => ({
          name: listener.name,
          protocol: 'TCP',
          port: listener.port,
          targetPort: listener.port,
        })),
      },
    };

    return {
      mode: params.provider,
      serviceName: tcpServiceName,
      serviceManifest,
      envEntries,
    };
  }

  private validateTcpIngressConfig(config: TcpIngressConfig, serviceName: string, servicePorts: number[]): void {
    const servicePortSet = new Set(servicePorts);
    const seenPorts = new Set<number>();

    for (const listener of config.listeners) {
      if (!servicePortSet.has(listener.port)) {
        throw new Error(
          `Service '${serviceName}' tcp_ingress listener '${listener.name}' uses port ${listener.port}, ` +
          'but that port is not declared in the service ports list.',
        );
      }
      if (seenPorts.has(listener.port)) {
        throw new Error(`Service '${serviceName}' tcp_ingress declares duplicate listener port ${listener.port}`);
      }
      seenPorts.add(listener.port);
      if (listener.port >= 30000 && listener.port <= 32767) {
        throw new Error(
          `Service '${serviceName}' tcp_ingress listener '${listener.name}' uses port ${listener.port} ` +
          'in the Kubernetes NodePort range (30000-32767). Pick an app port outside this range.',
        );
      }
    }

    for (const cidr of config.allow_cidrs ?? []) {
      if (!this.isValidCidr(cidr)) {
        throw new Error(`Service '${serviceName}' tcp_ingress allow_cidrs contains invalid CIDR "${cidr}"`);
      }
    }
  }

  private isValidCidr(value: string): boolean {
    const parts = value.split('/');
    if (parts.length !== 2) return false;
    const [address, prefixRaw] = parts;
    const family = net.isIP(address);
    if (family === 0) return false;
    if (!/^\d+$/.test(prefixRaw)) return false;
    const prefix = Number(prefixRaw);
    const max = family === 4 ? 32 : 128;
    return Number.isInteger(prefix) && prefix >= 0 && prefix <= max;
  }

  private async resolveOwningEnvName(hostname: string): Promise<string | null> {
    try {
      const row = await this.customDomains.findByHostname(hostname);
      if (!row?.environment_id) return null;
      const env = await this.environments.findById(row.environment_id);
      return env?.name ?? null;
    } catch {
      return null;
    }
  }

  private async verifyCustomDomainDns(hostname: string): Promise<{ ok: boolean; resolvedTo?: string }> {
    const target = this.getPlatformIngressTarget();
    if (target.ips.length === 0 && !target.hostname) {
      return { ok: false };
    }

    try {
      // Check A records — any of the platform IPs matching is sufficient
      try {
        const addresses = await dns.resolve4(hostname);
        const matchedIp = target.ips.find((ip) => addresses.includes(ip));
        if (matchedIp) {
          return { ok: true, resolvedTo: `A ${matchedIp}` };
        }
      } catch {
        // No A records
      }

      // Check CNAME
      try {
        const cnames = await dns.resolveCname(hostname);
        if (target.hostname && cnames.some((c) => c === target.hostname)) {
          return { ok: true, resolvedTo: `CNAME ${target.hostname}` };
        }

        // CNAME chain: might resolve to our IP indirectly
        if (target.ips.length > 0) {
          for (const cname of cnames) {
            try {
              const cnameAddresses = await dns.resolve4(cname);
              const matchedIp = target.ips.find((ip) => cnameAddresses.includes(ip));
              if (matchedIp) {
                return { ok: true, resolvedTo: `CNAME ${cname} → A ${matchedIp}` };
              }
            } catch {
              // CNAME target doesn't resolve
            }
          }
        }
      } catch {
        // No CNAME records
      }

      return { ok: false };
    } catch {
      return { ok: false };
    }
  }

  private getPlatformIngressTarget(): { ips: string[]; hostname: string } {
    const config = loadConfig();
    const rawIp = config.EVE_PLATFORM_INGRESS_IP ?? '';
    // Support comma-separated IPs (e.g., multi-AZ load balancers)
    const ips = rawIp.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      ips,
      hostname: config.EVE_PLATFORM_INGRESS_HOSTNAME ?? '',
    };
  }

  /**
   * Resolve managed DB tenants for all managed_db services in the manifest.
   * Creates tenants if they don't exist, polls until ready.
   * Returns interpolation values plus trust inputs for provider CA resolution.
   */
  private async resolveManagedDbTenants(params: {
    manifest: Manifest;
    envId: string;
    orgId: string;
    orgSlug: string;
    projectId: string;
    projectSlug: string;
    envName: string;
  }): Promise<ResolvedManagedDbContext> {
    const managedValues = new Map<string, string>();
    const trustInputs: ManagedDbTrustInput[] = [];
    const managedServices = getManagedDbServices(params.manifest);

    if (Object.keys(managedServices).length === 0) {
      return { managedValues, trustInputs };
    }

    for (const [serviceName, service] of Object.entries(managedServices)) {
      const config = getManagedDbConfig(service);
      const dbClass = config?.class ?? 'db.p1';
      const desiredExtensions = normalizeManagedDbExtensions(config?.extensions ?? []);

      // Check for existing tenant
      let tenant = await this.managedDb.findTenantByEnv(params.envId, serviceName);

      if (tenant?.status === 'failed') {
        const token = crypto.randomUUID();
        const locked = await this.managedDb.acquireOperationLock(tenant.id, token);
        if (locked) {
          await this.managedDb.transitionStatus(tenant.id, token, 'provisioning', {
            error: {
              code: 'retry',
              message: `Retrying managed DB tenant after previous provisioning failure: ${tenant.last_error_message ?? 'unknown'}`,
            },
          });
          tenant = await this.managedDb.findTenantByEnv(params.envId, serviceName);
          this.logger.warn(
            `Retrying managed DB tenant ${tenant?.id ?? ''} for ${serviceName} in env ${params.envName} ` +
            `after previous failure`,
          );
        } else {
          this.logger.warn(
            `Managed DB tenant ${tenant.id} for ${serviceName} in env ${params.envName} is locked ` +
            `while failed; continuing to poll current state`,
          );
        }
      }

      if (!tenant) {
        // Find best instance via placement
        const instancesWithCounts = await this.managedDb.listActiveInstancesWithCounts();
        const tenantCounts = new Map<string, number>();
        for (const inst of instancesWithCounts) {
          tenantCounts.set(inst.id, inst.tenant_count);
        }

        const placement = selectBestInstance({
          dbClass,
          instances: instancesWithCounts,
          tenantCounts,
        });

        if (!placement) {
          throw new Error(
            `No available managed DB instance for class "${dbClass}". ` +
            `Ensure a local or cloud instance is registered and available.`,
          );
        }

        // Create tenant record
        const dbName = generateManagedDbName(params.orgSlug, params.projectSlug, params.envName);
        const dbUser = generateManagedDbUser(params.orgSlug, params.projectSlug, params.envName);

        tenant = await this.managedDb.createTenant({
          id: generateManagedDbTenantId(),
          org_id: params.orgId,
          project_id: params.projectId,
          env_id: params.envId,
          service_name: serviceName,
          instance_id: placement.instanceId,
          db_name: dbName,
          db_user: dbUser,
          class: dbClass,
          desired_extensions: desiredExtensions,
        });

        this.logger.log(
          `Created managed DB tenant ${tenant.id} for ${serviceName} ` +
          `(db=${dbName}, instance=${placement.instanceId})`,
        );
      } else {
        const synced = await this.managedDb.syncTenantDesiredExtensions(tenant.id, desiredExtensions);
        tenant = synced ?? tenant;
      }

      const enabledExtensions = new Set(tenant.enabled_extensions ?? []);
      const missingExtensions = desiredExtensions.filter((extension) => !enabledExtensions.has(extension));
      if (missingExtensions.length > 0 && tenant.status === 'ready') {
        const token = crypto.randomUUID();
        const locked = await this.managedDb.acquireOperationLock(tenant.id, token);
        if (locked) {
          await this.managedDb.transitionStatus(tenant.id, token, 'modifying');
          const refreshed = await this.managedDb.findTenantByEnv(params.envId, serviceName);
          tenant = refreshed ?? tenant;
          this.logger.log(
            `Requested managed DB extension reconcile for tenant ${tenant.id}: ` +
            missingExtensions.join(', '),
          );
        } else {
          this.logger.warn(
            `Managed DB tenant ${tenant.id} needs extension reconcile but is locked; ` +
            `continuing to poll current state`,
          );
        }
      }

      // Poll until tenant is ready (max 60s, 2s interval)
      if (tenant.status !== 'ready') {
        const maxWait = 60_000;
        const pollInterval = 2_000;
        const start = Date.now();

        while (Date.now() - start < maxWait) {
          await new Promise(r => setTimeout(r, pollInterval));
          const refreshed = await this.managedDb.findTenantByEnv(params.envId, serviceName);
          if (!refreshed) {
            throw new Error(`Managed DB tenant for ${serviceName} disappeared during provisioning`);
          }
          if (refreshed.status === 'ready') {
            tenant = refreshed;
            break;
          }
          if (refreshed.status === 'failed') {
            throw new Error(
              `Managed DB provisioning failed for ${serviceName}: ` +
              `${refreshed.last_error_code}: ${refreshed.last_error_message}`,
            );
          }
        }

        if (tenant.status !== 'ready') {
          throw new Error(
            `Managed DB tenant for ${serviceName} did not reach ready state within ${maxWait / 1000}s ` +
            `(current: ${tenant.status})`,
          );
        }
      }

      const missingAfterReady = desiredExtensions.filter(
        (extension) => !(tenant.enabled_extensions ?? []).includes(extension),
      );
      if (missingAfterReady.length > 0) {
        throw new Error(
          `Managed DB tenant for ${serviceName} reached ready before requested extension(s) were enabled: ` +
          missingAfterReady.join(', '),
        );
      }

      // Sync backup config from manifest (or apply class-based defaults)
      const backupConfig = resolveBackupConfig(dbClass, config?.backup);
      await this.managedDb.syncTenantBackupConfig(tenant.id, backupConfig);
      this.logger.log(
        `Synced backup config for tenant ${tenant.id}: ` +
        `schedule=${backupConfig.backup_schedule ?? 'none'}, ` +
        `retention=${backupConfig.backup_retention ?? 'none'}, ` +
        `snapshot_on_delete=${backupConfig.snapshot_on_delete}, ` +
        `snapshot_on_reset=${backupConfig.snapshot_on_reset}`,
      );

      const instance = await this.managedDb.findInstanceById(tenant.instance_id);
      if (!instance) {
        throw new Error(`Managed DB instance ${tenant.instance_id} not found for tenant ${tenant.id}`);
      }

      trustInputs.push({
        provider: instance.provider,
        region: instance.region,
      });

      // Store connection URL for interpolation: ${managed.<serviceName>.url}
      // The credential URL's sslmode is set by the reconciler (inherits from DATABASE_URL).
      // The deployer must not overwrite it — "local" provider instances may be RDS on staging.
      if (tenant.credential_secret_ref) {
        managedValues.set(`${serviceName}.url`, tenant.credential_secret_ref);
      }
      managedValues.set(`${serviceName}.extensions`, desiredExtensions.join(','));
    }

    return { managedValues, trustInputs };
  }

  private async ensureManagedDbTrustStore(
    namespace: string,
    trustInputs: ManagedDbTrustInput[],
  ): Promise<ManagedDbTrustContext> {
    const bundle = await resolveManagedDbTrustBundle(trustInputs);
    if (!bundle) {
      return {
        enabled: false,
        envEntries: [],
        volumes: [],
        volumeMounts: [],
      };
    }

    await this.k8sService.createConfigMap(namespace, MANAGED_DB_TRUST_CONFIG_MAP_NAME, {
      'ca-bundle.pem': bundle,
    });

    const checksum = crypto.createHash('sha256').update(bundle).digest('hex');

    return {
      enabled: true,
      checksum,
      envEntries: [
        { name: 'NODE_EXTRA_CA_CERTS', value: MANAGED_DB_TRUST_BUNDLE_PATH },
        { name: 'PGSSLROOTCERT', value: MANAGED_DB_TRUST_BUNDLE_PATH },
      ],
      volumes: [
        {
          name: MANAGED_DB_TRUST_VOLUME_NAME,
          configMap: { name: MANAGED_DB_TRUST_CONFIG_MAP_NAME },
        },
      ],
      volumeMounts: [
        {
          name: MANAGED_DB_TRUST_VOLUME_NAME,
          mountPath: MANAGED_DB_TRUST_MOUNT_PATH,
          readOnly: true,
        },
      ],
    };
  }

  private mergeEnvEntries(base: k8s.V1EnvVar[], injected: k8s.V1EnvVar[]): k8s.V1EnvVar[] {
    if (injected.length === 0) {
      return base;
    }

    const injectedNames = new Set(injected.map((entry) => entry.name).filter((name): name is string => typeof name === 'string'));
    return [
      ...base.filter((entry) => !entry.name || !injectedNames.has(entry.name)),
      ...injected,
    ];
  }

  private mergeVolumes(base: k8s.V1Volume[], injected: k8s.V1Volume[]): k8s.V1Volume[] {
    if (injected.length === 0) {
      return base;
    }

    const injectedNames = new Set(injected.map((volume) => volume.name));
    return [
      ...base.filter((volume) => !injectedNames.has(volume.name)),
      ...injected,
    ];
  }

  private mergeVolumeMounts(base: k8s.V1VolumeMount[], injected: k8s.V1VolumeMount[]): k8s.V1VolumeMount[] {
    if (injected.length === 0) {
      return base;
    }

    const injectedNames = new Set(injected.map((mount) => mount.name));
    return [
      ...base.filter((mount) => !injectedNames.has(mount.name)),
      ...injected,
    ];
  }

  private getEnvConfig(parsed: Record<string, unknown> | null, envName: string): Record<string, unknown> | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const environments = (parsed as Record<string, unknown>).environments;
    if (!environments || typeof environments !== 'object') return null;
    const envConfig = (environments as Record<string, unknown>)[envName];
    return envConfig && typeof envConfig === 'object' ? envConfig as Record<string, unknown> : null;
  }

  private getEnvOverrides(envConfig: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!envConfig) return null;
    const overrides = envConfig.overrides;
    if (!overrides || typeof overrides !== 'object') return null;
    const services = (overrides as Record<string, unknown>).services;
    return services && typeof services === 'object' ? services as Record<string, unknown> : null;
  }

  private getDbOverrides(overrides: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!overrides || typeof overrides !== 'object') return null;
    const overrideObj = overrides as Record<string, unknown>;
    const services = overrideObj.services;
    if (services && typeof services === 'object') return services as Record<string, unknown>;
    return overrideObj;
  }

  private applyServiceOverrides(
    base: Record<string, Service>,
    overrides: Array<Record<string, unknown> | null>,
  ): Record<string, Service> {
    const merged: Record<string, Service> = { ...base };

    for (const override of overrides) {
      if (!override) continue;
      for (const [name, value] of Object.entries(override)) {
        if (!value || typeof value !== 'object') continue;
        const current = merged[name] as Record<string, unknown> | undefined;
        const next = current
          ? this.deepMerge(current, value as Record<string, unknown>)
          : (value as Record<string, unknown>);
        merged[name] = next as Service;
      }
    }

    return merged;
  }

  private deepMerge(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (Array.isArray(value)) {
        result[key] = value.slice();
        continue;
      }

      const baseValue = result[key];
      if (this.isPlainObject(baseValue) && this.isPlainObject(value)) {
        result[key] = this.deepMerge(baseValue as Record<string, unknown>, value as Record<string, unknown>);
        continue;
      }

      result[key] = value;
    }
    return result;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private getEnvWorkers(envConfig: Record<string, unknown> | null): Array<Record<string, unknown>> {
    if (!envConfig) return [];
    const workers = envConfig.workers;
    return Array.isArray(workers) ? workers.filter(w => w && typeof w === 'object') as Array<Record<string, unknown>> : [];
  }

  private filterDeployableServices(
    services: Record<string, Service>,
    envWorkers: Array<Record<string, unknown>>,
  ): Record<string, Service> {
    const workerServiceNames = new Set(
      envWorkers
        .map(worker => (worker.service ?? worker.name))
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );

    const result: Record<string, Service> = {};

    for (const [name, service] of Object.entries(services)) {
      const xeve = this.resolveXeve(service);
      if (xeve?.external || xeve?.connection_url) {
        continue;
      }

      if (xeve?.role === 'job') {
        continue;
      }

      // Managed DB services are provisioned by the orchestrator reconciler, not deployed to K8s
      if (xeve?.role === 'managed_db') {
        continue;
      }

      if (xeve?.role === 'worker') {
        if (!workerServiceNames.has(name)) {
          continue;
        }
      }

      result[name] = service;
    }

    return result;
  }

  private resolveServiceReplicas(
    service: Service,
    envWorkers: Array<Record<string, unknown>>,
    name: string,
  ): number {
    const xeve = this.resolveXeve(service);
    if (xeve?.role === 'worker') {
      const match = envWorkers.find(worker => worker.service === name || worker.name === name);
      if (match && typeof match.replicas === 'number') {
        return match.replicas;
      }
    }

    const replicas = (service as Record<string, unknown>).replicas;
    return typeof replicas === 'number' ? replicas : 1;
  }

  private resolveXeve(service: Service): Record<string, unknown> | null {
    const xeve = (service as Record<string, unknown>)['x-eve'] ?? (service as Record<string, unknown>).x_eve;
    return xeve && typeof xeve === 'object' ? xeve as Record<string, unknown> : null;
  }

  /**
   * Plan how to inject stable egress for a service. The result is consumed by
   * `applyStableEgressInjection` during pod-spec rendering.
   *
   * Modes:
   *   - `null` — service did not opt in. No injection.
   *   - `noop` — opted in but cluster compute model is not EKS. Logged once
   *     per render so app authors see the warning in `eve env diagnose`.
   *   - `eks`  — opted in on EKS. Returns the nodeSelector / toleration /
   *     hostNetwork / dnsPolicy / app env to apply.
   */
  private planStableEgressInjection(service: Service, name: string): StableEgressPlan {
    if (!requiresStableEgress(service)) {
      return null;
    }
    const config = loadConfig();
    if (config.EVE_COMPUTE_MODEL !== 'eks') {
      this.logger.warn(
        `Service '${name}' has networking.egress=stable but EVE_COMPUTE_MODEL=${config.EVE_COMPUTE_MODEL}; ` +
        `stable egress is only implemented on EKS. Continuing as a no-op.`
      );
      return { mode: 'noop' };
    }
    return {
      mode: 'eks',
      nodeSelector: {
        [config.EVE_STABLE_EGRESS_NODE_LABEL_KEY]: config.EVE_STABLE_EGRESS_NODE_LABEL_VALUE,
      },
      tolerations: [
        {
          key: config.EVE_STABLE_EGRESS_TAINT_KEY,
          operator: 'Equal',
          value: config.EVE_STABLE_EGRESS_TAINT_VALUE,
          effect: config.EVE_STABLE_EGRESS_TAINT_EFFECT,
        },
      ],
      hostNetwork: true,
      dnsPolicy: 'ClusterFirstWithHostNet',
      appEnv: { name: 'EVE_NETWORK_EGRESS', value: 'stable' },
    };
  }

  /**
   * Phase 1 fail-fasts for stable-egress services. These exist because
   * hostNetwork pods share the node IP and conflicting node ports across
   * services aren't validated at render time yet.
   *
   * Rejects:
   *   - replicas > 1 — would require pod anti-affinity + cluster-wide port
   *     collision validation, which is Phase 2.
   *   - service ports in 30000–32767 — the EKS node SG allows that range from
   *     0.0.0.0/0 for NLB NodePort traffic. A stable-egress hostNetwork pod
   *     binding there would inadvertently expose itself.
   */
  private validateStableEgressPhase1(name: string, replicas: number, ports: number[]): void {
    if (replicas > 1) {
      throw new Error(
        `Service '${name}' has networking.egress=stable but replicas=${replicas}. ` +
        `Phase 1 requires replicas=1; multi-replica hostNetwork services need ` +
        `pod anti-affinity and cluster-wide port-collision validation (Phase 2).`
      );
    }
    const reserved = ports.filter(p => p >= 30000 && p <= 32767);
    if (reserved.length > 0) {
      throw new Error(
        `Service '${name}' has networking.egress=stable with port(s) ${reserved.join(', ')} ` +
        `in the Kubernetes NodePort range (30000-32767). The EKS node SG allows that ` +
        `range from 0.0.0.0/0 for NLB traffic, so a hostNetwork pod listening there would ` +
        `be unintentionally public. Pick a port outside this range.`
      );
    }
  }

  private isDatabaseRole(service: Service): boolean {
    const xeve = this.resolveXeve(service);
    return xeve?.role === 'database';
  }

  private resolveIngressConfig(service: Service): Record<string, unknown> | null {
    const xeve = this.resolveXeve(service);
    const ingress = xeve?.ingress;
    return ingress && typeof ingress === 'object' ? ingress as Record<string, unknown> : null;
  }

  private resolveIngressFlavor(ingressClassName: string | undefined): IngressFlavor {
    const normalized = (ingressClassName ?? '').trim().toLowerCase();
    if (normalized === 'nginx' || normalized === 'nginx-ingress') {
      return 'nginx';
    }
    if (normalized === 'traefik') {
      return 'traefik';
    }
    return 'unknown';
  }

  private hasExplicitIngressTuning(ingress: Record<string, unknown> | null): boolean {
    return typeof ingress?.timeout === 'string' || typeof ingress?.max_body_size === 'string';
  }

  private buildIngressAnnotations(args: {
    ingress: Record<string, unknown> | null;
    tlsClusterIssuer?: string;
    ingressFlavor: IngressFlavor;
    defaultTimeout: string;
    defaultMaxBodySize: string;
  }): Record<string, string> {
    const annotations: Record<string, string> = {};
    if (args.tlsClusterIssuer) {
      annotations['cert-manager.io/cluster-issuer'] = args.tlsClusterIssuer;
    }

    if (args.ingressFlavor !== 'nginx') {
      return annotations;
    }

    const timeout = typeof args.ingress?.timeout === 'string'
      ? args.ingress.timeout
      : args.defaultTimeout;
    const maxBodySize = typeof args.ingress?.max_body_size === 'string'
      ? args.ingress.max_body_size
      : args.defaultMaxBodySize;
    const timeoutSeconds = parseIngressDuration(timeout);

    annotations['nginx.ingress.kubernetes.io/proxy-read-timeout'] = String(timeoutSeconds);
    annotations['nginx.ingress.kubernetes.io/proxy-send-timeout'] = String(timeoutSeconds);
    annotations['nginx.ingress.kubernetes.io/proxy-body-size'] = maxBodySize;
    return annotations;
  }

  private resolveIngressPort(ingress: Record<string, unknown> | null, ports: number[]): number | null {
    if (ingress && typeof ingress.port === 'number') {
      return ingress.port;
    }
    return ports.length > 0 ? ports[0] : null;
  }

  private resolveIngressAlias(ingress: Record<string, unknown> | null): string | null {
    if (!ingress || typeof ingress.alias !== 'string') {
      return null;
    }

    const alias = ingress.alias.trim().toLowerCase();
    if (!alias) {
      return null;
    }

    if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(alias)) {
      this.logger.warn(`Skipping invalid ingress alias "${alias}"`);
      return null;
    }

    return alias;
  }

  private resolveIngressDomains(ingress: Record<string, unknown> | null): string[] {
    if (!ingress || !Array.isArray(ingress.domains)) {
      return [];
    }

    const config = loadConfig();
    const platformDomain = config.EVE_DEFAULT_DOMAIN ?? '';

    return (ingress.domains as string[])
      .map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : ''))
      .filter((d) => {
        if (!d) return false;
        if (platformDomain && isPlatformDomainHostname(d, platformDomain)) {
          this.logger.warn(`Skipping custom domain "${d}": use alias for platform subdomains`);
          return false;
        }
        return true;
      });
  }

  private formatZodIssues(issues: Array<{ path: Array<string | number>; message: string }>): string {
    return issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'manifest';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
  }

  private resolveTcpIngressConfig(service: Service): TcpIngressConfig | null {
    const xeve = this.resolveXeve(service);
    const tcpIngress = xeve?.tcp_ingress;
    return tcpIngress && typeof tcpIngress === 'object'
      ? tcpIngress as TcpIngressConfig
      : null;
  }

  private parseServicePorts(ports?: Array<string | number>): number[] {
    if (!Array.isArray(ports)) return [];
    const parsed: number[] = [];
    for (const entry of ports) {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        parsed.push(entry);
        continue;
      }
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(':');
        const candidate = parts[parts.length - 1];
        const port = parseInt(candidate, 10);
        if (Number.isFinite(port)) {
          parsed.push(port);
        }
      }
    }
    return parsed;
  }

  private async resolveServiceEnvEntries(
    service: Service,
    context: {
      envName: string;
      projectId: string;
      orgId: string;
      orgSlug: string;
      projectSlug: string;
      componentName: string;
      secrets?: Map<string, string>;
      managedValues?: Map<string, string>;
    },
    objectStorePlan?: EnvObjectStorePlan,
  ): Promise<Array<{ name: string; value: string }>> {
    const config = loadConfig();

    // Platform-injected env vars (can be overridden by user-defined vars)
    const platformEnvVars: Array<{ name: string; value: string }> = [
      { name: 'EVE_API_URL', value: this.resolveServiceEveApiUrl(config.EVE_API_URL) },
      ...(config.EVE_PUBLIC_API_URL ? [{ name: 'EVE_PUBLIC_API_URL', value: config.EVE_PUBLIC_API_URL }] : []),
      ...(config.EVE_SSO_URL ? [{ name: 'EVE_SSO_URL', value: config.EVE_SSO_URL }] : []),
      { name: 'EVE_PROJECT_ID', value: context.projectId },
      { name: 'EVE_ORG_ID', value: context.orgId },
      { name: 'EVE_ENV_NAME', value: context.envName },
    ];

    // Mint a service token so the deployed app can authenticate to the Eve API.
    // Read-only defaults are always granted; write permissions come from x-eve.permissions in the manifest.
    const manifestPermissions = getServicePermissions(service);
    const mergedPermissions = [...new Set([...DEFAULT_SERVICE_PERMISSIONS, ...manifestPermissions])];
    const tokenResult = await mintServiceToken({
      projectId: context.projectId,
      orgId: context.orgId,
      envName: context.envName,
      serviceName: context.componentName,
      permissions: mergedPermissions,
    });
    if (tokenResult) {
      platformEnvVars.push({ name: 'EVE_SERVICE_TOKEN', value: tokenResult.access_token });
    } else {
      this.logger.warn(
        `Could not mint service token for ${context.componentName} — app won't be able to authenticate to Eve API`,
      );
    }

    const appLinkEnvVars = await this.resolveAppLinkEnvVars(context);
    for (const entry of appLinkEnvVars) {
      platformEnvVars.push(entry);
    }

    // Object store bucket provisioning and env var injection
    const objectStoreEnvVars = await this.resolveObjectStoreBuckets(service, context, objectStorePlan);
    for (const entry of objectStoreEnvVars) {
      platformEnvVars.push(entry);
    }

    // User-defined env vars from manifest
    const userEnvVars = service.environment && typeof service.environment === 'object'
      ? Object.entries(service.environment as Record<string, string>).map(([key, value]) => ({
          name: key,
          value: this.interpolateValue(String(value), context),
        }))
      : [];

    // Merge: platform vars first, then user vars (user can override platform vars)
    const envMap = new Map<string, string>();
    for (const entry of platformEnvVars) {
      envMap.set(entry.name, entry.value);
    }
    for (const entry of userEnvVars) {
      envMap.set(entry.name, entry.value);
    }

    return Array.from(envMap.entries()).map(([name, value]) => ({ name, value }));
  }

  private async resolveAppLinkEnvVars(context: {
    envName: string;
    projectId: string;
    componentName: string;
  }): Promise<Array<{ name: string; value: string }>> {
    const envVars: Array<{ name: string; value: string }> = [];
    if (typeof this.db !== 'function') {
      return envVars;
    }

    const subscriptions = await this.appLinkSubscriptions.listWithGrants({
      consumer_project_id: context.projectId,
    });

    for (const subscription of subscriptions) {
      if (!subscription.inject_into_services.includes(context.componentName)) {
        continue;
      }
      const grant = subscription.api_grant;
      if (!grant || grant.revoked_at || !grant.service_name) {
        this.logger.warn(`Skipping app-link ${subscription.local_alias}: API grant is missing or revoked`);
        continue;
      }

      const producerEnv = subscription.environment_strategy === 'same'
        ? context.envName
        : subscription.producer_env_name;
      if (!producerEnv) {
        this.logger.warn(`Skipping app-link ${subscription.local_alias}: producer environment is not resolved`);
        continue;
      }
      if (grant.envs.length > 0 && !grant.envs.includes(producerEnv)) {
        this.logger.warn(
          `Skipping app-link ${subscription.local_alias}: producer env ${producerEnv} is not allowed by grant`,
        );
        continue;
      }

      const producerProject = await this.projects.findById(grant.producer_project_id, { include_deleted: true });
      if (!producerProject) {
        this.logger.warn(`Skipping app-link ${subscription.local_alias}: producer project ${grant.producer_project_id} not found`);
        continue;
      }
      const producerOrg = await this.orgs.findById(producerProject.org_id, { include_deleted: true });
      if (!producerOrg) {
        this.logger.warn(`Skipping app-link ${subscription.local_alias}: producer org ${producerProject.org_id} not found`);
        continue;
      }

      const port = await this.resolveProducerServicePort(grant.producer_project_id, grant.service_name);
      const namespace = deriveNamespace(producerOrg.slug, producerProject.slug, producerEnv);
      const baseUrl = `http://${producerEnv}-${grant.service_name}.${namespace}.svc.cluster.local${port ? `:${port}` : ''}`;
      const token = await mintAppLinkToken({
        subscriptionId: subscription.id,
        consumerPrincipal: `service:${context.componentName}`,
        consumerEnv: context.envName,
        producerEnv,
        ttlSeconds: 90 * 24 * 60 * 60,
      });

      const prefix = this.appLinkEnvPrefix(subscription.local_alias);
      envVars.push({ name: `${prefix}_API_URL`, value: baseUrl });
      if (token) {
        envVars.push({ name: `${prefix}_TOKEN`, value: token.access_token });
      } else {
        this.logger.warn(`Could not mint app-link token for ${subscription.local_alias}`);
      }
      if (grant.cli_name) {
        envVars.push({ name: `${prefix}_CLI`, value: grant.cli_name });
      }
      envVars.push({ name: `${prefix}_SCOPES`, value: subscription.requested_scopes.join(',') });
      envVars.push({ name: `${prefix}_PROJECT`, value: grant.producer_project_id });
      envVars.push({ name: `${prefix}_ENV`, value: producerEnv });
    }

    return envVars;
  }

  private async resolveProducerServicePort(projectId: string, serviceName: string): Promise<number | null> {
    try {
      const manifestRecord = await this.manifests.findLatestByProject(projectId);
      if (!manifestRecord) return null;
      const parsed = yaml.parse(manifestRecord.manifest_yaml);
      const validated = ManifestSchema.safeParse(parsed);
      if (!validated.success) return null;
      const service = validated.data.services?.[serviceName];
      if (!service) return null;
      return this.parseServicePorts(service.ports)[0] ?? null;
    } catch {
      return null;
    }
  }

  private appLinkEnvPrefix(alias: string): string {
    return `EVE_APP_LINK_${alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  }

  private async prepareObjectStorePlan(params: {
    services: Record<string, Service>;
    envWorkers: Array<Record<string, unknown>>;
    scope: AppObjectStoreScope;
  }): Promise<EnvObjectStorePlan> {
    const desired = this.collectObjectStoreBuckets(params.services, params.envWorkers, params.scope);
    const bucketsByService = new Map<string, ObjectStoreDesiredBucket[]>();
    for (const entry of desired) {
      const current = bucketsByService.get(entry.serviceName) ?? [];
      current.push(entry);
      bucketsByService.set(entry.serviceName, current);
    }

    if (desired.length === 0) {
      if (typeof this.db === 'function') {
        await this.removeObjectStoreBinding(params.scope);
        await this.storageBuckets.deleteByEnv(params.scope.projectId, params.scope.envName);
      }
      return { scope: params.scope, binding: null, bucketsByService };
    }

    if (!this.bucketProvisioner.isConfigured) {
      const services = [...new Set(desired.map((entry) => entry.serviceName))].join(', ');
      throw new Error(
        `Services declaring x-eve.object_store.buckets (${services}) cannot deploy because Eve object storage is not configured. ` +
        `Set EVE_STORAGE_BACKEND and storage connection env vars on the worker, or remove the bucket declarations.`,
      );
    }

    const requestedMode = this.resolveRequestedObjectStoreIsolation(desired, params.scope.envName);
    const provisioner = this.selectObjectStoreCredentialProvisioner(requestedMode, desired);
    const physicalBucketNames = [...new Set(desired.map((entry) => entry.physicalName))].sort();
    const binding = await provisioner.ensureForEnv(params.scope, physicalBucketNames);

    for (const entry of desired) {
      await this.provisionObjectStoreBucket(entry, params.scope, binding);
    }

    await this.storageBuckets.deleteMissingForEnv(
      params.scope.projectId,
      params.scope.envName,
      desired.map((entry) => ({ service_name: entry.serviceName, name: entry.bucket.name })),
    );

    return { scope: params.scope, binding, bucketsByService };
  }

  private collectObjectStoreBuckets(
    services: Record<string, Service>,
    envWorkers: Array<Record<string, unknown>>,
    scope: AppObjectStoreScope,
  ): ObjectStoreDesiredBucket[] {
    const desired: ObjectStoreDesiredBucket[] = [];
    for (const [serviceName, service] of Object.entries(services)) {
      if (!this.shouldReconcileObjectStoreService(serviceName, service, envWorkers)) {
        continue;
      }

      const buckets = getServiceObjectStoreBuckets(service);
      if (buckets.length === 0) {
        continue;
      }

      const requestedIsolation = getServiceObjectStoreIsolation(service);
      for (const bucket of buckets) {
        const physicalName = this.bucketProvisioner.getAppBucketName(
          scope.orgSlug,
          scope.projectSlug,
          scope.envName,
          bucket.name,
        );
        desired.push({
          serviceName,
          bucket,
          physicalName,
          envKey: `STORAGE_BUCKET_${bucket.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
          requestedIsolation,
        });
      }
    }
    return desired;
  }

  private shouldReconcileObjectStoreService(
    serviceName: string,
    service: Service,
    envWorkers: Array<Record<string, unknown>>,
  ): boolean {
    const xeve = this.resolveXeve(service);
    if (xeve?.external || xeve?.connection_url || xeve?.role === 'managed_db') {
      return false;
    }
    if (xeve?.role !== 'worker') {
      return true;
    }
    return envWorkers.some((worker) => worker.service === serviceName || worker.name === serviceName);
  }

  private resolveRequestedObjectStoreIsolation(
    desired: ObjectStoreDesiredBucket[],
    envName: string,
  ): ObjectStoreIsolation {
    const explicit = new Map<ObjectStoreIsolation, Set<string>>();
    for (const entry of desired) {
      if (entry.requestedIsolation === 'auto') {
        continue;
      }
      const services = explicit.get(entry.requestedIsolation) ?? new Set<string>();
      services.add(entry.serviceName);
      explicit.set(entry.requestedIsolation, services);
    }

    if (explicit.size > 1) {
      const parts = [...explicit.entries()]
        .map(([mode, services]) => `${mode}: ${[...services].sort().join(', ')}`)
        .join('; ');
      throw new Error(
        `Conflicting x-eve.object_store.isolation values in env "${envName}": ${parts}. ` +
        'One environment can only use one object-store credential binding.',
      );
    }

    return explicit.keys().next().value ?? 'auto';
  }

  private selectObjectStoreCredentialProvisioner(
    requestedMode: ObjectStoreIsolation,
    desired: ObjectStoreDesiredBucket[],
  ): AppCredentialProvisioner {
    if (requestedMode === 'irsa') {
      return this.requireObjectStoreProvisioner('irsa', requestedMode, desired);
    }

    if (requestedMode === 'shared') {
      const staticMode: AppObjectStoreCredentialMode =
        this.bucketProvisioner.backend === 'minio' ? 'minio-static-key' : 'shared';
      return this.requireObjectStoreProvisioner(staticMode, requestedMode, desired);
    }

    for (const mode of ['irsa', 'minio-static-key', 'shared'] satisfies AppObjectStoreCredentialMode[]) {
      const provisioner = this.appCredentialProvisioners.find((candidate) => candidate.mode === mode);
      const availability = provisioner?.availability() ?? { available: false, reason: 'provisioner is not registered' };
      if (availability.available && provisioner) {
        return provisioner;
      }
    }

    throw new Error(
      'No object-store credential isolation mode is available on this cluster. ' +
      'Configure IRSA or static app storage credentials before deploying services with x-eve.object_store.buckets.',
    );
  }

  private requireObjectStoreProvisioner(
    mode: AppObjectStoreCredentialMode,
    requestedMode: ObjectStoreIsolation,
    desired: ObjectStoreDesiredBucket[],
  ): AppCredentialProvisioner {
    const provisioner = this.appCredentialProvisioners.find((candidate) => candidate.mode === mode);
    const availability = provisioner?.availability() ?? { available: false, reason: 'provisioner is not registered' };
    if (provisioner && availability.available) {
      return provisioner;
    }

    const services = [...new Set(
      desired
        .filter((entry) => entry.requestedIsolation === requestedMode)
        .map((entry) => entry.serviceName),
    )].sort();
    const servicePrefix = services.length === 1
      ? `Service "${services[0]}" declares object_store.isolation='${requestedMode}' but `
      : services.length > 1
        ? `Services ${services.map((service) => `"${service}"`).join(', ')} declare object_store.isolation='${requestedMode}' but `
        : '';

    throw new Error(
      `${servicePrefix}isolation mode '${requestedMode}' is not available on this cluster: ${availability.reason ?? 'unknown reason'}`,
    );
  }

  private async provisionObjectStoreBucket(
    entry: ObjectStoreDesiredBucket,
    scope: AppObjectStoreScope,
    binding: AppObjectStoreBinding,
  ): Promise<void> {
    try {
      await this.bucketProvisioner.ensureBucket(entry.physicalName);

      const visibility = entry.bucket.visibility ?? 'private';
      if (visibility === 'public') {
        await this.bucketProvisioner.setBucketPublicReadPolicy(entry.physicalName);
      }

      if (entry.bucket.cors && this.bucketProvisioner.backend === 'minio') {
        if (this.shouldWarnForMinioCorsFallback(entry.bucket.cors)) {
          this.logger.warn(
            `Object-store bucket ${entry.physicalName} declares restrictive CORS, but the MinIO backend only supports server-wide CORS in local k3d. ` +
            `Continuing with the bucket provisioned; local browser CORS uses MINIO_API_CORS_ALLOW_ORIGIN.`,
          );
        } else {
          this.logger.log(
            `Object-store bucket ${entry.physicalName} uses MinIO server-wide CORS configuration`,
          );
        }
      } else if (entry.bucket.cors) {
        await this.bucketProvisioner.setBucketCors(entry.physicalName, [{
          origins: entry.bucket.cors.origins ?? ['*'],
          methods: entry.bucket.cors.methods ?? ['GET', 'HEAD', 'PUT'],
          maxAgeSeconds: entry.bucket.cors.max_age_seconds,
        }]);
      }

      await this.storageBuckets.upsert({
        id: generateStorageBucketId(),
        org_id: scope.orgId,
        project_id: scope.projectId,
        env_name: scope.envName,
        service_name: entry.serviceName,
        name: entry.bucket.name,
        physical_name: entry.physicalName,
        visibility,
        cors_json: entry.bucket.cors ?? {},
        isolation_mode: binding.mode,
        iam_role_arn: binding.iamRoleArn ?? null,
        iam_role_name: binding.iamRoleName ?? null,
        service_account_name: binding.serviceAccount?.name ?? null,
        service_account_namespace: binding.serviceAccount?.namespace ?? null,
      });

      this.logger.log(
        `Provisioned bucket ${entry.physicalName} (visibility=${visibility}, isolation=${binding.mode})`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to provision object_store bucket "${entry.bucket.name}" for service "${entry.serviceName}": ${message}`,
      );
    }
  }

  private async resolveObjectStoreBuckets(
    service: Service,
    context: {
      envName: string;
      componentName: string;
    },
    objectStorePlan?: EnvObjectStorePlan,
  ): Promise<Array<{ name: string; value: string }>> {
    const buckets = getServiceObjectStoreBuckets(service);
    if (buckets.length === 0) {
      return [];
    }
    if (!objectStorePlan) {
      throw new Error(
        `Service "${context.componentName}" declares x-eve.object_store.buckets but the env-wide object-store plan was not prepared.`,
      );
    }
    if (!objectStorePlan.binding) {
      throw new Error(
        `Service "${context.componentName}" declares x-eve.object_store.buckets but no object-store credential binding was resolved.`,
      );
    }

    const desired = objectStorePlan.bucketsByService.get(context.componentName) ?? [];
    return [
      ...objectStorePlan.binding.envVars,
      ...desired.map((entry) => ({ name: entry.envKey, value: entry.physicalName })),
    ];
  }

  private buildObjectStoreServiceAccount(objectStorePlan: EnvObjectStorePlan): Record<string, unknown> | null {
    const serviceAccount = objectStorePlan.binding?.serviceAccount;
    if (!serviceAccount || objectStorePlan.binding?.mode !== 'irsa') {
      return null;
    }
    return {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: {
        name: serviceAccount.name,
        namespace: serviceAccount.namespace,
        annotations: serviceAccount.annotations,
      },
    };
  }

  private resolveObjectStoreServiceAccountName(
    objectStorePlan: EnvObjectStorePlan,
    serviceName: string,
  ): string | undefined {
    if (objectStorePlan.binding?.mode !== 'irsa') {
      return undefined;
    }
    if (!objectStorePlan.bucketsByService.has(serviceName)) {
      return undefined;
    }
    return objectStorePlan.binding.serviceAccount?.name;
  }

  private buildPodAnnotations(params: {
    managedDbTrustHash?: string;
    objectStorePlan: EnvObjectStorePlan;
    serviceName: string;
  }): Record<string, string> | undefined {
    const annotations: Record<string, string> = {};
    if (params.managedDbTrustHash) {
      annotations['eve.managed_db_trust_hash'] = params.managedDbTrustHash;
    }
    if (
      params.objectStorePlan.binding?.mode === 'irsa' &&
      params.objectStorePlan.binding.bindingHash &&
      params.objectStorePlan.bucketsByService.has(params.serviceName)
    ) {
      annotations['eve.app_bucket_binding_hash'] = params.objectStorePlan.binding.bindingHash;
    }
    return Object.keys(annotations).length > 0 ? annotations : undefined;
  }

  private async removeObjectStoreBinding(scope: AppObjectStoreScope): Promise<void> {
    for (const provisioner of this.appCredentialProvisioners) {
      if (!provisioner.availability().available) {
        continue;
      }
      try {
        await provisioner.removeForEnv(scope);
      } catch (error) {
        this.logger.warn(
          `Failed to remove ${provisioner.mode} object-store binding for ${scope.projectSlug}/${scope.envName}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private shouldWarnForMinioCorsFallback(cors: { origins?: string[] }): boolean {
    const origins = cors.origins ?? ['*'];
    return !origins.includes('*');
  }

  private resolveServiceEveApiUrl(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname;
      const isIpHost = /^[0-9.]+$/.test(host) || host.includes(':');
      if (host.includes('.') || host === 'localhost' || isIpHost) {
        return rawUrl;
      }
      parsed.hostname = `${host}.eve.svc.cluster.local`;
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return rawUrl;
    }
  }

  private resolveServiceCommand(
    service: Service,
  ): { command: string[] | null; args: string[] | null } {
    const record = service as Record<string, unknown>;
    const entrypoint = this.normalizeStringArray(record.entrypoint);
    const commandValue = record.command;

    if (Array.isArray(commandValue)) {
      const args = this.normalizeStringArray(commandValue);
      return { command: entrypoint, args };
    }

    if (typeof commandValue === 'string' && commandValue.trim().length > 0) {
      return { command: entrypoint ?? ['/bin/sh', '-c'], args: [commandValue] };
    }

    return { command: entrypoint, args: null };
  }

  private normalizeStringArray(value: unknown): string[] | null {
    if (Array.isArray(value)) {
      const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
      return entries.length > 0 ? entries : null;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return [value];
    }
    return null;
  }

  private resolveServiceVolumes(
    service: Service,
    serviceName: string,
  ): { volumes: k8s.V1Volume[]; volumeMounts: k8s.V1VolumeMount[] } {
    const record = service as Record<string, unknown>;
    const volumeEntries = record.volumes;

    const volumes: k8s.V1Volume[] = [];
    const volumeMounts: k8s.V1VolumeMount[] = [];
    const mountPaths = new Set<string>();

    const storage = this.resolvePersistentStorage(service, serviceName);
    if (storage) {
      volumes.push({
        name: storage.volumeName,
        persistentVolumeClaim: { claimName: storage.pvcName },
      });
      volumeMounts.push({
        name: storage.volumeName,
        mountPath: storage.mountPath,
      });
      mountPaths.add(storage.mountPath);
    }

    if (!Array.isArray(volumeEntries)) {
      return { volumes, volumeMounts };
    }

    volumeEntries.forEach((entry, index) => {
      if (typeof entry !== 'string') return;
      const trimmed = entry.trim();
      if (!trimmed) return;

      const parts = trimmed.split(':');
      const source = parts.length >= 2 ? parts[0] : '';
      const target = parts.length >= 2 ? parts[1] : parts[0];
      const mode = parts.length >= 3 ? parts[2] : '';

      if (!target || !target.startsWith('/')) {
        this.logger.warn(`Ignoring volume ${trimmed} for ${serviceName}: invalid mount path`);
        return;
      }

      if (mountPaths.has(target)) {
        this.logger.warn(
          `Ignoring volume ${trimmed} for ${serviceName}: mount path already used by storage`
        );
        return;
      }

      if (source) {
        this.logger.warn(
          `Volume source '${source}' for ${serviceName} is not yet supported; using emptyDir`
        );
      }

      const volumeName = toK8sName(`${serviceName}-vol-${index + 1}`, 'volume');
      volumes.push({ name: volumeName, emptyDir: {} });
      volumeMounts.push({
        name: volumeName,
        mountPath: target,
        readOnly: mode === 'ro',
      });
      mountPaths.add(target);
    });

    return { volumes, volumeMounts };
  }

  private resolveServiceResources(service: Service): k8s.V1ResourceRequirements {
    const record = service as Record<string, unknown>;
    const xeve = this.resolveXeve(service) as Record<string, unknown> | null;
    const raw = asRecord(record.resources) ?? asRecord(xeve?.resources);
    const explicitRequests = readResourceList(raw?.requests);

    const requests = {
      ...explicitRequests,
      cpu: explicitRequests.cpu ?? process.env.EVE_DEPLOYER_DEFAULT_CPU_REQUEST ?? DEFAULT_APP_CPU_REQUEST,
      memory: explicitRequests.memory ?? process.env.EVE_DEPLOYER_DEFAULT_MEMORY_REQUEST ?? DEFAULT_APP_MEMORY_REQUEST,
    };
    const limits = readResourceList(raw?.limits);

    return {
      requests,
      limits: Object.keys(limits).length > 0 ? limits : undefined,
    };
  }

  private resolvePersistentStorage(service: Service, serviceName: string): ServiceStorageConfig | null {
    const xeve = this.resolveXeve(service) ?? {};
    const storage = (xeve as Record<string, unknown>).storage;

    const role = typeof xeve.role === 'string' ? xeve.role : null;
    const hasStorageConfig = storage && typeof storage === 'object';
    const storageRecord = (hasStorageConfig ? storage : null) as Record<string, unknown> | null;

    let mountPath = storageRecord
      ? (storageRecord.mount_path ?? storageRecord.mountPath)
      : undefined;

    if (!mountPath && role === 'database') {
      mountPath = '/var/lib/postgresql/data';
    }

    if (typeof mountPath !== 'string' || mountPath.trim().length === 0) {
      if (hasStorageConfig) {
        this.logger.warn(`Ignoring storage for ${serviceName}: missing mount_path`);
      }
      return null;
    }

    if (!mountPath.startsWith('/')) {
      this.logger.warn(`Ignoring storage for ${serviceName}: mount_path must be absolute`);
      return null;
    }

    const size = typeof storageRecord?.size === 'string' && storageRecord.size.trim().length > 0
      ? storageRecord.size.trim()
      : '5Gi';

    const rawAccessMode = storageRecord?.access_mode ?? storageRecord?.accessMode;
    const accessMode = rawAccessMode === 'ReadWriteMany' || rawAccessMode === 'ReadOnlyMany'
      ? rawAccessMode
      : 'ReadWriteOnce';

    const storageClassName = typeof storageRecord?.storage_class === 'string'
      ? storageRecord.storage_class
      : typeof storageRecord?.storageClass === 'string'
        ? storageRecord.storageClass
        : undefined;

    const nameOverride = typeof storageRecord?.name === 'string' && storageRecord.name.trim().length > 0
      ? storageRecord.name.trim()
      : `${serviceName}-data`;

    const volumeBase = toK8sName(nameOverride, 'volume');
    const pvcName = toK8sName(`${nameOverride}-pvc`, 'pvc');

    return {
      mountPath,
      size,
      accessMode: accessMode as ServiceStorageConfig['accessMode'],
      storageClassName,
      pvcName,
      volumeName: volumeBase,
    };
  }

  private buildPersistentVolumeClaim(
    storage: ServiceStorageConfig,
    labels: Record<string, string>,
  ): k8s.V1PersistentVolumeClaim {
    return {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: storage.pvcName,
        labels,
      },
      spec: {
        accessModes: [storage.accessMode],
        resources: {
          requests: {
            storage: storage.size,
          },
        },
        storageClassName: storage.storageClassName || undefined,
      },
    };
  }

  private resolveServiceWorkingDir(service: Service): string | null {
    const record = service as Record<string, unknown>;
    const value = record.working_dir ?? record.workingDir;
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }

  /**
   * Read files from a source path for mounting as a ConfigMap.
   * Supports both single files and directories.
   * Returns a map of filename -> content for ConfigMap data.
   */
  private async readFilesForConfigMap(sourcePath: string): Promise<Record<string, string>> {
    const data: Record<string, string> = {};

    try {
      const stat = await fs.stat(sourcePath);

      if (stat.isDirectory()) {
        const files = await fs.readdir(sourcePath);
        for (const file of files) {
          const filePath = join(sourcePath, file);
          const fileStat = await fs.stat(filePath);
          if (fileStat.isFile()) {
            const content = await fs.readFile(filePath, 'utf-8');
            data[file] = content;
          }
          // Skip subdirectories - ConfigMaps are flat
        }
      } else if (stat.isFile()) {
        // Single file - use basename as key
        const basename = sourcePath.split('/').pop() ?? 'file';
        const content = await fs.readFile(sourcePath, 'utf-8');
        data[basename] = content;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read files from ${sourcePath}: ${message}`);
    }

    // Check ConfigMap size limit (1MB)
    const totalSize = Object.values(data).reduce((sum, content) => sum + content.length, 0);
    if (totalSize > 1024 * 1024) {
      throw new Error(
        `Files at ${sourcePath} exceed ConfigMap size limit (1MB). ` +
        `Total size: ${Math.round(totalSize / 1024)}KB. ` +
        `Consider baking files into the image instead.`
      );
    }

    return data;
  }

  /**
   * Resolve x-eve.files entries and create ConfigMaps for them.
   * Returns additional volumes and volume mounts to add to the container spec.
   */
  private async resolveXeveFiles(
    xeve: Record<string, unknown> | null,
    repoPath: string | null | undefined,
    namespace: string,
    resourcePrefix: string,
  ): Promise<{ volumes: k8s.V1Volume[]; volumeMounts: k8s.V1VolumeMount[]; configMapNames: string[] }> {
    const volumes: k8s.V1Volume[] = [];
    const volumeMounts: k8s.V1VolumeMount[] = [];
    const configMapNames: string[] = [];

    const filesConfig = xeve?.files as Array<{ source: string; target: string }> | undefined;
    if (!filesConfig || filesConfig.length === 0) {
      return { volumes, volumeMounts, configMapNames };
    }

    if (!repoPath) {
      this.logger.warn('x-eve.files specified but no repo path available - skipping file mounts');
      return { volumes, volumeMounts, configMapNames };
    }

    for (const [index, fileEntry] of filesConfig.entries()) {
      const { source, target } = fileEntry;

      if (!source || !target) {
        this.logger.warn(`Invalid x-eve.files entry at index ${index}: missing source or target`);
        continue;
      }

      if (!target.startsWith('/')) {
        this.logger.warn(`Invalid x-eve.files target "${target}": must be an absolute path`);
        continue;
      }

      const sourcePath = join(repoPath, source);
      const configMapName = toK8sName(`${resourcePrefix}-files-${index}`, 'configmap');

      try {
        const data = await this.readFilesForConfigMap(sourcePath);

        if (Object.keys(data).length === 0) {
          this.logger.warn(`No files found at ${sourcePath} - skipping ConfigMap creation`);
          continue;
        }

        await this.k8sService.createConfigMap(namespace, configMapName, data);
        configMapNames.push(configMapName);

        volumes.push({
          name: configMapName,
          configMap: { name: configMapName },
        });

        volumeMounts.push({
          name: configMapName,
          mountPath: target,
          readOnly: true,
        });

        this.logger.log(`Created ConfigMap ${configMapName} with ${Object.keys(data).length} files from ${source}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create ConfigMap for x-eve.files entry (${source} -> ${target}): ${message}`);
      }
    }

    return { volumes, volumeMounts, configMapNames };
  }

  private async waitForServiceDependencies(params: {
    namespace: string;
    envName: string;
    services: Record<string, Service>;
    timeoutMs: number;
  }): Promise<void> {
    const { namespace, envName, services, timeoutMs } = params;
    if (!services || Object.keys(services).length === 0) return;

    const envSlug = toK8sName(envName, 'environment');
    const healthyDeps = new Set<string>();

    for (const [, service] of Object.entries(services)) {
      const deps = service.depends_on as Record<string, { condition?: string }> | undefined;
      if (!deps) continue;
      for (const [depName, depConfig] of Object.entries(deps)) {
        const condition = typeof depConfig?.condition === 'string' ? depConfig.condition : 'service_started';
        if (['service_healthy', 'healthy'].includes(condition) && services[depName]) {
          healthyDeps.add(depName);
        }
      }
    }

    const sortedServices = this.topologicalSort(services as Record<string, any>);
    for (const { name } of sortedServices) {
      if (healthyDeps.has(name)) {
        const componentSlug = toK8sName(name, 'component');
        const resourceName = combineK8sName(envSlug, componentSlug, 'resource');
        this.logger.log(`Waiting for ${name} to become healthy (required by dependents)`);
        await this.waitForComponentHealth(namespace, resourceName, timeoutMs);
      }
    }
  }

  private async waitForJobDependencies(params: {
    namespace: string;
    envName: string;
    services: Record<string, Service>;
    serviceName: string;
    timeoutMs: number;
  }): Promise<void> {
    const { namespace, envName, services, serviceName, timeoutMs } = params;
    const service = services[serviceName];
    if (!service) return;

    const deps = service.depends_on as Record<string, { condition?: string }> | undefined;
    if (!deps) return;

    const envSlug = toK8sName(envName, 'environment');
    for (const [depName, depConfig] of Object.entries(deps)) {
      if (!services[depName]) continue;
      const condition = typeof depConfig?.condition === 'string' ? depConfig.condition : 'service_started';
      if (['service_started', 'started', 'service_healthy', 'healthy'].includes(condition)) {
        const componentSlug = toK8sName(depName, 'component');
        const resourceName = combineK8sName(envSlug, componentSlug, 'resource');
        this.logger.log(`Waiting for dependency ${depName} before running job ${serviceName}`);
        await this.waitForComponentHealth(namespace, resourceName, timeoutMs);
      }
    }
  }

  private async ensureImagePullSecret(params: {
    namespace: string;
    projectId: string;
    manifestYaml: string;
  }): Promise<string | null> {
    const parsed = yaml.parse(params.manifestYaml) as {
      registry?:
        | string
        | {
            host?: string;
            auth?: { username_secret?: string; token_secret?: string };
          };
    } | null;

    const registryValue = parsed?.registry;

    // --- Eve-native registry: use EVE_INTERNAL_API_KEY for Docker v2 token auth ---
    if (registryValue === 'eve') {
      const config = loadConfig();
      const registryHost = config.EVE_REGISTRY_HOST;
      if (!registryHost) {
        this.logger.warn('Eve registry requested but EVE_REGISTRY_HOST not configured');
        return null;
      }
      if (!config.EVE_INTERNAL_API_KEY) {
        this.logger.warn('Eve registry requested but EVE_INTERNAL_API_KEY not configured');
        return null;
      }

      // Store the API key as the docker password — NOT a pre-signed JWT.
      // When kubelet gets a 401 from the registry, it follows the Docker v2
      // token auth flow: GET the token endpoint with Basic auth (these creds).
      // The token endpoint validates the API key and issues a fresh JWT.
      const username = 'eve-token';
      const password = config.EVE_INTERNAL_API_KEY;
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      const dockerConfig = {
        auths: {
          [registryHost]: { username, password, auth },
        },
      };
      const dockerConfigJson = Buffer.from(JSON.stringify(dockerConfig)).toString('base64');
      const secretManifest = yaml.stringify({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: this.registrySecretName,
          namespace: params.namespace,
        },
        type: 'kubernetes.io/dockerconfigjson',
        data: {
          '.dockerconfigjson': dockerConfigJson,
        },
      });

      await this.k8sService.applyManifest(params.namespace, secretManifest);
      return this.registrySecretName;
    }

    // --- No registry / no pull secret needed ---
    if (registryValue === 'none') {
      return null;
    }

    // --- BYO registry (object with host + optional auth) ---
    const registry = typeof registryValue === 'object' ? registryValue : undefined;
    const host = registry?.host;
    if (!host) {
      return null;
    }

    const secretResult = await resolveProjectSecrets(params.projectId);
    if (!secretResult.resolved) {
      this.logger.warn(`Cannot resolve secrets for registry auth: ${secretResult.error}`);
    }

    const usernameKey = registry?.auth?.username_secret ?? 'GHCR_USERNAME';
    const tokenKey = registry?.auth?.token_secret ?? 'GITHUB_TOKEN';

    const username = secretResult.secrets.find((secret) => secret.key === usernameKey)?.value;
    const token =
      secretResult.secrets.find((secret) => secret.key === tokenKey)?.value ??
      secretResult.secrets.find((secret) => secret.key === 'GH_TOKEN')?.value;

    if (!username || !token) {
      this.logger.warn(
        `Registry auth missing for ${host}. Expected secrets: ${usernameKey} and ${tokenKey}`
      );
      return null;
    }

    const auth = Buffer.from(`${username}:${token}`).toString('base64');
    const dockerConfig = {
      auths: {
        [host]: {
          username,
          password: token,
          auth,
        },
      },
    };

    const dockerConfigJson = Buffer.from(JSON.stringify(dockerConfig)).toString('base64');
    const secretManifest = yaml.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.registrySecretName,
        namespace: params.namespace,
      },
      type: 'kubernetes.io/dockerconfigjson',
      data: {
        '.dockerconfigjson': dockerConfigJson,
      },
    });

    await this.k8sService.applyManifest(params.namespace, secretManifest);
    return this.registrySecretName;
  }


  /**
   * Load secrets from local .eve/dev-secrets.yaml file in the repository.
   * Falls back to .eve/secrets.yaml for backward compatibility.
   * Supports both flat structure and per-environment structure:
   * - Flat: secrets: { KEY: value }
   * - Per-env: secrets: { test: { KEY: value }, staging: { KEY: value } }
   *
   * @param repoPath - Path to the repository root
   * @param envName - Environment name to load secrets for
   * @returns Map of secret key-value pairs
   */
  private async loadLocalSecrets(repoPath: string, envName: string): Promise<Map<string, string>> {
    const secretsMap = new Map<string, string>();
    const secretsPath = join(repoPath, '.eve', 'dev-secrets.yaml');
    const legacySecretsPath = join(repoPath, '.eve', 'secrets.yaml');

    try {
      let fileContent: string | null = null;
      let usedPath: string | null = null;
      try {
        fileContent = await fs.readFile(secretsPath, 'utf-8');
        usedPath = secretsPath;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          try {
            fileContent = await fs.readFile(legacySecretsPath, 'utf-8');
            usedPath = legacySecretsPath;
            this.logger.warn(
              'Using deprecated .eve/secrets.yaml; rename to .eve/dev-secrets.yaml for local overrides.',
            );
          } catch (legacyError) {
            if (legacyError instanceof Error && 'code' in legacyError && legacyError.code === 'ENOENT') {
              return secretsMap;
            }
            throw legacyError;
          }
        } else {
          throw error;
        }
      }

      if (!fileContent) {
        return secretsMap;
      }
      const parsed = yaml.parse(fileContent);

      if (!parsed || typeof parsed !== 'object' || !parsed.secrets) {
        return secretsMap;
      }

      const secrets = parsed.secrets;

      // Helper to load secrets from an object
      const loadSecrets = (obj: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(obj)) {
          if (typeof value === 'string') {
            secretsMap.set(key, value);
          }
        }
      };

      // Check if it's a per-environment structure (has nested objects for envs)
      const hasEnvStructure = typeof secrets === 'object' &&
        (secrets['default'] || secrets[envName]) &&
        (typeof secrets['default'] === 'object' || typeof secrets[envName] === 'object');

      if (hasEnvStructure) {
        // Per-environment structure: secrets: { default: { KEY: value }, test: { KEY: value } }
        // First load defaults, then overlay env-specific
        if (secrets['default'] && typeof secrets['default'] === 'object') {
          loadSecrets(secrets['default'] as Record<string, unknown>);
        }
        if (secrets[envName] && typeof secrets[envName] === 'object') {
          loadSecrets(secrets[envName] as Record<string, unknown>);
        }
      } else if (typeof secrets === 'object') {
        // Flat structure: secrets: { KEY: value }
        // Only include keys that look like secret keys (uppercase with underscores)
        for (const [key, value] of Object.entries(secrets)) {
          if (typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key)) {
            secretsMap.set(key, value);
          }
        }
      }

      if (secretsMap.size > 0) {
        this.logger.log(
          `Loaded ${secretsMap.size} local secrets for environment ${envName}` +
            (usedPath ? ` from ${usedPath}` : ''),
        );
      }
    } catch (error) {
      // File not found or parse error - this is expected for repos without local secrets
      if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
        this.logger.debug(`Could not load local secrets: ${error.message}`);
      }
    }

    return secretsMap;
  }

  /**
   * Extract local file path from a file:// URL.
   * Returns undefined for non-file URLs (git://, https://, etc.)
   */
  private extractLocalRepoPath(repoUrl: string | null | undefined): string | undefined {
    if (!repoUrl) {
      return undefined;
    }

    if (repoUrl.startsWith('file://')) {
      return repoUrl.slice(7); // Remove 'file://' prefix
    }

    // For absolute paths without protocol (e.g., /path/to/repo)
    if (repoUrl.startsWith('/')) {
      return repoUrl;
    }

    return undefined;
  }


  /**
   * Interpolate manifest variables in a string value.
   * Supported variables:
   * - ${ENV_NAME} - environment name (e.g., "test", "staging")
   * - ${PROJECT_ID} - project ID
   * - ${ORG_ID} - organization ID
   * - ${ORG_SLUG} - organization slug
   * - ${COMPONENT_NAME} - current component name
   * - ${secret.KEY_NAME} - secret value from secrets map
   */
  private interpolateValue(
    value: string,
    context: {
      envName: string;
      projectId: string;
      orgId: string;
      orgSlug: string;
      componentName: string;
      secrets?: Map<string, string>;
      managedValues?: Map<string, string>;
    }
  ): string {
    let result = value
      .replace(/\$\{ENV_NAME\}/g, context.envName)
      .replace(/\$\{PROJECT_ID\}/g, context.projectId)
      .replace(/\$\{ORG_ID\}/g, context.orgId)
      .replace(/\$\{ORG_SLUG\}/g, context.orgSlug)
      .replace(/\$\{COMPONENT_NAME\}/g, context.componentName);

    // Interpolate ${SSO_URL} from platform config
    const ssoUrl = loadConfig().EVE_SSO_URL;
    if (ssoUrl) {
      result = result.replace(/\$\{SSO_URL\}/g, ssoUrl);
    }

    // Handle ${secret.KEY_NAME} patterns
    if (context.secrets) {
      result = result.replace(/\$\{secret\.([A-Z0-9_]+)\}/g, (match, keyName) => {
        const secretValue = context.secrets?.get(keyName);
        if (secretValue === undefined) {
          this.logger.warn(`Secret ${keyName} not found in secrets map`);
          return match; // Leave original placeholder if secret not found
        }
        return secretValue;
      });
    }

    // Handle ${managed.<service>.<field>} patterns (e.g., ${managed.db.url})
    if (context.managedValues) {
      result = result.replace(/\$\{managed\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_]+)\}/g, (match, service, field) => {
        const key = `${service}.${field}`;
        const value = context.managedValues?.get(key);
        if (value === undefined) {
          this.logger.warn(`Managed value ${key} not found`);
          return match;
        }
        return value;
      });
    }

    return result;
  }

  /**
   * Resolve the registry host from the manifest's registry config.
   * Returns null if no registry prefix should be applied.
   */
  private resolveRegistryHost(manifest: Manifest): string | null {
    if (isEveRegistry(manifest)) {
      return loadConfig().EVE_REGISTRY_HOST ?? null;
    }
    const registryConfig = getRegistryConfig(manifest);
    if (registryConfig?.host) {
      return registryConfig.host;
    }
    return null;
  }

  /**
   * Prefix a bare image name with the registry host.
   * A "bare" image has no registry qualifier in its first path segment
   * (no `.`, `:`, and isn't `localhost`).
   */
  private prefixRegistryHost(image: string, registryHost: string | null): string {
    if (!registryHost || !image) {
      return image;
    }
    const firstSlash = image.indexOf('/');
    const firstSegment = firstSlash > 0 ? image.slice(0, firstSlash) : image;
    const hasRegistry =
      firstSegment.includes('.') ||
      firstSegment.includes(':') ||
      firstSegment === 'localhost';
    if (hasRegistry) {
      return image;
    }
    return `${registryHost}/${image}`;
  }

  private resolveImageRef(baseImage: unknown, digest?: string, imageTag?: string): string {
    if (typeof baseImage !== 'string' || baseImage.length === 0) {
      if (!digest) {
        throw new Error('Component image missing');
      }
      return digest;
    }

    // If we have a digest, use it (pinned to specific image)
    if (digest && digest.length > 0) {
      if (digest.includes('/') || digest.includes('@')) {
        return digest;
      }
      const normalizedDigest = digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
      return `${baseImage}@${normalizedDigest}`;
    }

    // If baseImage already has a tag (contains ':' after the last '/'), use as-is
    const lastSlash = baseImage.lastIndexOf('/');
    const afterSlash = lastSlash >= 0 ? baseImage.slice(lastSlash + 1) : baseImage;
    if (afterSlash.includes(':')) {
      return baseImage;
    }

    // Apply imageTag if provided, otherwise default to 'latest'
    const tag = imageTag || 'latest';
    return `${baseImage}:${tag}`;
  }

  private resolveServiceDigest(
    serviceName: string,
    service: Service,
    allServices: Record<string, Service>,
    imageDigests?: Record<string, string>,
  ): string | undefined {
    if (!imageDigests || Object.keys(imageDigests).length === 0) {
      return undefined;
    }

    const directDigest = imageDigests[serviceName];
    if (typeof directDigest === 'string' && directDigest.length > 0) {
      return directDigest;
    }

    if (!service || typeof service.image !== 'string' || service.image.length === 0) {
      return undefined;
    }

    const targetRepo = this.normalizeImageRepository(service.image);
    for (const [candidateName, digest] of Object.entries(imageDigests)) {
      if (!digest || candidateName === serviceName) {
        continue;
      }
      const candidateService = allServices[candidateName];
      if (!candidateService || typeof candidateService.image !== 'string' || candidateService.image.length === 0) {
        continue;
      }
      if (this.normalizeImageRepository(candidateService.image) === targetRepo) {
        return digest;
      }
    }

    return undefined;
  }

  private normalizeImageRepository(image: string): string {
    const withoutDigest = image.split('@')[0];
    const lastSlash = withoutDigest.lastIndexOf('/');
    const lastColon = withoutDigest.lastIndexOf(':');
    if (lastColon > lastSlash) {
      return withoutDigest.slice(0, lastColon);
    }
    return withoutDigest;
  }

  private async normalizeImageForKubelet(image: string): Promise<string> {
    const firstSlash = image.indexOf('/');
    if (firstSlash <= 0) {
      return image;
    }

    const registry = image.slice(0, firstSlash);
    const repository = image.slice(firstSlash + 1);
    if (!repository) {
      return image;
    }

    const hostPortMatch = registry.match(/^([^:]+)(?::(\d+))?$/);
    if (!hostPortMatch) {
      return image;
    }
    const host = hostPortMatch[1];
    const port = hostPortMatch[2];

    const svcMatch = host.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.svc(?:\.cluster\.local)?$/i);
    if (!svcMatch) {
      return image;
    }

    const serviceName = svcMatch[1];
    const namespace = svcMatch[2];

    // Keep eve-registry service hostnames intact so kubelet uses the
    // configured insecure-registry host mapping (ClusterIP rewrites break it).
    if (serviceName === 'eve-registry') {
      return image;
    }

    try {
      const clusterIP = await this.k8sService.getServiceClusterIP(namespace, serviceName);
      if (!clusterIP) {
        return image;
      }
      const normalizedRegistry = port ? `${clusterIP}:${port}` : clusterIP;
      return `${normalizedRegistry}/${repository}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to resolve ClusterIP for registry host ${host}, using original image ref: ${message}`,
      );
      return image;
    }
  }

  private async resolveEnvironmentScope(envId: string): Promise<{
    namespace: string;
    environment: NonNullable<Awaited<ReturnType<typeof this.environments.findById>>>;
    project: NonNullable<Awaited<ReturnType<typeof this.projects.findById>>>;
    org: NonNullable<Awaited<ReturnType<typeof this.orgs.findById>>>;
  }> {
    const environment = await this.environments.findById(envId);
    if (!environment) {
      throw new Error(`Environment ${envId} not found`);
    }

    const project = await this.projects.findById(environment.project_id, { include_deleted: true });
    if (!project) {
      throw new Error(`Project ${environment.project_id} not found`);
    }

    const org = await this.orgs.findById(project.org_id);
    if (!org) {
      throw new Error(`Org ${project.org_id} not found for project ${project.id}`);
    }

    const namespace = deriveNamespace(org.slug, project.slug, environment.name, environment.namespace);
    return { namespace, environment, project, org };
  }

  /**
   * Topological sort of components by depends_on.
   * Returns components in order so dependencies are deployed first.
   * Throws if circular dependency detected.
   */
  private topologicalSort(
    components: Record<string, any>
  ): Array<{ name: string; component: any }> {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: Array<{ name: string; component: any }> = [];

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving component: ${name}`);
      }

      visiting.add(name);
      const component = components[name];
      const deps = component?.depends_on;

      if (deps && typeof deps === 'object') {
        for (const depName of Object.keys(deps)) {
          if (components[depName]) {
            visit(depName);
          }
        }
      }

      visiting.delete(name);
      visited.add(name);
      result.push({ name, component });
    };

    for (const name of Object.keys(components)) {
      visit(name);
    }

    return result;
  }

  private validateReleaseImageDigests(
    releaseId: string,
    imageDigests: Record<string, string> | null,
    manifestYaml: string,
  ): void {
    if (!imageDigests || Object.keys(imageDigests).length === 0) {
      return;
    }

    const parsed = yaml.parse(manifestYaml);
    const validated = ManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Cannot validate release ${releaseId} images: invalid manifest`);
    }

    const services = getServicesFromManifest(validated.data) ?? {};
    const missing: string[] = [];
    const invalid: string[] = [];

    for (const [serviceName, digest] of Object.entries(imageDigests)) {
      if (!services[serviceName]) {
        missing.push(serviceName);
        continue;
      }
      if (!digest.startsWith('sha256:')) {
        invalid.push(`${serviceName}=${digest}`);
      }
    }

    if (missing.length > 0 || invalid.length > 0) {
      const fragments: string[] = [];
      if (missing.length > 0) {
        fragments.push(`unknown services: ${missing.join(', ')}`);
      }
      if (invalid.length > 0) {
        fragments.push(`invalid digests: ${invalid.join(', ')}`);
      }
      throw new Error(`Release ${releaseId} failed image preflight (${fragments.join('; ')})`);
    }
  }

  /**
   * Wait for all deployments in an environment namespace to become ready.
   * Returns the last observed status so callers can include readiness details
   * in their own response or error handling.
   */
  private async waitForDeploymentReadiness(
    namespace: string,
    timeoutMs: number = 120000,
  ): Promise<NonNullable<DeploymentStatus['k8sStatus']>> {
    const startTime = Date.now();
    const pollInterval = 2000;
    let lastStatus = await this.k8sService.getDeploymentStatus(namespace);

    while (!lastStatus.ready && Date.now() - startTime < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - startTime);
      await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, Math.max(remaining, 0))));
      lastStatus = await this.k8sService.getDeploymentStatus(namespace);
    }

    if (lastStatus.ready) {
      this.logger.log(`Environment namespace ${namespace} is ready`);
    }

    return lastStatus;
  }

  /**
   * Wait for a component's deployment to become healthy.
   * @param namespace - K8s namespace
   * @param resourceName - K8s deployment name
   * @param timeoutMs - Maximum wait time (default 120s)
   */
  private async waitForComponentHealth(
    namespace: string,
    resourceName: string,
    timeoutMs: number = 120000
  ): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 2000;

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.k8sService.getDeploymentStatus(namespace, resourceName);
      if (status.ready) {
        this.logger.log(`Component ${resourceName} is healthy`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Component ${resourceName} failed to become healthy within ${timeoutMs}ms`);
  }

  /**
   * Convert Docker-compose style healthcheck to K8s readinessProbe.
   * Supports CMD and CMD-SHELL formats.
   *
   * Special handling for curl commands: converts to native K8s httpGet probes
   * since containers often don't have curl installed.
   */
  private healthcheckToK8sProbe(healthcheck: Healthcheck | undefined): K8sProbe | undefined {
    if (!healthcheck?.test) return undefined;

    const test = Array.isArray(healthcheck.test)
      ? healthcheck.test
      : ['CMD-SHELL', healthcheck.test];

    const [type, ...args] = test;

    if (type === 'CMD' || type === 'CMD-SHELL') {
      // Detect curl commands and convert to native httpGet probe
      const httpMatch = this.parseCurlHealthcheck(args, type);
      if (httpMatch) {
        return {
          httpGet: {
            path: httpMatch.path,
            port: httpMatch.port,
            scheme: httpMatch.scheme,
          },
          initialDelaySeconds: this.parseDuration(healthcheck.start_period) ?? 0,
          periodSeconds: this.parseDuration(healthcheck.interval) ?? 10,
          timeoutSeconds: this.parseDuration(healthcheck.timeout) ?? 5,
          failureThreshold: healthcheck.retries ?? 3,
        };
      }

      // Fall back to exec probe for non-curl commands
      return {
        exec: {
          command: type === 'CMD-SHELL'
            ? ['/bin/sh', '-c', args.join(' ')]
            : args,
        },
        initialDelaySeconds: this.parseDuration(healthcheck.start_period) ?? 0,
        periodSeconds: this.parseDuration(healthcheck.interval) ?? 10,
        timeoutSeconds: this.parseDuration(healthcheck.timeout) ?? 5,
        failureThreshold: healthcheck.retries ?? 3,
      };
    }

    return undefined;
  }

  /**
   * Parse curl healthcheck commands and extract HTTP endpoint details.
   * Returns null if the command is not a curl command.
   *
   * Supports formats like:
   *   curl -f http://localhost:3000/health
   *   curl --fail http://localhost:3000/health
   *   curl -sf http://localhost:3000/health
   */
  private parseCurlHealthcheck(
    args: string[],
    type: string,
  ): { scheme: 'HTTP' | 'HTTPS'; path: string; port: number } | null {
    const cmdString = type === 'CMD-SHELL' ? args.join(' ') : args.join(' ');

    // Match curl commands targeting localhost
    // Handles: curl -f http://localhost:3000/health, curl --fail --silent https://localhost:8080/
    const curlMatch = cmdString.match(
      /curl\s+(?:[-]+\w+\s+)*(https?):\/\/localhost:(\d+)(\/[^\s]*)?/i,
    );

    if (!curlMatch) return null;

    const scheme = curlMatch[1].toUpperCase() as 'HTTP' | 'HTTPS';
    const port = parseInt(curlMatch[2], 10);
    const path = curlMatch[3] || '/';

    return { scheme, path, port };
  }

  /**
   * Parse duration string (e.g., "5s", "30s", "1m") to seconds.
   * Returns undefined if the string cannot be parsed.
   */
  private parseDuration(duration: string | undefined): number | undefined {
    if (!duration) return undefined;

    const match = duration.match(/^(\d+)(s|m|h)?$/);
    if (!match) return undefined;

    const value = parseInt(match[1], 10);
    const unit = match[2] || 's';

    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      default: return undefined;
    }
  }
}
