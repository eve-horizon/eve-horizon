import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as k8s from '@kubernetes/client-node';
import {
  BuildServiceParams,
  BuildAllParams,
  BuildResult,
  BuildBackend,
} from './image-builder.interface.js';
import { K8sService } from '../deployer/k8s.service.js';

const execFileAsync = promisify(execFile);

/** Must match the version COPY'd into the worker Dockerfile */
const KANIKO_IMAGE = 'gcr.io/kaniko-project/executor:v1.20.1';
const GIT_IMAGE = 'alpine/git:2.47.2';
const BUILD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class KanikoBuilder implements BuildBackend {
  private readonly logger = new Logger(KanikoBuilder.name);

  constructor(private readonly k8sService: K8sService) {}

  async buildAll(_params: BuildAllParams): Promise<BuildResult> {
    throw new Error('Use ImageBuilderService.buildAll() instead');
  }

  async buildService(params: BuildServiceParams): Promise<string> {
    this.logger.log(
      `Building service ${params.serviceName} with tag ${params.tag} (kaniko k8s-job)`,
    );

    const namespace = this.getNamespace();
    const suffix = `${params.serviceName}-${Date.now()}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .slice(0, 50);
    const jobName = `kaniko-${suffix}`;
    const secretName = `kaniko-cfg-${suffix}`;

    // Extract authenticated git URL from the cloned workspace
    const gitUrl = await this.getGitRemoteUrl(params.workspacePath);

    // Decode the Docker config JSON (stored base64 in params)
    const dockerConfigJson = Buffer.from(
      params.registryAuth.dockerConfigJson,
      'base64',
    ).toString('utf-8');

    // Create a K8s Secret with registry auth + git clone URL
    await this.k8sService.createSecret(namespace, secretName, {
      'config.json': dockerConfigJson,
      'git-url': gitUrl,
    });

    try {
      const fullImageTag = `${params.imageRef}:${params.tag}`;

      // Resolve build context and Dockerfile paths relative to /workspace
      const buildContext = params.service.build?.context ?? '.';
      const dockerfile = params.service.build?.dockerfile ?? 'Dockerfile';
      const normalizedContext = path.normalize(buildContext).replace(/^\.[\\/]?/, '');
      const normalizedDockerfile = path.normalize(dockerfile).replace(/^\.[\\/]?/, '');

      // If dockerfile includes the context prefix, strip it for the relative path
      let relativeDockerfile = normalizedDockerfile;
      if (
        normalizedContext &&
        normalizedDockerfile.startsWith(normalizedContext + '/')
      ) {
        relativeDockerfile = normalizedDockerfile.slice(
          normalizedContext.length + 1,
        );
      }

      const contextPath = normalizedContext
        ? `/workspace/${normalizedContext}`
        : '/workspace';
      const dockerfilePath = `${contextPath}/${relativeDockerfile}`;

      // Build kaniko args
      const kanikoArgs = [
        `--context=dir://${contextPath}`,
        `--dockerfile=${dockerfilePath}`,
        `--destination=${fullImageTag}`,
      ];

      // Add OCI labels
      if (params.repoUrl) {
        kanikoArgs.push(
          `--label=org.opencontainers.image.source=${params.repoUrl}`,
        );
      }
      kanikoArgs.push(
        `--label=org.opencontainers.image.description=Eve Horizon built image: ${params.serviceName}`,
      );

      // Build args (auto-injected + manifest-defined)
      kanikoArgs.push(`--build-arg=GIT_SHA=${params.gitSha}`);
      kanikoArgs.push(`--build-arg=BUILD_DATE=${new Date().toISOString()}`);
      for (const [key, value] of Object.entries(params.service.build?.args ?? {})) {
        kanikoArgs.push(`--build-arg=${key}=${value}`);
      }

      // Create and run the K8s Job
      const job = this.createJobSpec({
        jobName,
        secretName,
        gitSha: params.gitSha,
        kanikoArgs,
        namespace,
      });

      this.logger.log(
        `Launching kaniko K8s Job ${jobName} in ${namespace} for ${fullImageTag}`,
      );
      const result = await this.k8sService.runJob(
        namespace,
        job,
        BUILD_TIMEOUT_MS,
        { onLog: params.onLog },
      );

      if (!result.success) {
        throw new Error(
          `Kaniko build failed (exit ${result.exitCode}):\n${result.logs}`,
        );
      }

      // Parse digest from kaniko's output logs
      const digest = this.parseDigest(result.logs ?? '');
      if (!digest) {
        throw new Error(
          `Kaniko build succeeded but no digest found in logs:\n${result.logs}`,
        );
      }

      this.logger.log(
        `Service ${params.serviceName} pushed with digest: ${digest}`,
      );
      return digest;
    } finally {
      try {
        await this.k8sService.deleteSecret(namespace, secretName);
      } catch (err) {
        this.logger.warn(`Failed to clean up secret ${secretName}: ${err}`);
      }
    }
  }

  /**
   * Build the K8s Job spec with:
   * - init container: clones repo at specific SHA using authenticated git URL
   * - main container: kaniko executor builds from cloned workspace
   */
  private createJobSpec(opts: {
    jobName: string;
    secretName: string;
    gitSha: string;
    kanikoArgs: string[];
    namespace: string;
  }): k8s.V1Job {
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: opts.jobName,
        namespace: opts.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'eve-worker',
          'eve.horizon/component': 'kaniko-build',
        },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: {
            labels: {
              'eve.horizon/component': 'kaniko-build',
            },
          },
          spec: {
            restartPolicy: 'Never',
            initContainers: [
              {
                name: 'clone',
                image: GIT_IMAGE,
                command: ['/bin/sh', '-c'],
                args: [
                  [
                    'git clone --no-checkout "$GIT_URL" /workspace',
                    `cd /workspace && git checkout ${opts.gitSha}`,
                  ].join(' && '),
                ],
                env: [
                  {
                    name: 'GIT_URL',
                    valueFrom: {
                      secretKeyRef: {
                        name: opts.secretName,
                        key: 'git-url',
                      },
                    },
                  },
                ],
                volumeMounts: [
                  { name: 'workspace', mountPath: '/workspace' },
                ],
              },
            ],
            containers: [
              {
                name: 'kaniko',
                image: KANIKO_IMAGE,
                args: opts.kanikoArgs,
                volumeMounts: [
                  { name: 'workspace', mountPath: '/workspace' },
                  {
                    name: 'docker-config',
                    mountPath: '/kaniko/.docker',
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              { name: 'workspace', emptyDir: {} },
              {
                name: 'docker-config',
                secret: {
                  secretName: opts.secretName,
                  items: [
                    { key: 'config.json', path: 'config.json' },
                  ],
                },
              },
            ],
          },
        },
      },
    };
  }

  /**
   * Extract the image digest (sha256:...) from kaniko's build output.
   * Kaniko logs the pushed digest in various formats; we match the hash.
   */
  private parseDigest(logs: string): string | null {
    const matches = logs.match(/sha256:[a-f0-9]{64}/g);
    if (!matches || matches.length === 0) {
      return null;
    }
    return matches[matches.length - 1];
  }

  /** Read the authenticated git remote URL from the workspace's .git/config */
  private async getGitRemoteUrl(workspacePath: string): Promise<string> {
    const { stdout } = await execFileAsync('git', [
      '-C',
      workspacePath,
      'remote',
      'get-url',
      'origin',
    ]);
    return stdout.trim();
  }

  /** Detect the K8s namespace this worker pod is running in */
  private getNamespace(): string {
    try {
      return fs
        .readFileSync(
          '/var/run/secrets/kubernetes.io/serviceaccount/namespace',
          'utf-8',
        )
        .trim();
    } catch {
      return process.env.EVE_K8S_NAMESPACE ?? 'eve-system';
    }
  }
}
