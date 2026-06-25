import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BuildAllParams,
  BuildResult,
  BuildServiceParams,
  BuildBackend,
} from './image-builder.interface.js';

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function parseHostFromImageRef(imageRef: string): string | null {
  const imageNoTag = imageRef.split('@')[0] ?? imageRef;
  const firstSegment = imageNoTag.split('/')[0];
  if (!firstSegment) return null;
  if (
    firstSegment.includes('.') ||
    firstSegment.includes(':') ||
    firstSegment === 'localhost'
  ) {
    return firstSegment;
  }
  return null;
}

function parseHostFromRegistryRef(ref: string): string | null {
  const candidate = ref.split('@')[0]?.split(':')[0] ?? ref;
  const firstSegment = candidate.split('/')[0];
  if (!firstSegment) return null;
  if (
    firstSegment.includes('.') ||
    firstSegment.includes(':') ||
    firstSegment === 'localhost'
  ) {
    return firstSegment;
  }
  return null;
}

function isLikelyInsecureHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === 'localhost' ||
    normalized.startsWith('localhost:') ||
    normalized.startsWith('127.') ||
    normalized.startsWith('host.docker.internal') ||
    normalized.includes('.svc') ||
    normalized.includes('.cluster.local') ||
    normalized.startsWith('k3d-registry') ||
    normalized.startsWith('eve-registry')
  );
}

function resolveInsecureRegistryHosts(): Set<string> {
  const raw = process.env.EVE_BUILDKIT_INSECURE_REGISTRIES;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((entry) => normalizeHost(entry))
      .filter((entry) => entry.length > 0),
  );
}

export function shouldUseInsecureRegistryForHost(
  host: string | null,
  insecureHosts: Set<string> = resolveInsecureRegistryHosts(),
): boolean {
  if (!host) return false;
  if (isTruthy(process.env.EVE_BUILDKIT_INSECURE_ALL)) return true;

  const normalized = normalizeHost(host);
  if (insecureHosts.has(normalized)) return true;
  return isLikelyInsecureHost(normalized);
}

