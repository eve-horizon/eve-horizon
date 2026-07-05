import { Logger } from '@nestjs/common';
import {
  loadConfig,
  isEveRegistry,
  getRegistryConfig,
  type Manifest,
  type Service,
} from '@eve/shared';
import { K8sService } from './k8s.service';

/**
 * ImageResolver - Resolves image references, digests, and registry hosts for
 * rendered workloads. Extracted from DeployerService.
 */
export class ImageResolver {
  constructor(
    private readonly k8sService: K8sService,
    private readonly logger: Logger,
  ) {}

  /**
   * Resolve the registry host from the manifest's registry config.
   * Returns null if no registry prefix should be applied.
   */
  resolveRegistryHost(manifest: Manifest): string | null {
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
  prefixRegistryHost(image: string, registryHost: string | null): string {
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

  resolveImageRef(baseImage: unknown, digest?: string, imageTag?: string): string {
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

  resolveServiceDigest(
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

  normalizeImageRepository(image: string): string {
    const withoutDigest = image.split('@')[0];
    const lastSlash = withoutDigest.lastIndexOf('/');
    const lastColon = withoutDigest.lastIndexOf(':');
    if (lastColon > lastSlash) {
      return withoutDigest.slice(0, lastColon);
    }
    return withoutDigest;
  }

  async normalizeImageForKubelet(image: string): Promise<string> {
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
}
