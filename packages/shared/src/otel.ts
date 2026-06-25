import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { trace, type Span } from '@opentelemetry/api';

let sdk: NodeSDK | null = null;

export function stampRequestId(span: Span | undefined | null, reqId: string | undefined | null): void {
  if (!span || !reqId) {
    return;
  }
  span.setAttribute('request_id', reqId);
  span.setAttribute('eve.request_id', reqId);
}

export function stampCurrentRequestId(reqId: string | undefined | null): void {
  stampRequestId(trace.getActiveSpan(), reqId);
}

export async function initOtel(serviceName: string): Promise<void> {
  if (process.env.OTEL_DISABLED === 'true') {
    return;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const enabled = process.env.OTEL_ENABLED === 'true' || Boolean(endpoint);
  if (!enabled) {
    return;
  }

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  });

  const traceExporter = new OTLPTraceExporter(
    endpoint ? { url: endpoint } : {},
  );

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(endpoint ? { url: endpoint } : {}),
  }) as unknown as import('@opentelemetry/sdk-metrics').MetricReader;

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  await sdk.start();

  const shutdown = async () => {
    try {
      await sdk?.shutdown();
    } catch (error) {
      console.error('OTEL shutdown failed', error);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