function extractFailedStage(outputLines: string[]): string | null {
  for (let i = outputLines.length - 1; i >= 0; i--) {
    const match = outputLines[i].match(/#\d+\s+\[([^\]]+)\]\s+(.+)/);
    if (match) return `[${match[1]}] ${match[2]}`;
  }
  return null;
}

@Injectable()
export class BuildKitBuilder implements BuildBackend {
  private readonly logger = new Logger(BuildKitBuilder.name);

  async buildAll(_params: BuildAllParams): Promise<BuildResult> {
    throw new Error('Use ImageBuilderService.buildAll() instead');
  }

  async buildService(params: BuildServiceParams): Promise<string> {
    const addr = this.resolveBuildkitAddr();
    this.logger.log(
      `Building service ${params.serviceName} with tag ${params.tag} (buildkit ${addr})`,
    );
    params.onLog?.(`buildkit addr: ${addr}`);

    let tempDir: string | undefined;

    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildkit-'));
      const dockerConfigPath = path.join(tempDir, 'config.json');
      const metadataPath = path.join(tempDir, 'metadata.json');

      const dockerConfigJson = Buffer.from(
        params.registryAuth.dockerConfigJson,
        'base64',
      ).toString('utf-8');
      await fs.writeFile(dockerConfigPath, dockerConfigJson, 'utf-8');

      const buildContext = params.service.build?.context ?? '.';
      const dockerfile = params.service.build?.dockerfile ?? 'Dockerfile';
      const contextPath = path.resolve(params.workspacePath, buildContext);
      const normalizedContext = path
        .normalize(buildContext)
        .replace(/^\.[\\/]?/, '');
      const normalizedDockerfile = path
        .normalize(dockerfile)
        .replace(/^\.[\\/]?/, '');

      let relativeDockerfile = normalizedDockerfile;
      if (
        normalizedContext &&
        normalizedDockerfile.startsWith(normalizedContext + path.sep)
      ) {
        relativeDockerfile = normalizedDockerfile.slice(
          normalizedContext.length + 1,
        );
      }

      const fullImageTag = `${params.imageRef}:${params.tag}`;
      const insecureHosts = resolveInsecureRegistryHosts();
      const imageRegistryHost = parseHostFromImageRef(params.imageRef);
      const insecureOutput =
        shouldUseInsecureRegistryForHost(params.registryAuth.host, insecureHosts) ||
        shouldUseInsecureRegistryForHost(imageRegistryHost, insecureHosts);
      const outputSpec = insecureOutput
        ? `type=image,name=${fullImageTag},push=true,registry.insecure=true`
        : `type=image,name=${fullImageTag},push=true`;

      const args = [
        '--addr',
        addr,
        'build',
        '--progress=plain',
        '--frontend',
        'dockerfile.v0',
        '--local',
        `context=${contextPath}`,
        '--local',
        `dockerfile=${contextPath}`,
        '--opt',
        `filename=${relativeDockerfile}`,
        '--output',
        outputSpec,
        '--metadata-file',
        metadataPath,
      ];
      if (insecureOutput) {
        params.onLog?.(`buildkit registry transport: insecure for ${params.registryAuth.host}`);
      }

      const cacheRepo = process.env.EVE_BUILDKIT_CACHE_REPO;
      if (cacheRepo) {
        const cacheHost = parseHostFromRegistryRef(cacheRepo);
        const insecureCache = shouldUseInsecureRegistryForHost(cacheHost, insecureHosts);
        const exportCacheSpec = insecureCache
          ? `type=registry,ref=${cacheRepo},mode=max,registry.insecure=true`
          : `type=registry,ref=${cacheRepo},mode=max`;
        const importCacheSpec = insecureCache
          ? `type=registry,ref=${cacheRepo},registry.insecure=true`
          : `type=registry,ref=${cacheRepo}`;
        args.push(
          '--export-cache',
          exportCacheSpec,
          '--import-cache',
          importCacheSpec,
        );
        params.onLog?.(
          `buildkit cache repo: ${cacheRepo}${insecureCache ? ' (insecure transport)' : ''}`,
        );
      }

      if (params.repoUrl) {
        args.push(
          '--opt',
          `label:org.opencontainers.image.source=${params.repoUrl}`,
        );
      }
      args.push(
        '--opt',
        `label:org.opencontainers.image.description=Eve Horizon built image: ${params.serviceName}`,
      );

      // Build args (auto-injected + manifest-defined)
      args.push('--opt', `build-arg:GIT_SHA=${params.gitSha}`);
      args.push('--opt', `build-arg:BUILD_DATE=${new Date().toISOString()}`);
      for (const [key, value] of Object.entries(params.service.build?.args ?? {})) {
        args.push('--opt', `build-arg:${key}=${value}`);
      }

      params.onLog?.(`Running buildctl build --push for ${fullImageTag}`);

      const outputLines: string[] = [];
      const { exitCode } = await this.spawnBuildctl(args, {
        cwd: params.workspacePath,
        env: {
          DOCKER_CONFIG: tempDir,
        },
        onLine: (line) => {
          outputLines.push(line);
          params.onLog?.(line);
        },
      });

      if (exitCode !== 0) {
        const tail = outputLines.slice(-30).join('\n');
        const failedStage = extractFailedStage(outputLines);
        throw new Error(
          `buildctl failed with exit code ${exitCode}` +
          (failedStage ? ` at ${failedStage}` : '') +
          `\n--- Last ${Math.min(outputLines.length, 30)} lines ---\n${tail}`,
        );
      }

      const digest = await this.extractDigest(metadataPath, outputLines);
      this.logger.log(`Service ${params.serviceName} pushed with digest: ${digest}`);
      params.onLog?.(`Digest: ${digest}`);
      return digest;
    } finally {
      if (tempDir) {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (err) {
          this.logger.warn(`Failed to clean up temp directory ${tempDir}: ${err}`);
        }
      }
    }
  }

  private resolveBuildkitAddr(): string {
    return (
      process.env.EVE_BUILDKIT_ADDR ??
      process.env.BUILDKIT_HOST ??
      'tcp://buildkitd.eve.svc:1234'
    );
  }

  private async spawnBuildctl(
    args: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      onLine?: (line: string) => void;
    },
  ): Promise<{ exitCode: number }> {
    const env = {
      ...process.env,
      ...opts.env,
    };

    const proc = spawn('buildctl', args, {
      cwd: opts.cwd,
      env,
    });

    const onLine = opts.onLine;
    const stdoutBuffer = this.createLineBuffer(onLine);
    const stderrBuffer = this.createLineBuffer(onLine);

    proc.stdout?.on('data', (chunk) => stdoutBuffer.push(chunk.toString()));
    proc.stderr?.on('data', (chunk) => stderrBuffer.push(chunk.toString()));

    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code) => resolve(code ?? 1));
    });

    stdoutBuffer.flush();
    stderrBuffer.flush();

    return { exitCode };
  }

  private createLineBuffer(onLine?: (line: string) => void) {
    let buffer = '';
    return {
      push: (chunk: string) => {
        if (!onLine) return;
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
        if (!onLine) return;
        const line = buffer.replace(/\r$/, '');
        if (line) {
          onLine(line);
        }
        buffer = '';
      },
    };
  }

  private async extractDigest(
    metadataPath: string,
    outputLines: string[],
  ): Promise<string> {
    try {
      const metadataRaw = await fs.readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
      const direct = metadata['containerimage.digest'] as string | undefined;
      if (direct) {
        return direct;
      }
      const exporter = metadata['exporter-response'] as Record<string, unknown> | undefined;
      const digest = typeof exporter?.['digest'] === 'string' ? exporter['digest'] : undefined;
      if (digest) {
        return digest;
      }
    } catch (err) {
      this.logger.warn(`Failed to parse buildkit metadata: ${err}`);
    }

    const combined = outputLines.join('\n');
    const match = combined.match(/sha256:[a-f0-9]{64}/g);
    if (match && match.length > 0) {
      return match[match.length - 1];
    }

    throw new Error('BuildKit build succeeded but no digest found');
  }
}
