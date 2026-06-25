import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '@eve/db';
import { projectManifestQueries } from '@eve/db';
import {
  getServicesFromManifest,
  type Manifest,
  type Service,
  type TraceQueryResponse,
  type TraceSpan,
} from '@eve/shared';
import * as yaml from 'yaml';

type XRayModule = {
  XRayClient: new (config: { region?: string }) => { send(command: unknown): Promise<unknown> };
  GetTraceSummariesCommand: new (input: Record<string, unknown>) => unknown;
  BatchGetTracesCommand: new (input: Record<string, unknown>) => unknown;
};

type TraceSummary = {
  Id?: string;
  Duration?: number;
  ResponseTime?: number;
  HasError?: boolean;
  HasFault?: boolean;
  HasThrottle?: boolean;
};

type SegmentDocument = {
  id?: string;
  trace_id?: string;
  parent_id?: string;
  name?: string;
  start_time?: number;
  end_time?: number;
  error?: boolean;
  fault?: boolean;
  throttle?: boolean;
  annotations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  http?: Record<string, unknown>;
  subsegments?: SegmentDocument[];
};

export interface TraceQueryOptions {
  projectId: string;
  service?: string;
  requestId?: string;
  traceId?: string;
  sinceSeconds?: number;
  error?: boolean;
  route?: string;
  p99?: boolean;
  limit?: number;
  noCache?: boolean;
}

@Injectable()
export class TracesService {
  private readonly logger = new Logger(TracesService.name);
  private readonly manifests: ReturnType<typeof projectManifestQueries>;
  private readonly cache = new Map<string, { expiresAt: number; response: TraceQueryResponse }>();

  constructor(@Inject('DB') private readonly db: Db) {
    this.manifests = projectManifestQueries(db);
  }

  async query(options: TraceQueryOptions): Promise<TraceQueryResponse> {
    const projectServices = await this.loadProjectServices(options.projectId);
    this.validateService(projectServices, options.service);
    const allowedServices = projectServices ? this.traceServiceNames(projectServices) : null;
    const normalized: TraceQueryOptions = {
      ...options,
      sinceSeconds: options.sinceSeconds ?? 300,
      limit: Math.min(Math.max(options.limit ?? 100, 1), 1000),
    };
    const cacheKey = JSON.stringify({
      ...normalized,
      allowed_services: allowedServices ? Array.from(allowedServices).sort() : null,
    });
    if (!normalized.noCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.response;
      }
    }

