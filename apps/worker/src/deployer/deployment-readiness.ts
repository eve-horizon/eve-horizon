import { Logger } from '@nestjs/common';
import { waitFor } from '@eve/shared';
import { K8sService } from './k8s.service';
import type { DeploymentStatus } from './deployer.service';

/**
 * DeploymentReadiness - Polls K8s deployment status until environments and
 * individual components become ready. Extracted from DeployerService.
 */
export class DeploymentReadiness {
  constructor(
    private readonly k8sService: K8sService,
    private readonly logger: Logger,
  ) {}

  /**
   * Wait for all deployments in an environment namespace to become ready.
   * Returns the last observed status so callers can include readiness details
   * in their own response or error handling.
   */
  async waitForDeploymentReadiness(
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
  async waitForComponentHealth(
    namespace: string,
    resourceName: string,
    timeoutMs: number = 120000
  ): Promise<void> {
    await waitFor(
      async () => (await this.k8sService.getDeploymentStatus(namespace, resourceName)).ready,
      { timeoutMs, intervalMs: 2000, label: `component ${resourceName} health` },
    );
    this.logger.log(`Component ${resourceName} is healthy`);
  }
}
