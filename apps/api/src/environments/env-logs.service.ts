import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
  MessageEvent,
} from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import type { Db } from '@eve/db';
import { projectQueries, orgQueries } from '@eve/db';
import { from, interval, Observable } from 'rxjs';
import { concatMap, share, startWith } from 'rxjs/operators';
import { wrapK8sError } from './k8s-error.js';

export interface EnvLogEntry {
  timestamp: string;
  line: string;
  pod?: string;
  container?: string;
  fields?: Record<string, unknown>;
}

export interface EnvLogsResponse {
  logs: EnvLogEntry[];
}

export type EnvLogFilters = Record<string, string>;

export interface EnvLogOptions {
  sinceSeconds?: number;
  tailLines?: number;
  grep?: string;
  filters?: EnvLogFilters;
  pod?: string;
  container?: string;
  previous?: boolean;
  allPods?: boolean;
  namespace?: string;
}

@Injectable()
export class EnvLogsService {
  private readonly logger = new Logger(EnvLogsService.name);

  static buildLabelSelector(projectId: string, envName: string, service: string): string {
    const envLabel = this.normalizeLabelValue(envName, 'env');
    const componentLabel = this.normalizeLabelValue(service, 'component');
    return `eve.project_id=${projectId},eve.env=${envLabel},eve.component=${componentLabel}`;
  }

