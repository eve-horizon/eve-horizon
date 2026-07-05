import { Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import * as crypto from 'crypto';
import { managedDbQueries } from '@eve/db';
import {
  type ManagedDbTrustInput,
  type Manifest,
  getManagedDbServices,
  getManagedDbConfig,
  generateManagedDbName,
  generateManagedDbUser,
  generateManagedDbTenantId,
  selectBestInstance,
  resolveBackupConfig,
  resolveManagedDbTrustBundle,
  normalizeManagedDbExtensions,
} from '@eve/shared';
import { K8sService } from './k8s.service';

export interface ResolvedManagedDbContext {
  managedValues: Map<string, string>;
  trustInputs: ManagedDbTrustInput[];
}

export interface ManagedDbTrustContext {
  enabled: boolean;
  checksum?: string;
  envEntries: k8s.V1EnvVar[];
  volumes: k8s.V1Volume[];
  volumeMounts: k8s.V1VolumeMount[];
}

const MANAGED_DB_TRUST_CONFIG_MAP_NAME = 'eve-db-trust';
const MANAGED_DB_TRUST_VOLUME_NAME = 'eve-db-trust';
const MANAGED_DB_TRUST_MOUNT_PATH = '/etc/eve/trust';
const MANAGED_DB_TRUST_BUNDLE_PATH = `${MANAGED_DB_TRUST_MOUNT_PATH}/ca-bundle.pem`;

/**
 * ManagedDbProvisioner - Resolves managed DB tenants for manifest services and
 * maintains the managed-db trust store ConfigMap. Extracted from DeployerService.
 */
export class ManagedDbProvisioner {
  constructor(
    private managedDb: ReturnType<typeof managedDbQueries>,
    private readonly k8sService: K8sService,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolve managed DB tenants for all managed_db services in the manifest.
   * Creates tenants if they don't exist, polls until ready.
   * Returns interpolation values plus trust inputs for provider CA resolution.
   */
  async resolveManagedDbTenants(params: {
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

  async ensureManagedDbTrustStore(
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
}