    const response = await this.queryXray(normalized, allowedServices);
    if (!normalized.noCache) {
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + 30_000,
        response,
      });
    }
    return response;
  }

  private async queryXray(
    options: TraceQueryOptions,
    allowedServices: Set<string> | null,
  ): Promise<TraceQueryResponse> {
    const xray = await this.loadXrayModule();
    const warnings: string[] = [];
    if (!xray) {
      return this.emptyResponse(options, [
        'X-Ray query backend is not installed in this API image.',
      ]);
    }

    const region = process.env.EVE_TRACES_AWS_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    const client = new xray.XRayClient({ region });

    try {
      let summaries: TraceSummary[] = [];
      let traceIds: string[] = [];
      if (options.traceId) {
        traceIds = [options.traceId];
      } else {
        const end = new Date();
        const start = new Date(end.getTime() - (options.sinceSeconds ?? 300) * 1000);
        const summaryResponse = await client.send(new xray.GetTraceSummariesCommand({
          StartTime: start,
          EndTime: end,
          FilterExpression: this.buildFilterExpression(options),
          Sampling: false,
        })) as { TraceSummaries?: TraceSummary[] };
        summaries = (summaryResponse.TraceSummaries ?? []).slice(0, options.limit);
        traceIds = summaries.map((summary) => summary.Id).filter(Boolean) as string[];
      }

      const traces = traceIds.length > 0
        ? await this.batchGetTraces(xray, client, traceIds, summaries, allowedServices)
        : [];
      const spanCount = traces.reduce((sum, trace) => sum + trace.spans.length, 0);
      const durations = summaries
        .map((summary) => typeof summary.Duration === 'number' ? summary.Duration * 1000 : null)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
      const p99Ms = options.p99 && durations.length > 0
        ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.99) - 1)]
        : null;

      return {
        project_id: options.projectId,
        service: options.service ?? null,
        request_id: options.requestId ?? null,
        trace_id: options.traceId ?? null,
        route: options.route ?? null,
        since_seconds: options.sinceSeconds ?? null,
        error: options.error,
        p99: options.p99,
        backend: 'x-ray',
        backend_available: true,
        traces,
        summary: {
          trace_count: traces.length,
          span_count: spanCount,
          p99_ms: p99Ms,
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`X-Ray query failed: ${message}`);
      return this.emptyResponse(options, [`X-Ray query failed: ${message}`]);
    }
  }

  private async batchGetTraces(
    xray: XRayModule,
    client: { send(command: unknown): Promise<unknown> },
    traceIds: string[],
    summaries: TraceSummary[],
    allowedServices: Set<string> | null,
  ): Promise<TraceQueryResponse['traces']> {
    const tracesById = new Map(summaries.map((summary) => [summary.Id, summary]));
    const response = await client.send(new xray.BatchGetTracesCommand({
      TraceIds: traceIds.slice(0, 100),
    })) as {
      Traces?: Array<{
        Id?: string;
        Duration?: number;
        Segments?: Array<{ Document?: string }>;
      }>;
    };

    return (response.Traces ?? []).map((trace) => {
      const spans: TraceSpan[] = [];
      for (const segment of trace.Segments ?? []) {
        if (!segment.Document) {
          continue;
          }
          try {
            const doc = JSON.parse(segment.Document) as SegmentDocument;
            spans.push(...this.flattenSegment(doc, doc.trace_id ?? trace.Id ?? '', undefined, allowedServices));
          } catch {
            // Ignore malformed segment documents from the backend.
          }
        }
      const summary = tracesById.get(trace.Id);
      return {
        trace_id: trace.Id ?? '',
        duration_ms: typeof trace.Duration === 'number'
          ? trace.Duration * 1000
          : typeof summary?.Duration === 'number'
            ? summary.Duration * 1000
            : null,
        response_time_ms: typeof summary?.ResponseTime === 'number' ? summary.ResponseTime * 1000 : null,
        has_error: Boolean(summary?.HasError || summary?.HasFault || summary?.HasThrottle),
        spans,
      };
    }).filter((trace) => trace.spans.length > 0);
  }

  private flattenSegment(
    segment: SegmentDocument,
    traceId: string,
    parentId?: string,
    allowedServices?: Set<string> | null,
    includeFromParent = false,
  ): TraceSpan[] {
    const startMs = typeof segment.start_time === 'number' ? segment.start_time * 1000 : null;
    const endMs = typeof segment.end_time === 'number' ? segment.end_time * 1000 : null;
    const serviceName = segment.name ?? null;
    const includeSpan = !allowedServices || includeFromParent || (serviceName ? allowedServices.has(serviceName) : false);
    const span: TraceSpan = {
      trace_id: segment.trace_id ?? traceId,
      span_id: segment.id ?? '',
      parent_span_id: segment.parent_id ?? parentId ?? null,
      name: segment.name ?? 'unknown',
      service: serviceName,
      start_time: startMs ? new Date(startMs).toISOString() : null,
      end_time: endMs ? new Date(endMs).toISOString() : null,
      duration_ms: startMs && endMs ? endMs - startMs : null,
      error: Boolean(segment.error),
      fault: Boolean(segment.fault),
      throttle: Boolean(segment.throttle),
      annotations: segment.annotations,
      metadata: segment.metadata,
      http: segment.http,
    };
    const childSpans = (segment.subsegments ?? [])
      .flatMap((child) => this.flattenSegment(child, span.trace_id, span.span_id, allowedServices, includeSpan));
    return includeSpan ? [span, ...childSpans] : childSpans;
  }

  private buildFilterExpression(options: TraceQueryOptions): string | undefined {
    const expressions: string[] = [];
    if (options.requestId) {
      expressions.push(`annotation.request_id = "${this.escapeFilterValue(options.requestId)}"`);
    }
    if (options.service) {
      expressions.push(`service("${this.escapeFilterValue(options.service)}")`);
    }
    if (options.error) {
      expressions.push('error = true');
    }
    if (options.route) {
      expressions.push(`annotation.http.route = "${this.escapeFilterValue(options.route)}"`);
    }
    return expressions.length > 0 ? expressions.join(' AND ') : undefined;
  }

  private escapeFilterValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private validateService(services: Record<string, Service> | null, service?: string): void {
    if (!service) {
      return;
    }
    if (!services) {
      return;
    }
    if (!services[service]) {
      throw new BadRequestException(`Service "${service}" is not declared in the latest project manifest`);
    }
  }

  private async loadProjectServices(projectId: string): Promise<Record<string, Service> | null> {
    const manifestRecord = await this.manifests.findLatestByProject(projectId);
    if (!manifestRecord) {
      return null;
    }
    const manifest = yaml.parse(manifestRecord.manifest_yaml) as Manifest;
    return getServicesFromManifest(manifest) ?? {};
  }

  private traceServiceNames(services: Record<string, Service>): Set<string> {
    const names = new Set<string>();
    for (const [name, service] of Object.entries(services)) {
      const xEve = this.getXeve(service);
      if (xEve.role === 'managed_db' || xEve.role === 'job' || xEve.external === true) {
        continue;
      }
      names.add(name);
    }
    return names;
  }

  private getXeve(service: Service): Record<string, unknown> {
    return (service['x-eve'] ?? service.x_eve ?? {}) as Record<string, unknown>;
  }

  private emptyResponse(options: TraceQueryOptions, warnings: string[]): TraceQueryResponse {
    return {
      project_id: options.projectId,
      service: options.service ?? null,
      request_id: options.requestId ?? null,
      trace_id: options.traceId ?? null,
      route: options.route ?? null,
      since_seconds: options.sinceSeconds ?? null,
      error: options.error,
      p99: options.p99,
      backend: 'x-ray',
      backend_available: false,
      traces: [],
      summary: {
        trace_count: 0,
        span_count: 0,
        p99_ms: null,
      },
      warnings,
    };
  }

  private async loadXrayModule(): Promise<XRayModule | null> {
    try {
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<XRayModule>;
      return await dynamicImport('@aws-sdk/client-xray');
    } catch {
      return null;
    }
  }
}