  private kc?: k8s.KubeConfig;
  private k8sApi?: k8s.CoreV1Api;
  private k8sAvailable = false;
  private projects: ReturnType<typeof projectQueries>;
  private orgs: ReturnType<typeof orgQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.projects = projectQueries(db);
    this.orgs = orgQueries(db);
    try {
      this.kc = new k8s.KubeConfig();
      this.kc.loadFromDefault();
      this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
      this.k8sAvailable = true;
    } catch {
      this.k8sAvailable = false;
    }
  }

  async getServiceLogs(
    projectId: string,
    envName: string,
    service: string,
    options: EnvLogOptions,
  ): Promise<EnvLogsResponse> {
    if (!this.k8sAvailable || !this.k8sApi) {
      throw new BadRequestException('Kubernetes logs are only available in k8s environments');
    }

    let namespace = options.namespace ?? process.env.EVE_NAMESPACE;
    if (!namespace) {
      const project = await this.projects.findById(projectId, { include_deleted: true });
      if (!project) {
        throw new NotFoundException(`Project ${projectId} not found`);
      }
      const org = await this.orgs.findById(project.org_id);
      if (!org) {
        throw new NotFoundException(`Org ${project.org_id} not found for project ${projectId}`);
      }
      namespace = `eve-${org.slug}-${project.slug}-${envName}`;
    }
    const selector = EnvLogsService.buildLabelSelector(projectId, envName, service);

    // Find pods matching the service
    let pods: k8s.V1Pod[];
    try {
      const podsResponse = await this.k8sApi.listNamespacedPod({
        namespace,
        labelSelector: selector,
      });
      pods = podsResponse.items ?? [];
    } catch (error) {
      const wrapped = wrapK8sError(error, 'list', { kind: 'Pod', namespace });
      this.logger.error(
        `Failed to list pods in ${namespace} with selector ${selector}: ${wrapped.message}`,
        wrapped.stack,
        JSON.stringify({
          namespace,
          selector,
          status_code: wrapped.statusCode,
          reason: wrapped.reason,
        }),
      );
      throw new InternalServerErrorException(wrapped.message);
    }

    if (pods.length === 0) {
      throw new NotFoundException(
        `No pods found for service "${service}" in ${envName} (namespace: ${namespace}, selector: ${selector})`,
      );
    }

    if (options.pod) {
      pods = pods.filter((pod) => pod.metadata?.name === options.pod);
      if (pods.length === 0) {
        throw new NotFoundException(`Pod ${options.pod} not found for service "${service}"`);
      }
    }

    if (!options.allPods) {
      pods = [pods[0]];
    }

    const entries: EnvLogEntry[] = [];

    for (const pod of pods) {
      const podName = pod.metadata?.name;
      if (!podName) {
        continue;
      }

      // Determine container name — required when pod has multiple containers
      const containers = pod.spec?.containers ?? [];
      const container = options.container ?? (containers.length > 1 ? service : undefined);

      let logText: string;
      try {
        const logsResponse = await this.k8sApi.readNamespacedPodLog({
          name: podName,
          namespace,
          container,
          tailLines: options.tailLines,
          sinceSeconds: options.sinceSeconds,
          previous: options.previous,
        });
        logText = typeof logsResponse === 'string' ? logsResponse : String(logsResponse ?? '');
      } catch (error) {
        if (options.previous && EnvLogsService.isNoPreviousContainerError(error)) {
          this.logger.debug(
            `No previous logs for pod ${podName} in ${namespace}; returning empty logs.`,
          );
          continue;
        }
        const wrapped = wrapK8sError(error, 'readLog', {
          kind: 'Pod',
          name: podName,
          namespace,
        });
        this.logger.error(
          `Failed to read logs for pod ${podName} in ${namespace}: ${wrapped.message}`,
          wrapped.stack,
          JSON.stringify({
            namespace,
            pod: podName,
            container,
            status_code: wrapped.statusCode,
            reason: wrapped.reason,
          }),
        );
        throw new InternalServerErrorException(wrapped.message);
      }

      const lines = logText.split('\n').filter((line) => line.trim());
      const filtered = lines
        .map((line) => ({ line, fields: EnvLogsService.parseJsonFields(line) }))
        .filter(({ line, fields }) => EnvLogsService.matchesLine(line, fields, options));

      for (const { line, fields } of filtered) {
        const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\s]*)/);
        entries.push({
          timestamp: timestampMatch ? timestampMatch[1] : new Date().toISOString(),
          line,
          pod: podName,
          container: container ?? undefined,
          fields,
        });
      }
    }

    return { logs: entries };
  }

  streamServiceLogs(
    projectId: string,
    envName: string,
    service: string,
    options: EnvLogOptions,
  ): Observable<MessageEvent> {
    const seen = new Set<string>();
    const knownPods = new Set<string>();
    let initialized = false;
    let lastHeartbeat = Date.now();

    return interval(1000).pipe(
      startWith(0),
      concatMap(() =>
        from(
          (async () => {
            const events: MessageEvent[] = [];
            const pollOptions: EnvLogOptions = {
              ...options,
              previous: false,
              tailLines: initialized
                ? undefined
                : options.tailLines ?? (options.sinceSeconds ? undefined : 10),
              sinceSeconds: initialized ? 2 : options.sinceSeconds,
            };

            const response = await this.getServiceLogs(projectId, envName, service, pollOptions);
            const currentPods = new Set(response.logs.map((entry) => entry.pod).filter(Boolean) as string[]);

            for (const pod of currentPods) {
              if (!knownPods.has(pod)) {
                knownPods.add(pod);
                if (initialized) {
                  events.push({
                    type: 'pod_changed',
                    data: {
                      pod_name: pod,
                      service,
                      timestamp: new Date().toISOString(),
                    },
                  });
                }
              }
            }

            for (const entry of response.logs) {
              const key = `${entry.pod ?? ''}\u0000${entry.container ?? ''}\u0000${entry.line}`;
              if (seen.has(key)) {
                continue;
              }
              seen.add(key);
              events.push({
                type: 'log',
                data: {
                  timestamp: entry.timestamp,
                  line: entry.line,
                  pod_name: entry.pod,
                  pod: entry.pod,
                  container: entry.container,
                  service,
                  fields: entry.fields,
                },
              });
            }

            initialized = true;
            if (Date.now() - lastHeartbeat >= 60_000) {
              lastHeartbeat = Date.now();
              events.push({
                type: 'heartbeat',
                data: {
                  type: 'heartbeat',
                  timestamp: new Date().toISOString(),
                },
              });
            }

            return events;
          })(),
        ),
      ),
      concatMap((events) => from(events)),
      share(),
    );
  }

  static parseFilters(filters: string | string[] | undefined): EnvLogFilters | undefined {
    if (!filters) {
      return undefined;
    }
    const list = Array.isArray(filters) ? filters : [filters];
    const parsed: EnvLogFilters = {};
    for (const entry of list) {
      const eqIndex = entry.indexOf('=');
      if (eqIndex <= 0) {
        throw new BadRequestException('--filter entries must use k=v syntax');
      }
      const key = entry.slice(0, eqIndex).trim();
      const value = entry.slice(eqIndex + 1);
      if (!key) {
        throw new BadRequestException('--filter key must not be empty');
      }
      parsed[key] = value;
    }
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  }

  static matchesLine(line: string, fields: Record<string, unknown> | undefined, options: EnvLogOptions): boolean {
    if (options.grep && !line.includes(options.grep)) {
      return false;
    }

    const entries = Object.entries(options.filters ?? {});
    if (entries.length === 0) {
      return true;
    }

    if (!fields) {
      return entries.every(([, value]) => line.includes(value));
    }

    return entries.every(([path, rawValue]) => {
      const actual = EnvLogsService.getPath(fields, path);
      if (actual === undefined) {
        return false;
      }
      const expected = EnvLogsService.coerceFilterValue(rawValue);
      if (actual === expected) {
        return true;
      }
      return String(actual) === rawValue;
    });
  }

  static parseJsonFields(line: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON service logs fall back to raw text matching.
    }
    return undefined;
  }

  private static getPath(value: Record<string, unknown>, path: string): unknown {
    let cursor: unknown = value;
    for (const segment of path.split('.')) {
      if (!segment) {
        return undefined;
      }
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
        return undefined;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
  }

  private static coerceFilterValue(value: string): string | number | boolean {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    if (value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value)) {
      return Number(value);
    }
    return value;
  }

  private static normalizeLabelValue(value: string, label: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-_.]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[^a-z0-9]+$/, '')
      .replace(/-+$/, '');

    if (!normalized) {
      throw new BadRequestException(`Invalid ${label} label value: ${value}`);
    }

    return normalized.length > 63 ? normalized.slice(0, 63).replace(/[-_.]+$/, '') : normalized;
  }

  private static isNoPreviousContainerError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error ?? '');
    return (
      msg.includes('previous terminated container') ||
      msg.includes('previous container') ||
      msg.includes('previous log')
    );
  }

}
