import type { Logger } from '@nestjs/common';
import type { Db, StorageBucket } from '@eve/db';
import { storageBucketQueries } from '@eve/db';
import {
  type ObjectStoreBucket,
  type ObjectStoreIsolation,
  type Service,
  getServiceObjectStoreBuckets,
  getServiceObjectStoreIsolation,
  generateStorageBucketId,
} from '@eve/shared';
import {
  APP_STORAGE_CREDENTIALS_SECRET,
  type AppCredentialProvisioner,
  type AppObjectStoreBinding,
  type AppObjectStoreCredentialMode,
  type AppObjectStoreEnvVar,
  type AppObjectStoreScope,
} from './app-credential-provisioner/factory';
import type { BucketProvisioner } from './bucket-provisioner';
import type { K8sService } from './k8s.service';

export interface ObjectStoreDesiredBucket {
  serviceName: string;
  bucket: ObjectStoreBucket;
  physicalName: string;
  envKey: string;
  requestedIsolation: ObjectStoreIsolation;
}

export interface EnvObjectStorePlan {
  scope: AppObjectStoreScope;
  binding: AppObjectStoreBinding | null;
  bucketsByService: Map<string, ObjectStoreDesiredBucket[]>;
}

/**
 * Provisions per-app object-store buckets and service-account bindings
 * during environment deploys. Extracted verbatim from DeployerService
 * (refactor plan R-C1); member names match the original so bodies are
 * unmodified moves.
 */
export class ObjectStoreProvisioner {
  private storageBuckets: ReturnType<typeof storageBucketQueries>;

  constructor(
    private readonly db: Db,
    private readonly bucketProvisioner: BucketProvisioner,
    private readonly appCredentialProvisioners: AppCredentialProvisioner[],
    private readonly k8s: Pick<K8sService, 'createSecret' | 'deleteSecret'>,
    private readonly logger: Logger,
    private readonly resolveXeve: (service: Service) => Record<string, unknown> | null,
  ) {
    this.storageBuckets = storageBucketQueries(this.db);
  }

  async prepareObjectStorePlan(params: {
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
        const previous = await this.storageBuckets.listByEnv(params.scope.projectId, params.scope.envName);
        await this.unpublishBuckets(params.scope, previous, new Set());
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

    // Before any credential grant: a colliding name would hand this env
    // another env's bucket.
    await this.assertPhysicalNamesUnclaimed(params.scope, desired);

    // Read what was published before the upserts below overwrite it. A
    // bucket that turned private or left the manifest loses its public
    // grant first, so a failure leaves its row in place for the next deploy.
    const previous = await this.storageBuckets.listByEnv(params.scope.projectId, params.scope.envName);
    const stillPublic = new Set(
      desired
        .filter((entry) => (entry.bucket.visibility ?? 'private') === 'public')
        .map((entry) => entry.physicalName),
    );
    await this.unpublishBuckets(params.scope, previous, stillPublic);

    const requestedMode = this.resolveRequestedObjectStoreIsolation(desired, params.scope.envName);
    const provisioner = this.selectObjectStoreCredentialProvisioner(requestedMode, desired);
    const physicalBucketNames = [...new Set(desired.map((entry) => entry.physicalName))].sort();
    const binding = await provisioner.ensureForEnv(params.scope, physicalBucketNames);
    await this.syncCredentialSecret(params.scope.namespace, binding);

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

  /**
   * Physical names join org, project, env and bucket with hyphens, which env
   * and bucket names may also contain (env "test" + bucket "a-x" and env
   * "test-a" + bucket "x" give the same name). Existing names cannot change
   * without orphaning data, so a name already tracked for another env or
   * project is refused instead.
   */
  private async assertPhysicalNamesUnclaimed(
    scope: AppObjectStoreScope,
    desired: ObjectStoreDesiredBucket[],
  ): Promise<void> {
    const claims = await this.storageBuckets.listByPhysicalNames(
      [...new Set(desired.map((entry) => entry.physicalName))],
    );
    const conflicts = new Map<string, string>();
    for (const claim of claims) {
      if (claim.project_id === scope.projectId && claim.env_name === scope.envName) continue;
      const entry = desired.find((candidate) => candidate.physicalName === claim.physical_name);
      if (!entry || conflicts.has(claim.physical_name)) continue;
      const owner = claim.project_id === scope.projectId
        ? `env "${claim.env_name}" (bucket "${claim.name}")`
        : 'another project';
      conflicts.set(
        claim.physical_name,
        `bucket "${entry.bucket.name}" maps to "${claim.physical_name}", which ${owner} already uses`,
      );
    }
    if (conflicts.size === 0) return;
    throw new Error(
      `Object-store bucket name collision in env "${scope.envName}": ${[...conflicts.values()].join('; ')}. ` +
      'Rename the bucket or the environment.',
    );
  }

  /**
   * Remove the public grant from buckets Eve published for this env that
   * are no longer declared public. Data is never deleted.
   */
  private async unpublishBuckets(
    scope: AppObjectStoreScope,
    previous: StorageBucket[],
    stillPublic: Set<string>,
  ): Promise<void> {
    const names = [...new Set(
      previous
        .filter((row) => row.visibility === 'public' && !stillPublic.has(row.physical_name))
        .map((row) => row.physical_name),
    )].sort();
    const failures: string[] = [];
    for (const name of names) {
      try {
        await this.bucketProvisioner.removeBucketPublicReadPolicy(name);
        this.logger.log(`Removed public read access from bucket ${name} (no longer declared public)`);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Failed to remove public read access from bucket(s) no longer declared public in env "${scope.envName}": ` +
        `${failures.join('; ')}`,
      );
    }
  }

  /** Best effort for env deletion: un-publish every public bucket of the env. */
  async unpublishEnvBuckets(scope: AppObjectStoreScope): Promise<void> {
    try {
      const previous = await this.storageBuckets.listByEnv(scope.projectId, scope.envName);
      await this.unpublishBuckets(scope, previous, new Set());
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : String(error));
    }
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

  async resolveObjectStoreBuckets(
    service: Service,
    context: {
      envName: string;
      componentName: string;
    },
    objectStorePlan?: EnvObjectStorePlan,
  ): Promise<AppObjectStoreEnvVar[]> {
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

  buildObjectStoreServiceAccount(objectStorePlan: EnvObjectStorePlan): Record<string, unknown> | null {
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

  resolveObjectStoreServiceAccountName(
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

  /**
   * Keep the namespace credentials Secret equal to the binding: written (and
   * so rotated) on every deploy for static-key modes, removed for keyless ones.
   */
  private async syncCredentialSecret(namespace: string, binding: AppObjectStoreBinding): Promise<void> {
    if (binding.credentialSecret) {
      await this.k8s.createSecret(namespace, binding.credentialSecret.name, binding.credentialSecret.stringData);
    } else {
      await this.k8s.deleteSecret(namespace, APP_STORAGE_CREDENTIALS_SECRET);
    }
  }

  async removeObjectStoreBinding(scope: AppObjectStoreScope): Promise<void> {
    try {
      await this.k8s.deleteSecret(scope.namespace, APP_STORAGE_CREDENTIALS_SECRET);
    } catch (error) {
      this.logger.warn(
        `Failed to remove object-store credentials Secret for ${scope.projectSlug}/${scope.envName}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
}
