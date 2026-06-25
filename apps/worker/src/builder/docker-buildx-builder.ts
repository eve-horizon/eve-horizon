import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BuildServiceParams,
  BuildAllParams,
  BuildResult,
  RegistryAuth,
  BuildBackend,
} from './image-builder.interface.js';

const execFileAsync = promisify(execFile);

@Injectable()
export class DockerBuildxBuilder implements BuildBackend {
  private readonly logger = new Logger(DockerBuildxBuilder.name);

  /**
   * Build and push all buildable services.
   * This method should not be called directly - use ImageBuilderService.buildAll() instead.
   */
  async buildAll(params: BuildAllParams): Promise<BuildResult> {
    throw new Error('Use ImageBuilderService.buildAll() instead');
  }

  /**
   * Build and push a single service using Docker Buildx.
   * Returns the pushed image digest (sha256:...).
   */
  async buildService(params: BuildServiceParams): Promise<string> {
    this.logger.log(
      `Building service ${params.serviceName} with tag ${params.tag}`,
    );
    params.onLog?.(`docker buildx: ${params.serviceName}:${params.tag}`);

    let tempDir: string | undefined;

    try {
      // Create temporary directory for metadata file
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildx-metadata-'));
      const metadataPath = path.join(tempDir, 'metadata.json');

      // Login to registry
      await this.loginToRegistry(params.registryAuth);

      // Prepare build context and dockerfile paths
      const contextPath = path.join(
        params.workspacePath,
        params.service.build!.context,
      );
      const dockerfile = params.service.build!.dockerfile ?? 'Dockerfile';
      const fullImageTag = `${params.imageRef}:${params.tag}`;

      this.logger.log(
        `Running docker buildx build --push for ${fullImageTag}`,
      );
      this.logger.debug(`Context: ${contextPath}, Dockerfile: ${dockerfile}`);
      params.onLog?.(`Running docker buildx build --push for ${fullImageTag}`);

      // Run docker buildx build with --push
      const buildArgs = [
        'buildx',
        'build',
        '--push',
        '--tag',
        fullImageTag,
        '--metadata-file',
        metadataPath,
        '--file',
        path.join(contextPath, dockerfile),
      ];

      // Add OCI labels
      if (params.repoUrl) {
        buildArgs.push('--label', `org.opencontainers.image.source=${params.repoUrl}`);
      }
      buildArgs.push('--label', `org.opencontainers.image.description=Eve Horizon built image: ${params.serviceName}`);

      // Build args (auto-injected + manifest-defined)
      buildArgs.push('--build-arg', `GIT_SHA=${params.gitSha}`);
      buildArgs.push('--build-arg', `BUILD_DATE=${new Date().toISOString()}`);
      for (const [key, value] of Object.entries(params.service.build?.args ?? {})) {
        buildArgs.push('--build-arg', `${key}=${value}`);
      }

      buildArgs.push(contextPath);

      await this.execCommand('docker', buildArgs, { cwd: params.workspacePath });

      this.logger.log(`Successfully built and pushed ${fullImageTag}`);
      params.onLog?.(`Successfully built and pushed ${fullImageTag}`);

      // Extract digest from metadata file
      const digest = await this.extractDigest(
        metadataPath,
        params.imageRef,
        params.tag,
      );

      this.logger.log(
        `Service ${params.serviceName} pushed with digest: ${digest}`,
      );
      params.onLog?.(`Digest: ${digest}`);

      return digest;
    } finally {
      // Clean up temporary directory
      if (tempDir) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn(
            `Failed to clean up temp directory ${tempDir}: ${err}`,
          );
        }
      }
    }
  }

  /**
   * Execute a command and return its output.
   * Throws an error if the command fails.
   */
  private async execCommand(
    command: string,
    args: string[],
    options?: { input?: string; cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const execOptions: Parameters<typeof execFileAsync>[2] = {
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large outputs
        ...(options?.cwd && { cwd: options.cwd }),
        ...(options?.input && { input: options.input }),
      };

      const result = await execFileAsync(command, args, execOptions);

      const stdout =
        typeof result.stdout === 'string'
          ? result.stdout
          : result.stdout.toString();
      const stderr =
        typeof result.stderr === 'string'
          ? result.stderr
          : result.stderr.toString();

      if (stderr) {
        this.logger.debug(`Command stderr: ${stderr}`);
      }

      return { stdout, stderr };
    } catch (err: unknown) {
      const error = err as {
        code?: string | number;
        stderr?: string;
        stdout?: string;
        message?: string;
      };

      const errorMessage = [
        `Command failed: ${command} ${args.join(' ')}`,
        error.stderr && `stderr: ${error.stderr}`,
        error.stdout && `stdout: ${error.stdout}`,
        error.message && `message: ${error.message}`,
      ]
        .filter(Boolean)
        .join('\n');

      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  /**
   * Login to the Docker registry using the provided credentials.
   */
  private async loginToRegistry(auth: RegistryAuth): Promise<void> {
    this.logger.log(`Logging in to registry ${auth.host}`);

    try {
      await this.execCommand(
        'docker',
        ['login', auth.host, '-u', auth.username, '--password-stdin'],
        { input: auth.token },
      );

      this.logger.log(`Successfully logged in to ${auth.host}`);
    } catch (err) {
      this.logger.error(`Failed to login to registry ${auth.host}: ${err}`);
      throw err;
    }
  }

  /**
   * Extract the image digest from the metadata file.
   * Falls back to docker buildx imagetools inspect if metadata parsing fails.
   */
  private async extractDigest(
    metadataPath: string,
    imageRef: string,
    tag: string,
  ): Promise<string> {
    try {
      // Try reading and parsing the metadata file
      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent);

      if (metadata['containerimage.digest']) {
        const digest = metadata['containerimage.digest'] as string;
        this.logger.debug(`Extracted digest from metadata: ${digest}`);
        return digest;
      }

      this.logger.warn(
        'Metadata file does not contain containerimage.digest, falling back to imagetools inspect',
      );
    } catch (err) {
      this.logger.warn(
        `Failed to parse metadata file: ${err}, falling back to imagetools inspect`,
      );
    }

    // Fallback: use docker buildx imagetools inspect
    return this.extractDigestFromImagetools(imageRef, tag);
  }

  /**
   * Extract digest using docker buildx imagetools inspect.
   */
  private async extractDigestFromImagetools(
    imageRef: string,
    tag: string,
  ): Promise<string> {
    const fullImageTag = `${imageRef}:${tag}`;
    this.logger.log(`Inspecting image ${fullImageTag} to extract digest`);

    const { stdout } = await this.execCommand('docker', [
      'buildx',
      'imagetools',
      'inspect',
      fullImageTag,
    ]);

    // Parse the output to find the Digest line
    const lines = stdout.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Digest:')) {
        const digest = trimmed.replace(/^Digest:\s*/, '').trim();
        this.logger.debug(`Extracted digest from imagetools: ${digest}`);
        return digest;
      }
    }

    throw new Error(
      `Could not find digest in imagetools inspect output for ${fullImageTag}`,
    );
  }
}
