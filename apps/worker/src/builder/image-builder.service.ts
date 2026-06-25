import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'yaml';
import {
  Manifest,
  ManifestSchema,
  getBuildableServicesWithDefaults,
  getRegistryConfig,
  isRegistryNone,
  hasUsableRegistry,
} from '@eve/shared';
import {
  BuildAllParams,
  BuildResult,
  BuildServiceParams,
  BUILD_BACKEND,
  BuildBackend,
} from './image-builder.interface.js';
import { RegistryAuthService } from './registry-auth.service.js';

const execFileAsync = promisify(execFile);

@Injectable()
export class ImageBuilderService {
  private readonly logger = new Logger(ImageBuilderService.name);

  constructor(
    private readonly registryAuth: RegistryAuthService,
    @Inject(BUILD_BACKEND) private readonly builder: BuildBackend,
  ) {}

  /**
   * Build and push all buildable services from the manifest.
   * Returns a map of service name to pushed image digest.
   */
  async buildAll(params: BuildAllParams): Promise<BuildResult> {
    const log = params.onLog;
    // 1. Parse manifest and get buildable services
    const manifest = yaml.parse(params.manifestYaml) as Manifest;
    const parsed = ManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      throw new Error(`Invalid manifest YAML: ${parsed.error.message}`);
    }

    // If registry is explicitly "none", skip builds — there's nowhere to push images.
    if (isRegistryNone(parsed.data)) {
      this.logger.warn('Manifest has registry: "none" — skipping image builds');
      log?.('Manifest has registry: "none" — skipping image builds');
      return { imageDigests: {} };
    }

    const buildableServices = getBuildableServicesWithDefaults(parsed.data);
    const serviceNames = Object.keys(buildableServices);

    if (serviceNames.length === 0) {
      // Check for services with build config that weren't included
      const allServices = parsed.data.services ?? {};
      const servicesWithBuild = Object.entries(allServices).filter(
        ([, svc]) => svc.build && !svc.image,
      );

      if (servicesWithBuild.length > 0) {
        const names = servicesWithBuild.map(([n]) => n).join(', ');
        const suggestion = hasUsableRegistry(parsed.data)
          ? 'Check for x-eve.external: true on these services.'
          : 'Add an `image` field to each service, or configure a `registry` in your manifest so image names can be auto-derived.';
        throw new Error(
          `No buildable services found, but ${servicesWithBuild.length} service(s) have \`build\` config without \`image\`: ${names}. ${suggestion}`,
        );
      }

      this.logger.log('No buildable services found in manifest');
      log?.('No buildable services found in manifest');
      return { imageDigests: {} };
    }

    // 2. Filter by params.components if provided
    const servicesToBuild = params.components
      ? Object.entries(buildableServices).filter(([name]) =>
          params.components!.includes(name),
        )
      : Object.entries(buildableServices);

    if (servicesToBuild.length === 0) {
      const filter = params.components ? ` matching components: ${params.components.join(', ')}` : '';
      this.logger.log(`No buildable services found${filter}`);
      log?.(`No buildable services found${filter}`);
      return { imageDigests: {} };
    }

    // 3. Resolve registry auth
    const { auth: registryAuthData, config: registryConfigData } =
      await this.registryAuth.resolve(params.projectId, params.manifestYaml);

    // 4. Compute tag (default: sha-<gitSha[:12]>)
    const tag = params.tag ?? `sha-${params.gitSha.slice(0, 12)}`;

    // 5. Resolve repo URL from git remote
    const repoUrl = await this.resolveRepoUrl(params.workspacePath);

    this.logger.log(
      `Building ${servicesToBuild.length} service(s) with tag: ${tag}`,
    );
    log?.(`Building ${servicesToBuild.length} service(s) with tag: ${tag}`);

    // 6. Build each service using this.builder.buildService()
    const imageDigests: Record<string, string> = {};

    for (const [serviceName, service] of servicesToBuild) {
      this.logger.log(`Building service: ${serviceName}`);
      log?.(`Starting build for ${serviceName}`);

      if (!service.image) {
        throw new Error(`Service '${serviceName}' is missing an image name`);
      }

      // Image ref: prefix registry host unless service.image already includes one.
      const imageWithoutDigest = service.image.split('@')[0];
      const lastSlashIndex = imageWithoutDigest.lastIndexOf('/');
      const lastColonIndex = imageWithoutDigest.lastIndexOf(':');
      const imageName =
        lastColonIndex > lastSlashIndex
          ? imageWithoutDigest.slice(0, lastColonIndex)
          : imageWithoutDigest;
      const imageFirstSegment = imageName.split('/')[0];
      const hasRegistry =
        imageFirstSegment.includes('.') ||
        imageFirstSegment.includes(':') ||
        imageFirstSegment === 'localhost';
      const imageRef = hasRegistry
        ? service.image
        : `${registryAuthData.host}/${service.image}`;

      const buildParams: BuildServiceParams = {
        serviceName,
        service,
        registryConfig: registryConfigData,
        registryAuth: registryAuthData,
        gitSha: params.gitSha,
        workspacePath: params.workspacePath,
        tag,
        imageRef,
        repoUrl,
        onLog: log ? (message: string) => log(`[${serviceName}] ${message}`) : undefined,
      };

      try {
        const digest = await this.builder.buildService(buildParams);
        imageDigests[serviceName] = digest;
        this.logger.log(`Built ${serviceName}: ${imageRef}:${tag} (${digest})`);
        log?.(`Built ${serviceName}: ${imageRef}:${tag} (${digest})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to build ${serviceName}: ${message}`);
        log?.(`Failed to build ${serviceName}: ${message}`);
        const succeeded = Object.keys(imageDigests);
        const partialInfo = succeeded.length > 0
          ? `\n(${succeeded.length} other service(s) built successfully: ${succeeded.join(', ')})`
          : '';
        throw new Error(
          `Build failed for service '${serviceName}': ${message}${partialInfo}`,
        );
      }
    }

    this.logger.log(
      `Successfully built ${Object.keys(imageDigests).length} service(s)`,
    );
    log?.(`Successfully built ${Object.keys(imageDigests).length} service(s)`);

    // 7. Collect and return digests
    return { imageDigests };
  }

  /**
   * Resolve the Git repository URL from the workspace.
   * Converts SSH URLs to HTTPS and strips trailing .git.
   */
  private async resolveRepoUrl(
    workspacePath: string,
  ): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['remote', 'get-url', 'origin'],
        { cwd: workspacePath },
      );

      let url = stdout.trim();
      if (!url) {
        return undefined;
      }

      // Convert SSH to HTTPS (e.g., git@github.com:org/repo.git -> https://github.com/org/repo)
      if (url.startsWith('git@')) {
        url = url
          .replace(/^git@([^:]+):/, 'https://$1/')
          .replace(/\.git$/, '');
      } else {
        // Strip trailing .git from HTTPS URLs
        url = url.replace(/\.git$/, '');
      }

      // Strip embedded credentials (e.g., https://token@github.com/... or https://user:pass@...)
      // These appear when repos are cloned with tokens in the URL and must not leak into OCI labels
      url = url.replace(/^(https?:\/\/)[^@]+@/, '$1');

      return url;
    } catch (error) {
      this.logger.warn(
        `Failed to resolve repo URL from git remote: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}
